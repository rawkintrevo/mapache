# Mapache repository review

Reviewed 2026-09-04 at commit `c25efee`.

## Overall assessment

**This is a reasonably organized personal application with unfinished architectural cleanup. Keep the architecture; improve a few boundaries.** It has substantial test coverage, useful developer documentation, and many focused services. It is not dominated by enormous source files. The bigger issue is that some of the extracted modules still share enough mutable state and implicit dependencies that changing one feature requires understanding several others.

For your use case, the maintenance priorities are predictable session behavior, preserving work, and making changes without breaking unrelated features. I would spend effort on frontend state ownership, async request lifetimes, and backend dependency boundaries before security hardening, scaling infrastructure, or adopting another framework. This is a maintainability review, not a security audit.

## What the repository contains

| Area | Role | Assessment |
| --- | --- | --- |
| `src/` | React/Vite app; Firebase login; workspace/session selection; terminals, files, Git and agent-management UI | Good component extraction, but application state and orchestration remain tightly coupled. |
| `functions/` | Firebase API, workspace persistence, Cloud Run provisioning, GitHub and Google integrations | Many sensible service boundaries; a few broad services and business logic remain in the entrypoint. |
| `session-runner/` | Container runtime, PTY/WebSockets, previews, SSH, workspace synchronization, Pi/Codex integrations | Generally the clearest lifecycle and service composition; terminal implementation is a notable mixed-responsibility file. |
| `community/` | Separate Docusaurus user documentation/site | Sensible separation from developer documentation. Included in the full build. |
| `docs/`, `adrs/` | Developer knowledge and design decisions | Valuable maintenance aids. Some pages accumulate feature history and stale wording. |
| `.github/workflows/`, `scripts/` | Verification, deployment, runner-image generation/builds | Canonical verification is shared by preview and production CI. Test discovery needs improvement. |

The main runtime path is **React app → Functions API/Firestore → per-session Cloud Run runner → workspace storage/GitHub**. That complexity reflects the product: persistent cloud terminals with multiple agent harnesses need coordination across systems even with one main user.

### Size snapshot

Counts below cover tracked `.js`, `.jsx`, `.mjs`, and `.css` files in the three application areas, excluding `*.test.*`. Lines include whitespace and comments; these are navigation aids, not complexity scores.

| Area | Files | Lines | Files over 400 lines |
| --- | ---: | ---: | ---: |
| Frontend | 138 | 15,427 | 2 |
| Functions | 55 | 10,201 | 5 |
| Runner | 88 | 12,139 | 4 |

The largest relevant files are:

| File | Lines | Interpretation |
| --- | ---: | --- |
| `functions/cloudRun.service.js` | 801 | Provisioning, reconciliation, environment construction, and cloud transport combined. |
| `functions/index.js` | 736 | Dependency wiring plus substantial business operations. |
| `functions/workspace.service.js` | 703 | Workspace lifecycle, source policy, storage operations, and validation combined. |
| `src/main.js` | 591 | Startup, state/rendering, dependency wiring, and several domain workflows. |
| `functions/githubClient.service.js` | 521 | Larger, but GitHub transport/auth is a more coherent boundary; lower priority than the files above. |
| `session-runner/lib/terminal.js` | 513 | Server PTY logic, Pi session discovery, and browser HTML/CSS/JS in one file. |
| `session-runner/lib/workspaceArchives.service.js` | 457 | Complex but substantially cohesive archive policy and transfer behavior. |
| `src/components/sessions/SessionDetail.jsx` | 401 | Session canvases, metrics, lifecycle presentation, sharing/publishing, Git, and SSH controls. |

Do not turn these into a blanket line-count limit. A 500-line cohesive service can be easier to maintain than ten small files sharing an unrestricted state object.

## Findings, in priority order

### 1. Frontend state has two competing update models

**Priority: high. Confidence: directly observed.**

