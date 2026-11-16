#!/usr/bin/python3 -I -S
"""capheos-sudo-gate broker: runs a fixed allowlist of root commands on behalf of the company's agents.

Installed root-owned at /usr/local/lib/capheos-sudo-gate/broker.py and started once per connection by
capheos-sudo-gate.socket (Accept=yes) on /run/capheos-sudo-gate.sock (owned by the company's Unix user, mode 0600).
The source of truth is company/tools/sudo-gate/broker.py; editing that copy changes nothing until the owner or
operator reinstalls with install.sh, because agents cannot write the installed copy and, under NoNewPrivileges,
cannot sudo. install.sh also writes gate.json next to the installed copy (root-owned): the project root and the
uid/gid allowed to use the gate. Run from the source tree (selftest), the project root is three folders up and the
owner is whoever owns it.

Policy (decide() below; fail closed on anything not listed):
  root:   true | id [flags] | docker <listed subcommands, no host-power flags, named volumes only (no host binds);
          exec/start refused into a container that has host power> | ufw status [numbered|verbose]
          | ss -<tulnpaex4 6H> | journalctl <read options> | snapper list-configs | snapper -c <cfg> list
          | btrfs subvolume list|show | cryptsetup status <name> | nft list ruleset|tables|table <f> <n>
          | iptables/ip6tables -S|-L (read flags) | sshd -T
  nobody: true | id | curl (another-uid probes; nobody can read only what any local user can)
Generic tools as root (cat, grep, ls, curl, tr, sh ...) are refused: run them without sudo.

Protocol: client sends one JSON line {"v":1,"argv":[...],"user":"root"|"nobody","stdin":bool}, then, if stdin,
frames of 4-byte big-endian length + bytes (length 0 = EOF). Broker answers frames of 1-byte channel
(1 stdout, 2 stderr, 3 exit) + 4-byte length + payload; the exit payload is the decimal exit code.
Every request is logged to the journal (this process's stderr) and to company/work/security/sudo-gate.log.

Guardrail privilegedShell (company/tools/guardrails.js, the owner's switch): OFF makes the gate pass sudo through (any
command by name from the system bin folders or by absolute path, as root or nobody), still logged, decision
"allowed-unguarded". Because the project's company/state/guardrails.json is writable by the company's user (and so by
agents), OFF needs BOTH that file saying privilegedShell false AND the root-owned gate.json beside the installed broker
saying the same; install.sh copies the owner's switch into gate.json, and only root runs it. Turning the guardrail back ON
in the project file takes effect at once. Any read error = ON (the allowlist holds).
"""
import json, os, re, select, signal, socket, struct, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))


def _conf():
    """gate.json beside this file (written root-owned by install.sh), else the source-tree layout."""
    try:
        with open(os.path.join(HERE, 'gate.json')) as f:
            c = json.load(f)
        return os.path.abspath(c['project']), int(c['uid']), int(c['gid'])
    except (OSError, ValueError, KeyError, TypeError):
        root = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
        try:
            st = os.stat(root)
            return root, st.st_uid, st.st_gid
        except OSError:
            return root, -1, -1   # nobody matches: fail closed


PROJECT, OWNER_UID, OWNER_GID = _conf()
LOG = PROJECT + '/company/work/security/sudo-gate.log'
MAX_SECONDS = 1800
BIN_DIRS = ('/usr/bin', '/usr/sbin', '/bin', '/sbin', '/usr/local/bin')
BINS = {'true': '/usr/bin/true', 'id': '/usr/bin/id', 'docker': '/usr/bin/docker', 'ufw': '/usr/bin/ufw',
        'ss': '/usr/bin/ss', 'journalctl': '/usr/bin/journalctl', 'snapper': '/usr/bin/snapper',
        'btrfs': '/usr/bin/btrfs', 'cryptsetup': '/usr/bin/cryptsetup', 'nft': '/usr/bin/nft',
        'iptables': '/usr/bin/iptables', 'ip6tables': '/usr/bin/ip6tables', 'sshd': '/usr/bin/sshd',
        'curl': '/usr/bin/curl'}
HINT = 'run it without sudo, or ask the risk owner to add it to company/tools/sudo-gate/broker.py'
DOCKER_SOCK = 'unix:///var/run/docker.sock'
NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')


class Refuse(Exception):
    pass


