// Kontekst zadań: odpowiednik ckalib.kube.Ctx z labu, działający na symulatorze.
import { makeHostShell } from '../shell/hostshell.js';
import { IO, ExitSignal } from '../shell/interp.js';
import { clean } from '../kubectl/common.js';
import { shQuote, b64enc, clone, hex, parseSelector, matchReqs } from '../lib/util.js';
import { httpRequest } from '../sim/net.js';
import { NODES } from '../sim/bootstrap.js';

export class SetupError extends Error {}
export class TaskUnavailable extends Error {}

export class Res {
  constructor(rc, out = '', err = '') { this.rc = rc; this.out = out; this.err = err; }
  get ok() { return this.rc === 0; }
  get text() { return (this.out + this.err).trim(); }
}

export const CFG = {
  cp: NODES[0].name, w1: NODES[1].name, w2: NODES[2].name, vm_user: 'candidate', net_prefix: '192.168.177',
  kubernetes_svc_ip: '10.96.0.1', dns_svc_ip: '10.96.0.10',
  ip(n) { return (NODES.find((x) => x.name === n) || {}).ip || n; },
  placeholders() {
    return {
      cp: this.cp, w1: this.w1, w2: this.w2, cp_ip: this.ip(this.cp), w1_ip: this.ip(this.w1), w2_ip: this.ip(this.w2),
      net: this.net_prefix, vm_user: this.vm_user, k8s_minor: '1.37', cert_manager_version: '1.21.3', podinfo_version: '6.17.0',
    };
  },
};

// synchroniczne wykonanie generatora powłoki (czas symulacji przewijany)
export function runSync(c, gen, { input = [], maxMs = 15 * 60e3 } = {}) {
  const start = c.now();
  let resume;
  let steps = 0;
  let follow = 0;
  while (true) {
    if (++steps > 300000) { try { gen.return(124); } catch { /* */ } return 124; }
    let r;
    try { r = gen.next(resume); } catch (e) {
      if (e instanceof ExitSignal) return e.code;
      throw e;
    }
    resume = undefined;
    if (r.done) return r.value ?? 0;
    const ef = r.value || {};
    if (ef.type === 'sleep') {
      if (ef.follow || ef.ms >= 3600e3) { if (++follow > 2) { try { gen.return(130); } catch { /* */ } return 130; } }
      c.advance(Math.min(ef.ms, 600e3), 1000);
      if (c.now() - start > maxMs) { try { gen.return(124); } catch { /* */ } return 124; }
    } else if (ef.type === 'input') resume = input.length ? input.shift() : null;
    else if (ef.type === 'edit') resume = { saved: false };
  }
}

export class TaskCtx {
  constructor(world, state = {}) {
    this.world = world;
    this.c = world.cluster;
    this.cfg = CFG;
    this.state = state;
    this.verbose = false;
    this.rng = state.__seed !== undefined ? mulberry(state.__seed) : Math.random;
  }

  random() { return this.rng(); }
  choice(arr) { return arr[Math.floor(this.rng() * arr.length)]; }
  token(n) { let s = ''; for (let i = 0; i < n * 2; i++) s += '0123456789abcdef'[Math.floor(this.rng() * 16)]; return s; }

  shell(host, user) {
    const h = this.c.hosts[host];
    const sh = makeHostShell(this.world, h, user, { login: true });
    sh.interactive = false;
    return sh;
  }

  run(host, script, { user = 'root', input, env = {} } = {}) {
    const sh = this.shell(host, user);
    for (const [k, v] of Object.entries(env)) { sh.vars.set(k, v); sh.exported.add(k); }
    const io = new IO(input ?? null);
    const rc = runSync(this.c, sh.run(script, io));
    return new Res(rc, io.o, io.e);
  }

  // ------------------------------------------------------------------ kubectl (admin na cp)
  kubectl(...args) {
    let opts = {};
    if (args.length && typeof args[args.length - 1] === 'object' && !Array.isArray(args[args.length - 1])) opts = args.pop();
    const cmd = ['kubectl', '--kubeconfig', '/etc/kubernetes/admin.conf', ...args].map(shQuote).join(' ');
    return this.run(this.cfg.cp, cmd, { input: opts.input });
  }

  k(...args) {
    const r = this.kubectl(...args);
    if (!r.ok) throw new SetupError(`kubectl ${args.filter((a) => typeof a === 'string').join(' ')}: ${r.err.trim() || r.out.trim()}`);
    return r.out;
  }

  res(kind) { return this.c.registry.resolve(kind); }

  get(kind, name, ns = null) {
    const r = this.res(kind);
    if (!r || !name) return null;
    const o = this.c.peek(r, r.namespaced ? ns || 'default' : null, name);
    return o ? clean(clone(o)) : null;
  }

  list(kind, ns = null, selector = null, allNs = false) {
    const r = this.res(kind);
    if (!r) return [];
    let items = this.c.all(r, r.namespaced && !allNs ? ns || 'default' : null);
    if (selector) { const reqs = parseSelector(selector); items = items.filter((o) => matchReqs(reqs, o.metadata.labels || {})); }
    return items.map((o) => clean(clone(o)));
  }

