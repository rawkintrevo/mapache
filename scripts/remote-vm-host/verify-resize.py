#!/usr/bin/env python3
"""Boot a disposable overlay twice, verifying CPU, RAM and guest disk persistence."""

import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET

import helper

USER_DATA = """#cloud-config
write_files:
- path: /var/lib/cloud/scripts/per-boot/check-resources
  permissions: '0755'
  content: |
    #!/bin/sh
    old=$(cat /root/resize-sentinel 2>/dev/null || echo fresh)
    echo retained >/root/resize-sentinel
    pclmul=$(grep -qm1 pclmulqdq /proc/cpuinfo && echo yes || echo no)
    echo "RESIZE cpu=$(nproc) mem=$(awk '/^MemTotal:/{print $2}' /proc/meminfo) pclmul=$pclmul sentinel=$old" >/dev/ttyS0
    sync
    shutdown -h now
"""


def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs).stdout


def virsh(*args):
    return run("virsh", "-c", "qemu:///system", *args)


def check_boot(guest, log, cpu, memory, marker):
    run("/usr/local/libexec/mapache-vm-helper", "resize", guest,
        input=json.dumps({"vcpus": cpu, "memoryMiB": memory}))
    virsh("start", guest)
    for _ in range(180):
        if virsh("domstate", guest).strip() == "shut off":
            break
        time.sleep(1)
    else:
        raise RuntimeError("guest boot check timed out")
    samples = re.findall(r"RESIZE cpu=(\d+) mem=(\d+) pclmul=(\w+) sentinel=(\w+)", log.read_text(errors="replace"))
    if not samples:
        raise RuntimeError("guest did not report resources")
    cores, kib, pclmul, observed_marker = samples[-1]
    if int(cores) != cpu or not memory * 0.85 < int(kib) / 1024 <= memory or pclmul != "yes" or observed_marker != marker:
        raise RuntimeError(f"unexpected guest observation: {samples[-1]}")
    print(f"{cores} vCPU, {kib} KiB MemTotal, pclmulqdq={pclmul}, disk marker {marker}", flush=True)


def verify(directory):
    guest = "mapache-ws-resize-" + uuid.uuid4().hex[:16]
    # QEMU needs to traverse the temp directory. Only this disposable domain
    # uses it, and its base image is opened as a read-only backing file.
    directory.chmod(0o711)
    helper.DISK_DIR = directory
    run("qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", helper.IMAGE_PATH,
        directory / (guest + ".qcow2"), helper.DISK_SIZE)
    user_data = directory / "user-data"
    metadata = directory / "metadata"
    user_data.write_text(USER_DATA)
    metadata.write_text(f"instance-id: {guest}\nlocal-hostname: resize-check\n")
    run("cloud-localds", directory / (guest + ".seed.iso"), user_data, metadata)
    log = directory / "serial"
    log.touch()
    log.chmod(0o622)
    domain = ET.fromstring(helper.guest_xml(guest))
    devices = domain.find("devices")
    devices.remove(devices.find("console"))
    serial = ET.SubElement(devices, "serial", type="file")
    ET.SubElement(serial, "source", path=str(log), append="on")
    ET.SubElement(serial, "target", port="0")
    definition = directory / "domain.xml"
    ET.ElementTree(domain).write(definition)
    virsh("define", definition)
    try:
        check_boot(guest, log, 1, 2048, "fresh")
        check_boot(guest, log, 3, 4096, "retained")
    finally:
        if virsh("domstate", guest).strip() != "shut off":
            virsh("destroy", guest)
        virsh("undefine", guest)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(dir="/var/tmp", prefix="mapache-resize-") as temp:
        verify(Path(temp))
