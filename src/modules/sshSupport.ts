import { SshHost, SlurmSession, PromptObserver, PromptCancelledError } from '../models';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import { Logger, errMsg } from '../logger';
import { lock, release } from './fsSupport';
import { buildShellCommand, extractCommandResult, READY_MARKER, renderAuthHtml } from './sshShell';
import { USER_SSH_CONFIG_PATH, SYSTEM_SSH_CONFIG_PATH, mergeHostsByPriority, parseHostsFromConfigText, buildSshConfigBlock, csHostAlias } from './sshHostsStore';

const logger = Logger.getInstance();
const CS_SSH_CONFIG_PATH = path.join(os.homedir(), '.cybershuttle', 'ssh_config');
const CS_SSH_KEYS_DIR = path.join(os.homedir(), '.cybershuttle', 'ssh_keys');
const CS_SSH_CONTROL_DIR = path.join(os.homedir(), '.cybershuttle', 'ssh_control');

const sessionKeyPath = (sessionId: string): string => path.join(CS_SSH_KEYS_DIR, `id_cshost-${sessionId}`);

type CommandResult = { stdout: string; stderr: string; code: number };

// The single command in flight on a shell; its streams accumulate until both sentinels arrive (see sshShell).
type Pending = { rid: string; outBuf: string; errBuf: string; settled: boolean; resolve: (r: CommandResult) => void };

// One persistent `ssh … bash -l` per host. `ready` resolves once the connect noise is drained; on Win32 (no
// ControlMaster) this in-process channel is the only multiplexing, so authentication happens once here.
type HostShell = {
    proc: ChildProcess;
    askpassDir: string;
    ready: Promise<void>;
    alive: boolean;
    connecting: boolean;
    dismissed: boolean;
    current?: Pending;
};

export class SshManager {
    private static instance: SshManager | undefined;

    // One persistent shell per host, plus a per-host serial queue so a single in-flight command owns the streams.
    private readonly shells = new Map<string, HostShell>();
    private readonly queues = new Map<string, Promise<unknown>>();

    private constructor(private readonly extensionUri: vscode.Uri) {
        if (!fs.existsSync(CS_SSH_CONTROL_DIR)) {
            fs.mkdirSync(CS_SSH_CONTROL_DIR, { recursive: true, mode: 0o700 });
        }

        if (!fs.existsSync(CS_SSH_KEYS_DIR)) {
            fs.mkdirSync(CS_SSH_KEYS_DIR, { recursive: true, mode: 0o700 });
        }
    }

    public static initInstance(extensionUri: vscode.Uri): SshManager {
        if (!SshManager.instance) {
            SshManager.instance = new SshManager(extensionUri);
        }

        // Include'd above the user's global entries so cshost-* aliases win via SSH first-match.
        if (!fs.existsSync(CS_SSH_CONFIG_PATH)) {
            fs.mkdirSync(path.dirname(CS_SSH_CONFIG_PATH), { recursive: true, mode: 0o700 });
            fs.writeFileSync(CS_SSH_CONFIG_PATH, '', { mode: 0o600 });
        }
        SshManager.instance.ensureSshInclude(CS_SSH_CONFIG_PATH);
        return SshManager.instance;
    }

    public static getInstance(): SshManager {
        if (!SshManager.instance) {
            throw new Error('SshManager not initialized. Call initInstance() first.');
        }
        return SshManager.instance;
    }

    private readHostsFile(filePath: string, source: 'user' | 'system'): SshHost[] {
        try {
            if (!fs.existsSync(filePath)) { return []; }
            const text = fs.readFileSync(filePath, 'utf-8');
            return parseHostsFromConfigText(text).map(h => ({ ...h, source }));
        }
        catch (err) {
            logger.error(`Error reading SSH config ${filePath}:`, err);
            return [];
        }
    }

    public getMergedHosts(): SshHost[] {
        return mergeHostsByPriority(
            this.readHostsFile(USER_SSH_CONFIG_PATH, 'user'),
            this.readHostsFile(SYSTEM_SSH_CONFIG_PATH, 'system'),
        );
    }

