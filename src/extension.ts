import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { CsCommands } from './cscommands';
import { CsStorage } from './csstorage';
import { CybershuttleViewProvider } from './CybershuttleViewProvider';
import { MetricsCollector, MetricEvent, decodeJwtClaims, anonymizeEvents, buildExportDatabase, saveExportFile, generateReporterID, submitReport } from './instrumentation';

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
	opts?: { queryOverride?: { to_date?: string }; placeholderVerb?: string; warnIfNoIdentity?: boolean },
): Promise<MetricsExportResult | undefined> {
	const verb = opts?.placeholderVerb ?? 'export';

	let fromDate: string | undefined;
	let rangeValue: string;
	if (opts?.queryOverride) {
		rangeValue = 'custom';
	} else {
		const rangeOptions = [
			{ label: 'Last 7 days', value: '7d', days: 7 },
			{ label: 'Last 30 days', value: '30d', days: 30 },
			{ label: 'All data', value: 'all', days: 0 },
		];
		const rangeChoice = await vscode.window.showQuickPick(
			rangeOptions.map(o => o.label),
			{ placeHolder: `Select time range to ${verb}` }
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
	} else if (opts?.warnIfNoIdentity) {
		const proceed = await vscode.window.showWarningMessage(
			'Unable to retrieve identity for anonymization. Export will include unmasked data. Proceed?',
			'Yes', 'Cancel'
		);
		if (proceed !== 'Yes') { return undefined; }
	}

	const queryFilters = opts?.queryOverride
		? { to_date: opts.queryOverride.to_date }
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
		vscode.window.registerWebviewViewProvider(CybershuttleViewProvider.workspacesViewType, sidebarProvider),
		vscode.window.registerWebviewViewProvider(CybershuttleViewProvider.serversViewType, sidebarProvider),
	);

	const auth = vscode.commands.registerCommand('cybershuttle.auth', () => {
		const csCommands = new CsCommands(metrics);
		csCommands.deviceAuth(csStorage);
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
			const prepared = await prepareMetricsExport(csStorage, { warnIfNoIdentity: true });
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

	const reportMetrics = vscode.commands.registerCommand('cybershuttle.reportMetrics', async () => {
		try {
			const prepared = await prepareMetricsExport(csStorage, { placeholderVerb: 'report' });
			if (!prepared) { return; }

			let reporterEmail: string | undefined;
			try {
				const msSession = await vscode.authentication.getSession('microsoft', [], { silent: true });
				if (msSession) {
					reporterEmail = msSession.account.label;
				}
			} catch {
			}
			if (!reporterEmail) {
				reporterEmail = prepared.userEmail;
			}
			if (!reporterEmail) {
				vscode.window.showWarningMessage('Unable to determine user identity. Please sign in first.');
				return;
			}
			const reporterID = generateReporterID(reporterEmail);

			const serverUrl = vscode.workspace.getConfiguration('cybershuttle').get<string>('adminServerUrl', 'https://admin.dev.cybershuttle.org');
			const extVersion = context.extension?.packageJSON?.version ?? 'unknown';

			const result = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Reporting ${prepared.events.length} events...`,
					cancellable: false,
				},
				async () => {
					return submitReport(serverUrl, reporterID, prepared.events, {
						extension_version: extVersion,
						vscode_version: vscode.version,
						time_range_filter: prepared.rangeValue,
						record_count: prepared.events.length,
					});
				}
			);

			if (result.success) {
				metrics.markExported(prepared.fromDate);
				const cleanup = await vscode.window.showInformationMessage(
					`Reported ${prepared.events.length} events to the CS-Bridge team. Clear reported records?`,
					'Clear reported records', 'Keep records'
				);
				if (cleanup === 'Clear reported records') {
					metrics.deleteByDateRange(prepared.fromDate);
				}
			} else {
				vscode.window.showErrorMessage(
					`Report failed: ${result.error || 'Unknown error'}. Your data is still stored locally.`
				);
			}
		} catch (err) {
			console.warn('[MetricsCollector] Report failed:', err);
			vscode.window.showErrorMessage('Report failed. Your data is still stored locally.');
		}
	});
	context.subscriptions.push(reportMetrics);

	const activationDuration = Date.now() - activateStart;
	metrics.record('extension_activate', 'success', {
		vscode_version: vscode.version,
		extension_version: context.extension?.packageJSON?.version ?? 'unknown',
	}, activationDuration);

	setTimeout(() => {
		const cutoff90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
		const oldEvents = metrics.query({ to_date: cutoff90 });
		if (oldEvents.length > 0) {
			vscode.window.showInformationMessage(
				`You have ${oldEvents.length} instrumentation events older than 90 days. Export before clearing?`,
				'Export & Clear', 'Clear Now', 'Remind Me Later'
			).then(async (choice) => {
				if (choice === 'Export & Clear') {
					const prepared = await prepareMetricsExport(csStorage, {
						queryOverride: { to_date: cutoff90 },
					});
					if (!prepared) { return; }

					const dateStr = new Date().toISOString().split('T')[0];
					const saveUri = await vscode.window.showSaveDialog({
						defaultUri: vscode.Uri.file(path.join(os.homedir(), `cs-bridge-metrics-old-90d-${dateStr}.db`)),
						filters: { 'SQLite Database': ['db'] },
					});
					if (!saveUri) { return; }

					const extVersion = context.extension?.packageJSON?.version ?? 'unknown';
					const exportDb = await buildExportDatabase(prepared.events, {
						export_timestamp: new Date().toISOString(),
						extension_version: extVersion,
						vscode_version: vscode.version,
						time_range_filter: 'older-than-90d',
						record_count: prepared.events.length,
						anonymization_applied: !!(prepared.userName || prepared.userEmail),
					});
					saveExportFile(exportDb, saveUri.fsPath);
					exportDb.close();
					metrics.markExported(undefined, cutoff90);
					metrics.purge(90);
				} else if (choice === 'Clear Now') {
					metrics.purge(90);
				}
			});
		}
	}, 0);
}

export function deactivate() {
	metrics.dispose();
}
