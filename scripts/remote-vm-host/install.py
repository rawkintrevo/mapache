#!/usr/bin/env python3
"""Install the versioned Mapache libvirt host support on Ubuntu 22.04.

The script is intentionally inspectable and idempotent. It never removes or
rewrites unrelated libvirt networks, VMs, disks, SSH keys, or firewall rules.
Run it locally with sudo after inspecting this file and verifying the host key.
"""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys

INSTALL_VERSION = "1"
APP_USER = "mapache-vm"
CONFIG_DIR = Path("/etc/mapache-vm")
STATE_FILE = CONFIG_DIR / "install.json"
AUTHORIZED_KEYS = CONFIG_DIR / "authorized_keys"
SSHD_CONFIG = Path("/etc/ssh/sshd_config.d/99-mapache-vm.conf")
HELPER_PATH = Path("/usr/local/libexec/mapache-vm-helper")
STORAGE_DIR = Path("/var/lib/mapache-vm")
NETWORK_NAME = "mapache-vm"
NETWORK_XML = CONFIG_DIR / "network.xml"
NETWORK_CIDR = "192.168.250.0/24"
NETWORK_GATEWAY = "192.168.250.1"
ALLOWED_PACKAGES = (
    "qemu-kvm", "libvirt-daemon-system", "libvirt-clients", "qemu-utils",
    "dnsmasq-base", "openssh-server", "nftables", "python3",
)


def run(command, *, check=True, capture=False, runner=subprocess.run):
    kwargs = {"check": check, "text": True}
    if capture:
        kwargs.update(capture_output=True)
    return runner(command, **kwargs)


def read_os_release(path=Path("/etc/os-release")):
    values = {}
    try:
        for line in path.read_text().splitlines():
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key] = value.strip().strip('"')
    except OSError:
        pass
    return values


def host_key_fingerprint(path=Path("/etc/ssh/ssh_host_ed25519_key.pub")):
    if not path.exists():
        return ""
    key = path.read_text().strip().split()
    if len(key) < 2 or key[0] != "ssh-ed25519":
        return ""
    try:
        blob = base64.b64decode(key[1], validate=True)
    except ValueError:
        return ""
    return "SHA256/" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")


def network_xml():
    return f'''<network>
  <name>{NETWORK_NAME}</name>
  <forward mode="nat"/>
  <bridge name="virbr250" stp="on" delay="0"/>
  <ip address="{NETWORK_GATEWAY}" netmask="255.255.255.0">
    <dhcp>
      <range start="192.168.250.2" end="192.168.250.254"/>
    </dhcp>
  </ip>
</network>
'''


def sshd_config():
    return f'''# Mapache remote VM management account, installer version {INSTALL_VERSION}.
Match User {APP_USER}
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AuthorizedKeysFile {AUTHORIZED_KEYS}
    AllowTcpForwarding local
    AllowStreamLocalForwarding no
    PermitListen none
    PermitOpen 192.168.250.*:*
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    PermitTunnel no
    PermitUserRC no
    ForceCommand {HELPER_PATH} ssh
Match all
'''


def authorized_key_line(public_key):
    fields = public_key.strip().split()
    if len(fields) < 2 or fields[0] != "ssh-ed25519" or not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", fields[1]):
        raise ValueError("public key must be one plain Ed25519 authorized_keys entry")
    # The account has no shell. Restrict the key itself as a second independent
    # boundary; local forwarding remains available for the private guest net.
    return f'restrict,port-forwarding,command="{HELPER_PATH} ssh" {fields[0]} {fields[1]} mapache-remote-host\n'


def validate_public_key(public_key):
    return authorized_key_line(public_key)


def command_available(command, which=shutil.which):
    return bool(which(command))


def service_active(service, runner=run):
    result = runner(["systemctl", "is-active", "--quiet", service], check=False)
    return result.returncode == 0


def readiness(*, runner=run, os_release=None, root=Path("/")):
    os_release = os_release or read_os_release(root / "etc/os-release")
    required = ["virsh", "qemu-img", "ssh-keygen", "sshd", "systemctl", "useradd"]
    command_state = {command: command_available(command) for command in required}
    kvm = Path("/dev/kvm").exists()
    libvirt = service_active("libvirtd", runner) or service_active("virtqemud", runner)
    network = False
    if command_state["virsh"]:
        result = runner(["virsh", "-c", "qemu:///system", "net-info", NETWORK_NAME], check=False, capture=True)
        network = result.returncode == 0 and bool(re.search(r"^Active:\s+yes\s*$", result.stdout or "", re.MULTILINE))
    storage = shutil.disk_usage(STORAGE_DIR if STORAGE_DIR.exists() else Path("/var/lib"))
    return {
        "version": INSTALL_VERSION,
        "os": {"id": os_release.get("ID", ""), "version": os_release.get("VERSION_ID", "")},
        "architecture": platform.machine(),
        "cpuCount": os.cpu_count() or 0,
        "memoryBytes": memory_bytes(),
        "freeDiskBytes": storage.free,
        "kvmAvailable": kvm,
        "libvirtAvailable": libvirt,
        "requiredCommands": command_state,
        "networkReady": network,
        "hostKeyFingerprint": host_key_fingerprint(),
        "storagePath": str(STORAGE_DIR),
        "ready": bool(kvm and libvirt and network and all(command_state.values())),
    }


def memory_bytes():
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError):
        pass
    return 0


def require_supported_host():
    release = read_os_release()
    if release.get("ID") != "ubuntu" or release.get("VERSION_ID") not in {"22.04", "24.04"}:
        raise RuntimeError("supported host is Ubuntu 22.04 or 24.04")
    if os.geteuid() != 0:
        raise RuntimeError("run the installer locally with sudo")


