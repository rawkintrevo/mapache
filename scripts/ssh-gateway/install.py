#!/usr/bin/env python3
"""Install a dedicated, IPv4 web-only SSH gateway on Ubuntu/Debian with systemd."""
import argparse
import datetime
import ipaddress
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys

USER = 'mapache_tunnel'
CONFIG = Path('/etc/mapache-ssh-gateway')
SSH_CONFIG = Path('/etc/ssh/sshd_config.d/00-mapache-gateway.conf')
UNIT = Path('/etc/systemd/system/mapache-ssh-gateway.service')
RUNTIME = '/run/mapache-ssh-gateway'
# IPv4 special-use ranges; IPv6 is entirely denied for this account.
BLOCKED = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
           '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
           '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
           '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4']


def firewall(uid, resolvers, denied):
    addresses = ', '.join(BLOCKED + denied)
    dns = ', '.join(resolvers)
    return f'''# Only this dedicated account is filtered; never flush the host ruleset.
add table inet mapache_gateway
flush table inet mapache_gateway
table inet mapache_gateway {{
  chain output {{
    type filter hook output priority 10; policy accept;
    meta skuid {uid} jump web_only
  }}
  chain web_only {{
    ip daddr {{ {dns} }} udp dport 53 accept
    ip daddr {{ {dns} }} tcp dport 53 accept
    fib daddr type {{ local, broadcast, multicast }} counter reject
    ip daddr {{ {addresses} }} counter reject
    meta nfproto ipv4 tcp dport {{ 80, 443 }} counter accept
    counter reject
  }}
}}
'''


def ssh_config():
    return f'''# Dedicated gateway only. Existing administrator logins are unaffected.
Match User {USER}
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    TrustedUserCAKeys none
    AuthorizedKeysCommand none
    AuthorizedKeysFile {RUNTIME}/authorized_keys
    AllowTcpForwarding local
    AllowStreamLocalForwarding no
    PermitListen none
    PermitOpen *:80 *:443
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    PermitTunnel no
    PermitUserRC no
    ForceCommand /bin/false
Match all
'''


