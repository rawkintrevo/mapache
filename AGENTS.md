# Agent Instructions

## Development Knowledge

This repo has development knowledge in `docs/`. For non-trivial fixes or feature work, inspect `docs/` before changing code and read the pages that look relevant.

Treat these docs as part of the source of truth for implementation context. If a change alters app architecture, user workflow, runtime container behavior, deployment assumptions, or a recorded design decision, update the relevant doc in the same change.

The docs are extensible. Add a new page when a change introduces a distinct area of development knowledge that does not fit cleanly into the existing docs.

## When Docs Must Be Updated

Update `docs/` when changing any of the following:

- Session creation flow, workspace/session UI layout, or terminal-first behavior.
- Runtime container image contents, image selection config, or Cloud Run provisioning behavior.
- Terminal rendering, PTY handling, WebSocket behavior, or workspace sync.
- Firebase Hosting, Cloud Functions, Firestore, Cloud Storage, or deployment flow.
- Any decision that future maintainers would need to understand before making a non-trivial fix.

Small copy edits, isolated styling tweaks, and mechanical dependency updates do not need doc changes unless they affect one of the areas above.

In general, keep docs edits focused on the current change. If the docs have become stale, repetitive, poorly organized, or would benefit from a broader restructure, call that out and prompt the user to instruct the agent to refactor the docs. Do not perform broad docs refactors unless the user asks for that explicitly.

## Implementation Notes

Keep changes scoped to the existing structure:

- Frontend state and handlers live in `src/main.js`.
- DOM rendering lives in `src/ui/render.js` and component-specific files in `src/ui/`.
- UI Component Index: See `docs/ui-components.md` for a mapping of UI components, their file locations, and purposes.
- Shared frontend styling lives in `src/styles.css`.
- Session image choices live in `src/config/sessionImages.js`.
- API client calls live in `src/services/api.js`.
- Cloud Functions backend logic lives in `functions/index.js`.
- Runtime container code lives in `session-runner/`.
- **Monolith Prevention**: For new features, break functionality into smaller, focused files rather than adding to large monoliths like `src/ui/render.js` or `src/main.js`.

For frontend changes, run `npm run build` before handing off when feasible. For runtime container changes, validate the container path and document whether existing Cloud Run services need a new revision.

This repo deploys to the `pi-agents-cloud` Firebase/GCP project. Use explicit project flags for remote build and deploy commands so a local default gcloud project cannot send work to the wrong place. For example, push the default runner image with:

```bash
gcloud builds submit session-runner --project pi-agents-cloud --tag us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest
```

Deploy Firebase resources with `--project pi-agents-cloud`.

When `functions/` code changes, deploy Cloud Functions before handing off unless the user explicitly asks not to deploy. Report the deploy command and outcome.
