#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <remote-vm-runner-image@sha256:digest> <output-directory>" >&2
  exit 64
fi
if [[ ! "$1" =~ @sha256:[0-9a-fA-F]{64}$ ]]; then
  echo "remote VM runner image must be pinned by digest" >&2
  exit 64
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "${script_dir}/prepare-payload.sh" "$1" "$2" remote-vm-runner
