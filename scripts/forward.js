// ssh's ProxyCommand for a CyberShuttle session: `forward.js <wss url> <token file>` bridges stdin and stdout to
// cs-plane's forward WebSocket. The session capability is read from the token file, so no command line shows it.
// Runs under VS Code's own Node, so it needs nothing installed.
const fs = require('node:fs');

const [url, tokenFile] = process.argv.slice(2);
const socket = new WebSocket(url, ['cybershuttle.v1', `capability.${fs.readFileSync(tokenFile, 'utf-8').trim()}`]);
socket.binaryType = 'arraybuffer';
socket.onopen = () => {
    process.stdin.on('data', chunk => socket.send(chunk));
    process.stdin.on('end', () => socket.close());
};
socket.onmessage = event => process.stdout.write(Buffer.from(event.data));
socket.onclose = event => process.exit(event.code === 1000 ? 0 : 1);
socket.onerror = () => process.exit(1);