    private buildControlMasterArgs(hostName: string): string[] {
        // Windows OpenSSH has no Unix-socket ControlMaster ("getsockname failed: Not a socket").
        if (process.platform === 'win32') {
            return [];
        }
        // Hashed socket name keeps ControlPath under the 104-byte UNIX socket limit.
        const hash = crypto.createHash('sha256').update(hostName).digest('hex').substring(0, 16);
        const socketPath = path.join(CS_SSH_CONTROL_DIR, hash);
        return [
            '-o', `ControlMaster=auto`,
            '-o', `ControlPath=${socketPath}`,
            '-o', `ControlPersist=600`,
        ];
    }

    // Every remote command rides the host's one persistent shell, established on demand and reused until it drops.
    // batch: a background poll won't open a new connection that would raise a Duo box it can't answer — it rides an
    // existing shell or fails fast (caller retries). A user-driven (observer) call authenticates interactively.
    public runRemoteCommand(hostName: string, command: string, observer?: PromptObserver, opts?: { batch?: boolean }): Promise<CommandResult> {
        return this.enqueue(hostName, async () => {
            let shell: HostShell;
            try { shell = await this.ensureShell(hostName, !!opts?.batch, observer); }
            catch (err) {
                if (err instanceof PromptCancelledError) { throw err; }
                return { stdout: '', stderr: errMsg(err), code: 255 };
            }
            return this.runOnShell(shell, command);
        });
    }

    public disposeAll(): void {
        for (const shell of this.shells.values()) {
            shell.alive = false; try { shell.proc.kill(); }
            catch { /* already gone */ }
        }
        this.shells.clear();
    }

    public static disposeInstance(): void {
        SshManager.instance?.disposeAll();
    }

    // Per-host serial queue: chain each command after the previous so one Pending owns the shell's streams at a time.
    private enqueue<T>(hostName: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.queues.get(hostName) ?? Promise.resolve();
        const next = prev.then(fn, fn);
        this.queues.set(hostName, next.then(() => { }, () => { }));
        return next;
    }

    private async ensureShell(hostName: string, batch: boolean, observer?: PromptObserver): Promise<HostShell> {
        let shell = this.shells.get(hostName);
        if (!shell || !shell.alive) {
            shell = this.spawnShell(hostName, batch, observer);
            this.shells.set(hostName, shell);
        }
        await shell.ready; // throws if this shell died during connect (auth failure / dismiss); caller maps it
        return shell;
    }

    private runOnShell(shell: HostShell, command: string): Promise<CommandResult> {
        return new Promise<CommandResult>((resolve) => {
            const rid = crypto.randomBytes(8).toString('hex');
            shell.current = { rid, outBuf: '', errBuf: '', settled: false, resolve };
            shell.proc.stdin!.write(buildShellCommand(rid, command));
        });
    }

