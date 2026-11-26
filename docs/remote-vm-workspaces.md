# Remote-host VM workspaces

This page defines the contract for the remote-libvirt workspace provider under
#630. Host registration, the lifecycle adapter, the host helper, and the
authenticated gateway are implemented behind explicit provider dispatch. Guest
connection materialization is implemented below; the integrated workspace
creation and lifecycle UI is now covered by child #642. The real-host rollout
remains the separate #643 gate. Existing Cloud Run, Compute Engine, and
retained SSH providers are unchanged.

The host registry portion is implemented by `functions/remoteHost.service.js`
and the authenticated API route composition in `functions/apiRouteManifest.js`,
`functions/apiRoutes.helpers.js`, `functions/apiDispatch.helpers.js`, and
`functions/apiHandlers.helpers.js`. Workspace admission validates this
owner-scoped registry and requires a ready host before creating a remote
provider descriptor.

The host bootstrap portion is implemented by the versioned pair
`scripts/remote-vm-host/install.py` and `scripts/remote-vm-host/helper.py`, with
the seed renderer in `scripts/remote-vm-host/mapache_guest_config.py`.
The installer supports Ubuntu 22.04 and 24.04, writes only files carrying the
Mapache marker (or the exact managed libvirt network definition), and reports
readiness with `--check-only --json`. It refuses an unmanaged account, helper,
SSH configuration or network definition instead of overwriting it.

The managed account uses the root-owned helper itself as its login shell:
sshd's exact forced-command invocation is accepted without shell evaluation.
The account belongs to `libvirt` for the system socket; this is privileged host
management access, so the helper and SSH restrictions are the authorization
boundary and must remain root-owned. No sudo grant is installed. The public
authorized-keys file is root-owned and readable (0644), while private transport
keys remain server-side. `PermitOpen` enumerates guest addresses .2 through
.254 because OpenSSH does not expand host globs. Installation starts libvirtd
before querying networks, defines a missing managed network, and starts an
inactive one; repeating setup preserves active guests and networks.
Managed storage directories use mode 0711 so libvirt's QEMU user can traverse
them without directory listing access; disk file permissions govern content
access. The credential-free base image is root-owned and readable by QEMU.

`functions/remoteHost.connection.js` implements the registry connection test
using the bundled `ssh2` client (no system SSH binary required). It connects to
an already validated IP. An unconfirmed host returns only its Ed25519
fingerprint and is disconnected before authentication; a changed key is
rejected before authentication. After confirmation, the helper must report an
active managed network, KVM, a readable base image, and valid capacity. Old
helpers without the readiness field require reinstalling the matching helper.
Existing PKCS8 Ed25519 private keys are converted in memory to OpenSSH format
without changing their public keys or persisting temporary key files. The
connection has a bounded deadline and helper output limit; command stderr and
private key material never reach the client. Deploy the API Functions revision
for this change; no Cloud Run runner image revision is needed.

The authenticated `/app` host surface is implemented in
`src/components/remoteHosts/RemoteHostsPage.jsx` and
`src/controllers/remoteHostsController.js`. It is intentionally limited to
one host in v1 and supports registration, copyable public-key/setup directions,
readiness testing, explicit SSH fingerprint confirmation, retry after setup or
connectivity failures, and safe removal. The controller fences requests by
owner identity and clears state on sign-out. Workspace creation links to this
surface. The modal admits creation only when the owner-scoped host is ready and
sends its stable `hostId`; setup and retry remain in the host surface.

## Product boundary

The existing authenticated `/app` remains the entry point. Workspace creation
offers `VM on remote machine` beside `Blank` and `GitHub`.
Remote VM workspaces always start blank. They do not have GitHub workspace
source metadata or managed clone/branch/commit behavior; a user can clone a
repository from pi-web-ui's own terminal.

The first release admits one registered host per Firebase UID. Records still
use a stable `hostId`, so lifting that admission limit later does not change
workspace identity. The host is a Linux machine with KVM/QEMU/libvirt and an
internet-reachable SSH service. The initial host setup targets Ubuntu 22.04;
that host operating-system choice is independent of the Ubuntu 24.04 LTS guest
image. Each workspace owns one retained guest and one retained thin-provisioned
QCOW2 disk sized at 2 vCPU, 8 GiB RAM, and 40 GiB. Sizing changes, disk growth,
multiple hosts, backups, headed Chrome, and scheduled/idle runtime policies are
follow-up work.

