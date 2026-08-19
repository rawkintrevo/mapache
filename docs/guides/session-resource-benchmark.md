# Session Resource Benchmark

This checklist records how to validate the resource catalog before changing the Small mapping. It is intentionally separate from the default PR checks because it creates billable Cloud Run revisions and requires Cloud Monitoring evidence.

## Pass rule

An image/allocation/workload combination passes only when it has no OOM termination or restart and the observed peak memory leaves at least 25% headroom. Run startup/restore, idle terminal, harness startup, and a representative workspace task for every standard image. Add dependency install/build and Preview QA for web images; add browser startup, one QA navigation, and terminal use while Chrome remains open for Chrome images. Run each combination at least three times, or record why a different sample is sufficient.

The routine matrix is `default`, `pi-basic`, `codex-basic`, `pi-web`, `codex-web`, `pi-chrome`, and `codex-chrome`. Skip `pi-n64` unless a separate N64 change is in scope. Capture the image, allocation, workload, run number, peak memory, restart/OOM evidence, revision/log links, and result. Remove every temporary workspace, session, and Cloud Run service after the run.

## Current catalog baseline

The implementation baseline uses the conservative candidate `Small = 1 vCPU / 2 GiB`, with no image-specific mapping. Medium is `2 vCPU / 4 GiB` and Large is `4 vCPU / 8 GiB`. The existing `1 vCPU / 1 GiB` allocation remains valid compatibility context and renders as `Custom`; it is not used as the new Cloud-session default.

| Image | 1 vCPU / 1 GiB context | 1 vCPU / 2 GiB candidate | Image-specific override |
| --- | --- | --- | --- |
| `default` | Existing compatibility allocation; peak evidence required | Catalog Small candidate; run startup, idle shell, and workspace task | None configured |
| `pi-basic` | Existing compatibility allocation; peak evidence required | Catalog Small candidate; run Pi startup and workspace task | None configured |
| `codex-basic` | Existing compatibility allocation; peak evidence required | Catalog Small candidate; run Codex startup and workspace task | None configured |
| `pi-web` | Existing compatibility allocation; peak evidence required | Catalog Small candidate; include install/build and Preview QA | None configured |
| `codex-web` | Existing compatibility allocation; peak evidence required | Catalog Small candidate; include install/build and Preview QA | None configured |
| `pi-chrome` | Existing compatibility allocation; peak evidence required | Catalog Small candidate; include Chrome and terminal coexistence | None configured |
| `codex-chrome` | Existing compatibility allocation; peak evidence required | Catalog Small candidate; include Chrome and terminal coexistence | None configured |

The catalog mapping must not be changed based only on a startup success. If measured peak memory fails the pass rule, update the catalog and its tests together, and record the image-specific reason here and in the parent sizing issue. The posted us-central1 rate formula used for the current candidate is `(vCPU × 0.000018 + GiB × 0.000002) × 3600`; it produces `$0.0792/hr` for Small before free tier, discounts, network, storage, build, and other charges.

## Evidence status

The checked-in QA allocation coverage establishes the implementation candidate and compatibility paths, but a formal three-run Cloud Monitoring matrix is an operational release check rather than a local unit-test step. Do not describe the candidate as a measured memory floor until the temporary-service run has attached revision metrics and logs to issue #176.
