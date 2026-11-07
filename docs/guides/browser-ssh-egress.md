# Owner-scoped browser SSH egress

## Access scope

This feature prevents accidental use of an owner's gateway connection by other
Mapache users. It is operator-configured and off by default; each route matches
both the exact Firebase owner UID and an explicit workspace allowlist. Normal
users cannot select someone else's route or override its reserved environment
variables. Keep credentials in an API-only Secret Manager secret.

This is not a hostile multi-tenant sandbox. The current shared runner service
account has broad control-plane data access, and the authorized workspace's
root shell can access its own runtime credentials. This feature targets
trusted collaborators; defending against malicious runner code would require
a separate infrastructure isolation change. Do not describe owner checks
or Secret Manager storage as fixing that existing limitation.

## Owners and behavior

- `functions/browserEgress.service.js` resolves an operator-managed secret on
  every creation/restart environment build. Only an exact owner UID **and**
  workspace ID match receives one route. Missing configuration means normal
  direct browsing; an enabled but invalid/unavailable configuration fails closed.
- `functions/env.helpers.js` reserves both configuration names, preventing
  workspace/session/generic environment injection. There is no client route API.
- `session-runner/lib/browserEgress.js` starts OpenSSH with a loopback SOCKS5
  listener, pinned Ed25519 host key, no password prompts, and dedicated identity.
  Child exit triggers retries with backoff capped at 30 seconds. Startup waits
  up to approximately ten seconds plus bounded probe time; failure prevents
  Chrome from starting. Keepalives detect a broken connection in roughly 45
  seconds; browser requests can stall until that detection.
- `runnerLifecycle.js` starts the tunnel before Chrome and stops it on startup
  failure/shutdown. Temporary key files are mode 0600 in a mode-0700 directory
  under `/tmp`, outside workspace, home, and Chrome profile archives. The JSON
  credential variable is removed from `process.env` before launching children;
  this is inheritance hygiene, not a same-container security boundary.
- `chromeDesktop.js` configures the existing persistent browser profile and
  preserves the proxy arguments on Chrome restart. The gateway route covers the
  browser's web traffic, with localhost preview/CDP remaining local. SOCKS-side
  resolution, blocked external local DNS resolution, disabled QUIC, and the
  non-proxied WebRTC UDP policy avoid ordinary browser network bypasses. There
  is no `DIRECT` fallback: an unavailable tunnel produces request errors.
  This is browser configuration, not a container-wide network firewall; a trusted
  agent can start another browser or change its own proxy settings.
- Model API, terminal, Git and workspace storage traffic keep existing routes.
  Automation sessions inherit the route only for an explicitly allowed workspace.

## Operator configuration

The gateway is a machine with an SSH port exposed to the internet. It must stay
awake and have an IPv4 internet connection. The user supplies its public IPv4
address (or a hostname for the client connection) and external SSH port. Behind
a router, forward that port to the machine's SSH port. This guide targets
Ubuntu/Debian with systemd, OpenSSH, Python 3 and nftables; it does not require
Tailscale. Keep an existing administrator SSH session open during installation.

### Install the gateway

Install prerequisites if missing:

```bash
sudo apt-get install openssh-server nftables python3
```

Create a **dedicated** key on a trusted administrator machine, outside workspace
archives. Never reuse the administrator login key. The example uses a 30-day
key expiration; the installer requires an expiration within 90 days.

```bash
umask 077
ssh-keygen -t ed25519 -N '' -f ./mapache-gateway-key
```

Copy only `mapache-gateway-key.pub` to the gateway. From a reviewed checkout of
Mapache on that machine, run:

```bash
sudo python3 scripts/ssh-gateway/install.py \
  --public-key /absolute/path/mapache-gateway-key.pub \
  --public-ip YOUR_GATEWAY_PUBLIC_IPV4 \
  --expires "$(date -u -d '+30 days' +%F)"
```

