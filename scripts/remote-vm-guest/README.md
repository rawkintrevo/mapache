# Versioned remote VM guest image

`manifest.json` is the v2 guest contract for the remote-libvirt provider:
Ubuntu 24.04 LTS (amd64), 2 vCPU, 8 GiB RAM, and one 40 GiB thin QCOW2 disk.
The base image is a dated Ubuntu release artifact with a checked-in SHA-256;
the builder refuses a changed or unverified base image.

The guest payload is extracted from an immutable `gcp-runner` image. It reuses
the repository's pinned pi-web-ui build (`pi-web-ui-v1`) and the session runner,
including the native terminal protocol. The extraction command must receive a
content-addressed Docker image (`image@sha256:...`); a mutable tag is rejected.

```bash
scripts/remote-vm-guest/prepare-payload.sh \
  us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:IMAGE_DIGEST \
  /tmp/mapache-guest-payload

# Extract the same immutable payload and overlay the committed guest-only
# repairs, recording source and per-file hashes in payload.json. The same
# descriptor records the bootstrap and systemd files supplied to the image
# builder.
scripts/remote-vm-guest/prepare-repaired-payload.sh \
  us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:IMAGE_DIGEST \
  /tmp/mapache-repaired-guest-payload

scripts/remote-vm-guest/build-image.py \
  --base-image /var/tmp/ubuntu-24.04-server-cloudimg-amd64.img \
  --payload /tmp/mapache-repaired-guest-payload \
  --output /var/lib/mapache-vm/images/ubuntu-24.04-v3.qcow2
```

The resulting image contains no owner, host, Firebase, model-provider, or SSH
credentials. `/etc/mapache-vm/guest.env` is intentionally absent from the
image; the lifecycle worker writes the short-lived identity and access values
after the VM is created. The service binds to the assigned `192.168.250.x`
libvirt address and is reachable only through the authenticated gateway/SSH
forward. `mapache-guest-bootstrap.sh` fails closed if a caller supplies a
public or loopback listener, changes the durable root, or omits the assigned
private address. The lifecycle worker may also provide `OWNER_UID`,
`WORKSPACE_ID`, `SESSION_ID`, `MAPACHE_AGENT_RUNTIME_GENERATION`,
`MAPACHE_AGENT_RUNTIME_BOOT_INSTANCE_ID`, `SESSION_BROWSER_TOKEN_SECRET`,
`SESSION_SHUTDOWN_TOKEN`, and
`MAPACHE_REMOTE_CREDENTIAL_BROKER_URL`. These values are workspace/session
scoped; the host SSH private key is never one of them.

The following roots live on the retained workspace disk and survive ordinary
VM stop/start and reboot: `home`, `workspace`, `agent`, `credentials`,
`uploads`, and `caches`. PID files, sockets, and other process state are
recreated at boot. A new workspace is blank; no repository or Git metadata is
seeded by the image.

The 40 GiB value is the virtual capacity, not the initial host allocation.
QCOW2 metadata and guest filesystem overhead consume space immediately; actual
host usage grows with writes. The builder records the base hash, upstream
runtime digest, overlay source commit and file hashes, payload hash, output
image checksum, virtual size, and image version in `<output>.manifest.json` for
lifecycle and upgrade checks. Changing `imageVersion` affects new workspaces
only. Existing v1 disks are never silently rebased; install v2 alongside v1
and use an explicit later migration operation if one is ever approved.

Building requires `qemu-img`, `virt-customize`, a libvirt-capable host, and a
guest with KVM access. A host without `/dev/kvm` can inspect or prepare an image
but cannot provide the isolated boot/persistence proof; that proof belongs to
the rollout issue (#643).
