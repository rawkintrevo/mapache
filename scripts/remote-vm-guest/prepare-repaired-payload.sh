#!/usr/bin/env bash
set -euo pipefail

# Extract the immutable runner payload, then overlay only the guest-specific
# files that are deliberately shipped in the remote VM image. Keeping this
# list explicit prevents a local checkout (or a future build-system change)
# from accidentally becoming part of the guest artifact.
if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <runner-image@sha256:digest> <output-directory>" >&2
  exit 64
fi

image="$1"
output="$2"
if [[ ! "${image}" =~ @sha256:[0-9a-fA-F]{64}$ ]]; then
  echo "runner image must be pinned by digest (image@sha256:<64 hex chars>)" >&2
  exit 64
fi
if [[ -e "${output}" ]]; then
  echo "refusing to overwrite existing payload directory: ${output}" >&2
  exit 73
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"

# The source files are expected to be committed. A dirty overlay would make
# the recorded source commit misleading; the per-file hashes below remain the
# final authority for the bytes that were actually copied.
overlay_files=(
  "session-runner/server.js"
  "session-runner/lib/activity.js"
  "session-runner/lib/runnerEnvironment.js"
  "session-runner/lib/piWebUiProcess.js"
  "session-runner/lib/piModelScope.service.js"
  "session-runner/lib/remoteCredentials.service.js"
  "session-runner/lib/remoteGuestDisk.js"
  "session-runner/lib/remoteWorkspaceAuthority.js"
  "session-runner/lib/remoteAuthorityLoss.js"
  "session-runner/lib/workspaceAuth.service.js"
)
guest_build_files=(
  "scripts/remote-vm-guest/mapache-guest-bootstrap.sh"
  "scripts/remote-vm-guest/mapache-guest.service"
)
for relative in "${overlay_files[@]}" "${guest_build_files[@]}"; do
  source_path="${repo_root}/${relative}"
  [[ -f "${source_path}" ]] || { echo "overlay source is missing: ${relative}" >&2; exit 66; }
  if ! git -C "${repo_root}" diff --quiet -- "${relative}" ||
     ! git -C "${repo_root}" diff --cached --quiet -- "${relative}"; then
    echo "overlay source must be committed before packaging: ${relative}" >&2
    exit 65
  fi
done
source_commit="$(git -C "${repo_root}" rev-parse HEAD)"

"${script_dir}/prepare-payload.sh" "${image}" "${output}"

for relative in "${overlay_files[@]}"; do
  destination="${output}/${relative}"
  mkdir -p "$(dirname -- "${destination}")"
  install -m 0644 "${repo_root}/${relative}" "${destination}"
done

python3 - "${output}/payload.json" "${source_commit}" "${image}" "${repo_root}" "${#overlay_files[@]}" "${overlay_files[@]}" "${guest_build_files[@]}" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

descriptor_path = Path(sys.argv[1])
source_commit = sys.argv[2]
image = sys.argv[3]
repo_root = Path(sys.argv[4])
overlay_count = int(sys.argv[5])
relative_files = sys.argv[6:6 + overlay_count]
build_files = sys.argv[6 + overlay_count:]
descriptor = json.loads(descriptor_path.read_text())
if descriptor.get("sourceImage") != image:
    raise SystemExit("extracted payload source image does not match requested digest")
root = descriptor_path.parent
descriptor["guestOverlay"] = {
    "schemaVersion": 1,
    "sourceCommit": source_commit,
    "files": [
        {
            "path": relative,
            "sha256": hashlib.sha256((root / relative).read_bytes()).hexdigest(),
        }
        for relative in relative_files
    ],
    "buildFiles": [
        {
            "path": relative,
            "sha256": hashlib.sha256((repo_root / relative).read_bytes()).hexdigest(),
        }
        for relative in build_files
    ],
}
descriptor_path.write_text(json.dumps(descriptor, indent=2, sort_keys=True) + "\n")
PY

echo "prepared repaired guest payload at ${output}"
