# Native upstream Goals

Mapache does not have a workspace-level Goals dashboard. The former Mapache
Goals records, routes, RPC bridge, and managed `pi-goal-x` package were retired
in Task 33. The only supported Goal surface is the native Goal implementation
inside the embedded upstream `/agent/` application.

The integration patch is
`session-runner/upstream/pi-web-ui/patches/0008-native-goal-persistence.patch`.
It keeps Goal behavior inside upstream and does not call a Mapache Goals API.

Native Goal display state is saved in the upstream UI data captured by the
checkpoint flow, under the global `__settings__.conversationGoals` entry in
`client-state.json`. Each record is keyed by the stable upstream session id (or
the session-file path fallback), so a fresh browser client id can restore the
same conversation. Only goal text, review preferences, round/verdict, feedback,
and the last visible status are serialized. Wizard progress, reviewer jobs,
queues, abort controllers, and streaming state are never serialized.

When a conversation is recreated after restore or history open, a saved native
Goal is shown as paused with a fresh wizard state and no automatic prompt,
wizard, review, or resume request. The Goal bar offers an explicit Resume action;
that action clears the paused marker and sends one ordinary upstream user
message. Goal state is conversation-scoped even when several browser tabs share
one managed runner. Clearing or completing the native Goal removes its display
record. This is display/restart persistence, not a durable server-side scheduler.

## Ownership and safety rules

- Mapache remains authoritative for workspace/session ownership, lifecycle,
  runtime admission, and checkpoint publication; upstream owns Goal behavior.
- The browser never receives runner shutdown credentials or arbitrary command
  execution. Agent access is mediated by the signed `/agent/` gateway.
- Native Goal state is persisted as part of the allowlisted upstream UI snapshot;
  active queues, reviewer jobs, and automatic execution are never restored.
- Do not reintroduce a Mapache Goals route, second Goal engine, or managed
  `pi-goal-x` declaration.

## Verification and rollout

Use the native Goal persistence tests alongside the repository aggregate:

```bash
npm run generate:runner-catalog -- --check
npm run docs:check
npm run check
```

See [the pi-web-ui integration plan](./plans/pi-web-ui-integration.md) for the
accepted ownership and persistence boundaries. The historical prototype plan
remains under `docs/plans/pi-workspace-goals.md` and is not an active runtime
contract.
