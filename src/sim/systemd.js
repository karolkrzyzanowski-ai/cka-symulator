// Jednostki systemd na węzłach: kubelet i containerd (start, awarie, auto-restart, dziennik).
import { parseOne } from '../lib/yaml.js';
import { sockPath } from './hosts.js';
import { klog } from './component.js';

const KUBELET_FLAGS = new Set(['bootstrap-kubeconfig', 'kubeconfig', 'config', 'container-runtime-endpoint', 'node-ip', 'hostname-override', 'pod-infra-container-image', 'v', 'cgroup-driver', 'fail-swap-on', 'node-labels', 'register-node', 'register-with-taints', 'root-dir', 'cert-dir', 'image-service-endpoint', 'resolv-conf', 'max-pods', 'cloud-provider', 'feature-gates', 'rotate-certificates', 'runtime-request-timeout', 'kube-reserved', 'system-reserved', 'eviction-hard', 'cluster-dns', 'cluster-domain', 'tls-cert-file', 'tls-private-key-file', 'provider-id']);

function nowIso(t) { return new Date(t).toISOString(); }

// --------------------------------------------------------------------------- containerd
export function checkContainerd(c, h) {
  const bin = '/usr/local/bin/containerd';
  const parsed = h.parseUnit('containerd');
  const argv = h.expandExec(parsed);
  if (!argv) return { ok: false, code: 'exec', msg: 'containerd.service: Service has no ExecStart=, ExecStop=, or SuccessAction=. Refusing.' };
  if (!h.fs.isFile(argv[0])) return { ok: false, code: 203, msg: `containerd.service: Failed to locate executable ${argv[0]}: No such file or directory` };
  void bin;
  let cfgPath = '/etc/containerd/config.toml';
  const ci = argv.indexOf('--config');
  if (ci > 0) cfgPath = argv[ci + 1];
  const text = h.fs.tryRead(cfgPath);
  let address = '/run/containerd/containerd.sock';
  if (text !== null) {
    const err = tomlCheck(text);
    if (err) return { ok: false, code: 1, msg: `containerd: failed to load TOML: ${cfgPath}: ${err}` };
    const g = text.match(/\[grpc\][^[]*?address\s*=\s*["']([^"']+)["']/);
    if (g) address = g[1];
  }
  return { ok: true, address: sockPath(address) };
}

export function tomlCheck(text) {
  const lines = text.split('\n');
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/#.*$/, '').trim();
    if (!l) continue;
    if (depth > 0) {
      for (const ch of l) { if (ch === '[' || ch === '{') depth++; if (ch === ']' || ch === '}') depth--; }
      continue;
    }
    if (l.startsWith('[')) {
      if (!/^\[\[?[^\][]+\]\]?$/.test(l)) return `(${i + 1}, 1): unexpected EOF`;
      continue;
    }
    const m = l.match(/^([\w."'-]+)\s*=\s*(.+)$/);
    if (!m) return `(${i + 1}, 1): expected key separator '='`;
    const v = m[2];
    const q = (v.match(/"/g) || []).length;
    if (q % 2) return `(${i + 1}, ${l.indexOf('"') + 1}): unclosed string`;
    for (const ch of v) { if (ch === '[' || ch === '{') depth++; if (ch === ']' || ch === '}') depth--; }
  }
  return null;
}

// --------------------------------------------------------------------------- kubelet
export function checkKubelet(c, h, { loaded } = {}) {
  const parsed = loaded || h.parseUnit('kubelet');
  const argv = h.expandExec(parsed);
  if (!argv) return { ok: false, code: 'noexec', msg: 'kubelet.service: Service has no ExecStart=, ExecStop=, or SuccessAction=. Refusing.' };
  if (!h.fs.isFile(argv[0])) return { ok: false, code: 203, msg: `kubelet.service: Failed to locate executable ${argv[0]}: No such file or directory`, msg2: `kubelet.service: Failed at step EXEC spawning ${argv[0]}: No such file or directory` };
  const flags = {};
  for (const a of argv.slice(1)) {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    if (!m) continue;
    if (!KUBELET_FLAGS.has(m[1])) return { ok: false, code: 1, msg: `E0000 00:00:00.000000    2481 run.go:72] "command failed" err="failed to parse kubelet flag: unknown flag: --${m[1]}"` };
    flags[m[1]] = m[2] ?? 'true';
  }
  const cfgPath = flags.config || '/var/lib/kubelet/config.yaml';
  const text = h.fs.tryRead(cfgPath);
  if (text === null) return { ok: false, code: 1, msg: `"command failed" err="failed to load kubelet config file, path: ${cfgPath}, error: failed to load Kubelet config file ${cfgPath}, error failed to read kubelet config file \\"${cfgPath}\\", error: open ${cfgPath}: no such file or directory"` };
  let cfg;
  try { cfg = parseOne(text) || {}; } catch (e) {
    return { ok: false, code: 1, msg: `"command failed" err="failed to load kubelet config file, path: ${cfgPath}, error: failed to decode: ${e.message}"` };
  }
  if (cfg.kind && cfg.kind !== 'KubeletConfiguration') return { ok: false, code: 1, msg: `"command failed" err="failed to load kubelet config file, path: ${cfgPath}, error: no kind \\"${cfg.kind}\\" is registered"` };
  const ca = cfg.authentication?.x509?.clientCAFile;
  if (ca && !h.fs.exists(ca)) return { ok: false, code: 1, msg: `"command failed" err="failed to construct kubelet dependencies: unable to load client CA file ${ca}: open ${ca}: no such file or directory"` };
  const kc = flags.kubeconfig || '/etc/kubernetes/kubelet.conf';
  if (!h.fs.exists(kc)) {
    const bk = flags['bootstrap-kubeconfig'];
    if (!bk || !h.fs.exists(bk)) {
      return { ok: false, code: 1, msg: `"command failed" err="failed to run Kubelet: unable to load bootstrap kubeconfig: stat ${bk || '/etc/kubernetes/bootstrap-kubelet.conf'}: no such file or directory"` };
    }
  }
  const endpoint = flags['container-runtime-endpoint'] || cfg.containerRuntimeEndpoint || 'unix:///run/containerd/containerd.sock';
  const cd = h.unit('containerd');
  const sock = sockPath(endpoint);
  if (cd.state !== 'active' || cd.address !== sock) {
    return { ok: false, code: 1, msg: `"command failed" err="failed to run Kubelet: validate service connection: validate CRI v1 runtime API for endpoint \\"${endpoint}\\": rpc error: code = Unavailable desc = connection error: desc = \\"transport: Error while dialing: dial unix ${sock}: connect: ${cd.state === 'active' ? 'no such file or directory' : 'connection refused'}\\""` };
  }
  if (cfg.failSwapOn !== false && h.kernel.swap) return { ok: false, code: 1, msg: '"command failed" err="failed to run Kubelet: running with swap on is not supported, please disable swap or set --fail-swap-on flag to false"' };
  return {
    ok: true, endpoint, staticPodPath: cfg.staticPodPath || '/etc/kubernetes/manifests',
    cgroupDriver: cfg.cgroupDriver || 'systemd', clusterDNS: cfg.clusterDNS?.[0] || '10.96.0.10',
    kubeconfig: kc, hasKubeconfig: h.fs.exists(kc),
  };
}

// --------------------------------------------------------------------------- operacje
export function startUnit(c, h, name, { manual = true } = {}) {
  const u = h.unit(name);
  const now = c.now();
  if (name !== 'kubelet' && name !== 'containerd') { u.state = 'active'; u.since = now; return { ok: true }; }
  const res = name === 'kubelet' ? checkKubelet(c, h, { loaded: u.loaded }) : checkContainerd(c, h);
  if (manual) {
    h.log(name, now, `Started ${name}.service - ${name === 'kubelet' ? 'kubelet: The Kubernetes Node Agent' : 'containerd container runtime'}.`);
  }
  if (!res.ok) {
    u.state = 'auto-restart';
    u.failCode = res.code;
    u.nextRestart = now + 10000;
    u.since = now;
    u.lastError = res.msg;
    u.restarts = (u.restarts || 0) + 1;
    if (res.code === 203) {
      h.log(name, now, res.msg);
      if (res.msg2) h.log(name, now, res.msg2);
      h.log(name, now, `${name}.service: Main process exited, code=exited, status=203/EXEC`);
    } else {
      h.log(name, now, res.msg);
      h.log(name, now, `${name}.service: Main process exited, code=exited, status=1/FAILURE`);
    }
    h.log(name, now, `${name}.service: Failed with result 'exit-code'.`);
    return { ok: false, res };
  }
  const wasActive = u.state === 'active';
  u.state = 'active';
  u.since = wasActive ? u.since : now;
  u.pid = 1000 + Math.floor(Math.random() * 30000);
  u.lastError = null;
  u.restarts = 0;
  if (name === 'containerd') {
    u.address = res.address;
    h.log(name, now, `time="${nowIso(now)}" level=info msg="starting containerd" revision=… version=v${h.packages.containerd || '2.4.2'}`);
    h.log(name, now, `time="${nowIso(now)}" level=info msg=serving... address=${res.address}`);
    h.log(name, now, `time="${nowIso(now)}" level=info msg="containerd successfully booted in 0.04s"`);
  } else {
    u.runningVersion = h.packages.kubelet;
    u.cfg = res;
    h.log(name, now, klog('I', now, 'server.go:529', `"Kubelet version" kubeletVersion="v${(h.packages.kubelet || '').split('-')[0]}"`));
    h.log(name, now, klog('I', now, 'server.go:1287', '"Started kubelet"'));
    h.log(name, now, klog('I', now + 400, 'kubelet_node_status.go:75', `"Attempting to register node" node="${h.name}"`));
  }
  return { ok: true, res };
}

export function stopUnit(c, h, name) {
  const u = h.unit(name);
  if (u.state === 'inactive') return;
  const now = c.now();
  h.log(name, now, `Stopping ${name}.service...`);
  h.log(name, now, `${name}.service: Deactivated successfully.`);
  h.log(name, now, `Stopped ${name}.service.`);
  u.state = 'inactive';
  u.since = now;
  u.nextRestart = null;
}

export function daemonReload(h) {
  for (const name of Object.keys(h.units)) {
    const u = h.units[name];
    u.loadedHash = h.unitHash(name);
    if (name === 'kubelet') u.loaded = h.parseUnit('kubelet');
  }
}

export function unitChangedOnDisk(h, name) {
  const u = h.unit(name);
  return u.loadedHash !== undefined && u.loadedHash !== h.unitHash(name);
}

// auto-restart (Restart=always, RestartSec=10)
export function systemdTick(c, h) {
  let changed = false;
  for (const name of ['containerd', 'kubelet']) {
    const u = h.units[name];
    if (!u) continue;
    if (u.state === 'auto-restart' && u.nextRestart && c.now() >= u.nextRestart) {
      startUnit(c, h, name, { manual: false });
      changed = true;
    }
    // kubelet działa, ale containerd padł -> kubelet się wysypuje
    if (name === 'kubelet' && u.state === 'active') {
      const cd = h.unit('containerd');
      const ep = sockPath(u.cfg?.endpoint);
      if (cd.state !== 'active' || cd.address !== ep) {
        const now = c.now();
        h.log('kubelet', now, klog('E', now, 'kubelet.go:2412', `"Skipping pod synchronization" err="container runtime is down"`));
        u.state = 'auto-restart';
        u.nextRestart = now + 10000;
        u.lastError = 'container runtime is down';
        changed = true;
      }
    }
  }
  return changed;
}

export function unitStatusText(c, h, name) {
  const u = h.unit(name);
  const parsed = h.parseUnit(name);
  const now = c.now();
  const since = new Date(u.since || h.bootTime || now);
  const ago = Math.max(0, Math.floor((now - (u.since || now)) / 1000));
  const agoStr = ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.floor(ago / 60)}min ${ago % 60}s ago` : `${Math.floor(ago / 3600)}h ${Math.floor((ago % 3600) / 60)}min ago`;
  const desc = name === 'kubelet' ? 'kubelet: The Kubernetes Node Agent' : name === 'containerd' ? 'containerd container runtime' : name;
  if (!parsed.base) return `Unit ${name}.service could not be found.\n`;
  const lines = [];
  const dot = u.state === 'active' ? '●' : u.state === 'auto-restart' ? '●' : '○';
  lines.push(`${dot} ${name}.service - ${desc}`);
  lines.push(`     Loaded: loaded (${parsed.base}; ${u.enabled ? 'enabled' : 'disabled'}; preset: enabled)`);
  if (parsed.dropins.length) {
    const byDir = {};
    for (const d of parsed.dropins) { const dir = d.slice(0, d.lastIndexOf('/')); (byDir[dir] = byDir[dir] || []).push(d.slice(d.lastIndexOf('/') + 1)); }
    let first = true;
    for (const [dir, files] of Object.entries(byDir)) {
      lines.push(`    ${first ? 'Drop-In' : '       '}: ${dir}`);
      lines.push(`             └─${files.join(', ')}`);
      first = false;
    }
  }
  const ts = since.toUTCString().replace(' GMT', ' UTC');
  if (u.state === 'active') lines.push(`     Active: active (running) since ${ts}; ${agoStr}`);
  else if (u.state === 'auto-restart') lines.push(`     Active: activating (auto-restart) (Result: exit-code) since ${ts}; ${agoStr}`);
  else lines.push(`     Active: inactive (dead)${u.since ? ` since ${ts}; ${agoStr}` : ''}`);
  lines.push(`       Docs: ${name === 'kubelet' ? 'https://kubernetes.io/docs/' : 'https://containerd.io'}`);
  if (u.state === 'auto-restart') {
    const argv = h.expandExec(parsed) || [];
    lines.push(`    Process: ${u.pid || 4242} ExecStart=${argv.join(' ')} (code=exited, status=${u.failCode === 203 ? '203/EXEC' : '1/FAILURE'})`);
    lines.push(`   Main PID: ${u.pid || 4242} (code=exited, status=${u.failCode === 203 ? '203/EXEC' : '1/FAILURE'})`);
  } else if (u.state === 'active') {
    const argv = h.expandExec(parsed) || [];
    lines.push(`   Main PID: ${u.pid} (${name})`);
    lines.push(`      Tasks: ${name === 'kubelet' ? 14 : 9} (limit: 4598)`);
    lines.push(`     Memory: ${name === 'kubelet' ? '48.2M' : '31.6M'}`);
    lines.push(`        CPU: ${Math.max(1, Math.floor(ago / 30))}.${String(ago % 100).padStart(3, '0')}s`);
    lines.push(`     CGroup: /system.slice/${name}.service`);
    lines.push(`             └─${u.pid} ${argv.join(' ')}`);
  }
  lines.push('');
  const j = (h.journal[name] || []).slice(-10);
  for (const [t, m] of j) lines.push(`${journalPrefix(t, h.name, name)}${m}`);
  if (unitChangedOnDisk(h, name)) lines.push(`Warning: The unit file, source configuration file or drop-ins of ${name}.service changed on disk. Run 'systemctl daemon-reload' to reload units.`);
  return lines.join('\n') + '\n';
}

export function journalPrefix(t, host, unit) {
  const d = new Date(t);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const pad = (n) => String(n).padStart(2, '0');
  const proc = unit === 'kubelet' ? 'kubelet[2481]' : unit === 'containerd' ? 'containerd[812]' : 'systemd[1]';
  return `${mon} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${host} ${proc}: `;
}

// restarty hostów (reboot) - wznowienie usług po ~20 s
export function processReboots(c) {
  if (!c.rebootQueue?.length) return false;
  let changed = false;
  for (const r of [...c.rebootQueue]) {
    if (c.now() < r.at) continue;
    const h = c.hosts[r.host];
    h.down = false;
    for (const u of ['containerd', 'kubelet']) if (h.unit(u).enabled) startUnit(c, h, u, { manual: true });
    c.rebootQueue = c.rebootQueue.filter((x) => x !== r);
    changed = true;
  }
  return changed;
}
