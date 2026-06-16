import type { SlurmSession, ViewSession } from '@/models';

type ActionKind = 'start' | 'restart' | 'stop' | 'switch' | 'connect' | 'current';

export interface SessionAction {
    kind: ActionKind;
    label: string;
    icon: string; // codicon name
}

interface SessionDescriptor {
    dot: string; // CSS colour var for the status indicator
    canClose: boolean;
    actions: SessionAction[];
}

/** "HH:MM:SS" → milliseconds. */
export function wallMs(wallTime: string): number {
    const p = (wallTime || '').split(':').map(Number);
    return ((p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0)) * 1000;
}

/** ms → "1h 30m" above an hour, "0m 45s" below. Clamps negatives to zero. */
export function fmtTime(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

/** Milliseconds left until the wall-clock deadline; the full wall time if not yet started. */
export function remainingMs(session: Pick<SlurmSession, 'wallTime' | 'startedAt'>, now: number): number {
    const total = wallMs(session.wallTime);
    return session.startedAt ? session.startedAt + total - now : total;
}

const FAILED: SlurmSession['status'][] = ['failed', 'cancelled'];
const ACTIVATING: SlurmSession['status'][] = ['queued', 'cancelling', 'submitting'];
const LIVE: SlurmSession['status'][] = ['preparing', 'connected'];
const CLOSEABLE: SlurmSession['status'][] = ['failed', 'completed', 'cancelled', 'not_started'];
const RESTARTABLE: SlurmSession['status'][] = ['failed', 'cancelled', 'completed'];
const STOPPABLE: SlurmSession['status'][] = ['queued', 'cancelling', 'submitting', 'preparing', 'connecting'];

const STOP: SessionAction = { kind: 'stop', label: 'Stop', icon: 'debug-stop' };

export function dotColor(status: SlurmSession['status']): string {
    if (FAILED.includes(status)) { return 'var(--vscode-errorForeground)'; }
    if (ACTIVATING.includes(status)) { return 'var(--vscode-charts-yellow)'; }
    if (LIVE.includes(status)) { return 'var(--vscode-charts-green)'; }
    return 'var(--vscode-descriptionForeground)';
}

export function sessionActions(session: ViewSession): SessionAction[] {
    const s = session.status;
    if (RESTARTABLE.includes(s)) { return [{ kind: 'restart', label: 'Restart', icon: 'debug-restart' }]; }
    if (s === 'connected') {
        const second: SessionAction = session.isCurrent
            ? { kind: 'current', label: 'Current', icon: 'check' }
            : { kind: 'switch', label: session.windowAlive ? 'Switch' : 'Connect', icon: 'arrow-swap' };
        return [STOP, second];
    }
    if (s === 'ready_to_connect' || s === 'disconnected') { return [STOP, { kind: 'connect', label: s === 'disconnected' ? 'Reconnect' : 'Connect', icon: 'arrow-swap' }]; }
    if (STOPPABLE.includes(s)) { return [STOP]; }
    if (s === 'not_started') { return [{ kind: 'start', label: 'Start', icon: 'play' }]; }
    return [];
}

export function statusDescriptor(session: ViewSession): SessionDescriptor {
    return {
        dot: dotColor(session.status),
        canClose: CLOSEABLE.includes(session.status),
        actions: sessionActions(session),
    };
}
