import * as vscode from 'vscode';

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
        this._outputChannel = vscode.window.createOutputChannel('CyberShuttle');
    }

    static getInstance(): Logger {
        if (!Logger._instance) {
            Logger._instance = new Logger();
        }
        return Logger._instance;
    }

    setLogLevel(level: LogLevel): void {
        this._logLevel = level;
    }

    show(): void {
        this._outputChannel.show();
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

        const timestamp = new Date().toISOString();
        const label = LogLevel[level].toUpperCase();
        const suffix = args.length > 0
            ? ' ' + args.map(a => a instanceof Error ? a.stack ?? a.message : String(a)).join(' ')
            : '';

        this._outputChannel.appendLine(`[${timestamp}] [${label}] ${message}${suffix}`);
    }
}
