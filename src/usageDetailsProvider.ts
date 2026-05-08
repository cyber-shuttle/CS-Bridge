import * as vscode from 'vscode';
import { Logger } from './logger';
import { getJobOutput } from './modules/slurmSupport';
import { JobOutput } from './models';

export class UsageDetailsProvider implements vscode.TextDocumentContentProvider {
    public static readonly scheme = 'cybershuttle-job';

    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange = this._onDidChange.event;

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const [cluster, jobId] = uri.path.replace(/^\/+/, '').replace(/\.md$/, '').split('/');
        try {
            const output = await getJobOutput(cluster, jobId);
            return output
                ? renderMarkdown(cluster, jobId, output)
                : `# Job ${jobId}\n\nOutput not available — SLURM controller may have purged this job's record.\n`;
        } catch (err) {
            Logger.getInstance().error(`UsageDetailsProvider: getJobOutput(${cluster}, ${jobId}) failed:`, err);
            const msg = err instanceof Error ? err.message : String(err);
            return `# Job ${jobId}\n\n_Failed to fetch job details: ${msg}_\n`;
        }
    }

    refresh(uri: vscode.Uri): void { this._onDidChange.fire(uri); }
}

const FIELDS: Array<[string, keyof JobOutput]> = [
    ['Partition', 'partition'],
    ['Elapsed', 'elapsed'],
    ['Time Limit', 'timeLimit'],
    ['Submit Time', 'submitTime'],
    ['Start Time', 'startTime'],
    ['End Time', 'endTime'],
    ['Node List', 'nodeList'],
    ['Working Dir', 'workDir'],
    ['Account', 'account'],
    ['Exit Code', 'exitCode'],
    ['Reason', 'reason'],
];

function renderMarkdown(cluster: string, jobId: string, o: JobOutput): string {
    const rows = FIELDS.map(([l, k]) => `| ${l} | ${o[k] || '—'} |`).join('\n');
    const logBlock = (label: string, path?: string, content?: string) => path
        ? `## ${label} \`${path}\`\n\`\`\`log\n${content || '(empty)'}\n\`\`\``
        : `## ${label} _(no log path)_`;
    const sections = [
        `# Job ${jobId}${o.name ? ' · ' + o.name : ''}`,
        `\`${o.state || '—'}\` on cluster **${cluster}**`,
        `| | |\n|---|---|\n${rows}`,
        logBlock('stdout', o.stdoutPath, o.stdout),
        logBlock('stderr', o.stderrPath, o.stderr),
    ];
    if (o.rawScontrol) {
        sections.push(`<details>\n<summary>Raw scontrol output</summary>\n\n\`\`\`\n${o.rawScontrol}\n\`\`\`\n</details>`);
    }
    return sections.join('\n\n');
}
