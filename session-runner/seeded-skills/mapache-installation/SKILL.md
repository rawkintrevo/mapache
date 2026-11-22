---
name: mapache-installation
description: Install software with explicit lifetime and scope choices and verify executable and credential persistence in Mapache runtimes.
---

# Software installation in Mapache

Use this skill for requests to install a CLI, SDK, runtime, or other software
that must be usable by the current agent or terminal. Treat executable
persistence and login/configuration persistence as separate questions.

## Confirm lifetime and scope before changing anything

If either choice is not already explicit in the conversation, ask one concise
question that keeps them separate:

> Should this last only for the current running session or survive workspace
> restarts? Should it apply only to this project/workspace or to all of your
> workspaces?

Do not repeat a choice the user already made. “This project/workspace” means
the current workspace and its supported sessions. “All of my workspaces” is not
permission to change the runner image, an operating-system package set, or an
account-wide setting. First check whether a supported account or image
mechanism exists; otherwise explain the required follow-up and stop before
making a broader change.

If the installation may create files other workspace participants or processes
can read, mention that workspace scope is not access isolation. Do not equate
`.gitignore` with access isolation: it does not protect a file from other
workspace participants or processes.

## Inspect the actual runtime

Before selecting an install path, inspect the values and filesystem behavior
that determine persistence. Do not dump the environment or any credential
file.

```bash
printf 'HOME=%s\n' "$HOME"
printf 'HOME_SYNC_MODE=%s\n' "${HOME_SYNC_MODE:-unset}"
printf 'WORKSPACE_STORAGE_MODE=%s\n' "${WORKSPACE_STORAGE_MODE:-unset}"
printf 'MAPACHE_RUNTIME_STORAGE_MODE=%s\n' "${MAPACHE_RUNTIME_STORAGE_MODE:-unset}"
printf 'MAPACHE_HOME_DIR=%s\n' "${MAPACHE_HOME_DIR:-unset}"
printf 'HOME_STORAGE_BUCKET=%s\n' "${HOME_STORAGE_BUCKET:-unset}"
printf 'HOME_STORAGE_PREFIX=%s\n' "${HOME_STORAGE_PREFIX:-unset}"
printf 'MAPACHE_RUNTIME_ROOT=%s\n' "${MAPACHE_RUNTIME_ROOT:-unset}"
printf 'WORKSPACE_DIR=%s\n' "${WORKSPACE_DIR:-/workspace}"
printf 'MAPACHE_WORKSPACE_BIN_DIR=%s\n' "${MAPACHE_WORKSPACE_BIN_DIR:-unset}"
printf 'MAPACHE_USER_BIN_DIR=%s\n' "${MAPACHE_USER_BIN_DIR:-unset}"
printf 'PATH_PREFIX=%s\n' "${PATH%%:*}"
tool_name="<tool>"
tool_path="$(command -v "$tool_name" || true)"
printf 'tool_path=%s\n' "$tool_path"
test -d "$HOME" && test -w "$HOME" && echo 'HOME is writable'
test -d "${WORKSPACE_DIR:-/workspace}" && test -w "${WORKSPACE_DIR:-/workspace}" && echo 'workspace is writable'
df -T "$HOME" "${WORKSPACE_DIR:-/workspace}" 2>/dev/null || true
```

Also inspect the relevant login-shell startup file before changing `PATH`.
Never print `GOOGLE_APPLICATION_CREDENTIALS` contents, token files, or auth
configuration contents.

Use the result, not an assumed default:

- A legacy runner with `HOME_SYNC_MODE=persistent` uses the actual `$HOME`
  (normally `/root`) as an archived workspace runtime tree. Workspace-scoped
  installs belong in `/workspace/.local`; do not put them in `$HOME`.
- A shared workspace runner reports `WORKSPACE_STORAGE_MODE=shared-gcsfuse-v1`.
  Its `/workspace` is the durable project tree, while its private `$HOME` and
  the private runtime paths under `/var/lib/mapache/runtimes/` are ephemeral.
  The explicit `/root/.local` mount is the owner-wide durable install location;
  it remains valid even when `$HOME` is a private runtime directory.
- A missing or unexpected value is not proof of persistence. Re-check the
  resolved paths and report uncertainty instead of guessing.

## Choose an installation strategy

### Current running session only

Use an explicit session-local directory such as `/tmp/mapache-install` or the
runtime's private home. Keep the tool and any generated config there, prepend
its `bin` directory to `PATH` for the processes that need it, and state that a
stop, replacement, or restart removes it. A shell `export` affects only that
shell and is not a restart hook.

Do not use `apt-get` or another OS-level install to satisfy a session-only
request unless the user explicitly accepts an image/container change. An OS
package change made in a running container is lost with that container and does
not become available to other workspaces.

### Across restarts in this workspace

