// Polecenia systemowe hostów: ssh, sudo, systemctl, journalctl, crictl, apt, kubeadm, etcdctl, openssl, sysctl...
import { registerHostCommands } from './index.js';
import { parseOpts } from './core.js';
import { kubectl } from '../../kubectl/index.js';
import { makeHostShell } from '../hostshell.js';
import { startUnit, stopUnit, daemonReload, unitChangedOnDisk, unitStatusText, journalPrefix } from '../../sim/systemd.js';
import { restartContainerById } from '../../sim/kubelet.js';
import { makeKey, makeCsr, makeCert, certInfo, parsePem, keyId, opensslDate, dn, fingerprint, KUBEADM_CERTS, KUBEADM_KUBECONFIGS } from '../../sim/pki.js';
import { b64enc, b64dec, hex, hexHash, shQuote, clone, humanDuration } from '../../lib/util.js';
import { parseOne, dump } from '../../lib/yaml.js';
import { helm } from './helm.js';
import { ExitSignal } from '../interp.js';
import { kubeletConfigYaml, kubeconfig as mkKubeconfig } from '../../sim/bootstrap.js';

const need = (sh) => sh.ctx || {};
const isRoot = (sh) => sh.user === 'root';
function* sleep(ms) { yield { type: 'sleep', ms }; }

// ------------------------------------------------------------------ ssh / sudo / su
function resolveHost(sh, name) {
  const { cluster: c } = need(sh);
  const hosts = Object.values(c.hosts);
  let h = hosts.find((x) => x.name === name);
  if (!h) {
    const line = (sh.fs.tryRead('/etc/hosts') || '').split('\n').find((l) => l.split(/\s+/).slice(1).includes(name));
    const ip = line ? line.split(/\s+/)[0] : /^\d+\.\d+\.\d+\.\d+$/.test(name) ? name : null;
    if (ip) h = hosts.find((x) => x.ip === ip);
    if (!h && !ip) return { error: `ssh: Could not resolve hostname ${name}: Name or service not known` };
    if (!h) return { error: `ssh: connect to host ${name} port 22: No route to host` };
  }
  if (h.down) return { error: `ssh: connect to host ${name} port 22: Connection refused` };
  return { h };
}

function* ssh(args, io, sh) {
  const { opts, rest } = parseOpts(args, { short: 'tTqvAN', withArg: 'oipl' });
  if (!rest.length) { io.eline('usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface] [-b bind_address]\n           [-c cipher_spec] [-D [bind_address:]port] [-E log_file]\n           [-e escape_char] [-F configfile] [-I pkcs11] [-i identity_file]\n           destination [command [argument ...]]'); return 255; }
  let target = rest[0];
  let user = opts.l || sh.user;
  if (target.includes('@')) [user, target] = target.split('@');
  const r = resolveHost(sh, target);
  if (r.error) { io.eline(r.error); return 255; }
  const h = r.h;
  if (h === sh.ctx.host && rest.length === 1 && user === sh.user) { /* ssh do siebie - ok */ }
  if (user === 'root' && sh.user !== 'root') { io.eline(`${user}@${target}: Permission denied (publickey).`); return 255; }
  if (!['candidate', 'root'].includes(user)) { io.eline(`${user}@${target}: Permission denied (publickey).`); return 255; }
  const remote = makeHostShell(sh.ctx.world || sh.ctx.cluster, h, user, { manifests: sh.ctx.manifests });
  if (rest.length > 1) {
    const cmd = rest.slice(1).join(' ');
    try { return yield* remote.run(cmd, io); } catch (e) { if (e instanceof ExitSignal) return e.code; throw e; }
  }
  const c = sh.ctx.cluster;
  const d = new Date(c.now() - 3600e3 * 2);
  const last = `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()}`;
  io.line(`Welcome to Ubuntu 24.04.5 LTS (GNU/Linux 6.8.0-147-generic x86_64)\n\n * Documentation:  https://help.ubuntu.com\n * Management:     https://landscape.canonical.com\n * Support:        https://ubuntu.com/pro\n\nLast login: ${last} from ${sh.ctx.host.ip}`);
  yield { type: 'subshell', shell: remote, kind: 'ssh', exitMsg: `logout\nConnection to ${target} closed.` };
  return 0;
}

function* sudo(args, io, sh) {
  let i = 0, user = 'root', login = false, shell = false, preserve = false;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-i') login = true;
    else if (a === '-s') shell = true;
    else if (a === '-E') preserve = true;
    else if (a === '-u') user = args[++i];
    else if (a === '-n' || a === '-H' || a === '-k') continue;
    else if (a === '--') { i++; break; } else break;
  }
  const cmd = args.slice(i);
  const host = sh.ctx.host;
  const mk = (u, lg) => {
    const s2 = makeHostShell(sh.ctx.world || sh.ctx.cluster, host, u, { cwd: lg ? undefined : sh.cwd, login: lg, manifests: sh.ctx.manifests });
    if (preserve) for (const [k, v] of Object.entries(sh.env())) if (!['HOME', 'USER', 'LOGNAME'].includes(k)) { s2.vars.set(k, v); s2.exported.add(k); }
    return s2;
  };
  if (!cmd.length) {
    if (login || shell) { yield { type: 'subshell', shell: mk(user, login), kind: 'sudo' }; return 0; }
    io.eline('usage: sudo -h | -K | -k | -V\nusage: sudo -v [-ABkNnS] [-g group] [-h host] [-p prompt] [-u user]\nusage: sudo [-ABbEHkNnPS] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] [VAR=value] [-i | -s] [<command>]');
    return 1;
  }
  if (['su', 'bash', 'sh'].includes(cmd[0]) && (cmd.length === 1 || cmd[1] === '-' || cmd[1] === '-l' || cmd[1] === '-i' || (cmd[0] === 'su' && cmd[1] === 'root'))) {
    yield { type: 'subshell', shell: mk(user, cmd[0] === 'su' ? cmd.includes('-') || cmd.includes('-l') : false), kind: 'sudo' };
    return 0;
  }
  const s2 = mk(user, login);
  try { return yield* s2.run(cmd.map(shQuote).join(' '), io); } catch (e) { if (e instanceof ExitSignal) return e.code; throw e; }
}

function* su(args, io, sh) {
  const rest = args.filter((a) => !a.startsWith('-'));
  const target = rest[0] || 'root';
  const login = args.includes('-') || args.includes('-l') || args.includes('--login');
  if (sh.user !== 'root') {
    yield { type: 'input', prompt: 'Password: ', secret: true };
    yield { type: 'sleep', ms: 1500 };
    io.eline('su: Authentication failure');
    return 1;
  }
  if (!['root', 'candidate'].includes(target)) { io.eline(`su: user ${target} does not exist or the user entry does not contain all the required fields`); return 1; }
  const s2 = makeHostShell(sh.ctx.world || sh.ctx.cluster, sh.ctx.host, target, { cwd: login ? undefined : sh.cwd, login, manifests: sh.ctx.manifests });
  yield { type: 'subshell', shell: s2, kind: 'sudo' };
  return 0;
}

// ------------------------------------------------------------------ systemctl
const STATIC_UNITS = ['ssh', 'systemd-resolved', 'cron', 'systemd-journald', 'systemd-networkd', 'rsyslog', 'apparmor', 'multipathd'];
function unitName(n) { return String(n || '').replace(/\.service$/, ''); }

function* systemctl(args, io, sh) {
  const h = sh.ctx.host;
  const c = sh.ctx.cluster;
  const flags = [], rest = [];
  let prop = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-p' || a === '--property') { prop = args[++i]; continue; }
    if (a.startsWith('--property=')) { prop = a.slice(11); continue; }
    if (a.startsWith('-')) flags.push(a); else rest.push(a);
  }
  const sub = rest[0] || 'list-units';
  const units = rest.slice(1).map(unitName);
  const known = (u) => u === 'kubelet' || u === 'containerd' || STATIC_UNITS.includes(u) || !!h.parseUnit(u).base;
  const mutating = ['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'daemon-reload', 'mask', 'unmask', 'reset-failed', 'try-restart', 'reload-or-restart', 'kill', 'edit'];
  if (mutating.includes(sub) && !isRoot(sh)) {
    if (sub === 'daemon-reload') { io.eline('Failed to reload daemon: Access denied'); return 1; }
    io.eline(`Failed to ${sub} ${units[0] || ''}.service: Access denied\nSee system logs and 'systemctl status ${units[0] || ''}.service' for details.`);
    return 1;
  }
  const enableNow = flags.includes('--now');
  switch (sub) {
    case 'daemon-reload': daemonReload(h); return 0;
    case 'status': {
      let st = 0;
      for (const u of units.length ? units : ['kubelet']) {
        if (STATIC_UNITS.includes(u)) { io.line(`● ${u}.service\n     Loaded: loaded (/usr/lib/systemd/system/${u}.service; enabled; preset: enabled)\n     Active: active (running) since ${new Date(h.bootTime || c.now()).toUTCString().replace(' GMT', ' UTC')}\n`); continue; }
        if (!h.parseUnit(u).base) { io.eline(`Unit ${u}.service could not be found.`); st = 4; continue; }
        io.out(unitStatusText(c, h, u));
        const s = h.unit(u).state;
        if (s !== 'active') st = 3;
      }
      return st;
    }
    case 'start': case 'restart': case 'try-restart': case 'reload-or-restart': case 'reload': {
      for (const u of units) {
        if (!known(u)) { io.eline(`Failed to ${sub} ${u}.service: Unit ${u}.service not found.`); return 5; }
        if (STATIC_UNITS.includes(u)) continue;
        if (unitChangedOnDisk(h, u)) io.eline(`Warning: The unit file, source configuration file or drop-ins of ${u}.service changed on disk. Run 'systemctl daemon-reload' to reload units.`);
        if (h.unit(u).masked) { io.eline(`Failed to ${sub} ${u}.service: Unit ${u}.service is masked.`); return 1; }
        if (sub !== 'start' || h.unit(u).state !== 'active') { if (sub !== 'start') stopUnit(c, h, u); startUnit(c, h, u); }
        if (u === 'containerd' && h.unit('kubelet').state === 'active') { /* kubelet sprawdzi gniazdo przy następnym ticku */ }
      }
      c.reconcile();
      yield* sleep(600);
      return 0;
    }
    case 'stop': case 'kill': {
      for (const u of units) {
        if (!known(u)) { io.eline(`Failed to stop ${u}.service: Unit ${u}.service not loaded.`); return 5; }
        if (STATIC_UNITS.includes(u)) continue;
        stopUnit(c, h, u);
      }
      c.reconcile();
      return 0;
    }
    case 'enable': case 'disable': {
      for (const u of units) {
        if (!known(u)) { io.eline(`Failed to ${sub} unit: Unit file ${u}.service does not exist.`); return 1; }
        const un = h.unit(u);
        const want = sub === 'enable';
        if (un.enabled !== want) {
          const base = h.parseUnit(u).base || `/usr/lib/systemd/system/${u}.service`;
          if (want) io.eline(`Created symlink /etc/systemd/system/multi-user.target.wants/${u}.service → ${base}.`);
          else io.eline(`Removed "/etc/systemd/system/multi-user.target.wants/${u}.service".`);
          un.enabled = want;
        }
        if (enableNow) { if (want) startUnit(c, h, u); else stopUnit(c, h, u); }
      }
      c.reconcile();
      return 0;
    }
    case 'mask': case 'unmask': for (const u of units) { h.unit(u).masked = sub === 'mask'; io.eline(sub === 'mask' ? `Created symlink /etc/systemd/system/${u}.service → /dev/null.` : `Removed "/etc/systemd/system/${u}.service".`); } return 0;
    case 'is-active': { let st = 0; for (const u of units) { const s = STATIC_UNITS.includes(u) ? 'active' : h.parseUnit(u).base ? (h.unit(u).state === 'auto-restart' ? 'activating' : h.unit(u).state) : 'inactive'; io.line(s); if (s !== 'active') st = 3; } return st; }
    case 'is-enabled': { let st = 0; for (const u of units) { const e = STATIC_UNITS.includes(u) || h.unit(u).enabled; io.line(h.unit(u).masked ? 'masked' : e ? 'enabled' : 'disabled'); if (!e) st = 1; } return st; }
    case 'is-failed': { for (const u of units) io.line(h.unit(u).state === 'auto-restart' ? 'activating' : h.unit(u).state); return 1; }
    case 'cat': {
      for (const u of units) {
        const p = h.parseUnit(u);
        if (!p.base) { io.eline(`No files found for ${u}.service.`); return 1; }
        io.line(`# ${p.base}`); io.out(h.fs.read(p.base));
        for (const d of p.dropins) { io.line(`\n# ${d}`); io.out(h.fs.read(d)); }
      }
      return 0;
    }
    case 'show': {
      for (const u of units) {
        const un = h.unit(u);
        const p = h.parseUnit(u);
        const argv = h.expandExec(un.loaded && un.loadedHash === h.unitHash(u) ? un.loaded : (un.loaded || p)) || [''];
        const props = { Id: `${u}.service`, ActiveState: un.state === 'auto-restart' ? 'activating' : un.state, SubState: un.state === 'active' ? 'running' : un.state === 'auto-restart' ? 'auto-restart' : 'dead', UnitFileState: un.enabled ? 'enabled' : 'disabled', ExecStart: `{ path=${argv[0]} ; argv[]=${argv.join(' ')} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`, FragmentPath: p.base || '', DropInPaths: p.dropins.join(' '), MainPID: un.state === 'active' ? un.pid : 0, NRestarts: un.restarts || 0, Restart: 'always' };
        const keys = prop ? prop.split(',') : Object.keys(props);
        for (const k of keys) io.line(flags.includes('--value') ? `${props[k] ?? ''}` : `${k}=${props[k] ?? ''}`);
      }
      return 0;
    }
    case 'list-units': case 'list-unit-files': {
      io.line('  UNIT                     LOAD   ACTIVE SUB     DESCRIPTION');
      for (const u of ['containerd', 'kubelet']) { const s = h.unit(u).state; io.line(`  ${(u + '.service').padEnd(24)} loaded ${s === 'active' ? 'active  running' : s === 'auto-restart' ? 'activating auto-restart' : 'inactive dead   '} ${u === 'kubelet' ? 'kubelet: The Kubernetes Node Agent' : 'containerd container runtime'}`); }
      for (const u of STATIC_UNITS.slice(0, 4)) io.line(`  ${(u + '.service').padEnd(24)} loaded active running ${u}`);
      return 0;
    }
    case 'reset-failed': return 0;
    case 'reboot': return yield* reboot([], io, sh);
    default: io.eline(`Unknown command verb '${sub}'.`); return 1;
  }
}