def resolve(argv0):
    base = os.path.basename(argv0)
    if '/' in argv0 and os.path.dirname(argv0) not in BIN_DIRS:
        raise Refuse('%s: only system binaries by name are allowed' % argv0)
    if base not in BINS:
        raise Refuse('%s is not on the sudo allowlist; %s' % (base, HINT))
    return base, BINS[base]


def split_opts(args, value_flags, bool_flags):
    """Parse leading options. Returns (opts as [(flag, value)], rest). Unknown flag -> Refuse (fail closed)."""
    opts, i = [], 0
    while i < len(args):
        a = args[i]
        if a == '--':
            return opts, args[i + 1:]
        if not a.startswith('-') or a == '-':
            break
        if a.startswith('--') and '=' in a:
            f, v = a.split('=', 1)
            if f not in value_flags:
                raise Refuse('option %s is not allowed' % f)
            opts.append((f, v)); i += 1; continue
        if a in value_flags:
            if i + 1 >= len(args):
                raise Refuse('option %s needs a value' % a)
            opts.append((a, args[i + 1])); i += 2; continue
        if a in bool_flags:
            opts.append((a, None)); i += 1; continue
        if re.match(r'^-[A-Za-z]{2,}$', a) and all(('-' + c) in bool_flags for c in a[1:]):
            opts.extend(('-' + c, None) for c in a[1:]); i += 1; continue
        m = re.match(r'^(-[A-Za-z])(.+)$', a)
        if m and m.group(1) in value_flags:
            opts.append((m.group(1), m.group(2))); i += 1; continue
        raise Refuse('option %s is not allowed' % a)
    return opts, args[i:]


def split_any(args, value_flags, bool_flags):
    """Like split_opts, but options may follow positionals (docker read commands, journalctl both allow it)."""
    opts, pos, rest = [], [], list(args)
    while rest:
        o, r = split_opts(rest, value_flags, bool_flags)
        opts += o
        if len(r) == len(rest) and r and r[0] == '--':
            pos += r[1:]; break
        if not r:
            break
        if r[0].startswith('-') and r[0] != '-':
            raise Refuse('option %s is not allowed' % r[0])
        pos.append(r[0]); rest = r[1:]
    return opts, pos


# ---- docker ----------------------------------------------------------------------------------------------------
FMT = {'--format', '-f'}
D_READ = {  # subcommand: (value flags, bool flags, positional rule)
    'ps': ({'--format', '--filter', '-f', '-n', '--last'}, {'-a', '--all', '-q', '--quiet', '--no-trunc', '-l', '--latest', '-s', '--size'}, 'none'),
    'images': ({'--format', '--filter', '-f'}, {'-a', '--all', '-q', '--quiet', '--no-trunc', '--digests'}, 'opt1'),
    'version': ({'--format', '-f'}, set(), 'none'),
    'info': ({'--format', '-f'}, set(), 'none'),
    'port': (set(), set(), 'some'),
    'inspect': ({'--format', '-f', '--type'}, {'-s', '--size'}, 'some'),
    'logs': ({'--tail', '-n', '--since', '--until'}, {'-t', '--timestamps', '--details'}, 'one'),
    'start': (set(), set(), 'some'),
    'stop': ({'-t', '--time', '-s', '--signal'}, set(), 'some'),
    'rm': (set(), {'-f', '--force', '-v', '--volumes'}, 'some'),
}
D_GROUPS = {
    ('image', 'inspect'): ({'--format', '-f'}, set(), 'some'),
    ('image', 'ls'): D_READ['images'],
    ('container', 'ls'): D_READ['ps'],
    ('container', 'inspect'): ({'--format', '-f'}, {'-s', '--size'}, 'some'),
    ('context', 'inspect'): ({'--format', '-f'}, set(), 'any'),
    ('context', 'ls'): ({'--format', '-f'}, {'-q', '--quiet'}, 'none'),
    ('network', 'ls'): ({'--format', '--filter', '-f'}, {'-q', '--quiet', '--no-trunc'}, 'none'),
    ('volume', 'ls'): ({'--format', '--filter', '-f'}, {'-q', '--quiet'}, 'none'),
    # `volume inspect` is read-only metadata and is the only command that can attribute an anonymous volume:
    # volume ls alone yields an ID and no author, so an audit sweep could name a gap and never close it.
    ('volume', 'inspect'): ({'--format', '-f'}, set(), 'some'),
}
RUN_VALUE = {'--name', '-e', '--env', '-p', '--publish', '-l', '--label', '-v', '--volume', '-w', '--workdir',
             '-u', '--user', '--network', '--net', '--network-alias', '--hostname', '-h', '--memory', '-m',
             '--cpus', '--restart', '--entrypoint', '--health-cmd', '--health-interval', '--health-timeout',
             '--health-retries', '--health-start-period', '--shm-size', '--tmpfs', '--stop-timeout', '--platform',
             '--pull', '--add-host', '--dns', '--expose', '--ulimit', '--pids-limit', '--stop-signal', '--log-opt',
             '--log-driver'}
