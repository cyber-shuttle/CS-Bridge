import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { CsCommands } from './cscommands';
import { CsStorage } from './csstorage';
import { CybershuttleViewProvider } from './CybershuttleViewProvider';
import { MetricsCollector, MetricEvent, decodeJwtClaims, anonymizeEvents, buildExportDatabase, saveExportFile, showConsentModal, syncTelemetry } from './instrumentation';

const metrics = MetricsCollector.instance;

interface MetricsExportResult {
	events: MetricEvent[];
	fromDate: string | undefined;
	rangeValue: string;
	userName: string | undefined;
	userEmail: string | undefined;
}

async function prepareMetricsExport(
	csStorage: CsStorage,
	queryOverride?: { to_date?: string },
): Promise<MetricsExportResult | undefined> {
	let fromDate: string | undefined;
	let rangeValue: string;
	if (queryOverride) {
		rangeValue = 'custom';
	} else {
		const rangeOptions = [
			{ label: 'Last 7 days', value: '7d', days: 7 },
			{ label: 'Last 30 days', value: '30d', days: 30 },
			{ label: 'All data', value: 'all', days: 0 },
		];
		const rangeChoice = await vscode.window.showQuickPick(
			rangeOptions.map(o => o.label),
			{ placeHolder: 'Select time range to export' }
		);
		if (!rangeChoice) { return undefined; }
		const range = rangeOptions.find(o => o.label === rangeChoice)!;
		rangeValue = range.value;
		if (range.days > 0) {
			fromDate = new Date(Date.now() - range.days * 24 * 60 * 60 * 1000).toISOString();
		}
	}

	let userName: string | undefined;
	let userEmail: string | undefined;
	const accessToken = await csStorage.getAccessToken();
	if (accessToken) {
		const claims = decodeJwtClaims(accessToken);
		userName = claims.name;
		userEmail = claims.email;
	}

	const queryFilters = queryOverride
		? { to_date: queryOverride.to_date }
		: { from_date: fromDate };
	const events = metrics.query(queryFilters);
	if (events.length === 0) {
		vscode.window.showInformationMessage('No events found in the selected time range.');
		return undefined;
	}
	const anonymized = anonymizeEvents(events, userName, userEmail);

	return { events: anonymized, fromDate, rangeValue, userName, userEmail };
}

