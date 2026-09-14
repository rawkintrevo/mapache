# Task 26: Deploy a pinned canary and preview UI

Difficulty: medium. Depends on Tasks 1–25. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `docs/deployment.md`
- `session-runner/cloudbuild.pi-chrome.yaml`
- `docs/plans/pi-web-ui-tasks/README.md`

Use actual paths/IDs from prior task evidence, not guessed names. Read focused wiki pages before editing code.

## Ownership

Existing image build/deploy scripts and restricted canary release record.

## Steps

1. Run current local checks and build pi-chrome with an immutable source-revision tag using gcloud builds submit session-runner --config session-runner/cloudbuild.pi-chrome.yaml --project pi-agents-cloud and an explicit _IMAGE substitution.
2. Record the resolved digest; do not move the production pi-chrome tag. Deploy compatible Functions first if needed.
3. Create one recorded disposable workspace marked pi-web-ui-v1 through the controlled admin path, with existing QA auth and safe configured model credentials.
4. Deploy the frontend to a Firebase preview channel with --project pi-agents-cloud, and connect it to that canary. Verify CPU/scaling/IAM, private upstream port, and signed HTTP/WS access.
5. Record cleanup/rollback commands by exact ID. Keep the HubSpot source running on its original image/path.

## Acceptance criteria

- Canary uses the recorded immutable digest and expected API/runner service accounts.
- Preview loads the new canvas, while the unmarked HubSpot source remains unaffected.
- Cloud build, API revision, preview URL, canary IDs, and safe health checks are recorded.

## Validation

Cloud Build terminal success and digest lookup, deployed-template inspection, authenticated access smoke, source compatibility smoke.

Update affected canonical docs for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

No primary Hosting switch, source stop, or mutable production-tag promotion. All shared stop conditions apply. Leave this task unchecked if any required check fails or access is missing.

## Handoff

Record actual commands/results, safe evidence references, and any recovery actions under Task 26 in the root checklist. Commit before continuing to Task 27.

