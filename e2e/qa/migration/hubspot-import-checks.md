# HubSpot migration QA checks

These checks are restricted migration evidence, not ordinary browser QA. Run
them only against an immutable Task 23 backup and an explicitly isolated
rehearsal target. Do not use the production HubSpot workspace, its source
prefix, or its live runner as a target.

1. Verify the backup with the Task 24 importer using the exact recorded source
   mapping and a new owner/workspace/session identity.
2. Run the importer in its default no-write mode and review the planned target
   roots. The fixed layout is `/workspace`, flat Pi sessions,
   `/var/lib/mapache/agent/pi`-equivalent non-secret config, and UI data.
3. Run `--execute` only on the empty rehearsal target. Save the generated
   comparison report outside Git. It must include the manifest checksum,
   copied/skipped counts, per-file hashes, history discovery/open counts,
   branch counts, trailing-record policy, intentional `pi-goal-x` settings
   changes, and an empty error list.
4. Run `--verify-only` against the installed rehearsal target. Repeat the
   command to prove idempotence. Add a new target file and prove that the
   importer refuses to overwrite it before removing the fixture.
5. Open every imported history through the pinned Pi SDK list/open path and
   perform at most one inert explicit resume prompt. The prompt must not use
   tools, write to HubSpot, or start a Goal loop.

Public evidence may contain only IDs, manifest/report checksums, counts,
statuses, safe error codes, and artifact paths. Never include transcript text,
credential values, auth files, cookies, browser-profile data, MCP bearer data,
or live storage object bodies. Keep the original backup unchanged for rollback.
