#!/usr/bin/env python3
"""Forced-command boundary for the Mapache libvirt management account."""

import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys

VERSION = "1"
APP_PREFIX = "mapache-ws-"
NETWORK = "mapache-vm"
GUEST_NETWORK_CIDR = "192.168.250.0/24"
ALLOWED_ACTIONS = {"status", "create", "start", "stop", "destroy", "forward"}
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
    if len(arguments) > 2 or (len(arguments) == 2 and not valid_guest_id(arguments[1])):
        raise ValueError("guest id is not a Mapache-managed workspace id")
    guest_id = arguments[1] if len(arguments) == 2 else ""
    if action == "status":
        result = virsh("list", "--all", runner=runner)
        return {"version": VERSION, "network": NETWORK, "guestId": guest_id or None,
                "virsh": result.stdout[-12000:]}
    command = {"create": "define", "start": "start", "stop": "shutdown", "destroy": "destroy"}[action]
    # Lifecycle code supplies an already validated, managed XML/path through a
    # separate helper protocol. No caller-controlled path reaches this command.
    raise ValueError(f"{action} requires the lifecycle worker protocol")


def handle_ssh(original_arguments):
    original = os.environ.get("SSH_ORIGINAL_COMMAND", "").strip()
    if original:
        parts = original.split()
        if parts[:1] != ["mapache-vm"]:
            raise ValueError("unsupported SSH command")
        return handle(parts[1:])
    # Empty command is the forwarding-only case. PermitOpen in sshd_config is
    # the authoritative destination restriction; never start an interactive shell.
    return {"version": VERSION, "forwarding": True, "network": NETWORK}


def main(argv=None):
    try:
        result = handle(list(argv or sys.argv[1:]))
        print(json.dumps(result, sort_keys=True))
        if list(argv or sys.argv[1:]) == ["ssh"] and not os.environ.get("SSH_ORIGINAL_COMMAND") and os.environ.get("SSH_CONNECTION"):
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
