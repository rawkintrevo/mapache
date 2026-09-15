#!/usr/bin/env bash
# Invoke with bash; credentials stay in the child environment, not git config.
set -euo pipefail
set +x

case "${1:-}" in
  gh|git) mode="$1"; shift ;;
  *) printf 'Usage: bash github.sh {gh|git} <arguments...>\n' >&2; exit 2 ;;
esac

# Prefer the installation-scoped credential for this connected workspace.
if [[ -n "${GITHUB_AUTOMATION_TOKEN:-}" ]]; then
  export GH_TOKEN="$GITHUB_AUTOMATION_TOKEN"
fi
export GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0
command -v gh >/dev/null || { echo 'GitHub CLI (gh) is required.' >&2; exit 127; }

if [[ "$mode" == gh ]]; then
  exec gh "$@"
fi
# Empty helper clears inherited helpers for this invocation only. gh supports
# an existing login too, when no runner token is present. Use HTTPS origin.
exec git -c credential.helper= -c 'credential.helper=!gh auth git-credential' "$@"