The guest runs the existing pi-web-ui experience, including its native
terminal. Mapache does not add a second terminal surface. Guest services have
no public listener; browser traffic uses the authenticated gateway and the
host's SSH transport.

## Ownership and records

Firebase Auth UID is the owner boundary. Every host, workspace, session, tunnel
route, operation and secret lookup is checked against the authenticated UID;
Firestore client rules must not permit client writes to provider authority.

The control plane owns these logical records (exact collection names may be
introduced with the implementation):

| Record | Required fields and invariants | Secret policy |
| --- | --- | --- |
| `remoteHosts/{hostId}` | `ownerUid`, display name, address, SSH port, managed username, pinned host-key fingerprint, setup version, readiness state, capacity snapshot, created/updated timestamps, removal tombstone | No private key or credential body in client DTOs. |
| `users/{uid}/private/remoteHosts/{hostId}` | Host SSH private key reference, key version, revocation state and server-only secret metadata | Stored/read only by the backend secret boundary; never returned to browser, guest, logs or URLs. |
| `workspaces/{workspaceId}` | Existing workspace fields plus `source.type=remote-libvirt`, `source.hostId`, `runtimeProvider.backend=remote-libvirt`, fixed guest preset, provider state, desired/applied config versions and deletion tombstone | Only IDs and redacted status are public. |
| `workspaces/{workspaceId}/sessions/{sessionId}` | Runtime generation, guest identity, access generation, tunnel route reference, lifecycle state and operation reference | Browser/session tokens are short-lived and audience-scoped. |
| `remoteVmOperations/{operationId}` | UID, workspace/host IDs, operation kind, idempotency key, state, attempt, timestamps, worker lease, safe error code and provider generation | Never include private keys, raw SSH output or arbitrary command text. |
| `remoteVmRoutes/{routeId}` | Owner/workspace/session IDs, host/guest target selected by the backend, runtime/access generation, expiry and gateway status | The browser receives a signed access URL, never a target address or forwarding authority. |

Host and guest identities are backend-generated from the owning IDs. A browser
cannot choose a VM name, disk path, guest address, forwarding port, host
command, generation, or secret. Host administrators may inspect their own
guests through the host, but an app request cannot inspect another Firebase
owner's records or an unmanaged host resource.

## Provider and operation contract

The provider name is `remote-libvirt`; it is distinct from `ssh` (a shell
session on an existing machine) and `compute-engine` (Google-managed VM
provisioning). The eventual provider adapter belongs behind the existing
runtime-provider composition boundary in focused modules; `functions/index.js`
and `src/main.js` remain composition roots. Provider dispatch must be explicit:
an error from remote-libvirt never falls back to Cloud Run, Compute Engine or
legacy SSH.

Authenticated API calls create bounded operation records and return an
operation ID when SSH/libvirt work can outlive the request. A worker claims the
record with a lease, executes only the narrow host helper command allowed for
that host, records the observed result, and can safely resume after process
loss. Repeated requests with the same idempotency key return the existing
operation. A lost SSH response is always reconciled by inspecting the backend's
owned guest and disk identity before retrying a side effect.

The implemented host registry endpoints are `GET /api/remote-hosts`,
`POST /api/remote-hosts`, `GET|PATCH|DELETE /api/remote-hosts/{hostId}`, and
`POST /api/remote-hosts/{hostId}/test`. They are behind the same Firebase Auth
and allowlist gate as the rest of `/api`. Registration returns the generated
public key and setup metadata only. A host-key fingerprint can be pinned only
with an explicit confirmation flag; a connection test with no pin reports the
observed fingerprint for owner verification and does not trust it implicitly.
The private key is stored in the backend-only Firestore private subtree and is
deleted on removal. The host registry never starts or deletes a guest; lifecycle
operations use the separate `remoteVmLifecycle.service.js` adapter.

V1 lifecycle states are `provisioning`, `starting`, `running`, `stopping`,
`stopped`, `unreachable`, `error`, and `deleting`. `unreachable` means the host
or tunnel cannot currently be inspected; it does not mean the guest was
deleted. A deletion tombstone fences new work and stale workers. Deletion is
complete only after the host helper confirms that the owned guest and disk are
gone. If the host is offline, deletion remains pending and is retried. Host
removal is rejected while any workspace or cleanup operation references it.

