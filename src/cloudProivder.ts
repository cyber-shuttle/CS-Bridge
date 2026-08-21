
import * as vscode from 'vscode';
import { CloudProviderState, WebviewMessage } from './models';
import { WebviewProvider } from './webviewProvider';

// Webview provider for the Cloud Provider view .
export class CloudProvider extends WebviewProvider {
    public static readonly viewType = 'csbridge.cloudView';
    protected readonly viewKind = 'cloud' as const;

    private accessKey = ""
    private secretKey = ""

    protected handleMessage(data: WebviewMessage): void {
        switch (data.command) {
            case 'ready': this.pushState(); break;
            default: this.logger.warn('Unknown command from cloud webview:', data);
        }
    }
    public pushState(): void {
        if (!this.view) { return; }
        const state: CloudProviderState = { name: "aws", accessKey: this.accessKey, secretKey: this.secretKey };
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

}