export async function activate(context: vscode.ExtensionContext) {
	const activateStart = Date.now();

	const dbPath = path.join(os.homedir(), '.cybershuttle', 'metrics.db');
	await metrics.initialize(dbPath);

	const csStorage = new CsStorage(context.secrets);

	const sidebarProvider = new CybershuttleViewProvider(context.extensionUri, context.workspaceState, metrics);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(CybershuttleViewProvider.infoViewType, sidebarProvider),
		vscode.window.registerWebviewViewProvider(CybershuttleViewProvider.workspacesViewType, sidebarProvider),
		vscode.window.registerWebviewViewProvider(CybershuttleViewProvider.serversViewType, sidebarProvider),
	);

	const auth = vscode.commands.registerCommand('cybershuttle.auth', async () => {
		if (sidebarProvider.devTunnelAccount) {
			const choice = await vscode.window.showQuickPick(
				['Switch Account', 'Sign Out'],
				{ placeHolder: `Signed in as ${sidebarProvider.devTunnelAccount}` }
			);
			if (choice === 'Switch Account') {
				sidebarProvider.switchDevTunnelAccount();
			} else if (choice === 'Sign Out') {
				sidebarProvider.signOutDevTunnel();
			}
		} else {
			sidebarProvider.signInDevTunnel();
		}
	});

	context.subscriptions.push(auth);

	const openMetrics = vscode.commands.registerCommand('cybershuttle.openMetrics', async () => {
		try {
			const { DashboardPanel } = await import('./DashboardPanel.js');
			DashboardPanel.createOrShow(context.extensionUri, metrics);
		} catch (err) {
			console.warn('[MetricsCollector] Dashboard panel not available:', err);
		}
	});
	context.subscriptions.push(openMetrics);

	const exportMetrics = vscode.commands.registerCommand('cybershuttle.exportMetrics', async () => {
		try {
			const prepared = await prepareMetricsExport(csStorage);
			if (!prepared) { return; }

			const dateStr = new Date().toISOString().split('T')[0];
			const defaultFilename = `cs-bridge-metrics-${prepared.rangeValue}-${dateStr}.db`;
			const saveUri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultFilename)),
				filters: { 'SQLite Database': ['db'] },
			});
			if (!saveUri) { return; }

			const extVersion = context.extension?.packageJSON?.version ?? 'unknown';
			const exportDb = await buildExportDatabase(prepared.events, {
				export_timestamp: new Date().toISOString(),
				extension_version: extVersion,
				vscode_version: vscode.version,
				time_range_filter: prepared.rangeValue,
				record_count: prepared.events.length,
				anonymization_applied: !!(prepared.userName || prepared.userEmail),
			});
			saveExportFile(exportDb, saveUri.fsPath);
			exportDb.close();

			metrics.markExported(prepared.fromDate);
			const filename = path.basename(saveUri.fsPath);
			const cleanup = await vscode.window.showQuickPick(
				['Yes', 'No'],
				{ placeHolder: 'Clear exported records from local database?' }
			);
			let cleared = false;
			if (cleanup === 'Yes') {
				metrics.deleteByDateRange(prepared.fromDate);
				cleared = true;
			}

			const msg = `Exported ${prepared.events.length} events to ${filename}` +
				(cleared ? ' and cleared exported records' : '');
			vscode.window.showInformationMessage(msg);
		} catch (err) {
			console.warn('[MetricsCollector] Export failed:', err);
			vscode.window.showErrorMessage('Failed to export metrics. See console for details.');
		}
	});
	context.subscriptions.push(exportMetrics);

	// Register Add Remote command — forward to the provider
	context.subscriptions.push(
		vscode.commands.registerCommand('cybershuttle.addRemote', () => sidebarProvider.handleAddRemote()),
	);

	// Register Files navigation commands — forward to the provider's message handler
	context.subscriptions.push(
		vscode.commands.registerCommand('cybershuttle.filesGoBack', () => sidebarProvider.handleFilesNav('filesGoBack')),
		vscode.commands.registerCommand('cybershuttle.filesGoForward', () => sidebarProvider.handleFilesNav('filesGoForward')),
		vscode.commands.registerCommand('cybershuttle.filesGoHome', () => sidebarProvider.handleFilesNav('filesGoHome')),
		vscode.commands.registerCommand('cybershuttle.filesRefresh', () => sidebarProvider.handleFilesNav('filesRefresh')),
	);

	// Record activation event
	const activationDuration = Date.now() - activateStart;
	metrics.record('extension_activate', 'success', {
		vscode_version: vscode.version,
		extension_version: context.extension?.packageJSON?.version ?? 'unknown',
	}, activationDuration);

	// Telemetry: check consent and start periodic background sync
	try {
		const consentGiven = context.globalState.get<boolean>('cybershuttle.telemetry.consent_given');
		if (consentGiven === undefined) {
			// First time — show consent modal
			await showConsentModal(context);
		}
		// Initial sync
		syncTelemetry(context, metrics).catch(() => {});
		// Periodic sync every 60s (syncTelemetry has its own cooldown gate)
		const telemetryTimer = setInterval(() => {
			syncTelemetry(context, metrics).catch(() => {});
		}, 60_000);
		context.subscriptions.push({ dispose: () => clearInterval(telemetryTimer) });
	} catch {
		// Telemetry must never disrupt activation
	}

	// 30-day TTL cleanup prompt
	setTimeout(() => {
		const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
		const oldEvents = metrics.query({ to_date: cutoff });
		if (oldEvents.length > 0) {
			vscode.window.showInformationMessage(
				`You have ${oldEvents.length} instrumentation events older than 30 days. Export before clearing?`,
				'Export & Clear', 'Clear Now', 'Remind Me Later'
			).then(async (choice) => {
				if (choice === 'Export & Clear') {
					const prepared = await prepareMetricsExport(csStorage, { to_date: cutoff });
					if (!prepared) { return; }

					const dateStr = new Date().toISOString().split('T')[0];
					const saveUri = await vscode.window.showSaveDialog({
						defaultUri: vscode.Uri.file(path.join(os.homedir(), `cs-bridge-metrics-old-30d-${dateStr}.db`)),
						filters: { 'SQLite Database': ['db'] },
					});
					if (!saveUri) { return; }

					const extVersion = context.extension?.packageJSON?.version ?? 'unknown';
					const exportDb = await buildExportDatabase(prepared.events, {
						export_timestamp: new Date().toISOString(),
						extension_version: extVersion,
						vscode_version: vscode.version,
						time_range_filter: 'older-than-30d',
						record_count: prepared.events.length,
						anonymization_applied: !!(prepared.userName || prepared.userEmail),
					});
					saveExportFile(exportDb, saveUri.fsPath);
					exportDb.close();
					metrics.markExported(undefined, cutoff);
					metrics.purge(30);
				} else if (choice === 'Clear Now') {
					metrics.purge(30);
				}
			});
		}
	}, 0);
}

export function deactivate() {
	metrics.dispose();
}
