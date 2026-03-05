import { Database } from 'sql.js';
import {
    initDatabase,
    insertEvent,
    queryEvents,
    getSummary as getDbSummary,
    purgeOldEvents,
    saveDatabase,
    deleteEventsByDateRange,
    markEventsExported,
    EventFilters,
    Summary,
} from './storage';
import { EventType, EventStatus, MetricEvent } from './types';

const AUTO_SAVE_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Singleton metrics collector backed by sql.js (WASM SQLite).
 * All public methods are try-catch wrapped so instrumentation never
 * disrupts the main extension flow.
 */
export class MetricsCollector {
    private static _instance: MetricsCollector;

    private _db: Database | null = null;
    private _dbPath: string = '';
    private _autoSaveTimer: ReturnType<typeof setInterval> | undefined;
    private _dirty = false;

    private constructor() {}

    static get instance(): MetricsCollector {
        if (!MetricsCollector._instance) {
            MetricsCollector._instance = new MetricsCollector();
        }
        return MetricsCollector._instance;
    }

    async initialize(dbPath: string): Promise<void> {
        try {
            this._dbPath = dbPath;
            this._db = await initDatabase(dbPath);
            this._autoSaveTimer = setInterval(() => {
                this._save();
            }, AUTO_SAVE_INTERVAL_MS);
        } catch (err) {
            console.warn('[MetricsCollector] Failed to initialize:', err);
        }
    }

    record(
        eventType: EventType,
        status: EventStatus,
        metadata: Record<string, unknown> = {},
        durationMs?: number,
        errorMessage?: string,
    ): void {
        setTimeout(() => {
            try {
                if (!this._db) { return; }
                const event: MetricEvent = {
                    timestamp: new Date().toISOString(),
                    event_type: eventType,
                    status,
                    duration_ms: durationMs,
                    error_message: errorMessage,
                    metadata,
                    exported: false,
                };
                insertEvent(this._db, event);
                this._dirty = true;
            } catch (err) {
                console.warn('[MetricsCollector] Failed to record event:', err);
            }
        }, 0);
    }

    query(filters?: EventFilters): MetricEvent[] {
        try {
            if (!this._db) { return []; }
            return queryEvents(this._db, filters);
        } catch (err) {
            console.warn('[MetricsCollector] Failed to query events:', err);
            return [];
        }
    }

    getSummary(): Summary {
        try {
            if (!this._db) { return { total: 0, by_type: {}, by_status: {} }; }
            return getDbSummary(this._db);
        } catch (err) {
            console.warn('[MetricsCollector] Failed to get summary:', err);
            return { total: 0, by_type: {}, by_status: {} };
        }
    }

    purge(days: number): { total: number; unexported: number } {
        try {
            if (!this._db) { return { total: 0, unexported: 0 }; }
            const result = purgeOldEvents(this._db, days);
            if (result.total > 0) { this._dirty = true; }
            return result;
        } catch (err) {
            console.warn('[MetricsCollector] Failed to purge events:', err);
            return { total: 0, unexported: 0 };
        }
    }

    deleteByDateRange(fromDate?: string, toDate?: string): number {
        try {
            if (!this._db) { return 0; }
            const count = deleteEventsByDateRange(this._db, fromDate, toDate);
            if (count > 0) { this._dirty = true; }
            return count;
        } catch (err) {
            console.warn('[MetricsCollector] Failed to delete events by date range:', err);
            return 0;
        }
    }

    markExported(fromDate?: string, toDate?: string): void {
        try {
            if (!this._db) { return; }
            markEventsExported(this._db, fromDate, toDate);
            this._dirty = true;
        } catch (err) {
            console.warn('[MetricsCollector] Failed to mark events exported:', err);
        }
    }

    dispose(): void {
        try {
            if (this._autoSaveTimer) {
                clearInterval(this._autoSaveTimer);
                this._autoSaveTimer = undefined;
            }
            this._save();
            if (this._db) {
                this._db.close();
                this._db = null;
            }
        } catch (err) {
            console.warn('[MetricsCollector] Failed to dispose:', err);
        }
    }

    private _save(): void {
        try {
            if (this._db && this._dirty) {
                saveDatabase(this._db, this._dbPath);
                this._dirty = false;
            }
        } catch (err) {
            console.warn('[MetricsCollector] Failed to save database:', err);
        }
    }
}
