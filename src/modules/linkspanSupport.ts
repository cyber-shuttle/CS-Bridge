// linkspan's HTTP API surface — endpoint paths, payload shapes, the health validator, and pure helpers, with no
// transport. Callers reach these over the session's tunnel (see tunnelSupport); this module just declares the API.

export const LINKSPAN_HEALTH = '/health';
export const LINKSPAN_SSH_SERVERS = '/vscode/sessions';
export const LINKSPAN_FORWARD = '/tunnels/devtunnels/forward';

// The Dev Tunnels edge answers 200 with an HTML page once the host is gone, so linkspan's {"status":"ok"} body — not
// the HTTP status — is the real liveness signal.
export const isLinkspanHealthy = (json: unknown): boolean => (json as { status?: unknown })?.status === 'ok';

// GET /vscode/sessions → sshd supervisor state. linkspan binds each sshd on ":<port>" and ids it "s-<port>", so both
// fields encode the port, and the port is stable across supervisor restarts.
export interface LinkspanSshStatus {
    id: string;
    state: string; // "running" while the listener is up; "restarting"/"failed" otherwise
    active: boolean; // true only while accepting connections
    addr?: string; // ":<port>" the sshd is bound to
    restarts: number;
    last_error?: string;
}

// POST /vscode/sessions (body { mount_user_home: false }) → the created sshd.
export interface SshServerInfo { bind_port: number; password: string; id: string; private_key: string }

export const sshdPort = (s: LinkspanSshStatus): number =>
    Number(s.addr?.split(':').pop()) || Number(s.id.replace(/^s-/, '')) || 0;

// One-line render of the sshd supervisor state for the health log.
export function summarizeSshStatus(list: LinkspanSshStatus[]): string {
    if (!list.length) { return 'no sshd'; }
    return list.map(s =>
        `${s.state}${s.active ? '' : '/inactive'}${s.addr ? ` @${s.addr}` : ''}`
        + `${s.restarts ? ` restarts=${s.restarts}` : ''}${s.last_error ? ` err="${s.last_error}"` : ''}`,
    ).join(', ');
}
