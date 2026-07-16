import { Metric } from '../models';

// linkspan's HTTP API client — one function per endpoint, each taking the base URL + auth headers its transport
// mandates (devtunnel today; see tunnelSupport.linkspanEndpoint). It does the calling but owns no transport of its
// own, so devtunnel and linkspan stay separate and compose at the caller.

const TIMEOUT_MS = 4500; // linkspan shares one relay + a 2-CPU node with live SSH + polls; keep below the 5s poll interval

export interface LinkspanSshStatus {
    id: string;
    state: string; // "running" while the listener is up; "restarting"/"failed" otherwise
    active: boolean; // true only while accepting connections
    addr?: string; // ":<port>" the sshd is bound to
    restarts: number;
    last_error?: string;
}

interface SshServerInfo { bind_port: number; password: string; id: string; private_key: string }

// GET and require a shape-checked JSON body — the tunnel edge answers 200 with an HTML page once the host is gone,
// so a valid body (not resp.ok) is the real liveness signal.
async function get(baseUrl: string, headers: Record<string, string>, path: string, valid: (json: unknown) => boolean): Promise<unknown> {
    const resp = await fetch(baseUrl + path, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await resp.text();
    let json: unknown;
    try { json = JSON.parse(body); }
    catch { /* not JSON: the edge's interstitial page */ }
    if (!resp.ok || !valid(json)) { throw new Error(`linkspan ${path} unhealthy (status=${resp.status}): ${body.slice(0, 200)}`); }
    return json;
}

async function post(baseUrl: string, headers: Record<string, string>, path: string, body: unknown): Promise<Response> {
    const resp = await fetch(baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (!resp.ok) { throw new Error(`linkspan ${path} failed (status=${resp.status} ${resp.statusText}): ${(await resp.text()).slice(0, 200)}`); }
    return resp;
}

export async function getHealth(baseUrl: string, headers: Record<string, string>): Promise<void> {
    await get(baseUrl, headers, '/health', j => (j as { status?: unknown })?.status === 'ok');
}

// GET /vscode/sessions — the sshd supervisor state (a JSON array also confirms the host is up).
export async function getSshServers(baseUrl: string, headers: Record<string, string>): Promise<LinkspanSshStatus[]> {
    return await get(baseUrl, headers, '/vscode/sessions', Array.isArray) as LinkspanSshStatus[];
}

// GET /metrics — linkspan's live sample; a valid body also confirms the host is up.
export async function getMetrics(baseUrl: string, headers: Record<string, string>): Promise<Metric> {
    return await get(baseUrl, headers, '/metrics', j => typeof j === 'object' && j !== null && !Array.isArray(j)) as Metric;
}

// POST /vscode/sessions — create a fresh sshd. Not idempotent; the caller guards re-creation.
export async function createSshServer(baseUrl: string, headers: Record<string, string>): Promise<SshServerInfo> {
    return await (await post(baseUrl, headers, '/vscode/sessions', { mount_user_home: false })).json() as SshServerInfo;
}

// POST /tunnels/devtunnels/forward — forward the sshd port on the tunnel. Idempotent on linkspan.
export async function forwardPort(baseUrl: string, headers: Record<string, string>, req: { tunnelName: string; port: number; token: string }): Promise<void> {
    await post(baseUrl, headers, '/tunnels/devtunnels/forward', req);
}

// linkspan binds each sshd on ":<port>" and ids it "s-<port>", so both fields encode the (restart-stable) port.
export const sshdPort = (s: LinkspanSshStatus): number =>
    Number(s.addr?.split(':').pop()) || Number(s.id.replace(/^s-/, '')) || 0;