    private spawnShell(hostName: string, batch: boolean, observer?: PromptObserver): HostShell {
        const askpassDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-askpass-'));
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (!batch) {
            const isWin = process.platform === 'win32';
            const wrapper = path.join(this.extensionUri.fsPath, 'scripts', isWin ? 'askpass.cmd' : 'askpass.sh');
            if (!isWin) {
                try { fs.chmodSync(wrapper, 0o755); }
                catch { /* vsix ships +x */ }
            }
            Object.assign(env, {
                SSH_ASKPASS: wrapper,
                SSH_ASKPASS_REQUIRE: 'force',
                CS_ASKPASS_DIR: askpassDir,
                CS_ASKPASS_JS: path.join(this.extensionUri.fsPath, 'scripts', 'askpass.js'),
                CS_NODE_BIN: process.execPath,
                DISPLAY: ':0',
            });
        }

        const connectArgs = batch
            ? ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
            : ['-o', 'NumberOfPasswordPrompts=3'];

        // `bash -l` gives the same PATH (SLURM binaries) a login shell has; the channel is held open and fed commands.
        const proc = spawn('ssh', [
            ...this.buildControlMasterArgs(hostName),
            ...connectArgs,
            '-o', 'ServerAliveInterval=15',
            '-o', 'ServerAliveCountMax=3',
            hostName,
            'bash -l',
        ], { env, stdio: ['pipe', 'pipe', 'pipe'] });

        let readyResolve!: () => void;
        let readyReject!: (e: Error) => void;
        const shell: HostShell = {
            proc, askpassDir, alive: true, connecting: true, dismissed: false,
            ready: new Promise<void>((res, rej) => { readyResolve = res; readyReject = rej; }),
        };

        const settle = (p: Pending): void => {
            const result = extractCommandResult(p.rid, p.outBuf, p.errBuf);
            if (result && !p.settled) { p.settled = true; p.resolve(result); }
        };

        let readyBuf = '';
        proc.stdout!.on('data', (d: Buffer) => {
            const s = d.toString();
            if (shell.connecting) {
                readyBuf += s; // drain profile/MOTD noise until the shell echoes its readiness marker
                if (readyBuf.includes(READY_MARKER)) { shell.connecting = false; readyResolve(); }
                return;
            }
            if (shell.current) { shell.current.outBuf += s; settle(shell.current); }
        });
        proc.stderr!.on('data', (d: Buffer) => {
            if (!shell.connecting && shell.current) { shell.current.errBuf += d.toString(); settle(shell.current); }
        });
        proc.stdin!.on('error', () => { /* write races a dropped connection; the close handler settles the command */ });

        proc.stdin!.write(`printf '\\n${READY_MARKER}\\n'\n`);

        const poll = batch ? undefined : this.pollAskpass(shell, hostName, observer);
        const stopPoll = (): void => { if (poll) { clearInterval(poll); } };
        shell.ready.then(stopPoll, stopPoll); // authentication is one-shot at connect

        const drop = (onConnect: () => Error): void => {
            shell.alive = false;
            stopPoll();
            try { fs.rmSync(askpassDir, { recursive: true, force: true }); }
            catch { /* best-effort */ }
            if (this.shells.get(hostName) === shell) { this.shells.delete(hostName); }
            if (shell.connecting) { shell.connecting = false; readyReject(onConnect()); }
            if (shell.current && !shell.current.settled) {
                shell.current.settled = true;
                shell.current.resolve({ stdout: shell.current.outBuf, stderr: `${shell.current.errBuf}\nssh connection closed`, code: 255 });
            }
        };
        proc.on('close', (code: number | null) => drop(() => shell.dismissed
            ? new PromptCancelledError('Interrupted by user')
            : new Error(`SSH connection to ${hostName} closed (exit ${code ?? 'null'})`)));
        proc.on('error', (err: Error) => drop(() => err));

        return shell;
    }

    // SSH auth prompt in a monospace webview (renderAuthHtml); resolves to the response, or undefined on dismiss.
    private promptAuth(hostName: string, prompt: string): Promise<string | undefined> {
        const nonce = crypto.randomBytes(16).toString('hex');
        const panel = vscode.window.createWebviewPanel(
            'csbridge.sshAuth', `SSH Authentication — ${hostName}`,
            vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true },
        );
        panel.webview.html = renderAuthHtml(prompt, nonce);
        return new Promise<string | undefined>((resolve) => {
            const finish = (v?: string) => { resolve(v); panel.dispose(); }; // resolve latches, dispose is idempotent
            panel.webview.onDidReceiveMessage((m: { type?: string; value?: string }) =>
                finish(m?.type === 'submit' ? (m.value ?? '') : undefined));
            panel.onDidDispose(() => finish(undefined));
        });
    }

    private pollAskpass(shell: HostShell, hostName: string, observer?: PromptObserver): NodeJS.Timeout {
        const handled = new Set<string>();
        const cancelFile = path.join(shell.askpassDir, 'cancel');
        return setInterval(async () => {
            if (!shell.alive) { return; }
            let files: string[];
            try { files = fs.readdirSync(shell.askpassDir); }
            catch { return; }
            for (const file of files) {
                if (!file.startsWith('prompt-') || handled.has(file)) { continue; }
                handled.add(file);
                try {
                    const { id, prompt } = JSON.parse(fs.readFileSync(path.join(shell.askpassDir, file), 'utf-8'));
                    observer?.('opened');
                    const password = await this.promptAuth(hostName, String(prompt));
                    if (password !== undefined) {
                        fs.writeFileSync(path.join(shell.askpassDir, `response-${id}`), password, 'utf-8');
                        observer?.('answered');
                    }
                    else {
                        // Only callers that opted into prompt handling (an observer) treat a dismiss as cancellation;
                        // others just get the non-zero exit from the killed ssh.
                        shell.dismissed = observer !== undefined;
                        fs.writeFileSync(cancelFile, '', 'utf-8');
                        shell.proc.kill();
                    }
                }
                catch { /* prompt-file read race — ignore, retry next tick */ }
            }
        }, 200);
    }

    private ensureSshInclude(targetPath: string): void {
        const sshDir = path.join(os.homedir(), '.ssh');
        const sshConfigPath = path.join(sshDir, 'config');
        const includeLine = `Include ${targetPath}`;

        try {
            if (!fs.existsSync(sshDir)) {
                fs.mkdirSync(sshDir, { mode: 0o700 });
            }
            if (!fs.existsSync(sshConfigPath)) {
                fs.writeFileSync(sshConfigPath, `${includeLine}\n`, { mode: 0o600 });
                return;
            }
            const content = fs.readFileSync(sshConfigPath, 'utf-8');
            if (!content.includes(includeLine)) {
                // Include must appear before any Host/Match blocks to take effect
                fs.writeFileSync(sshConfigPath, `${includeLine}\n${content}`);
            }
        }
        catch (err) {
            logger.error(`[ssh] Failed to add Include to ~/.ssh/config: ${errMsg(err)}`);
        }
    }
}

