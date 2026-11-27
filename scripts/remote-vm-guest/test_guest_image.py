"""Contract tests for the versioned remote-libvirt guest image builder."""

import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("build_image", ROOT / "build-image.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class GuestImageTests(unittest.TestCase):
    def setUp(self):
        self.manifest = builder.load_manifest()

    def test_manifest_pins_guest_contract(self):
        self.assertEqual(self.manifest["imageVersion"], "ubuntu-24.04-v2")
        self.assertEqual(self.manifest["resources"], {
            "vcpus": 2,
            "memoryMiB": 8192,
            "diskGiB": 40,
            "diskFormat": "qcow2",
            "thinProvisioned": True,
        })
        self.assertEqual(self.manifest["runtime"]["healthPath"], "/runner/health")
        self.assertFalse(self.manifest["network"]["publicListener"])

    def test_manifest_rejects_healthz_or_public_guest(self):
        bad = json.loads(json.dumps(self.manifest))
        bad["runtime"]["healthPath"] = "/healthz"
        with self.assertRaises(builder.BuildError):
            builder.validate_manifest(bad)
        bad = json.loads(json.dumps(self.manifest))
        bad["network"]["publicListener"] = True
        with self.assertRaises(builder.BuildError):
            builder.validate_manifest(bad)

    def test_payload_requires_runtime_and_rejects_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "runtime/bin").mkdir(parents=True)
            (root / "session-runner").mkdir()
            (root / "pi-web-ui/dist/server").mkdir(parents=True)
            node = root / "runtime/bin/node"
            node.write_bytes(b"node")
            node.chmod(node.stat().st_mode | stat.S_IXUSR)
            (root / "session-runner/server.js").write_text("// runner")
            (root / "pi-web-ui/dist/server/index.js").write_text("// ui")
            (root / "pi-mcp-adapter").mkdir()
            (root / "pi-mcp-adapter/index.ts").write_text("// adapter")
            payload = builder.validate_payload(root, self.manifest)
            self.assertEqual(payload["fileCount"], 4)
            (root / "id_rsa").write_text("not a key")
            with self.assertRaises(builder.BuildError):
                builder.validate_payload(root, self.manifest)

    def test_payload_records_and_verifies_guest_overlay_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "runtime/bin").mkdir(parents=True)
            (root / "session-runner").mkdir()
            (root / "pi-web-ui/dist/server").mkdir(parents=True)
            (root / "pi-mcp-adapter").mkdir()
            (root / "runtime/bin/node").write_bytes(b"node")
            (root / "runtime/bin/node").chmod(0o755)
            (root / "session-runner/server.js").write_text("// runner")
            (root / "pi-web-ui/dist/server/index.js").write_text("// ui")
            overlay = root / "session-runner/server.js"
            overlay_hash = builder.sha256_file(overlay)
            (root / "pi-mcp-adapter/index.ts").write_text("// adapter")
            (root / "payload.json").write_text(json.dumps({
                "schemaVersion": 1,
                "sourceImage": "registry.example/runner@sha256:" + "a" * 64,
                "runnerEntry": "session-runner/server.js",
                "guestOverlay": {
                    "schemaVersion": 1,
                    "sourceCommit": "b" * 40,
                    "files": [{"path": "session-runner/server.js", "sha256": overlay_hash}],
                    "buildFiles": [{
                        "path": "scripts/remote-vm-guest/mapache-guest-bootstrap.sh",
                        "sha256": builder.sha256_file(ROOT / "mapache-guest-bootstrap.sh"),
                    }],
                },
            }))
            result = builder.validate_payload(root, self.manifest)
            self.assertEqual(result["sourceImage"], "registry.example/runner@sha256:" + "a" * 64)
            self.assertEqual(result["guestOverlay"]["sourceCommit"], "b" * 40)
            overlay.write_text("// changed")
            with self.assertRaisesRegex(builder.BuildError, "hash does not match"):
                builder.validate_payload(root, self.manifest)

    def test_base_hash_mismatch_fails_before_qemu(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "base.img"
            image.write_bytes(b"not the pinned Ubuntu image")
            with self.assertRaisesRegex(builder.BuildError, "SHA-256 mismatch"):
                builder.verify_base_image(image, self.manifest, runner=lambda *args, **kwargs: self.fail("qemu must not run"))

    def test_credential_filenames_distinguish_code_from_saved_secrets(self):
        for name in ["call-credentials.js.map", "credentials.ts", "service-account.js"]:
            self.assertIsNone(builder.SECRET_NAME_RE.search(name), name)
        for name in ["credentials.json", "service-account.json", ".env", ".env.local", "id_ed25519", "authorized_keys"]:
            self.assertIsNotNone(builder.SECRET_NAME_RE.search(name), name)

    def test_private_key_scan_requires_material_and_covers_pkcs8(self):
        self.assertIsNone(builder.PRIVATE_KEY_RE.search("-----BEGIN RSA PRIVATE KEY-----\nXXXXXXXXXXX..."))
        for kind in ["", "RSA ", "OPENSSH ", "ENCRYPTED "]:
            self.assertIsNotNone(builder.PRIVATE_KEY_RE.search(
                f"-----BEGIN {kind}PRIVATE KEY-----\n" + "A" * 128 + "\n"))

    def test_dry_run_contains_persistence_and_upgrade_contract(self):
        result = builder.plan(None, None, Path("guest.qcow2"), self.manifest)
        self.assertEqual(result["resources"]["diskGiB"], 40)
        self.assertIn("/var/lib/mapache/workspace/home", result["durablePaths"])
        self.assertEqual(self.manifest["build"]["upgradePolicy"], "new-workspaces-only-unless-explicit-migration")

    def test_builder_copies_directory_and_uploads_individual_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = root / "payload"
            payload.mkdir()
            commands = []
            def run(command, **kwargs):
                commands.append(command)
                if command[0] == "qemu-img" and command[1] == "create":
                    Path(command[4]).write_bytes(b"qcow2 test output")
                if command[0] == "virt-customize":
                    source, destination = command[command.index("--copy-in") + 1].split(":", 1)
                    self.assertTrue(Path(source).is_dir())
                    self.assertEqual(destination, "/opt/mapache")
                    directories = [command[i + 1] for i, value in enumerate(command) if value == "--mkdir"]
                    self.assertIn("/usr/local/libexec", directories)
                    self.assertTrue(set(self.manifest["durablePaths"]).issubset(directories))
                    self.assertIn("ln -s /var/lib/mapache/workspace/workspace /workspace", command)
                    self.assertIn("ln -sT /var/lib/mapache/workspace/home /home/mapache", command)
                    self.assertIn("grub-install --target=i386-pc /dev/sda && update-grub", command)
                    for i, value in enumerate(command):
                        if value == "--upload":
                            self.assertTrue(Path(command[i + 1].split(":", 1)[0]).is_file())
            with patch.object(builder, "verify_base_image", return_value={}), \
                 patch.object(builder, "validate_payload", return_value={}), \
                 patch.object(builder, "qemu_info", return_value={"format": "qcow2"}), \
                 patch.object(builder.shutil, "which", return_value="available"):
                builder.build_image(root / "base", payload, root / "guest.qcow2", self.manifest, runner=run)
            self.assertEqual(sum(command[0] == "virt-customize" for command in commands), 1)
            resize = next(command for command in commands if command[0] == "virt-resize")
            self.assertEqual(resize[resize.index("--expand") + 1], "/dev/sda1")
            self.assertLess(commands.index(resize), next(i for i, command in enumerate(commands) if command[0] == "virt-customize"))


if __name__ == "__main__":
    unittest.main()