Evidence: [store implementation](src/state/appStore.js#L84), [rendering](src/main.js#L199), [initial state](src/state/initialState.js), [resetters](src/state/resetters.js), and [application shell](src/components/layout/AppShell.jsx).

The app has reducer actions, but `createAppStore()` copies reducer results back into the same state object using `Object.assign`. Controllers and workflows also mutate that object directly. React rendering is explicitly requested through passed-in `render` callbacks; the root does not subscribe to the store.

Consequences:

- An update's correctness depends on both changing the right state and arranging a later render.
- Workflows receive the entire mutable application state, so file extraction does not establish a strong ownership boundary.
- Reset logic must stay synchronized with independently added fields and modal flags.
- The store's stable object identity is incompatible with simply treating `getState()` as an immutable snapshot for a future `useSyncExternalStore` integration. Direct mutations also bypass its subscribers.

This is an explicitly documented migration bridge, which is reasonable temporarily. It becomes expensive if every new feature has to support both approaches indefinitely.

**Recommendation:** finish the transition one domain at a time. Pick one feature, give it explicit actions and a state slice, and make its updates drive rendering through a consistent subscription boundary. Ensure snapshots change identity when state changes. Retain adapters for unmigrated workflows. A new state-management package is optional; clear ownership matters more than the library.

**First extraction:** move Pi models and SSH forwarding out of `main.js`; later narrow the large `piPanelsController` into the domains it already delegates to. Keep startup and service wiring together.

### 2. Async request ownership is inconsistent

**Priority: high for future changes; current user impact varies by path.**

Evidence: [session lifecycle workflows](src/workflows/sessionLifecycle.js#L3), [Pi models loading/saving](src/main.js#L492), and the existing [session request tracker](src/utils/sessionRequest.js).

Some selected-session panel loads already capture identity and ignore stale responses. Other operations read `state.selectedWorkspaceId` again after an `await`, or write results into shared state without checking whether their original session is still selected.

I reproduced this sequence with the actual `restartSessionState` function and a deferred mock API:

1. Begin restarting `session-A` in `workspace-A`.
2. Change the state selection to `workspace-B/session-B` before the restart resolves.
3. Resolve the restart.
4. The workflow lists sessions for **workspace B**, then selects **session A** inside that view.

**Qualification:** the topbar disables workspace selection while a busy operation runs, so this harness demonstrates a latent workflow weakness, not a verified ordinary click-path bug. The workflow depends on UI blocking to preserve its invariant. Pi model loading/saving also lacks the identity checks already used by other panel loaders; I did not reproduce those paths in a browser.

**Recommendation:** capture `{workspaceId, sessionId, api}` at operation start, use those values for subsequent API calls, and only update the selected view if the operation still belongs to it. Let remote operations complete when appropriate, but discard obsolete presentation updates. Add deferred-response regression tests for switching selection, signing out, and overlapping requests. Keep independent request generations separate where one feature's refresh should not invalidate another's work.

This is a stronger reason to refactor state boundaries than the size of `main.js` alone.

### 3. Cloud Run provisioning combines several independently changing concerns

**Priority: medium-high. Confidence: directly observed.**

Evidence: [provisioning orchestration](functions/cloudRun.service.js#L46), [attempt claiming](functions/cloudRun.service.js#L154), [service specification](functions/cloudRun.service.js#L362), and [runner environment construction](functions/cloudRun.service.js#L425).

The largest service owns provisioning attempts, retry/reconciliation behavior, Cloud Run create/patch/delete, environment and credential composition, harness-specific settings, and Firestore lifecycle updates. A new agent capability and a provisioning retry fix can both require changes in this file despite having different reasons to change.

There is also repeated successful-provisioning bookkeeping across ordinary success, existing-service adoption, and timeout reconciliation. Each path must keep lifecycle and image metadata aligned.

**Recommendation:** split along these boundaries:

- Runner configuration/environment construction, with credential resolution supplied explicitly.
- Cloud Run transport and operation polling.
- Provisioning orchestration and persisted outcomes.

Keep the orchestration readable as one sequence. Extract common completion bookkeeping without erasing the different recovery conditions. Preserve the existing retry and reconciliation tests; these behaviors are valuable, not incidental complexity to delete.

### 4. Backend factories only partially isolate their dependencies

**Priority: medium-high, especially when modifying backend tests. Confidence: directly observed.**

Evidence: [backend context](functions/backendContext.js), [workspace factory](functions/workspace.service.js#L39), and [Cloud Run project resolution](functions/cloudRun.service.js#L764).

`backendContext.js` initializes Firebase clients during import. Some service methods use injected dependencies, while others still use imported singleton clients. For example, the workspace factory returns file operations that use module-level `db`/`admin`; `renameWorkspace` supports injected clients. Cloud Run client acquisition can use `dependencies.auth`, while project ID lookup falls back to the imported `auth`.

This makes the apparent contract of a factory misleading: injecting a test dependency does not necessarily isolate the service from ambient configuration. It also makes pure helper imports pull in backend initialization.

**Recommendation:** resolve dependencies once in each service factory and consistently use those resolved values. Put pure normalization helpers in modules that do not initialize Firebase. Keep production initialization in the composition layer. Do this as services are touched; no dependency-injection framework is needed.

### 5. The Functions entrypoint and workspace service retain broad responsibilities

**Priority: medium. Confidence: directly observed.**

Evidence: [entrypoint operations](functions/index.js#L470), [reservation transactions](functions/index.js#L551), [runner HTTP requests](functions/index.js#L700), and [workspace service](functions/workspace.service.js).

A large entrypoint is not automatically a problem: explicit service construction and route registration belong there. Here, however, `index.js` also implements session enrichment, runner file synchronization, SSH provisioning preparation, workspace reservation transactions, and runner HTTP error handling.

`workspace.service.js` similarly contains workspace CRUD, GitHub/SSH source normalization, home/sync policy, Cloud Storage file CRUD, directory representation, and download links. Its helper tests import this broad module to test basic path and source functions.

**Recommendation:** extract reservation policy/transactions, runner transport, and file-sync orchestration from `index.js`. Keep Chrome/GitHub reservation invariants and writer-lease updates atomic; do not split transaction steps into separate remote operations merely to shorten functions. Split workspace metadata/lifecycle from workspace files/storage and pure source/path policy. Prefer a handful of clear modules over a generic repository framework.

### 6. Terminal server and browser code share one source file

**Priority: medium; a good bounded refactor. Confidence: directly observed.**

Evidence: [PTY service](session-runner/lib/terminal.js#L10), [Pi command normalization](session-runner/lib/terminal.js#L235), and [HTML renderer](session-runner/lib/terminal.js#L326).

The same file owns process spawning, socket replay, activity tracking, Pi JSONL discovery, command-line behavior, and a template literal containing the browser terminal's CSS and JavaScript. Editing keyboard/focus handling means working inside a Node server module. Syntax checking that module does not parse the JavaScript inside its HTML string as browser code.

**Recommendation:** separate the PTY/socket service, Pi session-selection helpers, and terminal browser assets/template. Preserve one clearly documented message protocol. Before changing browser behavior, retain regression checks for replay, resize, reconnect, and mobile input; the wiki documents specific xterm assumptions that a cosmetic rewrite could break.

The runner's existing route registrars and lifecycle coordinator provide a good pattern to follow.

### 7. Verification passes, but test selection is fragile and “lint” is only syntax checking

**Priority: fix the omission now; improve tooling incrementally. Confidence: directly verified.**

Evidence: [Functions scripts](functions/package.json#L4), [runner scripts](session-runner/package.json), and [root verification](package.json).

The Functions test script manually enumerates files in a long `&&` chain. It contains **`node github.service.js` instead of `node github.service.test.js`**. Comparing tracked Functions test files with `test`/`pretest` identified that omitted test. I ran it directly and it passed, so this is a verification gap rather than an observed failing implementation.

The commands named `lint` run `node --check`. They catch syntax errors but do not provide unused-variable, React hook, or broader static correctness checks. The root has no dedicated frontend lint/type-check step.

**Recommendation:** fix the filename, then use discovered test files or a small runner so adding a test does not require editing a long package-script string. Existing assertion scripts can be retained during migration. Add a modest correctness-oriented lint configuration; do not start with a repository-wide formatting rewrite. JSDoc/checkJs or gradual types around session records, workflow state, and service dependencies would be more useful than an immediate all-files TypeScript conversion.

The existing tests are a real asset. The missing coverage worth adding first concerns asynchronous composition, not arbitrary coverage percentages. The large `AppShell.smoke.test.jsx` builds mock handlers and checks UI wiring; it cannot establish that the real `main.js` orchestration handles races correctly.

## What is already working well

- **Subsystem boundaries are recognizable.** The app, API, runner, and documentation site are appropriately separated. There is no justification here for more deployable services.
- **Runner composition is comparatively clear.** `server.js` wires focused services and route registrars; `runnerLifecycle.js` makes startup/shutdown ordering visible. The shared WebSocket upgrade router and workspace sync coordinator centralize tricky invariants.
- **Shared catalogs reduce drift.** Runner capabilities and resource sizing have canonical data sources. The generated runner catalog passed its freshness check.
- **Styles are already decomposed.** Global layers and component sidecars are a reasonable solution for this application. A CSS architecture migration is not a priority.
- **There are meaningful regression tests.** Provisioning recovery, workspace sync serialization, WebSocket routing, and frontend workflows have local tests. Preserve these while changing boundaries.
- **Developer documentation provides actual implementation context.** Keeping it separate from user-facing `community/` is useful.

## Lower-priority cleanup

`SessionDetail.jsx` is approaching the point where extracting preview sharing/publishing and SSH forwarding would help. It already delegates access URLs, metrics, and chat behavior to focused hooks/components, so finish that pattern as those areas change.

The Vite build reports a main JavaScript chunk of about **902 kB minified / 265 kB gzip**. Investigate with a bundle report if startup feels slow; this does not prove that a particular feature is responsible. Existing lazy admin/profile/modal surfaces are useful. For a small personal audience, state correctness has higher value than chasing this warning alone.

Some wiki pages contain outdated scaffolding: `docs/testing.md` still describes runner helper tests as “Future” and frontend smoke tests as “once added,” even though both exist. Other architecture pages carry long feature-by-feature narratives. Request a separate focused documentation cleanup when this starts hindering navigation; a broad rewrite is unnecessary for this review.

## Suggested order of work

1. **Small verification repair:** correct the GitHub test command and remove the need to enumerate every test manually.
2. **Frontend correctness:** extract Pi model operations, capture request identity consistently, and test late responses with deferred promises.
3. **Frontend ownership:** migrate one complete feature slice to a consistent store/render model. Use it as the pattern for later changes.
4. **Backend cleanup:** isolate Cloud Run configuration/transport and make dependency injection consistent in the touched modules.
5. **Bounded extractions:** separate terminal browser code, workspace file services, and entrypoint reservation operations as relevant work arises.

Success means a feature change has an obvious owner, can be tested without unrelated infrastructure, and does not require tracing shared mutations through the whole application. Do not optimize for the smallest possible files.

## Validation and limits

- `npm run check` completed successfully: developer-doc links, Functions tests/syntax checks, runner syntax/tests, frontend tests, Vite build, and Docusaurus build.
- Runner: **231 tests passed**. Frontend: **40 test files / 138 tests passed**. Functions uses multiple assertion scripts rather than one aggregate count.
- `node functions/github.service.test.js` passed separately; the canonical command currently omits it.
- `node scripts/generate-runner-catalog.mjs --check` passed.
- A local, mocked invocation reproduced the lifecycle workflow selection mismatch described above. No live API calls were needed for that reproduction.
- Review included tracked-file metrics, architecture documentation, key entrypoints/services/controllers, representative tests, and CI configuration. It was not an exhaustive audit of every module.
- No browser QA, live Cloud Run provisioning, image builds, security audit, or deployment was performed. Application code was not changed. This report is the only intended repository change.