The public IP is also denied as a forwarding destination, preventing access to
router port forwards through NAT loopback. If the machine has additional public
addresses or routes to internal **publicly numbered** networks, supply each as
`--deny-cidr ADDRESS/32` or `--deny-cidr NETWORK/PREFIX`. Update the deny list when
the gateway's public IP changes. Private, loopback, link-local, carrier-grade NAT,
benchmark, documentation, multicast and reserved IPv4 ranges are already denied.
IPv6 forwarding is denied entirely; IPv6-only websites will not work through this
gateway. Incoming administrator SSH access is unaffected.

The installer creates `mapache_tunnel` with no interactive shell, a root-owned
configuration, and an account-specific nftables output policy. Only TCP 80/443
to permitted IPv4 destinations and DNS to the configured IPv4 resolvers are
allowed. Rules inspect the actual destination IP, including after DNS resolution,
so a hostname resolving to a private address does not evade the restriction.
Review custom network/VPN routes and any other firewall manager: a later global
ruleset flush can remove these rules. Never flush them while tunnels are active.
The policy reduces network reach; a stolen key can still browse public web
services under the gateway IP until revoked.

`AllowTcpForwarding local`, `AllowStreamLocalForwarding no`, `PermitListen none`
and a forced failing command disable reverse forwarding, Unix socket forwarding,
and shell sessions. Agent forwarding, PTY, X11, user RC and tunnel devices are
also disabled. Certificate authentication and external authorized-key commands
are disabled for this account, so another host login mechanism cannot authorize
it. The installer checks effective sshd settings before reloading SSH; existing
administrator sessions are not restarted. Installations with custom address-based
`Match` rules should also check `sshd -T -C` using the actual client's address.

The systemd service loads the firewall **before** publishing the authorized key
under `/run`. A firewall load failure or reboot cannot leave the key available
without this startup step. Stopping the service removes the key and terminates
this dedicated account's existing connections, while leaving the firewall in
place. The installer refuses to overwrite an existing account or installation.
If installation fails, it revokes the new key and retains the account/configuration
for inspection; do not blindly delete/reuse its UID.

### Verify before moving browser traffic

Read the host's Ed25519 public key directly on the gateway:

```bash
sudo cat /etc/ssh/ssh_host_ed25519_key.pub
sudo systemctl status mapache-ssh-gateway.service
sudo nft list table inet mapache_gateway
sudo sshd -T -C user=mapache_tunnel,host=localhost,addr=CLIENT_PUBLIC_IP
```

Pin that host key in a dedicated `known_hosts` file on the client. Do not trust an
unverified `ssh-keyscan` result. Use `HOST` for port 22 or `[HOST]:PORT` otherwise,
followed by the `ssh-ed25519 BASE64` value. Then start a test proxy on an unused
local port, without closing an existing browser or tunnel:

```bash
ssh -F /dev/null -N -T -D 127.0.0.1:1081 \
  -i ./mapache-gateway-key -p EXTERNAL_SSH_PORT \
  -o IdentitiesOnly=yes -o BatchMode=yes -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile=./gateway_known_hosts \
  mapache_tunnel@GATEWAY_HOST
```

From a second terminal, verify public access and denied destinations:

```bash
curl --max-time 10 --proxy socks5h://127.0.0.1:1081 https://api.ipify.org
# These must fail, including when an internal destination has a web listener:
curl --max-time 5 --proxy socks5h://127.0.0.1:1081 http://127.0.0.1/
curl --max-time 5 --proxy socks5h://127.0.0.1:1081 http://192.168.1.1/
curl --max-time 5 --proxy socks5h://127.0.0.1:1081 http://169.254.169.254/
curl --max-time 5 --proxy socks5h://127.0.0.1:1081 http://YOUR_GATEWAY_PUBLIC_IPV4/
```

Also verify shell commands, `ssh -R`, Unix socket forwarding, and destinations on
port 22 are refused. Check nftables reject counters to distinguish a firewall
rejection from an absent service. Confirm ordinary administrator login still
works. Move the browser tunnel only after these checks. Remove any previous test
key from the administrator account and terminate its old tunnel after the
replacement is verified; leaving it authorized preserves the old exposure.

### Rotate or revoke

To revoke the route immediately, including established tunnels:

```bash
sudo systemctl disable --now mapache-ssh-gateway.service
```

Key expiry blocks **new authentication**, not existing tunnels. For rotation,
stop the service, replace `/etc/mapache-ssh-gateway/authorized_keys` with a new
public key retaining its restriction and expiry options, update the API secret,
and enable/start the service. Never put the private key on the gateway. Update
`firewall.nft` for resolver or public-IP changes while the service is stopped,
validate with `sudo nft --check -f /etc/mapache-ssh-gateway/firewall.nft`, then
restart. Do not remove the account or reuse its UID while its policy is installed.

### Configure Mapache

Store this JSON as a Secret Manager secret version in `pi-agents-cloud`:

```json
{
  "version": 1,
  "routes": [{
    "enabled": true,
    "ownerUid": "EXACT_FIREBASE_UID",
    "workspaceIds": ["EXACT_WORKSPACE_ID"],
    "host": "gateway.example.com",
    "port": 22,
    "user": "mapache_tunnel",
    "hostKey": "ssh-ed25519 BASE64_PUBLIC_HOST_KEY",
    "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----\n"
  }]
}
```

Grant `roles/secretmanager.secretAccessor` on this specific secret only to
`mapache-api@pi-agents-cloud.iam.gserviceaccount.com`. Never grant it to the
shared runner account. Do not store the configuration in Firestore, source
control, normal environment-key entries, PRs, logs, or workspace archives.

Set `BROWSER_EGRESS_CONFIG_SECRET` to a **numeric version-pinned** resource such as
`projects/pi-agents-cloud/secrets/browser-ssh-egress/versions/1` on all
provisioning Functions. The API reads the secret and injects only the matching
route into its runner's `MAPACHE_BROWSER_SSH_EGRESS` environment. Cloud Run
administrators can inspect that environment and are within the trust boundary.
No host/key/owner values are hardcoded in the runner image.

## Deployment and rollback

Build a uniquely tagged image before enabling configuration, deploy Functions,
and restart/recreate the authorized workspace with the new image. Existing
services retain their image and environment until replaced. Deploying Functions with the configuration unset is safe before the runner
image rollout and does not enable gateway access.

```bash
gcloud builds submit session-runner --config session-runner/cloudbuild.pi-chrome.yaml --project pi-agents-cloud --substitutions=_IMAGE=us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:gateway-egress-COMMIT
firebase deploy --only functions --project pi-agents-cloud
```

To revoke immediately, remove the dedicated public key on the gateway machine and
terminate existing SSH connections for its dedicated account. Changing a secret
or disabling a route affects only future provisioning; existing tunnels and
injected credentials remain until their runner is stopped/recreated. For a
planned direct-network rollback, disable the route and recreate the runner.
Never silently perform that rollback during a challenge/login.

## Verification

Run `python3 scripts/ssh-gateway/test_gateway.py` on Linux with `unshare`, `ip`,
`nft`, and OpenSSH installed (unprivileged user/network namespaces must be
permitted). It exercises real firewall traffic without changing host rules,
and verifies effective SSH restrictions and unaffected administrator settings.
The installer also requires the Ubuntu/Debian default `UsePAM yes`.

Run the browser-egress service tests, Chrome desktop/lifecycle tests, Functions
suite, runner suite and docs checks. Before release, verify a foreign owner and
foreign workspace receive no credential, unconfigured workspaces stay direct,
normal browser profile state survives restart, gateway egress is observed inside
Chromium, localhost previews remain accessible, and stopping SSH makes browser
internet requests fail instead of using the Google IP. Then verify automatic
reconnect. Owner/workspace denial tests cover the trusted-friends access scope;
they do not establish isolation against malicious runner code.

The initial Wave experiment used two fresh contexts in one live Chromium:
Google egress remained at the challenge while gateway egress reached Wave login.
That experiment demonstrates the network workaround, not persistent-profile
rollout or tenant isolation.

## Related docs

- [Runtime containers](../runtime-containers.md)
- [Backend API architecture](../backend-api-architecture.md)
- [Deployment](../deployment.md)
