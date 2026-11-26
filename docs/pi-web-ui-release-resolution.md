# pi-web-ui release resolution and managed integration audit

## Scope

Issues #591 and #590 upgrade the embedded pi-web-ui and Pi coding-agent SDK while keeping
the Mapache integration fail-closed on a known-compatible managed target.

The build policy in
session-runner/upstream/pi-web-ui/manifest.json records the managed targets
pi-web-ui `0.122.0` and `@earendil-works/pi-coding-agent` `1.6.0`. The
resolver still uses the GitHub stable-release and npm registry metadata
endpoints, but it rejects a release or package that differs from those targets.
build.mjs verifies the source package identity, applies the release-specific
managed integration patch strictly, installs the exact SDK version, records the
actual installed pi-ai metadata, and fails before producing a runtime directory
when a compatibility check fails. There is no fallback to an older release.

The current audit target is GitHub release
v0.122.0 (https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.122.0),
commit 6a3a5e705f8084d2c9afee408b5c3dce9cf1e1c6, with Pi SDK `1.6.0` and
pi-ai `1.6.0`. A future stable release must either be intentionally selected in
the manifest and accept the managed patch or fail the candidate image build
until its integration is ported.

## v0.123 migration in progress (#676)

The upstream v0.123.0 release (commit
`db6ff914de6cd1509edb224919dda2d547272f12`) changes the package identity to
`keel-agent` and replaces the old `AgentService`/`AgentServiceDaemon` runtime
with `packages/keel/src/app/core-engine.ts`. The active manifest remains on the
last integrated target above. Fresh builds fail safely on the newer stable
release until the complete managed integration is validated; changing only
the version or package name cannot repair the runtime.

`session-runner/upstream/pi-web-ui/patches/managed-v0123-workspace-boundary.patch`
is an **inactive, partial migration artifact**. It applies independently to the
official v0.123.0 source and is deliberately absent from the manifest. It
enforces canonical workspace containment in `server/core-workspace-adapter.ts`
and validates extra roots at `ClientStateStore` read/write boundaries. Managed
mode rejects external local paths, symlink escapes, and remote workspace URIs;
standalone behavior remains available. Rejected writes leave persisted state
unchanged, and stale external roots are filtered during restore.

`session-runner/upstream/pi-web-ui/patches/managed-v0123-run-accounting.patch`
is a second inactive component. `ManagedRunAccounting` observes SDK events
through the core session assembly: non-retry `agent_end` events increment an
engine-lifetime completed count, and tool start/end events maintain a separate
set for each session. `CoreEngine` exposes both counts to its status consumer.
Subscriptions follow the opened session through client-registry transfers and
are released when that session is disposed; reconnecting does not subscribe
twice. The cumulative completion count survives client disposal. These counts
are observations, not proof that all writers have drained.

The accounting patch passes 29 tests across `core-engine-connect.test.ts`,
`core-engine-plugin-hooks.test.ts`, and `core-app-session-registry.test.ts`.
Coverage uses the actual core engine/registry with synthetic SDK events,
including retries, reconnects, per-session tool IDs, transfer, and disposal.

`session-runner/upstream/pi-web-ui/patches/managed-v0123-drain.patch` applies
after those two inactive components. It introduces a bounded drain through the
real core/client assembly. Pending attachments settle before interrupted-run
state is recorded and stop requests are issued. Concurrent drain callers share
one promise. Stop failures, unreadable state, active writers, and hung adapters
fail closed. A failed drain requires process restart before unquiescing because
late stop operations may still be outstanding. Terminal and bash drain helpers
retain their records until termination can be observed rather than clearing the
records when sending a stop request. New goal, background, bot, and native CLI
work is gated during drain; the terminal dispatcher can inspect the same gate.

This is **not yet a complete shutdown integration**. Instantiated native Goal
and background hosts without their new `quiesce` capability explicitly fail
the drain. Native Goal pause/persistence, automation/request admission, and
full runtime validation remain required. Do not activate the patch set while
those contracts are incomplete. The component
passes 50 focused drain/core/terminal/bash/interrupted-run tests, the generated
dispatch-surface tests, and full upstream typecheck. Tests cover delayed and
hung SDK aborts, attachment races, retry sharing, terminal stop failure, late
rejection handling, and refusal of unsupported background drain.

