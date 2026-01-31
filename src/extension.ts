// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { CsCommands } from './cscommands';
import { CsStorage } from './csstorage';
import { CybershuttleViewProvider } from './CybershuttleViewProvider';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	// vscode.window.registerUriHandler
	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "cybershuttle" is now active!');
	const csStorage = new CsStorage(context.secrets);

	// Register the webview sidebar provider
	const sidebarProvider = new CybershuttleViewProvider(context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(CybershuttleViewProvider.viewType, sidebarProvider)
	);

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	
	const openWorkspace = vscode.commands.registerCommand('cybershuttle.openWorkspace', () => {
		const csCommands = new CsCommands();
		csCommands.selectWorkspaces().then(() => {
			console.log('Workspaces shown');
		});	
	});	
	
	
	const auth = vscode.commands.registerCommand('cybershuttle.auth', () => {
		const csCommands = new CsCommands();
		csCommands.deviceAuth(csStorage).then(() => {
			console.log('Device Authenticated');
		});
	});

	
		// The code you place here will be
	const disposable = vscode.commands.registerCommand('cybershuttle.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		/*vscode.commands.executeCommand("vscode.newWindow", {
			remoteAuthority: "ssh-remote+149.165.152.125",
			reuseWindow: false});*/

		vscode.env.openExternal(vscode.Uri.parse("https://www.google.com"));

		const token = vscode.window.showInputBox({
			title: "Enter a path",
			placeHolder: "e.g. /home/exouser/dir1",
			value: "/home/exouser/dir1",
			validateInput: (value) => {
				return value === "" ? "Please enter a path" : null;
			}

		});

		token.then((value) => {
			console.log("Value " + value);
			vscode.commands.executeCommand(
				"vscode.openFolder",
				vscode.Uri.from({
					scheme: "vscode-remote",
					authority: "ssh-remote+149.165.152.125",
					path: "/home/exouser/dir1",
				}),
				// Open this in a new window!
				true,
			);
		});
	
		vscode.window.showInformationMessage('Hello World from CyberShuttle2!');
	});

	context.subscriptions.push(disposable);
	context.subscriptions.push(auth);
}

// This method is called when your extension is deactivated
export function deactivate() {}
