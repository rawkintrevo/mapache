"""Contract tests for the versioned remote-libvirt guest image builder."""

import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest


ROOT = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("build_image", ROOT / "build-image.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class GuestImageTests(unittest.TestCase):
    def setUp(self):
        self.manifest = builder.load_manifest()

    def test_manifest_pins_guest_contract(self):
        self.assertEqual(self.manifest["imageVersion"], "ubuntu-24.04-v1")
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

    def test_base_hash_mismatch_fails_before_qemu(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "base.img"
            image.write_bytes(b"not the pinned Ubuntu image")
            with self.assertRaisesRegex(builder.BuildError, "SHA-256 mismatch"):
                builder.verify_base_image(image, self.manifest, runner=lambda *args, **kwargs: self.fail("qemu must not run"))

    def test_dry_run_contains_persistence_and_upgrade_contract(self):
        result = builder.plan(None, None, Path("guest.qcow2"), self.manifest)
        self.assertEqual(result["resources"]["diskGiB"], 40)
        self.assertIn("/var/lib/mapache/workspace/home", result["durablePaths"])
        self.assertEqual(self.manifest["build"]["upgradePolicy"], "new-workspaces-only-unless-explicit-migration")


if __name__ == "__main__":
    unittest.main()
