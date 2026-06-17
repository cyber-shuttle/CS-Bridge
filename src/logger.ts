import * as vscode from 'vscode';

export const errMsg = (e: unknown): string => e instanceof Error ? e.message : String(e);

export enum LogLevel {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
}

export class Logger {
    private static instance: Logger | undefined;
    private outputChannel: vscode.OutputChannel;
    private logLevel: LogLevel = LogLevel.Info;

    private constructor() {
        this.outputChannel = vscode.window.createOutputChannel('CS Bridge');
    }

    static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    debug(message: string, ...args: unknown[]): void {
        this.log(LogLevel.Debug, message, ...args);
    }

    info(message: string, ...args: unknown[]): void {
        this.log(LogLevel.Info, message, ...args);
    }

    warn(message: string, ...args: unknown[]): void {
        this.log(LogLevel.Warn, message, ...args);
    }

    error(message: string, ...args: unknown[]): void {
        this.log(LogLevel.Error, message, ...args);
    }

    dispose(): void {
        this.outputChannel.dispose();
        Logger.instance = undefined;
    }

    private log(level: LogLevel, message: string, ...args: unknown[]): void {
        if (level < this.logLevel) {
            return;
        }

        const prefix = `[${new Date().toISOString()}] [${LogLevel[level].toUpperCase()}] `;
        // Re-prefix every line so multi-line messages (stack traces, SSH banners) stay aligned.
        const body = [message, ...args.map((a) => {
            if (a instanceof Error) { return a.stack ?? a.message; }
            if (a === null || typeof a !== 'object') { return String(a); }
            try { return JSON.stringify(a); }
            catch { return String(a); }
        })].join(' ');
        for (const line of body.split('\n')) { this.outputChannel.appendLine(prefix + line); }
    }
}
