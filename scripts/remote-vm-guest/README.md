# Versioned remote VM guest image

`manifest.json` is the v5 guest contract for the remote-libvirt provider:
Ubuntu 24.04 LTS (amd64), 2 vCPU, 8 GiB RAM, and one 40 GiB thin QCOW2 disk.
The base image is a dated Ubuntu release artifact with a checked-in SHA-256;
the builder refuses a changed or unverified base image.

The guest payload is extracted from an immutable `remote-vm-runner` image. That
image is built by `session-runner/Dockerfile.remote-vm-runner` and uses the
upstream pi-web-ui release without the GCP `managed-keel` integration patch.
It retains the native terminal protocol, pi-web-ui, connected Chrome, and the
remote credential/runtime files. Installation-skill files are intentionally
absent. The image builder installs a checksum-pinned Google Chrome package and
its desktop dependencies. The extraction command must receive a
content-addressed Docker image (`image@sha256:...`); a mutable tag is rejected.

Build the independent runtime image with the VM-specific Cloud Build
configuration before preparing the QCOW2 payload:

```bash
gcloud builds submit session-runner \
  --project pi-agents-cloud \
  --config session-runner/cloudbuild.remote-vm-runner.yaml \
  --substitutions=_IMAGE=us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:remote-vm-runner
```

Record the resulting image digest and use that immutable reference in the
payload command below. The GCP runner image and its compatibility tag are not
inputs to this build.

```bash
scripts/remote-vm-guest/prepare-repaired-vm-payload.sh \
  us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:VM_IMAGE_DIGEST \
  /tmp/mapache-guest-payload

scripts/remote-vm-guest/build-image.py \
  --base-image /var/tmp/ubuntu-24.04-server-cloudimg-amd64.img \
  --payload /tmp/mapache-guest-payload \
  --output /var/lib/mapache-vm/images/ubuntu-24.04-v5.qcow2
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
only. Keep existing backing images in place. Install v5 alongside earlier
versions and use an explicit later migration operation if one is ever approved.

Building requires `qemu-img`, `virt-customize`, a libvirt-capable host, and a
guest with KVM access. A host without `/dev/kvm` can inspect or prepare an image
but cannot provide the isolated boot/persistence proof; that proof belongs to
the rollout issue (#643).
