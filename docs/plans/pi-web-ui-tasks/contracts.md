# Shared implementation contracts

These names and boundaries make neighboring tasks composable. They are proposed
new interfaces, not assertions that corresponding code already exists. Prefer a
small extension of an existing equivalent helper over duplicate implementations;
record a mechanical name change here and in dependent task files in the same task.

## Rollout and provisioning

- Server-owned workspace field `agentUiVersion: "pi-web-ui-v1"` selects the new path during development. The runner receives that server-owned marker as `MAPACHE_AGENT_UI_VERSION=pi-web-ui-v1`; never accept arbitrary UI version/image URI from a browser. Unmarked workspaces retain old behavior until the backend default changes in Task 32.
- Session access responses add `agentUrl` only for a marked workspace with a ready compatible runner. Keep old fields until legacy retirement.
- Use existing operation IDs and session documents. Extend workspace writer coordination with a monotonically increasing runtime generation and a per-boot instance ID. Admission must occur before the upstream engine accepts work.
- Task 12's concrete reservation fields are: on the marked workspace, `agentUiVersion: "pi-web-ui-v1"` (the server-owned rollout marker), `agentRuntimeSessionId` (the currently admitted session ID, or `null` after release), `agentRuntimeOperationId` (the normalized provisioning/lifecycle operation ID), `agentRuntimeGeneration` (a positive integer incremented in the reservation transaction), `agentRuntimeState` (`starting`, `running`, `stopping`, `failed`, or `stopped`), and `agentRuntimeUpdatedAt`. The admitted session copies `agentRuntimeOperationId`, `agentRuntimeGeneration`, and `agentRuntimeState`; its existing `provisioningOperationId` remains the idempotency key. The workspace and session fields are written together with the existing `syncWriter*` lease fields. Same-operation retries reuse the existing session document without overwriting the reservation; a different operation is rejected while the marked session is `provisioning`, `running`, `restarting`, `resizing`, `stopping`, or `deleting`. A terminal failure clears only the current session reservation, preserves the last generation, and permits the next operation to reserve `generation + 1`. Unmarked workspaces do not write or read these runtime reservation fields. Task 12 intentionally does not assign a boot-instance ID; Task 13 owns that field and fencing.
- Concurrent Start requests converge on one session/service. Restart/resize performs quiesce, final checkpoint, confirmed old-service deletion, then create. A timeout or uncertain deletion cannot authorize a second service.
- A process losing writer authority rejects new work and terminates its agent/tool process group. Publication also validates authority, so an old process cannot corrupt the last good checkpoint even after a delayed callback.
- Adapt the existing lease schema in Task 12; do not build a second independent lease database. A replacement needs positive fencing of its predecessor, not just a guessed wall-clock timeout.

Use a Firestore workspace coordination document as the atomic owner of generation,
boot instance, lifecycle operation, and published checkpoint references. Extend the
existing schema rather than introduce a competing authority. A publication
transaction reads that same authority and writes the new pointer in one transaction;
checking Firestore and later overwriting a mutable Storage `latest` object is not
equivalent. Task 12 records actual field names and Task 15 tests the transaction.

An unexpected boot cannot take over an existing boot's generation just because it
cannot reach the old process. Report recovery required to Functions. Reconcile by
deleting the old service and confirming completion before starting a new generation.
If the old service is already absent because of a crash, restore the last published
checkpoint with an interrupted status; a nonexistent process cannot supply a final
save. This crash path is distinct from a manual Stop, which requires the final-save
acknowledgement. Neither path starts a model turn automatically. Do not let a missing
heartbeat by itself force-stop a still-live source or authorize concurrent writers.

## Embedded transport

- Public prefix `/agent/`; internal `127.0.0.1:8787`; upstream WebSocket `/ws` maps to `/agent/ws`.
- Extend existing signed runner access with an agent audience and current generation. Reuse the existing TTL/renewal cadence; do not create a permanent shared browser password.
- Query bootstrap `mapache_access` establishes an agent-scoped Secure, HttpOnly, SameSite=None, Partitioned cookie, with `Path=/agent/`, then removes the query from browser history/redirects. Local tests may use an explicit localhost-only non-Secure cookie option.
- Verify token signature, expiry, session, audience, and generation at the gateway before forwarding. Validate exact trusted Origin on state-changing HTTP and WebSocket upgrades. GET bootstrap is authorized by its signed token. Do not broaden origin checks to arbitrary localhost ports in production.
- Gateway strips external auth/bootstrap material and injects a private per-boot upstream token. Strip upstream auth cookies; never reveal that private token or shutdown credentials to the browser.
- Keep the central manual WebSocket upgrade dispatcher (`noServer`); `/agent/ws` must coexist with Chrome/metrics sockets. Unauthorized upgrades fail before reaching upstream.
- Parent renews access before expiry. A minimal typed postMessage bridge checks both `event.origin` and `event.source`, rotates access inside the child, and reconnects the socket without reloading the iframe or resubmitting prompts. Close existing connections when their access expires if renewal fails.
- Messages between parent/child carry only readiness, access renewal, and safe error/status fields. Do not reimplement the upstream chat protocol in Mapache.
- Disable the embedded build's service-worker registration and clean up only its own old scoped worker if encountered. Do not unregister unrelated application workers.
- Reject off-origin redirects; stream uploads/downloads without reading large bodies into memory. Reuse bounded upstream limits, documented in the gateway task. No unauthenticated catch-all proxy.