Use `/workspace/.local` for an installation that belongs only to the current
workspace. Put executables in `/workspace/.local/bin`; for example,
`npm install --prefix /workspace/.local <package>` or a tool's equivalent
explicit prefix. Mapache creates this directory, persists the whole tree with
the workspace, and places it first on PATH automatically. Do not edit shell
startup files to repair this PATH.

For `shared-gcsfuse-v1`, `/workspace` is durable but is a GCS FUSE mount, not a
normal local filesystem. Before installing there, test the exact operations the
tool needs: create, rename, execute, permissions, locking, and any symlinks or
temporary files. If those semantics are not supported, do not install a
package manager tree directly on the mount. Use the owner-wide location only
when the tool supports the mounted filesystem, or keep it session-local and
report that limitation.

### Across all workspaces for this user

Use the owner-wide mount at `/root/.local`, with executables in
`/root/.local/bin`; for example, `npm install --prefix /root/.local <package>`
or the tool's supported equivalent. The complete `/root/.local` tree is stored
in owner-scoped persistent Cloud Storage and mounted into every workspace
runner for that user, including new workspaces. `MAPACHE_USER_BIN_DIR` is the
canonical runtime-discovered bin path. Workspace-local PATH entries come first,
so a project can intentionally override a user-wide executable.

The owner-wide directory is a shared writable install surface for that user:
concurrent installs can race, and files placed there are available to every
workspace and automation owned by that user. The mount is backend-derived and
uses a different storage namespace for other users; do not copy credentials or
private project files into it.

For `shared-gcsfuse-v1`, both install locations use GCS FUSE. Before installing
a tool, test the exact operations it needs: create, rename, execute,
permissions, locking, and symlinks. Package managers or compiled tools that
require unsupported local filesystem behavior should remain session-local or
use a project-specific artifact strategy.

The same PATH is applied to interactive shells, the managed Agent process,
terminal commands, and automation subprocesses. It is ordered as
`/workspace/.local/bin:/root/.local/bin:<existing system PATH>` and is
initialized idempotently for every process; preserving a custom existing PATH
does not require shell startup files.

For tools that cannot use a persistent mount:

- A simple portable executable may be kept in a session-local directory such as
  `/tmp/mapache-install` only after testing it; invoke it through an explicit
  path or a verified project command and report that limitation.
- A tool needing local filesystem semantics, compiled caches, locks, or a
  private package tree should use a session-local root unless its documented
  installation strategy supports one of the persistent mounts.

Project dependencies should use the project's normal manifest and lockfile
when possible. Do not turn a project installation into a platform-wide
installation, and do not treat the workspace mount as a safe place for
credentials.

### OS-level availability

These paths do not change the runner image or install OS packages. If a tool
requires root-owned system locations, an image rebuild is a separate explicit
deployment decision; do not silently broaden a user-local installation into an
OS package or account-level setting.

## gcloud example

Treat `gcloud` as two independent checks: the executable and its login/config
state. First verify availability without exposing secrets:

```bash
command -v gcloud || echo 'gcloud is not installed'
gcloud version 2>/dev/null | sed -n '1,4p' || true
gcloud auth list --format='value(account)' 2>/dev/null || true
gcloud config configurations list --format='value(name,is_active)' 2>/dev/null || true
gcloud config get-value project 2>/dev/null || true
```

If `gcloud` is missing, use the vendor-supported archive or package method
that matches the selected lifetime. A temporary install belongs under the
session-local root. A verified legacy persistent-home install can use a
user-local `google-cloud-sdk` directory and a user-local `bin/gcloud` entry.
Avoid installers that silently edit shell startup files; inspect and update
the file the fresh login shell actually reads, then verify again.

For retained login state, inspect only safe account/config metadata and then
repeat the checks after an actual runner stop/start or container replacement.
`gcloud auth list` shows account identifiers, not proof that every token or
application credential will survive. `GOOGLE_APPLICATION_CREDENTIALS`, when
provided, is a separate application-default-credentials path; do not cat it,
copy it into Git or `/workspace`, or print an access token. Mapache-managed
credentials and Google Workspace connections remain owned by their managed
auth flows; do not replace them with an untracked shell login.

If the runtime cannot retain the requested gcloud login/config state, report
that separately from executable persistence. Do not claim that `gcloud` is
ready merely because `gcloud version` succeeded.

## Verify and report

After installation:

1. Verify the exact invocation with `command -v <tool>` and `<tool> --version`
   (or the tool's safe equivalent).
2. Start a fresh login shell or agent process and repeat the check, including
   `PATH` and any project-local wrapper.
3. For a restart-surviving request, perform an actual session stop/start or
   container replacement and repeat the check. A browser refresh is not enough.
   If that lifecycle cannot be exercised, say the restart check is unverified.
4. If login state matters, verify it separately using account names or other
   non-secret metadata. Never print credential contents or access tokens.

Report the installation path, selected lifetime, selected scope, invocation,
executable result, credential/configuration result, restart evidence, and any
limitation. Keep the distinction between “the binary exists,” “a fresh process
can find it,” and “the login/configuration state was retained.”
