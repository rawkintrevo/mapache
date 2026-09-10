# Gate D runner-only preparation

Date: 2026-09-10

This is not a canary report. Gate A is not passed, and Gate C still has open
predecessor-fencing, external-writer, and backend-publication work. The shared
web-first owner remains disabled in the published image.

## Selected configuration

- Image: `pi-chrome`
- Pi: `0.84.1`
- Goals package: `pi-goal-x@0.31.2`
- MCP adapter: `pi-mcp-adapter@2.32.1`
- Browser MCP: `chrome-devtools-mcp@1.6.0`
- Web-first adapter revision: `gate-a-0.1.0`
- Published integration mode: `legacy`
- Published web-first flag: `MAPACHE_WEB_FIRST_ENABLED=false`

An isolated canary would require both
`MAPACHE_RUNNER_INTEGRATION_MODE=web-first` and
`MAPACHE_WEB_FIRST_ENABLED=true`. No test account, workspace, hosted session,
or production canary was used for this runner-only preparation.

## Implemented and verified

- Missing mode metadata resolves to legacy behavior.
- Composition rejects a legacy Goals RPC owner alongside the shared web-first
  owner.
- Adapter handshakes report tested capabilities and reject pinned package,
  adapter, and explicitly reported extension incompatibilities.
- Terminal completion hooks receive explicit reasons; mode-switch, authority
  loss, and runner shutdown do not run Git completion automation.
- Focused runner tests pass, including the Gate A/B/C regression coverage.

## Deliberately not released

The current adapter still reports command expansion, structured dialogs, reload,
and session replacement as unsupported. D05–D19 therefore remain release work;
in particular, this artifact contains no browser QA evidence, migration or
rollback rehearsal, evaluation-period metrics, or canary stop-condition signoff.

## Build and deployment record

Commands:

```bash
gcloud builds submit session-runner \
  --config session-runner/cloudbuild.pi-chrome.yaml \
  --project pi-agents-cloud
```

The resulting Artifact Registry digest and Cloud Run revision are recorded in
the handoff after the image build completes. No Functions or Hosting deploy is
required for this runner-only change.
