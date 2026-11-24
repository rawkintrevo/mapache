# VM Workspaces

This page is the active contract for the disposable Compute Engine workspace
backend introduced by #605. Firebase Hosting, Auth, Firestore, Cloud Storage,
and Cloud Functions remain the control plane. The VM feature is disabled until
the isolated proof and release gates in this page have passed.

The [2026-11-23 handoff](./handoffs/vm-crossover-605.md) records the paused
implementation state, issue-by-issue evidence, live fixture, recovery gaps and
next steps. It distinguishes implemented behavior from the target contracts
below; the crossover is not complete.

## Decision summary

Each managed workspace is one logical machine with a stable workspace ID and a
single retained zonal Persistent Disk. Compute is disposable: normal pause
deletes the VM and its auto-delete boot disk, while the data disk remains
attached to no writer. A replacement creates a new boot disk and VM, verifies
the data-disk identity, and attaches that same disk read/write. A workspace
never silently changes from a stored VM provider back to a stale Cloud Run
checkpoint.

The default region is `us-central1`; the initial proof zone is `us-central1-a`.
The initial machine preset is `e2-standard-2`, with a `pd-balanced` data disk
starting at 64 GiB and growing only after an explicit validated request. A
regional or multi-zone disk is a later availability decision, not an implicit
fallback. We do not introduce a standing cluster, NFS server, or shared
ext4 attachment.

`functions/runtimeProvider.helpers.js` owns the versioned descriptor and
workspace/owner identity checks. `functions/computeEngine.service.js` owns
Compute Engine REST operations, ownership labels, retained-disk attachment,
boot-disk deletion, and the Docker startup script. `functions/runtimeProvider.service.js`
dispatches lifecycle operations to the stored provider. `VM_WORKSPACE_RUNTIME_ENABLED`
only controls new workspace admission; it cannot change an already stored
descriptor.

## Trusted runtime descriptor

Managed workspace and session records may contain:

| Field | Contract |
| --- | --- |
| `version` | `1`; unknown versions fail closed. |
| `backend` | `cloud-run`, `compute-engine`, or retained `ssh`. |
| `workspaceId`, `ownerUid` | Backend-authored identity; must match the document and authenticated caller. |
| `region`, `zone` | Backend-selected location. |
| `generation` | Monotonic writer/access generation. |
| `dataDiskName` | Deterministic backend-owned name; never accepted from the browser. |
| `instanceName` | Generation-specific disposable VM name. |
| `gateway.baseUrl` | HTTPS origin only; no caller-supplied upstream address or credentials. |
| `desiredConfigVersion` | Machine configuration revision that must be applied before agent launch. |
| `state` | Provider state, reconciled from Compute Engine rather than inferred from a request timeout. |

Legacy records without a provider descriptor remain Cloud Run records. A record
that advertises a provider version but has a missing or invalid descriptor is a
visible error; no fallback writer is launched.

## Durable path and lifetime contract

The VM startup script uses Docker directly and never uses the deprecated
container declaration path. It formats a disk only when the create operation
proved that the disk is new, then mounts it. An existing disk must already have
the expected filesystem and marker; a missing marker, wrong owner, wrong
workspace, or unexpected populated root stops startup.

Initial creation evidence is persisted on the disk as its original operation
label and `mapache-created-generation`. A worker that stops after disk creation
can retry that same operation/generation with explicit `allowCreateDisk=true`;
it no longer depends on an in-memory `_mapacheCreated` property. Ordinary
resume/replacement keeps creation authority off, even if the original labels
remain. A different operation or generation cannot borrow that authority.
The bootstrap accepts only a successful signature probe or the explicit
no-signature result, mounts ext4, and permits creation of a missing identity
marker only for the admitted initial operation on an empty filesystem.
Probe errors, unmarked retained disks and populated unmarked roots fail closed.
Initial workspace reservation/admission is handled by the owner creation path
below; this low-level recovery contract alone does not admit new workspaces.

`functions/computeEngine.creation.test.js` injects loss of the disk-create
response, reconstructs the service and runs the generated storage bootstrap in
Bash with stubbed device calls. It covers recovery, retained-disk refusal,
wrong operation/generation, probe errors, and marker ownership.
`scripts/vm-initial-disk-proof.mjs disk|boot|inspect|pause` is the isolated live
equivalent, fixed to `vm-initial-disk-proof-605`; disk creation and boot must be
separate invocations. It supplies no runner credentials or gateway route and
tests host storage initialization only. After evidence collection, pause it,
verify detachment and delete only this proof disk to avoid idle storage cost.
Compute bootstrap edits apply to newly created VMs; existing VMs do not need
a runner image rebuild. Deploy the isolated worker and reconciler with
`firebase deploy --only functions:vmLifecycleWorker_v2,functions:vmLifecycleReconcile_v2 --project pi-agents-cloud`.
On 2026-11-23 that selective deployment succeeded. The separate-process live
proof created disk `mapache-ws-766db742df3a8c426b5b2487`, exited, and then booted
VM `mapache-vm-74b946c7ce56ea96b777dffc`. SSH confirmed an ext4 mount and the
expected workspace/owner/generation/operation marker. Evidence is under
`artifacts/qa/vm-initial-disk/`. This is storage-bootstrap evidence, not an
authenticated agent or end-to-end new-workspace creation test.
After verification the proof VM was deleted, its disk detachment confirmed,
and the dedicated proof disk deleted. The main `vm-proof-605` fixture remains.

| Data | Container path | Backing | Lifetime | Writer |
| --- | --- | --- | --- | --- |
| Workspace and `.git` | `/workspace` | retained disk | workspace lifetime | main VM only |
| User HOME and local tools | `/root` | retained disk | workspace lifetime | main VM only |
| Agent history, transcripts, UI state, MCP selection | `/var/lib/mapache/agent` | retained disk | workspace lifetime | admitted runtime |
| Chromium profile | `/var/lib/mapache/chrome/profile` | retained disk | workspace lifetime | one interactive browser |
| Broker-materialized credentials | `/var/lib/mapache/credentials` | retained disk with managed refresh/revocation | selected binding lifetime | control plane/runtime |
| Uploads | `/uploads` and workspace files | retained disk | workspace lifetime | authenticated upload or workspace process |
| Caches | `/var/cache/mapache` | retained disk, disposable contents | workspace lifetime | runtime-local |
| PID files, sockets, locks | runtime-specific subdirectories | recreated on boot | process lifetime | one VM |
| Boot image, Docker layers, logs | boot disk / logging | disposable or exported logs | VM lifetime / retention policy | VM service account |
| Backups and immutable outputs | Cloud Storage / snapshots | separate backup/output policy | configured retention | control plane |

Normal start, pause, and replacement do not serialize HOME or WORKSPACE to
Cloud Storage. Checkpoint and bundle readers remain available for migration and
recovery, but are not the VM lifecycle protocol. The filesystem is POSIX and
therefore preserves native locks, renames, modes, symlinks, dirty Git state,
SQLite files, and package trees.

Owner-wide tools remain owner-scoped rather than being attached read/write to
multiple VMs. Until a native owner-wide tool volume exists, installation
sharing is explicit through the existing broker/storage contract; the VM path
does not mount one ordinary ext4 filesystem into two workspaces.

## Access, identity, and routing

The parent app's `/metrics` WebSocket is the sole cross-origin gateway
exception. `vmRuntimes_v2/{id}.metricsOrigins` is a backend-only list of exact
approved app origins; it is not accepted from a browser request. An approved
origin still needs a valid current-generation agent token and the normal
workspace/session/boot/lease authority. Other paths, including Agent sockets,
shell and shutdown, keep the same-origin restriction. Removing an origin
invalidates its long connection on the next gateway reauthorization. Operators
must configure the deployed frontend origin when admitting a VM to the UI.
The live shell harness temporarily adds only `http://127.0.0.1:5174` to the
synthetic fixture, then restores its prior origin configuration.

VM resource collection uses container cgroup usage counters. If cgroup v2
explicitly reports unlimited memory (`max`), only the Compute Engine runtime
uses physical VM memory as the capacity denominator. This reports container
usage relative to machine capacity, not total host/OS usage. Explicit cgroup
limits retain precedence; missing/malformed metrics remain unavailable. Cloud
Run collection does not enable this fallback. Owners are
`session-runner/lib/resourceMetrics.service.js` and `session-runner/server.js`;
the change needs a new VM runner image, not a Cloud Run revision.

Runner, Chrome, terminal, preview, upload, and WebSocket traffic enters through
the authenticated gateway origin recorded in the trusted descriptor. The VM has
no public runner, Chrome, terminal, or debug port. The gateway authorizes the
Firebase owner/access policy and the current runtime generation before routing;
stale cookies and old generations are rejected. VM IP changes and replacement
are handled by updating the backend-owned gateway target and reconnecting with
fresh access material.

### Isolated gateway implementation

`vm-gateway/` is a streaming HTTP/WebSocket proxy deployed as the separate
`mapache-vm-gateway-v2` Cloud Run service. User compute remains on the VM.
The gateway uses Direct VPC egress to the dedicated subnet and network tag
`mapache-vm-gateway-v2`; firewall `mapache-vm-v2-gateway` permits only that
source tag to reach TCP 8080 on `mapache-vm-v2` instances. No public VM IP or
runner port is created. Direct VPC configuration follows the
[Cloud Run documentation](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc).

Its dedicated identity `mapache-vm-gateway-v2@pi-agents-cloud.iam.gserviceaccount.com`
has only invocation access to the new `vmGatewayResolve_v2` Function, not
Firestore or stored credentials. The Function runs as `mapache-api` and
transactionally checks a backend-owned `vmGatewayRoutes_v2/{hostname}` mapping,
workspace/session ownership, active generation, matching boot, and live lease.
Browser credentials must be signed for the current session; agent paths also
require the agent audience and generation. Health requires the separate shutdown
credential. A supplied cross-origin Origin is rejected. The Function returns
only a private target and bounded authority deadline, never a stored secret.
Both resolver and proxy reject targets outside the dedicated `10.90.0.0/24`
subnet and port 8080. The controller, not a runner/client, writes routes.

HTTP bodies and WebSocket frames stream with backpressure. Long-lived requests
reauthorize at most every five seconds and close by the authorization deadline
(at most ten seconds), even when the resolver hangs. Target/generation/boot
changes close the old connection. Connections also close after 55 minutes,
below the gateway's one-hour Cloud Run request timeout; clients must reconnect.
The initial canary caps the gateway at two instances with concurrency 80,
256 MiB and zero minimum instances. Each active long-lived connection currently
requires approximately 720 resolver requests and 2,880 Firestore document reads
per hour. Capacity, reconnect behavior, and measured cost remain release gates;
there is no production-scale authorization cache yet.

The current hostname belongs only to `vm-proof-605`. Unknown hosts fail closed.
General rollout still needs isolated origins per workspace; a shared origin
for mutually untrusted workspace applications is not acceptable. No DNS,
Hosting rewrite, existing API, or legacy Cloud Run service was changed.

Deploy the resolver separately:
`firebase deploy --only functions:vmGatewayResolve_v2 --project pi-agents-cloud`.
Its declared invoker preserves the dedicated gateway grant across deployments.
Build `vm-gateway/Dockerfile` to a new immutable image and deploy only
`mapache-vm-gateway-v2`, with the dedicated service account, network/subnet/tag,
private-ranges-only egress, and `VM_GATEWAY_RESOLVER_URL` set to the new Function.
The initial gateway image is
`sha256:d2f1b9febefefdcc0c696346a3ca6b9c116ce2500b049b32a6e9a55cf8484c32`
(build `ab715c7b-da1b-466c-8c8b-3a4250ec772e`). Existing runners need no image
change for this proxy. The separate runtime broker now accepts bounded `shell`
and `shell_stdout` history streams, requiring its own selective redeploy.