function* journalctl(args, io, sh) {
  const h = sh.ctx.host;
  let unit = null, n = null, follow = false, since = null, noPager = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-u' || a === '--unit') unit = unitName(args[++i]);
    else if (a.startsWith('--unit=')) unit = unitName(a.slice(7));
    else if (a === '-n' || a === '--lines') n = Number(args[++i]);
    else if (a.startsWith('--lines=')) n = Number(a.slice(8));
    else if (a === '-f' || a === '--follow') follow = true;
    else if (a === '--since') since = args[++i];
    else if (a === '--no-pager') noPager = true;
    else if (/^-[a-zA-Z]+$/.test(a)) {
      for (const ch of a.slice(1)) { if (ch === 'f') follow = true; if (ch === 'e' && n === null) n = 1000; if (ch === 'u') unit = unitName(args[++i]); if (ch === 'n') n = Number(args[++i]); }
    }
  }
  void noPager;
  if (!isRoot(sh) && !['candidate'].includes(sh.user)) { io.eline('No journal files were found.'); return 1; }
  if (!unit) { io.line(`-- No entries --`); return 0; }
  let entries = (h.journal[unit] || []).slice();
  if (since) {
    const c = sh.ctx.cluster;
    const m = String(since).match(/^(\d+)\s*(s|sec|min|m|h|hour|hours) ago$/);
    if (m) { const ms = Number(m[1]) * ({ s: 1, sec: 1, m: 60, min: 60, h: 3600, hour: 3600, hours: 3600 }[m[2]]) * 1000; entries = entries.filter(([t]) => t >= c.now() - ms); }
  }
  if (n !== null) entries = entries.slice(-n);
  if (!entries.length) { io.line('-- No entries --'); if (!follow) return 0; }
  for (const [t, m] of entries) io.line(journalPrefix(t, h.name, unit) + m);
  if (follow) {
    let seen = (h.journal[unit] || []).length;
    while (true) {
      yield* sleep(1000);
      const j = h.journal[unit] || [];
      if (j.length > seen) { for (const [t, m] of j.slice(seen)) io.line(journalPrefix(t, h.name, unit) + m); seen = j.length; } else if (j.length < seen) seen = j.length;
    }
  }
  return 0;
}

// ------------------------------------------------------------------ crictl
function goAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 1) return 'Less than a second ago';
  if (s < 60) return `${s} seconds ago`;
  if (s < 120) return 'About a minute ago';
  if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
  if (s < 7200) return 'About an hour ago';
  if (s < 86400 * 2) return `${Math.floor(s / 3600)} hours ago`;
  return `${Math.floor(s / 86400)} days ago`;
}
function crictlTable(rows) {
  const w = [];
  for (const r of rows) r.forEach((c, i) => { w[i] = Math.max(w[i] || 0, Math.max(20, String(c).length + 3)); });
  return rows.map((r) => r.map((c, i) => (i < r.length - 1 ? String(c).padEnd(w[i]) : c)).join('')).join('\n') + '\n';
}
function* crictl(args, io, sh) {
  const h = sh.ctx.host, c = sh.ctx.cluster;
  let endpoint = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-r' || args[i] === '--runtime-endpoint') endpoint = args[++i];
    else if (args[i].startsWith('--runtime-endpoint=')) endpoint = args[i].split('=')[1];
    else rest.push(args[i]);
  }
  const sub = rest[0];
  if (!sub || sub === '--help' || sub === '-h') { io.line('NAME:\n   crictl - client for CRI\n\nCOMMANDS:\n   attach, create, exec, version, images, inspect, inspecti, imagefsinfo, inspectp, logs, port-forward, ps, pull, run, runp, rm, rmi, rmp, pods, start, info, stop, stopp, update, config, stats, statsp, checkpoint, events, update-runtime-config'); return 0; }
  if (sub === '--version' || sub === '-v') { io.line('crictl version v1.37.0'); return 0; }
  if (!endpoint) {
    const cfg = parseOne(h.fs.tryRead('/etc/crictl.yaml') || '') || {};
    endpoint = cfg['runtime-endpoint'] || null;
  }
  const sock = String(endpoint || 'unix:///run/containerd/containerd.sock').replace(/^unix:\/\//, '').replace(/^\/var\/run\//, '/run/');
  const cd = h.unit('containerd');
  const err = (why) => { io.eline(`E0101 08:00:00.000000    4321 log.go:32] "validate service connection: validate CRI v1 runtime API for endpoint \\"unix://${sock}\\": rpc error: code = Unavailable desc = connection error: desc = \\"transport: Error while dialing: dial unix ${sock}: connect: ${why}\\""\nFATA[0000] validate service connection: validate CRI v1 runtime API for endpoint "unix://${sock}": rpc error: code = Unavailable desc = connection error: desc = "transport: Error while dialing: dial unix ${sock}: connect: ${why}"`); return 1; };
  if (!endpoint) io.eline('WARN[0000] Config "/etc/crictl.yaml" does not exist, trying next: "/usr/bin/crictl.yaml"\nWARN[0000] runtime connect using default endpoints: [unix:///run/containerd/containerd.sock unix:///run/crio/crio.sock unix:///var/run/cri-dockerd.sock]. As the default settings are now deprecated, you should set the endpoint instead.');
  if (cd.state !== 'active' || (cd.address && cd.address !== sock)) return err('no such file or directory');
  if (!isRoot(sh)) return err('permission denied');
  const rts = Object.values(c.runtime).filter((r) => r.node === h.name);
  const now = c.now();
  const all = rest.includes('-a') || rest.includes('--all');
  const quiet = rest.includes('-q') || rest.includes('--quiet');
  const nameIdx = rest.indexOf('--name');
  const nameF = nameIdx >= 0 ? rest[nameIdx + 1] : null;
  const ctrs = () => rts.flatMap((rt) => [...rt.init, ...rt.main].filter((x) => x.id).map((crt) => ({ rt, crt })));
  const find = (id) => ctrs().find(({ crt }) => crt.id.startsWith(id));
  switch (sub) {
    case 'ps': {
      let list = ctrs().filter(({ crt }) => all || crt.state === 'running');
      if (nameF) list = list.filter(({ crt }) => new RegExp(nameF).test(crt.name));
      const podIdx = rest.indexOf('--pod');
      if (podIdx >= 0) list = list.filter(({ rt }) => rt.sandbox?.startsWith(rest[podIdx + 1]));
      if (quiet) { for (const { crt } of list) io.line(crt.id); return 0; }
      const oi = rest.findIndex((a) => a === '-o' || a === '--output' || a.startsWith('-o=') || a.startsWith('--output='));
      const ofmt = oi >= 0 ? (rest[oi].includes('=') ? rest[oi].split('=')[1] : rest[oi + 1]) : null;
      if (ofmt === 'json' || ofmt === 'yaml') {
        const obj = { containers: list.map(({ rt, crt }) => ({ id: crt.id, podSandboxId: rt.sandbox, metadata: { name: crt.name, attempt: crt.restarts || 0 }, image: { image: crt.image, annotations: {}, userSpecifiedImage: '', runtimeHandler: '' }, imageRef: crt.imageID, state: crt.state === 'running' ? 'CONTAINER_RUNNING' : 'CONTAINER_EXITED', createdAt: String((crt.startedAtMs || now) * 1e6), labels: { 'io.kubernetes.container.name': crt.name, 'io.kubernetes.pod.name': rt.name, 'io.kubernetes.pod.namespace': rt.ns, 'io.kubernetes.pod.uid': rt.uid }, annotations: { 'io.kubernetes.container.restartCount': String(crt.restarts || 0) } })) };
        io.out(ofmt === 'json' ? `${JSON.stringify(obj, null, 2)}\n` : dump(obj));
        return 0;
      }
      const rows = [['CONTAINER', 'IMAGE', 'CREATED', 'STATE', 'NAME', 'ATTEMPT', 'POD ID', 'POD', 'NAMESPACE']];
      for (const { rt, crt } of list) rows.push([crt.id.slice(0, 13), hexHash(crt.image, 13), goAgo(now - (crt.startedAtMs || now)), crt.state === 'running' ? 'Running' : 'Exited', crt.name, String(crt.restarts || 0), (rt.sandbox || '').slice(0, 13), rt.name, rt.ns]);
      io.out(crictlTable(rows));
      return 0;
    }
    case 'pods': {
      let list = rts.filter((r) => r.sandbox);
      if (nameF) list = list.filter((r) => new RegExp(nameF).test(r.name));
      if (quiet) { for (const r of list) io.line(r.sandbox); return 0; }
      const rows = [['POD ID', 'CREATED', 'STATE', 'NAME', 'NAMESPACE', 'ATTEMPT', 'RUNTIME']];
      for (const r of list) rows.push([r.sandbox.slice(0, 13), goAgo(now - (r.created || now)), r.state === 'terminating' ? 'NotReady' : 'Ready', r.name, r.ns, '0', '(default)']);
      io.out(crictlTable(rows));
      return 0;
    }
    case 'images': case 'image': case 'img': {
      const imgs = new Set([...(h.images || []), ...rts.flatMap((r) => [...r.init, ...r.main].filter((x) => x.pulled).map((x) => x.imageInfo?.n?.full || x.image))]);
      const rows = [['IMAGE', 'TAG', 'IMAGE ID', 'SIZE']];
      for (const im of [...imgs].sort()) { const i = im.lastIndexOf(':'); rows.push([im.slice(0, i), im.slice(i + 1), hexHash(im, 13), `${(hexHash(im, 2).charCodeAt(0) % 90) + 5}.${hexHash(im, 1).charCodeAt(0) % 10}MB`]); }
      io.out(crictlTable(rows));
      return 0;
    }
    case 'logs': {
      const id = rest.slice(1).filter((a, i, arr) => !a.startsWith('-') && !['--tail', '--since', '-n'].includes(arr[i - 1]))[0];
      const tIdx = rest.findIndex((a) => a === '--tail' || a.startsWith('--tail='));
      const tail = tIdx >= 0 ? Number(rest[tIdx].includes('=') ? rest[tIdx].split('=')[1] : rest[tIdx + 1]) : null;
      if (!id) { io.eline('FATA[0000] ID cannot be empty'); return 1; }
      const f = find(id);
      if (!f) { io.eline(`E0101 08:00:00.000000 ContainerStatus from runtime service failed" err="rpc error: code = NotFound desc = an error occurred when try to find container \\"${id}\\": not found"\nFATA[0000] rpc error: code = NotFound desc = an error occurred when try to find container "${id}": not found`); return 1; }
      let logs = f.crt.logs || [];
      if (tail !== null) logs = logs.slice(-tail);
      for (const [, l] of logs) io.line(l);
      return 0;
    }
    case 'inspect': {
      if (!rest[1]) { io.eline('FATA[0000] ID cannot be empty'); return 1; }
      const f = find(rest[1]);
      if (!f) { io.eline(`FATA[0000] no such container "${rest[1]}"`); return 1; }
      const spec = [...(f.rt.spec.containers || []), ...(f.rt.spec.initContainers || [])].find((x) => x.name === f.crt.name) || {};
      io.line(JSON.stringify({ status: { id: f.crt.id, metadata: { attempt: f.crt.restarts, name: f.crt.name }, state: f.crt.state === 'running' ? 'CONTAINER_RUNNING' : 'CONTAINER_EXITED', createdAt: f.crt.startedAt, startedAt: f.crt.startedAt, exitCode: f.crt.exitCode || 0, image: { image: f.crt.image }, imageRef: f.crt.imageID, reason: f.crt.reason || '', labels: { 'io.kubernetes.container.name': f.crt.name, 'io.kubernetes.pod.name': f.rt.name, 'io.kubernetes.pod.namespace': f.rt.ns }, mounts: (spec.volumeMounts || []).map((m) => ({ containerPath: m.mountPath, readonly: !!m.readOnly })), logPath: `/var/log/pods/${f.rt.ns}_${f.rt.name}_${f.rt.uid}/${f.crt.name}/${f.crt.restarts}.log` }, info: { pid: 4000 + (f.crt.restarts || 0), config: { args: spec.args || [], command: spec.command || [], envs: Object.entries(f.crt.env || {}).map(([key, value]) => ({ key, value })) } } }, null, 2));
      return 0;
    }
    case 'inspectp': {
      if (!rest[1]) { io.eline('FATA[0000] ID cannot be empty'); return 1; }
      const r = rts.find((x) => x.sandbox?.startsWith(rest[1]));
      if (!r) { io.eline(`FATA[0000] getting the pod sandbox status for "${rest[1]}": rpc error: code = NotFound desc = an error occurred when try to find sandbox: not found`); return 1; }
      io.line(JSON.stringify({ status: { id: r.sandbox, metadata: { name: r.name, namespace: r.ns, uid: r.uid }, state: 'SANDBOX_READY', network: { ip: r.ip } } }, null, 2));
      return 0;
    }
    case 'stop': case 'rm': {
      for (const id of rest.slice(1).filter((a) => !a.startsWith('-'))) {
        const crt = restartContainerById(c, id);
        if (!crt && sub === 'stop') { io.eline(`FATA[0000] stopping the container "${id}": rpc error: code = NotFound desc = an error occurred when try to find container "${id}": not found`); return 1; }
        io.line(id);
      }
      c.reconcile();
      return 0;
    }
    case 'stopp': case 'rmp': { for (const id of rest.slice(1)) { io.line(`Stopped sandbox ${id}`); } return 0; }
    case 'info': io.line(JSON.stringify({ status: { conditions: [{ type: 'RuntimeReady', status: true }, { type: 'NetworkReady', status: !!c.meta.cniInstalled }] }, config: { containerd: { snapshotter: 'overlayfs', runtimes: { runc: { options: { SystemdCgroup: true } } } }, cni: { binDir: '/opt/cni/bin', confDir: '/etc/cni/net.d' } } }, null, 2)); return 0;
    case 'version': io.line(`Version:  0.1.0\nRuntimeName:  containerd\nRuntimeVersion:  v${h.packages.containerd || '2.4.2'}\nRuntimeApiVersion:  v1`); return 0;
    case 'pull': io.line(`Image is up to date for sha256:${hexHash(rest[1] || '', 64)}`); h.images = [...new Set([...(h.images || []), rest[1]])]; return 0;
    case 'rmi': io.line(`Deleted: ${rest[1]}`); h.images = (h.images || []).filter((x) => !x.includes(rest[1])); return 0;
    case 'exec': io.eline('crictl exec: użyj kubectl exec w symulatorze'); return 1;
    case 'stats': {
      const rows = [['CONTAINER', 'NAME', 'CPU %', 'MEM', 'DISK', 'INODES']];
      for (const { crt } of ctrs().filter(({ crt }) => crt.state === 'running')) rows.push([crt.id.slice(0, 13), crt.name, '0.10', '12.3MB', '28.67kB', '13']);
      io.out(crictlTable(rows));
      return 0;
    }
    default: io.eline(`No help topic for '${sub}'`); return 3;
  }
}

