# Frontend Architecture

## Purpose

This page owns the current frontend architecture: state ownership, React rendering boundaries, workflow modules, and UI/component routing.

## Read When

Read this before changing frontend startup, workspace/session state, modals, drawers, terminal/preview placement, Git controls, Pi panels, file workflows, or shared app styling.

## Canonical Owner

- Startup and global state: `src/main.js`
- React root: `src/App.jsx`
- Shell and layout: `src/components/layout/`
- Domain workflows: `src/workflows/`
- UI controllers: `src/controllers/`
- API client: `src/services/api.js`
- Component inventory: [ui-components.md](./ui-components.md)

## Current Behavior

The frontend uses Vite and React. `src/main.js` initializes Firebase/Auth, owns the top-level app state, coordinates selected workspace/session subscriptions, and passes grouped handlers into React. `src/App.jsx` chooses between the public landing page, fatal error surface, and signed-in app shell.

The signed-in shell is componentized under `src/components/`. `AppShell` owns the outer app wrapper, drawers, workspace panel, profile page, right inspector drawer, and modal stack. The Profile page includes account details, runner usage, and account-level GitHub connector controls for status, OAuth restart/connect, repository refresh, installation settings, and soft disconnect. The selected-session experience is terminal-first; runner-dependent panels reset while a selected session is provisioning, stopped, failed, or missing `serviceUrl`.

Preview-capable sessions show Preview, Share Preview, and Publish actions in `SessionDetail`. Share Preview calls the authenticated API to export the static build and then displays a copyable public preview URL. Publish is intentionally informational in V1 and directs users to contact `trevor@ata.systems`; it must not imply a production deploy happened.

The left drawer exposes session creation only from the Sessions section header for the selected workspace; workspace rows do not duplicate that action. The left drawer user menu shows an Admin item only when the current profile includes `isAdmin: true`. The Admin page lives in `src/components/admin/AdminPage.jsx` and reads paginated user summaries through `src/services/api.js`; `src/main.js` owns the admin page cursor stack, refresh, and whitelist toggle handlers.

Workflow modules under `src/workflows/` own cohesive API/state sequences such as session lifecycle, GitHub connection and repository refresh, Git/PR operations, Pi auth, Pi packages, Pi skills, and workspace file/editor actions. Controller modules under `src/controllers/` own drawer toggles, modal visibility, file tree/editor handlers, and right-panel handlers so `src/main.js` does not keep growing flat callback lists.

## Styling

Global CSS enters through `src/styles.css`, which imports `src/styles/tokens.css`, `src/styles/base.css`, `src/styles/primitives.css`, and `src/styles/layout.css`. Component-specific selectors live beside their React components as plain CSS sidecars when practical. See [css-decomposition.md](./css-decomposition.md).

## Invariants

- Keep terminal-first selected-session behavior.
- Keep `src/main.js` as the state orchestration point until a touched area is deliberately extracted.
- Add new feature logic to focused controllers, workflows, services, or components instead of expanding monoliths.
- Update [ui-components.md](./ui-components.md) when adding significant components.
- Keep `community/` out of frontend app refactors unless the task explicitly targets user-facing community docs.

## Verification

- `npm run test:frontend`
- `npm run build` for frontend-facing changes when feasible.
- `npm run docs:check` after docs edits.

## Last Verified Assumptions

- 2026-06-17: Source tree contains React component sidecars, controller modules, workflow modules, and global style layers matching this page.

## Related Docs

- [App overview](./app-overview.md)
- [UI components](./ui-components.md)
- [Style guide](./STYLE_GUIDE.md)
- [CSS decomposition](./css-decomposition.md)
