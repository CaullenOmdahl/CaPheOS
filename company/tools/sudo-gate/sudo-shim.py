#!/usr/bin/python3 -I
"""sudo shim for the company's agents. Installed at ~/.local/bin/sudo of the company's Unix user, first on the station PATH.

The owner's own shells and the operator's Claude Code session are NOT station descendants, so they get the real
/usr/bin/sudo unchanged (passwordless, exactly as now). Only a process whose ancestry runs the station
(sidecar/index.js) is routed to the root broker over /run/capheos-sudo-gate.sock, which runs a fixed allowlist.
Detection fails OPEN: if the ancestry walk cannot decide, the caller is treated as the owner and gets real sudo,
so the owner can never be locked out by a bug here. Under the hard gate (NoNewPrivileges on starnet.service) that
fail-open is backstopped by the kernel, which denies setuid sudo to every station process regardless of this shim.

Agent-facing behavior: parses the sudo options agents use (-n, -u/--user, -S, -E, -H, -k, -A, -p <x>, --), sends
the remaining command to the broker, streams stdin/stdout/stderr, and exits with the command's code. `sudo -l`/`-v`
print the gate policy and succeed so liveness probes keep working. A login/shell request (-i/-s) is refused.
"""
import os, select, socket, struct, sys

REAL_SUDO = '/usr/bin/sudo'
GATE_SOCK = '/run/capheos-sudo-gate.sock'
VALUE_OPTS = {'-u', '--user', '-g', '--group', '-p', '--prompt', '-C', '--close-from', '-r', '--role',
              '-t', '--type', '-h', '--host', '-U', '--other-user', '-R', '--chroot', '-T', '--command-timeout'}
BOOL_OPTS = {'-n', '--non-interactive', '-S', '--stdin', '-E', '--preserve-env', '-H', '--set-home', '-k',
             '--reset-timestamp', '-A', '--askpass', '-b', '--background', '-K', '--remove-timestamp', '-P',
             '--preserve-groups', '-N', '--no-update'}


def exec_real():
    os.execv(REAL_SUDO, [REAL_SUDO] + sys.argv[1:])


def runs_station(pid):
    """True when process `pid` is the station itself: an argv field is (…/)sidecar/index.js, not a mere mention."""
    try:
        with open('/proc/%d/cmdline' % pid, 'rb') as f:
            fields = f.read().split(b'\0')
    except OSError:
        return False
    return any(a == b'sidecar/index.js' or a.endswith(b'/sidecar/index.js') for a in fields)


def under_station():
    """True only when an ancestor is the station. The starnet.service cgroup is the definitive signal (no false
    positives); the argv walk is a fallback for a process that broke away from the cgroup. Any uncertainty returns
    False, so the owner and operator always reach real sudo — a misdetection can only over-restrict an agent."""
    try:
        pid = os.getppid()
        for _ in range(60):
            if pid <= 1:
                return False
            try:
                with open('/proc/%d/cgroup' % pid) as f:
                    if '/starnet.service' in f.read():
                        return True
            except OSError:
                pass
            if runs_station(pid):
                return True
            with open('/proc/%d/stat' % pid) as f:
                st = f.read()
            pid = int(st[st.rindex(')') + 2:].split()[1])
    except (OSError, ValueError, IndexError):
        return False
    return False


