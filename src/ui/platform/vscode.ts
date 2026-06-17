import { useEffect, useState } from 'preact/hooks';

const vscode = acquireVsCodeApi();

export const post = (msg: unknown) => vscode.postMessage(msg);

// Posts `ready` once on mount, then re-renders on each `state` message the extension pushes.
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
