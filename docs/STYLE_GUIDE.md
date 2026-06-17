# Style Guide

## Purpose

This page defines UI design and styling standards for the application.

## Read When

Read this before changing shared styling, component CSS, buttons, drawers, forms, iconography, or application layout.

This document defines the design and implementation standards for the application. The goal is to unify UI inconsistencies, improve maintainability, and create a predictable developer experience.

## 1. Design Philosophy

The application interface should be **clean, functional, and developer-focused**. Style decisions should prioritize clarity, hierarchy, and consistent interactions over decorative flair.

## 2. Foundational Tokens

All styles must transition to semantic variables to ensure consistency.

### Colors
Refactor existing CSS `:root` variables into semantic functional names:

| Variable | Description |
| :--- | :--- |
| `--color-bg-canvas` | Main background (`#f7f8fa`) |
| `--color-bg-panel` | Panel background (`#ffffff`) |
| `--color-text-main` | Primary text (`#17212b`) |
| `--color-text-muted` | Secondary/Help text (`#667085`) |
| `--color-accent` | Brand/Interactive (`#147d64`) |
| `--color-danger` | Destructive actions (`#b42318`) |
| `--color-border` | Lines and dividers (`#d9dee7`) |

### Typography
*   **Font Family:** `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;`
*   **Hierarchy:** Standardize H1, H2, H3 sizes and line-heights. Ensure consistent usage of font-weight for semantic meaning (e.g., bold for labels).

### Spacing & Grid
*   Implement a **4px-based spacing scale** (4, 8, 12, 16, 20, 24, 32px).
*   Use these values for all `gap`, `padding`, and `margin` properties. Avoid arbitrary pixel values.

### CSS Naming Convention
Adopt the **BEM (Block Element Modifier)** methodology to ensure modular, readable, and scalable CSS. This will help prevent naming collisions and make component styles more predictable.

### CSS File Ownership
Global CSS is layered from `src/styles.css`, which imports `src/styles/tokens.css`, `src/styles/base.css`, `src/styles/primitives.css`, and `src/styles/layout.css`. Keep design tokens, element defaults, shared controls, reusable primitives, and app-shell layout in those global files.

Component-owned selectors live beside their React component as plain CSS sidecars and are imported by that component. Use grouped sidecars only when related components intentionally share a local vocabulary, such as drawers, inspector panels, or modal surfaces. Do not introduce CSS Modules unless a future migration covers the whole touched component family.

### Iconography
The application will standardize on **Lucide** for all UI iconography to ensure visual consistency and accessibility.

Use the following Lucide icons for common action buttons:

| Button Type | Lucide Icon | Usage Notes |
| :--- | :--- | :--- |
| New / Create / Add | `Plus` | New workspace, create session, add authentication provider, and other create actions. |
| Refresh | `RefreshCw` | Refresh app state, files, authentication providers, and package lists. |
| Stop | `Square` | Stop a running terminal session; keeps the terminal/process-stop semantics of the old solid square. |
| Delete | `Trash2` | Delete sessions, providers, or other destructive removals. Prefer this over `X`, which is reserved for close/cancel. |
| Restart | `RotateCcw` | Restart sessions or retry/reset a running operation. |
| Update | `Download` | Fetch or install updated package/workspace bits. |

Adjacent controls should use:

| Button Type | Lucide Icon | Usage Notes |
| :--- | :--- | :--- |
| Close | `X` | Close modals, dialogs, and editors. |
| Expand / Collapse Drawer | `PanelLeftOpen`, `PanelLeftClose`, `PanelRightOpen`, `PanelRightClose` | Match the icon to the drawer side and current action. |
| Expand / Collapse Section | `ChevronRight`, `ChevronDown` | Used for drawer section disclosure controls. |
| Save | `Save` | Save file or form changes. |
| Sign out | `LogOut` | Account sign-out actions. |
| Profile | `User` | Profile/account entry points. |

## 3. Component Guidelines

### Buttons
Buttons must maintain consistent height, border-radius, and interactive states.
*   **Variants:** `primary` (default), `secondary`, `danger`, `icon-button` (compact).
*   **States:** Ensure explicit `hover`, `focus`, `disabled`, and `active` states.
*   **Icon Buttons:** All icon-only buttons must provide a descriptive `aria-label` and `title`/tooltip string for the button's action (e.g., 'New Session', 'Refresh Files'). Use the native/browser tooltip behavior from `title`; do not create custom tooltip/popover surfaces for simple button labels, including black-background/white-text tooltip elements.

### Drawers
Drawers should share a unified structure.
*   **Structure:** Every drawer must contain a header, a scrollable content area, and an optional footer.
*   **Behavior:** Toggle buttons should be positioned consistently, with uniform size and accessibility labels.
*   **Section header actions:** Actions displayed inline with a drawer section title in either sidebar, such as add workspace, create session, add auth provider, refresh, update all, or extension actions, must be compact, icon-only, secondary buttons with `aria-label` and native `title` tooltip text. Do not use labeled text buttons, primary buttons, or mixed variants for drawer section header actions.
*   **Listed items:** Workspaces, sessions, authentication providers, skills, and extensions must use the shared drawer list row primitives. Rows may expose different actions by domain, but common actions must reuse the same button treatment. Drawer row actions must be compact, icon-only, secondary buttons with `aria-label`/`title` text. Destructive row actions must use that same secondary button shape with only the destructive icon colored by `--color-danger`; do not use a larger labeled delete/remove button or a full danger-filled button in drawer rows.

### Forms & Inputs
*   Inputs, textareas, and selects must share the same height, border, and focus states.
*   Labels must be styled consistently (uppercase, small, bold, muted color).

## Related Docs

- [CSS decomposition](./css-decomposition.md)
- [Frontend architecture](./frontend-architecture.md)
- [UI components](./ui-components.md)
