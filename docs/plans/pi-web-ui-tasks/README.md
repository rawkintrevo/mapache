# pi-web-ui execution guide

This is the issue-sized breakdown of the [integration plan](../pi-web-ui-integration.md).
The authoritative ordered checklist is [task_list.md](../../../task_list.md).
These are local issue specifications, not published GitHub issues. Publication is
not required to execute them. No task implementation has started.

## Read order

1. Read the root checklist, `AGENTS.md`, and the developer-wiki reading protocol.
2. Read [fixed decisions](./decisions.md) and [shared contracts](./contracts.md).
3. Read only the first unchecked task and the focused source/docs it names.
4. Read predecessor completion notes when they provide an exact path, ID, or command.

The task files describe desired behavior. Existing code still implements the old
system until the corresponding task passes. Do not treat historical plans as a
second backlog or import their unresolved decisions into this work.

## Execution rules

- Work in strict numeric order, one task at a time. Every task depends on all preceding tasks.
- Complete the task's acceptance checks, required focused wiki update, and validation before checking it off.
- For an entire-checklist goal, commit each completed task and continue automatically. For `next task`, complete one task and report the next one. Use the existing next-task skill's checklist/commit mechanics.
- Do not create a PR per local task or publish GitHub comments/issues automatically. Those are separate external actions.
- Gather factual information from source, official upstream docs, existing cloud metadata, and bounded experiments. Choose ordinary implementation details within the fixed contracts without asking for approval.
- Prefer existing helpers. Keep orchestration in current owners and new behavior in focused modules; do not build a replacement agent engine, generic plugin platform, or generalized migration framework.
- Update the relevant canonical wiki page in each behavioral change and run `npm run docs:check`. Do not postpone all wiki work to the final task.
- Frontend changes require `npm run build`. Functions changes require focused tests/lint and the deployment required by `AGENTS.md`; see the deployment rule below. Run the aggregate only at the designated gates or after changes justify rerunning it.
- Record evidence under `artifacts/qa/pi-web-ui/<task-number>/` and a short non-secret completion note below the root checkbox. Sensitive migration payloads belong in restricted ignored storage, never Git or general QA reports.
- Stage only the current task's changes. Commit as `Task N: <outcome>`. Record the commit in the next task's handoff or Git history; do not amend merely to put a commit's own hash inside itself.
- A checked box means all acceptance criteria passed. Do not mark blocked, partially verified, or mock-only hosted QA as complete.

## Stop instead of improvising

For an actual blocker, leave the checkbox unchecked, add `Blocked:` with the
failed condition, evidence, attempts, and exact missing input, and stop the run.
Do not skip ahead or silently replace the requirement with easier behavior.

Stop immediately for missing credentials/permissions, multiple plausible HubSpot
source sessions, backup hash failures, unavailable required browser tools, or a
need to change an agreed product boundary. Never invent IDs, credentials, passing
results, or data-loss acceptance. A blocker is not a new product decision.

For implementation failures, inspect the error and try at most three distinct,
evidence-backed fixes before recording the remaining blocker. Repeating the same
deploy/build/request without new evidence is not a fix. Respect the existing
480-second Cloud Run operation deadline rather than inventing indefinite polling.
After one failed live migration/cutover, execute the documented rollback and stop;
do not retry against the sole source repeatedly.

If a task grows beyond its stated boundary, add ordered lettered subtasks inside
its task file, each with tests, leaving its root checkbox unchecked. Do not move
the complexity to a vague follow-up or make later work depend on an undocumented API.

## Deployment rule and temporary rollout isolation

Creating this plan performs no deployment. When a later instruction authorizes
execution of the complete checklist, the explicitly listed builds, QA, deployments,
and single-workspace migration are part of that goal; there is no separate design
approval checkpoint. A later explicit `do not deploy` instruction takes precedence
and leaves deployment-dependent tasks blocked, not falsely complete.

The repository requires Functions deployment when Functions code changes. Keep
all new behavior behind the server-owned per-workspace marker in the contracts
until the backend default changes in Task 32. Deploy compatible additions incrementally, with the old HubSpot
source unmarked and untouched. Read current production metadata before the first
deployment: local Git rollback did not roll back deployed code or images. If an
intermediate deploy cannot preserve the source session, stop before deploying.

The next-task skill's default no-deploy guidance does not override `AGENTS.md` or
an explicit whole-checklist deployment goal. Do not edit either skill to bypass
its other requirements. Destructive legacy removal occurs only after migration
passes. A temporary rollout marker is allowed; permanent alternate runners are not.

Use explicit `--project pi-agents-cloud` for every cloud command. Never move a
mutable production image tag during canary work. Preserve existing IAM identities.
Do not delete unrelated workspaces, user data, old backups, or unowned cloud resources.

Early tasks establish tested seams before later tasks connect them: local gateway
tests inject explicit generation/authority fixtures; Task 12 supplies real generation
reservation and Task 13 supplies boot authority. Production fails closed while
those prerequisites are absent. Task 4 initially uses the existing restore hook;
Task 16 extends it to the new checkpoint format. Do not invent a successful empty
restore, default generation zero, or permissive fake authority in production to
make an early task appear integrated. Task 22 is the first full local integration
gate and Task 26 the first hosted new-runner deployment.

## Suggested goal to give an implementation agent

> Complete the sequential pi-web-ui checklist in task_list.md, including its
> specified QA, deployments, and one-off HubSpot migration. Follow the linked
> fixed decisions, contracts, and stop conditions. Work one task at a time,
> verify and commit each completed task, then continue. Gather missing factual
> information as needed. If a defined blocker occurs, leave the task unchecked,
> record the evidence and missing input, and stop rather than guessing or skipping.

## Completion note format

```text
Completed: YYYY-MM-DD — implemented outcome; tests and results; evidence path;
deployment command/result when applicable; next-task handoff facts.
```

Implementation agents should not need the original conversation to understand
scope, architecture, migration limits, or when they must stop.