RUN_BOOL = {'-d', '--detach', '--rm', '-i', '--interactive', '-t', '--tty', '--init', '--read-only', '-P',
            '--publish-all', '--no-healthcheck'}
# Named on purpose, so a refusal says why rather than "not allowed": each one hands a container host power,
# or makes the root-run CLI read or write a host file.
RUN_DANGER = {'--privileged', '--cap-add', '--device', '--device-cgroup-rule', '--pid', '--ipc', '--uts',
              '--userns', '--cgroupns', '--security-opt', '--mount', '--volumes-from', '--volume-driver',
              '--env-file', '--label-file', '--cidfile', '--cgroup-parent', '--runtime', '--gpus', '--sysctl',
              '--isolation', '--oom-kill-disable', '--group-add'}
EXEC_VALUE = {'-e', '--env', '-u', '--user', '-w', '--workdir'}
EXEC_BOOL = {'-i', '--interactive', '-t', '--tty', '-d', '--detach'}


VOLUME_OPTS = {'ro', 'rw', 'nocopy'}
BIND_HINT = ('use a named volume (-v name:/path), or move data through the gate: '
             'docker exec -i <c> ... < file, docker exec <c> ... > file')


def check_bind(spec):
    """Named local volumes only. Host-path bind mounts are refused, inside the project and /tmp too: container
    root is host root here (no userns remap), so a writable host bind
    let a container leave setuid-root or root-owned files where the agent can reach them, and even a read-only one
    is open to a swap race (the agent owns the directory and can replace it with a symlink between this check and
    dockerd's mount). Agents rarely need a bind; named volumes and exec -i cover moving data."""
    parts = spec.split(':')
    src = parts[0]
    if len(parts) < 2:
        raise Refuse('-v %s: anonymous volumes need a container path' % spec)
    if len(parts) > 3:
        raise Refuse('-v %s: malformed volume spec' % spec)
    if src.startswith('/') or src.startswith('.') or src.startswith('~'):
        raise Refuse('-v %s: host bind mounts are refused through the gate (a root container could leave setuid or '
                     'root-owned files on the host); %s' % (spec, BIND_HINT))
    if not NAME_RE.match(src):
        raise Refuse('-v %s: not a valid volume name' % spec)
    if not parts[1].startswith('/'):
        raise Refuse('-v %s: the container path must be absolute' % spec)
    if len(parts) == 3 and not set(parts[2].split(',')) <= VOLUME_OPTS:
        raise Refuse('-v %s: volume options may be only ro, rw, nocopy' % spec)


# exec/start reach a container that already exists, possibly one the owner made with host power. The broker
# inspects each target before running (runtime, see guard_targets) and refuses one with any of these.
def host_power(info):
    """info = one element of `docker inspect --type container`. Returns a refusal reason, or None if harmless."""
    hc = info.get('HostConfig') or {}
    for key, bad in (('Privileged', lambda v: bool(v)), ('CapAdd', lambda v: bool(v)), ('Devices', lambda v: bool(v)),
                     ('DeviceCgroupRules', lambda v: bool(v)), ('SecurityOpt', lambda v: bool(v)),
                     ('PidMode', lambda v: v == 'host'), ('IpcMode', lambda v: v == 'host'),
                     ('UTSMode', lambda v: v == 'host'), ('UsernsMode', lambda v: v == 'host'),
                     ('CgroupnsMode', lambda v: v == 'host'), ('NetworkMode', lambda v: v == 'host'),
                     ('Binds', lambda v: any(str(b).startswith('/') for b in (v or []))),
                     ('VolumesFrom', lambda v: bool(v))):
        if bad(hc.get(key)):
            return 'it has %s=%s' % (key, json.dumps(hc.get(key))[:80])
    for m in info.get('Mounts') or []:
        if m.get('Type') not in ('volume', 'tmpfs'):
            return 'it has a %s mount of a host path' % m.get('Type')
    return None