## State, snapshots, and restart

| State | Owner/location | Treatment |
| --- | --- | --- |
| Workspace files and `.git` | `/workspace`, existing workspace storage | Preserve existing visibility; reuse file synchronization |
| Pi transcripts | `/var/lib/mapache/agent/sessions` | Set explicit flat `PI_CODING_AGENT_SESSION_DIR`; copy complete JSONL records preserving branches |
| Non-secret Pi config | `/var/lib/mapache/agent/pi` | Persist settings; omit rematerialized auth/ephemeral connector secrets from new agent snapshots |
| UI data/settings/uploads | `/var/lib/mapache/agent/ui` | Persist authoritative upstream data, including attachments referenced by conversations |
| Credentials/connections | Mapache stores and materialization | Regenerate before launching engine; do not invent a second credential database |
| Chrome profile | Existing Chrome lifecycle | Continue existing behavior for new runner use; excluded from the one-off migration |

Agent snapshots go under a new versioned internal workspace storage prefix. Task
13 records its exact path derived from the existing prefix; never mix it with a
legacy source archive. Use manifest version 1: relative path, kind, byte length,
SHA-256, and safe permission metadata; include workspace/session/generation and
capture time. Reject traversal and unsafe symlink extraction. Do not follow
symlinks into credentials or unrelated directories.

Upload to immutable unique objects first, then transactionally publish a pointer
only while generation/instance still owns the workspace. Readers use only the
published manifest. A partial upload never replaces the last good checkpoint.
Do not resume the old flat sync writer for the same new-runtime state paths.
Existing file sync must participate in the same writer-authority checks; Task 14
defines the manifest and Task 15 must test stale file writes as well as stale agent
snapshot publication.

Complete JSONL prefixes may be captured while an agent runs; incomplete trailing
records wait for the next save. Stable JSON/settings snapshots require atomic
upstream writes or retry on change. Graceful-stop capture follows confirmed writer
quiescence and includes final records. A migration capture must also be quiescent.

Restore to staging, validate, then atomically install before runtime admission.
Never overwrite good local state with a corrupt/partial restore. Restore display
state without restoring active queues, wizard runs, Goal review loops, or automatic
`continueRecent` execution. Explicit opening of old history must not send a prompt.

## Lifecycle adapter

Provide a narrow runtime adapter with `start`, `health`, `quiesce`, `stop`, and
`activity` operations. The implementation may use a local authenticated control
channel/Unix socket and a small upstream patch. It must not infer execution state
from rendered terminal text or browser presence.

Quiesce rejects new work, aborts active agent/Goal/tool execution, and reports
completion only after writers stop. Give cooperative shutdown 5 seconds, then
terminate its process group; confirm exit within a further 5 seconds. Failure
leaves the workspace in a visible stop-failed state. Only after this confirmation
may final capture occur. Give the manual final save a bounded 120-second budget;
a failed save does not become a successful stopped response or permit replacement.
Cloud Run SIGTERM has its own shorter deadline: best-effort save relies on periodic
checkpoints, and must not be advertised as the full manual-stop guarantee.

Runner status reports `starting`, `ready`, `stopping`, `stopped`, or `error`, plus
`lastCheckpointAt`, `checkpointError`, and runtime health. Persist an error code,
not raw secret-bearing stderr. Auth renewal or tab switching must not change
runtime execution state.

## Tests and release evidence

Each task file names its specific assertions. Use existing Node tests/Vitest and
dependency injection. Local tests must not require paid model calls. Hosted QA
uses a disposable workspace, an existing configured provider, bounded prompts,
and no real HubSpot CRM mutations. A missing provider or browser tool is blocked.

No more than 12 live model turns per hosted QA task, each with a 120-second harness
deadline and abort on expiry; use deterministic fixtures for timing/failure tests.
If a model already has a supported token cap, set a small cap appropriate to the
assertion. Do not build a new billing limiter for this plan. Migration validation
uses one inert explicit resume prompt such as `Reply MIGRATION_OK; do not use tools`.

A task's deploy command must name the project and record its result, image digest,
Functions revision, and relevant canary ID. Production cleanup uses IDs from the
inventory, never a wildcard deletion. Retain migration originals and release rollback
records outside Git; tracked evidence summaries must contain no transcript content.