`session-runner/upstream/pi-web-ui/patches/managed-v0123-background-drain.patch`
adds the background adapter's `quiesce` hook after the drain component. It
captures tracked PIDs before asking existing owners to stop jobs/port listeners,
then verifies both the remaining rows and captured process liveness within a
bounded deadline. UI cleanup alone cannot acknowledge termination. The upstream
plugin stop API removes task rows even if a stop callback throws, so active
plugin tasks trigger a best-effort stop and a failed drain requiring runner
process-group escalation; that API cannot establish successful termination.

This component passes 25 adapter tests, including a real background job whose
launcher and reported child PID are checked before and after shutdown. Mocked
cases cover removed-but-live job rows, delayed PID exit, and unverifiable plugin
stops. Full upstream typecheck passes with the candidate patch set. Native Goal
shutdown and the overall image/protocol/browser release gates remain open.

`session-runner/upstream/pi-web-ui/patches/managed-v0123-goal-state.patch`
adds native Goal display persistence and the adapter's drain implementation.
The existing `__settings__.conversationGoals` schema and `session:`/`file:`
identity prefixes are retained. `managed-core-goal-state.ts` owns the display
projection; `core-goal-run-adapter.ts` remains the sole execution owner. Restore
creates only a stopped, paused in-memory record with fresh wizard state and no
child conversations or turns. Clear/pass removes the saved display record.
Drain saves display state and invalidates every generation before awaiting any
abort, preventing late turn callbacks from dispatching review or more work.
The sink waits for turn settlement and rejects still-active SDK sessions before
child disposal. Abort failures propagate to the bounded core drain.

This component passes 38 native adapter/domain/sink/handler tests and full
upstream typecheck. A real `ClientStateStore` round-trip verifies restoration
under a new browser client id, session isolation, absence of execution fields,
and explicit clearing. This does **not** prove live browser restore: connection
and history-selection hooks still must call the restore capability, and the
explicit Resume protocol/UI path and re-admission after successful drain still
need integration. Keep the manifest unchanged until those paths and the full
release gates pass.

The remaining migration must preserve these contracts at their current owners:

| Contract | v0.123 owner / required work |
| --- | --- |
| Protocol and service interfaces | `packages/keel/src/protocol.ts` and `engine-service.ts`; server files are re-export shims. Port managed messages and real implementations together. |
| Persisted state | `packages/keel/src/projects-schema.ts` owns types; `server/client-state.ts` owns storage. Preserve paused goals, model timestamps, and interrupted workspace-request metadata. |
| Automation and workspace requests | Replace old daemon hooks with current core runtime/host integration; preserve status, cancellation, readiness, model validation, and restart recovery. |
| Quiesce and counters | Counter, bounded core drain, and background-host components are tested but inactive; native Goal shutdown, process-group escalation validation, and complete admission coverage remain required. |
| Native Pi Goals | Native adapter display persistence and drain are tested; connection/history restore hooks, explicit Resume, and re-admission remain. Old `goal-service.ts` tests do not establish these new runtime paths. |
| SDK setup | `packages/keel/src/adapters/sdk/session-opener.ts` and host ports must preserve credentials, transcript placement, prompt references, and the single MCP integration. Do not import server modules into the core package. |
| Embedding and browser surfaces | Revalidate authenticated `/agent/`, native terminal, model selection, Goals, and proxy paths against the actual new engine. |

The independent workspace patch passes 28 tests across
`managed-core-workspace.test.ts` and `core-domain-sessions-rebind.test.ts`, and
the full upstream `npm run typecheck` after installing root and mobile locked
dependencies. This is component evidence only: no full managed image, browser
release gate, or validated cache publication is implied. Before activating a
complete patch, run the candidate build/smoke, required release suite, runner
tests, and actual protocol/browser checks from #676. Keep the fast PR path and
strict release-cache validation separate.

This inactive artifact changes no deployed runtime. Existing Cloud Run
revisions and remote guests retain their images; a completed integration will
need a new validated image and explicit rollout evidence. No Functions deploy
is required for this checkpoint.

## v0.122 compatibility port (#590)

The active manifest applies `managed-v0122.patch`. It includes the retained
v0.121 managed integration and archive-test compatibility changes; the earlier
patch files remain historical and are not applied twice.

