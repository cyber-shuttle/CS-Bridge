// Shared fakes for the two control-client tests: a recording fetch, a SecretStorage-shaped map and
// an unsigned id token. Nothing here reaches the network except the loopback callback the sign-in
// test drives itself.
import type { Fetch } from './request';

export interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
}

export const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const errorResponse = (status: number, code: string, message: string): Response =>
    jsonResponse({ error: { code, message } }, status);

export function recordingFetch(answer: (call: Call) => Response): { calls: Call[]; fetch: Fetch } {
    const calls: Call[] = [];
    const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
        const call: Call = {
            url: String(input),
            method: init.method ?? 'GET',
            headers: init.headers as Record<string, string>,
            body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        };
        calls.push(call);
        return answer(call);
    }) as Fetch;
    return { calls, fetch };
}

export function secretStore(seed?: Record<string, string>) {
    const values = new Map<string, string>(Object.entries(seed ?? {}));
    return {
        values,
        get: (key: string) => Promise.resolve(values.get(key)),
        store: (key: string, value: string) => { values.set(key, value); return Promise.resolve(); },
        delete: (key: string) => { values.delete(key); return Promise.resolve(); },
    };
}

export const idToken = (claims: Record<string, string>): string =>
    `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
