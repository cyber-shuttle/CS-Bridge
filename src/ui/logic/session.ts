import type { SlurmSession, ViewSession } from '@/models';
import { isTerminal, isCloseable, isStoppable, wallMs } from '@/modules/sessionMachine';

export { wallMs }; // shared with the monitor via the vscode-free sessionMachine

type ActionKind = 'start' | 'restart' | 'stop' | 'switch' | 'connect' | 'current' | 'opening';

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

/** ms → "1h 30m" above an hour, "0m 45s" below. Clamps negatives to zero. */
export function fmtTime(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

/** Elapsed since `since` as "45s" / "2m 5s". Clamps at zero: the webview clock ticks once a second, so it can
 *  momentarily trail a just-set timestamp — without the clamp that reads as a spurious "-1s". */
export function elapsedLabel(since: number, now: number): string {
    const secs = Math.max(0, Math.floor((now - since) / 1000));
    return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
}

/** Milliseconds left until the wall-clock deadline; the full wall time if not yet started. */
export function remainingMs(session: Pick<SlurmSession, 'wallTime' | 'startedAt'>, now: number): number {
    const total = wallMs(session.wallTime);
    return session.startedAt ? session.startedAt + total - now : total;
}

const FAILED: SlurmSession['status'][] = ['failed', 'stopped'];
const ACTIVATING: SlurmSession['status'][] = ['queued', 'stopping', 'submitting', 'awaiting_input', 'unreachable'];
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
        if (session.isCurrent) { actions.push({ kind: 'current', label: 'Current', icon: 'check' }); }
        else if (session.windowAlive) { actions.push({ kind: 'switch', label: 'Switch', icon: 'arrow-swap' }); }
        else if (session.opening) { actions.push({ kind: 'opening', label: 'Opening…', icon: 'loading' }); }
        else { actions.push({ kind: 'switch', label: 'Connect', icon: 'arrow-swap' }); }
    }
    else if (s === 'connecting') {
        actions.push({ kind: 'opening', label: 'Connecting…', icon: 'loading' });
    }
    else if (s === 'ready_to_connect' || s === 'unreachable') {
        // For 'unreachable', Reconnect rebuilds the relay via the tunnel API → back to relay-live, off the login-node path.
        actions.push({ kind: 'connect', label: s === 'ready_to_connect' ? 'Connect' : 'Reconnect', icon: 'arrow-swap' });
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