// ------------------------------------------------------------------ apt / dpkg
const PKG_DESC = { kubeadm: 'Command-line utility for administering a Kubernetes cluster', kubelet: 'Node agent for Kubernetes clusters', kubectl: 'Command-line utility for interacting with a Kubernetes cluster', 'cri-tools': 'Command-line utility for interacting with a container runtime', containerd: 'An open and reliable container runtime', helm: 'The Kubernetes package manager' };
const EXTRA_PKGS = { 'nfs-common': '1:2.6.4-3ubuntu5.1', jq: '1.7.1-3build1', conntrack: '1:1.4.8-1ubuntu1', socat: '1.8.0.0-4build3', ebtables: '2.0.11-6build1', ethtool: '1:6.7-1build1', 'etcd-client': '3.4.30-1ubuntu0.24.04.3', 'apt-transport-https': '2.8.3', 'ca-certificates': '20240203', curl: '8.5.0-2ubuntu10.6', gpg: '2.4.4-2ubuntu17.3', 'bash-completion': '1:2.11-8', vim: '2:9.1.0016-1ubuntu7.9', tree: '2.1.1-2ubuntu3', 'net-tools': '2.10-0.1ubuntu4', 'iputils-ping': '3:20240117-1build1', dnsutils: '1:9.18.30-0ubuntu0.24.04.2' };
function repoMinor(h) {
  const t = h.fs.tryRead('/etc/apt/sources.list.d/kubernetes.list') || '';
  const m = t.match(/v1\.(\d+)\/deb/);
  return m ? `1.${m[1]}` : null;
}
function repoVersions(minor) {
  if (!minor) return [];
  const n = Number(minor.split('.')[1]);
  const patches = n < 37 ? [0, 1, 2, 3, 4, 5, 6] : n === 37 ? [0, 1, 2, 3] : n === 38 ? [0, 1] : [];
  return patches.map((p) => `${minor}.${p}-1.1`).reverse();
}
const K8S_PKGS = ['kubeadm', 'kubelet', 'kubectl'];
function lockErr(io) { io.eline('E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?'); return 100; }

function* apt(args, io, sh, name) {
  const h = sh.ctx.host;
  const rest = args.filter((a) => !a.startsWith('-'));
  const flags = args.filter((a) => a.startsWith('-'));
  const sub = rest[0];
  const yes = flags.some((f) => /^-[a-z]*y/.test(f) || f === '--yes' || f === '--assume-yes');
  const allowHeld = flags.includes('--allow-change-held-packages') || flags.includes('--allow-downgrades');
  const quiet = flags.some((f) => /^-q+$/.test(f));
  if (name === 'apt') io.eline('\nWARNING: apt does not have a stable CLI interface. Use with caution in scripts.\n');
  const cacheMinor = h.apt.minor;
  const available = (pkg) => (K8S_PKGS.includes(pkg) ? repoVersions(cacheMinor) : pkg === 'cri-tools' ? [`${cacheMinor}.0-1.1`] : EXTRA_PKGS[pkg] ? [EXTRA_PKGS[pkg]] : []);
  switch (sub) {
    case 'update': {
      if (!isRoot(sh)) { io.eline('Reading package lists... Done\nE: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)\nE: Unable to lock directory /var/lib/apt/lists/'); return 100; }
      const minor = repoMinor(h);
      io.line('Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease\nHit:2 http://archive.ubuntu.com/ubuntu noble-updates InRelease\nHit:3 http://security.ubuntu.com/ubuntu noble-security InRelease');
      yield* sleep(1200);
      if (minor) {
        if (Number(minor.split('.')[1]) > 38) { io.line(`Err:4 https://prod-cdn.packages.k8s.io/repositories/isv:/kubernetes:/core:/stable:/v${minor}/deb  InRelease\n  404  Not Found`); io.eline(`E: The repository 'https://pkgs.k8s.io/core:/stable:/v${minor}/deb  InRelease' is not signed.`); return 100; }
        io.line(`${minor === cacheMinor ? 'Hit' : 'Get'}:4 https://prod-cdn.packages.k8s.io/repositories/isv:/kubernetes:/core:/stable:/v${minor}/deb  InRelease [1,186 B]`);
        if (minor !== cacheMinor) io.line(`Get:5 https://prod-cdn.packages.k8s.io/repositories/isv:/kubernetes:/core:/stable:/v${minor}/deb  Packages [6,051 B]`);
      }
      io.line('Reading package lists... Done');
      h.apt.minor = minor;
      h.apt.updated = true;
      return 0;
    }
    case 'install': case 'upgrade': case 'reinstall': {
      if (!isRoot(sh)) return lockErr(io);
      const specs = rest.slice(1);
      if (!quiet) io.line('Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done');
      const plan = [];
      for (const s of specs) {
        const [pkg, ver] = s.split('=');
        const avail = available(pkg);
        if (!avail.length && !h.packages[pkg]) { io.eline(`E: Unable to locate package ${pkg}`); return 100; }
        const target = ver || avail[0] || h.packages[pkg];
        if (ver && !avail.includes(ver)) { io.eline(`E: Version '${ver}' for '${pkg}' was not found`); return 100; }
        plan.push({ pkg, target, from: h.packages[pkg] });
      }
      const held = plan.filter((p) => h.holds.includes(p.pkg) && p.from !== p.target);
      if (held.length && !allowHeld) {
        io.line(`The following held packages will be changed:\n  ${held.map((p) => p.pkg).join(' ')}`);
        io.eline('E: Held packages were changed and -y was used without --allow-change-held-packages.');
        return 100;
      }
      const changes = plan.filter((p) => p.from !== p.target);
      for (const p of plan.filter((q) => q.from === q.target)) io.line(`${p.pkg} is already the newest version (${p.target}).`);
      if (!changes.length) { io.line('0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.'); return 0; }
      const up = changes.filter((p) => p.from), inst = changes.filter((p) => !p.from);
      if (inst.length) io.line(`The following NEW packages will be installed:\n  ${inst.map((p) => p.pkg).join(' ')}`);
      if (up.length) io.line(`The following packages will be ${up.some((p) => p.target < p.from) ? 'DOWNGRADED' : 'upgraded'}:\n  ${up.map((p) => p.pkg).join(' ')}`);
      io.line(`${up.length} upgraded, ${inst.length} newly installed, 0 to remove and 0 not upgraded.\nNeed to get ${(changes.length * 11.4).toFixed(1)} MB of archives.\nAfter this operation, 0 B of additional disk space will be used.`);
      if (!yes) {
        const ans = yield { type: 'input', prompt: 'Do you want to continue? [Y/n] ' };
        if (ans !== null && ans !== undefined && /^n/i.test(String(ans).trim())) { io.line('Abort.'); return 1; }
      }
      yield* sleep(1500);
      changes.forEach((p, i) => io.line(`Get:${i + 1} https://prod-cdn.packages.k8s.io/repositories/isv:/kubernetes:/core:/stable:/v${cacheMinor}/deb  ${p.pkg} ${p.target} [11.4 MB]`));
      for (const p of changes) io.line(`Preparing to unpack .../${p.pkg}_${p.target}_amd64.deb ...\nUnpacking ${p.pkg} (${p.target})${p.from ? ` over (${p.from})` : ''} ...`);
      for (const p of changes) {
        io.line(`Setting up ${p.pkg} (${p.target}) ...`);
        h.packages[p.pkg] = p.target;
        if (K8S_PKGS.includes(p.pkg)) h.fs.put(`/usr/bin/${p.pkg}`, '\x7fELF', { mode: 0o755 });
        if (p.pkg === 'etcd-client') { h.fs.put('/usr/bin/etcdctl', '\x7fELF', { mode: 0o755 }); }
        if (p.pkg === 'jq') h.fs.put('/usr/bin/jq', '\x7fELF', { mode: 0o755 });
      }
      if (changes.some((p) => p.pkg === 'kubelet')) io.line('Processing triggers for man-db (2.12.0-4build2) ...');
      return 0;
    }
    case 'remove': case 'purge': {
      if (!isRoot(sh)) return lockErr(io);
      for (const p of rest.slice(1)) { delete h.packages[p]; io.line(`Removing ${p} ...`); }
      return 0;
    }
    case 'list': {
      io.line('Listing... Done');
      for (const [p, v] of Object.entries(h.packages)) io.line(`${p}/unknown,now ${v} amd64 [installed${h.holds.includes(p) ? ',upgradable to: ' : ''}]`.replace(',upgradable to: ]', ']'));
      return 0;
    }
    case 'show': case 'policy': return yield* aptCache(['policy', ...rest.slice(1)], io, sh);
    case 'search': for (const p of [...K8S_PKGS, ...Object.keys(EXTRA_PKGS)].filter((x) => x.includes(rest[1] || ''))) io.line(`${p}/noble ${available(p)[0] || ''} amd64\n  ${PKG_DESC[p] || p}\n`); return 0;
    default: io.eline(`E: Invalid operation ${sub || ''}`); return 100;
  }
}

function* aptCache(args, io, sh) {
  const h = sh.ctx.host;
  const sub = args[0];
  const pkgs = args.slice(1).filter((a) => !a.startsWith('-'));
  const minor = h.apt.minor;
  const avail = (p) => (K8S_PKGS.includes(p) ? repoVersions(minor) : EXTRA_PKGS[p] ? [EXTRA_PKGS[p]] : []);
  if (sub === 'madison') {
    for (const p of pkgs) {
      const v = avail(p);
      if (!v.length) { io.eline(`N: Unable to locate package ${p}`); continue; }
      for (const x of v) io.line(`   ${p} | ${x} | https://pkgs.k8s.io/core:/stable:/v${minor}/deb  Packages`);
    }
    return 0;
  }
  if (sub === 'policy' || sub === 'show') {
    for (const p of pkgs) {
      io.line(`${p}:\n  Installed: ${h.packages[p] || '(none)'}\n  Candidate: ${avail(p)[0] || '(none)'}\n  Version table:`);
      for (const x of avail(p)) io.line(` ${x === h.packages[p] ? '***' : '   '} ${x} 500\n        500 https://pkgs.k8s.io/core:/stable:/v${minor}/deb  Packages`);
    }
    return 0;
  }
  if (sub === 'search') { for (const p of [...K8S_PKGS, ...Object.keys(EXTRA_PKGS)].filter((x) => x.includes(pkgs[0] || ''))) io.line(`${p} - ${PKG_DESC[p] || p}`); return 0; }
  io.eline(`E: Invalid operation ${sub || ''}`);
  return 100;
}

function* aptMark(args, io, sh) {
  const h = sh.ctx.host;
  const [sub, ...pkgs] = args.filter((a) => !a.startsWith('-'));
  if (sub === 'showhold') { for (const p of h.holds) io.line(p); return 0; }
  if (!isRoot(sh)) { io.eline('E: Could not create temporary file for /var/lib/apt/extended_states - mkstemp (13: Permission denied)\nE: Failed to write temporary StateFile /var/lib/apt/extended_states'); return 100; }
  for (const p of pkgs) {
    if (!h.packages[p]) { io.eline(`E: Unable to locate package ${p}`); return 100; }
    if (sub === 'hold') { if (h.holds.includes(p)) io.line(`${p} was already set on hold.`); else { h.holds.push(p); io.line(`${p} set on hold.`); } } else if (sub === 'unhold') { if (!h.holds.includes(p)) io.line(`${p} was already not on hold.`); else { h.holds = h.holds.filter((x) => x !== p); io.line(`Canceled hold on ${p}.`); } } else { io.eline(`E: Invalid operation ${sub}`); return 100; }
  }
  return 0;
}

function* dpkg(args, io, sh) {
  const h = sh.ctx.host;
  if (args[0] === '-l' || args[0] === '--list') {
    io.line('Desired=Unknown/Install/Remove/Purge/Hold\n| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend\n|/ Err?=(none)/Reinst-required (Status,Err: uppercase=bad)\n||/ Name           Version      Architecture Description\n+++-==============-============-============-=================================');
    const filt = args[1];
    for (const [p, v] of Object.entries(h.packages).sort()) { if (filt && !new RegExp(filt.replace(/\*/g, '.*')).test(p)) continue; io.line(`${h.holds.includes(p) ? 'hi' : 'ii'}  ${p.padEnd(14)} ${v.padEnd(12)} amd64        ${PKG_DESC[p] || p}`); }
    return 0;
  }
  if (args[0] === '-s' || args[0] === '--status') { const p = args[1]; if (!h.packages[p]) { io.eline(`dpkg-query: package '${p}' is not installed and no information is available`); return 1; } io.line(`Package: ${p}\nStatus: ${h.holds.includes(p) ? 'hold' : 'install'} ok installed\nVersion: ${h.packages[p]}\nArchitecture: amd64`); return 0; }
  io.eline('dpkg: error: need an action option');
  return 2;
}

