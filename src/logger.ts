import * as vscode from 'vscode';

// Extract a human-readable message from an unknown thrown value.
export const errMsg = (e: unknown): string => e instanceof Error ? e.message : String(e);

export enum LogLevel {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
}

export class Logger {
    private static _instance: Logger | undefined;
    private _outputChannel: vscode.OutputChannel;
    private _logLevel: LogLevel = LogLevel.Info;

    private constructor() {
        this._outputChannel = vscode.window.createOutputChannel('CS Bridge');
    }

    static getInstance(): Logger {
        if (!Logger._instance) {
            Logger._instance = new Logger();
        }
        return Logger._instance;
    }

    debug(message: string, ...args: unknown[]): void {
        this._log(LogLevel.Debug, message, ...args);
    }

    info(message: string, ...args: unknown[]): void {
        this._log(LogLevel.Info, message, ...args);
    }

    warn(message: string, ...args: unknown[]): void {
        this._log(LogLevel.Warn, message, ...args);
    }

    error(message: string, ...args: unknown[]): void {
        this._log(LogLevel.Error, message, ...args);
    }

    dispose(): void {
        this._outputChannel.dispose();
        Logger._instance = undefined;
    }

    private _log(level: LogLevel, message: string, ...args: unknown[]): void {
        if (level < this._logLevel) {
            return;
        }

        const prefix = `[${new Date().toISOString()}] [${LogLevel[level].toUpperCase()}] `;
        // Re-prefix every line so multi-line messages (stack traces, SSH banners) stay aligned.
        const body = [message, ...args.map(a => {
            if (a instanceof Error) { return a.stack ?? a.message; }
            if (a === null || typeof a !== 'object') { return String(a); }
            try { return JSON.stringify(a); } catch { return String(a); }
        })].join(' ');
        for (const line of body.split('\n')) { this._outputChannel.appendLine(prefix + line); }
    }
}