Upstream moved `DispatchSession`, `EngineService`, and `TerminalManagerLike`
from `server/index.ts` into `server/engine-service.ts`. The managed drain,
active-tool accounting, and explicit goal-resume contracts now extend that
owner. The daemon retains upstream's `implements EngineService` declaration.

The port preserves upstream's stale-extension hook guard around the managed
operating-reference injection, transcript-version validation alongside the
managed workspace/session-root checks, shell-launch imports, and conversation
counting. Goal material references remain part of the new upstream goal/wizard
messages and are persisted/restored with paused goals; restore never starts
review or wizard work. Existing managed credentials, automation, workspace
request, MCP, and embedding restrictions remain in force. The new upstream
plugin-catalog refusal test is adapted to Mapache's existing allow policy:
it checks that catalog sync remains allowed and independently verifies the
correlated failure-response shape when a catalog operation is refused. The
operating-reference test now requires both the upstream stale-hook guard and
the managed prompt wrapper. The cron rescheduling regression uses the existing
`flushDisk` condition wait rather than a fixed 10 ms sleep, matching the other
scheduler tests after upstream moved task-state persistence to asynchronous
I/O; its running-state and next-fire assertions are unchanged.

Managed workspace containment now delegates to upstream’s `isInsideRoots`,
including symlink escapes through missing descendants. The desktop dependency
list is regenerated after installing the resolved SDK (adding `semver` and
`yallist`). The steer test waits for its abort callback to be installed before
interrupting; two asynchronous-writer fixtures retry directory cleanup on
`ENOTEMPTY`. No test assertions or build gates are disabled.

The previous candidate failed before compilation because stable resolution
returned 0.122.0 while the manifest expected 0.121.3. A direct application of
the old patch rejected eight files. This port resolves those conflicts rather
than relaxing version checks or accepting partial patch application.

Runner source changes such as #595 remain separate: this compatibility branch
unblocks their image build after integration. A successful candidate does not
replace running services; existing sessions require a released image and a
new revision. Keep the previously deployed digest for rollback.

### Candidate verification

Cloud Build `dd421d84-73e9-41a9-bb48-50d192b97a51` completed successfully
in `pi-agents-cloud` with the normal typecheck, production build, and full
upstream test gate: 1,264 files passed (one skipped), 14,566 tests passed
(45 skipped). The authenticated `/agent/` smoke check returned 200 and loaded
all referenced JavaScript bundles. Candidate image
`us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:gcp-runner-issue590-v0122`
has digest `sha256:c2170998a9ff761089fd1c49c136026cf5bd66c08348438b12651c898699adb7`.
The real-image local vertical slice also passes: streamed tool use, workspace
editing, session history, auth renewal, quiesce/restart, and no automatic model
execution after restore. Its fixture recognizes the upstream review marker,
ignores stale session-list messages, waits for populated history snapshots,
and aligns root-written private fixture files with the host snapshotter UID.
Runner tests pass (463 passed, three opt-in tests skipped), as do lint and
`npm run docs:check`.
This build publishes a candidate only; it does not retarget production services.

## Resolution contract

The builder records both legacy flat fields and the richer build-info.json
descriptor. The latter includes:

- the release channel, tag, package version, commit, release URL, archive
  URL/SHA-256, and required-source-file hashes;
- the resolved @earendil-works/pi-coding-agent version, npm integrity, and
  registry metadata;
- the actual installed @earendil-works/pi-ai version and npm integrity;
- the exact managed pi-mcp-adapter compatibility contract and whether the
  image build inspected the installed package;
- the applied integration patch path.

The pi SDK is installed with the exact version selected in the manifest. The
registry packument is still read for integrity/tarball metadata, but a changed
`latest` dist-tag cannot silently install a different SDK. The upstream lockfile
remains a source input, not the authority for the installed SDK. pi-ai metadata
is resolved from the installed package's own version, so a coding-agent release
and its AI package are not assumed to share a number.

The managed MCP adapter remains explicitly versioned at 2.32.1. The builder
also compares its installed peer-dependency contract with the checked-in
contract (`@earendil-works/pi-ai: ^0.84.1`, `@earendil-works/pi-tui: *`,
`typebox: *`, and `zod: ^3.25.0 || ^4.0.0`) and records the inspected metadata.
Those peers are optional in the adapter package; the contract is a drift
guard, not a claim that the embedded SDK must share the adapter's historical
numeric version. The adapter's Mapache mutation patch remains strict by
package version and source anchors, and the post-build patch step remains the
final runtime guard. This is an intentional compatibility gate, separate from
the floating pi-web release and SDK resolution.

