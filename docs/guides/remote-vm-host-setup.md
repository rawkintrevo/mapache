# Remote VM host setup

This guide prepares a Linux host for the remote-libvirt provider. The first
supported host versions are Ubuntu 22.04 and 24.04. The command is run locally
on the host with `sudo`; Mapache never needs your sudo password or a copy of
your personal private key.

## Before running setup

1. Register the host in Mapache and save the generated public key as
   `mapache-remote-host.pub`.
2. Download `install.py`, `helper.py`, and `mapache_guest_config.py` from the
   same Mapache release. Inspect the files and verify their release checksums.
3. Verify the host's SSH fingerprint through an independent channel. The
   installer reports the same fingerprint from
   `/etc/ssh/ssh_host_ed25519_key.pub`.

## Install

Run this command from the directory containing the scripts and the public key:

```bash
sudo python3 install.py --public-key ./mapache-remote-host.pub
```

The installer installs the KVM/QEMU/libvirt packages when they are missing,
creates the dedicated `mapache-vm` account, installs the restricted forced
command helper, creates the private `mapache-vm` NAT network, and configures the
managed storage directory. It validates `sshd` before reloading it. It does
not flush the host firewall, restart unrelated guests, replace an existing
network definition, or overwrite an unmanaged account/configuration.
It also installs `cloud-image-utils` for private cloud-init seed disks. Each
workspace seed contains only its own session settings and access tokens; treat
it as sensitive alongside the retained workspace disk. Deletion removes both.

The generated account uses the restricted helper as its login shell, with no
interactive shell or arbitrary command evaluation. Its key can run only the
Mapache helper protocol and local forwarding to the `192.168.250.0/24` guest
network. The helper rejects arbitrary shell commands, paths and guest IDs.
The account joins the `libvirt` group to reach the system management socket;
the root-owned helper and SSH configuration constrain this privileged access.
The root-owned authorized-keys file is mode 0644 so sshd can read the public
key as the managed account. No private SSH key is installed on the host.

## Install the guest image

Build the pinned `ubuntu-24.04-v2` image using the instructions in
[`scripts/remote-vm-guest/README.md`](../../scripts/remote-vm-guest/README.md),
then copy it to the managed image directory. The credential-free base image
must be readable by both the managed account and libvirt's QEMU user:

```bash
sudo install -o root -g root -m 0644 \
  ubuntu-24.04-v2.qcow2 /var/lib/mapache-vm/images/ubuntu-24.04-v2.qcow2
```

Install v2 beside any existing v1 image. Reinstall the matching `install.py`,
`helper.py`, and `mapache_guest_config.py` from the same release before the
readiness check; the helper selects v2 for new workspaces while retained v1
disks continue to reference their original backing image. Do not overwrite or
rebase an image that an existing QCOW2 overlay references.

The following is the complete operator-side install/check block. It verifies
the sidecar checksum before any privileged write, updates the existing
root-owned helper in place (the forced-command path does not change), installs
the new base beside v1, and finishes with the read-only readiness check:

```bash
image="$PWD/ubuntu-24.04-v2.qcow2"
manifest="$image.manifest.json"
expected="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["imageSha256"])' "$manifest")"
observed="$(sha256sum "$image" | awk '{print $1}')"
test "$expected" = "$observed"
sudo install -o root -g root -m 0755 helper.py /usr/local/libexec/mapache-vm-helper
sudo install -o root -g root -m 0644 mapache_guest_config.py /usr/local/libexec/mapache_guest_config.py
sudo install -o root -g root -m 0644 "$image" /var/lib/mapache-vm/images/ubuntu-24.04-v2.qcow2
sudo python3 install.py --check-only --json
```

This block does not stop or reconfigure an existing guest. A v1 retained disk
continues to use its v1 backing image; rollback is the same block with the
previous matching helper and v1 image, after stopping only a newly created v2
guest if one exists.

The lifecycle helper creates one 40 GiB thin QCOW2 overlay per workspace under
`/var/lib/mapache-vm/disks/`. It defines 2 vCPUs, 8192 MiB, the private
`mapache-vm` network, and disables libvirt autostart. Do not rename the image,
copy owner credentials into it, or edit a workspace disk while Mapache owns it.

## Verify readiness

The check is read-only and emits machine-readable status:

```bash
python3 install.py --check-only --json
```

`ready: true` requires KVM, libvirt, the required commands, the managed NAT
network and the storage path. A missing `/dev/kvm`, inactive libvirt service or
missing `virsh` is an actionable failure. The host fingerprint and capacity
fields are safe to copy into the Mapache setup form; no private key is printed.

Re-running the install command is supported. The managed public key is added
only once, retained guest disks and unrelated libvirt resources are preserved,
and a changed unmanaged file causes a visible refusal instead of an overwrite.
Host removal is rejected while a workspace or cleanup operation still
references this host.

## Troubleshooting readiness

Use the JSON check to distinguish setup from connectivity failures:

```bash
python3 install.py --check-only --json
```

`kvmAvailable: false` means the machine cannot run the isolated guest (often
because `/dev/kvm` is unavailable); do not register it as ready. A missing
`virsh`, inactive libvirt service, missing managed NAT network, or missing
storage path must be repaired with the matching installer release and then
checked again. A host-key mismatch is a trust failure: stop, verify the
fingerprint independently, and use the Mapache host page to retry verification;
never replace the pinned fingerprint just to make a test pass.

If a live canary loses SSH or the gateway, leave the workspace in its visible
pending/error state and retry the provider operation after connectivity is
restored. Do not remove the managed network or guest disk manually. Offline
deletion is retried by the provider and must be confirmed by the final host
inventory before the canary is considered clean.

## Revoke access

Remove the generated public-key line from the managed account's
`/etc/mapache-vm/authorized_keys`, then remove or disable the host in Mapache.
The app revokes its private key reference and will not create new tunnels. Do
not delete the host's libvirt network or guest disks while workspaces still
reference them; workspace deletion queues verified helper cleanup and keeps an
offline deletion pending for retry.

