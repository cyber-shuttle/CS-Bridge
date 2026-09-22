// The one place a cs-control HTTP call is made. cs-control requires an Origin on every request and
// accepts loopback HTTP ones, so the extension presents a loopback origin; the operator lists it with
// `csctl serve --allowed-origin`. Nothing listens there: an editor is not a browser, and sign-in uses a
// device code rather than a redirect. Every refusal arrives as {"error":{"code","message"}} and leaves
// here as a ControlError, so no caller handles a Response.

export const CONTROL_ORIGIN = 'http://127.0.0.1';

export type Fetch = typeof globalThis.fetch;

export class ControlError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
        super(message);
        this.name = 'ControlError';
    }
}

export interface RequestOptions {
    method?: string;
    body?: unknown;
    token?: string;
}

export async function controlRequest(fetchImpl: Fetch, base: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const headers: Record<string, string> = { Origin: CONTROL_ORIGIN };
    if (options.token) { headers['Authorization'] = `Bearer ${options.token}`; }
    if (options.body !== undefined) { headers['Content-Type'] = 'application/json'; }

    const response = await fetchImpl(`${base}/${path}`, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (response.status === 204) { return undefined; }
    const value = await response.json().catch(() => undefined);
    if (!response.ok) {
        const error = (value as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
        throw new ControlError(
            response.status,
            typeof error?.code === 'string' ? error.code : `http_${response.status}`,
            typeof error?.message === 'string' ? error.message : `CyberShuttle returned ${response.status}.`,
        );
    }
    return value;
}

export const unexpected = (what: string): ControlError =>
    new ControlError(502, 'invalid_response', `CyberShuttle returned an unexpected ${what}.`);
