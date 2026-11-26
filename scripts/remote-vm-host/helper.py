#!/usr/bin/env python3
"""Forced-command boundary for the Mapache libvirt management account."""

import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import sys
import tempfile
import time
from mapache_guest_config import MAX_CONFIG_BYTES, configuration_id, write_seed

VERSION = "1"
APP_PREFIX = "mapache-ws-"
NETWORK = "mapache-vm"
GUEST_NETWORK_CIDR = "192.168.250.0/24"
STORAGE_DIR = Path("/var/lib/mapache-vm")
IMAGE_DIR = STORAGE_DIR / "images"
DISK_DIR = STORAGE_DIR / "disks"
IMAGE_VERSION = "ubuntu-24.04-v1"
IMAGE_PATH = IMAGE_DIR / f"{IMAGE_VERSION}.qcow2"
DISK_SIZE = "40G"
VCPUS = 2
MEMORY_MIB = 8192
ALLOWED_ACTIONS = {"status", "capacity", "inspect", "create", "configure", "start", "stop", "destroy", "forward"}
ID_PATTERN = re.compile(r"^mapache-ws-[a-z0-9][a-z0-9-]{0,62}$")


def valid_guest_id(value):
    return bool(ID_PATTERN.fullmatch(str(value or "")))


def valid_forward_target(value):
    value = str(value or "")
    if ":" not in value:
        return False
    host, port = value.rsplit(":", 1)
    if not re.fullmatch(r"192\.168\.250\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])", host):
        return False
    try:
        return 1 <= int(port) <= 65535
    except ValueError:
        return False


def virsh(*args, runner=subprocess.run):
    return runner(["virsh", "-c", "qemu:///system", *args], check=True, text=True, capture_output=True)


def virsh_optional(*args, runner=subprocess.run):
    return runner(["virsh", "-c", "qemu:///system", *args], check=False, text=True, capture_output=True)


def parse_state(output):
    match = re.search(r"^State:\s+(.+)$", output or "", re.MULTILINE)
    state = match.group(1).strip().lower() if match else "unknown"
    if state in {"running", "blocked", "paused"}:
        return "running"
    if state in {"shut off", "shutdown", "in shutdown", "crashed", "pmsuspended"}:
        return "stopped"
    return "unknown"


def inspect_guest(guest_id, *, runner=subprocess.run):
    info = virsh_optional("dominfo", guest_id, runner=runner)
    if getattr(info, "returncode", 1) != 0:
        return {"version": VERSION, "network": NETWORK, "guestName": guest_id,
                "diskName": f"{guest_id}.qcow2", "exists": False, "state": "stopped",
                "guestIp": None, "autostart": False}
    # The image has no QEMU guest agent; the managed NAT network provides
    # DHCP leases that libvirt can inspect without guest-installed software.
    addresses = virsh_optional("domifaddr", guest_id, "--source", "lease", runner=runner)
    ip_match = re.search(r"\b(192\.168\.250\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4]))/", getattr(addresses, "stdout", "") or "")
    autostart = re.search(r"^Autostart:\s+enable", getattr(info, "stdout", "") or "", re.MULTILINE) is not None
    marker = DISK_DIR / f"{guest_id}.config-id"
    config_id = marker.read_text().strip() if marker.is_file() and (DISK_DIR / f"{guest_id}.seed.iso").is_file() else None
    return {"version": VERSION, "network": NETWORK, "guestName": guest_id,
            "diskName": f"{guest_id}.qcow2", "exists": True,
            "state": parse_state(getattr(info, "stdout", "")),
            "guestIp": ip_match.group(1) if ip_match else None, "autostart": autostart,
            "configurationId": config_id}