Cloud Build runs `buildInputs.mjs` before the cache lookup. Its content-addressed
key includes the resolved release archive, patched dependency lock tree,
managed patch hashes, builder scripts, and the Node/npm/git toolchain. The
GitHub workflow does not add a run ID, so a fresh worker can reuse the same
validated runtime. Cache objects are private and create-only; an absent or
unverifiable object is a miss. A successful image is still the only artifact
eligible for the immutable and compatibility tags, so the last working image
remains in place when a newer candidate fails.

## Managed patch disposition

The old v0.85 manifest contained 38 patches. The table below is the required
disposition audit for that entire series. Patches 0023 and 0028 were absent
from that manifest. The historical v0.121 build used the single
managed-v0121.patch, generated from the audited port of the retained and
adapted behavior. The old patch files remain as historical evidence but are
not applied by the new manifest.

| Old patch | Disposition | v0.121 evidence, proposed implementation, and verification |
| --- | --- | --- |
| 0001 expose-build-descriptor | RETAIN/ADAPT | v0.121 health already exposes runtime fields but not Mapache build provenance. Keep the health/build descriptor insertion and test /runner/health plus legacy fields. |
| 0002 managed-engine | RETAIN/ADAPT | Upstream supports several engines and switching; managed mode must continue forcing Pi. Reapply the current MANAGED gate and test rejected engine switches. |
| 0003 managed-subpath-and-service-worker | REPLACE | v0.121 already has appBase/relative assets, so discard the old base hunk. Retain exact-scope service-worker cleanup and /agent/ build-path checks; verify prefixed asset and worker behavior. |
| 0004 embedded-agent-renewal | RETAIN/ADAPT | No upstream Mapache access-renewal bridge exists. Port the iframe origin check, signed-cookie renewal, and WebSocket reconnect against the v0.121 entry points; retain bridge unit coverage. |
| 0005 managed-credential-ownership | RETAIN/ADAPT | v0.121 still owns provider keys, OAuth, and model configuration. Keep server-side refusal/redaction and managed UI restrictions; test direct mutation attempts and secret absence. |
| 0006 single-managed-mcp-path | RETAIN/ADAPT | v0.121 has native MCP/plugin paths. Keep one Mapache adapter route and verify exactly one fixture server/tool path plus managed mutation refusal. |
| 0007 workspace-root-and-flat-history | REPLACE | v0.121 has newer session search/root plumbing. Reimplement Mapache /workspace, canonical-path, and symlink-escape checks at the current owners; run workspace-root/history tests. |
| 0008 native-goal-persistence | RETAIN/ADAPT | Upstream GoalService has generations and delegation but not Mapache paused restoration. Preserve paused restore and explicit resume without automatic execution; run goal persistence/resume tests. |
| 0009 runtime-quiesce-control | REPLACE | v0.121 natively exposes status/quiesce/unquiesce. Retain Mapache drain, active-writer, goal, and final-save semantics in the new daemon; verify acknowledgement only after drain. |
| 0010 completed-turn-counter | RETAIN/ADAPT | Current service status has no Mapache final-turn counter. Count final non-retry turns at the current daemon event owner and cover status accounting. |
| 0011 managed-navigation-and-chrome | RETAIN/ADAPT | Upstream desktop UI does not provide the Mapache parent navigation bridge. Keep managed top-bar suppression and sibling Chrome navigation; verify the bridge message contract. |
| 0012 managed-capabilities | DELETE | The old patch is obsolete and its capability behavior conflicts with the managed policy. v0.121 managed restrictions plus the retained credential/MCP guards are the authority; test plugin/update refusal. |
| 0013 automation-run-state | RETAIN/ADAPT | No equivalent reducer exists upstream. Keep the pure run-state reducer and adapt event types to v0.121; run reducer, completion, cancellation, and interaction-required tests. |
| 0014 automation-control | RETAIN/ADAPT | Upstream scheduler/plugin chat primitives do not expose Mapache start/status/cancel control. Recreate those commands on the current daemon and test browserless lifecycle calls. |
| 0015 automation-control-timeout | RETAIN/ADAPT | v0.121 control idle timeout is short for probes. Keep the long-operation boundary in the asynchronous control path and test bounded start acknowledgement. |
| 0016 managed-operating-reference | RETAIN/ADAPT | Upstream has prompt/extension hooks but not the image-owned Mapache reference contract. Keep the reference injection and duplicate-prevention tests. |
| 0017 custom-provider-connections | RETAIN/ADAPT | Upstream custom providers do not replace Mapache Authentication Center ownership. Reapply provider connection/auth merging at current model-admin owners; test secret-safe discovery and streaming. |
| 0018 bounded-control-socket | RETAIN/ADAPT | v0.121 already bounds the probe and protects the socket. Retain the configurable private path and Mapache command routing; test mode, permissions, and timeout. |
| 0019 automation-model-inheritance | RETAIN/ADAPT | Scheduler accepts explicit models but not Mapache's workspace inheritance contract. Preserve latest saved provider/model selection and stale-selection errors; run model inheritance tests. |
| 0020 workspace-request-resume | RETAIN/ADAPT | Generic upstream resume is not the Mapache request recovery contract. Keep explicit resume, request identity, and duplicate-prompt prevention; run workspace request resume tests. |
| 0021 shared-workspace-request-chats | RETAIN/ADAPT | v0.121 has no Mapache workspace-request conversation metadata. Add it to the current conversation/history model and verify shared history without activating the browser chat. |
| 0029 workspace-request-model-and-chat | REPLACE | Use current plugin/scheduler chat primitives as lower-level APIs, then add durable Mapache request IDs, visible history, cancellation, and browser-independent chat tests. |
| 0030 workspace-request-bind | REPLACE | Current plugin chat supports conversation binding. Rebind the Mapache request to that API and test that an inactive browser conversation is not made active. |
| 0031 workspace-request-metadata | RETAIN/ADAPT | No upstream request handle/state type exists. Keep Mapache metadata while using one current run-state model; test persistence and sanitized status. |
| 0032 workspace-request-agent-fields | REPLACE | v0.121's canonical daemon client map supersedes private-client fields. Register a workspace-request client and test tool/catalog participation. |
| 0033 workspace-request-quiesce | REPLACE | Replace old uniqueClients() edits with the v0.121 daemon registry model; test request clients in quiesce, active counts, and final save. |
| 0034 workspace-request-active-count | DELETE | The old loop targets obsolete bookkeeping. The current daemon registry supplies the count; retain only focused active-count regression coverage. |
| 0035 workspace-request-client-counts | DELETE | Same obsolete loop change. Current canonical clients own counts; test status output after request registration instead. |
| 0036 workspace-request-agent-service | REPLACE | v0.121 lacks the old fields at that location. Add required counters and request lifecycle state at current service owners; run daemon/control tests. |
| 0037 workspace-request-control-methods | RETAIN/ADAPT | Upstream has no Mapache request reducer/status/cancel API. Keep the control contract and adapt routing/error handling to v0.121. |
| 0022 workspace-request-dispose | REPLACE | Current daemon disposal owns its client map. Add request-handle cleanup there and test cancellation/disposal on stop. |
| 0026 workspace-request-agent-tools | DELETE | Canonical daemon client/tool refresh covers requests after registration. Verify tool visibility with a focused regression test instead of the old loop edit. |
| 0027 workspace-request-client-catalog | DELETE | Canonical client catalogs cover slash commands/background tasks after registration. Verify catalog behavior through the current daemon path. |
| 0024 workspace-request-control-socket | RETAIN/ADAPT | v0.121 control socket natively has only status/quiesce/unquiesce. Keep Mapache request commands and test routing, authentication, and error sanitization. |
| 0025 workspace-request-control-test | REPLACE | Recreate the old routing coverage in the v0.121 test layout; the release does not contain the old test file. |
| 0038 workspace-request-model-catalog | REPLACE | Build the request response from the current runtime catalog, never credentials or the frontend fallback; test provider/model IDs and unavailable runtimes. |
| 0039 workspace-request-saved-model | RETAIN/ADAPT | Current state stores project model selections but needs Mapache cross-client inheritance. Preserve workspace scope and explicit stale-model rejection. |
| 0040 workspace-request-readiness | RETAIN/ADAPT | v0.121 has pending attach state but not the Mapache readiness/stage/error contract. Preserve shared initialization and retryability; test readiness, stopped runners, and sanitized errors. |

