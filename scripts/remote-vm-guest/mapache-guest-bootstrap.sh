#!/usr/bin/env bash
set -euo pipefail

# This file is installed into the immutable Ubuntu guest image. Per-workspace
# identity, browser tokens, connection material and the guest address are
# supplied later by the lifecycle/gateway worker through guest.env.
readonly DATA_ROOT="/var/lib/mapache/workspace"
readonly PAYLOAD_ROOT="/opt/mapache/payload"
readonly ENV_FILE="/etc/mapache-vm/guest.env"

if [[ -r "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1091
  source "${ENV_FILE}"
fi

: "${MAPACHE_RUNTIME_PROVIDER:=remote-libvirt}"
: "${MAPACHE_AGENT_UI_VERSION:=pi-web-ui-v1}"
: "${MAPACHE_RETAINED_DISK_ROOT:=${DATA_ROOT}}"
: "${WORKSPACE_DIR:=${DATA_ROOT}/workspace}"
: "${HOME:=${DATA_ROOT}/home}"
: "${MAPACHE_HOME_DIR:=${HOME}}"
: "${RUNNER_BIND_HOST:=private-guest-interface}"
: "${PORT:=8080}"
: "${OWNER_UID:=}"
: "${WORKSPACE_ID:=}"
: "${SESSION_ID:=}"
: "${MAPACHE_AGENT_RUNTIME_GENERATION:=}"
: "${MAPACHE_AGENT_RUNTIME_BOOT_INSTANCE_ID:=}"
: "${SESSION_BROWSER_TOKEN_SECRET:=}"
: "${SESSION_SHUTDOWN_TOKEN:=}"
: "${MAPACHE_REMOTE_CREDENTIAL_BROKER_URL:=}"

if [[ "${MAPACHE_RUNTIME_PROVIDER}" != "remote-libvirt" ]]; then
  echo "refusing non-remote-libvirt guest runtime" >&2
  exit 78
fi
if [[ "${MAPACHE_AGENT_UI_VERSION}" != "pi-web-ui-v1" ]]; then
  echo "unsupported guest agent UI version" >&2
  exit 78
fi
if [[ "${MAPACHE_RETAINED_DISK_ROOT}" != "${DATA_ROOT}" ]]; then
  echo "refusing an unowned retained-disk root" >&2
  exit 78
fi
if [[ "${WORKSPACE_DIR}" != "${DATA_ROOT}/workspace" || "${HOME}" != "${DATA_ROOT}/home" || "${MAPACHE_HOME_DIR}" != "${DATA_ROOT}/home" ]]; then
  echo "refusing guest paths outside the retained disk" >&2
  exit 78
fi
if [[ "${RUNNER_BIND_HOST}" == "private-guest-interface" ]]; then
  echo "lifecycle worker must provide the private guest address" >&2
  exit 78
fi
if [[ ! "${RUNNER_BIND_HOST}" =~ ^192\.168\.250\.([2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$ ]]; then
  echo "guest runtime must bind to the managed private network" >&2
  exit 78
fi

for directory in \
  "${DATA_ROOT}/home" \
  "${DATA_ROOT}/workspace" \
  "${DATA_ROOT}/agent" \
  "${DATA_ROOT}/credentials" \
  "${DATA_ROOT}/uploads" \
  "${DATA_ROOT}/caches"; do
  install -d -m 0700 -o mapache -g mapache "${directory}"
done

node_bin="${PAYLOAD_ROOT}/runtime/bin/node"
runner_entry="${PAYLOAD_ROOT}/session-runner/server.js"
if [[ ! -x "${node_bin}" || ! -f "${runner_entry}" ]]; then
  echo "guest runtime payload is incomplete" >&2
  exit 78
fi

export MAPACHE_RUNTIME_PROVIDER MAPACHE_AGENT_UI_VERSION MAPACHE_RETAINED_DISK_ROOT
export WORKSPACE_DIR HOME MAPACHE_HOME_DIR RUNNER_BIND_HOST PORT
export OWNER_UID WORKSPACE_ID SESSION_ID MAPACHE_AGENT_RUNTIME_GENERATION MAPACHE_AGENT_RUNTIME_BOOT_INSTANCE_ID
export SESSION_BROWSER_TOKEN_SECRET SESSION_SHUTDOWN_TOKEN MAPACHE_REMOTE_CREDENTIAL_BROKER_URL
export PATH="${PAYLOAD_ROOT}/runtime/bin:${PAYLOAD_ROOT}/runtime/lib-node-modules/.bin:${PATH}"
"${node_bin}" -e 'require("/opt/mapache/payload/session-runner/lib/remoteGuestDisk").initializeRemoteGuestDisk({root: process.env.MAPACHE_RETAINED_DISK_ROOT, ownerUid: process.env.OWNER_UID, workspaceId: process.env.WORKSPACE_ID, generation: process.env.MAPACHE_AGENT_RUNTIME_GENERATION, operationId: process.env.SESSION_ID}).catch(error => { console.error(error.message); process.exitCode = 1; })'
exec "${node_bin}" "${runner_entry}"