def docker_targets(cmd):
    """Containers an allowed docker exec/start would touch (pure). cmd is decide()'s output."""
    if not cmd or os.path.basename(cmd[0]) != 'docker':
        return []
    _, rest = split_opts(cmd[1:], {'--host', '-H'}, set())
    if not rest:
        return []
    if rest[0] == 'exec':
        _, r = split_opts(rest[1:], EXEC_VALUE, EXEC_BOOL)
        return r[:1]
    if rest[0] == 'start':
        return list(rest[1:])
    return []


def check_run(args):
    for a in args:
        if a.startswith('-'):
            f = a.split('=', 1)[0]
            if f in RUN_DANGER:
                raise Refuse('docker %s is refused: it gives the container host power or reads a host file as root' % f)
        else:
            break
    opts, rest = split_opts(args, RUN_VALUE, RUN_BOOL)
    for f, v in opts:
        if f in ('--network', '--net') and v == 'host':
            raise Refuse('docker --network=host is refused')
        if f in ('-p', '--publish') and not v.startswith('127.0.0.1:'):
            raise Refuse('docker -p %s is refused: publish on 127.0.0.1 only (ruling C4), e.g. 127.0.0.1::5432' % v)
        if f in ('-P', '--publish-all'):
            raise Refuse('docker -P publishes on every address; use -p 127.0.0.1::<port> (ruling C4)')
        if f in ('-v', '--volume'):
            check_bind(v)
        if f in ('--log-driver',) and v not in ('json-file', 'local', 'none'):
            raise Refuse('docker --log-driver %s is refused' % v)
    if not rest:
        raise Refuse('docker run/create needs an image')
    check_image(rest[0])


# --- image references ---------------------------------------------------------------------------
# Why this exists: `docker run` was allowed for ANY image reference, so `docker run --rm
# ghcr.io/someone/thing:1 true` fetched and ran a third-party image as root — while `docker pull` was
# refused as if that were the door. The two are the same capability (docker pulls a missing image
# implicitly on `run`), so a refusal of `pull` alone removes nothing and the hole is on `run`:
# `sudo -n docker run --rm hello-world` fetches an image that was not on the host.
# The rule: a public Docker Hub library reference — `name[:tag][@sha256:…]`, optionally `library/` —
# and nothing else. A reference that carries a registry host (any '…/' with a '.' or ':' in the first
# segment, or any other namespace) is refused, because "fetch this image from that server" is the
# supply-chain decision and it does not get made by whoever types the longest command.
IMAGE_REF = re.compile(r'^(library/)?[a-z0-9][a-z0-9._-]{0,63}(:[A-Za-z0-9][A-Za-z0-9._-]{0,127})?(@sha256:[0-9a-f]{64})?$')


def check_image(ref):
    if ref.startswith('-'):
        raise Refuse('docker image reference %r starts with "-" — that is a flag, not an image' % ref)
    if not IMAGE_REF.match(ref):
        raise Refuse('docker image %r is not a public Docker Hub library reference '
                     '(name[:tag][@sha256:…], optional library/ prefix). A registry host in the '
                     'reference is refused: use `docker image inspect <name>` to check what is local, '
                     'and ask the risk owner before the company pulls from a third-party registry' % ref)


def check_pull(args):
    opts, rest = split_opts(args, set(), set())
    if opts:
        raise Refuse('docker pull with options is refused (%s); the allowlist is name[:tag][@sha256:…] only'
                     % opts[0][0])
    if len(rest) != 1:
        raise Refuse('docker pull takes exactly one image reference')
    check_image(rest[0])