0041-upstream-runtime-compatibility.patch and
0042-upstream-build-regressions.patch from the earlier diagnostic branch were
not restored as source pins. The current port keeps only the managed behavior
needed for #578 and deliberately excludes the unrelated workspace-snapshot and
desktop test changes from 0042.

## Catalog and mixed-version behavior

The checked-in
src/config/automationModelCatalog.json is only an offline labels/IDs
fallback. scripts/generate-automation-model-catalog.mjs resolves
@earendil-works/pi-ai@latest directly and records that package's own version
and integrity. The frontend test checks package identity, catalog shape,
required model overrides, saved IDs, and custom IDs; it does not compare the
fallback version with the runner manifest.

Runtime capability remains authoritative:

- the runner refreshes its installed provider catalog from pi.dev and stores a
  non-secret cache below managed Agent data;
- workspace requests ask the live target runner for /workspace/models;
- Functions validates the exact provider/model pair against that target;
- saved unknown IDs remain visible in the editor but are rejected explicitly if
  the stopped/older target cannot run them;
- unknown remote providers are not added to the old-runner picker, while custom
  IDs remain available.

This allows the frontend, runner release, coding-agent SDK, and pi-ai catalog
to advance independently without silently rewriting a saved model selection.

## Verification and rollout

Focused builder tests:

    node --test session-runner/upstream/pi-web-ui/build.test.mjs \
      session-runner/upstream/pi-web-ui/releaseResolver.test.mjs \
      session-runner/upstream/pi-web-ui/artifactCache.test.mjs

