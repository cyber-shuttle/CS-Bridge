import { Database } from 'sql.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MetricEvent } from './types';
import { getSqlJsFactory } from './storage';

export interface ExportMetadata {
    export_timestamp: string;
    extension_version: string;
    vscode_version: string;
    time_range_filter: string;
    record_count: number;
    anonymization_applied: boolean;
}

export function decodeJwtClaims(token: string): { name?: string; email?: string } {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) { return {}; }

        let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (payload.length % 4 !== 0) { payload += '='; }

        const json = Buffer.from(payload, 'base64').toString('utf8');
        const claims = JSON.parse(json);
        return {
            name: claims.name ?? claims.preferred_username,
            email: claims.email,
        };
    } catch {
        return {};
    }
}

export function anonymizeEvents(
    events: MetricEvent[],
    userName?: string,
    userEmail?: string,
): MetricEvent[] {
    // Build the list of non-empty mask targets
    const osUsername = os.userInfo().username;
    const homeDir = os.homedir();
    const masks: string[] = [];
    if (userName && userName.length > 0) { masks.push(userName); }
    if (userEmail && userEmail.length > 0) { masks.push(userEmail); }
    if (osUsername && osUsername.length > 0) { masks.push(osUsername); }
    if (homeDir && homeDir.length > 0) { masks.push(homeDir); }

    if (masks.length === 0) {
        return events;
    }

    return events.map(event => {
        const copy: MetricEvent = {
            ...event,
            metadata: structuredClone(event.metadata),
        };

        if (copy.error_message) {
            copy.error_message = replaceAllMasks(copy.error_message, masks);
        }

        copy.metadata = maskObjectValues(copy.metadata, masks);

        return copy;
    });
}

function maskObjectValues(
    obj: Record<string, unknown>,
    masks: string[],
): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (typeof val === 'string') {
            result[key] = replaceAllMasks(val, masks);
        } else if (Array.isArray(val)) {
            result[key] = val.map(item => {
                if (typeof item === 'string') { return replaceAllMasks(item, masks); }
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                    return maskObjectValues(item as Record<string, unknown>, masks);
                }
                return item;
            });
        } else if (val && typeof val === 'object') {
            result[key] = maskObjectValues(val as Record<string, unknown>, masks);
        } else {
            result[key] = val;
        }
    }
    return result;
}

function replaceAllMasks(input: string, masks: string[]): string {
    let result = input;
    for (const mask of masks) {
        result = result.replace(new RegExp(escapeRegex(mask), 'gi'), '[REDACTED]');
    }
    return result;
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function buildExportDatabase(
    events: MetricEvent[],
    meta: ExportMetadata,
): Promise<Database> {
    const SQL = await getSqlJsFactory();
    const db = new SQL.Database();

    db.run(`
        CREATE TABLE events (
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
    db.run(`CREATE INDEX idx_events_type ON events(event_type)`);
    db.run(`CREATE INDEX idx_events_timestamp ON events(timestamp)`);
    db.run(`CREATE INDEX idx_events_status ON events(status)`);

    db.run('BEGIN TRANSACTION');
    for (const event of events) {
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
    db.run('COMMIT');

    db.run(`
        CREATE TABLE _export_metadata (
            export_timestamp TEXT NOT NULL,
            extension_version TEXT NOT NULL,
            vscode_version TEXT NOT NULL,
            time_range_filter TEXT NOT NULL,
            record_count INTEGER NOT NULL,
            anonymization_applied INTEGER NOT NULL
        )
    `);
    db.run(
        `INSERT INTO _export_metadata VALUES (?, ?, ?, ?, ?, ?)`,
        [
            meta.export_timestamp,
            meta.extension_version,
            meta.vscode_version,
            meta.time_range_filter,
            meta.record_count,
            meta.anonymization_applied ? 1 : 0,
        ]
    );

    return db;
}

export function saveExportFile(db: Database, filePath: string): void {
    const data = db.export();
    const buffer = Buffer.from(data);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, buffer);
}
