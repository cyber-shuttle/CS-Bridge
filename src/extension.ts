import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { CsCommands } from './cscommands';
import { CsStorage } from './csstorage';
import { CybershuttleViewProvider } from './CybershuttleViewProvider';
import { MetricsCollector } from './instrumentation';

const metrics = MetricsCollector.instance;

export async function activate(context: vscode.ExtensionContext) {
	const activateStart = Date.now();

	// Initialize metrics collector
	const dbPath = path.join(os.homedir(), '.cybershuttle', 'metrics.db');
	await metrics.initialize(dbPath);

	const csStorage = new CsStorage(context.secrets);

	// Register the webview sidebar provider (single instance manages both views)
	const sidebarProvider = new CybershuttleViewProvider(context.extensionUri, context.workspaceState, metrics);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(CybershuttleViewProvider.workspacesViewType, sidebarProvider),
		vscode.window.registerWebviewViewProvider(CybershuttleViewProvider.serversViewType, sidebarProvider),
	);

	const auth = vscode.commands.registerCommand('cybershuttle.auth', () => {
		const csCommands = new CsCommands(metrics);
		csCommands.deviceAuth(csStorage).then(() => {
			console.log('Device Authenticated');
		});
	});

	context.subscriptions.push(auth);

	// Register dashboard command
	const openMetrics = vscode.commands.registerCommand('cybershuttle.openMetrics', async () => {
		try {
			const { DashboardPanel } = await import('./DashboardPanel.js');
			DashboardPanel.createOrShow(context.extensionUri, metrics);
		} catch (err) {
			console.warn('[MetricsCollector] Dashboard panel not available:', err);
		}
	});
	context.subscriptions.push(openMetrics);

	// Record activation event
	const activationDuration = Date.now() - activateStart;
	metrics.record('extension_activate', 'success', {
		vscode_version: vscode.version,
		extension_version: context.extension?.packageJSON?.version ?? 'unknown',
	}, activationDuration);

	// TTL cleanup: purge events older than 90 days
	const purgeResult = metrics.purge(90);
	if (purgeResult.total > 0) {
		console.log(`[MetricsCollector] Purged ${purgeResult.total} events older than 90 days`);
	}
}

export function deactivate() {
	metrics.dispose();
}