  exists(kind, name, ns) { return this.get(kind, name, ns) !== null; }

  apply(manifest) {
    const text = JSON.stringify(Array.isArray(manifest) ? { apiVersion: 'v1', kind: 'List', items: manifest } : manifest);
    return this.k('apply', '-f', '-', { input: text });
  }

  delete(kind, name, ns = null, wait = false) {
    const args = ['delete', kind, name, '--ignore-not-found', `--wait=${wait ? 'true' : 'false'}`];
    if (ns) args.push('-n', ns);
    return this.kubectl(...args);
  }

  fresh_ns(ns, labels = null) {
    if (this.exists('namespace', ns)) this.kubectl('delete', 'namespace', ns, '--wait=true', '--timeout=180s');
    this.wait_until(() => !this.exists('namespace', ns), 120, 2);
    this.apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels: labels || {} } });
  }

  wait(...args) {
    let timeout = 180;
    if (typeof args[args.length - 1] === 'object') timeout = args.pop().timeout ?? 180;
    return this.kubectl('wait', ...args, `--timeout=${timeout}s`).ok;
  }

  rollout(target, ns, timeout = 180) { return this.kubectl('rollout', 'status', target, '-n', ns, `--timeout=${timeout}s`).ok; }
  api_ok() { return this.c.apiAvailable(); }

  can_i(verb, resource, ns, who, groups = []) {
    const args = ['auth', 'can-i', verb, resource, `--as=${who}`, ...groups.map((g) => `--as-group=${g}`)];
    if (ns) args.push('-n', ns);
    return this.kubectl(...args).out.trim().toLowerCase().startsWith('yes');
  }

  nodes() { return Object.fromEntries(this.list('nodes').map((n) => [n.metadata.name, n])); }
  node_is_ready(name) { const n = this.get('node', name); return !!n && (n.status?.conditions || []).some((x) => x.type === 'Ready' && x.status === 'True'); }
  svc_ip(name, ns) { return this.get('service', name, ns)?.spec?.clusterIP; }
  pods(ns, selector) { return this.list('pods', ns, selector); }
  ready_pods(ns, selector) { return this.pods(ns, selector).filter((p) => podReady(p) && !p.metadata.deletionTimestamp); }

  endpoints_ready(svc, ns) {
    let n = 0;
    for (const es of this.list('endpointslices', ns, `kubernetes.io/service-name=${svc}`)) for (const ep of es.endpoints || []) if (ep.conditions?.ready !== false) n += (ep.addresses || []).length;
    return n;
  }

  logs(target, ns, container = null, tail = null) {
    const args = ['logs', target, '-n', ns];
    if (container) args.push('-c', container);
    if (tail) args.push(`--tail=${tail}`);
    return this.kubectl(...args);
  }

  exec(ns, pod, cmd, container = null) {
    const args = ['exec', '-n', ns, pod];
    if (container) args.push('-c', container);
    args.push('--', 'sh', '-c', cmd);
    return this.kubectl(...args);
  }

  // ------------------------------------------------------------------ SSH
  ssh(host, script, sudo = false) { return this.run(host, script, { user: sudo ? 'root' : this.cfg.vm_user }); }

  sh(host, script, sudo = true) {
    const r = this.ssh(host, `set -e\n${script}`, sudo);
    if (!r.ok) throw new SetupError(`[${host}] skrypt nie powiódł się (rc=${r.rc}): ${r.text.slice(-600)}`);
    return r.out;
  }

  read(host, path, sudo = true) {
    const r = this.ssh(host, `cat ${shQuote(path)}`, sudo);
    return r.ok ? r.out : null;
  }

  put(host, path, content, mode = '0644', owner = null, sudo = true) {
    const d = path.slice(0, path.lastIndexOf('/')) || '/';
    let script = `mkdir -p ${shQuote(d)}\necho ${b64enc(content)} | base64 -d > ${shQuote(path)}\nchmod ${mode} ${shQuote(path)}\n`;
    if (owner) script += `chown ${owner} ${shQuote(path)}\n`;
    this.sh(host, script, sudo);
  }

  workdir(host, path) {
    const u = this.cfg.vm_user;
    this.sh(host, `rm -rf ${shQuote(path)} && mkdir -p ${shQuote(path)} && chown ${u}:${u} ${shQuote(path)}`);
  }

  // ------------------------------------------------------------------ sondy
  probe(ns, labels, tests, image = 'busybox:1.36') {
    const name = `cka-probe-${hex(3)}`;
    const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: ns, labels: { ...(labels || {}), 'cka-lab/probe': 'true' } }, spec: { terminationGracePeriodSeconds: 0, restartPolicy: 'Never', containers: [{ name: 'probe', image, command: ['sh', '-c', 'sleep 900'] }] } };
    try { this.apply(pod); } catch (e) { return tests.map(() => [false, new Res(1, '', String(e.message))]); }
    try {
      if (!this.wait(`pod/${name}`, '-n', ns, '--for=condition=Ready', { timeout: 120 })) return tests.map(() => [false, new Res(1, '', 'pod testowy nie wystartował')]);
      this.c.advance(3000, 1000);
      const out = [];
      for (const [cmd, want] of tests) {
        const attempts = want ? 3 : 2;
        let met = false, last = null;
        for (let i = 0; i < attempts; i++) {
          last = this.exec(ns, name, cmd);
          if (last.ok === want) { met = true; break; }
          this.c.advance(2000, 1000);
        }
        out.push([met, last]);
      }
      return out;
    } finally {
      this.kubectl('delete', 'pod', name, '-n', ns, '--grace-period=0', '--force', '--wait=false');
    }
  }

  // ------------------------------------------------------------------ HTTP z hosta base
  http(url, hostHeader = null, headers = null) {
    const hdrs = { ...(headers || {}) };
    if (hostHeader) hdrs.Host = hostHeader;
    const r = httpRequest(this.c, { host: this.c.hosts.base }, url, { headers: hdrs });
    if (r.error) return [0, String(r.error)];
    return [r.status, r.body || ''];
  }

  http_retry(url, want, hostHeader = null, headers = null, tries = 6, delay = 3) {
    let st = 0, body = '';
    for (let i = 0; i < tries; i++) {
      [st, body] = this.http(url, hostHeader, headers);
      if (body.includes(want)) return [true, st, body];
      this.c.advance(delay * 1000, 1000);
    }
    return [false, st, body];
  }

  wait_until(fn, timeout = 60, interval = 3) {
    const end = this.c.now() + timeout * 1000;
    while (true) {
      try { if (fn()) return true; } catch { /* */ }
      if (this.c.now() >= end) return false;
      this.c.advance(interval * 1000, 1000);
    }
  }
}

