# pi-web-ui release resolution and managed integration audit

## Scope

Issue #578 upgrades the embedded pi-web-ui without making the Mapache
integration depend on a manually edited upstream commit or on matching numeric
versions across unrelated Pi packages.

The build policy in
session-runner/upstream/pi-web-ui/manifest.json now selects the GitHub
stable release channel and the npm latest channel for the embedded coding
agent. build.mjs resolves each channel once, verifies the source package
identity, applies the release-specific managed integration patch strictly,
installs the resolved SDK version, records the actual installed pi-ai
metadata, and fails before producing a runtime directory when a compatibility
check fails. There is no fallback to an older release.

The current audit target was GitHub release
v0.121.0 (https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.121.0),
commit 6142308d81a1c85bd7c1ec180955ba5331cc650e. That is evidence from the
resolution performed during this change, not a new source pin. A future stable
release must either accept the managed patch or fail the candidate image build
until its integration is ported.

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

The pi SDK is installed with an exact version selected from the npm latest
dist-tag after resolution. The upstream lockfile remains a source input, not
the authority for the installed SDK. pi-ai metadata is resolved from the
installed package's own version, so a coding-agent release and its AI package
are not assumed to share a number.

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

Cloud Build receives MAPACHE_BUILD_RESOLUTION_KEY; the GitHub runner workflow
sets it to the source SHA and workflow run ID. Local builds use local by
default and can use --no-cache when a fresh registry/release lookup is
required. A successful image is still the only artifact eligible for the
immutable and compatibility tags, so the last working image remains in place
when a newer candidate fails.

## Managed patch disposition

The old v0.85 manifest contained 38 patches. The table below is the required
disposition audit for that entire series. Patches 0023 and 0028 were absent
from that manifest. The active v0.121 build uses the single
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
      session-runner/upstream/pi-web-ui/releaseResolver.test.mjs

The clean archive-mode build was run against the resolved v0.121.0 release with
--skip-tests; source verification, the managed patch, npm installs, mobile
dependencies, typecheck, production build, runtime copying, and the model
catalog override all passed. It produced a SHA-256 archive identity and
build-info.json.

The upstream npm test command was also run in the clean patched source:
1,099 of 1,108 files and 13,007 of 13,061 tests passed. The 14 failures were
in unrelated desktop/canvas, plugin-output, quota, workspace-snapshot, and
SDK-compatibility fixtures in this host environment. The builder remains
fail-closed when its normal test command is enabled; the --skip-tests result
does not claim those failures are fixed.

Before publishing, run the default image build in a clean Node 24 container,
then run the runner checks and the local vertical harness. Validate the
authenticated /runner/health contract and explicitly assert that /healthz
and /healthz/ are not served or probed. A new image revision is required for
new sessions; existing Cloud Run services retain their current image until
restarted or recreated. No Cloud Functions deployment is required for this
source-only runner change, but the image digest and release/build descriptor
must be recorded in the rollout note.