`scripts/vm-gateway-fixture.mjs route|probe|browser GENERATION` is restricted to
the synthetic identity. Route setup verifies Compute ownership, subnet, no
external IP, and the current registry generation. Live generation-5 probes
passed agent HTML and 17 bundles, authenticated health, wrong-token/audience/
generation/origin rejection, and a real shell WebSocket returning retained
workspace/HOME paths. Unauthenticated resolver invocation returned 403.
The browser case is `e2e/qa/cases/vm-gateway-fixture.json`, with evidence under
`artifacts/qa/vm-gateway-fixture/`. It checks a settled composer and successful
network traffic; the exact upstream Device Center `409 NOT_PAIRED` response is
expected for this deliberately unpaired fixture. This is not model chat,
Chrome desktop, upload/resume, or migration acceptance. Real replacement
reconnect and stale-connection fencing are exercised separately below.

`scripts/vm-gateway-replacement-proof.mjs GENERATION PINNED_IMAGE` keeps the
scope fixed to the synthetic fixture. It first revokes the gateway route while
the VM remains alive and checks that an existing socket closes within 12 seconds.
It then restores that route, opens another connection, replaces the disposable
compute, updates the route to the new generation, and polls actual agent health.
Finally it rejects the old still-unexpired browser token, old health credential,
and old WebSocket handshake before reconnecting with fresh credentials. It does
not restart a slow boot or infer health from Compute RUNNING.

On 2026-11-23 generation 5 -> 6 passed: live route revocation closed the socket
in 5,370 ms; replacement and successful reconnection took 190,012 ms including
the cold image pull. Generation 6 is `mapache-vm-044cc7581096c8e0f32f4afd`, with
the same retained disk `mapache-ws-efaf283eb879545a0e7ba4d3` and pinned image.
Its normal in-container runtime proof and filesystem verifier also passed,
including the original generation-2 Git HEAD, SQLite, native binary, mode,
symlink and lock checks. A repeated start adopted that exact existing instance
and its correct retained disk. Evidence is
`artifacts/qa/vm-gateway-replacement/result.json`. These observations do not
establish open-write crash recovery, browser-profile persistence, or full
worker-crash reconciliation.

Compute lifecycle operations now fail closed when pause cannot confirm instance
absence and an unattached retained disk. `inspect()` exposes the disk's users
for reconciliation. Start refuses a disk still attached to another instance,
and retries adopt an existing instance only if its one data disk is the admitted
READ_WRITE attachment with auto-delete disabled. A TERMINATED VM requires a
new generation and credentials, rather than restarting an expired admitted boot.
A missing disk is never silently replaced with an empty one: creation requires
explicit `allowCreateDisk` authority for a new workspace. The fixture records
that authority only on its initial reservation and stops using it once a boot
has been admitted. Interrupted first-disk initialization still requires durable
controller reconciliation before production use. These helper changes are used
by the local fixture and the isolated lifecycle controller below; production
API/migration integration remains outstanding.
No legacy Functions using this helper were redeployed. The isolated preflight
is selectively redeployed with the current Functions source package; it does
not enable VM admission or perform lifecycle mutations.

### Resumable lifecycle canary

`functions/vmLifecycle.service.js` owns operation reservation and phases;
`vmLifecycle.adapter.js` owns Compute, gateway publication and authenticated
shutdown/health calls. The separately named `vmLifecycle_v2` operator endpoint,
`vmLifecycleWorker_v2` Firestore worker and `vmLifecycleReconcile_v2` minute
scheduler use only `vmLifecycleOperations_v2` and the existing isolated VM
registry. They run as `mapache-api`. The HTTP endpoint is IAM-private; this is
not yet the Firebase-owner API or a production migration admission path.

Only an existing VM record explicitly marked `lifecycleEnabled=true` can queue
start, pause or replacement. The request checks owner, expected generation,
state, trusted pinned image and gateway configuration. Its request ID gives a
stable operation ID. Duplicate requests return that operation; competing
operations cannot take the workspace while it holds `activeOperationId`.

The phases are quiesce -> delete -> reserve -> provision -> route -> health.
Pause completes after confirmed deletion/detachment. Start skips quiesce but
still confirms old compute absence. Reservation atomically creates one fresh
session/generation and credentials, retaining selected authentication, environment entry IDs, and model
scope read from the old session after quiesce/deletion, including final shutdown
saves rather than an earlier enqueue snapshot. Provision retries use the same Compute operation ID and cannot create a
missing retained disk. Gateway routing changes only to the current owned VM;
completion requires actual agent health plus a still-current live writer lease.
Compute RUNNING is insufficient. Browser requests are denied while stopping;
the controller's distinct health/shutdown credential remains allowed until the
lease is released. Failed/unreachable quiesce is recorded explicitly before
deletion; it is not reported as successful graceful shutdown.

`functions/vmEnvironment.service.js` resolves only those selected environment
entries from the owner's private store at provisioning time. Values are injected
into Compute bootstrap, never copied into workspace/session/operation records.
Missing/deleted or foreign entries, duplicate variable names, and reserved
runtime/path variables stop provisioning with a value-free error. Editing an
entry affects the next process launch; an already running process keeps its
environment. This preserves existing selections across replacement; the
versioned machine editor and inheritance described below remain outstanding.

The fixed synthetic-fixture proof is `node scripts/vm-environment-proof.mjs
seed`, followed by replacement through `vm-lifecycle-fixture.mjs`, then
`vm-environment-proof.mjs verify` and `cleanup`. It uses a non-secret marker,
checks the actual new container environment over IAP, and removes its selected
reference and private entry after verification. It refuses to overwrite existing
selections or run during a lifecycle operation.

Live proof on 2026-11-23 replaced `vm-proof-605` generation 9 with generation 10
through operation `02e44651ff1c87688b63b9d8fd4ff0007df71836992adfbd8afbe1e3280a1ae1`.
The new container received the selected marker value; runner health, agent
readiness, metadata fencing, retained child paths, Git/SQLite/native executable,
permissions, symlink and locking checks passed. The proof selection/private entry
were removed afterward. Evidence is under `artifacts/qa/vm-environment/` and
`artifacts/qa/vm-lifecycle/`. Only `vmLifecycleWorker_v2` and
`vmLifecycleReconcile_v2` were deployed with `--project pi-agents-cloud`, both
running as `mapache-api@pi-agents-cloud.iam.gserviceaccount.com`. No runner image
or existing Cloud Run service revision was required for this environment fix.

Each worker invocation has a 540-second hard platform timeout and a 15-minute
exclusive claim. An uncertain cloud effect or exception retains the claim and
workspace admission. Reconciliation waits until that invocation cannot still
be running, then retries the same phase and operation ID. Stale completion
callbacks cannot overwrite a newer claim. The worker never logs raw Google API
error objects, which can contain bootstrap credentials. Health-not-ready retries
wait at least 15 seconds and are picked up by the minute scheduler.

The first controller is deliberately limited to admitted canaries: reconciliation
scans up to 100 pending operations and runs up to four at a time. Paginated cohort
reconciliation, operator repair/UI flows,
resource resizing, richer machine properties/capabilities and end-to-end worker
termination tests remain required before broad rollout. Unit tests inject loss
after each external phase and verify stable operation/instance IDs, admission,
duplicate suppression and readiness fencing; these are not real process-kill
acceptance tests. Missing storage stays pending with an actionable error and no
automatic empty-disk or Cloud Run fallback.

Deploy only the new functions and resolver:
`firebase deploy --only functions:vmLifecycle_v2,functions:vmLifecycleWorker_v2,functions:vmLifecycleReconcile_v2,functions:vmGatewayResolve_v2 --project pi-agents-cloud --force`.
The explicit Firebase retry-policy acknowledgement applies to the new worker;
the selected deploy does not replace legacy triggers. No runner rebuild is
needed. `scripts/vm-lifecycle-fixture.mjs` admits only `vm-proof-605` and calls
the IAM-private API using an operator identity token without printing it.
Its pause/start/replace requests are submitted twice to check idempotency;
`status`/`wait` observe the persisted operation rather than restarting work.

On 2026-11-23 the deployed controller paused generation 6 with successful
quiesce, confirmed the VM absent and the retained disk's `users` empty, then
started generation 7 on `mapache-vm-e867ca428e8588b757d06955`. Both requests were
submitted twice and returned their original operation IDs. Pause operation
`83dd5385515a11e8499f270c823637fb25b9307f346349fc51fdf5cee0479530` and start
operation `a0f18ebe17eb48e54aa540d3182b606f8e2c057c70e97d8aabea6736e8a6203b`
both reached `succeeded`; start remained pending until actual agent health and
current writer authority were confirmed. Live gateway health, 17 bundles, and
shell/retained-path checks passed against the controller-created session.
The normal in-container runtime proof and full retained-filesystem verifier
also passed on generation 7, including the original generation-2 Git HEAD.
Sanitized operation evidence lives under `artifacts/qa/vm-lifecycle/`.
Only the synthetic registry record is lifecycle-admitted. Existing workspaces,
including `vm-test`, are not moved or admitted by these tests.

### Firebase owner API

`functions/vmRead.service.js` supplies browser-safe discovery without exposing
the isolated Firestore collections to clients. `GET /workspaces` queries the
authenticated owner, `apiEnabled=true` and `backend=compute-engine`, ordered by
document ID. `limit` defaults to 50 (maximum 100); `nextCursor` is the last
returned workspace ID when another page exists. Pass it as `cursor` for the
next page. Unknown query fields and malformed limits/cursors are rejected.
The dedicated composite index is recorded in `firestore.indexes.json`; only
the `vmRuntimes_v2` index needs creating for this read path.

`GET /workspaces/{id}/sessions` transactionally reads the workspace and current
session. It returns one canonical session (or none when no session is assigned),
never historic generations. Owner/generation mismatch fails closed. Running
status requires lifecycle readiness and matching current live boot leases on
both records. Pending, stopping, stopped and unavailable states remain distinct;
expired access is not presented as running. The projection includes the stable
workspace ID, current session ID, generation, runtime kind, agent UI marker,
and gateway origin only when ready. Credentials, private addresses and raw
session configuration never appear. Signed access URLs still require the
separate access endpoint. These endpoints are the prerequisite for frontend
discovery/subscription integration. The opt-in frontend adapter now consumes
them; see [Frontend architecture](./frontend-architecture.md) for its gate,
supported actions and remaining full-shell validation.
On 2026-11-23 `vmApi_v2` deployed successfully and index `CICAgPj-05MK`
became ready. The live generation-8 owner proof passed listing, canonical
session reads, outsider empty-list/session denial, rejected caller owner
filters, and checks that internal credential/configuration fields are absent.
The existing signed-access checks also passed; temporary Auth and allowlist
changes were restored. Evidence: `artifacts/qa/vm-owner-api/probe.json`.
The targeted index creation command was
`gcloud firestore indexes composite create --project pi-agents-cloud --collection-group=vmRuntimes_v2 --query-scope=collection --field-config=field-path=ownerUid,order=ascending --field-config=field-path=apiEnabled,order=ascending --field-config=field-path=backend,order=ascending --async`.
Future normal index deploys can use the checked-in definition. No existing
Cloud Run handler or Firestore client rule changed for these read endpoints.

`POST /workspaces/{id}/create` accepts only `{requestId, name}` after ordinary
Firebase authentication/app admission. `functions/vmCreation.service.js`
requires an enabled backend-only `vmCreationAdmissions_v2/{id}` document with
the exact `ownerUid`, pinned `runnerImage`, and allocated `gatewayHost`. There
is no general public admission or client-selected infrastructure. The transaction
rejects existing VM and legacy workspace records, consumed admissions, occupied
gateway origins (even disabled routes), and credential/session collisions. It
atomically creates generation 1, independent credentials, a disabled route,
and a pending creation operation while recording the consumed admission.
Identical owner/request/name retries return the original operation; changed
requests cannot allocate another machine. Revoked admission rejects retries.