def ensure_packages(*, runner=run):
    missing = [package for package in ALLOWED_PACKAGES if not package_installed(package, runner)]
    if missing:
        runner(["apt-get", "update"])
        runner(["apt-get", "install", "-y", *missing])
    return missing


def package_installed(package, runner=run):
    return runner(["dpkg-query", "-W", "-f=${Status}", package], check=False, capture=True).returncode == 0


def ensure_user(*, runner=run):
    lookup = runner(["id", "-u", APP_USER], check=False, capture=True)
    if lookup.returncode != 0:
        runner(["useradd", "--system", "--user-group", "--home-dir", str(STORAGE_DIR),
                "--shell", "/usr/sbin/nologin", APP_USER])
    else:
        # Never take ownership of an existing unrelated account.
        marker = CONFIG_DIR / "managed-account"
        if not marker.exists():
            raise RuntimeError(f"refusing to reuse existing account {APP_USER} without Mapache marker")


def ensure_file(path, content, mode, *, preserve_unrelated=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    if preserve_unrelated and path.exists():
        existing = path.read_text()
        if content.strip() not in existing:
            path.write_text(existing.rstrip("\n") + "\n" + content)
    elif not path.exists() or path.read_text() != content:
        path.write_text(content)
    path.chmod(mode)


def ensure_managed_file(path, content, mode, marker):
    if path.exists() and marker not in path.read_text():
        raise RuntimeError(f"refusing to overwrite unmanaged file {path}")
    ensure_file(path, content, mode)


def install(public_key, *, runner=run, dry_run=False):
    require_supported_host()
    key_line = validate_public_key(public_key)
    if dry_run:
        return {"version": INSTALL_VERSION, "publicKeyAccepted": True, "network": NETWORK_NAME,
                "storagePath": str(STORAGE_DIR), "sshdConfig": str(SSHD_CONFIG)}
    ensure_packages(runner=runner)
    CONFIG_DIR.mkdir(mode=0o755, exist_ok=True)
    ensure_user(runner=runner)
    marker = CONFIG_DIR / "managed-account"
    marker.write_text(f"mapache-vm installer version {INSTALL_VERSION}\n")
    marker.chmod(0o644)
    STORAGE_DIR.mkdir(mode=0o750, exist_ok=True)
    (STORAGE_DIR / "images").mkdir(mode=0o750, exist_ok=True)
    (STORAGE_DIR / "disks").mkdir(mode=0o750, exist_ok=True)
    run(["chown", f"{APP_USER}:{APP_USER}", str(STORAGE_DIR)], runner=runner)
    run(["chown", f"{APP_USER}:{APP_USER}", str(STORAGE_DIR / "images"), str(STORAGE_DIR / "disks")], runner=runner)
    ensure_file(AUTHORIZED_KEYS, key_line, 0o600, preserve_unrelated=True)
    ensure_managed_file(HELPER_PATH, helper_source(), 0o755, "Forced-command boundary")
    ensure_managed_file(SSHD_CONFIG, sshd_config(), 0o644, "Mapache remote VM management account")
    existing_network = runner(
        ["virsh", "-c", "qemu:///system", "net-info", NETWORK_NAME],
        check=False,
        capture=True,
    )
    if not NETWORK_XML.exists():
        if existing_network.returncode == 0:
            raise RuntimeError(f"refusing to take over existing unmanaged libvirt network {NETWORK_NAME}")
        ensure_file(NETWORK_XML, network_xml(), 0o644)
        runner(["virsh", "-c", "qemu:///system", "net-define", str(NETWORK_XML)])
    elif NETWORK_XML.read_text() != network_xml():
        raise RuntimeError(f"refusing to overwrite unmanaged network definition {NETWORK_XML}")
    if not service_active("libvirtd", runner) and command_available("systemctl"):
        runner(["systemctl", "enable", "--now", "libvirtd"])
    net_state = runner(["virsh", "-c", "qemu:///system", "net-info", NETWORK_NAME], check=False, capture=True)
    if net_state.returncode != 0:
        runner(["virsh", "-c", "qemu:///system", "net-start", NETWORK_NAME])
    runner(["virsh", "-c", "qemu:///system", "net-autostart", NETWORK_NAME])
    runner(["sshd", "-t"])
    runner(["systemctl", "reload", "ssh"])
    STATE_FILE.write_text(json.dumps({"version": INSTALL_VERSION, "network": NETWORK_NAME,
                                      "storagePath": str(STORAGE_DIR)}, indent=2) + "\n")
    STATE_FILE.chmod(0o644)
    return readiness(runner=runner)


def helper_source():
    return Path(__file__).with_name("helper.py").read_text()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-key", type=Path, required=False, help="Mapache generated .pub file")
    parser.add_argument("--check-only", action="store_true", help="report readiness without changing the host")
    parser.add_argument("--dry-run", action="store_true", help="validate key and print planned paths")
    parser.add_argument("--json", action="store_true", help="emit one JSON object")
    args = parser.parse_args(argv)
    try:
        if args.check_only:
            result = readiness()
        else:
            if not args.public_key:
                parser.error("--public-key is required unless --check-only is used")
            result = install(args.public_key.read_text(), dry_run=args.dry_run)
    except (OSError, RuntimeError, ValueError) as error:
        parser.error(str(error))
    if args.json:
        print(json.dumps(result, sort_keys=True))
    else:
        print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result.get("ready", True) else 2 if args.check_only else 0


if __name__ == "__main__":
    raise SystemExit(main())
