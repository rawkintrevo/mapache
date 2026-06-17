# CSS Decomposition

## Purpose

This page records CSS ownership after the stylesheet split and gives maintainers a safe migration path for future styling changes.

## Read When

Read this before changing `src/styles.css`, files under `src/styles/`, component CSS sidecars, drawer/inspector/modal styles, or the app-wide style conventions.

## Canonical Owner

- Global stylesheet entry: `src/styles.css`
- Global layers: `src/styles/tokens.css`, `src/styles/base.css`, `src/styles/primitives.css`, `src/styles/layout.css`
- Component sidecars: `src/components/**/*.css`
- Style standards: [STYLE_GUIDE.md](./STYLE_GUIDE.md)

## Current Behavior

`src/styles.css` imports the global style layers. Tokens, element defaults, shared control primitives, and app-shell layout stay global. Component-owned selectors live beside React components as plain CSS sidecars and are imported by those components. Grouped sidecars are allowed when related components intentionally share a local vocabulary, such as drawers, inspector panels, modals, or session detail controls.

The app uses restrained operational styling: dense drawers, compact controls, predictable icons, terminal-first session layout, 8px-or-less radii for panels/cards, semantic color variables, and Lucide icons for standard actions.

## Migration Rules

- Keep design tokens and element defaults global.
- Keep reusable button/control/list primitives global only when used across component families.
- Move component-specific selectors into sidecars when touching that component.
- Avoid CSS Modules unless a future migration covers the whole touched component family.
- Do not create broad visual refactors while performing architecture/doc maintenance unless explicitly requested.

## Verification

- `npm run build`
- `npm run test:frontend` when component behavior is touched.
- Manual browser review for changed responsive layouts.

## Last Verified Assumptions

- 2026-06-17: The source tree contains global style layers and sidecars for auth, landing, drawers, files, inspector, layout topbar, modals, profile, and session components.

## Related Docs

- [Style guide](./STYLE_GUIDE.md)
- [Frontend architecture](./frontend-architecture.md)
- [UI components](./ui-components.md)
