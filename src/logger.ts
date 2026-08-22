import * as vscode from 'vscode';

export const errMsg = (e: unknown): string => e instanceof Error ? e.message : String(e);

type Level = 'INFO' | 'WARN' | 'ERROR';

export class Logger {
    private static instance: Logger | undefined;
    private outputChannel: vscode.OutputChannel;

    private constructor() {
        this.outputChannel = vscode.window.createOutputChannel('CS Bridge');
    }

    static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    info(message: string, ...args: unknown[]): void {
        this.log('INFO', message, ...args);
    }

    warn(message: string, ...args: unknown[]): void {
        this.log('WARN', message, ...args);
    }

    error(message: string, ...args: unknown[]): void {
        this.log('ERROR', message, ...args);
    }

    dispose(): void {
        this.outputChannel.dispose();
        Logger.instance = undefined;
    }

    private log(level: Level, message: string, ...args: unknown[]): void {
        const prefix = `[${new Date().toISOString()}] [${level}] `;
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
