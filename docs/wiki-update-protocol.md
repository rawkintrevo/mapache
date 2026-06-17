# Wiki Update Protocol

## Purpose

This page defines when and how to update developer wiki pages while changing the app.

## Read When

Read this before handing off any non-trivial code, runtime, deployment, or workflow change.

## When Docs Must Change

Update `docs/` in the same change when behavior changes in any of these areas:

- Session creation flow, workspace/session UI layout, or terminal-first behavior.
- Runtime image contents, image catalog selection, Cloud Run provisioning, PTY, preview, WebSocket, or sync behavior.
- Firebase Hosting, Cloud Functions, Firestore, Cloud Storage, service accounts, or deployment flow.
- Frontend architecture, major state/workflow ownership, component ownership, or shared styling conventions.
- Pi auth, Pi skills, Pi package manager, GitHub workspace, GitHub App, Git controls, or PR workflows.
- Any accepted decision future maintainers need before making a non-trivial fix.

Small copy edits, isolated styling tweaks, and mechanical dependency updates do not need docs changes unless they affect one of those areas.

## How To Choose A Page

- Update the canonical subsystem page first.
- Add a short related-doc link instead of duplicating detail across pages.
- Add a new page only when the change introduces a distinct subsystem or maintenance protocol.
- Keep historical notes in `docs/prior_task_lists/`; do not move active implementation notes into `community/`.
- If an ADR decision changes, add a new ADR or explicit superseding note instead of editing history as though the old decision never existed.

## Edit Checklist

Before handoff:

- The relevant wiki page names the owning code paths.
- Stale "planned" or "future" language has been removed when the feature is implemented.
- Related docs link to deeper context without circular duplication.
- Any unresolved uncertainty is called out as a follow-up.
- `npm run docs:check` passes.
- For frontend changes, `npm run build` runs when feasible.
- For runtime container changes, the affected image and whether existing Cloud Run services need a new revision are documented.
- For Functions changes, deploy requirements are documented and the deploy outcome is reported when deployment is requested or required by repo instructions.

## Related Docs

- [LLM reading protocol](./llm-reading-protocol.md)
- [Testing](./testing.md)
- [Deployment](./deployment.md)
