import * as vscode from 'vscode';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { MetricsCollector } from './collector';
import { anonymizeEvents, decodeJwtClaims } from './export';
import { MetricEvent } from './types';

const gzip = promisify(zlib.gzip);

export const CONSENT_VERSION = '1.0';

const REQUEST_TIMEOUT_MS = 30_000;
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
// const SYNC_INTERVAL_MS = 30 * 1000; // 30s (testing)
const MS_AUTH_SCOPE = '46da2f7e-b5ef-422a-88d4-2a7f9de6a0b2/.default';

const STATE_KEY_CONSENT_GIVEN = 'cybershuttle.telemetry.consent_given';
const STATE_KEY_CONSENT_VERSION = 'cybershuttle.telemetry.consent_version';
const STATE_KEY_CONSENT_TIMESTAMP = 'cybershuttle.telemetry.consent_timestamp';
const STATE_KEY_LAST_SYNC = 'cybershuttle.telemetry.last_sync_timestamp';

interface TelemetryState {
    consent_given: boolean;
    consent_version: string;
    consent_timestamp: string;
    last_sync_timestamp: string | null;
}

function getTelemetryState(context: vscode.ExtensionContext): TelemetryState {
    return {
        consent_given: context.globalState.get<boolean>(STATE_KEY_CONSENT_GIVEN, false),
        consent_version: context.globalState.get<string>(STATE_KEY_CONSENT_VERSION, ''),
        consent_timestamp: context.globalState.get<string>(STATE_KEY_CONSENT_TIMESTAMP, ''),
        last_sync_timestamp: context.globalState.get<string | null>(STATE_KEY_LAST_SYNC, null) ?? null,
    };
}

/**
 * Check whether telemetry is enabled. All three conditions must be met:
 * 1. User gave consent
 * 2. cybershuttle.telemetry.enabled setting is true
 * 3. VS Code telemetry level is not "off"
 */
export function isTelemetryEnabled(context: vscode.ExtensionContext): boolean {
    try {
        const state = getTelemetryState(context);
        if (!state.consent_given) {
            return false;
        }

        const csConfig = vscode.workspace.getConfiguration('cybershuttle');
        if (!csConfig.get<boolean>('telemetry.enabled', true)) {
            return false;
        }

        const telemetryLevel = vscode.workspace.getConfiguration('telemetry').get<string>('telemetryLevel', 'all');
        if (telemetryLevel === 'off') {
            return false;
        }

        return true;
    } catch {
        return false;
    }
}

/**
 * Show the telemetry consent modal to the user.
 * Returns true if the user agreed, false otherwise.
 * If VS Code telemetry is off, skips the modal entirely and returns false.
 */
export async function showConsentModal(context: vscode.ExtensionContext): Promise<boolean> {
    try {
        // If VS Code telemetry is off, skip the modal entirely
        const telemetryLevel = vscode.workspace.getConfiguration('telemetry').get<string>('telemetryLevel', 'all');
        if (telemetryLevel === 'off') {
            return false;
        }

        const choice = await vscode.window.showInformationMessage(
            'CS-Bridge collects anonymous usage metrics (job submissions, connection outcomes, errors) to improve the extension. No personal files, code, or identifying information is sent. Your name and email are masked before transmission.\n\nYou can opt out at any time in Settings > CyberShuttle > Telemetry.',
            { modal: true, detail: 'CS-Bridge Anonymous Telemetry' },
            'I Agree',
            'No Thanks',
        );

        const agreed = choice === 'I Agree';
        await context.globalState.update(STATE_KEY_CONSENT_GIVEN, agreed);
        if (agreed) {
            await context.globalState.update(STATE_KEY_CONSENT_VERSION, CONSENT_VERSION);
            await context.globalState.update(STATE_KEY_CONSENT_TIMESTAMP, new Date().toISOString());
        }
        return agreed;
    } catch (err) {
        console.warn('[Telemetry] Failed to show consent modal:', err);
        return false;
    }
}

/**
 * Sync telemetry data to the server if conditions are met.
 * This function never throws and never shows UI.
 */
export async function syncTelemetry(
    context: vscode.ExtensionContext,
    metrics: MetricsCollector,
): Promise<void> {
    try {
        if (!isTelemetryEnabled(context)) {
            return;
        }

        // Check if 24 hours have passed since last sync
        const state = getTelemetryState(context);
        if (state.last_sync_timestamp) {
            const lastSync = new Date(state.last_sync_timestamp).getTime();
            if (Date.now() - lastSync < SYNC_INTERVAL_MS) {
                return;
            }
        }

        // Try to get Microsoft token silently - don't force sign-in
        let msSession: vscode.AuthenticationSession | undefined;
        try {
            msSession = await vscode.authentication.getSession(
                'microsoft',
                [MS_AUTH_SCOPE],
                { silent: true },
            );
        } catch {
            // No session available
        }
        if (!msSession) {
            return;
        }

        // Query events since last sync
        const queryFilters: { from_date?: string } = {};
        if (state.last_sync_timestamp) {
            queryFilters.from_date = state.last_sync_timestamp;
        }
        const events = metrics.query(queryFilters);
        if (events.length === 0) {
            return;
        }

        // Anonymize PII
        let userName: string | undefined;
        let userEmail: string | undefined;
        // Try to extract identity from Microsoft session for anonymization
        if (msSession.account.label) {
            userEmail = msSession.account.label;
        }
        const anonymized = anonymizeEvents(events, userName, userEmail);

        // Build request body
        const extVersion = vscode.extensions.getExtension('cybershuttle.cybershuttle')?.packageJSON?.version ?? 'unknown';
        const body = JSON.stringify({
            metadata: {
                extension_version: extVersion,
                vscode_version: vscode.version,
                time_range_filter: 'auto-sync',
                record_count: anonymized.length,
            },
            events: anonymized.map((e: MetricEvent) => ({
                timestamp: e.timestamp,
                event_type: e.event_type,
                status: e.status,
                duration_ms: e.duration_ms ?? null,
                error_message: e.error_message ?? null,
                metadata_json: e.metadata,
            })),
        });

        // Compress and send
        const compressed = await gzip(Buffer.from(body, 'utf8'));
        const serverUrl = vscode.workspace
            .getConfiguration('cybershuttle')
            .get<string>('adminServerUrl', 'https://admin.dev.cybershuttle.org');
            // .get<string>('adminServerUrl', 'http://localhost:8090');
        const url = serverUrl.replace(/\/+$/, '') + '/api/v1/ingest';

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Encoding': 'gzip',
                    'Authorization': `Bearer ${msSession.accessToken}`,
                },
                body: compressed,
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (response.ok) {
                await context.globalState.update(STATE_KEY_LAST_SYNC, new Date().toISOString());
                metrics.markExported(state.last_sync_timestamp ?? undefined);
            }
        } catch {
            clearTimeout(timeout);
            // Silently fail - will retry on next activation
        }
    } catch (err) {
        console.warn('[Telemetry] Sync failed:', err);
    }
}

/**
 * Returns an HTML snippet showing telemetry status for the dashboard.
 */
export function getTelemetryStatusHtml(context: vscode.ExtensionContext): string {
    const enabled = isTelemetryEnabled(context);
    const status = enabled ? 'Enabled' : 'Disabled';
    const settingsLink = 'command:workbench.action.openSettings?%22cybershuttle.telemetry%22';
    return `Anonymous telemetry: ${status} &middot; <a href="${settingsLink}">Change in Settings</a>`;
}
