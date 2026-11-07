"""Real nftables tests in an unprivileged network namespace; never touch host rules."""
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

SPEC = importlib.util.spec_from_file_location('gateway', Path(__file__).with_name('install.py'))
gateway = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gateway)


def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True).stdout


def namespace_checks():
    run('ip', 'link', 'set', 'lo', 'up')
    run('ip', 'route', 'add', 'default', 'dev', 'lo')
    run('ip', '-6', 'route', 'add', 'default', 'dev', 'lo')
    with tempfile.NamedTemporaryFile(mode='w') as f:
        f.write(gateway.firewall(0, ['127.0.0.53'], ['8.8.8.8/32']))
        f.flush()
        run('nft', '-f', f.name)
        run('nft', '-f', f.name)  # Restart atomically replaces only our table.
    def counters():
        data = json.loads(run('nft', '-j', 'list', 'chain', 'inet', 'mapache_gateway', 'web_only'))
        return [e['counter']['packets'] for item in data['nftables'] if 'rule' in item
                for e in item['rule']['expr'] if 'counter' in e]
    def attempt(host, port, expected):
        before = counters()
        family = socket.AF_INET6 if ':' in host else socket.AF_INET
        with socket.socket(family, socket.SOCK_STREAM) as sock:
            sock.settimeout(.05)
            sock.connect_ex((host, port))
        after = counters()
        assert after[expected] > before[expected], (host, port, before, after)
        if expected != 2:
            assert after[2] == before[2], ('Denied traffic reached allow rule', host)
    # Counters: local, forbidden IPv4, web allow, default deny.
    for host in ('127.0.0.1', '127.0.0.53', '::1'):
        attempt(host, 80, 0)
    for host in ('10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254',
                 '100.100.100.100', '198.18.0.1', '8.8.8.8'):
        attempt(host, 443, 1)
    attempt('1.1.1.1', 443, 2)
    attempt('1.1.1.1', 80, 2)
    attempt('1.1.1.1', 22, 3)
    attempt('2606:4700:4700::1111', 443, 3)
    # Explicit resolver is permitted, other loopback DNS is not.
    before = counters()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.sendto(b'test', ('127.0.0.53', 53))
    assert counters() == before
    # Different UID must not be subject to this policy.
    with tempfile.NamedTemporaryFile(mode='w') as f:
        f.write(gateway.firewall(12345, ['127.0.0.53'], ['8.8.8.8/32']))
        f.flush()
        run('nft', '-f', f.name)
    with socket.socket() as sock:
        sock.settimeout(.05)
        sock.connect_ex(('127.0.0.1', 80))
    assert counters() == [0, 0, 0, 0]


class GatewayTests(unittest.TestCase):
    def test_firewall_real_packets(self):
        run('unshare', '--user', '--map-root-user', '--net', sys.executable, __file__, '--namespace')

    def test_effective_sshd_settings_and_admin_unchanged(self):
        with tempfile.TemporaryDirectory() as d:
            key = str(Path(d) / 'host_key')
            run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', key)
            config = Path(d) / 'sshd_config'
            include = Path(d) / 'gateway.conf'
            include.write_text(gateway.ssh_config())
            config.write_text(f'Include {include}\nHostKey {key}\nUsePAM yes\nSubsystem sftp internal-sftp\n')
            args = ['/usr/sbin/sshd', '-T', '-f', str(config), '-C']
            effective = run(*args, 'user=mapache_tunnel,host=localhost,addr=127.0.0.1')
            gateway.settings_verified(effective)
            with self.assertRaises(ValueError):
                gateway.settings_verified(effective.replace('allowtcpforwarding local', 'allowtcpforwarding yes'))
            admin = run(*args, 'user=existing_admin,host=localhost,addr=127.0.0.1')
            self.assertIn('allowtcpforwarding yes\n', admin)
            self.assertIn('forcecommand none\n', admin)
            self.assertNotIn(gateway.RUNTIME, admin)


if __name__ == '__main__':
    if '--namespace' in sys.argv:
        namespace_checks()
    else:
        unittest.main()