// ------------------------------------------------------------------ sysctl / modprobe / swap / reboot
function readSysctlFiles(h) {
  const out = {};
  const files = [];
  if (h.fs.isDir('/etc/sysctl.d')) for (const f of h.fs.list('/etc/sysctl.d').sort()) if (f.endsWith('.conf')) files.push(`/etc/sysctl.d/${f}`);
  if (h.fs.exists('/etc/sysctl.conf')) files.push('/etc/sysctl.conf');
  for (const f of files) for (const l of (h.fs.tryRead(f) || '').split('\n')) { const m = l.replace(/#.*/, '').match(/^\s*([\w.]+)\s*=\s*(\S+)/); if (m) out[m[1]] = { v: m[2], f }; }
  return out;
}
function* sysctl(args, io, sh) {
  const h = sh.ctx.host;
  const k = h.kernel;
  if (args.includes('--system') || args[0] === '-p') {
    if (!isRoot(sh)) { io.eline('sysctl: permission denied on key "net.ipv4.ip_forward"'); return 1; }
    const vals = readSysctlFiles(h);
    let lastFile = '';
    for (const [key, { v, f }] of Object.entries(vals)) {
      if (args[0] === '-p' && args[1] && sh.abs(args[1]) !== f) continue;
      if (f !== lastFile && args.includes('--system')) { io.line(`* Applying ${f} ...`); lastFile = f; }
      if (key.startsWith('net.bridge') && !k.modules.includes('br_netfilter')) { io.eline(`sysctl: cannot stat /proc/sys/${key.replace(/\./g, '/')}: No such file or directory`); continue; }
      k.sysctl[key] = v;
      io.line(`${key} = ${v}`);
    }
    return 0;
  }
  if (args[0] === '-a') { for (const [key, v] of Object.entries(k.sysctl).sort()) io.line(`${key} = ${v}`); return 0; }
  const w = args.includes('-w');
  const valOnly = args.includes('-n') || args.includes('--values');
  let st = 0;
  for (const a of args.filter((x) => !x.startsWith('-'))) {
    if (a.includes('=')) {
      if (!isRoot(sh)) { io.eline(`sysctl: permission denied on key "${a.split('=')[0]}"`); st = 1; continue; }
      const [key, v] = a.split('=');
      if (key.startsWith('net.bridge') && !k.modules.includes('br_netfilter')) { io.eline(`sysctl: cannot stat /proc/sys/${key.replace(/\./g, '/')}: No such file or directory`); st = 1; continue; }
      k.sysctl[key.trim()] = v.trim();
      io.line(`${key.trim()} = ${v.trim()}`);
    } else {
      if (a.startsWith('net.bridge') && !k.modules.includes('br_netfilter')) { io.eline(`sysctl: cannot stat /proc/sys/${a.replace(/\./g, '/')}: No such file or directory`); st = 255; continue; }
      const v = k.sysctl[a] ?? (a.startsWith('net.') || a.startsWith('vm.') || a.startsWith('kernel.') ? '0' : null);
      if (v === null) { io.eline(`sysctl: cannot stat /proc/sys/${a.replace(/\./g, '/')}: No such file or directory`); st = 255; continue; }
      io.line(valOnly ? v : `${a} = ${v}`);
    }
  }
  void w;
  return st;
}
function* modprobe(args, io, sh) {
  const h = sh.ctx.host;
  const mods = args.filter((a) => !a.startsWith('-'));
  if (!isRoot(sh)) { io.eline(`modprobe: ERROR: could not insert '${mods[0]}': Operation not permitted`); return 1; }
  const known = ['overlay', 'br_netfilter', 'nf_conntrack', 'ip_tables', 'ip_vs', 'ip_vs_rr', 'ip_vs_wrr', 'ip_vs_sh', 'nfs', 'xt_set', 'vxlan', 'ipip'];
  for (const m of mods) {
    if (!known.includes(m)) { io.eline(`modprobe: FATAL: Module ${m} not found in directory /lib/modules/6.8.0-147-generic`); return 1; }
    if (args.includes('-r')) h.kernel.modules = h.kernel.modules.filter((x) => x !== m);
    else if (!h.kernel.modules.includes(m)) h.kernel.modules.push(m);
  }
  return 0;
}
function* lsmod(args, io, sh) {
  const h = sh.ctx.host;
  io.line('Module                  Size  Used by');
  const sizes = { overlay: 212992, br_netfilter: 32768, nf_conntrack: 196608, ip_tables: 32768, bridge: 421888 };
  const list = [...h.kernel.modules];
  if (list.includes('br_netfilter') && !list.includes('bridge')) list.push('bridge');
  for (const m of list) io.line(`${m.padEnd(20)} ${String(sizes[m] || 16384).padStart(8)}  ${m === 'bridge' ? '1 br_netfilter' : '0'}`);
  return 0;
}
function* swapoff(args, io, sh) { if (!isRoot(sh)) { io.eline('swapoff: Not superuser.'); return 1; } sh.ctx.host.kernel.swap = false; return 0; }
function* swapon(args, io, sh) {
  const k = sh.ctx.host.kernel;
  if (args.includes('--show') || args.includes('-s')) { if (k.swap) io.line('NAME      TYPE SIZE USED PRIO\n/swap.img file   2G   0B   -2'); return 0; }
  if (!isRoot(sh)) { io.eline('swapon: Not superuser.'); return 1; }
  k.swap = true;
  return 0;
}

function* reboot(args, io, sh) {
  const h = sh.ctx.host, c = sh.ctx.cluster;
  if (!isRoot(sh)) { io.eline('Call to Reboot failed: Interactive authentication required.'); return 1; }
  if (h.role === 'base') { io.eline('Reboot hosta base nie jest obsługiwany w symulatorze.'); return 1; }
  io.line(`Connection to ${h.name} closed by remote host.`);
  // stan po restarcie: moduły z modules-load.d, sysctl z plików, swap z fstab
  const mods = new Set(['nf_conntrack', 'ip_tables']);
  if (h.fs.isDir('/etc/modules-load.d')) for (const f of h.fs.list('/etc/modules-load.d')) for (const l of (h.fs.tryRead(`/etc/modules-load.d/${f}`) || '').split('\n')) if (l.trim() && !l.startsWith('#')) mods.add(l.trim());
  h.kernel.modules = [...mods];
  h.kernel.sysctl = { 'net.ipv4.ip_forward': '0' };
  for (const [key, { v }] of Object.entries(readSysctlFiles(h))) if (!key.startsWith('net.bridge') || mods.has('br_netfilter')) h.kernel.sysctl[key] = v;
  h.kernel.swap = /^[^#\n]*\bswap\b/m.test(h.fs.tryRead('/etc/fstab') || '');
  for (const u of ['kubelet', 'containerd']) stopUnit(c, h, u);
  for (const rt of Object.values(c.runtime)) if (rt.node === h.name) for (const crt of [...rt.main, ...rt.init]) { if (crt.state === 'running') { crt.state = 'terminated'; crt.exitCode = 255; crt.reason = 'Unknown'; crt.listen = []; crt.restarts++; } }
  h.down = true;
  h.bootTime = c.now() + 20000;
  daemonReload(h);
  c.rebootQueue = c.rebootQueue || [];
  c.rebootQueue.push({ host: h.name, at: c.now() + 20000 });
  throw new ExitSignal(255);
}


// ------------------------------------------------------------------ kubelet / containerd / ctr (binaria)
function* kubeletBin(args, io, sh) {
  const v = (sh.ctx.host.packages.kubelet || '1.37.1').split('-')[0];
  if (args.includes('--version') || args[0] === 'version') { io.line(`Kubernetes v${v}`); return 0; }
  io.eline('E0101 08:00:00.000000    5555 run.go:72] "command failed" err="failed to run Kubelet: unable to load bootstrap kubeconfig: stat /etc/kubernetes/bootstrap-kubelet.conf: no such file or directory (uruchom kubelet przez systemctl)"');
  return 1;
}
function* containerdBin(args, io, sh) {
  const v = sh.ctx.host.packages.containerd || '2.4.2';
  if (args.includes('--version') || args[0] === '-v') { io.line(`containerd github.com/containerd/containerd/v2 v${v} 1a43cb6a1035441f9aca8f5666a9b3ef9e70ab20`); return 0; }
  if (args[0] === 'config' && args[1] === 'default') { io.out(DEFAULT_CONTAINERD); return 0; }
  if (args[0] === 'config' && args[1] === 'dump') { io.out(sh.ctx.host.fs.tryRead('/etc/containerd/config.toml') || ''); return 0; }
  io.eline('containerd: uruchom przez systemctl start containerd');
  return 1;
}
const DEFAULT_CONTAINERD = `version = 3
root = '/var/lib/containerd'
state = '/run/containerd'
temp = ''
disabled_plugins = []
required_plugins = []
oom_score = 0
imports = []

[grpc]
  address = '/run/containerd/containerd.sock'
  tcp_address = ''
  uid = 0
  gid = 0
  max_recv_message_size = 16777216
  max_send_message_size = 16777216

[plugins]
  [plugins.'io.containerd.cri.v1.images']
    snapshotter = 'overlayfs'
    disable_snapshot_annotations = true

    [plugins.'io.containerd.cri.v1.images'.pinned_images]
      sandbox = 'registry.k8s.io/pause:3.10.1'

  [plugins.'io.containerd.cri.v1.runtime']
    enable_selinux = false

    [plugins.'io.containerd.cri.v1.runtime'.containerd]
      default_runtime_name = 'runc'

      [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes]
        [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runc]
          runtime_type = 'io.containerd.runc.v2'

          [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runc.options]
            BinaryName = ''
            SystemdCgroup = false

    [plugins.'io.containerd.cri.v1.runtime'.cni]
      bin_dirs = ['/opt/cni/bin']
      conf_dir = '/etc/cni/net.d'
`;
function* ctr(args, io, sh) {
  if (!isRoot(sh)) { io.eline('ctr: failed to dial "/run/containerd/containerd.sock": connection error: desc = "transport: error while dialing: dial unix:///run/containerd/containerd.sock: timeout": unavailable'); return 1; }
  if (args.includes('version')) { io.line(`Client:\n  Version:  v${sh.ctx.host.packages.containerd || '2.4.2'}\n\nServer:\n  Version:  v${sh.ctx.host.packages.containerd || '2.4.2'}`); return 0; }
  if (args.includes('images') || args.includes('i')) { io.line('REF                                     TYPE                                    DIGEST'); for (const im of sh.ctx.host.images || []) io.line(`${im.padEnd(40)}application/vnd.oci.image.index.v1+json sha256:${hexHash(im, 64)}`); return 0; }
  if (args.includes('containers') || args.includes('c')) { io.line('CONTAINER    IMAGE    RUNTIME'); return 0; }
  io.line('ctr - containerd CLI (symulator: dostępne "ctr -n k8s.io images ls", "ctr version")');
  return 0;
}

// ------------------------------------------------------------------ kubeadm
function k8sVersion(h) { return `v${(h.packages.kubeadm || '1.37.1').split('-')[0]}`; }
function clusterVersion(c) {
  const cp = Object.values(c.hosts).find((x) => x.role === 'control-plane');
  const m = (cp.fs.tryRead('/etc/kubernetes/manifests/kube-apiserver.yaml') || '').match(/kube-apiserver:(v[\d.]+)/);
  return m ? m[1] : c.meta.version;
}
const vcmp = (a, b) => { const pa = a.replace(/^v/, '').split('.').map(Number), pb = b.replace(/^v/, '').split('.').map(Number); for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); return 0; };

function notRoot(io) { io.eline('[preflight] Running pre-flight checks\nerror execution phase preflight: [preflight] Some fatal errors occurred:\n\t[ERROR IsPrivilegedUser]: user is not running as root\n[preflight] If you know what you are doing, you can make a check non-fatal with `--ignore-preflight-errors=...`\nTo see the stack trace of this error execute with --v=5 or higher'); return 1; }

function certPaths(h) {
  const out = [];
  for (const kc of KUBEADM_KUBECONFIGS) out.push({ name: kc.name, path: `/etc/kubernetes/${kc.file}`, kubeconfig: true, ca: 'ca', def: kc });
  for (const ct of KUBEADM_CERTS) out.push({ name: ct.name, path: `/etc/kubernetes/pki/${ct.file}.crt`, ca: ct.ca, def: ct });
  out.sort((a, b) => a.name.localeCompare(b.name));
  void h;
  return out;
}
function readCert(h, p) {
  if (p.kubeconfig) {
    const kc = parseOne(h.fs.tryRead(p.path) || '') || {};
    const data = kc.users?.[0]?.user?.['client-certificate-data'];
    return data ? certInfo(b64dec(data)) : null;
  }
  return certInfo(h.fs.tryRead(p.path) || '');
}
function fmtExp(ms) {
  const d = new Date(ms);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${mon} ${String(d.getUTCDate()).padStart(2, '0')}, ${d.getUTCFullYear()} ${d.toISOString().slice(11, 16)} UTC`;
}
function residual(ms) {
  if (ms <= 0) return '<invalid>';
  const d = Math.floor(ms / 86400e3);
  if (d >= 365 * 2) return `${Math.floor(d / 365)}y`;
  if (d >= 1) return `${d}d`;
  return `${Math.floor(ms / 3600e3)}h`;
}

function* kubeadm(args, io, sh) {
  const h = sh.ctx.host, c = sh.ctx.cluster;
  const rest = args.filter((a) => !a.startsWith('-'));
  const flag = (n) => { const i = args.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`)); if (i < 0) return undefined; return args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : true; };
  const sub = rest[0];
  const now = c.now();
  const cp = Object.values(c.hosts).find((x) => x.role === 'control-plane');
  switch (sub) {
    case 'version': {
      const v = k8sVersion(h);
      if (flag('output') === 'short' || args.includes('-o') && args[args.indexOf('-o') + 1] === 'short') { io.line(v); return 0; }
      io.line(`kubeadm version: &version.Info{Major:"1", Minor:"${v.split('.')[1]}", EmulationMajor:"", EmulationMinor:"", MinCompatibilityMajor:"", MinCompatibilityMinor:"", GitVersion:"${v}", GitCommit:"3c07f4d8e8a1b2c3d4e5f60718293a4b5c6d7e8f", GitTreeState:"clean", BuildDate:"2026-01-10T12:00:00Z", GoVersion:"go1.25.7", Compiler:"gc", Platform:"linux/amd64"}`);
      return 0;
    }
    case 'token': {
      if (!isRoot(sh)) { io.eline('failed to load admin kubeconfig: open /etc/kubernetes/admin.conf: permission denied\nTo see the stack trace of this error execute with --v=5 or higher'); return 1; }
      if (h.role !== 'control-plane') { io.eline('failed to load admin kubeconfig: open /etc/kubernetes/admin.conf: no such file or directory\nTo see the stack trace of this error execute with --v=5 or higher'); return 1; }
      if (!c.apiAvailable()) { io.eline(`timed out waiting for the condition\nTo see the stack trace of this error execute with --v=5 or higher`); return 1; }
      if (rest[1] === 'create') {
        const id = hex(3), secret = hex(8);
        c.put({ apiVersion: 'v1', kind: 'Secret', type: 'bootstrap.kubernetes.io/token', metadata: { name: `bootstrap-token-${id}`, namespace: 'kube-system' }, data: { 'token-id': b64enc(id), 'token-secret': b64enc(secret), expiration: b64enc(new Date(now + 86400e3).toISOString()), 'usage-bootstrap-authentication': b64enc('true'), 'usage-bootstrap-signing': b64enc('true'), 'auth-extra-groups': b64enc('system:bootstrappers:kubeadm:default-node-token') } });
        const caHash = hexHash(cp.fs.tryRead('/etc/kubernetes/pki/ca.crt') || '', 64);
        if (args.includes('--print-join-command')) io.line(`kubeadm join ${cp.ip}:6443 --token ${id}.${secret} --discovery-token-ca-cert-hash sha256:${caHash} `);
        else io.line(`${id}.${secret}`);
        return 0;
      }
      if (rest[1] === 'list') {
        const toks = c.all('secrets', 'kube-system').filter((s) => s.type === 'bootstrap.kubernetes.io/token');
        io.line('TOKEN                     TTL         EXPIRES                USAGES                   DESCRIPTION                                                EXTRA GROUPS');
        for (const t of toks) { const exp = Date.parse(b64dec(t.data.expiration || '')) || now; io.line(`${b64dec(t.data['token-id'])}.${b64dec(t.data['token-secret'])}   ${humanDuration(exp - now).padEnd(11)} ${new Date(exp).toISOString().slice(0, 19)}Z   authentication,signing   <none>                                                     system:bootstrappers:kubeadm:default-node-token`); }
        return 0;
      }
      if (rest[1] === 'delete') { for (const t of rest.slice(2)) { c.remove('secrets', 'kube-system', `bootstrap-token-${t.split('.')[0]}`); io.line(`bootstrap token "${t.split('.')[0]}" deleted`); } return 0; }
      io.eline('Usage:\n  kubeadm token [flags]\n  kubeadm token [command]\n\nAvailable Commands:\n  create      Create bootstrap tokens on the server\n  delete      Delete bootstrap tokens on the server\n  generate    Generate and print a bootstrap token, but do not create it on the server\n  list        List bootstrap tokens on the server');
      return 1;
    }
    case 'join': {
      if (!isRoot(sh)) return notRoot(io);
      const errs = [];
      if (h.fs.exists('/etc/kubernetes/kubelet.conf')) errs.push('[ERROR FileAvailable--etc-kubernetes-kubelet.conf]: /etc/kubernetes/kubelet.conf already exists');
      if (h.kernel.swap) errs.push('[ERROR Swap]: running with swap on is not supported. Please disable swap');
      if (h.kernel.sysctl['net.ipv4.ip_forward'] !== '1') errs.push('[ERROR FileContent--proc-sys-net-ipv4-ip_forward]: /proc/sys/net/ipv4/ip_forward contents are not set to 1');
      if (h.unit('containerd').state !== 'active') errs.push('[ERROR CRI]: container runtime is not running: output: time="2026-01-01T08:00:00Z" level=fatal msg="validate service connection: validate CRI v1 runtime API for endpoint \\"unix:///run/containerd/containerd.sock\\": rpc error: code = Unavailable desc = connection error"');
      if (!h.packages.kubelet) errs.push('[ERROR FileExisting-kubelet]: kubelet not found in system path');
      io.line('[preflight] Running pre-flight checks');
      if (errs.length) { io.eline(`error execution phase preflight: [preflight] Some fatal errors occurred:\n${errs.map((e) => '\t' + e).join('\n')}\n[preflight] If you know what you are doing, you can make a check non-fatal with \`--ignore-preflight-errors=...\`\nTo see the stack trace of this error execute with --v=5 or higher`); return 1; }
      const tok = flag('token');
      const tid = String(tok || '').split('.')[0];
      const sec = c.peek('secrets', 'kube-system', `bootstrap-token-${tid}`);
      if (!c.apiAvailable()) { io.eline(`error execution phase preflight: couldn't validate the identity of the API Server: Get "https://${cp.ip}:6443/api/v1/namespaces/kube-public/configmaps/cluster-info?timeout=10s": dial tcp ${cp.ip}:6443: connect: connection refused`); return 1; }
      if (!sec || b64dec(sec.data['token-secret']) !== String(tok).split('.')[1]) { yield* sleep(5000); io.eline(`error execution phase preflight: couldn't validate the identity of the API Server: could not find a JWS signature in the cluster-info ConfigMap for token ID "${tid}"\nTo see the stack trace of this error execute with --v=5 or higher`); return 1; }
      const caHash = hexHash(cp.fs.tryRead('/etc/kubernetes/pki/ca.crt') || '', 64);
      const given = String(flag('discovery-token-ca-cert-hash') || '').replace('sha256:', '');
      if (!args.includes('--discovery-token-unsafe-skip-ca-verification') && given !== caHash) { io.eline(`error execution phase preflight: couldn't validate the identity of the API Server: cluster CA found in cluster-info ConfigMap is invalid: none of the public keys "sha256:${caHash}" are pinned\nTo see the stack trace of this error execute with --v=5 or higher`); return 1; }
      io.line('[preflight] Reading configuration from the "kubeadm-config" ConfigMap in namespace "kube-system"...\n[preflight] Use \'kubeadm init phase upload-config kubeadm --config your-config-file\' to re-upload it.\n[kubelet-start] Writing kubelet configuration to file "/var/lib/kubelet/config.yaml"\n[kubelet-start] Writing kubelet environment file with flags to file "/var/lib/kubelet/kubeadm-flags.env"\n[kubelet-start] Starting the kubelet');
      const { kubeletConfigYaml, kubeconfig } = yield* bootMod();
      h.fs.put('/var/lib/kubelet/config.yaml', kubeletConfigYaml());
      h.fs.put('/var/lib/kubelet/kubeadm-flags.env', `KUBELET_KUBEADM_ARGS="--node-ip=${h.ip}"\n`);
      h.fs.mkdir('/etc/kubernetes/manifests', { p: true });
      h.fs.put('/etc/kubernetes/pki/ca.crt', cp.fs.read('/etc/kubernetes/pki/ca.crt'));
      h.fs.put('/etc/kubernetes/kubelet.conf', kubeconfig({ user: `system:node:${h.name}`, cn: `system:node:${h.name}`, o: ['system:nodes'], ca: cp.fs.read('/etc/kubernetes/pki/ca.crt'), t: now }), { mode: 0o600 });
      h.unit('kubelet').enabled = true;
      daemonReload(h);
      stopUnit(c, h, 'kubelet');
      startUnit(c, h, 'kubelet');
      io.line('[kubelet-check] Waiting for a healthy kubelet at http://127.0.0.1:10248/healthz. This can take up to 4m0s');
      yield* sleep(3000);
      io.line('[kubelet-check] The kubelet is healthy after 1.002s\n[kubelet-start] Waiting for the kubelet to perform the TLS Bootstrap\n\nThis node has joined the cluster:\n* Certificate signing request was sent to apiserver and a response was received.\n* The Kubelet was informed of the new secure connection details.\n\nRun \'kubectl get nodes\' on the control-plane to see this node join the cluster.\n');
      c.reconcile();
      return 0;
    }
    case 'reset': {
      if (!isRoot(sh)) return notRoot(io);
      if (!args.includes('-f') && !args.includes('--force')) {
        io.line('W0101 08:00:00.000000   12345 preflight.go:56] [reset] WARNING: Changes made to this host by \'kubeadm init\' or \'kubeadm join\' will be reverted.');
        const a = yield { type: 'input', prompt: '[reset] Are you sure you want to proceed? [y/N]: ' };
        if (!/^y/i.test(String(a || ''))) { io.eline('error execution phase preflight: won\'t proceed; the user didn\'t answer (Y|y) in order to continue\nTo see the stack trace of this error execute with --v=5 or higher'); return 1; }
      }
      stopUnit(c, h, 'kubelet');
      for (const p of ['/etc/kubernetes/manifests', '/etc/kubernetes/pki', '/var/lib/kubelet/pki']) if (h.fs.exists(p)) h.fs.remove(p, { recursive: true });
      for (const f of ['/etc/kubernetes/kubelet.conf', '/etc/kubernetes/admin.conf', '/etc/kubernetes/super-admin.conf', '/etc/kubernetes/controller-manager.conf', '/etc/kubernetes/scheduler.conf', '/var/lib/kubelet/config.yaml']) if (h.fs.exists(f)) h.fs.remove(f);
      h.fs.mkdir('/etc/kubernetes/manifests', { p: true });
      io.line('[preflight] Running pre-flight checks\n[reset] Stopping the kubelet service\n[reset] Unmounting mounted directories in "/var/lib/kubelet"\n[reset] Deleting contents of directories: [/etc/kubernetes/manifests /var/lib/kubelet /etc/kubernetes/pki]\n[reset] Deleting files: [/etc/kubernetes/admin.conf /etc/kubernetes/super-admin.conf /etc/kubernetes/kubelet.conf /etc/kubernetes/bootstrap-kubelet.conf /etc/kubernetes/controller-manager.conf /etc/kubernetes/scheduler.conf]\n\nThe reset process does not perform cleanup of CNI plugin configuration,\nnetwork filtering rules and kubeconfig files.\n');
      return 0;
    }
    case 'upgrade': return yield* kubeadmUpgrade(args, rest, io, sh, flag);
    case 'certs': {
      const sub2 = rest[1];
      if (h.role !== 'control-plane') { io.eline('failed to load admin kubeconfig: open /etc/kubernetes/admin.conf: no such file or directory'); return 1; }
      if (!isRoot(sh)) { io.eline('[check-expiration] Reading configuration from the "kubeadm-config" ConfigMap in namespace "kube-system"...\n[check-expiration] Error reading configuration from the Cluster. Falling back to default configuration\n\nfailed to load existing certificate apiserver: open /etc/kubernetes/pki/apiserver.crt: permission denied'); return 1; }
      if (sub2 === 'check-expiration') {
        io.line('[check-expiration] Reading configuration from the "kubeadm-config" ConfigMap in namespace "kube-system"...\n[check-expiration] Use \'kubeadm init phase upload-config kubeadm --config your-config-file\' to re-upload it.\n');
        const rows = [['CERTIFICATE', 'EXPIRES', 'RESIDUAL TIME', 'CERTIFICATE AUTHORITY', 'EXTERNALLY MANAGED']];
        for (const p of certPaths(h)) { const i = readCert(h, p); if (!i) { rows.push([p.name, '<missing>', '', p.ca, 'no']); continue; } rows.push([p.name, fmtExp(i.na), residual(i.na - now), p.ca, 'no']); }
        const pad = (rs) => { const w = []; for (const r of rs) r.forEach((x, k) => { w[k] = Math.max(w[k] || 0, x.length); }); return rs.map((r) => r.map((x, k) => (k < r.length - 1 ? x.padEnd(w[k] + 3) : x)).join('')).join('\n'); };
        io.line(pad(rows));
        io.line('');
        const caRows = [['CERTIFICATE AUTHORITY', 'EXPIRES', 'RESIDUAL TIME', 'EXTERNALLY MANAGED']];
        for (const [n, f] of [['ca', 'ca.crt'], ['etcd-ca', 'etcd/ca.crt'], ['front-proxy-ca', 'front-proxy-ca.crt']]) { const i = certInfo(h.fs.tryRead(`/etc/kubernetes/pki/${f}`) || ''); caRows.push([n, i ? fmtExp(i.na) : '<missing>', i ? residual(i.na - now) : '', 'no']); }
        io.line(pad(caRows));
        return 0;
      }
      if (sub2 === 'renew') {
        const which = rest[2];
        if (!which) { io.eline('missing subcommand; "renew" is not meant to be run on its own\nTo see the stack trace of this error execute with --v=5 or higher'); return 1; }
        io.line('[renew] Reading configuration from the "kubeadm-config" ConfigMap in namespace "kube-system"...\n[renew] Use \'kubeadm init phase upload-config kubeadm --config your-config-file\' to re-upload it.\n');
        const list = certPaths(h).filter((p) => which === 'all' || p.name === which);
        if (!list.length) { io.eline(`unknown command "${which}" for "kubeadm certs renew"`); return 1; }
        const ca = h.fs.read('/etc/kubernetes/pki/ca.crt');
        const msgs = { 'admin.conf': 'certificate embedded in the kubeconfig file for the admin to use and for kubeadm itself', 'super-admin.conf': 'certificate embedded in the kubeconfig file for the super-admin', apiserver: 'certificate for serving the Kubernetes API', 'apiserver-etcd-client': 'certificate the apiserver uses to access etcd', 'apiserver-kubelet-client': 'certificate for the API server to connect to kubelet', 'controller-manager.conf': 'certificate embedded in the kubeconfig file for the controller manager to use', 'etcd-healthcheck-client': 'certificate for liveness probes to healthcheck etcd', 'etcd-peer': 'certificate for etcd nodes to communicate with each other', 'etcd-server': 'certificate for serving etcd', 'front-proxy-client': 'certificate for the front proxy client', 'scheduler.conf': 'certificate embedded in the kubeconfig file for the scheduler manager to use' };
        for (const p of list) {
          if (p.kubeconfig) {
            const { kubeconfig } = yield* bootMod();
            h.fs.put(p.path, kubeconfig({ user: p.def.user, cn: p.def.user, o: p.def.o || [], ca, t: now }), { mode: 0o600 });
          } else {
            const old = certInfo(h.fs.tryRead(p.path) || '') || {};
            h.fs.put(p.path, makeCert({ cn: p.def.cn, o: p.def.o || [], issuer: p.def.ca === 'ca' ? 'kubernetes' : p.def.ca, notBefore: now, days: 365, san: old.san || [], key: h.fs.tryRead(p.path.replace(/\.crt$/, '.key')) }));
          }
          io.line(`${msgs[p.name] || p.name} renewed`);
        }
        io.line('\nDone renewing certificates. You must restart the kube-apiserver, kube-controller-manager, kube-scheduler and etcd, so that they can use the new certificates.');
        return 0;
      }
      if (sub2 === 'certificate-key') { io.line(hex(32)); return 0; }
      io.eline('Commands related to handling Kubernetes certificates\n\nAvailable Commands:\n  certificate-key  Generate certificate keys\n  check-expiration Check certificates expiration for a Kubernetes cluster\n  generate-csr     Generate keys and certificate signing requests\n  renew            Renew certificates for a Kubernetes cluster');
      return 1;
    }
    case 'config': {
      if (rest[1] === 'images' && rest[2] === 'list') { const v = k8sVersion(h); for (const n of ['kube-apiserver', 'kube-controller-manager', 'kube-scheduler', 'kube-proxy']) io.line(`registry.k8s.io/${n}:${v}`); io.line('registry.k8s.io/coredns/coredns:v1.12.4\nregistry.k8s.io/pause:3.10.1\nregistry.k8s.io/etcd:3.6.6-0'); return 0; }
      if (rest[1] === 'print') { io.out(`apiVersion: kubeadm.k8s.io/v1beta4\nkind: InitConfiguration\nlocalAPIEndpoint:\n  advertiseAddress: 1.2.3.4\n  bindPort: 6443\nnodeRegistration:\n  criSocket: unix:///var/run/containerd/containerd.sock\n  imagePullPolicy: IfNotPresent\n  name: node\n---\napiVersion: kubeadm.k8s.io/v1beta4\nkind: ClusterConfiguration\nkubernetesVersion: ${k8sVersion(h)}\nnetworking:\n  dnsDomain: cluster.local\n  serviceSubnet: 10.96.0.0/12\n`); return 0; }
      io.eline('kubeadm config: dostępne "images list", "print init-defaults"');
      return 1;
    }
    case 'init': {
      if (!isRoot(sh)) return notRoot(io);
      io.line('[init] Using Kubernetes version: ' + k8sVersion(h) + '\n[preflight] Running pre-flight checks');
      io.eline('error execution phase preflight: [preflight] Some fatal errors occurred:\n\t[ERROR Port-6443]: Port 6443 is in use\n\t[ERROR FileAvailable--etc-kubernetes-manifests-kube-apiserver.yaml]: /etc/kubernetes/manifests/kube-apiserver.yaml already exists\n\t[ERROR DirAvailable--var-lib-etcd]: /var/lib/etcd is not empty\n[preflight] If you know what you are doing, you can make a check non-fatal with `--ignore-preflight-errors=...`\nTo see the stack trace of this error execute with --v=5 or higher');
      return 1;
    }
    default:
      io.line('\n    ┌──────────────────────────────────────────────────────────┐\n    │ KUBEADM                                                  │\n    │ Easily bootstrap a secure Kubernetes cluster             │\n    └──────────────────────────────────────────────────────────┘\n\nUsage:\n  kubeadm [command]\n\nAvailable Commands:\n  certs       Commands related to handling kubernetes certificates\n  completion  Output shell completion code for the specified shell (bash or zsh)\n  config      Manage configuration for a kubeadm cluster persisted in a ConfigMap in the cluster\n  help        Help about any command\n  init        Run this command in order to set up the Kubernetes control plane\n  join        Run this on any machine you wish to join an existing cluster\n  kubeconfig  Kubeconfig file utilities\n  reset       Performs a best effort revert of changes made to this host by \'kubeadm init\' or \'kubeadm join\'\n  token       Manage bootstrap tokens\n  upgrade     Upgrade your cluster smoothly to a newer version with this command\n  version     Print the version of kubeadm');
      return sub ? 1 : 0;
  }
}