Creation follows disk -> provision -> route -> health. The disk phase may
create storage only for the initial operation/generation and rejects a disk
with another creation provenance. After that phase is committed, provisioning
sets `allowCreateDisk=false`: loss of the confirmed disk remains an error.
Separate `allowInitializeDisk` authority permits first formatting/marker setup
on that existing, correctly labelled disk and ends once a boot is admitted.
Route publication and completion use the same ownership, health and live-lease
checks as replacement. Provisioning does not delete old compute or copy a
Cloud Run checkpoint. Legacy workspace IDs are explicitly rejected; migration
must use its own freeze/import/cutover protocol.

Creation currently requires an operator-allocated isolated gateway origin and
explicit per-workspace admission. Frontend creation, central configuration
materialization, generalized origin allocation, and migration remain release
gates. No real user workspace is admitted by deploying these handlers.
Deploy with `firebase deploy --only functions:vmApi_v2,functions:vmLifecycleWorker_v2,functions:vmLifecycleReconcile_v2 --project pi-agents-cloud`.
`scripts/vm-owner-api-proof.mjs create` uses the fixed `vm-owner-create-605`
fixture and a `create-proof` gateway revision tag. It exercises real owner
authentication, duplicate/foreign-owner/forged-input rejection, readiness and
agent access, then pauses and deletes only its dedicated disk and registry
records. Completed operation records remain as evidence. A failed or pending
operation is retained for reconciliation, never automatically restarted as a
new workspace. Remove the temporary gateway tag after the proof completes.
Before running it, use `gcloud run services update-traffic mapache-vm-gateway-v2
--region us-central1 --project pi-agents-cloud --update-tags create-proof=REVISION`
with the inspected ready gateway revision. This adds a fixture hostname without
changing the main traffic split. Cleanup uses the same command with
`--remove-tags create-proof` instead of `--update-tags`.
The creation tests cover atomic duplicate reservation, legacy/origin conflicts,
auth-derived ownership, loss of a disk-create response, and a lost provisioning
response after boot admission. Initialization authority is not renewed after
that boot, and missing storage after the disk phase cannot be recreated.
On 2026-11-23 the deployed owner creation proof passed. Operation
`6d2a68c4745c31eeccdf0cc192a157cb34e1c2690fa78c80077f1a778bc96759`
created a healthy generation-1 machine and its isolated signed agent URL
returned the agent page. Duplicate creation reused that operation; unauthorised
owners and caller-supplied infrastructure were rejected. Pause operation
`f244d09e97a6af8da5785a9dc23eb9b331268ca403480ddab12846e9ccf63ba0`
completed before disk/registry cleanup. The original generation-8 fixture's
owner API/access checks also passed afterward, and temporary Auth/allowlist
state was restored. Evidence: `artifacts/qa/vm-owner-api/create.json`.

`functions/vmApi.service.js` backs the separately deployed `vmApi_v2` Function.
It uses the existing `requireUser` Firebase ID-token verification and app
allowlist, then checks workspace ownership and the explicit `apiEnabled` gate
in `vmRuntimes_v2`. It does not accept an owner UID, image, disk, or upstream
address from the caller. All responses use `Cache-Control: no-store`.

| Method/path relative to `vmApi_v2` | Contract |
| --- | --- |
| `GET /workspaces/{id}` | Safe state/generation/session/operation fields; readiness also requires a live lease |
| `POST /workspaces/{id}/access` | `{expectedGeneration}`; owner-scoped signed runner URLs only after lifecycle readiness and matching live session/route authority |
| `POST /workspaces/{id}/start`, `/pause`, `/replace` | `{expectedGeneration, requestId}`; queues the isolated lifecycle operation, with API admission rechecked in its reservation transaction |
| `GET /workspaces/{id}/operations/{operationId}` | Safe progress/error fields only for the same owner and workspace |

Access credentials expire after 15 minutes. The same agent-audience/generation
credential is used for Agent, Shell and Preview URLs so a sibling surface cannot
replace the cookie with an agent-invalid token. The runner's existing 303
bootstrap installs the cookie and removes the token from the URL. Stored browser
signing secrets, shutdown/control credentials and private VM addresses never
appear in owner API responses. The gateway continues checking current
generation/boot/lease on requests and long connections. A signed runner token
is not a Firebase API credential. Chrome URLs are returned only when the
session records that capability. This endpoint does not yet replace the
frontend's legacy API wiring or admit/migrate an existing workspace.

`vmFixtureAuth_v2` is an IAM-private test helper, restricted to the fixed
`vm-proof-owner` and `vm-proof-outsider` identities while the synthetic workspace
is API/lifecycle-admitted. It refuses unrelated or disabled pre-existing Auth
users and cannot mint a caller-selected UID. It uses the API service account's
existing self-signing permission; no operator signing or new IAM grant is
needed. It does not bypass `vmApi_v2`'s app allowlist.

