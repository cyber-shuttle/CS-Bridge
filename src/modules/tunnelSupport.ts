import { TunnelCredential } from "../models";

export function getDevTunnelCredentials(): TunnelCredential {
    // Placeholder for fetching credentials from local storage or configuration
    return {
        provider: 'devtunnel',
        authToken: 'example-auth-token',
        serverUrl: 'https://devtunnels.microsoft.com'
    };
}

export function getFrpTunnelCredentials(): TunnelCredential {
    // Placeholder for fetching credentials from local storage or configuration
    return {
        provider: 'frp',
        authToken: 'example-frp-auth-token',
        serverUrl: 'https://frp-tunnel-server.com'
    };
}