Capacity admission is performed on the host before provisioning and is reserved
for the operation. It checks CPU, memory and real free storage with headroom;
the 40 GiB virtual limit is not a promise that 40 GiB of host storage is free.
Thin-disk exhaustion is surfaced as an error. Reservations are released only
after the operation reaches a terminal state or verified cleanup.

### Lifecycle implementation (child #639)

`functions/remoteVmLifecycle.service.js` owns the remote guest state machine.
Each request creates a deterministic operation ID from owner, workspace, kind,
and idempotency key in `remoteVmOperations/{operationId}`. A transaction checks
the owner, host readiness, workspace tombstone, fixed guest identity, and host
capacity before reserving one 2-vCPU/8-GiB/40-GiB entry. Reservations are stored
per workspace so stop and verified delete can release exactly the owning entry;
the transaction never performs a read after its callback returns.

Workers claim an operation lease and use only the managed `mapache-vm` helper
actions (`inspect`, `create`, `start`, `stop`, `destroy`). A lost SSH response is
resolved by inspecting the deterministic guest and disk before any side effect
is retried. Host errors produce `unreachable` and retain the workspace and
guest; the Firestore trigger retries the same operation after reconnect. Delete
sets a tombstone before remote cleanup and marks the workspace deleted only
after a final `inspect` proves the guest is absent. A stale create/start worker
cannot pass the descriptor generation or tombstone fence.

Remote guests use explicit `autostart=disabled` state. Browser closure and the
legacy idle/scheduled reconcilers do not stop a remote guest; manual stop/start
and workspace deletion are the only v1 power transitions. The lifecycle adapter
dispatches only for `runtimeProvider.backend=remote-libvirt`; provider errors
never fall back to Cloud Run, Compute Engine, or SSH.

Lifecycle helper commands use the same bundled SSH client as host connection
testing. Each operation resolves and validates the host address again, connects
to that validated IP, and pins the Ed25519 key before authentication. Actions
and managed guest names are validated before sending a command. The 45-second
deadline and bounded output prevent indefinite worker waits; disk-full errors
are returned as a safe code without host paths. This path does not require
system `ssh`/`ssh-keyscan` binaries or temporary private-key files. Deploy API,
provisioning, lifecycle-operation, and cleanup Functions that load this module
when changing it; no guest image revision is required.

### Authenticated gateway implementation (child #640)

`vm-gateway/` is the separately deployed `mapache-vm-gateway-v2` Cloud Run
relay. The browser receives a short-lived `agent` token from
`functions/preview.service.js` and opens `/workspaces/{workspaceId}/agent/`
and its child asset/API/WebSocket paths on the gateway origin.
`functions/vmGatewayResolve.service.js` is an IAM-only
`vmGatewayResolve_v2` resolver; it verifies the signed token, owner/workspace
binding, running runtime generation, ready host, pinned host fingerprint, and
the fixed `192.168.250.x:8787` guest endpoint. It returns a bounded relay
authority to the gateway, never to the browser. The private host key is used
only inside the server-to-server resolver/relay path and is never logged or
forwarded to the guest.

The resolver converts existing PKCS8 Ed25519 keys to OpenSSH format in memory
for the gateway's bundled SSH client and resolves the host to a validated public IP
on each authorization. The client verifies the pinned fingerprint before
authentication. A changed host-key pin closes an existing relay at its next
authorization check. Deploy both `vmGatewayResolve_v2` and the gateway image
when changing this transport contract; session runner revisions are unchanged.

