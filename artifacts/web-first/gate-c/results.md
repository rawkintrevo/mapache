# Gate C implementation results

## Scope and decision

This change implements the runner-contained execution-authority,
process-fencing, mutation-barrier, immutable-checkpoint, restore-verification,
and orphan-cleanup slice for `pi-chrome`. It does not enable the image in
production. `MAPACHE_WEB_FIRST_ENABLED=false` remains in
`session-runner/Dockerfile.pi-chrome` because Gate A is incomplete and the
platform does not yet prove predecessor fencing or backend-only publication.

## Deterministic verification

The following local checks pass for the implementation:

```text
npm run check
npm --prefix session-runner run lint
npm --prefix session-runner test
```

`npm run check` passed, including the documentation link check, Functions
tests/lint, runner lint/tests, frontend tests, and both application builds.

The runner suite covers the existing behavior plus the new barrier, authority,
process-supervisor, checkpoint allowlist, session-tree, immutable object,
manifest-binding, workspace-sync, and restore-boundary helpers. The current
full runner result is 289 tests passed, 0 failed.

The new local evidence includes:

- simultaneous writer-reservation checks and conservative monotonic lease
  expiry; unconfirmed renewal fences the runtime;
- bounded child termination with an explicit unresolved-ownership error;
- new writes rejected during barrier closure and a stalled writer leaving the
  barrier blocked;
- credential/cache/archive exclusions and real tar listing inspection;
- stable session-tree parent/leaf validation;
- immutable fake-Storage uploads followed by paired Firestore pointer
  publication and exact manifest binding checks;
- cleanup refusal while publication is in flight and safe staging restore
  destination validation.

## Fault and platform matrix

| Case | Runner result | Evidence/status |
| --- | --- | --- |
| Renewal reply delayed or missing | Fences after the last confirmed monotonic deadline | Deterministic authority test; no live Cloud Run measurement. |
| Child ignores termination | Reports `execution_child_termination_unresolved` | Deterministic process-supervisor test. |
| Barrier writer stalls | Leaves admission blocked with `checkpoint_barrier_timeout` | Deterministic barrier test. |
| Payload upload fails or duplicates | No pointer transaction is attempted; immutable path is never overwritten | Fake-Storage/object precondition tests. |
| Manifest/payload generation or checksum mismatch | Verification stops with an explicit error | Manifest/object verification code and tests. |
| Prior pointer or workspace revision races | Firestore publication rejects the stale transaction | Fake Firestore publication test path. |
| Pending publication vs orphan cleanup | Cleanup refuses while a checkpoint is in flight and protects the committed pair | Service guard plus reference check. |
| Crash before/after payload, manifest, or pointer | Not yet automated as a live crash matrix | C23 remains open. |
| Predecessor uncertainty or detached child | New authority acquisition returns `execution_recovery_required`; detached arbitrary work is not claimed controlled | C03/C10 evidence is only runner-local; platform proof remains open. |
| Browser/Functions/legacy writer race | Not fenced by this runner-only change | C17/C18 remain open by design. |
| Snapshot size/upload/blocking cost | Not measured against Cloud Storage or a representative development server | C05 remains open. |
| Cloud Run background execution policy | Not measured in the target deployment | C24 remains open. |

## Deployment note

Only the `pi-chrome` image is in scope. The required build/publish command is:

```bash
cd session-runner
gcloud builds submit . --config cloudbuild.pi-chrome.yaml --project pi-agents-cloud
```

No Functions or frontend source change is part of this slice, so no Functions
deployment is required. Existing pi-chrome Cloud Run services need restart or
recreation to receive the new image revision.

Cloud Build completed successfully on 2026-09-10:

- build: `7925eaea-abd5-4949-9fc5-a404b0b64842` (5m25s);
- image: `us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome`;
- digest: `sha256:51da674cbbc415b52c205e2cd1a2bde5e9b25cba3272c70b4d119b9b64ef79e0`.

This pushes the image only; it does not restart or recreate existing Cloud Run
session services.