def guest_xml(guest_id):
    # All values are generated after valid_guest_id; no caller-supplied path,
    # bridge, disk, or network XML reaches libvirt.
    disk = DISK_DIR / f"{guest_id}.qcow2"
    return f'''<domain type="kvm">
  <name>{guest_id}</name>
  <memory unit="MiB">{MEMORY_MIB}</memory>
  <currentMemory unit="MiB">{MEMORY_MIB}</currentMemory>
  <vcpu placement="static">{VCPUS}</vcpu>
  <os><type arch="x86_64">hvm</type><boot dev="hd"/></os>
  <features><acpi/><apic/></features>
  <devices>
    <disk type="file" device="disk"><driver name="qemu" type="qcow2"/><source file="{disk}"/><target dev="vda" bus="virtio"/></disk>
    <disk type="file" device="cdrom"><driver name="qemu" type="raw"/><source file="{DISK_DIR / (guest_id + '.seed.iso')}"/><target dev="sda" bus="sata"/><readonly/></disk>
    <interface type="network"><source network="{NETWORK}"/><model type="virtio"/></interface>
    <console type="pty"><target type="serial" port="0"/></console>
  </devices>
</domain>\n'''


def create_guest(guest_id, *, runner=subprocess.run):
    existing = inspect_guest(guest_id, runner=runner)
    disk = DISK_DIR / f"{guest_id}.qcow2"
    if not disk.exists():
        if not IMAGE_PATH.exists():
            raise ValueError(f"guest image {IMAGE_PATH} is not installed")
        DISK_DIR.mkdir(mode=0o750, parents=True, exist_ok=True)
        runner(["qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", str(IMAGE_PATH), str(disk), DISK_SIZE], check=True, text=True, capture_output=True)
    if not existing["exists"]:
        with tempfile.NamedTemporaryFile("w", prefix="mapache-vm-", suffix=".xml", delete=False) as xml_file:
            xml_file.write(guest_xml(guest_id))
            xml_path = xml_file.name
        try:
            runner(["virsh", "-c", "qemu:///system", "define", xml_path], check=True, text=True, capture_output=True)
        finally:
            Path(xml_path).unlink(missing_ok=True)
        # Guests are explicitly managed by Mapache; host reboot does not
        # override the persisted stopped/running intent.
        runner(["virsh", "-c", "qemu:///system", "autostart", guest_id, "--disable"], check=True, text=True, capture_output=True)
    return inspect_guest(guest_id, runner=runner)


def mutate_guest(action, guest_id, *, runner=subprocess.run):
    observed = inspect_guest(guest_id, runner=runner)
    if action == "start":
        if not observed["exists"]:
            observed = create_guest(guest_id, runner=runner)
        if observed["state"] != "running":
            if not (DISK_DIR / f"{guest_id}.seed.iso").is_file():
                raise ValueError("managed guest configuration is missing")
            runner(["virsh", "-c", "qemu:///system", "start", guest_id], check=True, text=True, capture_output=True)
        for _ in range(30):
            observed = inspect_guest(guest_id, runner=runner)
            if observed.get("guestIp"):
                return observed
            time.sleep(1)
        raise ValueError("managed guest DHCP address is not ready")
    elif action == "stop":
        if not observed["exists"]:
            raise ValueError("managed guest does not exist")
        if observed["state"] == "running":
            runner(["virsh", "-c", "qemu:///system", "shutdown", guest_id], check=True, text=True, capture_output=True)
            for _ in range(30):
                observed = inspect_guest(guest_id, runner=runner)
                if observed["state"] == "stopped":
                    break
                time.sleep(1)
    elif action == "destroy":
        if observed["exists"]:
            if observed["state"] == "running":
                runner(["virsh", "-c", "qemu:///system", "destroy", guest_id], check=True, text=True, capture_output=True)
            runner(["virsh", "-c", "qemu:///system", "undefine", guest_id], check=True, text=True, capture_output=True)
        disk = DISK_DIR / f"{guest_id}.qcow2"
        if disk.exists():
            disk.unlink()
        for suffix in ("seed.iso", "config-id"):
            (DISK_DIR / f"{guest_id}.{suffix}").unlink(missing_ok=True)
        return inspect_guest(guest_id, runner=runner)
    return inspect_guest(guest_id, runner=runner)