The relay opens pinned SSH forwarding channels to the managed host, strips
browser credentials and forwarding headers, and injects the short-lived access
cookie on the private guest request. HTTP bodies and WebSocket frames stream
with backpressure. A five-second bounded reauthorization loop closes a route
when the host, guest, owner, session, generation, or deletion state changes;
gateway/SSH loss closes the route without stopping the guest, and the client
must request a fresh access URL. The legacy Compute Engine route remains an
explicit direct-target branch; remote-libvirt errors never fall back to it.
For an authorized remote guest GET containing `mapache_access`, the gateway
sets a Secure, HttpOnly, SameSite=None cookie scoped to
`/workspaces/{workspaceId}/agent` and redirects
to the same URL without the token. This permits the following asset and
WebSocket requests to authenticate. Invalid tokens never set a cookie; every
subsequent request still checks current session authority and token expiry.
The resolver also requires the URL workspace to equal the signed token's `wid`;
namespaced paths cannot select legacy Compute routes. `vm-gateway/workspacePaths.js`
strips the public prefix only on the private guest hop. It rewrites the small
HTML entry document's root asset links and inserts its workspace base URL so
upstream `appUrl`/`appWsUrl` requests retain the namespace. Vite's compiled preload
helper still embeds the build-time `/agent/` base: a focused rewrite of its
return-prefix expression scopes lazy JS/CSS preload requests as well. CSS asset
`url(/agent/...)` references are scoped too. Entry HTML and static JS/CSS assets
are requested uncompressed and bounded to 1 MiB and
8 MiB respectively. API bodies and streamed content are not rewritten. Changes
to the upstream bundler require rechecking lazy terminal loading with no legacy
`/agent` cookie present. Guest redirects under `/agent` retain the public prefix and
upstream cookies cannot overwrite the gateway cookie. Browser local storage is
still origin-scoped; the namespace isolates routing authority, not browser origins.
Existing unprefixed URLs remain accepted for deployment compatibility; refresh
access URLs to obtain isolated paths. Deploy the gateway image and resolver
before the API URL producer. Roll back the API producer first if necessary;
leave namespace-capable readers deployed until existing URLs expire. No guest
image or standard runner revision is needed for this change.
Remote access tokens also carry the current `agentRuntimeBootInstanceId`.
The resolver requires an exact match and returns that boot identity for ongoing
route renewal. Disk/provider generation is retained across ordinary restarts,
so it cannot substitute for the boot fence. Old and bootless tokens are rejected;
clients obtain a fresh access URL after the API/resolver deployment or restart.
Deploy the API signer before enabling the resolver's required boot check;
the existing resolver already accepts the additional claim. The boot fence
requires Functions updates only. Cookie bootstrap requires the gateway image
revision described above.
The gateway pools authenticated SSH connections by host, username, pinned key
fingerprint and transport public-key digest (independent of private-key
serialization). Each authorized HTTP/WebSocket request
gets its own forwarding channel and retains its own expiry/revocation checks.
Idle connections close after 30 seconds. Asset bursts therefore share a
handshake instead of exhausting the host's unauthenticated SSH connection limit.
The private hop uses HTTP, so its synthesized Origin uses HTTP as well; the
resolver validates the public HTTPS origin before forwarding. Rejected upgrade
responses close with a denial instead of leaving the browser handshake pending.

Deploy the resolver with `firebase deploy --only functions:vmGatewayResolve_v2
--project pi-agents-cloud`. Build and deploy `vm-gateway/Dockerfile` to the
existing `mapache-vm-gateway-v2` service with
`VM_GATEWAY_RESOLVER_URL=https://us-central1-pi-agents-cloud.cloudfunctions.net/vmGatewayResolve_v2`,
the `mapache-vm-gateway-v2@pi-agents-cloud.iam.gserviceaccount.com` identity,
and public ingress for the signed browser origin. The relay image includes
only the SSH transport and Google ID-token client; it has no Firestore or
secret-store authority. Keep the gateway host in the
`VM_WORKSPACE_GATEWAY_HOSTS` Functions environment variable.

## Host trust and bootstrap

The backend generates a dedicated SSH keypair for each owner/host registration.
The UI shows only the public key and a one-time, inspectable `sudo` setup
command. The user downloads the matching `scripts/remote-vm-host/install.py`
with `helper.py` and `mapache_guest_config.py`, inspects them, and runs
`sudo python3 install.py --public-key ./mapache-remote-host.pub`. The user then
explicitly verifies the host fingerprint. The helper account may manage
only Mapache-owned libvirt guests, disks and the private NAT network; it is not
an arbitrary root shell. Re-running setup must preserve unrelated VMs, disks,
firewall rules and SSH access.

The operator-facing steps and revocation procedure are in the
[Remote VM host setup guide](./guides/remote-vm-host-setup.md).

The backend pins the verified host key and rejects changed keys. Revoking a host
removes its app-side secret authorization and shows host-side key removal
directions; it does not delete guests implicitly. Address validation and
connection-time resolution reject loopback, metadata, private control-plane and
other disallowed relay targets. The host's existing port 22 is sufficient; no
guest port is opened to the internet.

