import { TunnelCredential } from "../models";
import * as vscode from 'vscode';
import { Logger } from '../logger';

const DEV_TUNNELS_APP_ID = '46da2f7e-b5ef-422a-88d4-2a7f9de6a0b2';
const DEV_TUNNELS_SCOPE = `${DEV_TUNNELS_APP_ID}/.default`;

const logger = Logger.getInstance();

export async function getDevTunnelCredentials(): Promise<TunnelCredential> {
    // Placeholder for fetching credentials from local storage or configuration
    const token = await getDevTunnelAuthToken();
    logger.info('Obtained Dev Tunnels auth token successfully. Token ' + token);

    return {
        provider: 'devtunnel',
        authToken: token,
        serverUrl: 'https://devtunnels.microsoft.com'
    };
}

export async function getFrpTunnelCredentials(): Promise<TunnelCredential> {
    // Placeholder for fetching credentials from local storage or configuration
    return {
        provider: 'frp',
        authToken: 'example-frp-auth-token',
        serverUrl: 'https://frp-tunnel-server.com'
    };
}

export async function getDevTunnelAuthToken(): Promise<string> {
    try {
        const session = await vscode.authentication.getSession(
            'microsoft',
            [DEV_TUNNELS_SCOPE],
            { clearSessionPreference: true, createIfNone: true },
        );
        return session?.accessToken || '';
    } catch (err) {
        logger.error('Failed to get Dev Tunnels auth token:', err);
        throw new Error('Dev Tunnels authentication is required. Please sign in to your Microsoft account.');
    }
}

export async function switchDevTunnelAccount(): Promise<void> {
    try {
        const session = await vscode.authentication.getSession(
            'microsoft',
            [DEV_TUNNELS_SCOPE],
            { clearSessionPreference: true, createIfNone: true },
        );
        logger.info(`Dev Tunnels: switched to ${session.account.label}`);
    } catch (err: any) {
        vscode.window.showErrorMessage(`Dev Tunnels sign-in failed: ${err.message}`);
    }
}