def check_docker(args):
    opts, rest = split_opts(args, {'--host', '-H'}, set())
    for f, v in opts:
        if v != DOCKER_SOCK:
            raise Refuse('docker --host may only be %s' % DOCKER_SOCK)
    if not rest:
        raise Refuse('docker needs a subcommand')
    sub, tail = rest[0], rest[1:]
    if sub in ('run', 'create'):
        return check_run(tail)
    if sub == 'pull':
        return check_pull(tail)
    if sub == 'exec':
        if any(a.split('=', 1)[0] == '--privileged' for a in tail):
            raise Refuse('docker exec --privileged is refused')
        o, r = split_opts(tail, EXEC_VALUE, EXEC_BOOL)
        if len(r) < 2:
            raise Refuse('docker exec needs a container and a command')
        return
    if sub in ('image', 'container', 'context', 'network', 'volume'):
        if not tail or (sub, tail[0]) not in D_GROUPS:
            raise Refuse('docker %s %s is not on the allowlist' % (sub, tail[0] if tail else ''))
        spec, tail = D_GROUPS[(sub, tail[0])], tail[1:]
    elif sub in D_READ:
        spec = D_READ[sub]
    else:
        raise Refuse('docker %s is not on the allowlist (allowed: run, create, exec, start, stop, rm, ps, port, '
                     'images, inspect, logs, version, info, image/container/context/network/volume reads)' % sub)
    if sub == 'logs' and any(a in ('-f', '--follow') for a in tail):
        raise Refuse('docker logs --follow is refused (it never ends); use --tail')
    o, r = split_any(tail, spec[0], spec[1])
    rule = spec[2]
    if rule == 'none' and r:
        raise Refuse('docker %s takes no arguments here' % sub)
    if rule in ('some', 'one') and not r:
        raise Refuse('docker %s needs a target' % sub)
    if rule == 'one' and len(r) != 1:
        raise Refuse('docker %s takes one target' % sub)
    if rule == 'opt1' and len(r) > 1:
        raise Refuse('docker %s takes at most one filter' % sub)
    for x in r:
        if x.startswith('-'):
            raise Refuse('option %s after the target is not allowed' % x)


# ---- read-only diagnostics -------------------------------------------------------------------------------------
J_VALUE = {'-u', '--unit', '-n', '--lines', '-S', '--since', '-U', '--until', '-p', '--priority', '-g', '--grep',
           '-t', '--identifier', '-o', '--output', '-b', '--boot', '--facility', '-T', '--exclude-identifier'}
J_BOOL = {'--no-pager', '-k', '--dmesg', '-r', '--reverse', '-q', '--quiet', '-a', '--all', '-x', '--catalog',
          '--utc', '--no-hostname', '--list-boots', '--disk-usage', '-e', '--pager-end', '--case-sensitive',
          '--no-full', '-l', '--full', '-m', '--merge'}
J_OUTPUTS = {'short', 'short-iso', 'short-precise', 'short-monotonic', 'short-unix', 'short-full', 'cat', 'json',
             'json-pretty', 'with-unit', 'verbose'}


def check_journalctl(args):
    # -f, --follow, --vacuum-*, --rotate, --flush, --sync, -D/--directory, --file, --root, --image, --cursor-file,
    # --setup-keys, --update-catalog, --relinquish-var are all absent from the lists above, so they are refused.
    # -b is accepted bare (this boot); an older boot is named with --boot=-1 or a positional boot id.
    opts, rest = split_any(args, J_VALUE - {'-b'}, J_BOOL | {'-b'})
    for f, v in opts:
        if f in ('-o', '--output') and v not in J_OUTPUTS:
            raise Refuse('journalctl --output %s is not allowed' % v)
    for x in rest:
        if not re.match(r'^(_?[A-Z][A-Z0-9_]*=.*|\+|-?\d+|[0-9a-f]{32}|/usr/s?bin/[\w.+-]+)$', x):
            raise Refuse('journalctl argument %r is not allowed (matches FIELD=value, a boot id or /usr/bin/<exe> only)' % x)


def guard_privileged_shell(gate_json=None, project=None, euid=None):
    """True = guardrail privilegedShell ON (the allowlist holds). See the module docstring for why OFF needs two files."""
    gate_json = gate_json or os.path.join(HERE, 'gate.json')
    project = project or PROJECT
    euid = os.geteuid() if euid is None else euid
    try:
        with open(os.path.join(project, 'company', 'state', 'guardrails.json')) as f:
            g = json.load(f)
        if not (isinstance(g, dict) and isinstance(g.get('guards'), dict) and g['guards'].get('privilegedShell') is False):
            return True
    except (OSError, ValueError):
        return True
    if os.path.exists(gate_json):
        try:
            with open(gate_json) as f:
                c = json.load(f)
            return not (isinstance(c, dict) and c.get('privilegedShell') is False)
        except (OSError, ValueError):
            return True
    # no gate.json: the source tree. Unprivileged (a selftest, a dry look) may follow the project file; root never does.
    return euid == 0