def parse(argv):
    """Return (user, meta, command_argv). meta is 'list'|'validate'|None. Raises ValueError on -i/-s/-e."""
    user, meta, i = 'root', None, 0
    while i < len(argv):
        a = argv[i]
        if a == '--':
            i += 1
            break
        if a in ('-i', '--login', '-s', '--shell'):
            raise ValueError('the gate does not run login or shell sessions (%s)' % a)
        if a in ('-e', '--edit'):
            raise ValueError('sudoedit is not available through the gate')
        if a in ('-l', '--list'):
            meta = 'list'; i += 1; continue
        if a in ('-v', '--validate'):
            meta = 'validate'; i += 1; continue
        if a in ('-V', '--version'):
            meta = 'validate'; i += 1; continue
        if a.startswith('--') and '=' in a:
            f, v = a.split('=', 1)
            if f in ('-u', '--user'):
                user = v
            i += 1; continue
        if a in VALUE_OPTS:
            if a in ('-u', '--user'):
                if i + 1 >= len(argv):
                    raise ValueError('%s needs a value' % a)
                user = argv[i + 1]
            i += 2; continue
        if a in BOOL_OPTS:
            i += 1; continue
        if a.startswith('-') and a != '-':
            m = a[1]
            if ('-' + m) in VALUE_OPTS and len(a) > 2:
                if m == 'u':
                    user = a[2:]
                i += 1; continue
            if all(('-' + c) in BOOL_OPTS for c in a[1:]):
                i += 1; continue
            raise ValueError('option %s is not supported by the gate' % a)
        break
    return user, meta, argv[i:]


def policy_text():
    return ('sudo-gate: agents may run, as root, only the allowlisted commands\n'
            '    docker (the company subcommands, no host-power flags), ufw status, ss, journalctl (read),\n'
            '    snapper list, btrfs subvolume list|show, cryptsetup status, nft list, iptables -S/-L, sshd -T,\n'
            '    id, true; and as nobody: true, id, curl. Anything else is refused -- run it without sudo.\n'
            '    Policy: /usr/local/lib/capheos-sudo-gate/broker.py. Log: company/work/security/sudo-gate.log\n')


def recv_exact(sock, n):
    buf = b''
    while len(buf) < n:
        c = sock.recv(n - len(buf))
        if not c:
            raise EOFError
        buf += c
    return buf


def talk(user, command):
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.connect(GATE_SOCK)
    except OSError as e:
        sys.stderr.write('sudo-gate: cannot reach the gate (%s); is capheos-sudo-gate.socket installed and running?\n' % e)
        return 1
    want_stdin = not sys.stdin.isatty()
    import json
    sock.sendall((json.dumps({'v': 1, 'argv': command, 'user': user, 'stdin': want_stdin}) + '\n').encode())
    stdin_fd = sys.stdin.fileno() if want_stdin else None
    stdin_open = want_stdin
    outmap = {1: sys.stdout.buffer, 2: sys.stderr.buffer}
    buf = b''
    while True:
        rl = [sock]
        if stdin_open:
            rl.append(stdin_fd)
        r, _, _ = select.select(rl, [], [])
        if stdin_open and stdin_fd in r:
            try:
                data = os.read(stdin_fd, 65536)
            except OSError:
                data = b''
            try:
                sock.sendall(struct.pack('>I', len(data)) + data)
            except OSError:
                pass
            if not data:
                stdin_open = False
        if sock in r:
            chunk = sock.recv(65536)
            if not chunk:
                return 1
            buf += chunk
            while len(buf) >= 5:
                ch, n = struct.unpack('>BI', buf[:5])
                if len(buf) < 5 + n:
                    break
                payload, buf = buf[5:5 + n], buf[5 + n:]
                if ch == 3:
                    try:
                        for w in outmap.values():
                            w.flush()
                    except OSError:
                        pass
                    try:
                        return int(payload or b'1')
                    except ValueError:
                        return 1
                w = outmap.get(ch)
                if w:
                    try:
                        w.write(payload); w.flush()
                    except OSError:
                        pass


def main():
    if not under_station():
        exec_real()  # owner / operator: real passwordless sudo, unchanged
    try:
        user, meta, command = parse(sys.argv[1:])
    except ValueError as e:
        sys.stderr.write('sudo-gate: refused: %s\n' % e)
        return 1
    if meta == 'list':
        sys.stdout.write(policy_text()); return 0
    if meta == 'validate':
        return 0
    if not command:
        sys.stderr.write('sudo-gate: a command is required (the gate runs an allowlist, not a shell)\n'); return 1
    return talk(user, command)


if __name__ == '__main__':
    sys.exit(main())