The Cloud Build cache rehearsal is the release evidence for this policy: the
first clean worker records a miss and full-build elapsed time, a second clean
worker with identical inputs records a verified hit, and changing a managed
patch or resolved dependency records a different key and a miss. The final
image smoke test also fetches `/agent/` and each referenced JavaScript bundle
before the image can be published.

The clean archive-mode build was run against v0.121.3 with `--skip-tests`;
source verification, the managed patch, npm installs, mobile dependencies,
typecheck, production build, runtime copying, and the model catalog override
all passed. The resulting runtime reported pi-web-ui `0.121.3`, coding-agent
`1.6.0`, pi-ai `1.6.0`, and pi-mcp `1.6.0`, and produced a SHA-256 archive
identity and build-info.json.

The normal builder runs the production build before npm test because the
upstream CLI smoke tests import generated server modules. Its test subprocess
clears inherited LC_ALL so the tests' explicit locale overrides remain
effective. The test environment also uses a synthetic non-system HOME so the
upstream browse-path boundary fixture can distinguish a user home from the
explicitly blocked /root path; production runtime HOME remains unchanged.

The normal builder test command was also run in the clean patched source:
1,204 of 1,217 files and 14,027 of 14,088 tests passed. The 12 failing files
and 16 failing tests were environment-sensitive desktop, SDK-hook, environment
registry, i18n, plugin-link, notes, quota, repository-hygiene, process, and
workspace-snapshot fixtures on this host. The builder remains fail-closed when
its normal test command is enabled; the passing `--skip-tests` build proves the
runtime typecheck and production artifact path, not a claim that those host
fixtures are fixed.

Cloud Build runs the same test command from a release tarball rather than a
Git checkout. The builder removes its source-resolution marker before testing
and creates a temporary Git index so upstream repository-hygiene tests inspect
the extracted source without treating build metadata as a repository file.
The v0.121.3 compatibility patch also registers the two managed internal
variables (`PI_WEB_CONTROL_PATH` and `PI_WEB_MCP_ADAPTER_PATH`) and removes the
unused `goalBarSet` translation key from the synchronized dictionaries. This
keeps the release audit strict while making the archive-mode test environment
equivalent to the upstream checkout assumptions.

Before publishing, run the default image build in a clean Node 24 container,
then run the runner checks and the local vertical harness. Validate the
authenticated `/runner/health` contract and keep `/healthz` and `/healthz/`
out of all routes and callers. This source-only change did not modify an
existing Cloud Run service or revision; a new `gcp-runner` image revision is
required for new sessions, while existing services retain their current image
until restarted or recreated. No Cloud Functions deployment is required, but
the published image digest and release/build descriptor must be recorded in
the rollout note.