Address checks use Node's IP subnet matcher so IPv4-mapped IPv6 literals and
hexadecimal encodings cannot bypass loopback, private, or metadata exclusions.
Connection-time resolution validates literal IPs as well as every DNS answer;
a mixture of public and prohibited answers is rejected rather than selecting
one. Resolver, API, and lifecycle worker deployments must share this validator.

## Guest storage and networking

The host helper creates one private NAT/libvirt network and one QCOW2 disk per
workspace. The guest's workspace, home/tool installations, pi-web-ui state and
agent history remain on that disk across stop/start. Runtime locks, sockets and
other process state are recreated on boot. There is no Cloud Storage
checkpoint/upload loop on this provider, and no disk is attached to two guests
at once. The guest image is versioned and integrity-pinned; changing the image
version affects new guests or an explicit migration, never an existing disk by
surprise.

Guest XML omits graphics devices for the headless v1 guest; `graphics
type="none"` is not a valid libvirt device. Validate generated definitions with
`virt-xml-validate <domain.xml> domain` on the prepared host. Guest address
discovery uses libvirt's DHCP lease source on the managed network, since the
base image does not install a QEMU guest agent. A missing lease remains a
missing address and must not be replaced with an assumed guest IP.

The guest exposes its pi-web-ui HTTP and WebSocket service only to the private
host network. The gateway route is backend-authored from the host, guest and
session records. It is never accepted from a browser request. The canonical
runner health path remains `/runner/health`; `/healthz` is not an alias or
fallback.

### Versioned guest image (child #638)

Before starting a guest, the lifecycle worker reads the owning session and
constructs an allowlisted configuration in `remoteVmGuestConfig.helpers.js`.
Only the session ID, owner/workspace identity, generation/boot identity,
browser/shutdown secrets, and the fixed credential broker URL are included.
The configuration travels over SSH stdin, never command arguments or operation
records. The `configure` helper refuses a running VM and uses `cloud-localds`
to atomically install a mode-0640 NoCloud seed ISO beside the disk. An opaque
configuration hash makes retries idempotent. Changing configuration on a live
guest first stops it; the retained filesystem is preserved.

Cloud-init installs a root-only `guest.env` and a network setup unit that
selects the private DHCP address on each boot before starting the runner on
port 8787. A new configuration changes cloud-init's instance ID. Host startup
waits for a DHCP lease, and the worker verifies the configured identity before
marking the guest running. The broker continues to require the session's
running state, generation, and boot identity. Host deletion removes seed,
configuration marker, and disk even after an interrupted domain undefine.
Reinstall all three host scripts and use the updated guest bootstrap that
accepts the full managed address range. Deploy API and both provisioning and
remote-operation workers together; existing Cloud Run runners do not need
new revisions. Live guest boot and broker readiness remain the rollout gate.

The checked-in `scripts/remote-vm-guest/manifest.json` defines guest image
`ubuntu-24.04-v2`: Ubuntu 24.04 LTS amd64, 2 vCPU, 8192 MiB RAM, and a 40 GiB
thin-provisioned QCOW2 disk. `build-image.py` verifies the dated Ubuntu cloud
image SHA-256 before producing a standalone QCOW2, validates an immutable
`gcp-runner` payload, and records a sidecar manifest with the base, upstream
digest, guest overlay, payload and output hashes. `prepare-payload.sh` requires
a content-addressed runner image; mutable tags are not accepted.

`prepare-repaired-payload.sh` is the v2 packaging entry point. It calls the
immutable extraction command and overlays only the committed #682 guest files,
recording their source commit and individual hashes in `payload.json`. No
upstream runner release is rebuilt for this repair. v2 is installed alongside
v1: the provider default is v2 for newly created workspaces, while existing v1
descriptors and retained disks are never silently rebased.

The payload reuses the pinned `pi-web-ui-v1` runtime and session runner, so the
guest has the existing pi-web-ui experience and native terminal protocol. The
guest systemd unit binds the runner to the lifecycle-assigned
`192.168.250.x` address, keeps pi-web-ui's upstream child on `127.0.0.1:8787`,
and disables Chrome for v1. The bootstrap fails closed for a public/loopback
listener, an unexpected retained-disk root, an unsupported runtime version, or
missing payload files. `/etc/mapache-vm/guest.env` is written only after guest
creation; no owner, host, Firebase, model-provider, or SSH credentials are
baked into the image.