function* bootMod() { return { kubeletConfigYaml, kubeconfig: mkKubeconfig }; }

function* kubeadmUpgrade(args, rest, io, sh, flag) {
  const h = sh.ctx.host, c = sh.ctx.cluster;
  const sub = rest[1];
  const kv = k8sVersion(h);
  const cur = clusterVersion(c);
  if (!isRoot(sh)) return notRoot(io);
  if (sub === 'plan') {
    if (h.role !== 'control-plane') { io.eline('failed to load admin kubeconfig: open /etc/kubernetes/admin.conf: no such file or directory'); return 1; }
    if (!c.apiAvailable()) { io.eline(`[upgrade/config] FATAL: unable to fetch the kubeadm-config ConfigMap: failed to get config map: Get "https://${h.ip}:6443/api/v1/namespaces/kube-system/configmaps/kubeadm-config?timeout=10s": dial tcp ${h.ip}:6443: connect: connection refused`); return 1; }
    io.line(`[preflight] Running pre-flight checks.\n[upgrade/config] Reading configuration from the "kubeadm-config" ConfigMap in namespace "kube-system"...\n[upgrade/config] Use 'kubeadm init phase upload-config kubeadm --config your-config-file' to re-upload it.\n[upgrade] Running cluster health checks\n[upgrade] Fetching available versions to upgrade to\n[upgrade/versions] Cluster version: ${cur}\n[upgrade/versions] kubeadm version: ${kv}`);
    yield* sleep(1500);
    const target = vcmp(kv, cur) > 0 ? kv : null;
    io.line(`[upgrade/versions] Target version: ${kv}\n[upgrade/versions] Latest version in the v${cur.split('.').slice(0, 2).join('.').slice(1)} series: ${kv}\n`);
    if (!target) { io.line('Awesome, you\'re up-to-date! Enjoy!'); return 0; }
    const nodes = c.all('nodes');
    io.line('Components that must be upgraded manually after you have upgraded the control plane with \'kubeadm upgrade apply\':\nCOMPONENT   NODE      CURRENT   TARGET');
    for (const n of nodes) io.line(`kubelet     ${n.metadata.name.padEnd(9)} ${n.status.nodeInfo.kubeletVersion.padEnd(9)} ${target}`);
    io.line(`\nUpgrade to the latest version in the v${cur.split('.').slice(0, 2).join('.').slice(1)} series:\n\nCOMPONENT                 NODE      CURRENT    TARGET\nkube-apiserver            cka-cp1   ${cur.padEnd(10)} ${target}\nkube-controller-manager   cka-cp1   ${cur.padEnd(10)} ${target}\nkube-scheduler            cka-cp1   ${cur.padEnd(10)} ${target}\nkube-proxy                          ${cur.padEnd(10)} ${target}\nCoreDNS                             v1.12.4    v1.12.4\netcd                      cka-cp1   3.6.6-0    3.6.6-0\n\nYou can now apply the upgrade by executing the following command:\n\n\tkubeadm upgrade apply ${target}\n\n_____________________________________________________________________\n`);
    return 0;
  }
  if (sub === 'apply') {
    const target = rest[2];
    if (!target) { io.eline('[upgrade/version] FATAL: missing one or more required arguments. Required arguments: [version]\nTo see the stack trace of this error execute with --v=5 or higher'); return 1; }
    const tv = target.startsWith('v') ? target : `v${target}`;
    if (h.role !== 'control-plane') { io.eline('failed to load admin kubeconfig: open /etc/kubernetes/admin.conf: no such file or directory'); return 1; }
    io.line('[preflight] Running pre-flight checks.\n[upgrade/config] Reading configuration from the "kubeadm-config" ConfigMap in namespace "kube-system"...\n[upgrade/config] Use \'kubeadm init phase upload-config kubeadm --config your-config-file\' to re-upload it.\n[upgrade] Running cluster health checks');
    if (!c.apiAvailable()) { io.eline('[upgrade/health] FATAL: [preflight] Some fatal errors occurred:\n\t[ERROR CreateJob]: Get "https://192.168.177.10:6443/api/v1/namespaces/kube-system/jobs": dial tcp 192.168.177.10:6443: connect: connection refused'); return 1; }
    if (vcmp(tv, kv) > 0) { io.eline(`[upgrade/version] FATAL: the --version argument is invalid due to these errors:\n\n\t- Specified version to upgrade to "${tv}" is higher than the kubeadm version "${kv}". Upgrade kubeadm first using the tool you used to install kubeadm\n\nCan be bypassed if you pass the --force flag\nTo see the stack trace of this error execute with --v=5 or higher`); return 1; }
    if (vcmp(tv, cur) < 0) { io.eline(`[upgrade/version] FATAL: the --version argument is invalid due to these errors:\n\n\t- Specified version to upgrade to "${tv}" is equal to or lower than the cluster version "${cur}". Downgrades are not supported yet\n\nCan be bypassed if you pass the --force flag`); return 1; }
    if (Number(tv.split('.')[1]) > Number(cur.split('.')[1]) + 1) { io.eline(`[upgrade/version] FATAL: the --version argument is invalid due to these errors:\n\n\t- Specified version to upgrade to "${tv}" is too high; kubeadm can upgrade only 1 minor version at a time`); return 1; }
    io.line(`[upgrade] Upgrading your Static Pod-hosted control plane to version "${tv}" (timeout: 5m0s)...`);
    if (!args.includes('-y') && !args.includes('--yes') && !args.includes('-f') && !args.includes('--force')) {
      const a = yield { type: 'input', prompt: '[upgrade] Are you sure you want to proceed? [y/N]: ' };
      if (!/^y/i.test(String(a || ''))) { io.eline('won\'t proceed; the user didn\'t answer (Y|y) in order to continue\nTo see the stack trace of this error execute with --v=5 or higher'); return 1; }
    }
    io.line('[upgrade/staticpods] Writing new Static Pod manifests to "/etc/kubernetes/tmp/kubeadm-upgraded-manifests1234567890"\n[upgrade/staticpods] Preparing for "etcd" upgrade\n[upgrade/staticpods] Current and new manifests of etcd are equal, skipping upgrade\n[upgrade/etcd] Waiting for etcd to become available');
    const now = c.now();
    for (const comp of ['kube-apiserver', 'kube-controller-manager', 'kube-scheduler']) {
      const p = `/etc/kubernetes/manifests/${comp}.yaml`;
      const text = h.fs.tryRead(p) || '';
      h.fs.put(p, text.replace(new RegExp(`(registry\\.k8s\\.io/${comp}):v[\\d.]+`), `$1:${tv}`), { mode: 0o600 });
      io.line(`[upgrade/staticpods] Preparing for "${comp}" upgrade\n[upgrade/staticpods] Renewing ${comp === 'kube-apiserver' ? 'apiserver certificate' : comp === 'kube-controller-manager' ? 'controller-manager.conf certificate' : 'scheduler.conf certificate'}\n[upgrade/staticpods] Moving new manifest to "${p}" and backing up old manifest to "/etc/kubernetes/tmp/kubeadm-backup-manifests-${now}/${comp}.yaml"\n[upgrade/staticpods] Waiting for the kubelet to restart the component\n[upgrade/staticpods] This can take up to 5m0s`);
      yield* sleep(comp === 'kube-apiserver' ? 15000 : 4000);
      io.line(`[apiclient] Found 1 Pods for label selector component=${comp}\n[upgrade/staticpods] Component "${comp}" upgraded successfully!`);
    }
    // certyfikaty odnowione przy upgrade
    const ca = h.fs.read('/etc/kubernetes/pki/ca.crt');
    for (const p of certPaths(h)) {
      if (p.kubeconfig) { const { kubeconfig } = yield* bootMod(); h.fs.put(p.path, kubeconfig({ user: p.def.user, cn: p.def.user, o: p.def.o || [], ca, t: c.now() }), { mode: 0o600 }); } else { const old = certInfo(h.fs.tryRead(p.path) || '') || {}; h.fs.put(p.path, makeCert({ cn: p.def.cn, o: p.def.o || [], issuer: p.def.ca === 'ca' ? 'kubernetes' : p.def.ca, notBefore: c.now(), days: 365, san: old.san || [], key: h.fs.tryRead(p.path.replace(/\.crt$/, '.key')) })); }
    }
    // obiekty w klastrze
    const cm = c.peek('configmaps', 'kube-system', 'kubeadm-config');
    if (cm) { cm.data.ClusterConfiguration = cm.data.ClusterConfiguration.replace(/kubernetesVersion: v[\d.]+/, `kubernetesVersion: ${tv}`); c.put(cm); }
    const kp = c.peek('daemonsets', 'kube-system', 'kube-proxy');
    if (kp) { const n = clone(kp); n.spec.template.spec.containers[0].image = `registry.k8s.io/kube-proxy:${tv}`; try { c.update(n, { user: null }); } catch { /* */ } }
    c.meta.version = tv;
    io.line(`[upgrade/postupgrade] Applying label node-role.kubernetes.io/control-plane='' to Nodes with label node-role.kubernetes.io/master='' (deprecated)\n[upload-config] Storing the configuration used in ConfigMap "kubeadm-config" in the "kube-system" Namespace\n[kubelet] Creating a ConfigMap "kubelet-config" in namespace kube-system with the configuration for the kubelets in the cluster\n[upgrade] Backing up kubelet config file to /etc/kubernetes/tmp/kubeadm-kubelet-config1234567/config.yaml\n[kubelet-start] Writing kubelet configuration to file "/var/lib/kubelet/config.yaml"\n[bootstrap-token] Configured RBAC rules to allow certificate rotation for all node client certificates in the cluster\n[addons] Applied essential addon: CoreDNS\n[addons] Applied essential addon: kube-proxy\n\n[upgrade] SUCCESS! A control plane node of your cluster was upgraded to "${tv}".\n\n[upgrade] Now please proceed with upgrading the rest of the nodes by following the right order.`);
    c.reconcile();
    return 0;
  }
  if (sub === 'node') {
    io.line('[upgrade] Reading configuration from the "kubeadm-config" ConfigMap in namespace "kube-system"...\n[upgrade] Use \'kubeadm init phase upload-config kubeadm --config your-config-file\' to re-upload it.\n[preflight] Running pre-flight checks\n[preflight] Skipping prepull. Not a control plane node.\n[upgrade] Skipping phase. Not a control plane node.\n[upgrade] Skipping phase. Not a control plane node.\n[upgrade] Backing up kubelet config file to /etc/kubernetes/tmp/kubeadm-kubelet-config/config.yaml\n[kubelet-start] Writing kubelet configuration to file "/var/lib/kubelet/config.yaml"\n[upgrade/kubelet-config] The kubelet configuration for this node was successfully upgraded!\n[upgrade/addon] Skipping the addon/coredns phase. Not a control plane node.\n[upgrade/addon] Skipping the addon/kube-proxy phase. Not a control plane node.');
    h.upgradedNode = clusterVersion(c);
    return 0;
  }
  if (sub === 'diff') { io.line(`--- /etc/kubernetes/manifests/kube-apiserver.yaml\n+++ new manifest\n-    image: registry.k8s.io/kube-apiserver:${cur}\n+    image: registry.k8s.io/kube-apiserver:${flag('version') || kv}`); return 0; }
  io.eline('Upgrade your cluster smoothly to a newer version with this command\n\nAvailable Commands:\n  apply       Upgrade your Kubernetes cluster to the specified version\n  diff        Show what differences would be applied to existing static pod manifests. See also: kubeadm upgrade apply --dry-run\n  node        Upgrade commands for a node in the cluster\n  plan        Check which versions are available to upgrade to and validate whether your current cluster is upgradeable.');
  return 1;
}

