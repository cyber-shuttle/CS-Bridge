import { spawnSync } from "child_process";
import { CSExtensionContext } from "./ExtensionContext";

/**
* Delete a devtunnel by name (best-effort, synchronous).
* Used to pre-cleanup stale tunnels before creating new ones.
*/
export function deleteDevTunnel(tunnelName: string, ctx: CSExtensionContext): void {
    const devtunnelBin = ctx.tunnelManager.resolveDevTunnelBin();
    if (!devtunnelBin) { return; }
    try {
        const result = spawnSync(devtunnelBin, ['delete', tunnelName, '-f'], {
            encoding: 'utf-8',
            timeout: 10_000,
        });
        if (result.status === 0) {
            ctx.outputChannel.appendLine(`[tunnel] Deleted stale tunnel ${tunnelName}`);
        }
    } catch {
        // Best-effort
    }
}
