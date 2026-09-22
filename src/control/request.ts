// The one place a cs-control HTTP call is made. cs-control requires an Origin on every request and
// accepts loopback HTTP ones, so the extension presents the same loopback origin its sign-in callback
// listens on; the operator lists it with `csctl serve --allowed-origin`. Every refusal arrives as
// {"error":{"code","message"}} and leaves here as a ControlError, so no caller handles a Response.

export const CALLBACK_PORT = 8046;
export const CONTROL_ORIGIN = `http://127.0.0.1:${CALLBACK_PORT}`;

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
    const headers: Record<string, string> = { Origin: CONTROL_ORIGIN, Accept: 'application/json' };
    if (options.token) { headers['Authorization'] = `Bearer ${options.token}`; }
    if (options.body !== undefined) { headers['Content-Type'] = 'application/json'; }

    const response = await fetchImpl(`${base}/${path}`, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (response.status === 204) { return undefined; }
    const value = await response.json().catch(() => undefined);
    if (!response.ok) { throw envelopeError(response.status, value); }
    return value;
}

function envelopeError(status: number, value: unknown): ControlError {
    const error = (value as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    return new ControlError(
        status,
        typeof error?.code === 'string' ? error.code : `http_${status}`,
        typeof error?.message === 'string' ? error.message : `CyberShuttle returned ${status}.`,
    );
}

export const unexpected = (what: string): ControlError =>
    new ControlError(502, 'invalid_response', `CyberShuttle returned an unexpected ${what}.`);