// ------------------------------------------------------------------ etcdctl / etcdutl
function etcdJson(c, level, caller, msg, extra = {}) {
  return JSON.stringify({ level, ts: new Date(c.now()).toISOString().replace('Z', '123Z').replace(/\.(\d{3})123Z/, '.$1456Z'), caller, msg, ...extra });
}
function* etcdctl(args, io, sh) {
  const h = sh.ctx.host, c = sh.ctx.cluster;
  const env = sh.env();
  const opt = (n) => { const i = args.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`)); if (i >= 0) return args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1]; return env[`ETCDCTL_${n.toUpperCase().replace(/-/g, '_')}`]; };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) { if (!a.includes('=') && ['endpoints', 'cacert', 'cert', 'key', 'write-out', 'dial-timeout', 'command-timeout', 'data-dir', 'name', 'initial-cluster', 'initial-advertise-peer-urls', 'initial-cluster-token', 'skip-hash-check', 'user', 'password'].includes(a.slice(2))) i++; continue; }
    if (a === '-w') { i++; continue; }
    rest.push(a);
  }
  const wi = args.indexOf('-w');
  const wout = wi >= 0 ? args[wi + 1] : opt('write-out') || 'simple';
  const sub = rest[0];
  if (!sub || sub === 'help') { io.line('NAME:\n\tetcdctl - A simple command line client for etcd3.\n\nCOMMANDS:\n\tget, put, del, member list, endpoint health, endpoint status, snapshot save, snapshot status, snapshot restore, version'); return 0; }
  if (sub === 'version') { io.line('etcdctl version: 3.6.6\nAPI version: 3.6'); return 0; }
  if (sub === 'snapshot' && (rest[1] === 'restore' || rest[1] === 'status')) {
    io.eline(`Deprecated: Use \`etcdutl snapshot ${rest[1]}\` instead.\n`);
    return yield* etcdutl(args.filter((a) => a !== 'snapshot' || true), io, sh);
  }
  // połączenie
  const endpoints = (opt('endpoints') || '127.0.0.1:2379').split(',');
  const ep = endpoints[0];
  const m = ep.match(/^(?:(https?):\/\/)?([^:/]+):(\d+)/);
  const timeout = function* () { yield* sleep(5000); io.eline(etcdJson(c, 'warn', 'v3@v3.6.6/retry_interceptor.go:63', 'retrying of unary invoker failed', { target: `etcd-endpoints://0xc000123456/${ep}`, attempt: 0, error: 'rpc error: code = DeadlineExceeded desc = latest balancer error: last connection error: connection error: desc = "error reading server preface: EOF"' })); io.eline('Error: context deadline exceeded'); return 1; };
  if (!m) { io.eline(`Error: invalid endpoint ${ep}`); return 1; }
  const ip = m[2] === 'localhost' ? '127.0.0.1' : m[2];
  const local = ip === '127.0.0.1' && h.role === 'control-plane';
  const cpHost = Object.values(c.hosts).find((x) => x.role === 'control-plane');
  if (!(local || ip === cpHost.ip) || m[3] !== '2379') { yield* sleep(2000); io.eline(etcdJson(c, 'warn', 'v3@v3.6.6/retry_interceptor.go:63', 'retrying of unary invoker failed', { error: `rpc error: code = DeadlineExceeded desc = latest balancer error: last connection error: connection error: desc = "transport: Error while dialing: dial tcp ${ip}:${m[3]}: connect: connection refused"` })); io.eline('Error: context deadline exceeded'); return 1; }
  if (!c.comp?.etcd) { yield* sleep(2000); io.eline(`{"level":"warn","msg":"retrying of unary invoker failed","error":"rpc error: code = DeadlineExceeded desc = latest balancer error: last connection error: connection error: desc = \\"transport: Error while dialing: dial tcp ${ip}:2379: connect: connection refused\\""}\nError: context deadline exceeded`); return 1; }
  if (m[1] !== 'https' && ep.startsWith('http://')) return yield* timeout();
  const cacert = opt('cacert'), cert = opt('cert'), key = opt('key');
  if (!cacert || !cert || !key) return yield* timeout();
  for (const [n, p] of [['cacert', cacert], ['cert', cert], ['key', key]]) {
    try { sh.fs.read(sh.abs(p), sh.user); } catch (e) {
      io.eline(`Error: open ${p}: ${e.code === 'EACCES' ? 'permission denied' : 'no such file or directory'}`);
      void n;
      return 128;
    }
  }
  const caInfo = certInfo(sh.fs.read(sh.abs(cacert), sh.user));
  const cInfo = certInfo(sh.fs.read(sh.abs(cert), sh.user));
  if (!caInfo || caInfo.cn !== 'etcd-ca' || !cInfo || cInfo.iss !== 'etcd-ca') { yield* sleep(1000); io.eline(`{"level":"warn","msg":"retrying of unary invoker failed","error":"rpc error: code = DeadlineExceeded desc = latest balancer error: last connection error: connection error: desc = \\"transport: authentication handshake failed: tls: failed to verify certificate: x509: certificate signed by unknown authority\\""}\nError: context deadline exceeded`); return 1; }
  if (keyId(sh.fs.read(sh.abs(key), sh.user)) && cInfo.k && keyId(sh.fs.read(sh.abs(key), sh.user)) !== cInfo.k) { io.eline('Error: tls: private key does not match public key'); return 128; }
  switch (sub) {
    case 'snapshot': {
      if (rest[1] !== 'save') { io.eline('Error: unknown command'); return 1; }
      const file = rest[2];
      if (!file) { io.eline('Error: snapshot save expects one argument'); return 1; }
      const p = sh.abs(file);
      const data = `ETCD-SNAPSHOT v3.6 rev=${c.rv} at=${c.now()}\n` + JSON.stringify(c.db);
      try { sh.fs.write(p, data, { user: sh.user, mode: 0o600 }); } catch (e) { io.eline(`Error: could not open ${p}.part (${e.reason || e.message})`); return 1; }
      const size = `${(data.length / 1048576).toFixed(1)} MB`;
      io.line(etcdJson(c, 'info', 'snapshot/v3_snapshot.go:83', 'created temporary db file', { path: `${p}.part` }));
      io.line(etcdJson(c, 'info', 'v3@v3.6.6/maintenance.go:236', 'opened snapshot stream; downloading', { logger: 'client' }));
      io.line(etcdJson(c, 'info', 'snapshot/v3_snapshot.go:96', 'fetching snapshot', { endpoint: ep }));
      io.line(etcdJson(c, 'info', 'v3@v3.6.6/maintenance.go:302', 'completed snapshot read; closing', { logger: 'client' }));
      io.line(etcdJson(c, 'info', 'snapshot/v3_snapshot.go:111', 'fetched snapshot', { endpoint: ep, size, took: 'now' }));
      io.line(etcdJson(c, 'info', 'snapshot/v3_snapshot.go:120', 'saved', { path: p }));
      io.line(`Snapshot saved at ${file}`);
      return 0;
    }
    case 'member': io.line(wout === 'table' ? `+------------------+---------+---------+-----------------------------+-----------------------------+------------+\n|        ID        | STATUS  |  NAME   |         PEER ADDRS          |        CLIENT ADDRS         | IS LEARNER |\n+------------------+---------+---------+-----------------------------+-----------------------------+------------+\n| 8e9e05c52164694d | started | cka-cp1 | https://${cpHost.ip}:2380 | https://${cpHost.ip}:2379 |      false |\n+------------------+---------+---------+-----------------------------+-----------------------------+------------+` : `8e9e05c52164694d, started, cka-cp1, https://${cpHost.ip}:2380, https://${cpHost.ip}:2379, false`); return 0;
    case 'endpoint':
      if (rest[1] === 'health') { io.line(`${ep} is healthy: successfully committed proposal: took = 9.218753ms`); return 0; }
      if (rest[1] === 'status') { io.line(wout === 'table' ? `+------------------------+------------------+---------+-----------------+---------+--------+-----------------------+-------+-----------+------------+-----------+------------+--------------------+--------+--------------------------+-------------------+\n|        ENDPOINT        |        ID        | VERSION | STORAGE VERSION | DB SIZE | IN USE | PERCENTAGE NOT IN USE | QUOTA | IS LEADER | IS LEARNER | RAFT TERM | RAFT INDEX | RAFT APPLIED INDEX | ERRORS | DOWNGRADE TARGET VERSION | DOWNGRADE ENABLED |\n+------------------------+------------------+---------+-----------------+---------+--------+-----------------------+-------+-----------+------------+-----------+------------+--------------------+--------+--------------------------+-------------------+\n| ${ep.padEnd(22)} | 8e9e05c52164694d |   3.6.6 |           3.6.0 |  5.2 MB | 2.6 MB |                   50% | 2.1 GB |      true |      false |         3 |      ${String(c.rv).padStart(5)} |              ${String(c.rv).padStart(5)} |        |                          |             false |\n+------------------------+------------------+---------+-----------------+---------+--------+-----------------------+-------+-----------+------------+-----------+------------+--------------------+--------+--------------------------+-------------------+` : `${ep}, 8e9e05c52164694d, 3.6.6, 3.6.0, 5.2 MB, 2.6 MB, 50%, 2.1 GB, true, false, 3, ${c.rv}, ${c.rv}, , , false`); return 0; }
      return 1;
    case 'get': {
      const key0 = rest[1] || '';
      const prefix = args.includes('--prefix');
      const keysOnly = args.includes('--keys-only');
      const keys = [];
      for (const [tbl, items] of Object.entries(c.db)) {
        const [plural, ...grp] = tbl.split('.');
        const g = grp.join('.');
        const base = g && !['apps', 'batch', 'policy'].includes(g) ? `/registry/${g}/${plural}` : `/registry/${plural === 'endpointslices' ? 'endpointslices' : plural}`;
        for (const k of Object.keys(items)) keys.push([`${base}/${k.replace(/^\//, '')}`, items[k]]);
      }
      keys.sort((a, b) => a[0].localeCompare(b[0]));
      for (const [k, v] of keys) {
        if (prefix ? !k.startsWith(key0) : k !== key0) continue;
        io.line(k);
        if (!keysOnly) { io.line(`k8s\0${JSON.stringify(v)}`); }
      }
      return 0;
    }
    case 'put': io.line('OK'); return 0;
    case 'del': io.line('1'); return 0;
    case 'alarm': io.line(''); return 0;
    default: io.eline(`Error: unknown command "${sub}" for "etcdctl"`); return 1;
  }
}

