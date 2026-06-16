import { parse } from 'shell-quote';
import { BasicParser } from 'posix-getopt';

export class CommandParseError extends Error {}

export interface SshConfigEntry {
    Host: string;
    HostName: string;
    [key: string]: string;
}

// Verbatim getopt option string from Remote-SSH 0.123.0.
const OPTSTRING = ':1246ab:c:e:fgi:kl:m:no:p:qstvxAB:CD:E:F:GI:J:KL:MNO:PQ:R:S:TVw:W:XYy';

// Flag -> ssh_config directive (Remote-SSH 0.123.0). Flags in OPTSTRING but absent here are consumed by getopt without producing a directive.
const OPTION_MAP: Record<string, (c: Record<string, string>, arg: string) => void> = {
    '1': c => { c.Protocol = '1'; },
    '2': c => { c.Protocol = '2'; },
    '4': c => { c.AddressFamily = 'inet'; },
    '6': c => { c.AddressFamily = 'inet6'; },
    A: c => { c.ForwardAgent = 'yes'; },
    b: (c, a) => { c.BindAddress = a; },
    C: c => { c.Compression = 'yes'; },
    c: (c, a) => { c.Cipher = a; },
    D: (c, a) => { c.DynamicForward = a; },
    g: c => { c.GatewayPorts = 'yes'; },
    I: (c, a) => { c.SmartcardDevice = a; },
    i: (c, a) => { c.IdentityFile = a; },
    J: (c, a) => { c.ProxyJump = a; },
    K: c => { c.GSSAPIAuthentication = 'yes'; },
    k: c => { c.GSSAPIDelegateCredentials = 'no'; },
    L: (c, a) => {
        const m = a.match(/^((.*):?\d+)?:(.+?)?$/);
        if (m) {
            const listener = m[1];
            const dest = m[3];
            if (listener && dest) { c.LocalForward = `${listener} ${dest}`; return; }
            throw new CommandParseError(`LocalForward needs a listener and a destination separated by a colon. ${a} does not match.`);
        }
        const idx = a.indexOf(':');
        if (idx === -1) { throw new CommandParseError(`LocalForward needs a listener and a destination separated by a colon. ${a} does not match.`); }
        c.LocalForward = `${a.substring(0, idx)} ${a.substring(idx + 1)}`;
    },
    l: (c, a) => { c.User = a; },
    M: c => { c.ControlMaster = 'yes'; },
    m: (c, a) => { c.MACs = a; },
    o: (c, a) => {
        const idx = a.indexOf('=');
        if (idx === -1) { throw new CommandParseError(`Argument missing for option ${a}`); }
        c[a.slice(0, idx)] = a.slice(idx + 1);
    },
    p: (c, a) => { c.Port = a; },
    R: (c, a) => { c.RemoteForward = a; },
    S: (c, a) => { c.ControlPath = a; },
    v: c => { c.LogLevel = 'verbose'; },
    W: (c, a) => { c.RemoteForward = a; },
    w: (c, a) => { c.TunnelDevice = a; },
    X: c => { c.ForwardX11 = 'yes'; },
    x: c => { c.ForwardX11 = 'no'; },
    Y: c => { c.ForwardX11Trusted = 'yes'; },
};

function consumeFlags(tokens: string[], config: Record<string, string>): number {
    const parser = new BasicParser(OPTSTRING, tokens, 0);
    for (;;) {
        const opt = parser.getopt();
        if (!opt) { break; }
        if (opt.option === ':') { throw new CommandParseError(`Expected flag -${opt.optopt} to have an argument but it did not`); }
        if (opt.option === '?') { throw new CommandParseError(`Unknown flag ${opt.optopt}`); }
        const handler = OPTION_MAP[opt.option];
        if (handler) { handler(config, opt.optarg ?? ''); }
    }
    return parser.optind();
}

function parseHostToken(token: string): { hostname: string; username?: string; port?: string } {
    let url: URL | undefined;
    try { url = new URL(token); } catch { /* not a URL */ }
    if (url && url.protocol === 'ssh:') {
        return { hostname: url.hostname, username: url.username || undefined, port: url.port || undefined };
    }
    const at = token.lastIndexOf('@');
    if (at === -1) { return { hostname: token }; }
    let host = token.slice(at + 1);
    let user = token.slice(0, at);
    const userColon = user.indexOf(':');
    if (userColon !== -1) { user = user.slice(0, userColon); }
    let port: string | undefined;
    const hostColon = host.indexOf(':');
    if (hostColon !== -1) { port = host.slice(hostColon + 1); host = host.slice(0, hostColon); }
    return { hostname: host, username: user, port };
}

export function sshCommandToConfig(command: string): SshConfigEntry {
    const tokens = parse(command) as unknown as string[];
    if (tokens[0] === 'ssh') { tokens.shift(); }
    const config: Record<string, string> = {};
    for (let i = 0; i < tokens.length; i++) {
        i += consumeFlags(tokens.slice(i), config);
        if (i < tokens.length && !config.Host) {
            const { hostname, port, username } = parseHostToken(tokens[i]);
            config.Host = hostname;
            config.HostName = hostname;
            if (!config.Port && port) { config.Port = port; }
            if (!config.User && username) { config.User = username; }
        }
    }
    if (!config.Host) { throw new CommandParseError('Missing host in SSH connection string'); }
    const { Host, HostName, ...rest } = config;
    return { Host, HostName, ...rest };
}

const INVALID_HOST_CHARS = ['\\', "'", '"', '`', '!', '%', '\r', '\n'];

export function assertValidHost(entry: SshConfigEntry): void {
    const hostName = entry.HostName;
    const user = entry.User;
    if (hostName.startsWith('-')) { throw new CommandParseError('SSH host name cannot begin with -'); }
    if (user && user.startsWith('-')) { throw new CommandParseError('SSH user name cannot begin with -'); }
    for (const ch of INVALID_HOST_CHARS) {
        if (hostName.includes(ch)) { throw new CommandParseError(`SSH host name cannot include the character ${ch}`); }
        if (user && user.includes(ch)) { throw new CommandParseError(`SSH user name cannot include the character ${ch}`); }
    }
}
