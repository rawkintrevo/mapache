# Remote-host VM workspaces

This page defines the contract for the remote-libvirt workspace provider under
#630. Host registration, the lifecycle adapter, the host helper, and the
authenticated gateway are implemented behind explicit provider dispatch. Guest
connection materialization, the workspace-creation UI, and real-host rollout
remain separate children. Existing Cloud Run, Compute Engine, and retained SSH
providers are unchanged.

The host registry portion is implemented by `functions/remoteHost.service.js`
and the authenticated API route composition in `functions/apiRouteManifest.js`,
`functions/apiRoutes.helpers.js`, `functions/apiDispatch.helpers.js`, and
`functions/apiHandlers.helpers.js`. It remains a registry-only capability until
the bootstrap, guest, lifecycle and gateway children are complete.

The host bootstrap portion is implemented by the versioned pair
`scripts/remote-vm-host/install.py` and `scripts/remote-vm-host/helper.py`.
The installer supports Ubuntu 22.04 and 24.04, writes only files carrying the
Mapache marker (or the exact managed libvirt network definition), and reports
readiness with `--check-only --json`. It refuses an unmanaged account, helper,
SSH configuration or network definition instead of overwriting it.

The authenticated `/app` host surface is implemented in
`src/components/remoteHosts/RemoteHostsPage.jsx` and
`src/controllers/remoteHostsController.js`. It is intentionally limited to
one host in v1 and supports registration, copyable public-key/setup directions,
readiness testing, explicit SSH fingerprint confirmation, retry after setup or
connectivity failures, and safe removal. The controller fences requests by
owner identity and clears state on sign-out. Workspace creation links to this
surface, while the explicit remote VM provider option remains part of the
follow-up workspace integration work.

## Product boundary

The existing authenticated `/app` remains the entry point. Workspace creation
will eventually offer `VM on remote machine` beside `Blank` and `GitHub`.
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
| `workspaces/{workspaceId}` | Existing workspace fields plus `source.type=blank`, `runtimeProvider.backend=remote-libvirt`, `hostId`, fixed guest preset, provider state, desired/applied config versions and deletion tombstone | Only IDs and redacted status are public. |
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

### Authenticated gateway implementation (child #640)

`vm-gateway/` is the separately deployed `mapache-vm-gateway-v2` Cloud Run
relay. The browser receives a short-lived `agent` token from
`functions/preview.service.js` and opens only `/agent/` and `/agent/ws` on the
gateway origin. `functions/vmGatewayResolve.service.js` is an IAM-only
`vmGatewayResolve_v2` resolver; it verifies the signed token, owner/workspace
binding, running runtime generation, ready host, pinned host fingerprint, and
the fixed `192.168.250.x:8787` guest endpoint. It returns a bounded relay
authority to the gateway, never to the browser. The private host key is used
only inside the server-to-server resolver/relay path and is never logged or
forwarded to the guest.

The relay opens a pinned `ssh -W` stdio connection to the managed host, strips
browser credentials and forwarding headers, and injects the short-lived access
cookie on the private guest request. HTTP bodies and WebSocket frames stream
with backpressure. A five-second bounded reauthorization loop closes a route
when the host, guest, owner, session, generation, or deletion state changes;
gateway/SSH loss closes the route without stopping the guest, and the client
must request a fresh access URL. The legacy Compute Engine route remains an
explicit direct-target branch; remote-libvirt errors never fall back to it.

Deploy the resolver with `firebase deploy --only functions:vmGatewayResolve_v2
--project pi-agents-cloud`. Build and deploy `vm-gateway/Dockerfile` to the
existing `mapache-vm-gateway-v2` service with
`VM_GATEWAY_RESOLVER_URL=https://us-central1-pi-agents-cloud.cloudfunctions.net/vmGatewayResolve_v2`,
the `mapache-vm-gateway-v2@pi-agents-cloud.iam.gserviceaccount.com` identity,
and public ingress for the signed browser origin. The relay image includes
only the OpenSSH client and Google ID-token client; it has no Firestore or
secret-store authority. Keep the gateway host in the
`VM_WORKSPACE_GATEWAY_HOSTS` Functions environment variable.

## Host trust and bootstrap

The backend generates a dedicated SSH keypair for each owner/host registration.
The UI shows only the public key and a one-time, inspectable `sudo` setup
command. The user downloads the matching `scripts/remote-vm-host/install.py`
and `helper.py`, inspects them, and runs
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

## Guest storage and networking

The host helper creates one private NAT/libvirt network and one QCOW2 disk per
workspace. The guest's workspace, home/tool installations, pi-web-ui state and
agent history remain on that disk across stop/start. Runtime locks, sockets and
other process state are recreated on boot. There is no Cloud Storage
checkpoint/upload loop on this provider, and no disk is attached to two guests
at once. The guest image is versioned and integrity-pinned; changing the image
version affects new guests or an explicit migration, never an existing disk by
surprise.

The guest exposes its pi-web-ui HTTP and WebSocket service only to the private
host network. The gateway route is backend-authored from the host, guest and
session records. It is never accepted from a browser request. The canonical
runner health path remains `/runner/health`; `/healthz` is not an alias or
fallback.

### Versioned guest image (child #638)

The checked-in `scripts/remote-vm-guest/manifest.json` defines guest image
`ubuntu-24.04-v1`: Ubuntu 24.04 LTS amd64, 2 vCPU, 8192 MiB RAM, and a 40 GiB
thin-provisioned QCOW2 disk. `build-image.py` verifies the dated Ubuntu cloud
image SHA-256 before producing a standalone QCOW2, validates an immutable
`gcp-runner` payload, and records a sidecar manifest with the source and
payload hashes. `prepare-payload.sh` requires a content-addressed runner image;
mutable tags are not accepted.

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
| #642 | Existing `/app` workspace creation, list, lifecycle and capability UI |
| #643 | Rollout gate, real-host QA, deployment, rollback and release evidence |

Deferred policies, headed Chrome, custom resources, disk growth, multiple hosts,
backups/recovery and image slimming are tracked under #633. No child ticket
may change Blank, GitHub, legacy SSH or Compute Engine behavior as an incidental
way to implement remote-libvirt.

## Verification and rollout

Contract verification is documentation/link checking plus review against the
current runtime-provider dispatch, Firebase ownership rules, credential
materialization and gateway authorization. Implementation tickets add unit and
integration tests before the release ticket performs a real isolated-host
canary. The feature remains behind an admission flag until the canary proves
owner isolation, persistence across stop/start, tunnel reconnect, duplicate
operation recovery, offline deletion recovery, no public guest ports and
preservation of unrelated host VMs. Existing Cloud Functions deploy commands
must use `--project pi-agents-cloud` and the mandated service accounts.

