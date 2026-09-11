# Task 31: Make the embedded app the primary workspace surface

Difficulty: medium. Depends on Tasks 1–30. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `src/components/sessions/SessionDetail.jsx`
- `src/components/layout/AppShell.jsx`
- `docs/ui-components.md`

Use actual paths/IDs from prior task evidence, not guessed names. Read focused wiki pages before editing code.

## Ownership

Workspace/session shell components, focused workflow modules, and access hooks.

## Steps

1. Show one workspace runner lifecycle: Start/Open, Stop, Restart and existing resource controls. Remove session/image selection for new workspaces.
2. Make Agent the default canvas, with Persistent Chrome and Preview siblings and resource/status indicators.
3. Remove parent session-level file/Git and agent-setting controls duplicated inside upstream. Keep login, workspace management, credentials/connections and lifecycle.
4. Keep blank/GitHub workspace creation. Display old unsupported records as inactive rather than silently attempting to convert/start them.
5. Keep backend activation gated until Task 32 and first use the preview channel for UI verification. After those checks pass, publish this compatible shell to primary Hosting with `--project pi-agents-cloud` before later tasks remove old backend routes. Do not leave the old production frontend calling retired APIs through Tasks 32–36.

## Acceptance criteria

- The user has one obvious owner for files/Git/agent settings and can still reach Mapache credentials/connections.
- The migrated HubSpot session opens directly into its new conversation interface.
- Chrome/Preview switching, resource changes, loading/stopped/error states and responsive layout work.

## Validation

Focused frontend/workflow tests, npm run build, relevant preview browser cases, explicit-project Hosting deployment and production source-session smoke; update frontend/UI-component docs.

Update affected canonical docs for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not delete legacy backend code or cloud resources in a frontend cleanup. All shared stop conditions apply. Leave this task unchecked if any required check fails or access is missing.

## Handoff

Record actual commands/results, safe evidence references, and any recovery actions under Task 31 in the root checklist. Commit before continuing to Task 32.