The durable guest roots are `/var/lib/mapache/workspace/{home,workspace,agent,
credentials,uploads,caches}`. They remain on the retained disk across stop,
start, and reboot; sockets, PID files, and other process state are recreated.
The image starts a blank workspace and seeds no repository metadata. The 40 GiB
value is virtual capacity, not promised host allocation: QCOW2 metadata and the
guest filesystem consume some space immediately and allocation grows with
writes. An image-version change applies only to new workspaces unless a future
explicit migration is approved; existing disks are never silently rebased.
Image construction requires `qemu-img`, `virt-customize`, and a KVM-capable
libvirt host. The real boot, authenticated readiness, and reboot-persistence
proof is part of #643.

## Authenticated gateway and SSH transport

The gateway authenticates the Firebase owner/access policy, workspace/session
binding, current runtime generation and short-lived audience-scoped browser
token before opening a route. The gateway then uses the server-side SSH
credential to reach the approved host and the host's private guest target.
Browsers receive an HTTPS origin or signed access URL, never a raw guest IP,
SSH key, host helper command or arbitrary forward target.

HTTP bodies and WebSocket frames stream with backpressure. Long-lived
connections reauthorize periodically, expire at a bounded deadline and close
when a route, generation, host key or owner grant changes. The client reconnects
with a fresh signed URL. Gateway and SSH reconnects do not start or stop a
guest. Dead routes and leases are released after bounded retry/backoff, and
deployment must record connection, concurrency and cost limits for the chosen
gateway service.

The route accepts only the backend-selected pi-web-ui service and approved
runner paths. It rejects caller-supplied hosts, ports, DNS names, metadata
addresses, cross-owner workspace IDs and stale generations. Negative tests must
cover SSRF, origin confusion, token replay, host-key replacement, tunnel loss,
gateway restart and WebSocket expiry. No public guest service is part of this
design.

### Existing connection broker implementation (child #641)

`functions/remoteVmCredentials.service.js` exposes the token-gated
`remoteVmCredentials_v2` broker used by remote guests. A guest signs a
five-minute `remote-credentials` token with its session browser-access secret;
the broker re-reads the owner/workspace/session records and fences the request
by the current remote runtime generation and boot identity before returning
material. It returns only the selected Pi/provider entries, selected generic
environment values, the normalized workspace MCP configuration, and a
short-lived Google access token plus its existing refresh metadata. It never
returns the host SSH key, Firebase/GCP credentials, Google refresh token, or
another owner's entries.

`session-runner/lib/remoteCredentials.service.js` fetches this response before
runner startup, applies the bounded environment and MCP configuration, and
hands the selected Pi entries to the existing `workspaceAuth` materializer.
Google renewal continues through the existing private Unix-socket broker, so
the embedded pi-web-ui process receives neither the remote broker URL nor the
session/browser or shutdown credentials. A stopped/restarted session receives
a new generation/boot fence; rotation, revocation, an expired connection, or a
broker failure produces an actionable startup/materialization error rather
than falling back to another account. The guest bootstrap exports only the
workspace-scoped runtime identity and broker URL from `guest.env`; host
transport keys are never written there.

## Existing connections and authority

Remote guests reuse the existing owner-scoped connection catalog. The
implementation must inventory and preserve these classes: Pi/provider auth
(`users/{uid}/private/agentAuth` and selected entries), generic environment
keys, workspace MCP definitions, Google Workspace bindings and tokens, and
GitHub account connections used by tools inside a blank workspace. Connection
selection remains ID-based and secrets are materialized through the existing
backend/broker patterns. A remote workspace does not create a second account
store and does not turn GitHub connections into a managed GitHub workspace
source.

The host SSH key is a transport credential, not an agent credential. It must
never be copied into the guest or exposed to pi-web-ui. Guest bootstrap receives
only the short-lived, workspace/session/generation-scoped material needed to
materialize selected connections. Revocation and rotation deny old generations
and are reflected on the next bounded refresh or restart. Missing or expired
connections fail visibly; they do not silently select another owner's values.

## Child issue ownership

The v1 work is deliberately split so each ticket has one owner boundary:

