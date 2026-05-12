import * as vscode from 'vscode';
import { Logger } from './logger';
import { getAllSessions } from './extensionStore';
import { getRecentJobs } from './modules/slurmSupport';
import { RecentJob } from './models';

class ClusterNode extends vscode.TreeItem {
    constructor(public readonly cluster: string) {
        super(cluster, vscode.TreeItemCollapsibleState.Collapsed);
    }
}

class SectionNode extends vscode.TreeItem {
    constructor(
        public readonly cluster: string,
        public readonly kind: 'active' | 'recent',
        public readonly jobs: RecentJob[]
    ) {
        super(`${kind === 'active' ? 'Active' : 'Recent'} (${jobs.length})`, vscode.TreeItemCollapsibleState.Expanded);
    }
}

class JobNode extends vscode.TreeItem {
    constructor(public readonly cluster: string, public readonly job: RecentJob) {
        super(job.jobId, vscode.TreeItemCollapsibleState.None);
        const time = job.elapsed + (job.timeLimit && job.timeLimit !== 'UNLIMITED' ? ` / ${job.timeLimit}` : '');
        this.description = `${job.name}${time ? ' · ' + time : ''}`;
        const tooltipBits = [job.state, job.partition].filter(Boolean);
        if (job.reason) { tooltipBits.push(`reason: ${job.reason}`); }
        if (job.exitCode) { tooltipBits.push(`exit: ${job.exitCode}`); }
        this.tooltip = tooltipBits.join(' · ');
        this.iconPath = new vscode.ThemeIcon('circle-filled', stateColor(job.state));
        this.command = {
            command: 'cybershuttle.usage.openJob',
            title: 'Open Job Detail',
            arguments: [{ cluster, jobId: job.jobId }],
        };
    }
}

function stateColor(state: string): vscode.ThemeColor {
    if (/RUNNING/i.test(state)) { return new vscode.ThemeColor('testing.iconPassed'); }
    if (/PENDING|CONFIGURING|SUSPENDED/i.test(state)) { return new vscode.ThemeColor('editorWarning.foreground'); }
    if (/FAILED|TIMEOUT|OUT_OF_MEMORY|NODE_FAIL/i.test(state)) { return new vscode.ThemeColor('errorForeground'); }
    return new vscode.ThemeColor('descriptionForeground');
}

export class UsageTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    public static readonly viewType = 'cybershuttle.usageView';

    getTreeItem(node: vscode.TreeItem): vscode.TreeItem { return node; }

    async getChildren(node?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!node) {
            const clusters = [...new Set(getAllSessions().map(s => s.cluster).filter(Boolean))];
            return clusters.length === 0
                ? [new vscode.TreeItem('No sessions yet — create one to populate clusters.')]
                : clusters.map(c => new ClusterNode(c));
        }
        if (node instanceof ClusterNode) {
            const result = await getRecentJobs(node.cluster)
                .catch(err => { Logger.getInstance().error(`UsageTreeProvider: getRecentJobs(${node.cluster}) failed:`, err); return null; });
            if (!result) { return [new vscode.TreeItem('SLURM not available on this cluster.')]; }
            return [
                new SectionNode(node.cluster, 'active', result.active),
                new SectionNode(node.cluster, 'recent', result.recent),
            ];
        }
        if (node instanceof SectionNode) {
            return node.jobs.length === 0
                ? [new vscode.TreeItem(node.kind === 'active' ? 'No active jobs.' : 'No recent jobs in the last 30 days.')]
                : node.jobs.map(j => new JobNode(node.cluster, j));
        }
        return [];
    }
}