def passthrough(argv, user):
    """Guardrail privilegedShell OFF: run what was asked, as root or nobody. Still refuses a malformed request."""
    if not argv or not isinstance(argv, list) or not all(isinstance(a, str) for a in argv):
        raise Refuse('empty or malformed command')
    if any('\0' in a for a in argv) or len(argv) > 4096:
        raise Refuse('malformed command')
    if user not in ('root', 'nobody'):
        raise Refuse('the gate runs commands only as root or nobody')
    a0 = argv[0]
    if '/' in a0:
        if not os.path.isabs(a0):
            raise Refuse('%s: give a command by name or by absolute path' % a0)
        return [a0] + argv[1:]
    for d in BIN_DIRS:
        cand = os.path.join(d, a0)
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return [cand] + argv[1:]
    raise Refuse('%s was not found in %s' % (a0, ', '.join(BIN_DIRS)))


def plan(argv, user, guarded):
    """The argv to execute: the allowlist (decide) when the guardrail is ON, pass-through when it is OFF."""
    return decide(argv, user) if guarded else passthrough(argv, user)


def decide(argv, user):
    """Return the exact argv to execute, or raise Refuse. Pure: no I/O except realpath for bind sources."""
    if not argv or not isinstance(argv, list) or not all(isinstance(a, str) for a in argv):
        raise Refuse('empty or malformed command')
    if any('\0' in a or len(a) > 8192 for a in argv) or len(argv) > 256:
        raise Refuse('malformed command')
    base, path = resolve(argv[0])
    args = argv[1:]
    if user == 'nobody':
        if base not in ('true', 'id', 'curl'):
            raise Refuse('as nobody only true, id and curl are allowed (another-uid probes)')
        return [path] + args
    if user != 'root':
        raise Refuse('sudo -u %s is not allowed; only root and nobody (C8: the docker group route is closed)' % user)
    if base == 'curl':
        raise Refuse('curl as root is refused; %s' % HINT)
    if base == 'true':
        if args:
            raise Refuse('true takes no arguments')
    elif base == 'id':
        o, r = split_opts(args, set(), {'-u', '-g', '-G', '-n', '-r', '-z'})
        if len(r) > 1 or (r and not re.match(r'^[a-z_][a-z0-9_-]{0,31}$', r[0])):
            raise Refuse('id takes at most one user name')
    elif base == 'docker':
        check_docker(args)
    elif base == 'ufw':
        if not (args[:1] == ['status'] and len(args) <= 2 and (len(args) == 1 or args[1] in ('numbered', 'verbose'))):
            raise Refuse('ufw: only "ufw status [numbered|verbose]" is allowed')
    elif base == 'ss':
        if not (len(args) == 1 and re.match(r'^-[tulnpaex46H]+$', args[0])):
            raise Refuse('ss: only one flag group such as -tlnp is allowed')
    elif base == 'journalctl':
        check_journalctl(args)
        args = ['--no-pager'] + [a for a in args if a != '--no-pager']
    elif base == 'snapper':
        if args not in (['list-configs'], ['--no-dbus', 'list-configs']) and not (
                len(args) == 3 and args[0] == '-c' and NAME_RE.match(args[1]) and args[2] == 'list'):
            raise Refuse('snapper: only "snapper list-configs" and "snapper -c <config> list" are allowed')
    elif base == 'btrfs':
        if not (len(args) >= 3 and args[0] == 'subvolume' and args[1] in ('list', 'show')):
            raise Refuse('btrfs: only "btrfs subvolume list|show <path>" is allowed')
        o, r = split_opts(args[2:], set(), {'-a', '-p', '-c', '-g', '-o', '-u', '-q', '-R', '-t', '-s', '-d'})
        if len(r) != 1 or not r[0].startswith('/'):
            raise Refuse('btrfs subvolume list|show takes one absolute path')
    elif base == 'cryptsetup':
        if not (len(args) == 2 and args[0] == 'status' and NAME_RE.match(args[1])):
            raise Refuse('cryptsetup: only "cryptsetup status <name>" is allowed')
    elif base == 'nft':
        ok = args in (['list', 'ruleset'], ['list', 'tables'], ['-a', 'list', 'ruleset']) or (
            len(args) == 4 and args[:2] == ['list', 'table'] and args[2] in ('ip', 'ip6', 'inet', 'arp', 'bridge', 'netdev')
            and NAME_RE.match(args[3]))
        if not ok:
            raise Refuse('nft: only "nft list ruleset|tables" and "nft list table <family> <name>" are allowed')
    elif base in ('iptables', 'ip6tables'):
        o, r = split_opts(args, {'-t', '--table'}, {'-S', '--list-rules', '-L', '--list', '-n', '--numeric', '-v',
                                                     '--verbose', '--line-numbers', '-x'})
        flags = {f for f, v in o}
        if not flags & {'-S', '--list-rules', '-L', '--list'}:
            raise Refuse('%s: only listing (-S or -L) is allowed' % base)
        for f, v in o:
            if f in ('-t', '--table') and v not in ('filter', 'nat', 'mangle', 'raw', 'security'):
                raise Refuse('%s -t %s is not allowed' % (base, v))
        if len(r) > 1 or (r and not re.match(r'^[A-Za-z0-9_-]{1,32}$', r[0])):
            raise Refuse('%s takes at most one chain name' % base)
    elif base == 'sshd':
        if args != ['-T']:
            raise Refuse('sshd: only "sshd -T" is allowed')
    return [path] + args