| Issue | Owns |
| --- | --- |
| #635 | Owner-scoped host registry, generated keys, pinned trust and secret redaction |
| #636 | Versioned Ubuntu host bootstrap, narrow helper and readiness checks |
| #637 | Host setup UI, setup directions, fingerprint verification and status |
| #638 | Ubuntu 24.04 guest image, pi-web-ui/native terminal and retained disk paths |
| #639 | Remote libvirt lifecycle, capacity reservation, idempotency and deletion |
| #640 | Authenticated HTTP/WebSocket gateway and SSH relay/reconnect behavior |
| #641 | Reuse of existing Pi auth, environment, MCP, Google and GitHub connections |
| #642 | Existing `/app` workspace creation, list, lifecycle and capability UI (implemented) |
| #643 | Rollout gate, real-host QA, deployment, rollback and release evidence |

Deferred policies, headed Chrome, custom resources, disk growth, multiple hosts,
backups/recovery and image slimming are tracked under #633. No child ticket
may change Blank, GitHub, legacy SSH or Compute Engine behavior as an incidental
way to implement remote-libvirt.

## Verification and rollout

Guest payload extraction rewrites the npm Pi launcher symlink for the
payload's relocated module directory and excludes ssh2's test fixtures.
The builder uses `virt-resize` to expand the pinned image's root partition
and filesystem before installing the payload, and creates all durable
directories before systemd enters the runtime working directory.
The guest also exposes `/workspace` as a symlink to the retained workspace
directory, matching the managed pi-web-ui project root without duplicating data.
It reinstalls BIOS GRUB and regenerates the menu after resizing: GPT partition
renumbering otherwise leaves an obsolete GRUB prefix and stops at rescue mode.
The v1 image masks unused Snap services so network-dependent Snap seeding cannot
block cloud-final. The runner retries startup every five seconds without a
systemd start-rate cutoff, allowing the credential broker and session state to
become available after guest boot.
The image validator rejects saved credential filenames and private-key
material while allowing dependency source filenames and documentation that
only illustrate key headers. With Snap Docker, extract into a non-hidden
directory under the current user's home; `/var/tmp` may be inaccessible to
the Docker client. These preparation changes affect the remote guest image
only and do not require a Cloud Run runner revision.

On Ubuntu, supermin may fail if the selected `/boot/vmlinuz-*` is readable
only by root. Diagnose with `libguestfs-test-tool`. An operator can copy that
specific kernel to a readable build directory with `sudo install -m 0644`;
set `SUPERMIN_KERNEL` to that copy and `SUPERMIN_MODULES` to its matching
`/lib/modules/<version>` directory when invoking the builder. This avoids
changing permissions on the installed boot kernel.

Contract verification is documentation/link checking plus review against the
current runtime-provider dispatch, Firebase ownership rules, credential
materialization and gateway authorization. Implementation tickets add unit and
integration tests before the release ticket performs a real isolated-host
canary. The feature remains behind an admission flag until the canary proves
owner isolation, persistence across stop/start, tunnel reconnect, duplicate
operation recovery, offline deletion recovery, no public guest ports and
preservation of unrelated host VMs. Existing Cloud Functions deploy commands
must use `--project pi-agents-cloud` and the mandated service accounts.

### Release-gate runbook (#643)

Remote guest startup initializes `.mapache-vm-disk.json` before starting the
runner. `session-runner/lib/remoteGuestDisk.js` binds the host-created disk to
the root-owned seed's workspace/owner identity, accepts only the image's known
directory layout for first initialization, and refuses an existing foreign
marker. Generic retained-disk mount validation still rejects unmarked nonempty
volumes. The bootstrap never replaces an established disk identity.

Home guests have no Firebase service-account credentials. The server selects
`remoteWorkspaceAuthority.js` instead of the Cloud Run Firestore authority.
It validates the lifecycle-issued boot/session/generation through the existing
credential broker every five seconds, caps local admission at fifteen seconds,
and stops pi-web-ui on denial, transport failure or expiry. The remote-only
`remoteAuthorityLoss.js` handler then exits the runner with status 1, including
when agent shutdown fails or exceeds five seconds. Systemd's existing
`Restart=on-failure`/`RestartSec=5` policy retries the full bootstrap; every retry
must obtain current broker admission before starting pi-web-ui. Continued
revocation stays unavailable, while a transient outage can recover without a
manual VM restart. It issues no agent-task resume command and does not change boot identity.
The guest unit cleans up remaining processes before starting its replacement.
A released boot
cannot be readmitted by a late response. Broker requests have a ten-second
deadline. The host enforces the one-VM-per-workspace invariant; the broker fences
superseded boot identities. Lifecycle state remains control-plane-owned.
Guest activity helpers do not write Firestore, broker-filtered credentials do
not re-read account selection directly, and native model choices remain on the
retained disk. Cloud Run authority and telemetry are unchanged.

