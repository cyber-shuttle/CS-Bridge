import { Workspace } from "./WorkspaceManager";
import * as vscode from 'vscode';
import { ChildProcess } from 'child_process';
import { TunnelManager } from "./TunnelManager";
import { LocalLinkspanManager } from "./LocalLinkspan";
import { PersistentShell, SshManager } from "./SshManager";
import { StorageBrowserManager } from "./StorageBrowserManager";
import { DataCache } from "./vfs/DataCache";
import { SyncProvider } from "./vfs/SyncProvider";
import { MountProvider } from "./vfs/MountProvider";
import { MetricsCollector } from "./instrumentation";

export interface CSExtensionContext {
    internalSshConfigPath: string;
    windowId: string;
    workspaces: Workspace[];
    workspaceState: vscode.Memento;
    logTailProcesses: Map<string, ChildProcess>;
    associationsCts: Map<string, vscode.CancellationTokenSource>;
    cachedRemoteHome: Map<string, string>;
    localProcesses: Map<string, ChildProcess>;
    tunnelManager: TunnelManager;
    localLinkspan: LocalLinkspanManager;
    linkspanStartingPath: string | undefined;
    ssh: SshManager;
    storageBrowser: StorageBrowserManager;
    dataCache: DataCache;
    syncProvider: SyncProvider;
    mountProvider: MountProvider;
    switchingSessionId?: string;
    sessionPollTimer?: ReturnType<typeof setInterval>;
    sessionPollBusy: boolean;
    sessionsFilePath: string;
    lastWriteTime: number;
    statusBarItem: vscode.StatusBarItem;
    countdownTimer?: ReturnType<typeof setInterval>;
    disposing: boolean;
    tearingDown: Set<string>;
    metrics: MetricsCollector;
    heartbeatTimer?: ReturnType<typeof setInterval>;
    linkspanDownloaded: boolean;
    lastTokenRefresh: number;
    outputChannel: vscode.OutputChannel;
    sshControlDir: string;
    /** @deprecated — kept only for old SSH shell methods that haven't been removed yet */
    persistentShells: Map<string, PersistentShell>;
}