# ---- runtime ---------------------------------------------------------------------------------------------------
SECRET_RE = re.compile(r'((?:PASS|PASSWORD|TOKEN|SECRET|KEY|PWD)[A-Z_]*=)[^\s]+', re.I)


def redact(s):
    return SECRET_RE.sub(r'\1<redacted>', s)


def peer_info(sock):
    pid, uid, gid = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    info = {'pid': pid, 'uid': uid, 'cwd': '?', 'station': False}
    try:
        info['cwd'] = os.readlink('/proc/%d/cwd' % pid)
    except OSError:
        pass
    try:
        with open('/proc/%d/cgroup' % pid) as f:
            info['station'] = '/starnet.service' in f.read()
    except OSError:
        pass
    p = pid
    for _ in range(40):
        if p <= 1 or info['station']:
            break
        try:
            with open('/proc/%d/cmdline' % p, 'rb') as f:
                if any(a == b'sidecar/index.js' or a.endswith(b'/sidecar/index.js') for a in f.read().split(b'\0')):
                    info['station'] = True
                    break
            with open('/proc/%d/stat' % p) as f:
                st = f.read()
            p = int(st[st.rindex(')') + 2:].split()[1])
        except (OSError, ValueError):
            break
    return info


def log(rec):
    line = json.dumps(rec, ensure_ascii=False)
    try:
        sys.stderr.write('capheos-sudo-gate ' + line + '\n'); sys.stderr.flush()
    except OSError:
        pass
    # Write the company copy as the owner, never as root: a symlink planted at the log path then fails with EACCES
    # instead of letting root append to /etc/shadow.
    try:
        os.setegid(OWNER_GID); os.seteuid(OWNER_UID)
        fd = os.open(LOG, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            os.write(fd, (line + '\n').encode())
        finally:
            os.close(fd)
    except OSError as e:
        try:
            sys.stderr.write('capheos-sudo-gate company log not written: %s\n' % e)
        except OSError:
            pass
    finally:
        os.seteuid(0); os.setegid(0)


def guard_targets(cmd):
    """Runtime half of the exec/start rule: refuse a target container that has host power. A name that does not
    resolve is left to docker, which then fails on its own; an inspect that hangs or errors otherwise fails closed."""
    for name in docker_targets(cmd):
        try:
            p = subprocess.run([BINS['docker'], 'inspect', '--type', 'container', '--', name], stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, cwd='/',
                               env={'PATH': '/usr/bin', 'LANG': 'C.UTF-8', 'HOME': '/root'})
        except (OSError, subprocess.TimeoutExpired) as e:
            raise Refuse('could not inspect container %s before running (%s)' % (name, e.__class__.__name__))
        if p.returncode != 0:
            if b'No such' in p.stderr:
                continue
            raise Refuse('could not inspect container %s before running' % name)
        try:
            infos = json.loads(p.stdout)
        except ValueError:
            raise Refuse('could not read the inspect output for %s' % name)
        for info in infos:
            why = host_power(info)
            if why:
                raise Refuse('docker exec/start into %s is refused: %s (host power is the owner\'s, not the gate\'s)'
                             % (name, why))


def send(sock, ch, data):
    sock.sendall(struct.pack('>BI', ch, len(data)) + data)


def recv_exact(sock, n):
    buf = b''
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise EOFError
        buf += chunk
    return buf


def run(sock, cmd, user, want_stdin):
    env = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/bin', 'LANG': 'C.UTF-8', 'HOME': '/root',
           'SYSTEMD_PAGER': 'cat', 'SYSTEMD_PAGERSECURE': '1', 'PAGER': 'cat', 'TERM': 'dumb'}
    pre = None
    if user == 'nobody':
        env['HOME'] = '/'

        def pre():
            os.setgroups([]); os.setgid(65534); os.setuid(65534)
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE if want_stdin else subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd='/', env=env, close_fds=True,
                            preexec_fn=pre, start_new_session=True)
    outs = {proc.stdout.fileno(): 1, proc.stderr.fileno(): 2}
    deadline = time.monotonic() + MAX_SECONDS
    stdin_open, pending, sock_open = want_stdin, b'', True
    killed = None
    while outs:
        if time.monotonic() > deadline:
            killed = 'timeout'
            break
        rl = list(outs) + ([sock.fileno()] if sock_open else [])
        r, _, _ = select.select(rl, [], [], 1.0)
        for fd in r:
            if fd == sock.fileno():
                data = sock.recv(65536)
                if not data:
                    sock_open = False
                    if stdin_open or proc.poll() is None:
                        killed = 'client went away'
                    break
                pending += data
                while stdin_open and len(pending) >= 4:
                    n = struct.unpack('>I', pending[:4])[0]
                    if len(pending) < 4 + n:
                        break
                    chunk, pending = pending[4:4 + n], pending[4 + n:]
                    if n == 0:
                        stdin_open = False
                        try:
                            proc.stdin.close()
                        except OSError:
                            pass
                    else:
                        try:
                            proc.stdin.write(chunk); proc.stdin.flush()
                        except OSError:
                            stdin_open = False
                continue
            data = os.read(fd, 65536)
            if not data:
                del outs[fd]
                continue
            try:
                send(sock, outs[fd], data)
            except OSError:
                killed = 'client went away'
                break
        if killed:
            break
    if killed:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
    code = proc.wait()
    return (code if code >= 0 else 128 - code), killed


