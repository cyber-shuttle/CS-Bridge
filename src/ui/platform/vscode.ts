import { useEffect, useState } from 'preact/hooks';

const vscode = acquireVsCodeApi();

/** The webview's only outbound channel to the extension host. */
export const post = (msg: unknown) => vscode.postMessage(msg);

/** Subscribe to the extension's pushed state: posts `ready` once, re-renders on each `state` message. */
export function useWebviewState<T>(): T | null {
    const [state, setState] = useState<T | null>(null);
    useEffect(() => {
        const onMsg = (e: MessageEvent) => {
            const msg = e.data as { command?: string; state?: T };
            if (msg.command === 'state' && msg.state) { setState(msg.state); }
        };
        window.addEventListener('message', onMsg);
        post({ command: 'ready' });
        return () => window.removeEventListener('message', onMsg);
    }, []);
    return state;
}
