# SSH-Backed Sessions

This guide explains how to prepare an SSH target for Mapache sessions when the target only allows login with OpenSSH signed user keys.

## Behavior

An SSH-backed session still provisions a small Mapache Cloud Run runner. The runner owns browser terminal access, reconnect, authenticated port-forward URLs, and runner management routes. Its PTY command is `ssh` instead of `pi`, `codex`, or `bash`.

The SSH target shell starts in the configured initial directory and then behaves like a normal shell for the configured user. The file browser is intentionally scoped to that initial directory for the first implementation. Port forwards connect from the SSH target's `127.0.0.1:<port>` and are exposed through the existing authenticated runner URL.

## Target Setup

On a trusted admin machine, create or choose an SSH user CA:

```bash
ssh-keygen -t ed25519 -f ./mapache_user_ca -C mapache-user-ca
```

Install the CA public key on the target:

```bash
sudo install -d -m 0755 /etc/ssh
sudo install -m 0644 ./mapache_user_ca.pub /etc/ssh/mapache_user_ca.pub
```

Configure `sshd` to trust that CA for user certificates:

```text
TrustedUserCAKeys /etc/ssh/mapache_user_ca.pub
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
```

Reload SSH after validating configuration:

```bash
sudo sshd -t
sudo systemctl reload sshd
```

Create a user key for the Mapache session and sign it with the CA. The principal must match a principal accepted for the target account. If the target uses default principal mapping, use the Unix username.

```bash
ssh-keygen -t ed25519 -f ./mapache_session_key -C mapache-session
ssh-keygen -s ./mapache_user_ca \
  -I mapache-session-001 \
  -n developer \
  -V +8h \
  ./mapache_session_key.pub
```

Verify from a normal machine before using Mapache:

```bash
ssh -i ./mapache_session_key \
  -o CertificateFile=./mapache_session_key-cert.pub \
  developer@dev.example.com
```

For strict host key checking, collect the target host key:

```bash
ssh-keyscan -p 22 dev.example.com > ./known_hosts
```

## Creating A Mapache Session

In the Mapache web UI:

1. Open New session.
2. Set Session type to SSH target.
3. Enter host, port, username, and initial directory.
4. Paste the private key from `mapache_session_key`.
5. Paste the signed user certificate from `mapache_session_key-cert.pub`.
6. Paste `known_hosts` when strict host key checking should pin the target host key.
7. Create the session.

The private key and certificate are used to configure the Cloud Run runner environment for that session. The stored Firestore session document keeps target metadata and certificate presence, but not the private key or certificate body. Restarting an SSH session may require creating a fresh session with currently valid signed key material.

## Port Forwarding

For a development server on the SSH target, start the server bound to the target loopback address, for example:

```bash
npm run dev -- --host 127.0.0.1 --port 5173
```

In the Mapache session detail panel, enter `5173` as the forwarded port. Mapache creates an SSH local forward inside the runner and shows an authenticated browser URL. Multiple forwarded ports can be active at the same time and can be closed from the same panel.

## Security Notes

- Use short certificate lifetimes such as `+8h` or less.
- Prefer a dedicated Unix account for Mapache access.
- Use `AuthorizedPrincipalsFile` or `AuthorizedPrincipalsCommand` if the target should accept a principal that differs from the Unix username.
- Keep `PasswordAuthentication no` and `KbdInteractiveAuthentication no` on signed-key-only targets.
- The first implementation scopes file browsing to the configured initial directory. Wider filesystem browsing is intentionally not enabled.