`scripts/vm-owner-api-proof.mjs probe|cycle` exchanges fixture custom tokens
using the [Firebase REST authentication contract](https://firebase.google.com/docs/reference/rest/auth/),
verifies their Firebase identities, and exercises the real owner API. Probe
covers missing/invalid auth, another authenticated owner, forged owner fields,
stale generation, runner-cookie bootstrap, and rejection of runner tokens as API
credentials. Cycle additionally pauses/starts through the owner API, submits each
request twice, checks owner-only operation polling and stopped-access rejection,
then opens the new runner. Tokens stay in memory; evidence under
`artifacts/qa/vm-owner-api/` is sanitized. Cleanup restores temporary API admission
and allowlist entries without removing concurrent unrelated changes, and removes
only synthetic Auth users/profiles created by the probe. A process kill during
the harness itself still requires operator cleanup of its `apiQaRunId` marker.

Deploy only `functions:vmApi_v2,functions:vmFixtureAuth_v2` with explicit
`--project pi-agents-cloud`. These functions run as `mapache-api`; no legacy API,
Hosting rewrite or runner image needs replacement. The fixture signer is private
at IAM; the owner API is network-public but every operation authenticates and
checks ownership/admission. The fixture access probe passed on generation 7.
The owner-driven pause/start cycle then passed from generation 7 to 8, including
duplicate request IDs, cross-owner denial, stale-generation denial, and fresh
agent/shell access. Temporary API admission, allowlist entries, and synthetic
Auth state were restored. Sanitized evidence is in
`artifacts/qa/vm-owner-api/{probe,cycle}.json`. This does not wire the frontend
or migrate existing user workspaces.
Generation 8 also passed the in-container runtime and retained-filesystem
proofs: normal agent readiness, blocked metadata credentials, retained child
HOME/workspace, original dirty Git state, native executable, SQLite, modes,
symlink and locking.

The Compute Engine runtime identity is
`mapache-runner@pi-agents-cloud.iam.gserviceaccount.com`. It receives only the
runtime scopes needed for logging, monitoring, and the runner's approved
read-only image/object access. `mapache-api@pi-agents-cloud.iam.gserviceaccount.com`
owns provisioning and requires `roles/iam.serviceAccountUser` on the runner
identity. The runner cannot create/delete arbitrary Compute Engine resources or
read another workspace's disk. Every instance and disk carries immutable
`mapache-owner-uid`, `mapache-workspace-id`, `mapache-operation-id`, and
`mapache-runtime-provider` labels; cleanup refuses foreign labels.

The canonical health contract remains `/runner/health`, with a functional
agent/readiness check in addition to HTTP readiness. No alternate health path
is part of this design.

## Automation and workspace requests

An external scheduler owns the wake-up: it admits the selected workspace,
starts its VM if stopped, applies the latest managed configuration, waits for
functional readiness, and runs the task on that machine without a browser.
Automation work uses a separate process/runtime identity, read-only source
views where required, and isolated output prefixes. It never attaches an
ordinary writable ext4 disk to two VMs. `http_ticket` requests continue in the
target machine's normal runtime with directional grants, stable source/target
IDs, durable results, and no transfer of target credentials to the caller.

Queue/admission records and generation fencing survive retries, worker loss,
uncertain acknowledgements, and VM replacement. An uncertain external side
effect is not replayed automatically. Pause waits for admitted work according
to the existing exclusion policy; it does not silently kill a scheduled task.
Usage records distinguish active VM time, retained disk, and background work.

## Configuration contract

### Implemented VM auth/environment revisions

`functions/vmConfiguration.service.js` serves owner-authenticated
`GET` and `PATCH /workspaces/{id}/configuration` through `vmApi_v2`.
PATCH requires `expectedGeneration` and `expectedVersion`, plus at least one of
`authSelection: {harness: "pi", providers: {provider: entryId}}` or
`environmentEntryIds: [entryId]`. Only selected owner-private references are
accepted; unknown fields, direct credentials, infrastructure overrides and
stale saves are rejected. Partial saves retain the other selection; explicit
empty selections clear them. Owner-default inheritance is not implemented yet.

The backend-only workspace `machineConfig` stores `desiredVersion`,
`appliedVersion`, `desired`, and `state`. Existing machines without this record
return `unversioned` with their current session references. A save increments
the desired version and returns `pending-restart`, without touching the current
session or starting compute. Saves during lifecycle operations are rejected.
The next start/replacement copies desired references and `configVersion` into
its new session. Healthy, generation/boot/lease-fenced lifecycle completion
records that version as applied; an older completion never replaces newer
desired settings. Applied version means the last healthy launch's selection
revision, not an immutable version of private credential values. Private entry
edits require a process restart and do not change a running process environment.
Deleted selected auth entries fail the versioned session's startup broker call.
Failures remain visible through lifecycle operation status.

The VM workspace editor now supports provider/environment selections and
pending/applied/conflict status; see [Frontend architecture](./frontend-architecture.md).
Remaining machine properties, reusable defaults, hot application, and other central
bindings below remain release work. `node scripts/vm-owner-api-proof.mjs
configuration` checks stopped saves, stale/foreign rejection, pending status,
and applied version after a real pause/start of the fixed synthetic fixture.

Live verification on 2026-11-23 paused generation 10, saved revision 1 while
stopped, rejected a stale save, then started generation 11 and observed revision
1 as applied only after healthy launch. Owner isolation and agent/shell access
also passed; temporary API admission/auth state was restored. Evidence:
`artifacts/qa/vm-owner-api/configuration.json`; start operation:
`1977e861d998de7357678d532769487f66c79888c36fdeed6232cc9d952b7bb3`.
Deployment used `firebase deploy --project pi-agents-cloud --only
functions:vmApi_v2,functions:vmLifecycleWorker_v2,functions:vmLifecycleReconcile_v2,functions:vmRuntimeControl_v2`.
All four Functions are ACTIVE under `mapache-api`; existing Cloud Run functions,
Hosting and runner images were not redeployed.

### Complete crossover target

The control plane stores desired machine configuration separately from the
runtime's applied version. Supported centrally managed selections include Pi
auth/config, environment entries, MCP definitions, Google Workspace bindings,
gateway assignment, resource preset, data-disk growth, idle policy, and
schedule. Secrets stay in backend-owned stores; Firestore/client DTOs contain
IDs and redacted status only. The latest desired revision is applied before Pi
or MCP launch on every start/replacement. A process-restart or VM-recreate
change is reported as pending and is not forced through an active task.

Saving while stopped updates desired state without starting compute. The workspace
edit modal exposes the safe IDs, resource preset, disk growth, description, and
idle policy; it never accepts a disk name, secret, zone, or machine identity.
Stale expected-version saves fail with a conflict. Unmanaged local files/settings
remain on the retained filesystem. Disk shrink, arbitrary disk identity, owner,
zone, and unsupported machine-family transitions are separate migrations, not
ordinary modal edits.

Direct VM uploads use the same short-lived, session-scoped browser access token
as the terminal and browser URLs. The token stays in the in-memory upload URL;
the runner writes bounded chunks to a temporary file and atomically renames the
file into `/uploads` after size/checksum and create-only checks pass.

## Migration and recovery state machines

### Read-only registry and published-manifest inventory

Run `node scripts/vm-migration-inventory.mjs --project pi-agents-cloud` to
paginate the legacy workspace/session registries and the isolated VM registry.
`--workspace <id>` restricts legacy inspection; `--output <new-local-file>`
chooses a create-only report. The command never pauses, writes Firestore/GCS,
provisions resources, or switches authority. It downloads only published
checkpoint manifests, capped at 16 MiB each, using the observed object generation
and checking the published checksum, identity, schema and file descriptors.
Console output contains aggregate counts; the local report has mode `0600` and
contains stable workspace/owner IDs, capture/object generations, format counts,
validation categories and blockers, without file names or credential values.

`scripts/lib/vm-migration-inventory.mjs` recognizes per-file, workspace-bundle-v1,
large-file-v1 and symlink entries; classifies Git/shared-tree references,
never-started, active and failed-stop records; and excludes SSH and N64 from
automatic migration. It does not equate a published manifest with verified
payload recovery. Shared trees, flat prefixes and legacy internal spellings,
HOME/browser archives, owner tools, uploads/private Git, orphan captures and
live-only state still need deeper inventory. Every record explicitly remains
unready for cutover. The byte count covers only readable manifests; the disk
lower bound uses 30% headroom and a 64 GiB floor, while the actual disk size,
downtime and full cost estimates remain unknown. Registry reads are not an
atomic snapshot and must be repeated under migration admission before cutover.

Tests: `node --test scripts/lib/vm-migration-inventory.test.mjs`. This maintenance
command does not require Function or runner deployment. The existing migration
coordinator is not invoked by the dry run.

For bounded payload verification, add `--workspace <id> --verify-bytes <bytes>`.
This opt-in requires a single workspace and an explicit total download budget.
`scripts/lib/vm-checkpoint-payloads.mjs` streams generation-pinned ordinary and
large-file-v1 objects; it reads each bundle once, verifies its whole-object hash
and every referenced file slice across stream chunks, and validates captured
symlink targets. Namespace, descriptor, size, checksum and budget failures remain
explicit blockers. No payload bytes or filenames are written into the report;
an aggregate digest records the verified object identities/generations/hashes.
The manifest integrity result and payload result are separate fields. Passing
payload checks removes only the checkpoint-payload blocker, never the remaining
archive/live-state checks or the cutover gate. Run both inventory and payload
tests with `node --test scripts/lib/vm-migration-inventory.test.mjs
scripts/lib/vm-checkpoint-payloads.test.mjs`.

On 2026-11-23, `vm-test` payload verification with a 100 MiB budget checked 36
agent objects (1,236,845 bytes) and eight workspace objects (29,047 bytes).
All matched their recorded sizes and hashes. Evidence:
`artifacts/qa/vm-migration-inventory/vm-test-payloads-verified.json` (local mode 0600).
This is published-checkpoint recovery evidence, not a complete-machine export,
archive verification, or migration. No cloud writes or deployments were needed.

`--workspace <id> --list-objects <limit>` adds bounded, paginated current-object
metadata inventory (maximum 100,000 entries). Provide `--default-bucket` and
`--tools-bucket` from verified deployment configuration when needed; the tool
does not silently guess owner-tool storage. `scripts/lib/vm-storage-metadata.mjs`
derives workspace, custom HOME, historical session, shared-tree, browser seed,
uploads and owner-hashed tool candidates, including `.mapahce-internal` legacy
spellings. It deduplicates identical prefixes, appends a slash to each listing
scope, and reports access failures, malformed metadata, cursor loops and budget
exhaustion explicitly. Source listings can overlap: their object/byte totals are
not additive. Reports retain category counts, metadata evidence digests and
unresolved descriptors, not filenames. No archives or tools are downloaded by
this option. Current browser pointers are read within a 64 KiB bound and checked
with the runner's descriptor validator against the workspace, bucket and pinned
archive metadata; this is not archive hash or extraction validation.

The 2026-11-23 `vm-test` scan completed 584 listing entries across overlapping
sources within a 10,000-entry limit. Its workspace prefix contained 568 objects;
the owner-tools source contained three non-marker files totaling 65,988 bytes.
Neither current nor legacy HOME prefix contained an archive, which does not
prove no live-only HOME state existed. The current browser seed selected an
existing 48,086,059-byte archive captured at `2026-11-23T19:59:11.882Z` and its
descriptor/generation/size checks passed. Archive content, tool payloads and
source authority still require verification. Evidence:
`artifacts/qa/vm-migration-inventory/vm-test-storage-verified.json` (0600).
Run metadata tests with `node --test scripts/lib/vm-storage-metadata.test.mjs`.
No production resources or data were changed.

Add `--verify-archive-bytes <total-compressed-budget>` and
`--archive-expanded-bytes <per-archive-limit>` together with `--list-objects`
to verify current browser seed payloads. `scripts/lib/vm-archive-verifier.mjs`
streams the generation-pinned object through SHA-256, gzip and `tar-stream`,
checking the descriptor size/hash, expansion budget, 100,000-entry limit,
member paths, supported types, duplicate members and link layout. It drains
file bodies without extracting files or logging member names. Descriptor and
archive results stay separate; neither implies a successful Chrome restore or
cutover readiness. Tests: `node --test scripts/lib/vm-archive-verifier.test.mjs
scripts/lib/vm-storage-metadata.test.mjs`.

The selected `vm-test` browser archive passed on 2026-11-23: 48,086,059 compressed
bytes, 104,847,360 expanded tar bytes, 119 directories and 324 files (104,542,504
file bytes). Evidence: `artifacts/qa/vm-migration-inventory/vm-test-archive.json`
(0600). No extraction or browser launch was performed. Separate read-only
version and soft-delete listings found zero objects under both HOME prefix
spellings; bucket versioning was disabled and soft-delete retention was seven
days. Evidence: `artifacts/qa/vm-migration-inventory/vm-test-home-history.json`.
The recorded Cloud Run service no longer exists. These observations leave full
HOME recovery unproven; they do not establish that the workspace never had
live-only HOME files. No Function, runner or Hosting deployment is needed for
this maintenance-tool change.

The 2026-11-23 read-only scan accounted for 85 legacy workspace records and one
isolated VM fixture: 27 inactive, 57 with no session records and one excluded SSH
workspace. Of the published sources inspected, 41 manifests passed integrity and
identity checks, 15 referenced missing objects, one had an identity/schema
mismatch, and one had an invalid reference; one shared tree remained unread.
These counts describe references, not distinct recoverable machines. Valid
manifests described 4,566,849,928 logical bytes, excluding unverified external
state. The requested `vm-test` workspace had readable agent/workspace manifests
but unverified payloads and archives; it was not migrated. Evidence is the local
mode-0600 `artifacts/qa/vm-migration-inventory/registry-final.json`. No source or
cloud resource changed. Full #614 inventory and all cutover gates remain open.

Inventory is read-only and accounts for blank, GitHub, shared-storage,
checkpoint, bundle-v1, HOME archive, owner-tool, large-file-v1, running, and
failed-stop workspaces. SSH-backed machines are reported unsupported for
automatic migration. The planned complete importer writes a new owned disk using bounded
streams, a journal, source generations, create-only destination writes, and a
ready marker. It never changes authority or deletes the source.

The first importer component, `scripts/lib/vm-import-stage.mjs`, stages actual
object bytes into a private local directory. An immutable identity binds the
owner, workspace, operation and source-plan digest. Each transfer journals its
bucket/object/generation/size/hash, streams to a unique partial file, checks
size/hash, syncs it and publishes with a create-only hard link. Resume rehashes
existing objects rather than trusting the journal. A crash between publication
and return is safe to retry; partial files from a killed process remain
unpublished and are not reused. No source data is changed.

This component requires a trusted destination disk with exclusive maintenance
access; it does not prove Compute ownership, enforce source-plan membership,
assemble filesystem paths/modes/links, or emit a disk-ready marker. An interruption
before initial identity publication fails closed and requires inspection of that
uninitialized staging directory. Cleanup of abandoned partial files and disk
capacity checks remain coordinator work. Tests include a real child-process
SIGKILL during transfer, content/mode revalidation, identity mismatches, generation
changes, corrupt/truncated streams and symlink refusal. Injected source failures
are covered; real destination ENOSPC and full-disk recovery are not yet proven.
Run `node --test scripts/lib/vm-import-stage.test.mjs`. This local maintenance
component needs no Function, Hosting or runner deployment.

`scripts/lib/vm-checkpoint-import.mjs` adapts published agent and workspace
checkpoints to that transfer stage. Planning verifies manifest bytes/hash and
the expected workspace/session/runtime-generation/boot/prefix/bucket identity,
then pins each unique payload's current object generation. The trusted caller
must obtain the expected identity from owned registry records. The resulting
private plan records file modes, paths, tombstones, source generations and bundle
offsets. Its digest is bound into the staging operation. Path/ancestor conflicts,
unsupported file kinds/modes, unsafe links and overlapping agent destinations
fail before payload staging. Existing payload validators are shared through
`checkpointPayloadGroups` rather than duplicated.

Staging downloads each unique ordinary, bundle or large-file-v1 object once,
reuses verified local bytes on retry, and checks every bundle slice before
returning the planned entries. Deferred large files contain their real bytes,
not pointer JSON. Agent paths map to retained `agent/sessions`, `agent/pi`,
`agent/ui` and `agent/ui/uploads`; workspace paths map to `workspace`.
The adapter itself does not install files, apply modes/links/tombstones, validate
application-level history/settings, recover absent directories, or select
authority among multiple source formats. The plan contains private filenames;
keep it in mode-0600 local evidence, never broad console logs.

On 2026-11-23, a read-only cloud/local-write proof staged the real `vm-test`
published captures: 36 agent objects/entries (1,236,845 bytes) and eight workspace
objects/entries (29,047 bytes). Evidence and private plans are under
`artifacts/qa/vm-checkpoint-import/`, with summary `result.json`. No source,
provider descriptor, VM, disk or production deployment changed. Fixture tests
cover bundle slices, real deferred bytes, executable-mode metadata, agent path
mapping, resume without remote reads, and identity/path/mode/hash/budget failures:
`node --test scripts/lib/vm-checkpoint-import.test.mjs`.

`scripts/lib/vm-import-tree.mjs` assembles a selected checkpoint under its private
stage's `tree/`, using the plan's retained-disk path mappings. It streams file
slices with a 64 KiB buffer, verifies each hash, preserves file permission bits,
syncs files/directories and publishes files without replacing existing targets.
Safe captured symlinks are recreated; implied parent directories use mode 0700.
It records the exact plan before writes, verifies existing entries on resume,
and rejects unknown files, changed bytes/modes and symlinked parent directories.
A final full-tree comparison precedes `checkpoint-tree.json`. That receipt is
evidence for the selected checkpoint only: it is neither the VM disk marker nor
cutover approval, and must never replace revalidation of a mutable destination.

Fixture validation executes a restored tool through its symlink and kills a
real child process after file publication but before completion; retry verifies
the published file and finishes the remaining tree. The real `vm-test` local
proof assembled 36 agent files/10 implied directories and eight workspace
files/10 implied directories, using only previously staged bytes (no network).
Private summary: `artifacts/qa/vm-checkpoint-import/tree-result.json`. No agents
were launched and no cloud data/resources changed. Application validation,
explicit empty directories/directory modes from other source formats, archive
and shared-tree merging, tombstone reconciliation, HOME recovery and full-disk
capacity/error handling remain required before machine import is complete.

`scripts/lib/vm-archive-import.mjs` now stages a generation-pinned HOME or
browser archive and publishes a private `archive-plan.json`. The source-plan
identity binds owner/workspace, the full archive descriptor and the destination
(`home` or `browser/profile`); changing that selection cannot reuse the operation.
The archive verifier's opt-in `includeManifest` mode computes file hashes while
streaming and records explicit directories/modes, original symlink text and
hard links resolved to their captured file. Ordinary inventory output still
omits all member names. Resume rehashes the local archive and does not download
it again when its bytes match.

Import planning rejects unsupported special permission bits, conflicting modes
on one hard-linked inode, dangling/cyclic links, and semantic escapes through
symlink chains (including `..` after following a link). Modes 0000–0777 are
represented; applying unreadable modes requires the eventual privileged
maintenance importer. This is stronger than integrity-only archive inspection.
The stage retains the compressed bytes and per-member plan, without extracting
files, changing ownership, assembling a complete machine or approving cutover.
Source ownership/authority selection remains the coordinator's responsibility.

The real `vm-test` browser archive passed these stricter rules on 2026-11-23:
48,086,059 compressed bytes, 104,847,360 expanded tar bytes, 119 directories and
324 files. Private local evidence is under
`artifacts/qa/vm-browser-archive-import/`; `result.json` contains only descriptor
metadata and aggregate counts. No cloud writes or deployments were needed.
Tests: `node --test scripts/lib/vm-archive-import.test.mjs
scripts/lib/vm-archive-verifier.test.mjs`.

`scripts/lib/vm-archive-tree.mjs` extracts that verified archive into its private
`tree/`. It first revalidates the staged archive and compares its complete member
plan, then streams file bodies through size/hash checks into synced temporary
files and publishes them without replacing existing paths. It recreates hard
links only after regular files, verifies matching device/inode identity, and
preserves original symlink text. Explicit empty directories survive; directory
permissions are applied from descendants upward after file/link installation.
Implicit parents use mode 0700. Restrictive modes require sufficient maintenance
process privileges; the importer never silently loosens final permissions.

Resume validates existing contents and rejects unknown entries. Before a final
receipt exists, directories can have their temporary 0700 mode or the planned
mode; afterward their exact final mode is required. The completed tree is fully
compared before a private `archive-tree.json` receipt is published. Like the
checkpoint receipt, it is not a VM disk-ready marker or cutover permission.
The caller must retain exclusive maintenance access and revalidate mutable
destinations before use. Abandoned temporary files from process death remain
outside the assembled tree for later coordinator cleanup.

Fixture extraction passed a real SIGKILL after file publication and resumed
successfully. Tests verify empty directory modes, hardlink inodes, symlink text,
and refusal of changed directory modes or hardlinks replaced by equal-content
copies. Local `vm-test` extraction restored and verified 324 files and 120
directories (119 archived plus one implied parent), without network reads or
agent/browser launch. Evidence:
`artifacts/qa/vm-browser-archive-import/tree-result.json`. Browser/SQLite runtime
validation, HOME recovery, source merging and full-machine cutover are still
outstanding. No Function, Hosting or runner deployment is needed for this tool.

The isolated local browser proof is documented in
[restored profile checks](../e2e/qa/migration/vm-browser-profile-checks.md) and
implemented by `scripts/vm-browser-profile-proof.mjs`. It uses an owned Chrome
DevTools pipe inside a new user/network namespace with no external interfaces,
operating only on a disposable copy. On 2026-11-23, Chrome 148.0.7778.178 opened
the restored profile and rendered the synthetic test page, then exited with
code zero. All 20 existing SQLite databases passed before launch; all 22 present
after close passed. The source filesystem fingerprint was unchanged, and the
owned Chrome process/profile were cleaned up. Private result:
`artifacts/qa/vm-browser-profile-proof/result.json`.
This does not establish VM/noVNC behavior, runner-version compatibility,
encrypted credential recovery or external login validity. No cloud deployment
or source/provider change occurred.

`scripts/lib/vm-owner-tools-import.mjs` captures the existing
`owner-gcsfuse-v1` tools source. It derives the owner-hashed prefix through the
backend's `userToolsStorageForOwner`, requires a complete bounded listing and
an explicit byte budget, and pins each object generation. File bytes are checked
against available GCS MD5/CRC32C values while computing SHA-256 for resumable
local staging. It rejects namespace/path conflicts, missing checksums, changed
generations, nonempty directory markers and unsupported custom metadata before
accepting a plan. The observed `gcsfuse_mtime` string is retained without losing
its precision; applying it is still assembly work.

The old mount explicitly uses `file-mode=0755` and `dir-mode=0755`. Accordingly,
plans map both explicit markers and implicit directories to retained
`home/.local` with those modes instead of guessing from file names. A capture
is not a consistent snapshot: other owner workspaces can still write this
shared source, so final writer reconciliation remains necessary. Staging does
not alter owner-wide sharing or choose how this source merges with a HOME
archive.

`assembleOwnerToolsTree` uses the checkpoint tree assembler to place staged
files and directories under the private stage's `tree/home/.local`. The
assembler binds the output to the staged plan, uses create-only publication,
and checks contents and modes before writing `owner-tools-tree.json`.
Directories start at 0700 during assembly and receive their planned 0755
mode before final verification. The stage itself stays private. Parent
directories outside the captured tools tree use 0700. Source timestamps
remain in the plan and are not applied. The receipt covers this source tree
only. Combining it with other sources still requires a conflict policy and
final writer reconciliation.

The real `vm-test` owner-tools proof verified and staged three files totaling
65,988 bytes and captured five empty directory markers on 2026-11-23. Private
evidence: `artifacts/qa/vm-owner-tools-import/result.json` and
`stage/owner-tools-plan.json`. The local assembly proof verified all three
files, five recorded directories and the implied HOME directory without
remote reads. Its receipt is `artifacts/qa/vm-owner-tools-import/tree-result.json`.
Tests: `node --test scripts/lib/vm-owner-tools-import.test.mjs` (owner identity,
listing/budget/metadata refusal, CRC-only sources, generation/checksum failure,
fixed mount modes, timestamps, interrupted assembly, revalidation and
resume without remote reads).

Cutover is:

```text
preflight -> reserve/freeze -> quiesce writers -> final capture
          -> import/verify -> compare-and-swap authority
          -> validate VM -> release admission
```

`vmMigrationPreflight_v2` is a read-only IAM-private operator endpoint
for the first step. Pass the expected `workspaceId` and `ownerUid` as GET
query parameters. A Firestore read-only transaction observes the source
workspace, destination registry record, up to 500 source sessions, and up
to 100 queued or active automation runs. The response includes counts,
blocker codes, the source generation and a digest of the observed document
paths and update times. It returns 404 for a mismatched owner. A truncated
inventory or an uncertain session status blocks progress. The digest is
diagnostic evidence from one observation, with no writer admission or
authority attached to it.

Pass `checkCompute=1` to observe the recorded Cloud Run services and
unfinished provisioning operations through the provider API. The read is
bounded to 96 distinct references. It checks the original and deterministic
service names, rejects foreign or malformed references, and treats an unknown
operation result as a blocker. The endpoint reads Firestore again after the
provider calls and invalidates the observation if the source digest changed.
It reports counts and a provider observation digest without service names or
provider error payloads. `recordedComputeClear` covers only recorded
references. Orphan discovery, confirmed runner quiesce, and Storage authority
still gate the final capture.

The same option returns a separate `compute.discovery` result. It scans
paginated Cloud Run service templates in the configured default and recorded
regions, up to four regions and five pages per region. It checks workspace
identity in runner environment fields and automation labels. It also flags
another service pointing to the exact workspace bucket and prefix. The code
keeps provider responses in memory and reports only counts, region names,
blocker codes and a digest. Repeated cursors, missing runner identity,
provider errors and capped scans block a clear result. The scan covers the
current service templates in those regions. Other regions, tagged historical
revisions, and aliases outside the matched prefix still require reconciliation.
See the [Cloud Run services list API](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/list).

Pass `checkStorage=1` to compare two paginated listings of the
workspace's owned prefix on the default bucket. The observer uses the same
prefix validator as the reservation coordinator. A conflicting bucket or
prefix in session metadata blocks the observation. Each pass covers up to
3,000 live objects and hashes sorted names, generations, metagenerations,
sizes and CRC32C metadata. The response exposes digests and counts.
Duplicate objects, repeated page cursors and exceeded limits block the
result. Changes in the Firestore observation invalidate the comparison.

When the workspace declares persistent HOME, the check reports a missing
archive if the configured object is absent in both internal spellings.
A stable listing can still have this blocker. The initial `vm-test`
provider check returned identical digests for 568 live objects and
`legacy_persistent_home_archive_missing`. This is metadata evidence for
the observed prefix. Final capture still requires verified writer quiesce,
generation-pinned content validation and coverage of the remaining sources.

The endpoint reports both `readyForFreeze` and `readyForCutover` as false.
The existing `sharedStorageMigration` state is checked by Cloud Run
session reservation and automation enqueue, but those checks do not fence
already queued workers or dispatch to an existing session. Workspace
deletion and other conflicting operations need the same transactional
admission contract. The checked-in Firestore rules protect backend-owned
runtime authority, source descriptors and storage pointers on client create
and update. They use the presence of a backend-only document at
`vmMigrationFences_v2/{workspaceId}` to reject direct client creates,
updates and deletes while fenced, including when the workspace document is
missing. Direct client deletion of a workspace with a runtime provider
descriptor is also denied so deletion goes through the lifecycle API.
Ordinary unfenced workspace metadata edits and legacy descriptor-free
deletes remain available. The shipped browser uses the API for workspace
creation and deletion.

The emulator verifies owner metadata edits, denial of direct provider and
source edits, privacy of the fence document, denial under an empty fence,
and behavior after fence release. These rule changes are in the draft;
production rollout must be coordinated with the backend writer checks.
Rules apply to Firebase clients. Admin SDK operations, existing session
dispatch, queued workers and signed Storage writes need their own admission
and drain checks.

The checked-in server admission paths use `functions/vmMigrationFence.helpers.js`
to read the backend-only fence in the same Firestore transaction as new
session reservation, resize enqueue/claim, automation enqueue/admission/
provisioning, fresh dispatch to an existing runner, or the initial workspace
deletion tombstone. A fence blocks these transitions without consuming the
queued job or initiating deletion. Existing request claims can still be observed
and reconciled. The coordinator must account for work committed before the
fence, including resumed deletions and already submitted cloud operations.
Legacy workspace listing in `functions/workspace.service.js` continues to
return fenced workspaces without repairing their canonical session pointers.
Unfenced repairs check the workspace, fence and candidate sessions in one
transaction. Workspace rename and resource edits, including propagation to
the canonical session, and MCP config saves use the same admission check.
Legacy desired configuration changes and applied-version callbacks in
`functions/machineConfiguration.service.js` also read the fence before
writing. An older applied callback cannot lower the recorded applied version.
The emulator exercises these paths while reserved and after abort.
The legacy scheduler in `functions/workspaceRuntimeSchedule.service.js`
checks the fence before claiming a lease or saving runtime policy and
long-running settings. A previous lease can release under the fence and
leaves schedule status and errors alone. Scheduled stop admission in
`functions/sessionLifecycle.service.js` checks the fence in the transaction
that records the session transition, as scheduled start and restart already
do. Manual stop remains available to drain admitted runners. Preflight
reports `legacy_runtime_schedule_lease_unresolved` until the lease is
released or reconciled. The scheduler TTL can permit another tick in normal
operation and cannot prove that the first worker finished.
Direct legacy restart and resize now check the fence in the same transaction
that records the lifecycle transition, before a Cloud Run patch or a stop for
recreation. The update also rejects a changed session state or operation
identity. Legacy sync and Git reservations consult the same fence. Cloud Run
provisioning with an operation ID checks it when claiming a fresh create.
It can still poll an operation already submitted before the fence. The
preflight includes the fence in its observation digest and reports
unfinished provisioning or resize records even if the session says stopped.
Runtime-side writers and operations without a durable claim still require
provider reconciliation and confirmed quiesce before migration.
Only the updated read-only preflight is deployed in this increment. The
legacy server guards and Firestore rules require coordinated rollout and do
not yet authorize creating production fences.

The draft legacy upload issuer now records its intent under
`vmLegacyUploads_v2/{workspaceId}/pending/{operationId}` in a transaction
that checks the fence, owner, workspace state and current Storage
descriptor. Before returning a resumable session URI, it replaces the
intent with a per-workspace drain deadline. The URI itself never goes
into Firestore. The deadline is set to seven days plus five minutes after
the provider response, and concurrent issuances can only extend it. A
failed or ambiguous provider call leaves the intent so an operator can
reconcile it. The preflight distinguishes unresolved issuance from an
active drain deadline.

Cloud Storage resumable session URIs remain usable for up to one week.
The current legacy deployment can still issue untracked URIs. An empty
ledger is insufficient evidence that there are no active upload sessions.
Disabling all old issuance paths and proving that earlier sessions have
expired or been canceled remains part of the final capture gate. Direct
Firebase Storage SDK writes have a separate draft guard in `storage.rules`.
An Admin-only document at
`vmMigrationStorageFences_v2/{bucket}/owners/{uid}/prefixes/{workspaceKey}`
blocks client writes and deletes at `workspaces/{uid}/{workspaceKey}/...`
while preserving owner reads and writes in sibling prefixes. The key is the
actual Storage path segment, which can differ from the Firestore workspace
ID. Before creating a fence, the coordinator must verify that the bucket and
prefix uniquely identify the source and account for custom paths and aliases.
The rules need cross-service Firestore access and a coordinated rollout.
Other GCS writers require their own quiesce and access revocation checks.
[Cloud Storage resumable uploads](https://docs.cloud.google.com/storage/docs/resumable-uploads)

Legacy shared-storage reconciliation in
`functions/workspaceStorageMigration.service.js` checks the workspace fence
at entry and in the transactions that publish a descriptor or error.
`functions/workspaceSharedStorage.service.js` also reserves an Admin-only
claim at `vmLegacySharedStorage_v2/{workspaceId}/pending/{operationId}`
before repairing bucket IAM. The transaction checks the fence, owner and
storage identity. A successful provider response clears the claim. An
ambiguous failure or an interrupted worker leaves the claim for
reconciliation. Preflight reports `legacy_shared_storage_iam_unresolved`
while any claim remains, and the coordinator can reserve a fence but cannot
record quiesce. Deployed legacy handlers may still have untracked work until
the staged guards roll out and existing requests drain. A shared-tree
source still requires its own Storage scope and writer-reconciliation proof.

The legacy `scripts/workspace-storage-recovery.mjs` CLI uses
`functions/workspaceStorageBackup.service.js`. The service checks the VM
fence when reserving maintenance, starting a restore or tree recovery, and
publishing the recovery pointer. Provider writes are serialized by a claim
under `workspaceStorageRecoveryReservations/{workspaceId}/pending`.
The claim survives interrupted or ambiguous writes, and release refuses
while a claim remains. Preflight blocks quiesce for a pending claim or
any unreleased reservation, including an expired reservation. A matching
expired reservation can be explicitly released after confirming the prior
process and its Storage requests are settled. If a claim remains, reconcile
its provider writes before removing the claim through trusted maintenance
access. Old CLI copies without the fence and claim checks must also drain
before a production operator can attest writer quiescence.

The Firestore/Storage emulator test runs with
`firebase emulators:exec --only firestore,storage --project mapache-rules-test 'node storage.rules.test.cjs && node firestore.rules.test.cjs'`.
It covers owner reads under a fence, refusal of fenced creates/replacements/
deletes, a neighboring unfenced prefix, foreign access and release. Production
changes for this increment are limited to the read-only preflight.

Compute absence and final Storage generations need separate verification after
quiesce. Do not reuse the legacy migration record as an authoritative
VM cutover lock.

The reservation coordinator in `functions/vmMigrationCoordinator.service.js`
recomputes the same preflight inside a write transaction. With a verified
admission policy, it creates an operation record, the workspace fence, and
the Storage-prefix fence atomically. It checks the owner, observation digest,
destination absence, and the canonical bucket/prefix against an owner registry
scan. It refuses ambiguous prefixes, custom external HOME storage and shared
trees that need a separately proven fence. Drain blockers such as in-flight
uploads remain blockers for final capture after the reservation.

Operation IDs are scoped to a workspace. Repeating the same request returns
the existing operation. A different observation cannot reuse its ID.
Aborting a reserved, quiesced or prefix-captured operation atomically releases both fences only if they
still belong to it, the source scope and generation are unchanged, and no
VM authority exists. The reservation, quiesce and abort methods require a
trusted admission policy. Production Functions expose the existing preflight
and IAM-private GET status at `vmMigrationStatus_v2`, which takes
`workspaceId`, `ownerUid` and `operationId`. The coordinator's mutation
methods have no production entry point.

The coordinator records a `quiesced` receipt only when the exact operation
owns both fences and the source scope still matches the reservation. It
checks the Firestore writer inventory, bounded Compute observation and
regional discovery, and two matching Storage generation listings with no
blockers. Before committing the receipt, it re-reads the Firestore inventory
and compares the operation and both fence versions. If the source generation
changes after reservation, resolve that authority change before proceeding.
Successful retries return the existing timestamped receipt.

A quiesce policy must attest rollout of all writer fences and verify drainage
outside those bounded observations, including existing runner operations,
regions and revisions outside the scan, previously issued upload URIs, and
other Storage writers.

The internal `capturePrefix` transition rechecks the Firestore state and
versions of both fences against the quiesce receipt. It repeats Compute
discovery and the Storage generation comparison. Only matching evidence
can commit. It writes the ordered object inventory in chunks under the
operation's private `prefixInventory` subcollection and updates the phase
to `prefix-captured` in the same transaction. The inventory identifies the
exact name, generation, metageneration, length and CRC32C of each object.
The capture is capped at 3,000 objects and 4 MiB of serialized chunk data.
The internal `getCapturedPrefix` reader checks the record, source and
fences and reconstructs the inventory only when it hashes to the receipt.
An abort leaves the chunks for operator inspection and disables this
reader for the operation.

Status exposes only the timestamp and count for the captured prefix and
continues to report `readyForCutover=false`. The inventory pins the owned
prefix. Source data outside it, including owner-wide tools and unsupported
shared trees, requires separate authority and reconciliation.

The operator CLI stages one published agent or workspace checkpoint against
the captured prefix and writes a private tree, plan and verification receipt.

```bash
node scripts/vm-import-captured-checkpoint.mjs --project pi-agents-cloud \
  --workspace WORKSPACE_ID --owner OWNER_UID --operation OPERATION_ID \
  --kind workspace --root /absolute/private/workspace-stage --max-bytes 104857600
```

Use `--kind agent` with a separate stage for the agent checkpoint. The
CLI reads the captured inventory, published pointer and main-session IDs
under the same Firestore checks. Both the manifest and its payloads must
belong to the captured bucket and prefix and use the generations and
metadata in that inventory. Each payload is checked against its manifest
hash and bundle slices are verified. A missing generation, different
metageneration, superseded checkpoint or inactive capture blocks the
result. Generations outside the installed SDK's safe integer range are
refused before a request. The CLI rechecks the operation after local
assembly. A local tree receipt records byte verification and does not
authorize disk import or cutover.

The captured archive CLI stages HOME or the browser profile against the
same operation. Use a separate private stage for each archive.

```bash
node scripts/vm-import-captured-archive.mjs --project pi-agents-cloud \
  --workspace WORKSPACE_ID --owner OWNER_UID --operation OPERATION_ID \
  --kind home --root /absolute/private/home-stage \
  --max-compressed-bytes 104857600 --max-expanded-bytes 1073741824 --max-entries 100000
```

HOME follows the frozen workspace policy, including the canonical and
historical internal-directory spellings. Browser recovery uses a pinned
canonical-session seed, then a captured current seed descriptor, then the
legacy archive when no seed is selected. Every object and pointer must come
from the captured prefix at its recorded generation. Selected seeds are
verified against their published hash. For older archives without a
published hash, the CLI streams one pinned download, verifies captured
CRC32C and computes the SHA-256 for the stage. The archive plan binds that
digest to the operation and capture. Extraction enforces expanded-byte
and entry limits, then rechecks source authority. For legacy archives the
stage needs room for both the temporary compressed download and the
verified copy during import.

The checkpoint and archive trees can be merged locally or installed on a
retained disk using the same captured-prefix provenance. Owner tools and
other legacy formats need their own binding before a complete workspace
can switch authority. Import verification and authority switching are
separate coordinator transitions.

Emulator tests exercise reservation, quiesce, prefix capture and release with real Firestore
transactions. They cover competing requests, stale observations, duplicate
retries, alias conflicts, incomplete provider observations, blocked Storage,
capture corruption and refusal to release after authority changes.

```bash
firebase emulators:exec --only firestore --project demo-mapache-cutover \
  'node --test functions/vmMigrationCoordinator.service.test.js'
```

Deploy the isolated operator endpoints with
`firebase deploy --only functions:vmMigrationPreflight_v2,functions:vmMigrationStatus_v2 --project pi-agents-cloud`.
The original preflight deployment succeeded on 2026-11-23 with the
`mapache-api` service account. The live
`vm-test` check returned one stopped session and zero queued/active
automation runs. Anonymous access returned 403, a mismatched owner
returned 404, and POST returned 405. The source document update time was
unchanged and no destination record was created. Local evidence is
`artifacts/qa/vm-migration-preflight/result.json`.

Every transition is resumable and records the source generation, destination
disk/generation, operation owner, progress, and blocker. Before destination
writes, rollback restores source authority only after every destination writer
stops. After destination writes, rollback requires a verified reverse export or
remains visibly blocked; flipping back to an old checkpoint is never accepted.
Sources and backups remain through the rollback window. No source is deleted
because an import job merely reported success.

Backups are separate from retained storage. The selected initial policy is
daily crash-consistent snapshots with a 14-day retention target, plus an
operator-rehearsed restore to a fresh disk/VM. Application-consistent captures
are required before a migration cutover or any operation that claims a tighter
RPO. Cleanup first fences admissions, confirms compute absence and disk
detachment, and only then applies the explicit tombstone/backup policy.

The read-only inventory's `--list-objects` mode also checks shared-tree bucket
ownership, HNS layout, generation-ready marker and original import control
identity through `scripts/lib/vm-shared-tree-authority.mjs`. It does not invoke
legacy helpers that repair IAM. Missing/denied buckets, invalid provenance and
missing control records remain distinct outcomes; verified original provenance
does not verify current mutable objects or HNS folders and never clears cutover
blockers. The handoff scan of the sole shared-tree record returned
`shared_bucket_not_found`. Private evidence:
`artifacts/qa/vm-shared-tree-inventory/handoff.json`. Four focused tests cover
valid provenance, refusal paths and preservation of migration blockers.

### Merge selected recovery trees

Run `node scripts/vm-merge-import.mjs <private-config.json>` after the
individual checkpoint, archive and owner-tool stages have assembled receipts.
The config takes an absolute destination stage `root`, the `ownerUid`,
`workspaceId`, an `operationId`, a logical file byte budget `maxBytes`, and
an ordered `sources` array. Each source has a `kind` of `checkpoint`,
`archive` or `owner-tools` and an absolute private stage `root`.
Checkpoint sources also specify the original `planFile`. Use an exclusively
managed stage and keep the configuration and recovered files private.

The merger verifies the selected source files against the plans, rejects
ownership mismatches and path conflicts before writing, and preserves
supported modes, empty directories, symlinks and hard links. Explicit
directories can overlap only when their modes match. A file collision or
another source's tombstone requires explicit reconciliation. Both staged
objects and the assembled tree consume disk space, so the logical byte
budget alone does not establish capacity. Keep the same source order and
operation ID to resume. The receipt `merged-tree.json` covers the selected
plans and their assembled paths. Eligibility and missing-source decisions
remain with the migration coordinator.

The local `vm-test` exercise combined its published agent and workspace
checkpoints, browser archive and owner tools into 371 files and 146 directories
under `artifacts/qa/vm-merged-import/`. Reopening the same operation verified
the same receipt. Full HOME recovery remains unproven.

### Install selected sources on a retained disk

`scripts/vm-import-retained-disk.mjs` provides the maintenance-host path
for an exclusively attached, initialized retained disk. Run it with the
runner stopped and with exclusive writer access to the disk. Use a private
JSON config with the merge inputs above, replacing `root` with an absolute
`mountRoot` and adding the disk's original `generation`. The operation ID
must match the disk marker written during provisioning.

```bash
flock -n "$IMPORT_MOUNT" node scripts/vm-import-retained-disk.mjs "$IMPORT_CONFIG"
```

The importer checks Linux mount metadata for a writable ext4 filesystem
mounted at its root, rejects aliases and nested mounts in the maintenance
namespace, and matches its block device to the workspace's GCE by-id device.
It also checks the marker's owner, workspace, generation and operation.
A fresh import accepts the disk marker, ext4's lost+found directory, and
its own private staging directory. It refuses preexisting runtime data.

The first pass estimates free blocks and inodes for staging plus assembly.
An allocation failure remains possible, especially on retry. The importer
records its intent before moving each verified runtime directory to its
final name on the same disk. On retry, directories already moved must
match the plan, and unmoved directories must still be present in staging.
It publishes `.mapache-import-stage/disk-import-receipt.json` after the
final verification. Staged objects remain on disk for inspection and
consume extra capacity. The caller still owns Compute attachment and
writer coordination, missing-source decisions, and boot validation.

For a captured import, set `prefixCapture` in the merge or disk config to
`{operationId, sourceGeneration, sha256}` from the coordinator's verified
capture. The destination `operationId` in the disk config identifies the
disk provisioning marker and can differ from the source capture operation.
Every selected source must match the capture and declare a distinct agent,
workspace, HOME or browser component. Captured archive receipts also hash
the member plan. Rebuild archives staged before that receipt field existed
in a fresh private stage. The merger refuses mixing captured and ordinary
recovery trees. The disk intent and final receipt retain the source
generation, capture digest and selected components, and the receipt
identifies the destination disk name, provisioning operation and generation.
Changing the capture during resume fails before further publication.
These receipts record a verified local import. Cutover still requires
independent destination identity, source authority and boot checks.

The internal coordinator first calls `registerImportDisk` with the
destination zone, provisioning operation and VM generation. The Compute
observer checks ownership labels, creation labels, disk readiness and
detachment, and reads the provider's numeric disk ID as a string. Once
registered, the same name cannot adopt another provider disk ID.
`verifyDiskImport` uses a trusted maintenance evidence reader that must
independently bind the on-disk receipt to that provider ID. It validates
the source capture, imported components and destination fields, then
rechecks that the exact disk is ready and detached. Before committing
`disk-import-verified` it compares the Firestore operation, source and
both fences again. Read-only status reports the verified components and
timestamp. It keeps cutover readiness false.

The trusted operator command reads evidence from an explicitly selected
private maintenance VM. Install the maintenance helper and its local
module dependencies under `/opt/mapache-maintenance`, enroll that VM's
SSH host key, and unmount and reattach the registered disk as a read-only,
non-boot, non-autodelete device before verification.

```bash
node scripts/vm-verify-migration-disk.mjs --project pi-agents-cloud \
  --workspace WORKSPACE_ID --owner OWNER_UID --operation OPERATION_ID \
  --maintenance-instance INSTANCE_NAME --maintenance-id INSTANCE_ID
```

The operator's credentials need Compute read and disk detach access,
IAP SSH access and restricted Firestore access to the operation. The
remote helper checks its Compute metadata identity, mounts ext4 without
journal replay, requires a read-only block device and verifies the
marker, receipt, merge-plan hash and installed file contents. It unmounts
before returning. The operator command checks the provider disk and VM
IDs and the read-only attachment before and after the IAP read, then
detaches the disk. The coordinator checks detachment before recording its
receipt. This command requires an existing registered, fenced operation.
If the disk detaches and the Firestore verification fails, recheck source
authority before reattaching for another read. Full source coverage, boot
validation, authority switch and rollback remain unfinished.

A live synthetic proof verified the captured receipt and installed files
over strict-host-key IAP on a read-only attachment, then verified the same
disk's detachment in Compute. Evidence is in
`artifacts/qa/vm-retained-import/maintenance-evidence.log`.

The emulator passes a locally installed receipt through coordinator
verification and rejects a substituted capture, a same-name provider
disk replacement and a concurrent Firestore record change. A separate
live Compute check read a disposable disk's provider ID without rounding,
rejected a different creation operation and confirmed disk removal.

Focused tests exercise interrupted directory publication, retry,
ownership rejection and changed destination data. A real tmpfs mount was
rejected by the production guard.

On 2026-11-23, `scripts/vm-retained-import-proof.mjs` exercised the
production mount/device checks on a fresh 10 GiB balanced Persistent Disk
attached to the private Debian maintenance VM `mapache-import-proof-605`.
The VM had no service account or external address. The fixture generated
two synthetic checkpoint trees and seeded its own provisioning marker.
The `interrupt` invocation killed itself after syncing its first
published directory and exited 137. `resume` confirmed the disk had one
published directory and no receipt before continuing. After unmount and
remount, `verify` confirmed the same receipt, agent history bytes, and
executable behavior. The installed tree passed the runner's
`prepareRetainedDisk` check with `initialized=false`.
Local evidence is `artifacts/qa/vm-retained-import/live.log`. The proof VM
and disk were detached and deleted after verification.

The captured variant of that proof uses `--captured` on all four phases.
On 2026-11-23 the synthetic capture used source generation 7 and a
separate destination provisioning operation at generation 1. After the
exit-137 interruption, a private Debian maintenance VM resumed the import
on an actual 10 GiB Persistent Disk. The receipt still named both
operations and the same capture digest after remount. Runner storage
bootstrap, executable mode and agent history passed. The maintenance VM
and disposable disk were removed. Local evidence is
`artifacts/qa/vm-retained-import/captured-live.log`.

For a repeat run, create a fresh fixture disk named
`mapache-ws-9f45ab7766711f54018f3551` in `pi-agents-cloud/us-central1-a`.
Attach it to a disposable Linux maintenance VM with that exact device name.
Confirm the fresh device has no filesystem signature before formatting
it as ext4 and mounting at `/mnt/mapache-import-proof-605`. With Node
18.20 or newer, run `seed`, then `interrupt` (expect exit 137), then
`resume`, using a separate process for each and holding an exclusive
mount-directory lock. Unmount, remount, then run `verify`. The last phase
also creates the remaining runtime directories, so it is the final phase.
Unmount and remove the disposable disk and VM after collecting evidence.

To extend the disk proof through normal runner startup, provision the
fixture disk through `ensureDataDisk` with the fixture workspace and
operation IDs in `scripts/vm-retained-import-boot.mjs`. This supplies the
ownership and creation labels the Compute service checks. Stop after
`resume`, unmount, and detach from the maintenance VM. Run
`node scripts/vm-retained-import-boot.mjs start <pinned-runner-image>`.
The helper reserves only the fixed synthetic registry records and starts
ordinary Compute Engine provisioning with disk creation disabled. Once
the VM is ready, stream `scripts/vm-retained-import-runtime-proof.cjs`
over IAP SSH to `sudo -n docker exec -i mapache-runner node`. The probe
checks authorized and anonymous `/runner/health` behavior, actual agent
readiness and imported history and executable bytes inside the container.
Use `node scripts/vm-retained-import-boot.mjs cleanup` to delete the fixture
runner and its registry records, then remove the detached proof disk.

The full synthetic runner proof passed on 2026-11-23. COS VM
`mapache-vm-98cfff5f3f7513451bc97216` started the regular runner from the
disk populated on the maintenance VM. The authenticated health response
was 200 with agent readiness true, and the unauthenticated response was
404. The imported executable ran and the session history matched in
the paths selected by the runner configuration. The disk receipt digest
matched the maintenance VM's import. Evidence is in
`artifacts/qa/vm-retained-import/{boot-seed,runner-health,runner-cleanup}.log`.
The proof exercises the synthetic path through storage and ordinary
runner startup. Importing complete legacy state, application-level use
of recovered transcripts, and real workspace cutover remain open.

## Cost model and guardrails

These are planning estimates, not measured usage. The pricing references were
checked on 2026-11-23 and must be refreshed before production approval:

- Persistent Disk Balanced in Iowa is listed at `$0.10/GiB-month`; 64 GiB is
  therefore approximately `$6.40/month` while retained, before snapshots.
- Standard snapshots are listed at `$0.065/GiB-month`; a 64 GiB fully changed
  snapshot is an upper-bound planning value of `$4.16/month`, while incremental
  snapshots are normally lower.
- A forwarding rule is listed at `$0.025/hour` for the first five global rules;
  regional gateway/data-processing, NAT, egress, logging, and TLS products are
  separate line items.
- VM compute is selected by machine type and active seconds. The release
  worksheet must use the current `e2-standard-2` us-central1 rate and observed
  cold-start/active-hour distribution rather than embedding an unverified
  number in application code.

The monthly worksheet is:

```text
active VM hours * current machine rate
+ provisioned data GiB * disk rate
+ changed snapshot GiB * snapshot rate
+ gateway forwarding rules + gateway processing
+ NAT/static IP/logging/egress
+ migration overlap + failed/orphaned resource allowance
```

Hard controls are quotas, admission concurrency, disk-size ceilings, labels,
orphan reconciliation, and an off-by-default feature flag. Budgets and alerts
are visibility, not a hard spend cap. The operator dashboard must expose disk
headroom, backup age/failures, startup stage timings, stranded resources, and
actual compute/storage/network cost.

Pricing references: [Compute Engine pricing](https://cloud.google.com/products/compute/pricing),
[Google Cloud block storage pricing](https://cloud.google.com/products/block-storage),
[Cloud Load Balancing pricing](https://cloud.google.com/load-balancing/pricing), and
[Compute Engine snapshot behavior](https://docs.cloud.google.com/compute/docs/disks/snapshots).

## Simplification audit

| Existing mechanism | VM decision | Removal gate |
| --- | --- | --- |
| Main HOME/workspace tar/checkpoint restore and shutdown upload | Replace with retained paths; keep readers for migration/recovery | Persistence and rollback fixtures pass |
| Large-file pointers and mandatory GCS upload mount | Replace with bounded resumable disk uploads; retain old readers | #622 tests pass for migrated VM paths |
| Chromium profile archive/restore, tint2 dependency, and layered restart policy | Open profile in place; minimal Openbox/Xvfb/VNC; one supervisor; verify sandbox and shared memory | #621 browser matrix passes |
| Private Git seed/reconstruction for ordinary POSIX main worktree | Keep `.git` in the retained worktree; preserve isolated automation Git | Migration comparison and dirty-history tests pass |
| GCS FUSE mode/lock/cache/polling workarounds | Remove only on VM path; preserve polling for remote clients and historical readers | No active workspace depends on removed path |
| Cloud Run revision/min-instance/probe workarounds | Keep for legacy/unsupported records; stop adding them to VM path | #620 rollback window expires |
| Overlapping process supervisors | One container/VM startup owner and one browser supervisor | Crash/restart tests pass |

## Release and verification gates

### Isolated rollout Functions

`vmRuntimeControl_v2` provides session-token authenticated coordination through
the backend-only `vmRuntimes_v2` registry. This registry does not trigger the
legacy workspace session workers. Each operation verifies the stored token
hash, owner, current session, generation, state, and admitted boot. One boot
can acquire the reservation; expired/released boots cannot reclaim it. A
45-second lease renews every five seconds; unavailable coordination revokes
runner admission and stops the managed agent child. Only the controller may
reserve a new generation after fencing the old compute.

The broker supports authority acquire/check/renew/release, constrained activity
and history, model selection, and selected canonical agent credentials. It
does not expose generic Firestore reads, arbitrary update fields, owner-wide
credential maps, or provisioning actions. The HTTP Function is network-public
because the VM has no Google identity token; every action requires the separate
session control token. Browser access tokens do not authorize these actions.
Control tokens travel over HTTPS and are never accepted as browser credentials.
`scripts/vm-control-probe.mjs` creates unique synthetic registry records, tests
the deployed broker, then deletes only those probe records. On 2026-11-23 its
live checks passed concurrent boot fencing (one 200/one 409), wrong-token 404,
stale-generation rejection, arbitrary-write rejection, model-selection round
trip, and expired-lease rejection. This is control-plane evidence, not VM
browser/session acceptance.

The fixture controller stores its raw bootstrap material in the backend-only
`vmRuntimeCredentials_v2` collection, while the registry stores only its control
token hash. This is a synthetic fixture controller, not the production migration
coordinator. `scripts/vm-crossover-fixture.mjs` now reserves an isolated generation
and starts the normal runner without startup-smoke mode. Its registry and secret
records are retained for repeatable inspection and are not user workspace data.

Runner VM operations use `session-runner/lib/vmRuntimeControl.js`; Cloud Run
keeps its existing authority implementation. VM startup requires an explicit
`MAPACHE_VM_CONTROL_URL` and `MAPACHE_VM_CONTROL_TOKEN` and never falls back to
ambient metadata credentials. VM Chrome startup uses the retained profile in
place, clearing only stale process locks. Legacy Chrome seed/archive timers and
agent checkpoint uploads are disabled for this backend; independent disk backup
and migration/recovery operations remain required release gates.

For code-only canaries affecting `lib/` and `server.js`,
`session-runner/cloudbuild.vm-canary.yaml` builds on an immutable `_BASE_IMAGE`
and publishes only `_IMAGE`. It compares both package manifests to the base
image and refuses dependency changes. Other source/dependency changes require
the full gcp-runner build. Its ordinary startup smoke is a compatibility check;
the live VM broker/lease/agent path must still be verified separately.

The broker-enabled generation-4 fixture completed normal startup (smoke mode
off), acquired its control-plane lease, launched Pi Web UI, and returned the
authenticated agent page and application bundles successfully. That image still
predated the baked-path precedence correction, so it is startup evidence only.
`scripts/vm-runtime-proof.cjs` is the stronger in-container check for authenticated
health, functional agent readiness, blocked metadata-token access, retained
workspace, and retained child HOME. The health path skips legacy Firestore
checkpoint reads for VM storage; backups are a separate concern.

The parent-metrics canary build `d1aa0a46-2f29-45a2-8dce-d276c0f21c7e`
published the VM-only tag `vm-crossover-metrics-f72a55b` at immutable digest
`sha256:885a04f85bc34d8987523624f2c7bd9fe704b0121d483971adfe227299c7b3b8`.
It adds the dedicated-VM unlimited-memory capacity fallback above. Production
runner tags were not moved. `scripts/vm-lifecycle-fixture.mjs admit GENERATION
[PINNED_IMAGE]` now preserves the fixture's stored image unless an explicit
validated digest is supplied; admission no longer rolls it back to an older
hard-coded image.
Replacement operation
`d7c04e20305031d5f7d76501a70233dea7a8e189d15d20e6a8c08ab0538268ef`
passed generation 8 -> 9 with graceful quiesce. Generation 9 is
`mapache-vm-f82ddd54fbcf523ee9cd3e54`, still attached to retained disk
`mapache-ws-efaf283eb879545a0e7ba4d3`. Normal agent health, metadata fencing,
retained child HOME/workspace and the original Git/SQLite/native/mode/symlink/
locking proofs passed. The live opt-in app shell then passed Firebase owner
login, discovery, current-session reads, signed Agent access, connected embedded
Agent and real CPU/RAM samples. The shell used neither legacy workspace-scoped
API calls nor a legacy Firestore session listener. Temporary Auth, allowlist,
API admission and parent metrics-origin changes were restored. Evidence is
`artifacts/qa/vm-owner-api/shell.json`, `artifacts/qa/vm-live-shell/`, and the
operation record under `artifacts/qa/vm-lifecycle/`. The synthetic unpaired
Device Center's verified `NOT_PAIRED` 409 is expected; model-chat and migration
acceptance remain outstanding. Only `vmGatewayResolve_v2` was redeployed for
the gateway fix; no production runner tag or Hosting release changed.

Generation 5 (`mapache-vm-d0af925469e49c4467ec0bd6`) passed that stronger
runtime proof on 2026-11-23 with immutable image
`sha256:a65b97e030790abfe1dc8e7d3de5cc8c30bf753cfddada062f1dd358c161fecc`.
Unauthenticated health returned 404, authenticated health returned 200 with
the agent ready, metadata-token access was blocked, and a real child used the
retained HOME and workspace. The authenticated agent page and all referenced
JavaScript bundles also passed the HTTP smoke check. The persistence verifier
passed inside this running normal runner against the original generation-2
Git HEAD and retained SQLite/native executable/mode/symlink/lock fixtures.
These checks do not establish browser interaction, model-provider authentication,
WebSocket routing, or user migration. The private gateway remains a release gate.

The isolated proof uses synthetic identity `vm-proof-605` / `vm-proof-owner`;
`scripts/vm-crossover-fixture.mjs` accepts no user workspace ID. Its operations
are `inspect`, `start`, `pause`, and `replace`, followed by a generation and
(for start/replace) a project-owned immutable runner image digest. Replace
deletes only the ownership-verified fixture instance and auto-delete boot disk;
the data disk remains. `scripts/vm-persistence-proof.cjs seed|verify` runs inside
that fixture container and checks dirty Git state, symlinks, modes, SQLite,
file locking, atomic rename, and a compiled native executable. This harness
does not yet establish browser-profile, package-manager, backup, or migration
release gates.

The deployed proof infrastructure in `pi-agents-cloud` is:

| Resource | Configuration |
| --- | --- |
| VPC `mapache-vm-v2` | Custom subnet mode; separate from existing services |
| Subnet `mapache-vm-v2-us-central1` | `us-central1`, `10.90.0.0/24`, Private Google Access |
| Router `mapache-vm-v2-router` | `us-central1`, on the proof VPC |
| NAT `mapache-vm-v2-egress` | Auto-allocated external addresses; only the proof subnet |
| Firewall `mapache-vm-v2-iap-ssh` | TCP 22 from IAP `35.235.240.0/20`, tag `mapache-vm-v2` |
| Custom role `mapacheVmProvisionerV2` | Instance create/delete/get/start/metadata/service-account/tags/labels; disk create/get/use/labels; subnet use; zone-operation get; image use-read-only |

Only `mapache-api` receives the custom provisioning role. Existing
`iam.serviceAccountUser` on `mapache-runner` supplies actAs; the runner retains
its existing Artifact Registry reader grant. VMs have no external access config.
The startup script blocks container access to the metadata HTTP endpoint while
allowing host image authentication. NAT and retained disks incur charges even
between proof runs; pause removes compute, not those infrastructure resources.
COS host Docker configuration lives under `/var/lib/mapache/host-home` on the
disposable boot filesystem because `/root` is read-only. The runner identity
also has `roles/logging.logWriter` for guest startup diagnostics.

VM terminal/tool child processes must receive retained HOME, XDG config/state,
caches, and the retained user-local executable directory. Owners are
`session-runner/lib/runnerEnvironment.js` and `session-runner/lib/config.js`.
Temporary sockets/locks remain under container `/tmp`. Changes to these files
require a new canary runner image; existing Cloud Run images are unaffected.
Retained paths take precedence over legacy image environment defaults, including
`WORKSPACE_DIR`, `CHROME_PROFILE_DIR`, `PREVIEW_STATIC_ROOT`, and user-local tool
paths. Regression coverage supplies those baked defaults and checks the actual
configured paths, rather than only checking the retained-path helper object.

The first live boot exposed direct Firestore calls that depended on ambient
Google credentials. The scoped control broker now permits normal agent startup
with metadata credentials fenced, as verified by generation 5 above. Remaining
compatibility paths still need validation before migration.

On 2026-11-23 the clean replacement filesystem proof passed from fixture
generation 2 (`mapache-vm-35530052c17c57f4310967d3`) to generation 3
(`mapache-vm-b732e83747943dda08a0cc3e`), using retained disk
`mapache-ws-efaf283eb879545a0e7ba4d3`. Both seed and verify reported Git HEAD
`9850d196d8e77c5e0ce1a72364cbb5a4f5b67217` and passed native executable,
SQLite, mode, symlink, and locking checks. Verification ran as an offline
container command from the pinned existing runner image, not as an authenticated
user session. Hard-loss/open-write recovery, browser state,
package installation, and backup restore remain separate unpassed gates.
The API-identity preflight now reports no missing checked Compute permissions.

Canary build `e3dfe040-ecab-4bcd-8dc5-5396ce730736` succeeded and published
`vm-crossover-c431211` (digest
`sha256:82c6f6db5286091d53b6a262337e35f7b8a69124c4064ae83a74f2114a6c53c3`).
It predates the retained-HOME child-environment correction; that correction
requires the next image. The production `gcp-runner` tag was not moved.

`vmRuntimePreflight_v2` is an IAM-private, read-only HTTP Function owned by
`functions/vmRuntimePreflight.service.js`. It checks the deployed API identity
for Compute permissions and gateway configuration without changing workspace
admission, session documents, or Hosting routes. It always reports live release
validation as outstanding; configured permissions alone are not readiness.
Deploy it independently with
`firebase deploy --only functions:vmRuntimePreflight_v2 --project pi-agents-cloud`.
Existing API, provisioning triggers, and Cloud Run services retain their deployed
revisions. Future VM workers must use separate names and isolated records so
legacy Firestore triggers cannot claim the same work.

On 2026-11-23 the isolated preflight deployed successfully under
`mapache-api@pi-agents-cloud.iam.gserviceaccount.com`: unauthenticated requests
returned 403 and an authenticated operator request returned 200. The deployed
identity initially lacked all eight checked Compute permissions. After the
dedicated infrastructure grants, preflight reported no missing checked permissions.
Gateway configuration remains absent and admission disabled. Next gates include
authenticated gateway routing and verified canary migration. No existing
workspace has been migrated by this Function.

The Compute bootstrap sets its marker-validation identity explicitly, uses a
bounded ext4 volume label and an explicit attached-disk device name. Compute
request IDs are deterministic UUIDs scoped to each resource and operation.
Ownership label values are case-sensitive identity hashes because Firebase IDs
can contain uppercase characters forbidden in Compute label values; the disk
marker retains the full original identity for filesystem verification.
These fixes require deployment of the eventual VM worker, not a runner image
rebuild; they are not evidence of a successful live VM replacement.

The current branch includes local contract/fixture coverage for descriptor
validation, Compute Engine request construction, ownership checks, retained-disk
identity, and the VM runner path. The live gates still require an isolated
`pi-agents-cloud` fixture (never a real user workspace): delete/recreate cycles,
hard loss, attach failure, disk-full, zone recovery, real authenticated
gateway/WebSockets, browser/upload QA, backup restore, migration formats,
central configuration, automation wake-up, machine-to-machine requests, and
resumable cohort reconciliation.

Rollout order is fixture -> canary -> bounded cohort -> reconciliation ->
rollback-window expiry -> legacy retirement. The parent feature flag remains
off until numeric thresholds for integrity, startup, gateway reconnect, cost,
and failure recovery are recorded. `pi-n64`, user-provided SSH machines, and
unrelated frontend/agent rewrites remain outside automatic migration.

## Related owners

- Provider contract: `functions/runtimeProvider.helpers.js`, `functions/runtimeProvider.service.js`
- Compute lifecycle: `functions/computeEngine.service.js`
- Session admission/lifecycle: `functions/sessionLifecycle.service.js`, `functions/provisioning.worker.js`, `functions/workspaceSessionReservation.service.js`
- Runner durable paths: `session-runner/lib/config.js`, `session-runner/lib/retainedDiskStorage.js`, `session-runner/lib/workspace.js`
- Browser simplification: `session-runner/lib/chromeDesktop.js`
- Existing migration/recovery readers: `functions/workspaceStorageMigration.service.js`, `functions/workspaceStorageBackup.service.js`, `session-runner/maintenance/`
- Existing automation/request contracts: `functions/automation*.service.js`, `functions/workspaceRequest*.service.js`