def handle(arguments, *, runner=subprocess.run):
    if not arguments:
        raise ValueError("missing Mapache helper action")
    action = arguments[0]
    if action == "ssh":
        return handle_ssh(arguments[1:])
    if action not in ALLOWED_ACTIONS:
        raise ValueError("unsupported Mapache helper action")
    if action == "forward":
        if len(arguments) != 2 or not valid_forward_target(arguments[1]):
            raise ValueError("forward target must be an approved guest address")
        # The SSH daemon applies the same PermitOpen network boundary. The
        # helper only emits a target descriptor; it never runs a shell command.
        return {"version": VERSION, "network": NETWORK, "target": arguments[1]}
    if action == "capacity":
        if len(arguments) != 1:
            raise ValueError("capacity does not accept a guest id")
        storage = __import__("shutil").disk_usage(STORAGE_DIR if STORAGE_DIR.exists() else Path("/var/lib"))
        return {"version": VERSION, "network": NETWORK, "cpuCount": os.cpu_count() or 0,
                "memoryBytes": memory_bytes(), "freeDiskBytes": storage.free}
    if len(arguments) > 2 or (len(arguments) == 2 and not valid_guest_id(arguments[1])):
        raise ValueError("guest id is not a Mapache-managed workspace id")
    guest_id = arguments[1] if len(arguments) == 2 else ""
    if action not in {"status"} and not guest_id:
        raise ValueError(f"{action} requires a managed guest id")
    if action == "status":
        if guest_id:
            return inspect_guest(guest_id, runner=runner)
        result = virsh("list", "--all", runner=runner)
        network = virsh_optional("net-info", NETWORK, runner=runner)
        network_ready = network.returncode == 0 and bool(re.search(
            r"^Active:\s+yes\s*$", network.stdout or "", re.MULTILINE))
        return {"version": VERSION, "network": NETWORK, "guestId": None,
                "ready": bool(network_ready and Path("/dev/kvm").exists() and os.access(IMAGE_PATH, os.R_OK)
                              and shutil.which("cloud-localds")),
                "virsh": result.stdout[-12000:]}
    if action == "inspect":
        if not guest_id:
            raise ValueError("inspect requires a managed guest id")
        return inspect_guest(guest_id, runner=runner)
    if action == "create":
        return create_guest(guest_id, runner=runner)
    if action == "configure":
        raw = sys.stdin.buffer.read(MAX_CONFIG_BYTES + 1)
        if len(raw) > MAX_CONFIG_BYTES:
            raise ValueError("guest configuration is too large")
        try:
            config = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            raise ValueError("guest configuration is invalid") from None
        identity = configuration_id(config)
        observed = inspect_guest(guest_id, runner=runner)
        if not observed["exists"]:
            raise ValueError("managed guest does not exist")
        if observed.get("configurationId") == identity:
            return observed
        if observed["state"] != "stopped":
            raise ValueError("stop the managed guest before changing configuration")
        write_seed(guest_id, config, DISK_DIR, runner=runner)
        return inspect_guest(guest_id, runner=runner)
    return mutate_guest(action, guest_id, runner=runner)


def memory_bytes():
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError):
        return 0
    return 0


def handle_ssh(original_arguments):
    if original_arguments:
        raise ValueError("ssh does not accept arguments")
    original = os.environ.get("SSH_ORIGINAL_COMMAND", "").strip()
    if original:
        parts = original.split()
        if parts[:1] != ["mapache-vm"] or parts[1:2] == ["ssh"]:
            raise ValueError("unsupported SSH command")
        return handle(parts[1:])
    # Empty command is the forwarding-only case. PermitOpen in sshd_config is
    # the authoritative destination restriction; never start an interactive shell.
    return {"version": VERSION, "forwarding": True, "network": NETWORK}


def main(argv=None):
    try:
        arguments = list(sys.argv[1:] if argv is None else argv)
        # sshd invokes the account's login shell with -c and ForceCommand.
        # This executable is that shell: never evaluate arbitrary shell text.
        if arguments[:1] == ["-c"]:
            if arguments != ["-c", "/usr/local/libexec/mapache-vm-helper ssh"]:
                raise ValueError("unsupported SSH shell command")
            arguments = ["ssh"]
        result = handle(arguments)
        print(json.dumps(result, sort_keys=True))
        if arguments == ["ssh"] and not os.environ.get("SSH_ORIGINAL_COMMAND") and os.environ.get("SSH_CONNECTION"):
            # Keep an -N forwarding session alive until the SSH client closes
            # it. No shell or command execution is attached to this process.
            while True:
                signal.pause()
        return 0
    except ValueError as error:
        print(json.dumps({"error": str(error), "version": VERSION}), file=sys.stderr)
        return 64


if __name__ == "__main__":
    raise SystemExit(main())
