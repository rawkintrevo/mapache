#!/usr/bin/env python3
"""Unit checks for the inspectable remote-host bootstrap boundary."""

import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


helper = load("helper")
installer = load("install")


class HostToolTests(unittest.TestCase):
    def test_helper_rejects_shell_paths_and_foreign_guest_ids(self):
        for args in [
            ["bash", "-c", "id"],
            ["status", "/etc/passwd"],
            ["start", "foreign-vm"],
            ["forward", "127.0.0.1:22"],
            ["forward", "192.168.250.2:22", "/tmp/file"],
        ]:
            with self.assertRaises(ValueError):
                helper.handle(args, runner=lambda *args, **kwargs: None)

    def test_helper_accepts_only_managed_guest_and_private_forward_targets(self):
        result = helper.handle(["forward", "192.168.250.42:8080"])
        self.assertEqual(result["network"], "mapache-vm")
        self.assertTrue(helper.valid_guest_id("mapache-ws-abc123"))
        self.assertFalse(helper.valid_guest_id("ubuntu"))

    def test_public_key_line_is_restricted_and_idempotent(self):
        key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
        line = installer.validate_public_key(key)
        self.assertIn('command="/usr/local/libexec/mapache-vm-helper ssh"', line)
        self.assertIn("restrict,port-forwarding", line)
        with self.assertRaises(ValueError):
            installer.validate_public_key("ssh-rsa AAAA not-ed25519")

    def test_readiness_reports_missing_host_capabilities_without_mutation(self):
        class Result:
            returncode = 1
            stdout = ""

        result = installer.readiness(
            runner=lambda *args, **kwargs: Result(),
            os_release={"ID": "ubuntu", "VERSION_ID": "22.04"},
        )
        self.assertFalse(result["ready"])
        self.assertEqual(result["version"], "1")
        self.assertIn("hostKeyFingerprint", result)


if __name__ == "__main__":
    unittest.main()
