# CSS Decomposition Plan

`src/styles.css` is currently the only frontend stylesheet imported by the app. It is about 2,300 lines and mixes design tokens, element defaults, shared controls, app shell layout, landing-page visuals, workspace/session UI, inspector panels, modals, the file editor, and responsive overrides.

## Decision

Use a hybrid plain-CSS structure:

- Keep global tokens, reset rules, base element styling, layout primitives, and shared UI primitives under `src/styles/`.
- Move component-specific selectors beside their React components as plain sidecar CSS files, imported by the owning component.
- Do not introduce CSS Modules for this cleanup pass. Existing components already use stable semantic class names, many selectors intentionally span small component families, and converting to modules would create high churn without solving the main maintainability issue.

This keeps the current class-name contract readable in JSX while shrinking the global stylesheet and making component edits local.

## Current Selector Clusters

- `:root`, base elements, `.button`, `.visually-hidden`, form controls, and headings are shared foundations.
- `.app`, `main`, `.topbar`, `.drawer`, `.workspace`, `.drawer-section`, `.drawer-toggle`, and `.icon` define shell and layout behavior.
- `.drawer-list-row`, `.row`, `.pill`, `.metric`, `.empty`, `.subtle`, `.toolbar`, `.form-row`, and `.session-actions` are shared UI primitives used by multiple component families.
- `.auth`, `.auth-panel`, `.landing-*`, and landing keyframes belong to `src/components/auth/`.
- `.profile-*` belongs to `src/components/profile/ProfilePage.jsx`.
- `.file-tree`, `.file-row`, `.file-error`, `.file-status`, and related file metadata selectors belong to `src/components/files/`.
- `.canvas-*`, `.terminal-placeholder`, `.details`, `.git-*`, and `.session-title` belong to `src/components/sessions/`, except reusable detail grids should stay global until they have a single owner.
- `.auth-center-*`, `.package-*`, `.skill-*`, `.known-package-row`, and `.pi-auth-selection-*` belong to inspector or modal components.
- `.modal-*`, `.checkbox-row`, `.pull-request-panel`, and `.file-editor-*` belong to `src/components/modals/`.
- The responsive rules at the end currently couple layout, drawers, workspace panels, Git status, profile usage, and forms. Split these with the components they affect as selectors move.

## Target Structure

Keep this global layer:

```text
src/styles.css
src/styles/tokens.css
src/styles/base.css
src/styles/primitives.css
src/styles/layout.css
```

`src/styles.css` should become an import manifest for global CSS only. Suggested responsibilities:

- `tokens.css`: `:root` color, spacing, sizing, shadow, radius, and typography variables.
- `base.css`: box sizing, body, typography defaults, form element defaults, and accessibility helpers.
- `primitives.css`: shared controls and reusable classes such as `.button`, `.pill`, `.metric`, `.empty`, `.subtle`, `.toolbar`, `.form-row`, and `.hidden`.
- `layout.css`: outer app shell primitives that cross component boundaries, including `.app`, `main`, `.workspace`, and global responsive shell layout.

Move component-owned styles beside components as focused sidecar files:

```text
src/components/auth/LandingPageScreen.css
src/components/auth/AuthScreen.css
src/components/layout/Topbar.css
src/components/drawers/Drawers.css
src/components/profile/ProfilePage.css
src/components/files/WorkspaceFileTree.css
src/components/sessions/SessionDetail.css
src/components/sessions/GitStatusPanel.css
src/components/inspector/InspectorPanels.css
src/components/modals/ModalStack.css
src/components/modals/FileEditorDialog.css
```

Prefer one CSS file per component when the selector set is large or isolated. Use a small grouped file only when components deliberately share a local vocabulary, such as drawer rows or inspector package/skill rows.

## Migration Order

Move CSS by component area, with one small verification step per move:

1. Extract global foundations into `src/styles/` while keeping `src/styles.css` as the single root import from `src/main.js`.
2. Move landing-page styles to `LandingPageScreen.css`. The landing page is isolated from the signed-in shell and has the largest self-contained selector block.
3. Move modal and file-editor styles to modal sidecar files. These selectors are isolated and easy to validate through modal flows.
4. Move drawer styles and shared drawer row styles together. Keep drawer list primitives grouped until row usage is fully audited across workspaces, sessions, auth entries, packages, and skills.
5. Move session and Git status styles after drawer styles, because session detail uses shared primitives and responsive shell behavior.
6. Move profile, file tree, and inspector panels once shared primitives are stable.

Avoid moving unrelated visual areas in the same pull request. Each migration should preserve class names unless the owning component is changed in the same commit with test or screenshot coverage.

## Rules For New CSS

- New component-specific selectors should live beside the component, not in `src/styles.css`.
- Keep names scoped by component or local domain prefix, such as `.git-status-*`, `.file-editor-*`, or `.landing-*`.
- Keep tokens and cross-app primitives global; do not duplicate token values inside sidecar CSS when a variable already exists.
- Add responsive rules next to the selector they modify after that selector has moved out of the global file.
- Do not use CSS Modules unless there is a future migration plan for the whole touched component family.

## Verification

For each extraction slice, run `npm run build`. For visual-risk slices, also inspect:

- landing page at `/`
- signed-in app shell at `/app`
- left and right drawer expanded/collapsed states
- session detail with terminal and preview tabs when available
- modal forms, including file editor and pull request modal
- mobile widths near 900px and 620px breakpoints

Frontend smoke coverage now exercises route gating, drawer panels, session selection, selected-session rendering, and key modal submissions so future CSS moves are safer in PR checks.
