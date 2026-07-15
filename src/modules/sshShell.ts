// Pure protocol for driving one persistent remote login shell: frame each command with a per-call random
// marker so its stdout, stderr, and exit code can be demuxed from the shell's continuous output streams.

// Printed once at connect to skip profile/MOTD noise before the first command. A fixed token; remote profile
// output colliding with it is effectively impossible. ponytail: bump to a random per-shell token if it ever does.
export const READY_MARKER = '__CS_SHELL_READY__';

const marker = (rid: string): string => `__CSE_${rid}__`;

// Run `command`, capture its exit code before the marker printf overwrites $?, then emit the code on stdout and
// a matching boundary on stderr. Commands here are single-line and never read stdin (the shell's stdin is ours).
export function buildShellCommand(rid: string, command: string): string {
    const m = marker(rid);
    return `${command}\n__cs=$?; printf '\\n${m} %s\\n' "$__cs"; printf '\\n${m}\\n' 1>&2\n`;
}

// SSH auth prompts (e.g. CILogon device-flow) embed a terminal QR that only renders in a monospace, newline-preserved
// surface — which showInputBox isn't — so show the prompt verbatim in a webview <pre>, HTML-escaped then URL-linkified.
export function renderAuthHtml(prompt: string, nonce: string): string {
    const esc = (s: string) => s.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
    // linkify after escaping so anchor text stays the exact URL (QR glyphs untouched)
    const body = esc(prompt).replace(/https?:\/\/[^\s<>"]+/g, u => `<a href="${u}">${u}</a>`);
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { padding: 14px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  pre { font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; line-height: 1; white-space: pre; overflow-x: auto; margin: 0 0 12px; }
  a { color: var(--vscode-textLink-foreground); }
  input { width: 100%; box-sizing: border-box; padding: 5px 7px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  .hint { margin-top: 8px; color: var(--vscode-descriptionForeground); font-size: 12px; }
</style></head>
<body>
<pre>${body}</pre>
<input id="r" type="password" autocomplete="off" />
<div class="hint">Press Enter to submit · Escape to cancel</div>
<script nonce="${nonce}">
  const api = acquireVsCodeApi();
  const r = document.getElementById('r');
  r.focus();
  addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); api.postMessage({ type: 'submit', value: r.value }); }
    else if (e.key === 'Escape') { e.preventDefault(); api.postMessage({ type: 'cancel' }); }
  });
</script>
</body></html>`;
}

// Null until both sentinels have arrived; otherwise the payload preceding each (the injected leading \n is the
// separator, so output without a trailing newline still splits cleanly).
export function extractCommandResult(
    rid: string,
    outBuf: string,
    errBuf: string,
): { stdout: string; stderr: string; code: number } | null {
    const m = marker(rid);
    const out = outBuf.match(new RegExp(`\\n${m} (\\d+)\\n`));
    const err = errBuf.match(new RegExp(`\\n${m}\\n`));
    if (!out || !err) { return null; }
    return { stdout: outBuf.slice(0, out.index), stderr: errBuf.slice(0, err.index), code: Number(out[1]) };
}
