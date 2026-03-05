import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { MetricEvent } from './types';

const gzip = promisify(zlib.gzip);

const REPORTER_ID_SALT = 'cybershuttle-metrics-reporter-id-hmac-v1-salt-2025';
const REQUEST_TIMEOUT_MS = 30_000;

export interface ReportMetadata {
    extension_version: string;
    vscode_version: string;
    time_range_filter: string;
    record_count: number;
}

export interface ReportResponse {
    success: boolean;
    receipt_id: string;
    error: string;
}

export function generateReporterID(email: string): string {
    return crypto
        .createHmac('sha256', REPORTER_ID_SALT)
        .update(email)
        .digest('hex');
}

export async function submitReport(
    serverUrl: string,
    reporterID: string,
    events: MetricEvent[],
    meta: ReportMetadata,
): Promise<ReportResponse> {
    const body = JSON.stringify({
        reporter_id: reporterID,
        metadata: {
            extension_version: meta.extension_version,
            vscode_version: meta.vscode_version,
            time_range_filter: meta.time_range_filter,
            record_count: meta.record_count,
        },
        events: events.map(e => ({
            timestamp: e.timestamp,
            event_type: e.event_type,
            status: e.status,
            duration_ms: e.duration_ms ?? null,
            error_message: e.error_message ?? null,
            metadata_json: e.metadata,
        })),
    });

    const compressed = await gzip(Buffer.from(body, 'utf8'));
    const url = serverUrl.replace(/\/+$/, '') + '/api/v1/ingest';

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Encoding': 'gzip',
                },
                body: compressed,
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (response.status >= 500 && attempt === 0) {
                continue;
            }

            const result = await response.json() as ReportResponse;
            return result;
        } catch (err) {
            if (attempt === 0) {
                continue;
            }
            return {
                success: false,
                receipt_id: '',
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    return { success: false, receipt_id: '', error: 'Unexpected retry exhaustion' };
}
