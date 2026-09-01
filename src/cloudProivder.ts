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
    DescribeSecurityGroupsCommand,
    RunInstancesCommand,
} from "@aws-sdk/client-ec2";

// Webview provider for the Cloud Provider view .
export class CloudProvider extends WebviewProvider {
    public static readonly viewType = "csbridge.cloudView";
    protected readonly viewKind = "cloud" as const;
    protected readonly KEY_NAME = "cs-aws-generated-key";
    private client: EC2Client | null = null;
    private readonly securityGroupName = "CS-Brige VSCode Ext SSH Access"
    protected pollInternval: NodeJS.Timeout | null = null;


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
        instances: [],
        clientInit: false
    };

    protected handleMessage(data: WebviewMessage): void {
        switch (data.command) {
            case "ready":
                this.pushState();
                break;
            case "launch":
                this.launchEC2Instance();
                break;
            case "rm-key-pair":
                this.remmoveKeyPair(this.PRIVATE_KEY_PATH);
            case "poll-instances":
                if (this.client !== null) {
                    this.getInstances()
                    this.pollInternval = setInterval(() => this.getInstances(), 30000) // poll every 30 secs
                }
            case "stop-instance":
                console.log(data.name ?? "no name")
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
        this.initEC2Client();
        this.pushState();
        // this.getInstances()
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
        this.state = {
            ...this.state,
            clientInit: true
        };
    }
    // Entire workflow for launching EC2 instance
    public async launchEC2Instance(): Promise<void> {

        const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
        vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Setting up EC2 Instance...",
                cancellable: true,
            },
            // Outline for what is needed to launch instance
            async (progress) => {
                try {
                    progress.report({ message: "Generating SSH Key Pair..." });
                    await this.generateSSHKeyPair()
                    await sleep(2500)
                    progress.report({ message: "Check Security Groups" });
                    const securityGroupID = await this.getSSHSecurityGroup()
                    await sleep(2500)
                    if (securityGroupID === "") {

                        progress.report({ message: "Did not find existing security group for CS-Bridge" });
                        await sleep(2500)
                        progress.report({ message: "Creating new Security Group" });
                        await this.creatSSHSecurityGroup()
                        await sleep(2500)
                    } else {
                        progress.report({ message: "Found existing CS-Bridge Security Group" });
                        await sleep(2500)
                    }
                    progress.report({ message: "Creating Instnace..." });
                    this.createInstance(this.KEY_NAME, securityGroupID)
                    sleep(3000)
                    progress.report({ message: "Instance is running." });
                } catch (error: any) {
                    vscode.window.showErrorMessage("Failed to launch instance");
                }
            },
        );
    }

    // Create EC2 Instance
    // add options for image, and instance type later
    private async createInstance(keyName: string, securityGroupID: string): Promise<void> {
        if (this.client === null) {
            throw new Error("EC2 Client is not initialized")
        }
        const instanceID = crypto.randomUUID().slice(0, 5)
        try {

            await this.client.send(new RunInstancesCommand({
                ImageId: "ami-0001e312b82212f65", // Not sure how many options to show 
                InstanceType: "t3.micro",
                KeyName: keyName,
                SecurityGroupIds: [securityGroupID],
                MinCount: 1,
                MaxCount: 1,
                TagSpecifications: [
                    {
                        ResourceType: "instance",
                        Tags: [
                            { Key: "Name", Value: `CS-Bridge-Instance-${instanceID}` },
                            { Key: "Environment", Value: "CS-Bridge" }
                        ]
                    }
                ]
            }));
        } catch (errors) {
            console.log("Failed to create instance: ", errors)
        }

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
                console.error(`Error (${error.name}):`, error.message,);
            } else {
                console.error("An unknown error occurred:", error);
            }
        }
    }

    public async remmoveKeyPair(keyName: string): Promise<void> {
        if (this.client === null) {
            throw new Error("EC2 Client is not initialized")
        }
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
    // Get Existing Security For CS-Brige
    public async getSSHSecurityGroup(): Promise<string> {
        if (this.client === null) {

            throw new Error("EC2 Client is not initialized")
        }
        const params = {
            Filters: [
                {
                    Name: "group-name",
                    Values: [this.securityGroupName]
                }
            ]
        };

        try {
            const command = new DescribeSecurityGroupsCommand(params);
            const data = await this.client.send(command);

            const securityGroups = data.SecurityGroups;
            if (this.securityGroupName.length === 0) {
                console.log("Did not find exisitng group")
                return ""
            } else {
                console.log("Found Exisitng Sec Group")
                return securityGroups?.at(0)?.GroupName ?? ""
            }

        } catch (error) {
            console.error("Failed to get Security Groups:", error);
        }
        return ""

    }
    // Create Security For SSH Access
    public async creatSSHSecurityGroup(): Promise<string> {
        if (this.client === null) {
            throw new Error("EC2 Client is not initialized")
        }
        try {
            const createCommand = new CreateSecurityGroupCommand({
                GroupName: this.securityGroupName,
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
            return groupID ?? ""


        } catch (error) {
            console.error("Creating SSH Sec Group failed:", error);
            return ""
        }
    }
    // Stop Instace from webview
    // public async stopInstance(instanceID: string): Promise<void> { }


    public async getInstances(): Promise<void> {
        if (this.client === null) {
            throw new Error("EC2 Client is not initialized")
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
        console.log("Fetching instances ....")
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


        this.state = {
            ...this.state,
            instances: instances
        };
        this.pushState()
    }

    // public async pollInstances(): Promise<void> {
    //     if (this.client === null) {
    //         throw new Error("EC2 Client is not initialized")
    //     }
    //     console.log("Fetching instance status ...")
    //     await this.getInstances()
    //     this.pollInternval = setInterval(() => this.getInstances(), 3000)
    //
    // }

}
