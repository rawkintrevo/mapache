#!/usr/bin/env python3
"""Unit checks for the inspectable remote-host bootstrap boundary."""

import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import tempfile
import subprocess
import os
import shutil
import io
import json
from contextlib import ExitStack
from functools import partial


ROOT = Path(__file__).parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


helper = load("helper")
installer = load("install")


class HostToolTests(unittest.TestCase):
    def test_resize_validates_input_and_requires_power_off_before_define(self):
        with patch.object(helper, "virsh") as virsh:
            for cpu, memory in [(True, 2048), (0, 2048), (3, 2000), (65, 2048), (3, 263168)]:
                with self.assertRaisesRegex(ValueError, "invalid guest resources"):
                    helper.resize_guest("mapache-ws-test", {"vcpus": cpu, "memoryMiB": memory})
            virsh.assert_not_called()
            virsh.return_value.stdout = "running"
            with self.assertRaisesRegex(ValueError, "stop the managed guest"):
                helper.resize_guest("mapache-ws-test", {"vcpus": 3, "memoryMiB": 4096})
            self.assertEqual(virsh.call_count, 1)

    def test_configure_refuses_live_guest_and_bounds_stdin(self):
        from test_guest_config import configuration
        stream = SimpleNamespace(buffer=io.BytesIO(json.dumps(configuration()).encode()))
        with patch.object(helper.sys, "stdin", stream), patch.object(helper, "inspect_guest", return_value={"exists": True, "state": "running"}), patch.object(helper, "write_seed") as writer:
            with self.assertRaisesRegex(ValueError, "stop the managed"):
                helper.handle(["configure", "mapache-ws-test"])
            writer.assert_not_called()
        stream = SimpleNamespace(buffer=io.BytesIO(b"x" * (helper.MAX_CONFIG_BYTES + 1)))
        with patch.object(helper.sys, "stdin", stream), patch.object(helper, "write_seed") as writer:
            with self.assertRaisesRegex(ValueError, "too large"):
                helper.handle(["configure", "mapache-ws-test"])
            writer.assert_not_called()

    def test_destroy_removes_orphan_seed_and_disk_after_domain_is_absent(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(helper, "DISK_DIR", Path(directory)), patch.object(helper, "inspect_guest", return_value={"exists": False, "state": "stopped"}):
            for suffix in ("qcow2", "seed.iso", "config-id"):
                (Path(directory) / f"mapache-ws-test.{suffix}").write_text("test")
            helper.handle(["destroy", "mapache-ws-test"])
            self.assertEqual(list(Path(directory).iterdir()), [])

    @unittest.skipUnless(shutil.which("virt-xml-validate"), "libvirt schema validator is not installed")
    def test_generated_guest_matches_installed_libvirt_domain_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "domain.xml"
            path.write_text(helper.guest_xml("mapache-ws-schema-check"))
            result = subprocess.run(["virt-xml-validate", str(path), "domain"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_status_checks_network_and_base_image_before_admitting_host(self):
        for active, readable, expected in [(False, True, False), (True, False, False), (True, True, True)]:
            def runner(command, **kwargs):
                return SimpleNamespace(returncode=0, stdout=f"Active: {'yes' if active else 'no'}\n")
            with patch.object(helper.os, "access", return_value=readable), patch.object(helper.Path, "exists", return_value=True), patch.object(helper.shutil, "which", return_value="/usr/bin/cloud-localds"):
                self.assertEqual(helper.handle(["status"], runner=runner)["ready"], expected)

    def test_install_creates_readable_public_key_and_restricted_account(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory)
            for name, relative in {"CONFIG_DIR": "etc", "STATE_FILE": "etc/install.json",
                                   "AUTHORIZED_KEYS": "etc/authorized_keys", "SSHD_CONFIG": "ssh/config",
                                   "HELPER_PATH": "bin/helper", "STORAGE_DIR": "storage",
                                   "NETWORK_XML": "etc/network.xml"}.items():
                stack.enter_context(patch.object(installer, name, root / relative))
            stack.enter_context(patch.object(installer, "require_supported_host"))
            stack.enter_context(patch.object(installer, "ensure_packages"))
            stack.enter_context(patch.object(installer, "readiness", return_value={"ready": True}))
            commands = []
            def runner(command, **kwargs):
                commands.append(command)
                return SimpleNamespace(returncode=1 if command[0] == "id" or "net-info" in command else 0, stdout="")
            # Exercise the real wrapper's keyword contract. Passing the fake
            # subprocess directly hides accidental nested run() calls.
            installer.install("ssh-ed25519 AAAA", runner=partial(installer.run, runner=runner))
            self.assertEqual(installer.AUTHORIZED_KEYS.stat().st_mode & 0o777, 0o644)
            self.assertEqual(installer.HELPER_PATH.stat().st_mode & 0o777, 0o755)
            self.assertEqual(installer.STORAGE_DIR.stat().st_mode & 0o777, 0o711)
            self.assertIn(["usermod", "--shell", str(installer.HELPER_PATH), "--append", "--groups", "libvirt", "mapache-vm"], commands)
            self.assertIn(["sshd", "-t"], commands)
            self.assertLess(commands.index(["sshd", "-t"]), commands.index(["systemctl", "reload", "ssh"]))

    def test_login_shell_dispatch_never_evaluates_shell_commands(self):
        environment = {**os.environ, "SSH_ORIGINAL_COMMAND": "mapache-vm forward 192.168.250.42:8787"}
        for command, expected in [("/usr/local/libexec/mapache-vm-helper ssh", 0),
                                  ("id", 64), ("/usr/local/libexec/mapache-vm-helper ssh; id", 64)]:
            result = subprocess.run([str(ROOT / "helper.py"), "-c", command],
                                    env=environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, expected, result.stderr)
        environment["SSH_ORIGINAL_COMMAND"] = "mapache-vm ssh"
        result = subprocess.run([str(ROOT / "helper.py"), "-c", "/usr/local/libexec/mapache-vm-helper ssh"],
                                env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 64)

    def test_residual_package_configuration_is_not_installed(self):
        for status, expected in [("install ok installed", True), ("deinstall ok config-files", False)]:
            self.assertEqual(installer.package_installed("libvirt-clients", lambda *a, **k:
                SimpleNamespace(returncode=0, stdout=status)), expected)

    def test_network_initial_install_repair_and_repeat(self):
        for defined, active, file_exists in [(False, False, False), (False, False, True),
                                            (True, False, True), (True, True, True)]:
            with self.subTest(defined=defined, active=active, file_exists=file_exists), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "network.xml"
                if file_exists:
                    path.write_text(installer.network_xml())
                commands = []
                def runner(command, **kwargs):
                    commands.append(command)
                    return SimpleNamespace(returncode=(0 if defined else 1) if "net-info" in command else 1,
                                           stdout=f"Active: {'yes' if active else 'no'}\n")
                with patch.object(installer, "NETWORK_XML", path):
                    installer.ensure_network(runner=runner)
                actions = [command[3] for command in commands if command[0] == "virsh"]
                self.assertEqual("net-define" in actions, not defined)
                self.assertEqual("net-start" in actions, not active)
                self.assertEqual(commands[1], ["systemctl", "enable", "--now", "libvirtd"])
                self.assertEqual(actions[-1], "net-autostart")

    def test_unmanaged_network_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(installer, "NETWORK_XML", Path(directory) / "network.xml"):
            commands = []
            def runner(command, **kwargs):
                commands.append(command)
                return SimpleNamespace(returncode=0, stdout="Active: yes\n")
            with self.assertRaisesRegex(RuntimeError, "unmanaged"):
                installer.ensure_network(runner=runner)
            self.assertFalse(any("net-define" in command or "net-start" in command for command in commands))

    def test_forwarding_destinations_are_explicit_guest_addresses(self):
        config = installer.sshd_config()
        destinations = next(line.split()[1:] for line in config.splitlines() if line.strip().startswith("PermitOpen "))
        self.assertEqual(len(destinations), 253)
        self.assertTrue(all(helper.valid_forward_target(target.replace(":*", ":8787")) for target in destinations))
        self.assertNotIn("192.168.250.1:*", destinations)

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

    def test_lifecycle_actions_are_fixed_to_the_owned_guest_contract(self):
        xml = helper.guest_xml("mapache-ws-abc123")
        self.assertIn("<name>mapache-ws-abc123</name>", xml)
        self.assertIn("/var/lib/mapache-vm/disks/mapache-ws-abc123.qcow2", xml)
        self.assertIn("<vcpu placement=\"static\">2</vcpu>", xml)
        with self.assertRaises(ValueError):
            helper.handle(["capacity", "mapache-ws-abc123"])

        class Result:
            returncode = 0
            stdout = "State: running\nAutostart: disable\n"

        backing_image = helper.IMAGE_PATH

        def runner(command, **kwargs):
            if "dumpxml" in command:
                xml = helper.guest_xml("mapache-ws-abc123").replace(
                    '<target dev="vda"',
                    f"<backingStore><source file='{backing_image}'/></backingStore><target dev=\"vda\"")
                return SimpleNamespace(returncode=0, stdout=xml)
            if "domifaddr" in command:
                self.assertEqual(command[-2:], ["--source", "lease"])
                return SimpleNamespace(returncode=0, stdout="vnet0 52:54:00:aa:bb:cc ipv4 192.168.250.42/24\n")
            return Result()

        observed = helper.handle(["inspect", "mapache-ws-abc123"], runner=runner)
        self.assertTrue(observed["exists"])
        self.assertTrue(observed["supportsWorkspaceHostname"])
        self.assertEqual(observed["guestImageVersion"], helper.IMAGE_VERSION)
        self.assertEqual(observed["state"], "running")
        self.assertFalse(observed["autostart"])
        self.assertEqual(observed["guestIp"], "192.168.250.42")
        backing_image = helper.IMAGE_DIR / "ubuntu-24.04-v2.qcow2"
        legacy = helper.handle(["inspect", "mapache-ws-abc123"], runner=runner)
        self.assertIsNone(legacy["guestImageVersion"])

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
