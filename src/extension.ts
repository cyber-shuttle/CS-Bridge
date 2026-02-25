import * as vscode from 'vscode';
import { CsCommands } from './cscommands';
import { CsStorage } from './csstorage';
import { CybershuttleViewProvider } from './CybershuttleViewProvider';
[]
export function activate(context: vscode.ExtensionContext) {
	const csStorage = new CsStorage(context.secrets);

	// Register the webview sidebar provider
	const sidebarProvider = new CybershuttleViewProvider(context.extensionUri, context.globalState);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(CybershuttleViewProvider.viewType, sidebarProvider)
	);

	const auth = vscode.commands.registerCommand('cybershuttle.auth', () => {
		const csCommands = new CsCommands();
		csCommands.deviceAuth(csStorage).then(() => {
			console.log('Device Authenticated');
		});
	});

	context.subscriptions.push(auth);
}

export function deactivate() {}
