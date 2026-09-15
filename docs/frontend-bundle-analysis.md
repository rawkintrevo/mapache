# Frontend Bundle Analysis

## Purpose

This page records the measurement behind frontend chunk boundaries. Bundle work
must reduce initial transfer or defer code outside the terminal-first path; it
must not split chunks merely to remove Vite's size warning.

## Reproducing the report

Run:

```bash
npm run analyze:bundle
```

The command creates a production build with source maps and reports the entry
chunk's minified and zlib level-9 gzip sizes for every initial and lazy asset. `scripts/analyze-vite-bundle.mjs` attributes generated source-map spans to packages and source files without adding a bundle analysis dependency. The attribution is an estimate; the emitted asset byte counts remain the authoritative before/after totals.

## Issue 331 measurements

Measurements were taken from `main` immediately before the issue 331 changes
and from the implementation branch after them, both with Vite 8.0.16.

| Initial asset | Before | After | Change |
| --- | ---: | ---: | ---: |
| Main JavaScript, minified | 633,599 B | 620,657 B | -12,942 B (-2.0%) |
| Main JavaScript, zlib level-9 gzip | 189,516 B | 185,352 B | -4,164 B (-2.2%) |
| Initial CSS, minified | 25,469 B | 19,925 B | -5,544 B (-21.8%) |
| Initial CSS, zlib level-9 gzip | 5,333 B | 4,274 B | -1,059 B (-19.9%) |
| Main JS + shared Button JS + initial CSS, zlib level-9 gzip | 198,056 B | 192,833 B | -5,223 B (-2.6%) |

Opening Logs now fetches its feature assets: 2,627 B JavaScript (1,114 B zlib level-9 gzip), a shared 393 B modal-backdrop chunk (313 B gzip), and 5,545 B CSS (1,565 B gzip). Its existing loading, empty, runtime-error, and request-error
states remain unchanged; the shell displays a lazy loading fallback while the
feature chunk loads.

The before-build source-map attribution covered 99.8% of the main chunk. Its
largest contributors were:

| Contributor | Attributed minified bytes |
| --- | ---: |
| `react-dom` | 178,417 B |
| `@firebase/firestore` | 172,951 B |
| Application source | 97,176 B |
| `@firebase/auth` | 85,613 B |
| `@firebase/webchannel-wrapper` | 50,751 B |
| `@firebase/storage` | 10,709 B |
| `@firebase/util` | 9,520 B |
| `@firebase/app` | 9,203 B |
| `lucide-react` | 5,429 B |

Firebase Storage had no application consumer and was removed from startup.
React DOM, Auth, Firestore, and WebChannel remain eager because authentication,
workspace/session discovery, and the terminal-first shell require them.

## Startup conclusion and boundaries

The stale roughly 902 kB issue baseline had already fallen to 633.6 kB before
this work. The current warning is mostly startup-critical framework and Firebase
code. The justified changes reduce the representative initial gzip payload by
only 5.2 kB (2.6%), so bundle weight is not presently a material bottleneck for
the intended personal-use workflow. Manual vendor chunks would silence or move
the warning without reducing initial transfer and are therefore not configured.

Keep these user-triggered surfaces lazy:

- landing page for signed-in app routes;
- admin and profile pages;
- the modal stack;
- session Logs.

Keep `WorkspacePanel`, `SessionDetail`, `ManagedAgentSurface`, `PiWebUiCanvas`,
and `BrowserCanvas` eager. These components are small relative to Firebase and
React, and they own terminal-first rendering, iframe identity, access renewal,
and stateful canvas connections. Deferring them would add a request and loading
state directly to the primary workflow.

## Owners

- Build configuration and report command: `vite.config.js`, `package.json`, and
  `scripts/analyze-vite-bundle.mjs`
- Lazy rendering boundaries: `src/App.jsx` and
  `src/components/layout/AppShell.jsx`
- Firebase startup: `src/services/auth.js`

## Verification

```bash
npm run analyze:bundle
npm run test:frontend
npm run build
npm run docs:check
```

## Related docs

- [Frontend architecture](./frontend-architecture.md)
- [Testing](./testing.md)