def service(uid):
    # /run starts empty on boot. A failed firewall load cannot publish the key.
    # Stop removes authorization and kills existing tunnels, retaining the firewall.
    return f'''[Unit]
Description=Mapache restricted SSH gateway
After=network.target nftables.service

[Service]
Type=oneshot
RemainAfterExit=yes
RuntimeDirectory=mapache-ssh-gateway
RuntimeDirectoryMode=0755
ExecStart=/usr/sbin/nft -f {CONFIG}/firewall.nft
ExecStart=/usr/bin/install -o root -g root -m 0644 {CONFIG}/authorized_keys {RUNTIME}/authorized_keys
ExecStopPost=/usr/bin/rm -f {RUNTIME}/authorized_keys
ExecStopPost=-/usr/bin/pkill -KILL -u {uid}

[Install]
WantedBy=multi-user.target
'''


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def settings_verified(output):
    settings = dict(line.split(' ', 1) for line in output.splitlines() if ' ' in line)
    expected = {
        'authenticationmethods': 'publickey', 'pubkeyauthentication': 'yes',
        'usepam': 'yes',
        'passwordauthentication': 'no', 'kbdinteractiveauthentication': 'no',
        'trustedusercakeys': 'none', 'authorizedkeyscommand': 'none',
        'authorizedkeysfile': f'{RUNTIME}/authorized_keys',
        'allowtcpforwarding': 'local', 'allowstreamlocalforwarding': 'no',
        'permitlisten': 'none', 'permitopen': '*:80 *:443', 'permittty': 'no',
        'x11forwarding': 'no', 'allowagentforwarding': 'no', 'permittunnel': 'no',
        'permituserrc': 'no', 'forcecommand': '/bin/false',
    }
    for name, value in expected.items():
        if settings.get(name) != value:
            raise ValueError(f'Effective sshd setting {name} must be {value!r}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public-key', type=Path, required=True)
    parser.add_argument('--public-ip', required=True, help='Gateway/router public IPv4; also blocked as a destination')
    parser.add_argument('--deny-cidr', action='append', default=[], help='Additional routed/internal IPv4 network to deny')
    parser.add_argument('--expires', required=True, help='Key expiry date, YYYY-MM-DD (00:00 UTC)')
    args = parser.parse_args()
    public_ip = ipaddress.IPv4Address(args.public_ip)
    if not public_ip.is_global:
        parser.error('--public-ip must be a globally routable IPv4 address')
    denied = [str(public_ip) + '/32'] + [str(ipaddress.IPv4Network(v)) for v in args.deny_cidr]
    expiry = datetime.datetime.strptime(args.expires, '%Y-%m-%d').replace(tzinfo=datetime.timezone.utc)
    if not datetime.datetime.now(datetime.timezone.utc) < expiry <= datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=90):
        parser.error('Expiry must be in the future and within 90 days')
    key = args.public_key.read_text().strip()
    if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?', key):
        parser.error('Supply a single plain Ed25519 public key, without key options')
    run('ssh-keygen', '-l', '-f', str(args.public_key), stdout=subprocess.DEVNULL)
    key = ' '.join(key.split()[:2])
    resolvers = [str(ipaddress.IPv4Address(line.split()[1])) for line in Path('/etc/resolv.conf').read_text().splitlines()
                 if line.startswith('nameserver ') and ':' not in line.split()[1]]
    if not resolvers:
        parser.error('At least one IPv4 resolver in /etc/resolv.conf is required')
    if os.geteuid() != 0:
        parser.error('Run this installer locally with sudo; never send anyone your password')
    for command in ('nft', 'sshd', 'useradd', 'systemctl', 'pkill', 'install'):
        if not shutil.which(command):
            parser.error(f'Missing dependency: {command}')
    for path in (CONFIG, SSH_CONFIG, UNIT, Path(RUNTIME)):
        if path.exists():
            parser.error(f'Refusing to overwrite existing installation: {path}')
    try:
        pwd.getpwnam(USER)
    except KeyError:
        pass
    else:
        parser.error(f'Refusing to reuse existing account: {USER}')
    if subprocess.run(['nft', 'list', 'table', 'inet', 'mapache_gateway'], capture_output=True).returncode == 0:
        parser.error('Refusing to overwrite existing mapache_gateway firewall table')
    run('sshd', '-t')
    run('systemctl', 'is-active', '--quiet', 'ssh.service')
    os.umask(0o077)
    # No reusable password, home, supplementary groups or interactive shell.
    run('useradd', '--system', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', USER)
    uid = pwd.getpwnam(USER).pw_uid
    try:
        CONFIG.mkdir(mode=0o755)
        (CONFIG / 'firewall.nft').write_text(firewall(uid, resolvers, denied))
        (CONFIG / 'authorized_keys').write_text(
            f'restrict,port-forwarding,command="/bin/false",permitopen="*:80",permitopen="*:443",expiry-time="{expiry:%Y%m%d}Z" {key}\n')
        (CONFIG / 'authorized_keys').chmod(0o600)
        SSH_CONFIG.write_text(ssh_config())
        UNIT.write_text(service(uid))
        run('nft', '--check', '-f', str(CONFIG / 'firewall.nft'))
        run('sshd', '-t')
        effective = run('sshd', '-T', '-C', f'user={USER},host=localhost,addr=127.0.0.1', capture_output=True).stdout
        settings_verified(effective)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'enable', '--now', 'mapache-ssh-gateway.service')
        run('systemctl', 'reload', 'ssh.service')
    except Exception:
        # Revoke the new account; retain its UID and firewall to avoid UID-reuse leaks.
        subprocess.run(['systemctl', 'disable', '--now', 'mapache-ssh-gateway.service'], capture_output=True)
        Path(f'{RUNTIME}/authorized_keys').unlink(missing_ok=True)
        SSH_CONFIG.unlink(missing_ok=True)
        subprocess.run(['sshd', '-t'], check=True)
        subprocess.run(['systemctl', 'reload', 'ssh.service'], check=True)
        print('Installation failed; key revoked. Inspect retained account/config before retrying.', file=sys.stderr)
        raise
    print('Gateway installed. Verify forwarding and denial checks before moving any live tunnel.')
    print('To revoke immediately: sudo systemctl disable --now mapache-ssh-gateway.service')


if __name__ == '__main__':
    main()
