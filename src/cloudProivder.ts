import * as vscode from "vscode";
import { AWSInstanceInfo, CloudProviderState, WebviewMessage } from "./models";
import { WebviewProvider } from "./webviewProvider";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { homedir } from "os";
import path from "path";
import {
    EC2Client,
    CreateKeyPairCommand,
    DeleteKeyPairCommand,
    EC2ServiceException,
    paginateDescribeInstances,
    AuthorizeSecurityGroupIngressCommand,
    CreateSecurityGroupCommand,
} from "@aws-sdk/client-ec2";

// Webview provider for the Cloud Provider view .
export class CloudProvider extends WebviewProvider {
    public static readonly viewType = "csbridge.cloudView";
    protected readonly viewKind = "cloud" as const;
    protected readonly KEY_NAME = "cs-aws-generated-key";
    private client: EC2Client | null = null;

    protected readonly PRIVATE_KEY_PATH = path.join(
        homedir(),
        ".cybershuttle",
        this.KEY_NAME,
    );

    private state: CloudProviderState = {
        name: "aws",
        accessKey: "",
        secretKey: "",
        sessionToken: "",
        region: "us-east-1",
        // add test data to see how UI looks
        instances: [{ instanceID: "12313", instanceType: "M5", name: "test1", state: "running" }, { instanceID: "asdfq", instanceType: "M5a", name: "test2", state: "running" }],
    };

    protected handleMessage(data: WebviewMessage): void {
        switch (data.command) {
            case "ready":
                this.pushState();
                break;
            case "launch":
                this.generateSSHKeyPair();
                // this.creatSSHSecurityGroup()
                // this.launchEC2Instance();
                break;
            case "rm-key-pair":
                this.remmoveKeyPair(this.PRIVATE_KEY_PATH);
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
        this.initEC2Client();
    }

    // add options for ec2 instance later
    // Launch insteance with custom CS-Bridge tag
    // all to query only instances launched by ext
    public async launchEC2Instance(): Promise<void> {
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
    private async generateSSHKeyPair(): Promise<void> {
        try {
            if (!existsSync(this.PRIVATE_KEY_PATH)) {
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
            } else {
                console.log(
                    "Dectecting Keys Exists. ...Skipping Key Pair generation. ",
                );
            }
        } catch (error) {
            if (error instanceof Error) {
                console.error(`AWS Error (${error.name}):`, error.message,);
            } else {
                console.error("An unknown error occurred:", error);
            }
        }
    }

    public async remmoveKeyPair(keyName: string): Promise<void> {
        try {
            console.log("Removing Key Pair from AWS");
            const command = new DeleteKeyPairCommand({ KeyName: keyName });
            await this.client?.send(command);
            console.log("Removing local copy of key");
            unlinkSync(this.PRIVATE_KEY_PATH);
        } catch (error) {
            if (error instanceof EC2ServiceException) {
                console.error(`AWS Error [${error.name}]: ${error.message}`);
            } else {
                console.error(`Unhandled Error ${error}`);
            }
        }
    }
    // Create Security For SSH Access
    public async creatSSHSecurityGroup(): Promise<string | undefined> {
        if (this.client === null) {
            throw new Error("EC2 Client is not initialized")
        }
        try {
            const createCommand = new CreateSecurityGroupCommand({
                GroupName: "CS-Brige VSCode Ext SSH Access",
                Description: "Security group - CS-Bridge SSH access",
            });

            const createResponse = await this.client.send(createCommand);
            const groupID = createResponse.GroupId;
            console.log(`Created Security Group with ID: ${groupID}`);

            const sshGroupCommand = new AuthorizeSecurityGroupIngressCommand({
                GroupId: groupID,
                IpPermissions: [
                    {
                        IpProtocol: "tcp",
                        FromPort: 22,
                        ToPort: 22,
                        IpRanges: [
                            {
                                CidrIp: "0.0.0.0/0",
                                Description: " SSH Access"
                            }
                        ]
                    }
                ]
            });

            await this.client.send(sshGroupCommand);
            console.log("Inbound SSH rule attached to the new group.");
            return groupID


        } catch (error) {
            console.error("Creating SSH Sec Group failed:", error);
        }
    }
    // Stop Instace from webview
    // public async stopInstance(instanceID: string): Promise<void> { }

    // Poll status of instance
    public async instanceStatus(): Promise<void> {
        // Filter instasnce with custon CS-bridge tag 
        if (this.client === null) {
            return
        }
        const instances: AWSInstanceInfo[] = [];

        const config = {
            client: this.client,
            input: {
                Filters: [
                    {
                        Name: "tag:Environment",
                        Values: ["CS-Bridge"]
                    }
                ]
            }
        };
        try {
            const paginator = paginateDescribeInstances(config, {});

            for await (const page of paginator) {
                if (page.Reservations) {
                    for (const reservation of page.Reservations) {
                        if (reservation.Instances) {
                            reservation.Instances.map(instance => {
                                const inst: AWSInstanceInfo = {
                                    instanceID: instance.InstanceId,
                                    instanceType: instance.InstanceType,
                                    name: instance.Tags?.find(value => value.Key == "Name")?.Value,
                                    state: instance.State?.Name
                                }
                                instances.push(inst)
                            })
                        }
                    }
                }
            }
        } catch (error) {
            console.error("Get instances failed:", error);
        }
    }
}
