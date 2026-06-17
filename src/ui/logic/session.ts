import type { SlurmSession, ViewSession } from '@/models';
import { isTerminal, isCloseable, isStoppable } from '@/modules/sessionMachine';

type ActionKind = 'start' | 'restart' | 'stop' | 'switch' | 'connect' | 'current';

export interface SessionAction {
    kind: ActionKind;
    label: string;
    icon: string;
}

interface SessionDescriptor {
    statusColor: string;
    canClose: boolean;
    actions: SessionAction[];
}

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

const FAILED: SlurmSession['status'][] = ['failed', 'stopped'];
const ACTIVATING: SlurmSession['status'][] = ['queued', 'stopping', 'submitting', 'awaiting_input'];
const LIVE: SlurmSession['status'][] = ['preparing', 'connected'];

const STOP: SessionAction = { kind: 'stop', label: 'Stop', icon: 'debug-stop' };

export function dotColor(status: SlurmSession['status']): string {
    if (FAILED.includes(status)) { return 'var(--vscode-errorForeground)'; }
    if (ACTIVATING.includes(status)) { return 'var(--vscode-charts-yellow)'; }
    if (LIVE.includes(status)) { return 'var(--vscode-charts-green)'; }
    return 'var(--vscode-descriptionForeground)';
}

export function sessionActions(session: ViewSession): SessionAction[] {
    const s = session.status;
    if (isTerminal(s)) { return [{ kind: 'restart', label: 'Restart', icon: 'debug-restart' }]; }
    if (s === 'interrupted') { return [{ kind: 'restart', label: 'Retry', icon: 'debug-restart' }]; }
    if (s === 'not_started') { return [{ kind: 'start', label: 'Start', icon: 'play' }]; }

    const actions: SessionAction[] = [];
    if (isStoppable(s)) { actions.push(STOP); }
    if (s === 'connected') {
        actions.push(session.isCurrent
            ? { kind: 'current', label: 'Current', icon: 'check' }
            : { kind: 'switch', label: session.windowAlive ? 'Switch' : 'Connect', icon: 'arrow-swap' });
    }
    else if (s === 'ready_to_connect' || s === 'disconnected') {
        actions.push({ kind: 'connect', label: s === 'disconnected' ? 'Reconnect' : 'Connect', icon: 'arrow-swap' });
    }
    return actions;
}

export function statusDescriptor(session: ViewSession): SessionDescriptor {
    return {
        statusColor: dotColor(session.status),
        canClose: isCloseable(session.status),
        actions: sessionActions(session),
    };
}
