import * as vscode from "vscode";
import { CloudProviderState, WebviewMessage } from "./models";
import { WebviewProvider } from "./webviewProvider";
import { writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { EC2Client, CreateKeyPairCommand } from "@aws-sdk/client-ec2";

// Webview provider for the Cloud Provider view .
export class CloudProvider extends WebviewProvider {
  public static readonly viewType = "csbridge.cloudView";
  protected readonly viewKind = "cloud" as const;
  protected readonly KEY_NAME = "cs-aws-generated-key";

  protected readonly PRIVATE_KEY_PATH = path.join(homedir(), this.KEY_NAME);

  private state: CloudProviderState = {
    name: "aws",
    accessKey: "",
    secretKey: "",
    sessionToken: "",
    instanceStatus: "",
    instanceID: "",
    region: "us-east-1",
  };
  private client: EC2Client | null = null;

  protected handleMessage(data: WebviewMessage): void {
    switch (data.command) {
      case "ready":
        this.pushState();
        break;
      case "launch":
        this.launchEC2Instance();
        break;
      default:
        this.logger.warn("Unknown command from cloud webview:", data);
    }
  }
  public pushState(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ command: "state", state: this.state });
  }
  public async addAWSToken(): Promise<void> {
    const accessKey = (
      await vscode.window.showInputBox({
        title: "Enter AWS Access Key",
        placeHolder: "AWS Acxess Key",
        ignoreFocusOut: true,
      })
    )?.trim();
    if (!accessKey) {
      return;
    }

    const secretKey = (
      await vscode.window.showInputBox({
        title: "Enter AWS Secret Key",
        placeHolder: "AWS Secret Key",
        ignoreFocusOut: true,
      })
    )?.trim();
    if (!secretKey) {
      return;
    }
    const sessionToken = (
      await vscode.window.showInputBox({
        title: "Enter AWS Session Token",
        placeHolder: "AWS Session Token",
        ignoreFocusOut: true,
      })
    )?.trim();
    if (!sessionToken) {
      return;
    }
    this.state = {
      ...this.state,
      accessKey: accessKey,
      secretKey: secretKey,
      sessionToken: sessionToken,
    };
    this.pushState();
  }

  // add options for ec2 instance later
  // handle cancel
  // handle remove instance after launch
  public async launchEC2Instance(): Promise<void> {
    if (this.state.secretKey == "" || this.state.accessKey == "") {
    }
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Setting up EC2 Instance...",
        cancellable: true,
      },
      async (progress) => {
        try {
          progress.report({ message: "Generating SSH Key Pair..." });
          await new Promise((resolve) => setTimeout(resolve, 2000));

          progress.report({ message: "Launching Instnace..." });
          await new Promise((resolve) => setTimeout(resolve, 3000));

          progress.report({ message: "Instance is running." });
          await new Promise((resolve) => setTimeout(resolve, 3000));
        } catch (error: any) {
          vscode.window.showErrorMessage("Failed to launch instance");
        }
      },
    );
  }
  private async initEC2Client(): void {
    this.client = new EC2Client({
      region: this.state.region,
      credentials: {
        accessKeyId: this.state.accessKey,
        secretAccessKey: this.state.secretKey,
        sessionToken: this.state.sessionToken,
      },
    });
  }
  // TODO: Handle Key Pair generation and removal
  private async generateSSHKeyPair(): Promise<void> {
    try {
      console.log(`Creating key pair: ${this.KEY_NAME}...`);
      const keyPairResponse = await this.client?.send(
        new CreateKeyPairCommand({
          KeyName: this.KEY_NAME,
          KeyType: "ed25519",
        }),
      );

      const privateKey = keyPairResponse?.KeyMaterial;
      if (privateKey !== undefined) {
        writeFileSync(this.PRIVATE_KEY_PATH, privateKey, { mode: 0o600 });
        console.log(`Private key safely written to ${this.PRIVATE_KEY_PATH}`);
      } else {
        console.log("Error: Reponse from key pair generatino is undefined");
      }
    } catch (error) {}
  }

  // TODO: Remove Key Pair
  public async remmoveKeyPair(keyName: string): Promise<void> {}

  // Stop Instace from webview
  public async stopInstance(): Promise<void> {}
  // Poll status of instance
  public async instanceStatus(): Promise<void> {}
}
