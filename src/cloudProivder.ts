
import * as vscode from 'vscode';
import { CloudProviderState, WebviewMessage } from './models';
import { WebviewProvider } from './webviewProvider';
import { writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

// Webview provider for the Cloud Provider view .
export class CloudProvider extends WebviewProvider {
    public static readonly viewType = 'csbridge.cloudView';
    protected readonly viewKind = 'cloud' as const;

    private accessKey = ""
    private secretKey = ""
    private instanceID = ""

    protected handleMessage(data: WebviewMessage): void {
        switch (data.command) {
            case 'ready': this.pushState(); break;
            case 'launch': this.launchEC2Instance(); break;
            default: this.logger.warn('Unknown command from cloud webview:', data);
        }
    }
    public pushState(): void {
        if (!this.view) { return; }
        const state: CloudProviderState = { name: "aws", accessKey: this.accessKey, secretKey: this.secretKey, instanceID: "" };
        this.view.webview.postMessage({ command: 'state', state });

    }
    public async addAWSToken(): Promise<void> {
        const accessKey = (await vscode.window.showInputBox({
            title: 'Enter AWS Access Key',
            placeHolder: 'AWS Acxess Key',
            ignoreFocusOut: true,
        }))?.trim();
        if (!accessKey) { return; }

        const secretKey = (await vscode.window.showInputBox({
            title: 'Enter AWS Secret Key',
            placeHolder: 'AWS Secret Key',
            ignoreFocusOut: true,
        }))?.trim();
        if (!secretKey) { return; }
        this.secretKey = secretKey
        this.accessKey = accessKey
        this.pushState()

    }

    // add options for ec2 instance later
    // handle cancel 
    // handle remove instance after launch
    public async launchEC2Instance(): Promise<void> {
        const fileName = path.join(homedir(), "sample.txt")
        writeFileSync(fileName, "hello", { mode: 0o600 });
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Setting up EC2 Instance...",
            cancellable: true
        }, async (progress) => {

            try {

                progress.report({ message: "Generating SSH Key Pair..." });
                await new Promise(resolve => setTimeout(resolve, 2000));

                progress.report({ message: "Launching Instnace..." });
                await new Promise(resolve => setTimeout(resolve, 3000));

                progress.report(({ message: "Instance is running." }))
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
            catch (error: any) {
                vscode.window.showErrorMessage("Failed to launch instance");
            }
        });
    }

    // Stop Instace from webview 
    public async stopInstance(): Promise<void> {

    }
    // Poll status of instance
    public async instanceStatus(): Promise<void> {

    }

}
