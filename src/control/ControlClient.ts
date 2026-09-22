// The typed client for cs-control's SSH and telemetry routes, and the whole of what the Resources
// and Stats views may do: this extension owns no CyberShuttle resource state of its own. A host is
// described by the ssh command that already works and cs-control parses it, so nothing here
// composes configuration text. A 401 means the stored credential is spent, so it is dropped and the
// views fall back to the sign-in button on the next push.
import { AuthClient } from './AuthClient';
import { ControlError, controlRequest, unexpected, type Fetch, type RequestOptions } from './request';
import type { Run, SshHost, SshHostTest, SshKey } from './types';

const alias = encodeURIComponent;

export class ControlClient {
    constructor(private readonly auth: AuthClient, private readonly fetchImpl: Fetch = globalThis.fetch) { }

    public listSshHosts(): Promise<SshHost[]> {
        return this.list('ssh/hosts', 'hosts');
    }

    public addSshHost(name: string, command: string, key = ''): Promise<SshHost> {
        return this.send('ssh/hosts', { method: 'POST', body: { name, command, key } }) as Promise<SshHost>;
    }

    public updateSshHost(name: string, command: string, key = ''): Promise<SshHost> {
        return this.send(`ssh/hosts/${alias(name)}`, { method: 'PUT', body: { command, key } }) as Promise<SshHost>;
    }

    public async deleteSshHost(name: string): Promise<void> {
        await this.send(`ssh/hosts/${alias(name)}`, { method: 'DELETE' });
    }

    public testSshHost(name: string): Promise<SshHostTest> {
        return this.send(`ssh/hosts/${alias(name)}/test`, { method: 'POST' }) as Promise<SshHostTest>;
    }

    public listSshKeys(): Promise<SshKey[]> {
        return this.list('ssh/keys', 'keys');
    }

    public addSshKey(name: string, privateKey: string): Promise<SshKey> {
        return this.send('ssh/keys', { method: 'POST', body: { name, privateKey } }) as Promise<SshKey>;
    }

    public async deleteSshKey(name: string): Promise<void> {
        await this.send(`ssh/keys/${alias(name)}`, { method: 'DELETE' });
    }

    public listRuns(): Promise<Run[]> {
        return this.list('telemetry', 'runs');
    }

    private async list<T>(path: string, field: string): Promise<T[]> {
        const items = ((await this.send(path)) as Record<string, unknown> | undefined)?.[field];
        if (!Array.isArray(items)) { throw unexpected(`${field} list`); }
        return items as T[];
    }

    private async send(path: string, options: RequestOptions = {}): Promise<unknown> {
        const token = await this.auth.token();
        if (!token) { throw new ControlError(401, 'unauthorized', 'Log in to CyberShuttle first.'); }
        try {
            return await controlRequest(this.fetchImpl, this.auth.baseUrl, path, { ...options, token });
        }
        catch (err) {
            if (err instanceof ControlError && err.status === 401) { await this.auth.signOut(); }
            throw err;
        }
    }
}
