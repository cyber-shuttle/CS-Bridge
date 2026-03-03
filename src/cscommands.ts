import * as vscode from 'vscode';
import { CsStorage } from './csstorage';
import { MetricsCollector } from './instrumentation';

export class CsCommands {

    constructor(private readonly _metrics: MetricsCollector) {}

    public async deviceAuth(csStorage: CsStorage): Promise<void> {
        const authStart = Date.now();
        this._metrics.record('auth_flow', 'in_progress', { stage: 'device_code' });

        const data = new URLSearchParams({
            client_id: "cybershuttle-agent",
            scope: "openid",
        });

        const auth_device_url = "https://auth.cybershuttle.org/realms/default/protocol/openid-connect/auth/device";

        try {
            const response = await fetch(auth_device_url, {
                method: "POST",
                body: data,
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            });

            const result = await response.json() as {
                device_code: string,
                interval: number,
                expires_in: number, user_code: string,
                verification_uri: string,
                verification_uri_complete: string,};

            this._metrics.record('auth_flow', 'success', { stage: 'device_code' }, Date.now() - authStart);

            console.log("Please visit " + result.verification_uri_complete + " and authenticate");
            await vscode.env.openExternal(vscode.Uri.parse(result.verification_uri_complete));
            await this.pollForToken(result.device_code, result.interval, result.expires_in, csStorage);
        } catch (err: any) {
            this._metrics.record('auth_flow', 'failure', { stage: 'device_code' }, Date.now() - authStart, err.message);
            throw err;
        }
    }

    private async pollForToken(
        deviceCode: string,
        interval: number,
        expires_in: number,
        csStorage: CsStorage): Promise<void> {
        this._metrics.record('auth_flow', 'in_progress', { stage: 'polling' });

        const data = new URLSearchParams({
            client_id: "cybershuttle-agent",
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });

        const token_url = "https://auth.cybershuttle.org/realms/default/protocol/openid-connect/token";
        const response = await fetch(token_url, {
            method: "POST",
            body: data,
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
        });

        if (response.status === 400) {
            const result = await response.json() as { error: string, error_description: string };
            if (result.error === "authorization_pending") {
                console.log("Authorization pending. Polling again in " + interval + " seconds");
                setTimeout(() => this.pollForToken(deviceCode, interval, expires_in, csStorage), interval * 1000);
            } else {
                this._metrics.record('auth_flow', 'failure', { stage: 'polling' }, undefined, result.error_description);
                console.error(result.error_description);
            }
        } else if (response.status === 200) {
            const result = await response.json() as {
                access_token: string,
                expires_in: number,
                refresh_token: string,
                token_type: string,
                scope: string,
                id_token: string,
                session_state: string,
                not_before_policy: number,
            };

            this._metrics.record('auth_flow', 'success', { stage: 'token_exchange' });

            csStorage.storeAccessToken(result.access_token);
            csStorage.storeRefreshToken(result.refresh_token);
            console.log("Access token: " + result.access_token);
            console.log("Refresh token: " + result.refresh_token);
            console.log("ID token: " + result.id_token);
        }
    }
}
