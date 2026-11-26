#!/usr/bin/env bash
set -euo pipefail

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
command -v docker >/dev/null || { echo "docker is required to extract the runner payload" >&2; exit 69; }

mkdir -p "${output}"
container="mapache-guest-payload-$$"
cleanup() {
  docker rm "${container}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker create --name "${container}" "${image}" >/dev/null
mkdir -p "${output}/runtime" "${output}/session-runner" "${output}/pi-web-ui"
docker cp "${container}:/usr/local/bin/node" "${output}/runtime/bin-node"
docker cp "${container}:/usr/local/bin/pi" "${output}/runtime/pi"
docker cp "${container}:/usr/local/lib/node_modules" "${output}/runtime/lib-node-modules"
if [[ -L "${output}/runtime/pi" ]]; then
  pi_target="$(readlink "${output}/runtime/pi")"
  case "${pi_target}" in
    ../lib/node_modules/*)
      ln -sfn "lib-node-modules/${pi_target#../lib/node_modules/}" "${output}/runtime/pi"
      ;;
    *)
      echo "unsupported pi launcher symlink: ${pi_target}" >&2
      exit 65
      ;;
  esac
fi
[[ -f "${output}/runtime/pi" ]] || { echo "pi launcher target is missing" >&2; exit 65; }
docker cp "${container}:/root/.pi/agent/npm/node_modules/pi-mcp-adapter" "${output}/pi-mcp-adapter"
docker cp "${container}:/app/." "${output}/session-runner/"
docker cp "${container}:/opt/mapache/pi-web-ui/." "${output}/pi-web-ui/"
# ssh2 ships private-key fixtures for its own test suite, not runtime use.
if [[ -d "${output}/pi-web-ui/node_modules/ssh2/test" ]]; then
  find "${output}/pi-web-ui/node_modules/ssh2/test" -depth -delete
fi
mkdir -p "${output}/runtime/bin"
mv "${output}/runtime/bin-node" "${output}/runtime/bin/node"
chmod 0755 "${output}/runtime/bin/node" "${output}/runtime/pi"
cat > "${output}/payload.json" <<EOF
{
  "schemaVersion": 1,
  "sourceImage": "${image}",
  "nodePath": "runtime/bin/node",
  "runnerEntry": "session-runner/server.js",
  "piWebUiRoot": "pi-web-ui",
  "piMcpAdapterPath": "pi-mcp-adapter/index.ts"
}
EOF
echo "prepared guest payload at ${output}"
