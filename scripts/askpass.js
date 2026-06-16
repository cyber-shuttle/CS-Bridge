// SSH_ASKPASS helper script for CS Bridge extension.
// SSH calls this script with the prompt as the first argument.
// It writes a unique request file and waits for the extension
// to write the password to a corresponding response file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const prompt = process.argv.slice(2).join(' ') || 'Password:';
const sessionDir = process.env.CS_ASKPASS_DIR;

if (!sessionDir) {
    process.stderr.write('CS_ASKPASS_DIR not set\n');
    process.exit(1);
}

// Use a unique ID so multiple askpass invocations don't collide
const requestId = crypto.randomBytes(8).toString('hex');
const promptFile = path.join(sessionDir, `prompt-${requestId}`);
const responseFile = path.join(sessionDir, `response-${requestId}`);
const cancelFile = path.join(sessionDir, 'cancel');

// Write the prompt so the extension can read it
fs.writeFileSync(promptFile, JSON.stringify({ id: requestId, prompt: prompt }), 'utf-8');

// Poll for the response or cancel file
const startTime = Date.now();
const timeout = 600000;

function poll() {
    if (Date.now() - startTime > timeout) {
        try { fs.unlinkSync(promptFile); } catch {}
        process.stderr.write('Timed out waiting for password input\n');
        process.exit(1);
    }

    if (fs.existsSync(cancelFile)) {
        try { fs.unlinkSync(promptFile); } catch {}
        process.exit(1);
    }

    if (fs.existsSync(responseFile)) {
        const password = fs.readFileSync(responseFile, 'utf-8');
        try { fs.unlinkSync(responseFile); } catch {}
        try { fs.unlinkSync(promptFile); } catch {}
        // Output password to stdout — SSH reads it from here
        process.stdout.write(password);
        process.exit(0);
    }

    setTimeout(poll, 100);
}

poll();
