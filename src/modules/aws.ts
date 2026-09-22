import * as vscode from 'vscode';
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
    StopInstancesCommand,
    StartInstancesCommand,
    TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";

import { CloudInstanceInfo, InstanceActions, SshHost } from "../models";
import { addSshConfigEntryAWS, removeSshConfigEntryAWS, SshManager } from '../modules/sshSupport';
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { homedir } from "os";
import path from "path";
import { confirmModal } from '@/webviewProvider';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const CS_SSH_CONFIG_PATH = path.join(homedir(), '.cybershuttle', 'ssh_config');
export default class AWSClient {
    protected readonly KEY_NAME = "cs-aws-generated-key";
    private client: EC2Client | null = null;
    private readonly securityGroupName = "CS-Brige VSCode Ext SSH Access"
    protected pollInternval: NodeJS.Timeout | null = null;
    protected instances: CloudInstanceInfo[] = []
    protected hosts: SshHost[] = []


    protected readonly PRIVATE_KEY_PATH = path.join(
        homedir(),
        ".cybershuttle",
        this.KEY_NAME,
    );


    private toast(title: string, message: string, cancellable: boolean) {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title,
            cancellable
        }, async (progress) => {
            progress.report({ message });
            await new Promise(resolve => setTimeout(resolve, 5000));

        });
    }

    constructor() {
    }

    public isReady(): boolean {
        return this.client !== null
    }



    public async initEC2Client(region: string): Promise<void> {

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

        this.client = new EC2Client({
            region: region,
            credentials: {
                accessKeyId: accessKey,
                secretAccessKey: secretKey,
                sessionToken: sessionToken,
            },
        });
    }
    // Entire workflow for launching EC2 instance
    public async launchEC2Instance(): Promise<void> {

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
    protected async createInstance(keyName: string, securityGroupID: string): Promise<void> {
        if (this.client === null) {
            throw new Error("EC2 Client is not initialized")
        }
        const instanceID = crypto.randomUUID().slice(0, 5)
        try {

            await this.client.send(new RunInstancesCommand({
                ImageId: "ami-0001e312b82212f65", // Not sure how many options to show 
                InstanceType: "t3.medium",
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

    public async doInstanceActions(action: InstanceActions, instanceID: string, instanceName: string): Promise<void> {
        if (this.client === null) {
            throw new Error("EC2 Client is not initialized")
        }

        let command = null;
        let msg = "no action"
        let title = "no action"
        switch (action) {
            case InstanceActions.Stop:
                command = new StopInstancesCommand({
                    InstanceIds: [instanceID],
                });
                break
            case InstanceActions.Start:
                command = new StartInstancesCommand({
                    InstanceIds: [instanceID],
                });
                break
            case InstanceActions.Remove:
                command = new TerminateInstancesCommand({
                    InstanceIds: [instanceID],
                });
        }

        try {
            await this.client.send(command);

            switch (action) {
                case InstanceActions.Stop:
                    msg = `Stopping instance: ${instanceID}`
                    title = "Stop Instance"
                    break
                case InstanceActions.Start:
                    msg = `Restarting instance: ${instanceID}`
                    title = "Restart Instance"
                    break
                case InstanceActions.Remove:
                    msg = `Removing instance: ${instanceID}`
                    title = "Remove Instance"
                    break
            }
            console.log(msg);
            this.toast(title, msg, false)

            if (action === InstanceActions.Remove) {
                await this.removeSshConfigEntryAWS(instanceID, instanceName)
            }

        } catch (error) {
            const errMsg = `Error ${title}: ${error}`
            console.error(errMsg);
            vscode.window.showErrorMessage(errMsg)
        }
    }

    public async removeInstance(instanceID: string, instanceName: string): Promise<void> {
        console.log("Start Removing Instance")
        const confirmed = await confirmModal('Remove Instnace?', 'Remove',
            'This stops and terminates the instance')
        if (!confirmed) {
            console.log("Cancel remove")
            return;
        }
        await this.doInstanceActions(InstanceActions.Remove, instanceID, instanceName)
    }

    public getInstances(): CloudInstanceInfo[] {
        return this.instances
    }


    public async pollInstances(): Promise<void> {
        if (this.client === null) {
            throw new Error("EC2 Client is not initialized")
        }
        const instances: CloudInstanceInfo[] = [];

        const config = {
            client: this.client,
            pageSize: 15,
        };
        const params = {
            Filters: [
                {
                    Name: "tag:Environment",
                    Values: ["CS-Bridge"]
                },
                {
                    Name: "instance-state-name",
                    Values: ["pending", "running", "shutting-down", "stopping", "stopped"]
                }
            ]
        }
        console.log("Fetching instances ....")
        try {
            const paginator = paginateDescribeInstances(config, params);

            for await (const page of paginator) {
                if (page.Reservations) {
                    for (const reservation of page.Reservations) {
                        if (reservation.Instances) {
                            reservation.Instances.map(instance => {
                                const inst: CloudInstanceInfo = {
                                    instanceID: instance.InstanceId,
                                    instanceType: instance.InstanceType,
                                    name: instance.Tags?.find(value => value.Key == "Name")?.Value,
                                    state: instance.State?.Name,
                                    publicIp: instance.PublicIpAddress
                                }
                                instances.push(inst)

                            })
                        }
                    }
                }
            }

            this.instances = instances
            console.log("Cloud SSH Hosts: ", this.hosts)
            console.log("Cloud Instances: ", this.instances)
        } catch (error) {
            console.error("Get instances failed:", error);
        }

    }

    public openTerminal(ip: string): void {
        const hostString = `ec2-user@${ip}`
        vscode.window.createTerminal({ name: ip, shellPath: 'ssh', shellArgs: [...SshManager.getInstance().buildControlMasterArgs(ip), "-i", this.PRIVATE_KEY_PATH, hostString] }).show();

    }

    public async openRemoteSession(id: string, name: string, ip: string): Promise<void> {
        this.hosts = SshManager.getInstance().getCSHosts()
        console.log("Checking SSH Config")
        if (this.hosts.find(host => host.hostname === ip)) {
            console.log("Found existing entry")
        } else {
            await addSshConfigEntryAWS(id, name, ip, 22, this.PRIVATE_KEY_PATH)
            this.hosts = SshManager.getInstance().getCSHosts()
        }

        const sshConfig = vscode.workspace.getConfiguration('remote.SSH');
        await sshConfig.update('configFile', CS_SSH_CONFIG_PATH, vscode.ConfigurationTarget.Global);

        const uri = vscode.Uri.from({
            scheme: 'vscode-remote',
            authority: `ssh-remote+${name}`,
            path: '/'
        });


        console.log("Openning Remote Session")
        await vscode.commands.executeCommand('vscode.openFolder', uri, {
            forceNewWindow: true
        });

    }

    protected async removeSshConfigEntryAWS(id: string, name: string): Promise<void> {
        console.log(`Remove SSH Config for ${name} `)
        await removeSshConfigEntryAWS(id, name)

    }


}
