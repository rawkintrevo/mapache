#!/usr/bin/env python3
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from mapache_guest_config import BROKER_URL, NETWORK_SCRIPT, cloud_config, configuration_id, validate_config, write_seed


def configuration():
    return {"OWNER_UID": "owner-1", "WORKSPACE_ID": "workspace-1", "SESSION_ID": "session-1",
            "MAPACHE_AGENT_RUNTIME_GENERATION": "1", "MAPACHE_AGENT_RUNTIME_BOOT_INSTANCE_ID": "boot-1",
            "SESSION_BROWSER_TOKEN_SECRET": "a" * 64, "SESSION_SHUTDOWN_TOKEN": "b" * 48,
            "MAPACHE_REMOTE_CREDENTIAL_BROKER_URL": BROKER_URL}


class GuestConfigTests(unittest.TestCase):
    def test_boot_network_script_selects_private_ip_and_replaces_stale_address(self):
        for address in ("192.168.250.2", "192.168.250.3", "192.168.250.254"):
            with tempfile.TemporaryDirectory() as directory:
                environment = Path(directory) / "guest.env"
                environment.write_text("SESSION_ID=session-1\nRUNNER_BIND_HOST=192.168.250.99\n")
                interfaces = json.dumps([{"addr_info": [{"local": "127.0.0.1"}, {"local": address}]}]).encode()
                with patch("pathlib.Path", return_value=environment), patch("subprocess.check_output", return_value=interfaces):
                    exec(compile(NETWORK_SCRIPT, "guest-network", "exec"), {})
                self.assertEqual(environment.read_text(), f"SESSION_ID=session-1\nRUNNER_BIND_HOST={address}\n")
                self.assertEqual(environment.stat().st_mode & 0o777, 0o600)

    def test_rejects_extra_fields_shell_syntax_and_foreign_broker(self):
        for changes in ({"HOST_PRIVATE_KEY": "no"}, {"OWNER_UID": "owner; id"},
                        {"SESSION_ID": "a\nPORT=22"}, {"MAPACHE_REMOTE_CREDENTIAL_BROKER_URL": "https://example.com"},
                        {"SESSION_SHUTDOWN_TOKEN": "short"}):
            with self.assertRaises(ValueError):
                validate_config({**configuration(), **changes})

    def test_seed_contains_only_scoped_configuration_and_boot_network_service(self):
        document = json.loads(cloud_config(configuration()).split("\n", 1)[1])
        files = {entry["path"]: entry for entry in document["write_files"]}
        environment = files["/etc/mapache-vm/guest.env"]
        text = base64.b64decode(environment["content"]).decode()
        self.assertIn("PORT=8787\n", text)
        self.assertIn("SESSION_ID=session-1\n", text)
        self.assertEqual(environment["permissions"], "0600")
        script = base64.b64decode(files["/usr/local/libexec/mapache-guest-network"]["content"]).decode()
        compile(script, "guest-network", "exec")
        self.assertIn("Requires=mapache-guest-network.service", base64.b64decode(
            files["/etc/systemd/system/mapache-guest.service.d/network.conf"]["content"]).decode())
        self.assertNotIn("SESSION_BROWSER_TOKEN_SECRET", json.dumps(document["runcmd"]))

    @unittest.skipUnless(shutil.which("cloud-localds") and shutil.which("isoinfo"), "seed tools not installed")
    def test_real_seed_iso_contents_and_idempotency(self):
        with tempfile.TemporaryDirectory() as directory:
            identity = write_seed("mapache-ws-test", configuration(), directory)
            path = Path(directory) / "mapache-ws-test.seed.iso"
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)
            output = subprocess.check_output(["isoinfo", "-R", "-i", str(path), "-x", "/user-data"], text=True)
            self.assertEqual(output, cloud_config(configuration()))
            metadata = subprocess.check_output(["isoinfo", "-R", "-i", str(path), "-x", "/meta-data"], text=True)
            self.assertIn(identity, json.loads(metadata)["instance-id"])
            with patch("subprocess.run", side_effect=AssertionError("seed was rebuilt")) as runner:
                self.assertEqual(write_seed("mapache-ws-test", configuration(), directory, runner=runner), identity)
            changed = {**configuration(), "SESSION_ID": "session-2"}
            self.assertNotEqual(write_seed("mapache-ws-test", changed, directory), identity)


if __name__ == "__main__":
    unittest.main()
