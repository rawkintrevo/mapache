#!/usr/bin/env python3
"""Build and validate the versioned Ubuntu remote-libvirt guest image.

The builder deliberately has no network or credential behavior. Downloading
the Ubuntu artifact and producing the runner payload are separate, inspectable
steps. This command only accepts the checked-in base-image hash and a payload
that contains the pinned pi-web-ui/session-runner runtime contract.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parent
MANIFEST_PATH = ROOT / "manifest.json"
IMAGE_VERSION_RE = re.compile(r"^ubuntu-24\.04-v[0-9]+$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SECRET_NAME_RE = re.compile(
    r"(^|[-_.])(id_rsa|id_ed25519|authorized_keys|credentials?|service[-_]?account|\.env)([-_.]|$)",
    re.IGNORECASE,
)
PRIVATE_KEY_RE = re.compile(r"-----BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY-----")
SERVICE_ACCOUNT_RE = re.compile(r'"private_key"\s*:\s*"-----BEGIN', re.IGNORECASE)


class BuildError(RuntimeError):
    """A safe, user-facing image build validation failure."""


def load_manifest(path: Path = MANIFEST_PATH) -> dict:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise BuildError(f"unable to read guest manifest: {path}") from error
    validate_manifest(value)
    return value


def validate_manifest(manifest: dict) -> None:
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
        raise BuildError("guest manifest schemaVersion must be 1")
    if not IMAGE_VERSION_RE.fullmatch(str(manifest.get("imageVersion", ""))):
        raise BuildError("guest imageVersion must be ubuntu-24.04-vN")
    distribution = manifest.get("distribution") or {}
    if distribution != {
        "id": "ubuntu",
        "version": "24.04",
        "codename": "noble",
        "architecture": "amd64",
    }:
        raise BuildError("guest distribution must be Ubuntu 24.04 noble amd64")

    base = manifest.get("base") or {}
    if not base.get("filename") or not str(base.get("url", "")).startswith("https://cloud-images.ubuntu.com/"):
        raise BuildError("guest base image must come from cloud-images.ubuntu.com")
    if not SHA256_RE.fullmatch(str(base.get("sha256", ""))):
        raise BuildError("guest base image must have a SHA-256 pin")
    if base.get("format") != "qcow2":
        raise BuildError("guest base image must be QCOW2")

    resources = manifest.get("resources") or {}
    expected_resources = {
        "vcpus": 2,
        "memoryMiB": 8192,
        "diskGiB": 40,
        "diskFormat": "qcow2",
        "thinProvisioned": True,
    }
    if resources != expected_resources:
        raise BuildError("guest resources must remain 2 vCPU, 8 GiB, 40 GiB thin QCOW2")

    runtime = manifest.get("runtime") or {}
    if runtime.get("agentUiVersion") != "pi-web-ui-v1" or runtime.get("healthPath") != "/runner/health":
        raise BuildError("guest must use the managed pi-web-ui v1 and /runner/health")
    if runtime.get("listenHost") != "private-guest-interface" or runtime.get("upstreamHost") != "127.0.0.1":
        raise BuildError("guest runtime must separate its private listener from the upstream loopback service")
    if runtime.get("listenPort") != 8080 or runtime.get("upstreamPort") != 8787:
        raise BuildError("guest runtime ports do not match the runner contract")
    capabilities = runtime.get("capabilities") or {}
    if capabilities.get("terminal") is not True or capabilities.get("chrome") is not False:
        raise BuildError("guest must retain the native terminal and omit Chrome in v1")

    network = manifest.get("network") or {}
    if network.get("cidr") != "192.168.250.0/24" or network.get("publicListener") is not False:
        raise BuildError("guest network must be the private managed libvirt network")
    try:
        network_cidr = ipaddress.ip_network(network["cidr"])
    except ValueError as error:
        raise BuildError("guest network CIDR is invalid") from error
    if not network_cidr.is_private:
        raise BuildError("guest network CIDR must be private")

    paths = manifest.get("durablePaths") or []
    if not paths or any(not path.startswith("/var/lib/mapache/workspace/") for path in paths):
        raise BuildError("all guest durable paths must remain below the retained disk")
    payload = manifest.get("payload") or {}
    if payload.get("credentialPolicy") != "no-baked-credentials":
        raise BuildError("guest payload must declare no-baked-credentials")
    if manifest.get("build", {}).get("upgradePolicy") != "new-workspaces-only-unless-explicit-migration":
        raise BuildError("guest upgrade policy must preserve existing disks")


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def directory_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix().encode()
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(sha256_file(path).encode())
    return digest.hexdigest()


def validate_payload(payload: Path, manifest: dict) -> dict:
    if not payload.is_dir():
        raise BuildError(f"payload directory does not exist: {payload}")
    required = [
        payload / "runtime/bin/node",
        payload / "session-runner/server.js",
        payload / "pi-web-ui/dist/server/index.js",
        payload / "pi-mcp-adapter/index.ts",
    ]
    missing = [str(path.relative_to(payload)) for path in required if not path.is_file()]
    if missing:
        raise BuildError(f"guest payload is missing: {', '.join(missing)}")
    node = payload / "runtime/bin/node"
    if not node.stat().st_mode & 0o111:
        raise BuildError("guest payload node runtime is not executable")

    payload_descriptor = payload / "payload.json"
    if payload_descriptor.exists():
        try:
            descriptor = json.loads(payload_descriptor.read_text())
        except (OSError, json.JSONDecodeError) as error:
            raise BuildError("guest payload.json is not valid JSON") from error
        if descriptor.get("schemaVersion") != manifest["payload"]["schemaVersion"]:
            raise BuildError("guest payload schema does not match the image manifest")
        if descriptor.get("runnerEntry") != "session-runner/server.js":
            raise BuildError("guest payload runner entry is not the session runner")

    scanned_files = 0
    for path in payload.rglob("*"):
        if not path.is_file():
            continue
        scanned_files += 1
        if SECRET_NAME_RE.search(path.name):
            raise BuildError(f"guest payload contains a credential-looking file: {path.name}")
        try:
            sample = path.read_bytes()[:2 * 1024 * 1024]
        except OSError as error:
            raise BuildError(f"unable to inspect guest payload file: {path}") from error
        if PRIVATE_KEY_RE.search(sample.decode("utf-8", errors="ignore")) or SERVICE_ACCOUNT_RE.search(
            sample.decode("utf-8", errors="ignore")
        ):
            raise BuildError(f"guest payload contains private-key material: {path.name}")
    if scanned_files == 0:
        raise BuildError("guest payload is empty")
    return {"sha256": directory_digest(payload), "fileCount": scanned_files}


def command_output(command: list[str], runner=subprocess.run) -> str:
    result = runner(command, check=True, text=True, capture_output=True)
    return result.stdout or ""


def qemu_info(path: Path, runner=subprocess.run) -> dict:
    raw = command_output(["qemu-img", "info", "--output=json", str(path)], runner)
    try:
        info = json.loads(raw)
    except json.JSONDecodeError as error:
        raise BuildError("qemu-img returned invalid JSON") from error
    if info.get("format") != "qcow2":
        raise BuildError("base image is not QCOW2")
    return info


def verify_base_image(path: Path, manifest: dict, runner=subprocess.run) -> dict:
    if not path.is_file():
        raise BuildError(f"base image does not exist: {path}")
    expected = manifest["base"]["sha256"]
    observed = sha256_file(path)
    if observed != expected:
        raise BuildError(f"base image SHA-256 mismatch: expected {expected}, got {observed}")
    info = qemu_info(path, runner)
    return {"sha256": observed, "format": info["format"], "virtualSize": info.get("virtual-size")}


def build_image(base_image: Path, payload: Path, output: Path, manifest: dict, runner=subprocess.run) -> dict:
    base = verify_base_image(base_image, manifest, runner)
    payload_info = validate_payload(payload, manifest)
    if output.resolve() == base_image.resolve():
        raise BuildError("output image must not overwrite the base image")
    if output.exists():
        raise BuildError(f"refusing to overwrite existing guest image: {output}")
    if shutil.which("qemu-img") is None or shutil.which("virt-customize") is None:
        raise BuildError("qemu-img and virt-customize are required to build a guest image")

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="mapache-guest-image-"))
    try:
        bootstrap = ROOT / "mapache-guest-bootstrap.sh"
        unit = ROOT / "mapache-guest.service"
        staged_payload = staging / "payload"
        shutil.copytree(payload, staged_payload, symlinks=True)
        # Copy to a new standalone QCOW2 first. A retained workspace disk must
        # not depend on the downloadable base image remaining on the host.
        runner(["qemu-img", "convert", "-p", "-O", "qcow2", str(base_image), str(output)], check=True)
        runner(["qemu-img", "resize", str(output), f"{manifest['resources']['diskGiB']}G"], check=True)
        runner([
            "virt-customize", "-a", str(output),
            "--install", "ca-certificates,curl,git,openssh-client,python3",
            "--mkdir", "/opt/mapache",
            "--mkdir", "/etc/mapache-vm",
            "--mkdir", "/var/lib/mapache/workspace",
            "--upload", f"{staged_payload}:/opt/mapache/payload",
            "--upload", f"{bootstrap}:/usr/local/libexec/mapache-guest-bootstrap",
            "--upload", f"{unit}:/etc/systemd/system/mapache-guest.service",
            "--run-command", "useradd --system --home-dir /var/lib/mapache --shell /usr/sbin/nologin mapache || true",
            "--run-command", "chown -R mapache:mapache /var/lib/mapache",
            "--run-command", "chmod 0755 /usr/local/libexec/mapache-guest-bootstrap",
            "--run-command", "ln -sfn /opt/mapache/payload/session-runner /app",
            "--run-command", "ln -sfn /opt/mapache/payload/runtime/lib-node-modules /usr/local/lib/node_modules",
            "--run-command", "ln -sfn /opt/mapache/payload/runtime/pi /usr/local/bin/pi",
            "--run-command", "mkdir -p /etc/systemd/system/multi-user.target.wants",
            "--run-command", "ln -sfn /etc/systemd/system/mapache-guest.service /etc/systemd/system/multi-user.target.wants/mapache-guest.service",
        ], check=True)
        image_info = qemu_info(output, runner)
        result = {
            "schemaVersion": 1,
            "imageVersion": manifest["imageVersion"],
            "baseImage": base,
            "payload": payload_info,
            "virtualSize": image_info.get("virtual-size"),
            "format": image_info.get("format"),
            "thinProvisioned": manifest["resources"]["thinProvisioned"],
        }
        output.with_name(f"{output.name}.manifest.json").write_text(json.dumps(result, indent=2) + "\n")
        return result
    except Exception:
        if output.exists():
            output.unlink()
        raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def plan(base_image: Path | None, payload: Path | None, output: Path | None, manifest: dict) -> dict:
    result = {
        "imageVersion": manifest["imageVersion"],
        "base": manifest["base"],
        "resources": manifest["resources"],
        "runtime": manifest["runtime"],
        "network": manifest["network"],
        "durablePaths": manifest["durablePaths"],
        "output": str(output) if output else None,
    }
    if base_image and base_image.exists():
        result["baseObservedSha256"] = sha256_file(base_image)
    if payload and payload.exists():
        result["payload"] = validate_payload(payload, manifest)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=MANIFEST_PATH)
    parser.add_argument("--base-image", type=Path)
    parser.add_argument("--payload", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--dry-run", action="store_true", help="validate and print the build plan without mutating an image")
    args = parser.parse_args(argv)
    try:
        manifest = load_manifest(args.manifest)
        if args.dry_run:
            print(json.dumps(plan(args.base_image, args.payload, args.output, manifest), indent=2, sort_keys=True))
            return 0
        if not args.base_image or not args.payload or not args.output:
            parser.error("--base-image, --payload and --output are required unless --dry-run is used")
        print(json.dumps(build_image(args.base_image, args.payload, args.output, manifest), indent=2, sort_keys=True))
        return 0
    except (BuildError, OSError, subprocess.CalledProcessError) as error:
        print(f"guest image build failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
