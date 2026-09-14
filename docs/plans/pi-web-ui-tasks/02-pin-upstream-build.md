# Task 2: Add the pinned upstream build and patch manifest

Difficulty: medium. Depends on Tasks 1–1. Implementation status is tracked only in [the root checklist](../../../task_list.md).

## Goal and starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then inspect:

- `session-runner/Dockerfile.pi-chrome`
- `session-runner/cloudbuild.pi-chrome.yaml`
- `docs/plans/pi-web-ui-tasks/decisions.md`

Paths above are repository-relative. Upstream paths referenced below are relative to the pinned source prepared in Task 2. Read focused wiki pages before editing their owners.

## Ownership

New session-runner/upstream/pi-web-ui/ build metadata, patch files, and build helper.

## Steps

1. Fetch the exact commit in the fixed decisions, verify its revision, retain LICENSE, and record package/lockfile hashes in a checked-in manifest. Fetch into the runner build context during a reproducible build, not at runtime.
2. Use upstream npm ci and its build scripts with the pinned lockfile. Resolve and pin the compatible Pi SDK and existing pi-mcp-adapter dependency versions; record the source evidence.
3. Add an ordered patch application command that fails on a mismatched baseline. Keep patched source/build outputs generated and ignored; keep only manifest, scripts, license, and patches in Git.
4. Produce a build artifact with the upstream server and web output and a safe version descriptor for runtime health.

## Acceptance criteria

- A clean build produces the same pinned source/dependency inputs and reports the expected commit/version.
- Wrong revision or patch mismatch fails the build.
- No floating startup install, submodule, copied credentials, or unrelated upstream source dump is introduced.

## Validation

Build from a clean temporary directory; exercise wrong-revision/patch rejection; run upstream typecheck and relevant tests.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Apply the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not launch a cloud runner or upgrade upstream to fix unrelated problems. The shared stop conditions apply; do not skip this task if access or an acceptance gate is blocked.

## Handoff

Add a short Completed or Blocked note under Task 2 in the root checklist. Record actual owner paths, commands/results, non-secret evidence references, and any contract refinements needed by Task 3. Check the box only after all criteria pass.

