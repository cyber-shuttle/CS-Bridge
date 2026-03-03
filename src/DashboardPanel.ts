import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MetricsCollector } from './instrumentation';
import { EventFilters } from './instrumentation/storage';

/**
 * Webview panel that displays session metrics in an editor tab.
 * Loads HTML/CSS/JS from src/webview-dashboard/.
 */
export class DashboardPanel {
    public static readonly viewType = 'cybershuttle.metricsPanel';

    private static _currentPanel: DashboardPanel | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _collector: MetricsCollector;
    private _disposed = false;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        collector: MetricsCollector,
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._collector = collector;

        this._panel.webview.html = this._getHtml();

        this._panel.webview.onDidReceiveMessage(
            (msg) => this._handleMessage(msg),
            undefined,
        );

        this._panel.onDidDispose(() => {
            this._disposed = true;
            DashboardPanel._currentPanel = undefined;
        });
    }

    /**
     * Create or reveal the metrics dashboard panel.
     */
    static createOrShow(extensionUri: vscode.Uri, collector: MetricsCollector): void {
        if (DashboardPanel._currentPanel) {
            DashboardPanel._currentPanel._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            DashboardPanel.viewType,
            'Session Metrics',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
            },
        );

        DashboardPanel._currentPanel = new DashboardPanel(panel, extensionUri, collector);
    }

    private _handleMessage(msg: { type: string; filters?: Record<string, string> }): void {
        switch (msg.type) {
            case 'requestSummary': {
                // Build filters from message (same shape as requestEvents)
                const summaryFilters: EventFilters = {};
                if (msg.filters) {
                    if (msg.filters.event_type) {
                        summaryFilters.event_type = msg.filters.event_type as EventFilters['event_type'];
                    }
                    if (msg.filters.status) {
                        summaryFilters.status = msg.filters.status as EventFilters['status'];
                    }
                    if (msg.filters.since) {
                        summaryFilters.from_date = msg.filters.since;
                    }
                }
                // Query filtered events and compute summary stats
                const events = this._collector.query(summaryFilters);
                const success = events.filter(e => e.status === 'success').length;
                const failure = events.filter(e => e.status === 'failure').length;
                const withDuration = events.filter(e => e.duration_ms != null && e.duration_ms > 0);
                const avgDuration = withDuration.length > 0
                    ? Math.round(withDuration.reduce((sum, e) => sum + (e.duration_ms ?? 0), 0) / withDuration.length)
                    : 0;
                this._postMessage({
                    type: 'summary',
                    data: {
                        total: events.length,
                        success,
                        failure,
                        avg_duration_ms: avgDuration,
                    },
                });
                break;
            }
            case 'requestEvents': {
                const filters: EventFilters = {};
                if (msg.filters) {
                    if (msg.filters.event_type) {
                        filters.event_type = msg.filters.event_type as EventFilters['event_type'];
                    }
                    if (msg.filters.status) {
                        filters.status = msg.filters.status as EventFilters['status'];
                    }
                    if (msg.filters.since) {
                        filters.from_date = msg.filters.since;
                    }
                }
                const events = this._collector.query(filters);
                this._postMessage({ type: 'events', data: events });
                break;
            }
            case 'refreshData': {
                // Re-send both summary and events, forwarding any filters
                this._handleMessage({ type: 'requestSummary', filters: msg.filters });
                this._handleMessage({ type: 'requestEvents', filters: msg.filters });
                break;
            }
        }
    }

    private _postMessage(msg: unknown): void {
        if (!this._disposed) {
            this._panel.webview.postMessage(msg);
        }
    }

    private _getHtml(): string {
        const webview = this._panel.webview;
        const nonce = getNonce();

        // Resolve URIs for external CSS and JS
        const cssUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview-dashboard', 'dashboard.css'),
        );
        const jsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview-dashboard', 'dashboard.js'),
        );

        // Read the HTML template and replace placeholders
        const htmlPath = path.join(this._extensionUri.fsPath, 'webview-dashboard', 'dashboard.html');
        let html = fs.readFileSync(htmlPath, 'utf8');

        html = html.replace(/\$\{cspSource\}/g, webview.cspSource);
        html = html.replace(/\$\{nonce\}/g, nonce);
        html = html.replace(/\$\{cssUri\}/g, cssUri.toString());
        html = html.replace(/\$\{jsUri\}/g, jsUri.toString());

        return html;
    }
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}
