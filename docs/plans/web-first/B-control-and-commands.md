# Gate B — Control, commands, and local failure behavior

Status: runner control slice implemented for pi-chrome; Gate A-dependent execution and production enablement remain blocked. The deployed image keeps `MAPACHE_WEB_FIRST_ENABLED=false` until the Gate A/C release criteria pass.

Source: [refactor plan v2](../../../refactor-plan-v2.md), Sections 4–8 and 11. Requires passing [Gate A](A-adapter-feasibility.md). Next: [Gate C](C-execution-and-checkpoints.md).

Goal: make one controlled runner safe to use across tabs, retries, disconnects, and reloads. Each task should be a small reviewable change with its stated regression test. Use local fixtures/emulated durable services; production replacement execution stays disabled until Gate C.

## Define the protocol

- [x] B01 — Read the Gate A decision and inspect `webSocketUpgrade.js`, `browserAccess.js`, `piChatWebSocket.js`, `terminal.js`, and `src/components/sessions/usePiChat.js`. Identify reusable authentication and reconnect helpers in a short implementation note. See [control map](../../../artifacts/web-first/gate-b/control-map.md).
- [x] B02 — Define validated command envelopes in a focused protocol module. Include runtime ID, execution epoch, session generation, control epoch, command ID, run ID where relevant, type, and bounded payload. Add tests for missing identities, unknown types, invalid payloads, and oversized messages.
- [x] B03 — Define processing status, outcome, and durability as separate fields. Write example transitions for successful prompt, failed handler, canceled run, and unknown dispatch. Test that `agent_settled` alone cannot mark an operation successful.
- [x] B04 — Define the root-run busy rule: one browser root run, no steering or follow-up queue, and stop/pause/dialog answers as correlated controls. Test that a managed goal retains the slot while temporarily idle.

## Enforce ownership

- [x] B05 — Add a control manager with an injectable clock and atomic acquire/resume/revoke operations. Bind a tab identity to its authenticated connection/resumption secret. Test two simultaneous acquisitions and an attempted copied-client-ID takeover.
- [x] B06 — Implement configurable heartbeat/expiry using v2's initial 10-second/30-second values. Test expiry, reconnect, and new-owner acquisition while the existing run remains busy. Reconnect must never replay a prompt automatically.
- [x] B07 — Gate terminal data, paste, raw fallback messages, and resize at the receiving boundary. Audit alternate terminal endpoints. Test an observer and an old connection after handoff; neither may write or resize.
- [ ] B08 — Add handoff states that close admission and invalidate the old input epoch. Implement wait-at-safe-boundary first. Test that a command admitted before the barrier cannot dispatch afterward using stale control.
- [ ] B09 — Add interrupt handoff using Gate A's cancellation path. Account for dialogs, managed schedulers, internal queues, and child work. Test timeout and delayed continuation; grant control only after verified quiescence.
- [ ] B10 — Wire managed handler guards, including terminal aliases, directly into the real command integration. Test an extension command that bypasses the generic input hook. Keep unsupported widget delegation consistent with Gate A.

## Admit and track commands

- [x] B11 — Implement an operation-ledger repository with transaction tests and a semantic payload hash. Store records under the Mapache session. Duplicate IDs return the existing status; changed payloads return a stable conflict. Keep tombstones for the addressable session's lifetime.
- [x] B12 — Implement durable admission and a one-use dispatch permit. Keep Pi calls outside transaction callbacks. Test a retried transaction callback and an ambiguous permit response; each command may dispatch at most once.
- [x] B13 — Recheck control after asynchronous admission and before dispatch. Release/cancel an unused reservation deliberately when control changed. Add a race test between durable admission and terminal takeover.
- [x] B14 — Use Gate A's causal evidence to update operation records. Store unrelated terminal/background events as session events. Test explicit handler failure, missing result, and process death after permit consumption without automatic redispatch.
- [ ] B15 — Handle stop, pause, and dialog answers independently of the root request's wait. Validate parent run, generation, goal revision, response shape, and controller. Test duplicate/stale answers and a stop while a root result is pending.
- [ ] B16 — Resolve the emergency-stop policy with a maintainer: authenticated local cancellation must remain possible when Firestore is unavailable, with later audit reconciliation. Implement the selected policy and test an outage during an active fixture tool; reject new root work while durable admission is unavailable.

## Reconnect and verify

- [x] B17 — Register `/agent` with the existing single upgrade dispatcher and browser-access checks. Add origin validation, message limits, and bounded output/backpressure. Test unauthorized upgrades, malformed frames, and a slow observer.
- [x] B18 — Implement bounded snapshots and event replay with an explicit sequence boundary. Include active response, tools, dialogs, ownership, and operation states. Test events arriving during snapshot construction, replay gaps, and stale runtime/generation events.
- [ ] B19 — Add a minimal session-level frontend client above canvases, reusing `useSessionAccessUrls.js`. Test refresh, token renewal, switching canvases, and stale sockets without duplicate submission. Rich UI remains Gate D work.
- [ ] B20 — Exercise reload/session replacement with outstanding requests. Invalidate old bindings and dialog handles, publish fresh state, and reconcile the run reservation explicitly. Never treat an old unresolved promise as restored state.
- [x] B21 — Run runner tests/lint, `npm --prefix functions test`, `npm --prefix functions run lint`, frontend tests, and `npm run build` for touched frontend code. Save the race/failure matrix and results in `artifacts/web-first/gate-b/`. See [deterministic runner results](../../../artifacts/web-first/gate-b/results.md).
- [x] B22 — Update the focused runner/frontend/Goals docs for implemented behavior; run `npm run docs:check`. If Functions changed, follow repo deployment policy with `firebase deploy --only functions:api --project pi-agents-cloud` unless explicitly instructed not to deploy; keep new-mode production execution disabled and report the outcome.

## Exit criteria

The implemented runner slice enforces one controller and one root run at
receiving boundaries, with retry/reconnect protection and explicit unknown
outcomes. B08–B10, B15–B16, and B19–B20 remain unchecked because they require a
Gate-A-passed adapter, durable backend policy, or frontend session client.
Gate C owns the remaining execution-authority and durability guarantees;
passing local tests does not enable production failover.