// ------------------------------------------------------------------ ocenianie
export class Grader {
  constructor() { this.items = []; }
  ok(desc, cond, detail = '', points = 1) {
    const passed = !!cond && !(Array.isArray(cond) && !cond.length);
    this.items.push({ desc, passed, detail: passed ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)) || '', points });
    return passed;
  }
  get total() { return this.items.reduce((a, i) => a + i.points, 0); }
  get earned() { return this.items.filter((i) => i.passed).reduce((a, i) => a + i.points, 0); }
  get fraction() { return this.total ? this.earned / this.total : 0; }
}

// ------------------------------------------------------------------ pomocnicze (jak ckalib.util)
export function jp(obj, path, dflt = null) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return dflt;
    if (Array.isArray(cur)) { const i = Number(part); cur = Number.isInteger(i) ? cur[i] : undefined; } else if (typeof cur === 'object') cur = cur[part];
    else return dflt;
  }
  return cur === null || cur === undefined ? dflt : cur;
}
export function podSpec(o) {
  if (!o) return {};
  if (o.kind === 'Pod') return o.spec || {};
  if (o.kind === 'CronJob') return jp(o, 'spec.jobTemplate.spec.template.spec', {});
  return jp(o, 'spec.template.spec', {});
}
export const containers = (o, init = false) => podSpec(o)[init ? 'initContainers' : 'containers'] || [];
export function cont(o, name = null, init = false) { const cs = containers(o, init); if (name === null) return cs[0] || {}; return cs.find((c) => c.name === name) || {}; }
export function envVar(ct, name) { return (ct.env || []).find((e) => e.name === name) || {}; }
export function condition(o, t) { return (jp(o, 'status.conditions', []) || []).find((c) => c.type === t)?.status ?? null; }
export const nodeReady = (n) => condition(n, 'Ready') === 'True';
export const podReady = (p) => jp(p, 'status.phase') === 'Running' && condition(p, 'Ready') === 'True';
export const readyReplicas = (o) => Number(jp(o, 'status.readyReplicas', 0) || 0);
const UNITS = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, m: 1e-3 };
export function qty(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  for (const u of Object.keys(UNITS).sort((a, b) => b.length - a.length)) if (s.endsWith(u)) { const n = Number(s.slice(0, -u.length)); return Number.isNaN(n) ? null : n * UNITS[u]; }
  const n = Number(s);
  return s === '' || Number.isNaN(n) ? null : n;
}
export function qeq(a, b) { const x = qty(a), y = qty(b); return x !== null && y !== null && Math.abs(x - y) < 1e-9 * Math.max(1, Math.abs(y)); }
export function goDuration(s) {
  if (s === null || s === undefined) return null;
  let total = 0, found = false;
  for (const m of String(s).matchAll(/([0-9.]+)(h|ms|m|s)/g)) { found = true; total += Number(m[1]) * { h: 3600, m: 60, s: 1, ms: 0.001 }[m[2]]; }
  return found ? total : null;
}
export function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }
export function vkey(v) { return (String(v || '').match(/\d+/g) || []).map(Number); }
export function vcmp(a, b) { const x = vkey(a), y = vkey(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; }
export const deq = (a, b) => JSON.stringify(sortObj(a)) === JSON.stringify(sortObj(b));
function sortObj(o) { if (Array.isArray(o)) return o.map(sortObj); if (!o || typeof o !== 'object') return o; return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortObj(o[k])])); }

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
