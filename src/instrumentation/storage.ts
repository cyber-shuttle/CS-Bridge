import * as fs from 'fs';
import * as path from 'path';

// sql.js is loaded dynamically to avoid crashing the extension when packaged without node_modules
type Database = import('sql.js').Database;

import { MetricEvent, EventType, EventStatus } from './types';

type SqlJsFactory = { Database: new (...args: unknown[]) => Database };
let sqlJsPromise: Promise<SqlJsFactory> | null = null;

export function getSqlJsFactory(): Promise<SqlJsFactory> {
    if (!sqlJsPromise) {
        const p = (async () => {
            const sqljs = await import('sql.js');
            const initSqlJs = sqljs.default;
            const wasmPath = path.join(
                path.dirname(require.resolve('sql.js')),
                'sql-wasm.wasm'
            );
            const wasmBinary = fs.readFileSync(wasmPath);
            return initSqlJs({ wasmBinary });
        })() as Promise<SqlJsFactory>;
        sqlJsPromise = p;
        p.catch(() => { sqlJsPromise = null; });
    }
    return sqlJsPromise;
}

export interface EventFilters {
    event_type?: EventType;
    status?: EventStatus;
    from_date?: string;   // ISO 8601
    to_date?: string;     // ISO 8601
}

export interface Summary {
    total: number;
    by_type: Record<string, number>;
    by_status: Record<string, number>;
}

export async function initDatabase(dbPath: string): Promise<Database> {
    const SQL = await getSqlJsFactory();

    let db: Database;
    if (fs.existsSync(dbPath)) {
        const fileBuffer = fs.readFileSync(dbPath);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    db.run(`
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            event_type TEXT NOT NULL,
            status TEXT NOT NULL,
            duration_ms INTEGER,
            error_message TEXT,
            metadata TEXT NOT NULL DEFAULT '{}',
            exported INTEGER NOT NULL DEFAULT 0
        )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_events_status ON events(status)`);

    return db;
}

export function insertEvent(db: Database, event: MetricEvent): void {
    db.run(
        `INSERT INTO events (timestamp, event_type, status, duration_ms, error_message, metadata, exported)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            event.timestamp,
            event.event_type,
            event.status,
            event.duration_ms ?? null,
            event.error_message ?? null,
            JSON.stringify(event.metadata),
            event.exported ? 1 : 0,
        ]
    );
}

export function queryEvents(db: Database, filters?: EventFilters): MetricEvent[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters?.event_type) {
        conditions.push('event_type = ?');
        params.push(filters.event_type);
    }
    if (filters?.status) {
        conditions.push('status = ?');
        params.push(filters.status);
    }
    if (filters?.from_date) {
        conditions.push('timestamp >= ?');
        params.push(filters.from_date);
    }
    if (filters?.to_date) {
        conditions.push('timestamp <= ?');
        params.push(filters.to_date);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const stmt = db.prepare(`SELECT * FROM events ${where} ORDER BY timestamp DESC LIMIT 1000`, params);

    const results: MetricEvent[] = [];
    while (stmt.step()) {
        const row = stmt.getAsObject() as Record<string, unknown>;
        results.push({
            id: row['id'] as number,
            timestamp: row['timestamp'] as string,
            event_type: row['event_type'] as EventType,
            status: row['status'] as EventStatus,
            duration_ms: row['duration_ms'] as number | undefined,
            error_message: row['error_message'] as string | undefined,
            metadata: JSON.parse((row['metadata'] as string) || '{}'),
            exported: (row['exported'] as number) === 1,
        });
    }
    stmt.free();
    return results;
}

export function getSummary(db: Database): Summary {
    const total = (db.exec('SELECT COUNT(*) FROM events')[0]?.values[0]?.[0] as number) || 0;

    const by_type: Record<string, number> = {};
    const typeRows = db.exec('SELECT event_type, COUNT(*) FROM events GROUP BY event_type');
    if (typeRows.length > 0) {
        for (const row of typeRows[0].values) {
            by_type[row[0] as string] = row[1] as number;
        }
    }

    const by_status: Record<string, number> = {};
    const statusRows = db.exec('SELECT status, COUNT(*) FROM events GROUP BY status');
    if (statusRows.length > 0) {
        for (const row of statusRows[0].values) {
            by_status[row[0] as string] = row[1] as number;
        }
    }

    return { total, by_type, by_status };
}

export function purgeOldEvents(db: Database, days: number): { total: number; unexported: number } {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const unexportedStmt = db.prepare(
        `SELECT COUNT(*) FROM events WHERE timestamp < ? AND exported = 0`, [cutoff]
    );
    unexportedStmt.step();
    const unexported = (unexportedStmt.getAsObject() as Record<string, unknown>)['COUNT(*)'] as number || 0;
    unexportedStmt.free();

    const totalStmt = db.prepare(
        `SELECT COUNT(*) FROM events WHERE timestamp < ?`, [cutoff]
    );
    totalStmt.step();
    const total = (totalStmt.getAsObject() as Record<string, unknown>)['COUNT(*)'] as number || 0;
    totalStmt.free();

    if (total > 0) {
        db.run(`DELETE FROM events WHERE timestamp < ?`, [cutoff]);
    }

    return { total, unexported };
}

export function deleteEventsByDateRange(db: Database, fromDate?: string, toDate?: string): number {
    const conditions: string[] = [];
    const params: string[] = [];

    if (fromDate) {
        conditions.push('timestamp >= ?');
        params.push(fromDate);
    }
    if (toDate) {
        conditions.push('timestamp <= ?');
        params.push(toDate);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    db.run(`DELETE FROM events ${where}`, params);

    const result = db.exec('SELECT changes()');
    return (result[0]?.values[0]?.[0] as number) || 0;
}

export function markEventsExported(db: Database, fromDate?: string, toDate?: string): void {
    const conditions: string[] = [];
    const params: string[] = [];

    if (fromDate) {
        conditions.push('timestamp >= ?');
        params.push(fromDate);
    }
    if (toDate) {
        conditions.push('timestamp <= ?');
        params.push(toDate);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    db.run(`UPDATE events SET exported = 1 ${where}`, params);
}

export function saveDatabase(db: Database, dbPath: string): void {
    const data = db.export();
    const buffer = Buffer.from(data);
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = dbPath + '.tmp';
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, dbPath);
}
