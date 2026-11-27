"""Managed guest configuration: bounded session settings on a NoCloud seed."""

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

MAX_CONFIG_BYTES = 16384
FIELDS = {
    "OWNER_UID", "WORKSPACE_ID", "SESSION_ID", "MAPACHE_AGENT_RUNTIME_GENERATION",
    "MAPACHE_AGENT_RUNTIME_BOOT_INSTANCE_ID", "SESSION_BROWSER_TOKEN_SECRET",
    "SESSION_SHUTDOWN_TOKEN", "MAPACHE_REMOTE_CREDENTIAL_BROKER_URL",
}
BROKER_URL = "https://us-central1-pi-agents-cloud.cloudfunctions.net/remoteVmCredentials_v2"

# Re-evaluate the DHCP address on every boot, not just the first cloud-init run.
NETWORK_SCRIPT = '''#!/usr/bin/python3
import ipaddress
import json
import os
from pathlib import Path
import subprocess
interfaces = json.loads(subprocess.check_output(["ip", "-j", "-4", "addr", "show"]))
network = ipaddress.ip_network("192.168.250.0/24")
addresses = [entry["local"] for interface in interfaces for entry in interface.get("addr_info", [])
             if ipaddress.ip_address(entry["local"]) in network and 2 <= int(entry["local"].split(".")[-1]) <= 254]
if len(addresses) != 1:
    raise SystemExit("expected one managed guest address")
path = Path("/etc/mapache-vm/guest.env")
lines = [line for line in path.read_text().splitlines() if not line.startswith("RUNNER_BIND_HOST=")]
temporary = path.with_suffix(".tmp")
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as output:
    output.write("\\n".join(lines) + "\\nRUNNER_BIND_HOST=" + addresses[0] + "\\n")
temporary.replace(path)
'''
NETWORK_UNIT = '''[Unit]
Description=Select the Mapache guest private address
Wants=network-online.target
After=network-online.target
Before=mapache-guest.service
[Service]
Type=oneshot
ExecStart=/usr/local/libexec/mapache-guest-network
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
'''


def validate_config(config):
    if not isinstance(config, dict) or set(config) - {"WORKSPACE_HOSTNAME"} != FIELDS:
        raise ValueError("guest configuration fields are invalid")
    for key, value in config.items():
        if not isinstance(value, str):
            raise ValueError("guest configuration values must be strings")
        if key == "MAPACHE_REMOTE_CREDENTIAL_BROKER_URL":
            valid = value == BROKER_URL
        elif key == "WORKSPACE_HOSTNAME":
            valid = bool(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", value))
        elif key in {"SESSION_BROWSER_TOKEN_SECRET", "SESSION_SHUTDOWN_TOKEN"}:
            valid = bool(re.fullmatch(r"[a-f0-9]{48,128}", value))
        elif key == "MAPACHE_AGENT_RUNTIME_GENERATION":
            valid = bool(re.fullmatch(r"[1-9][0-9]{0,14}", value))
        else:
            valid = bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", value))
        if not valid:
            raise ValueError("guest configuration value is invalid")
    return config


def configuration_id(config):
    validate_config(config)
    encoded = json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def cloud_config(config):
    validate_config(config)
    environment = "".join(f"{key}={config[key]}\n" for key in sorted(FIELDS)) + "PORT=8787\n"
    def file(path, content, permissions):
        return {"path": path, "content": base64.b64encode(content.encode()).decode(),
                "encoding": "b64", "owner": "root:root", "permissions": permissions}
    return "#cloud-config\n" + json.dumps({
        "ssh_pwauth": False,
        "write_files": [
            file("/etc/sudoers.d/mapache-workspace", "mapache ALL=(root) NOPASSWD: ALL\n", "0440"),
            # PrivateDevices and RestrictAddressFamilies also imply NoNewPrivileges for User=mapache.
            file("/etc/systemd/system/mapache-guest.service.d/sudo.conf",
                 "[Service]\nPrivateDevices=false\nRestrictAddressFamilies=\nNoNewPrivileges=false\n", "0644"),
            file("/etc/mapache-vm/guest.env", environment, "0600"),
            file("/usr/local/libexec/mapache-guest-network", NETWORK_SCRIPT, "0700"),
            file("/etc/systemd/system/mapache-guest-network.service", NETWORK_UNIT, "0644"),
            file("/etc/systemd/system/mapache-guest.service.d/network.conf",
                 "[Unit]\nRequires=mapache-guest-network.service\nAfter=mapache-guest-network.service\n", "0644"),
        ],
        "runcmd": [["systemctl", "daemon-reload"],
                   ["systemctl", "enable", "mapache-guest-network.service"],
                   ["systemctl", "restart", "mapache-guest-network.service"],
                   ["systemctl", "restart", "mapache-guest.service"]],
    }) + "\n"


def write_seed(guest_id, config, disk_dir, *, runner=subprocess.run):
    identity = configuration_id(config)
    disk_dir = Path(disk_dir)
    seed_path = disk_dir / f"{guest_id}.seed.iso"
    marker = disk_dir / f"{guest_id}.config-id"
    if seed_path.is_file() and marker.is_file() and marker.read_text().strip() == identity:
        return identity
    with tempfile.TemporaryDirectory(prefix="mapache-seed-", dir=disk_dir) as directory:
        directory = Path(directory)
        user_data = directory / "user-data"
        metadata = directory / "meta-data"
        user_data.write_text(cloud_config(config))
        user_data.chmod(0o600)
        metadata.write_text(json.dumps({"instance-id": f"{guest_id}-{identity}", "local-hostname": config.get("WORKSPACE_HOSTNAME", guest_id[:63].rstrip("-"))}))
        output = directory / "seed.iso"
        runner(["cloud-localds", str(output), str(user_data), str(metadata)],
               check=True, text=True, capture_output=True)
        output.chmod(0o640)
        output.replace(seed_path)
        identifier = directory / "config-id"
        identifier.write_text(identity + "\n")
        identifier.chmod(0o640)
        identifier.replace(marker)
    return identity