function* etcdutl(args, io, sh) {
  const c = sh.ctx.cluster;
  const rest = [];
  let dataDir = null;
  let wout = 'simple';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--data-dir') { dataDir = args[++i]; continue; }
    if (a.startsWith('--data-dir=')) { dataDir = a.slice(11); continue; }
    if (a === '-w' || a === '--write-out') { wout = args[++i]; continue; }
    if (a.startsWith('--write-out=')) { wout = a.slice(12); continue; }
    if (a.startsWith('--')) { if (!a.includes('=') && !['--skip-hash-check', '--bump-revision', '--mark-compacted'].includes(a)) i++; continue; }
    rest.push(a);
  }
  if (rest[0] === 'version') { io.line('etcdutl version: 3.6.6\nAPI version: 3.6'); return 0; }
  if (rest[0] !== 'snapshot') { io.line('NAME:\n\tetcdutl - An administrative command line tool for etcd3.\n\nCOMMANDS:\n\tdefrag, snapshot restore, snapshot status, version'); return rest.length ? 1 : 0; }
  const file = rest[2];
  if (!file) { io.eline(`Error: snapshot ${rest[1]} requires exactly one argument`); return 1; }
  let data;
  try { data = sh.fs.read(sh.abs(file), sh.user); } catch (e) { io.eline(`Error: open ${file}: ${e.code === 'EACCES' ? 'permission denied' : 'no such file or directory'}`); return 1; }
  if (!data.startsWith('ETCD-SNAPSHOT')) { io.eline(`Error: snapshot file integrity check failed. 2 errors occurred:\n\t* invalid database\n\t* unexpected EOF`); return 1; }
  const header = data.slice(0, data.indexOf('\n'));
  const rev = Number((header.match(/rev=(\d+)/) || [])[1] || 0);
  if (rest[1] === 'status') {
    const hash = hexHash(data, 8);
    const keys = (() => { try { return Object.values(JSON.parse(data.slice(data.indexOf('\n') + 1))).reduce((a, t) => a + Object.keys(t).length, 0); } catch { return 0; } })();
    if (wout === 'json') { io.line(JSON.stringify({ hash: parseInt(hash, 16), revision: rev, totalKey: keys, totalSize: data.length, version: '3.6.0' })); return 0; }
    if (wout === 'table') io.line(`+----------+----------+------------+------------+---------+\n|   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE | VERSION |\n+----------+----------+------------+------------+---------+\n| ${hash} | ${String(rev).padStart(8)} | ${String(keys).padStart(10)} | ${`${(data.length / 1048576).toFixed(1)} MB`.padStart(10)} |   3.6.0 |\n+----------+----------+------------+------------+---------+`);
    else io.line(`${hash}, ${rev}, ${keys}, ${(data.length / 1048576).toFixed(1)} MB, 3.6.0`);
    return 0;
  }
  if (rest[1] === 'restore') {
    const dir = sh.abs(dataDir || `${(file.split('/').pop() || 'default').replace(/\.db$/, '')}.etcd`);
    if (sh.fs.exists(dir) && sh.fs.isDir(dir) && sh.fs.list(dir).length) { io.eline(`Error: data-dir "${dir}" not empty or could not be read`); return 1; }
    try {
      sh.fs.mkdir(`${dir}/member/snap`, { p: true, user: sh.user });
      sh.fs.mkdir(`${dir}/member/wal`, { p: true, user: sh.user });
      sh.fs.write(`${dir}/member/snap/db`, data, { user: sh.user });
    } catch (e) { io.eline(`Error: mkdir ${dir}: ${e.reason || 'permission denied'}`); return 1; }
    io.line(`${new Date(c.now()).toISOString()}\tinfo\tsnapshot/v3_snapshot.go:305\trestoring snapshot\t{"path": "${file}", "wal-dir": "${dir}/member/wal", "data-dir": "${dir}", "snap-dir": "${dir}/member/snap", "initial-memory-map-size": 10737418240}`);
    io.line(`${new Date(c.now()).toISOString()}\tinfo\tmembership/store.go:138\tTrimming membership information from the backend...`);
    io.line(`${new Date(c.now()).toISOString()}\tinfo\tmembership/cluster.go:421\tadded member\t{"cluster-id": "cdf818194e3a8c32", "local-member-id": "0", "added-peer-id": "8e9e05c52164694d", "added-peer-peer-urls": ["http://localhost:2380"], "added-peer-is-learner": false}`);
    io.line(`${new Date(c.now()).toISOString()}\tinfo\tsnapshot/v3_snapshot.go:333\trestored snapshot\t{"path": "${file}", "wal-dir": "${dir}/member/wal", "data-dir": "${dir}", "snap-dir": "${dir}/member/snap", "initial-memory-map-size": 10737418240}`);
    return 0;
  }
  io.eline(`Error: unknown command "${rest[1]}"`);
  return 1;
}