def main():
    sock = socket.socket(fileno=0)
    started = time.time()
    peer = peer_info(sock)
    rec = {'ts': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'pid': peer['pid'], 'uid': peer['uid'],
           'station': peer['station'], 'cwd': peer['cwd']}
    try:
        if peer['uid'] != OWNER_UID:
            raise Refuse('only uid %d may use the gate' % OWNER_UID)
        line = b''
        while not line.endswith(b'\n'):
            c = sock.recv(1)
            if not c:
                raise EOFError
            line += c
            if len(line) > 1 << 20:
                raise Refuse('request too large')
        req = json.loads(line)
        argv, user = req.get('argv'), req.get('user') or 'root'
        rec['user'] = user
        rec['cmd'] = redact(' '.join(map(str, argv or [])))[:2000]
        guarded = guard_privileged_shell()
        rec['guardrail'] = 'on' if guarded else 'off'
        cmd = plan(argv, user, guarded)
        if user == 'root' and guarded:
            guard_targets(cmd)
    except Refuse as e:
        rec['decision'] = 'refused'; rec['why'] = str(e); log(rec)
        try:
            send(sock, 2, ('sudo-gate: refused: %s\n' % e).encode()); send(sock, 3, b'1')
        except OSError:
            pass
        return
    except (EOFError, ValueError, OSError) as e:
        rec['decision'] = 'refused'; rec['why'] = 'bad request: %s' % e.__class__.__name__; log(rec)
        return
    rec['decision'] = 'allowed' if rec.get('guardrail') == 'on' else 'allowed-unguarded'
    log(dict(rec))
    try:
        code, killed = run(sock, cmd, user, bool(req.get('stdin')))
    except OSError as e:
        code, killed = 127, 'exec failed: %s' % e
    done = {'ts': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'pid': peer['pid'], 'decision': 'finished', 'exit': code,
            'secs': round(time.time() - started, 2)}
    if killed:
        done['killed'] = killed
    log(done)
    try:
        send(sock, 3, str(code).encode())
    except OSError:
        pass


if __name__ == '__main__':
    main()
