# Owner-scoped browser SSH egress

## Access scope

This feature prevents accidental use of an owner's office connection by other
Mapache users. It is operator-configured and off by default; each route matches
both the exact Firebase owner UID and an explicit workspace allowlist. Normal
users cannot select someone else's route or override its reserved environment
variables. Keep credentials in an API-only Secret Manager secret.

This is not a hostile multi-tenant sandbox. The current shared runner service
account has broad control-plane data access, and the authorized workspace's
root shell can access its own runtime credentials. The owner explicitly accepts
the trusted-friends threat model; defending against malicious runner code would
require a separate infrastructure isolation change. Do not describe owner checks
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
  preserves the proxy arguments on Chrome restart. The office route covers the
  browser's web traffic, with localhost preview/CDP remaining local. SOCKS-side
  resolution, blocked external local DNS resolution, disabled QUIC, and the
  non-proxied WebRTC UDP policy avoid ordinary browser network bypasses. There
  is no `DIRECT` fallback: an unavailable tunnel produces request errors.
  This is browser configuration, not a container-wide network firewall; a trusted
  agent can start another browser or change its own proxy settings.
- Model API, terminal, Git and workspace storage traffic keep existing routes.
  Automation sessions inherit the route only for an explicitly allowed workspace.

## Operator configuration

Use a dedicated office SSH account/key restricted to TCP forwarding, without
shell, PTY, agent, or X11 access. Permit destination ports 80/443 only; restrict
remote forwarding in `sshd_config`. Verify office login and host key out of band.
The office host must stay awake and reachable. Never reuse a personal SSH key.

Store this JSON as a Secret Manager secret version in `pi-agents-cloud`:

```json
{
  "version": 1,
  "routes": [{
    "enabled": true,
    "ownerUid": "EXACT_FIREBASE_UID",
    "workspaceIds": ["EXACT_WORKSPACE_ID"],
    "host": "office.example.com",
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
`projects/pi-agents-cloud/secrets/browser-office-egress/versions/1` on all
provisioning Functions. The API reads the secret and injects only the matching
route into its runner's `MAPACHE_BROWSER_SSH_EGRESS` environment. Cloud Run
administrators can inspect that environment and are within the trust boundary.
No host/key/owner values are hardcoded in the runner image.

## Deployment and rollback

Build a uniquely tagged image before enabling configuration, deploy Functions,
and restart/recreate the authorized workspace with the new image. Existing
services retain their image and environment until replaced. Deploying Functions with the configuration unset is safe before the runner
image rollout and does not enable office access.

```bash
gcloud builds submit session-runner --config session-runner/cloudbuild.pi-chrome.yaml --project pi-agents-cloud --substitutions=_IMAGE=us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:office-egress-COMMIT
firebase deploy --only functions --project pi-agents-cloud
```

To revoke immediately, remove the dedicated public key on the office machine and
terminate existing SSH connections for its dedicated account. Changing a secret
or disabling a route affects only future provisioning; existing tunnels and
injected credentials remain until their runner is stopped/recreated. For a
planned direct-network rollback, disable the route and recreate the runner.
Never silently perform that rollback during a challenge/login.

## Verification

Run the browser-egress service tests, Chrome desktop/lifecycle tests, Functions
suite, runner suite and docs checks. Before release, verify a foreign owner and
foreign workspace receive no credential, unconfigured workspaces stay direct,
normal browser profile state survives restart, office egress is observed inside
Chromium, localhost previews remain accessible, and stopping SSH makes browser
internet requests fail instead of using the Google IP. Then verify automatic
reconnect. Owner/workspace denial tests cover the trusted-friends access scope;
they do not establish isolation against malicious runner code.

The initial Wave experiment used two fresh contexts in one live Chromium:
Google egress remained at the challenge while office egress reached Wave login.
That experiment demonstrates the network workaround, not persistent-profile
rollout or tenant isolation.

## Related docs

- [Runtime containers](../runtime-containers.md)
- [Backend API architecture](../backend-api-architecture.md)
- [Deployment](../deployment.md)
