import * as vscode from "vscode";
import { CloudProviderState, WebviewMessage } from "./models";
import { WebviewProvider } from "./webviewProvider";
import { writeFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import path from "path";
import { EC2Client, CreateKeyPairCommand, DeleteKeyPairCommand, EC2ServiceException } from "@aws-sdk/client-ec2";

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
                this.generateSSHKeyPair()
                // this.launchEC2Instance();
                break;
            case "rm-key-pair":
                this.remmoveKeyPair(this.PRIVATE_KEY_PATH)
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
        this.initEC2Client()
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
    private async initEC2Client(): Promise<void> {
        this.client = new EC2Client({
            region: this.state.region,
            credentials: {
                accessKeyId: this.state.accessKey,
                secretAccessKey: this.state.secretKey,
                sessionToken: this.state.sessionToken,
            },
        });
    }
    // TODO: Check if exisiting keypair exists
    // TODO: move key to exisiting .cybershuttle dir 
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
                console.log("Error: Response from key pair generation is undefined");
            }
        } catch (error) {
            if (error instanceof Error) {
                switch (error.name) {
                    case "InvalidKeyPair.Duplicate":
                        console.error(`Error: A key pair named "${this.KEY_NAME}" already exists.`);
                        break;
                    case "DryRunOperation":
                        console.info("Dry run successful. You have permissions to create this key pair.");
                        break;
                    case "UnauthorizedOperation":
                        console.error("Error: You are not authorized to create key pairs. Check IAM policies.");
                        break;
                    case "MissingParameter":
                        console.error("Error: The KeyName parameter is missing from the request.");
                        break;
                    default:
                        console.error(`Unexpected AWS Service Error (${error.name}):`, error.message);
                }
            } else {
                console.error("An unknown error occurred:", error);
            }
        }
    }

    // TODO: Remove local private key
    public async remmoveKeyPair(keyName: string): Promise<void> {
        try {

            console.log("Removing Key Pair from AWS")
            const command = new DeleteKeyPairCommand({ KeyName: keyName })
            await this.client?.send(command)


        } catch (error) {
            if (error instanceof EC2ServiceException) {
                switch (error.name) {
                    case "InvalidKeyPair.NotFound":
                        console.error("The key pair does not exist.");
                        break;
                    case "UnauthorizedOperation":
                        console.error("You do not have permission to delete this key pair.");
                        break;
                    default:
                        console.error(`AWS Error [${error.name}]: ${error.message}`);
                }
            } else {
                console.error(`Undhandled Error ${error}`);
            }

        }

        console.log("Removing local copy of key")
        unlinkSync(this.PRIVATE_KEY_PATH)
    }
    // Stop Instace from webview
    public async stopInstance(): Promise<void> { }
    // Poll status of instance
    public async instanceStatus(): Promise<void> { }
}