// ------------------------------------------------------------------ openssl
function* openssl(args, io, sh) {
  const c = sh.ctx?.cluster;
  const now = c ? c.now() : Date.now();
  const sub = args[0];
  const opt = (n) => { const i = args.indexOf(`-${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const has = (n) => args.includes(`-${n}`);
  const rd = (p) => { try { return sh.fs.read(sh.abs(p), sh.user); } catch (e) { throw new Error(`Could not open file or uri for loading ${p.includes('key') ? 'private key' : 'certificate'} from ${p}: ${e.reason === 'Permission denied' ? 'Permission denied' : 'No such file or directory'}`); } };
  const wr = (p, d) => { try { sh.fs.write(sh.abs(p), d, { user: sh.user }); } catch (e) { throw new Error(`Could not open file or uri for writing ${p}: ${e.reason || 'Permission denied'}`); } };
  try {
    switch (sub) {
      case 'version': io.line('OpenSSL 3.0.13 30 Jan 2024 (Library: OpenSSL 3.0.13 30 Jan 2024)'); return 0;
      case 'genrsa': case 'genpkey': {
        const out = opt('out');
        const key = makeKey(Number(args[args.length - 1]) || 2048);
        if (out) wr(out, key); else io.out(key);
        return 0;
      }
      case 'rand': { const n = Number(args[args.length - 1]) || 16; io.line(has('hex') ? hex(n) : b64enc(hex(n)).slice(0, Math.ceil(n * 4 / 3))); return 0; }
      case 'req': {
        if (has('new') || has('newkey')) {
          let key;
          if (opt('key')) key = rd(opt('key'));
          else { key = makeKey(); if (opt('keyout')) wr(opt('keyout'), key); }
          const subj = opt('subj');
          if (!subj) { const cn = yield { type: 'input', prompt: 'Common Name (e.g. server FQDN or YOUR name) []:' }; return yield* openssl([...args, '-subj', `/CN=${cn || 'user'}`], io, sh); }
          const parts = subj.split('/').filter(Boolean).map((p) => p.split('='));
          const cn = (parts.find(([k]) => k === 'CN') || [])[1] || '';
          const o = parts.filter(([k]) => k === 'O').map(([, v]) => v);
          if (has('x509')) {
            const crt = makeCert({ cn, o, issuer: cn, notBefore: now, days: Number(opt('days') || 30), key, ca: true });
            if (opt('out')) wr(opt('out'), crt); else io.out(crt);
            return 0;
          }
          const csr = makeCsr({ cn, o, key });
          if (opt('out')) wr(opt('out'), csr); else io.out(csr);
          return 0;
        }
        if (opt('in')) {
          const p = parsePem(rd(opt('in')));
          if (!p || p.type !== 'CERTIFICATE REQUEST') { io.eline('Could not find certificate request from ' + opt('in')); return 1; }
          if (has('text') || has('subject')) io.line(`${has('text') ? 'Certificate Request:\n    Data:\n        Version: 1 (0x0)\n        ' : ''}subject=${(p.meta.o || []).map((x) => `O = ${x}, `).join('')}CN = ${p.meta.cn}`);
          if (!has('noout')) io.out(rd(opt('in')));
          return 0;
        }
        io.eline('req: Use -help for summary.');
        return 1;
      }
      case 'x509': {
        const inF = opt('in');
        if (has('req')) {
          const csr = parsePem(rd(inF));
          if (!csr || csr.type !== 'CERTIFICATE REQUEST') { io.eline('Unable to load certificate request input'); return 1; }
          const caCrt = certInfo(rd(opt('CA')));
          rd(opt('CAkey'));
          const crt = makeCert({ cn: csr.meta.cn, o: csr.meta.o, issuer: caCrt?.cn || 'kubernetes', notBefore: now, days: Number(opt('days') || 30), key: null });
          const fixed = crt.replace(/^/, '');
          // klucz certyfikatu = klucz z CSR
          const meta = { ...certInfo(fixed), k: csr.meta.k };
          const pem = `-----BEGIN CERTIFICATE-----\n${b64enc(JSON.stringify(meta) + '#' + hexHash(JSON.stringify(meta), 300)).match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
          if (opt('out')) wr(opt('out'), pem); else io.out(pem);
          io.eline(`Certificate request self-signature ok\nsubject=${(csr.meta.o || []).map((x) => `O = ${x}, `).join('')}CN = ${csr.meta.cn}`);
          return 0;
        }
        const text = inF ? rd(inF) : io.stdin || '';
        const ci = certInfo(text);
        if (!ci) { io.eline('Could not read certificate from ' + (inF || '<stdin>') + '\nUnable to load certificate'); return 1; }
        const subj = dn(ci), iss = `CN = ${ci.iss}`;
        if (has('text')) {
          io.line(`Certificate:\n    Data:\n        Version: 3 (0x2)\n        Serial Number: ${ci.serial.match(/.{2}/g).join(':')}\n        Signature Algorithm: sha256WithRSAEncryption\n        Issuer: ${iss}\n        Validity\n            Not Before: ${opensslDate(ci.nb)}\n            Not After : ${opensslDate(ci.na)}\n        Subject: ${subj}\n        Subject Public Key Info:\n            Public Key Algorithm: rsaEncryption\n                Public-Key: (2048 bit)\n        X509v3 extensions:\n            X509v3 Key Usage: critical\n                Digital Signature, Key Encipherment${ci.ca ? ', Certificate Sign' : ''}\n            X509v3 Basic Constraints: critical\n                CA:${ci.ca ? 'TRUE' : 'FALSE'}${(ci.san || []).length ? `\n            X509v3 Subject Alternative Name: \n                ${ci.san.map((s) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? `IP Address:${s}` : `DNS:${s}`)).join(', ')}` : ''}`);
          return 0;
        }
        const lines = [];
        if (has('subject')) lines.push(`subject=${subj}`);
        if (has('issuer')) lines.push(`issuer=${iss}`);
        if (has('dates') || has('startdate')) lines.push(`notBefore=${opensslDate(ci.nb)}`);
        if (has('dates') || has('enddate')) lines.push(`notAfter=${opensslDate(ci.na)}`);
        if (has('serial')) lines.push(`serial=${ci.serial.toUpperCase()}`);
        if (has('fingerprint')) { const fpv = fingerprint(text) || ''; lines.push(has('sha256') ? `sha256 Fingerprint=${fpv}` : `sha1 Fingerprint=${fpv.slice(0, 59)}`); }
        if (args.includes('-ext')) lines.push(`X509v3 Subject Alternative Name: \n    ${(ci.san || []).map((s) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? `IP Address:${s}` : `DNS:${s}`)).join(', ')}`);
        if (has('checkend')) { const ok = ci.na > now + Number(opt('checkend')) * 1000; io.line(ok ? 'Certificate will not expire' : 'Certificate will expire'); return ok ? 0 : 1; }
        for (const l of lines) io.line(l);
        if (!has('noout')) io.out(text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\n?/)?.[0] || '');
        return 0;
      }
      case 'base64': case 'enc': {
        const data = opt('in') ? rd(opt('in')) : io.stdin || '';
        if (has('d')) io.out(b64dec(data.replace(/\s/g, '')));
        else { const e = b64enc(data); io.line(has('A') ? e : e.match(/.{1,64}/g).join('\n')); }
        return 0;
      }
      case 'rsa': case 'pkey': { const k = rd(opt('in')); if (has('pubout')) io.out('-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA' + keyId(k) + '\n-----END PUBLIC KEY-----\n'); else if (has('check')) io.line('RSA key ok'); return 0; }
      case 'verify': { const ca = certInfo(rd(opt('CAfile'))); const f = args[args.length - 1]; const ci = certInfo(rd(f)); if (ci && ca && ci.iss === ca.cn) { io.line(`${f}: OK`); return 0; } io.eline(`CN = ${ci?.cn}\nerror 20 at 0 depth lookup: unable to get local issuer certificate\nerror ${f}: verification failed`); return 2; }
      case 's_client': {
        const target = opt('connect') || '';
        const [thost, tport] = target.split(':');
        const cc = sh.ctx?.cluster;
        const cpH = cc && Object.values(cc.hosts).find((x) => x.role === 'control-plane');
        const isApi = cc && tport === '6443' && (['127.0.0.1', 'localhost', cpH?.name].includes(thost) ? sh.ctx.host === cpH : thost === cpH?.ip);
        if (!isApi || !cc.apiAvailable()) { io.eline(`${thost}:${tport}: Connection refused\nconnect:errno=111`); return 1; }
        const crt = cc.meta.servingCert || cpH.fs.tryRead('/etc/kubernetes/pki/apiserver.crt') || '';
        io.eline('depth=0 CN = kube-apiserver\nverify error:num=20:unable to get local issuer certificate\nverify return:1');
        io.line(`CONNECTED(00000003)\n---\nCertificate chain\n 0 s:CN = kube-apiserver\n   i:CN = kubernetes\n---\nServer certificate\n${crt.trim()}\nsubject=CN = kube-apiserver\nissuer=CN = kubernetes\n---\nNo client certificate CA names sent\n---\nSSL handshake has read 1520 bytes and written 393 bytes\nVerification error: unable to get local issuer certificate\n---\nNew, TLSv1.3, Cipher is TLS_AES_128_GCM_SHA256\nDONE`);
        return 0;
      }
      default: io.eline(`Invalid command '${sub || ''}'; type "help" for a list.`); return 1;
    }
  } catch (e) {
    io.eline(e.message);
    return 1;
  }
}

// ------------------------------------------------------------------ watch (pętla)
function* watch(args, io, sh) {
  let interval = 2;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n' || args[i] === '--interval') interval = Number(args[++i]);
    else if (/^-n\d/.test(args[i])) interval = Number(args[i].slice(2));
    else if (args[i] === '-d' || args[i] === '-t' || args[i] === '--no-title') continue;
    else rest.push(args[i]);
  }
  const cmd = rest.join(' ');
  while (true) {
    yield { type: 'clear' };
    const c = sh.ctx?.cluster;
    io.line(`Every ${interval.toFixed(1)}s: ${cmd}`.padEnd(60) + `${(sh.fs.tryRead('/etc/hostname') || '').trim()}: ${new Date(c ? c.now() : Date.now()).toUTCString()}\n`);
    try { yield* sh.run(cmd, io); } catch (e) { if (!(e instanceof ExitSignal)) throw e; }
    yield* sleep(interval * 1000);
  }
}

function* hostnamectl(args, io, sh) { const h = sh.ctx.host; io.line(` Static hostname: ${h.name}\n       Icon name: computer-vm\n         Chassis: vm 🖴\n  Virtualization: kvm\nOperating System: Ubuntu 24.04.5 LTS\n          Kernel: Linux 6.8.0-147-generic\n    Architecture: x86-64`); return 0; }
function* iptables(args, io, sh) { if (!isRoot(sh)) { io.eline('iptables v1.8.10 (nf_tables): Could not fetch rule set generation id: Permission denied (you must be root)'); return 4; } io.line('Chain INPUT (policy ACCEPT)\ntarget     prot opt source               destination\nKUBE-FIREWALL  all  --  anywhere             anywhere\n\nChain FORWARD (policy ACCEPT)\ntarget     prot opt source               destination\nKUBE-FORWARD  all  --  anywhere             anywhere'); return 0; }
function* nslookupHost(args, io, sh) { return 0; }
function* cka(args, io) { io.line('Panel zadań znajdziesz w aplikacji (przycisk "Zadanie").'); return 0; }

registerHostCommands({
  ssh, sudo, su, systemctl, journalctl, crictl, apt, 'apt-get': apt, 'apt-cache': aptCache, 'apt-mark': aptMark, dpkg,
  sysctl, modprobe, lsmod, swapoff, swapon, reboot, shutdown: reboot, kubeadm, kubelet: kubeletBin, containerd: containerdBin, ctr,
  etcdctl, etcdutl, openssl, kubectl, helm, watch, hostnamectl, iptables, cka,
});
void nslookupHost; void startUnit;
