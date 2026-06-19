# Workspace Guidance

- Use checked-in skills under `.agents/skills/` for recurring Mapache workflows.
- Treat `/workspace/.codex/config.toml` as project config. Codex session state, auth, logs, and sessions live under `$CODEX_HOME`.
- For browser preview work, build static output into `/workspace/build` or configure `/workspace/.mapache/preview.json` for proxy mode.
- Store preview QA evidence under `/workspace/.mapache/qa` or `artifacts/qa/` inside the workspace when the task needs saved screenshots and reports.