These fixes require an updated guest payload, bootstrap and systemd unit.
Quote the entire `RUNNER_CAPABILITIES` assignment in the unit so systemd retains
the JSON quotes, and use the retained home for user-installed executables.
Existing guests need an explicitly stopped, backed-up offline update; never
overwrite a base image while any retained QCOW2 overlay still references it.
Updating only Cloud Functions cannot repair an already-created guest disk.
Standard Cloud Run services do not need a new revision for the remote-only
branches, and these guest changes do not require a Functions deployment.

Operation completion must read workspace/session/host reservation records before
any transaction writes. Stop/delete/cancellation release capacity inside that
same transaction. A confirmed stop also publishes the owned session's stopped
state, so the UI and credential broker cannot retain a running session after
the guest is off. This uses an explicit reconciliation transition when the
session still says running. Only the original queued event drives automatic
retries, with platform backoff for pending/offline work; error-state writes do
not recursively enqueue themselves, and permanent failures require an explicit
retry. The captured boot identity prevents an old stop completion
from changing a newer boot's session. Successful completion clears earlier
operation/workspace errors. Deploy `api`, `provisionQueuedSession` and
`reconcileRemoteVmOperation` together for these shared lifecycle changes.

The session provisioning worker and operation reconciler can observe the same
start concurrently. A queued/running operation whose lease is held by another
worker returns `remote_vm_provisioning_pending`. The provisioning trigger retries
without marking the session failed or releasing its reservations. A later
attempt adopts the completed operation and publishes the running session;
it does not create or restart a second guest. Actual host failures retain their
existing error handling. Deploy both `provisionQueuedSession` and
`reconcileRemoteVmOperation`, plus `api`, when changing this shared lifecycle
code. No guest image or host helper update is required for this behavior.

The gateway hostname can also have a legacy Compute Engine route. The resolver
dispatches workspace-scoped tokens (the `wid` claim) to remote-libvirt before
looking up that hostname route, then verifies the token against the owned
remote session. An invalid remote token never falls back to Compute Engine.
Tokens without a workspace claim retain the legacy route contract. Deploy
`vmGatewayResolve_v2` for resolver dispatch changes; no gateway image rebuild
is needed.

The live canary is deliberately separate from the mocked/unit fixtures. The
operator must reserve one disposable host and one owner account, record the
release commit and guest-image/helper versions, and keep host addresses,
fingerprints and credentials out of committed evidence. Run the following
read-only host check from the prepared host before registering it:

```bash
python3 scripts/remote-vm-host/install.py --check-only --json
```

The result must contain `ready: true`, `kvmAvailable: true`,
`libvirtAvailable: true`, `networkReady: true`, and all required commands. A
`ready: false` result is a blocked rollout, not a reason to bypass the gate.
Install or update the host only with the matching release scripts and then
repeat the check. Do not delete or redefine an unrelated libvirt network or
guest while repairing readiness.

Run the checked-in browser cases with Chrome DevTools against the deployed
revision:

- `remote-vm.security-boundary` must reject a forged host ID with no workspace,
  guest, disk or tunnel side effect.
- `remote-vm.rollout-canary` must be run with an operator-supplied ready
  `remoteHostId`. It creates one disposable blank workspace/session, verifies
  the pi-web-ui/native terminal, writes a sentinel file and harmless user-scoped
  tool, disconnects/reconnects the browser, stops/starts the guest, exercises a
  duplicate mutation and a gateway/SSH interruption, then uses the explicit
  permanent-delete confirmation. Inventory the host's managed disk directory,
  libvirt domains and capacity after cleanup; unrelated guests and networks
  must be unchanged. Retain only sanitized screenshots, network status and
  operation IDs.

The current admission behavior is intentionally fail-closed: workspace
creation requires an owner-scoped host with `ready` status. If a canary cannot
be completed, leave admission disabled and record the blocker rather than
calling a mocked test a release. Existing remote workspaces must continue to
use their stored provider descriptor when admission is disabled.

Rollback is a Functions revision rollback, followed by disabling new remote
admission at the same configuration boundary. Do not remove the remote
provider dispatch, gateway, host key material or guest disks during rollback;
existing workspaces need those paths to stop, reconnect or finish deletion.

