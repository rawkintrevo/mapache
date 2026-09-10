# Gate A — Adapter feasibility

Status: prototype complete; Gate A not passed. The pi-chrome fixture proves
same-process identity, private IPC, ordinary message admission, and fail-closed
disconnect behavior. The public Pi TUI extension API does not expose the command
expansion, browser-answerable native UI, reload, or session-replacement hooks
required by this gate. Evidence: [Gate A report](../../../artifacts/web-first/gate-a/results.md).

Source: [refactor plan v2](../../../refactor-plan-v2.md), Sections 2–4 and Gate A. Next: [Gate B](B-control-and-commands.md).

Goal: demonstrate that one real Pi process can support structured browser interaction and its native terminal. This is a disposable prototype, not a production rollout. Complete tasks in order. Check a task only after saving the stated evidence. If an API cannot support a required experiment, record the failure and bring the small reproducer to a maintainer; do not invent an API or bypass the requirement.

## Establish the fixture

- [x] A01 — Read [runner architecture](../../session-runner-architecture.md), [Workspace Goals](../../workspace-goals.md), and [testing](../../testing.md). Inspect `session-runner/lib/terminal.js`, `runnerLifecycle.js`, `goalsRpc.service.js`, `goalsProtocol.js`, and `patchPiGoalX.js`. Write a short map of who starts Pi, submits commands, and handles dialogs. See [fixture map](../../../artifacts/web-first/gate-a/fixture-map.md).
- [x] A02 — Record `git rev-parse HEAD`, `git status --short`, and the diff of those files against HEAD. Identify the uncommitted Goals takeover changes and their regression tests. Preserve them; do not reset the working tree to match the original review. See [baseline](../../../artifacts/web-first/gate-a/baseline.md).
- [x] A03 — Create a local prototype entry point and temporary workspace fixture under the runner test structure. Give it a cleanup function that closes sockets and stops every process it starts. Use test files and isolated credentials; do not use a user's workspace. See `session-runner/test-fixtures/web-first/`.
- [x] A04 — Record the installed Pi version, managed Goals package version, image digest when applicable, and adapter revision. Pin the prototype dependencies and write down the command that reproduces the environment. See [environment](../../../artifacts/web-first/gate-a/environment.md).
- [x] A05 — From the pinned Pi API/source, make an operation table for prompt, extension-command dispatch, events, cancel, dialog response, session identity, reload, and session export. For each, name the supported API and its return/event evidence, or mark it unsupported. Ask a maintainer to review unsupported requirements before implementation continues. See [operation table](../../../artifacts/web-first/gate-a/operation-table.md); maintainer review remains pending.

## Build the smallest real integration

- [x] A06 — Start one interactive Pi process in a PTY after fixture preparation. Record its PID and actual Pi session ID. Attach and detach a terminal client twice; assert that neither identity changes. See [live results](../../../artifacts/web-first/gate-a/live-results.json).
- [x] A07 — Add the candidate image-owned bridge with a private local IPC connection. Open resources on the supported session lifecycle event and close them idempotently on shutdown. Keep control JSON off terminal stdout and keep sockets/secrets outside archived workspace paths. See `session-runner/lib/piWebFirstAdapter.extension.mjs` and the sanitized trace.
- [x] A08 — Implement a handshake containing protocol, runtime, session-generation, Pi-session, adapter, and package versions. Disconnect IPC and verify managed commands become unavailable instead of falling back to PTY typing. See `session-runner/lib/piWebFirstAdapter.js`.
- [ ] A09 — Submit one ordinary prompt through the supported API and collect structured message/tool events. Verify the same conversation is visible in the terminal. Then submit a terminal prompt and verify browser-side observation. Save event traces with secrets removed. The fixture records only dispatch/input without a model credential; the full experiment remains incomplete.
- [ ] A10 — Dispatch an actual managed Goals command using the supported extension-command expansion option. Record handler invocation evidence proving it was executed rather than sent as literal prompt text.
- [ ] A11 — Add a narrow dialog interface to the managed package integration. Exercise a real Goals confirmation, answer it through IPC, and assert that the exact request resolves once. Repeat with a duplicate answer and an invalid response shape; neither may cause another transition.
- [ ] A12 — Add a fixture invocation context and record stable evidence linking a root request to invocation and result. Exercise success, handler failure, and no-result behavior. Do not correlate by prompt text or by labeling all events with the active request ID.
- [ ] A13 — Use a fixture tool that runs until canceled. Stop it through the adapter; verify its child process exits and its continuation does not run. Repeat cancellation while a managed dialog is pending. Record timeout behavior as failure, not successful cancellation.
- [ ] A14 — Invoke native `/reload` at a safe boundary. Verify old IPC/context and pending answers are invalid, a fresh handshake arrives, and new work succeeds. Separately exercise session replacement and verify the actual Pi session changes. Implement a browser reload control only if the API table proves a supported path.
- [ ] A15 — Demonstrate native UI fallback for an unsupported widget using the explicit delegation or interrupt policy in v2. Verify no second Pi process starts and browser completion is not falsely reported after delegation.
- [ ] A16 — Load a fixture extension that injects unrelated background work. Verify the prototype detects/excludes that producer from managed execution and does not attribute its output to the browser request. Record how incompatible user packages will be reported without silently disabling them.

## Record the decision

- [x] A17 — Add repeatable runner tests for the supported adapter boundaries. Run `npm --prefix session-runner run lint` and `npm --prefix session-runner test`. Keep live model experiments separate from deterministic default tests. Live fixture execution is opt-in via `node session-runner/test-fixtures/web-first/run-gate-a.js`.
- [x] A18 — Save a results report under `artifacts/web-first/gate-a/` with versions, reproduction commands, each experiment's pass/fail result, sanitized traces, and cleanup outcome. Missing experiments remain incomplete.
- [ ] A19 — Have a maintainer review the API table and experiment evidence. Record the selected extension/SDK/upstream-hook approach. If a required experiment fails, retain the legacy mode and document the next candidate; Gate A has not passed.
- [x] A20 — Add a focused developer-doc note describing only the capabilities actually demonstrated and run `npm run docs:check`.

## Exit criteria

Gate A has not passed. The selected TUI extension candidate does not provide
structured Goals command dispatch, browser-answerable native dialogs, or
reload/session-replacement control. Keep the existing RPC plus explicit
interrupting terminal handoff as the legacy mode, and do not begin Gate B until
a maintainer reviews a pinned SDK/upstream-hook candidate that supplies those
missing boundaries. This gate does not authorize production replacement
execution.
