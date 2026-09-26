# Security Policy

## Supported Versions

Fixes go into the next Marketplace release. There are no maintenance branches, so only the latest published
version is supported.

## Reporting a Vulnerability

Report privately through GitHub: open this repository's **Security** tab and choose **Report a vulnerability**.
Please do not use a public issue, pull request or discussion for a security problem.

Include what an attacker can reach, the steps to reproduce it, the extension version (VS Code's **Extensions**
view, or `code --list-extensions --show-versions`), your OS, and the cluster and scheduler if the report involves
the remote path. Redact tokens, hostnames and usernames you do not want published. We will acknowledge the report
and say whether we can reproduce it before any fix ships.

## Scope

CS Bridge runs in your local VS Code and drives a cluster you already have SSH access to. These are the boundaries
it is built around; a report is most useful when it shows one of them failing.

- The private half of a session key never leaves the local machine; only the public half is handed to cs-plane. The
  key and the session capability the ProxyCommand reads are mode `0600`, and the capability is never on a command line.
- The only writes to `~/.ssh/config` are the `Include ~/.cybershuttle/ssh_config` line and the `Host` entries you
  add or remove yourself in the SSH Hosts view. Per-session aliases go to `~/.cybershuttle/ssh_config`.
- The job receives a link token or a Dev Tunnel host token scoped to its cs-plane session, never an account
  credential. It reaches linkspan only through `sbatch`'s exported environment, never the batch script, a command
  line, a file or the log. A linkspan without it cannot link.
- Authentication is CILogon's device grant, relayed by cs-plane; the credential is kept only in VS Code's
  SecretStorage and sent only to cs-plane. cs-plane never reaches the cluster and never sees SSH credentials, session
  private keys or the remote window's decrypted SSH traffic.
- The agent binary is fetched over HTTPS with no signature check, and everything CS Bridge runs remotely runs as
  the submitting user with no privilege that user does not already have.

How each of these is implemented is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

A finding that assumes an attacker already holds the local account, or an account on the cluster as that user,
describes one of these boundaries rather than a way through it. The compute-node agent's own boundaries are in
[linkspan's security policy](https://github.com/cyber-shuttle/linkspan/blob/main/SECURITY.md).