export function addSshConfigEntry(session: SlurmSession, localPort: number, privateKey: string): string {
    const hostAlias = csHostAlias(session.cluster, session.name);
    removeSshConfigEntry(session.id, hostAlias);
    writeSessionPrivateKey(session.id, privateKey);

    const hostname = '127.0.0.1';
    const user = 'cs-ssh-user'; // any non-empty value works; the custom SSH server ignores the username
    const configBlock = buildSshConfigBlock(session.id, hostAlias, hostname, localPort, user, sessionKeyPath(session.id));

    // Locked: startup reattach can rewrite this concurrently, so the append must not interleave.
    lock(CS_SSH_CONFIG_PATH);
    try {
        fs.appendFileSync(CS_SSH_CONFIG_PATH, `\n${configBlock}\n`);
    }
    catch (err) {
        logger.error(`Failed to write SSH config for session ${session.id}:`, err);
    }
    finally {
        release(CS_SSH_CONFIG_PATH);
    }
    return hostAlias;
}

export function writeSessionPrivateKey(sessionId: string, privateKey: string): void {
    fs.mkdirSync(CS_SSH_KEYS_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(sessionKeyPath(sessionId), privateKey, { mode: 0o600 });
}

export function getSessionPrivateKey(sessionId: string): string | undefined {
    try { return fs.readFileSync(sessionKeyPath(sessionId), 'utf-8'); }
    catch { return undefined; }
}

function removeSessionPrivateKey(sessionId: string): void {
    const privateKeyPath = sessionKeyPath(sessionId);
    try {
        if (fs.existsSync(privateKeyPath)) {
            fs.unlinkSync(privateKeyPath);
        }
    }
    catch (err) {
        logger.error(`Failed to remove SSH private key for session ${sessionId}:`, err);
    }
}

export function removeSshConfigEntry(sessionId: string, hostAlias: string): void {
    lock(CS_SSH_CONFIG_PATH);
    try {
        const content = fs.readFileSync(CS_SSH_CONFIG_PATH, 'utf-8');
        // Escape the alias (a cluster name may contain '.') so it can't over-match; the id marker is a regex-safe uuid.
        const aliasRe = hostAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(
            `(?:\\n|^)# CS-Bridge auto-generated for session ${sessionId}\\nHost ${aliasRe}\\n(?:    [^\\n]+\\n)*`,
            'gm',
        );
        const cleaned = content.replace(re, '');
        if (cleaned !== content) {
            fs.writeFileSync(CS_SSH_CONFIG_PATH, cleaned);
        }

        removeSessionPrivateKey(sessionId);
    }
    catch (err) {
        logger.error(`Failed to clear SSH config entry for session ${sessionId}:`, err);
    }
    finally {
        release(CS_SSH_CONFIG_PATH);
    }
}
