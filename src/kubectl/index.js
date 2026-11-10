// kubectl - główny punkt wejścia i polecenia odczytu/diagnostyki.
import { parseArgs, FlagError } from './flags.js';
import { connect, KubeError, resolveContext, readKubeconfig, makeToken } from './context.js';
import { fail, KErr, clean, apiMsg, parseResourceArgs, resolveType, render, parseOutput, readManifestSources, toYaml, qualifiedName, refName } from './common.js';
import { describe } from './describe.js';
import { tableText, kindPrefix, podStatus } from './printers.js';
import { ApiError } from '../sim/cluster.js';
import { authorize, rulesFor } from '../sim/rbac.js';
import { execShell, podMetrics } from '../sim/kubelet.js';
import { explainType, explainSchema, KIND_TYPE } from '../sim/schema.js';
import { dump } from '../lib/yaml.js';
import { jsonpath } from '../lib/jsonpath.js';
import { parseDuration, b64enc, b64dec, matchLabelSelector, clone, parseQty, shQuote, humanDuration, age } from '../lib/util.js';
import { CREATE_CMDS } from './create.js';
import { APPLY_CMDS } from './apply.js';

const KUSTOMIZE_VERSION = 'v5.7.1';

export function* kubectl(argv, io, sh) {
  const c = sh.ctx?.cluster;
  let p;
  try { p = parseArgs(argv); } catch (e) {
    if (e instanceof FlagError) {
      const cmd = argv.find((a) => !a.startsWith('-')) || '';
      io.eline(`error: ${e.message}\nSee 'kubectl ${cmd ? cmd + ' ' : ''}--help' for usage.`);
      return 1;
    }
    throw e;
  }
  const x = { c, sh, io, f: p.flags, pos: p.pos, dash: p.dash, dashSeen: p.dashSeen, cmd: p.cmd, allNs: !!p.flags['all-namespaces'] };
  x.api = () => {
    if (x.conn) return x.conn;
    x.conn = connect(sh, p.flags, c);
    x.user = x.conn.user;
    x.ns = x.conn.namespace;
    return x.conn;
  };
  x.nsLocal = () => { try { return resolveContext(sh, p.flags).namespace; } catch { return p.flags.namespace || 'default'; } };
  x.manifests = sh.ctx?.manifests;
  x.kustomizeDocs = (xx, d) => APPLY_CMDS.__kustomizeDocs(xx, d);
  if (!p.cmd || p.flags.help) {
    io.line(HELP[p.cmd] || HELP._);
    return 0;
  }
  const fn = COMMANDS[p.cmd];
  if (!fn) {
    io.eline(`error: unknown command "${p.cmd}" for "kubectl"${SUGGEST[p.cmd] ? `\n\nDid you mean this?\n\t${SUGGEST[p.cmd]}\n` : ''}`);
    return 1;
  }
  try {
    const r = yield* fn(x);
    return r ?? 0;
  } catch (e) {
    if (e instanceof KErr || e instanceof KubeError) { if (e.message) io.eline(e.message); return e.code ?? 1; }
    if (e instanceof ApiError) { io.eline(e.kubectlMessage()); return 1; }
    throw e;
  }
}

const SUGGEST = { gt: 'get', desc: 'describe', creat: 'create', aply: 'apply', delte: 'delete', logs2: 'logs', ececute: 'exec', lable: 'label' };

// ------------------------------------------------------------------ pomocnicze
export function nsOf(x, r) { return r.namespaced ? (x.allNs ? null : x.ns) : null; }
const withNs = (x, r, msg) => (r.namespaced && !x.allNs ? `${msg} in ${x.ns} namespace.` : `${msg}`);

function fetchGroups(x, groups, { selector, fieldSelector, ignoreNotFound } = {}) {
  const out = [];
  let errors = 0;
  for (const g of groups) {
    const items = [];
    if (g.names.length) {
      for (const n of g.names) {
        try { items.push(x.c.get(g.r, x.ns, n, { user: x.user })); } catch (e) {
          if (e instanceof ApiError && e.code === 404 && ignoreNotFound) continue;
          if (e instanceof ApiError && e.reason === 'Forbidden') throw e;
          x.io.eline(apiMsg(e)); errors++;
        }
      }
    } else {
      try { items.push(...x.c.list(g.r, nsOf(x, g.r), { labelSelector: selector, fieldSelector, user: x.user })); } catch (e) {
        if (e instanceof ApiError && e.reason === 'Forbidden') throw e;
        if (e instanceof Error && /unable to parse requirement/.test(e.message)) fail(`error: ${e.message}`);
        throw e;
      }
    }
    out.push({ r: g.r, items, all: g.all, named: g.names.length > 0 });
  }
  return { out, errors };
}

function sortItems(items, sortBy) {
  if (!sortBy) return items;
  let path = sortBy.trim();
  if (!path.startsWith('{')) path = `{${path.startsWith('.') ? path : '.' + path}}`;
  const val = (o) => { try { return jsonpath(path, clean(o)); } catch { return ''; } };
  return [...items].sort((a, b) => {
    const va = val(a), vb = val(b);
    const na = parseQty(va), nb = parseQty(vb);
    if (na !== null && nb !== null && va !== '' && vb !== '' && !/^\d{4}-/.test(va)) return na - nb;
    return va < vb ? -1 : va > vb ? 1 : 0;
  });
}

function* sleep(ms) { yield { type: 'sleep', ms }; }

export function rtForPod(c, pod) {
  return c.runtime[pod.metadata.uid] || Object.values(c.runtime).find((r) => r.static && r.ns === pod.metadata.namespace && r.name === pod.metadata.name) || null;
}

function kubeletReachable(x, pod) {
  const h = x.c.hosts[pod.spec.nodeName];
  if (!h || h.unit('kubelet').state !== 'active') {
    const ip = h?.ip || '0.0.0.0';
    fail(`Error from server: Get "https://${ip}:10250/containerLogs/${pod.metadata.namespace}/${pod.metadata.name}": dial tcp ${ip}:10250: connect: connection refused`);
  }
}

// ------------------------------------------------------------------ get
function* cmdGet(x) {
  const f = x.f;
  const out = parseOutput(f.output);
  if (f.raw) {
    x.api();
    if (f.raw === '/healthz' || f.raw === '/livez' || f.raw === '/readyz') { x.io.out('ok'); return 0; }
    if (f.raw.startsWith('/healthz') || f.raw.startsWith('/livez') || f.raw.startsWith('/readyz')) { x.io.line('[+]ping ok\n[+]log ok\n[+]etcd ok\nlivez check passed'); return 0; }
    if (f.raw === '/version') { x.io.line(JSON.stringify(versionInfo(x.c), null, 2)); return 0; }
    fail(`Error from server (NotFound): the server could not find the requested resource`);
  }
  let groups;
  if (f.filename?.length || f.kustomize) {
    x.api();
    const docs = f.kustomize ? (yield* kustomizeDocs(x, f.kustomize)) : readManifestSources(x, f.filename, { recursive: f.recursive });
    groups = [];
    for (const d of docs) {
      const r = x.c.registry.byKind(d.obj.apiVersion, d.obj.kind) || x.c.registry.byKindAnyVersion(d.obj.apiVersion, d.obj.kind);
      if (!r) fail(`error: resource mapping not found for name: "${d.obj.metadata?.name}" namespace: "" from "${d.source}": no matches for kind "${d.obj.kind}" in version "${d.obj.apiVersion}"\nensure CRDs are installed first`);
      const ns = d.obj.metadata?.namespace || x.ns;
      const g = groups.find((y) => y.r === r && y.ns === ns);
      if (g) g.names.push(d.obj.metadata.name); else groups.push({ r, names: [d.obj.metadata.name], ns });
    }
  } else {
    if (!x.pos.length) fail('You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.\n\nerror: Required resource not specified.\nUse "kubectl explain <resource>" for a detailed description of that resource (e.g. kubectl explain pods).\nSee \'kubectl get -h\' for help and examples');
    x.api();
    groups = parseResourceArgs(x.c, x.pos);
  }
  if (groups.some((g) => g.names.length) && x.allNs && !f.filename) fail('error: a resource cannot be retrieved by name across all namespaces');
  for (const g of groups) if (g.r.kind === 'Endpoints') x.io.eline('Warning: v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice');
  const fetch = () => {
    const res = [];
    let errs = 0;
    for (const g of groups) {
      const save = x.ns;
      if (g.ns) x.ns = g.ns;
      const { out: o, errors } = fetchGroups(x, [g], { selector: f.selector, fieldSelector: f['field-selector'], ignoreNotFound: f['ignore-not-found'] });
      x.ns = save;
      errs += errors;
      for (const gg of o) res.push({ ...gg, items: sortItems(gg.items, f['sort-by']) });
    }
    return { res, errs };
  };
  const { res, errs } = fetch();
  const single = groups.length === 1 && groups[0].names.length === 1;
  const total = res.reduce((a, g) => a + g.items.length, 0);
  if (!total && !errs && !groups.some((g) => g.names.length)) {
    if (out.kind === 'table' || out.kind === 'name') {
      const r0 = groups[0].r;
      if (!f.watch) { x.io.eline(r0.namespaced && !x.allNs ? `No resources found in ${x.ns} namespace.` : 'No resources found'); return 0; }
    }
  }
  if (out.kind === 'table' && res.some((g) => g.all) && !total && !errs) { x.io.eline(`No resources found in ${x.ns} namespace.`); return 0; }
  const text = render(x, res.filter((g) => g.items.length || out.kind !== 'table'), out, { single, flags: f });
  x.io.out(text);
  if (f.watch && out.kind === 'table') {
    // tryb obserwacji: wypisuj zmienione wiersze
    let prev = new Map(res.flatMap((g) => g.items.map((o) => [o.metadata.uid, JSON.stringify(rowOf(x, g.r, o, out, f))])));
    while (true) {
      yield* sleep(1000);
      let cur;
      try { cur = fetch().res; } catch (e) { x.io.eline(apiMsg(e)); return 1; }
      for (const g of cur) {
        for (const o of g.items) {
          const row = rowOf(x, g.r, o, out, f);
          const key = o.metadata.uid;
          const s = JSON.stringify(row);
          if (prev.get(key) !== s) { x.io.out(row); prev.set(key, s); }
        }
      }
    }
  }
  return errs ? 1 : 0;
}

function rowOf(x, r, o, out, f) {
  return render(x, [{ r, items: [o] }], out, { flags: { ...f, 'no-headers': true } });
}

export function versionInfo(c) {
  const cp = Object.values(c.hosts).find((h) => h.role === 'control-plane');
  const man = cp?.fs.tryRead('/etc/kubernetes/manifests/kube-apiserver.yaml') || '';
  const m = man.match(/kube-apiserver:(v[\d.]+)/);
  const gv = m ? m[1] : c.meta.version;
  return { major: '1', minor: gv.split('.')[1], emulationMajor: '1', emulationMinor: gv.split('.')[1], minCompatibilityMajor: '1', minCompatibilityMinor: String(Number(gv.split('.')[1]) - 1), gitVersion: gv, gitCommit: '3c07f4d8e8a1b2c3d4e5f60718293a4b5c6d7e8f', gitTreeState: 'clean', buildDate: '2026-01-10T12:00:00Z', goVersion: 'go1.25.7', compiler: 'gc', platform: 'linux/amd64' };
}

// ------------------------------------------------------------------ describe
function* cmdDescribe(x) {
  x.api();
  let groups;
  if (x.f.filename?.length) {
    const docs = readManifestSources(x, x.f.filename, { recursive: x.f.recursive });
    groups = docs.map((d) => ({ r: x.c.registry.byKindAnyVersion(d.obj.apiVersion, d.obj.kind), names: [d.obj.metadata.name] }));
  } else {
    if (!x.pos.length) fail('You must specify the type of resource to describe. Use "kubectl api-resources" for a complete list of supported resources.');
    groups = parseResourceArgs(x.c, x.pos, { verb: 'describe' });
  }
  const outs = [];
  let errs = 0;
  for (const g of groups) {
    let items;
    if (g.names.length) {
      items = [];
      for (const n of g.names) {
        const o = x.c.peek(g.r, x.ns, n);
        x.c.authz(x.user, 'get', g.r, x.ns, n);
        if (o) { items.push(o); continue; }
        // describe dopasowuje też prefiks nazwy
        const pre = x.c.all(g.r, g.r.namespaced ? x.ns : null).filter((y) => y.metadata.name.startsWith(n));
        if (pre.length) items.push(...pre);
        else { x.io.eline(`Error from server (NotFound): ${qualifiedName(g.r)} "${n}" not found`); errs++; }
      }
    } else items = x.c.list(g.r, nsOf(x, g.r), { labelSelector: x.f.selector, user: x.user });
    for (const o of items) outs.push(describe(x.c, g.r, o));
  }
  if (!outs.length && !errs) { x.io.eline(withNs(x, groups[0].r, 'No resources found')); return 0; }
  x.io.out(outs.join('\n\n'));
  return errs ? 1 : 0;
}

// ------------------------------------------------------------------ delete
function* cmdDelete(x) {
  x.api();
  const f = x.f;
  let targets = [];
  const dry = f['dry-run'] && f['dry-run'] !== 'none';
  if (f.filename?.length || f.kustomize) {
    const docs = f.kustomize ? (yield* kustomizeDocs(x, f.kustomize)) : readManifestSources(x, f.filename, { recursive: f.recursive });
    for (const d of docs) {
      const r = x.c.registry.byKindAnyVersion(d.obj.apiVersion, d.obj.kind);
      if (!r) { x.io.eline(`error: resource mapping not found for name: "${d.obj.metadata?.name}" namespace: "" from "${d.source}": no matches for kind "${d.obj.kind}" in version "${d.obj.apiVersion}"`); continue; }
      targets.push({ r, ns: r.namespaced ? d.obj.metadata.namespace || x.ns : null, name: d.obj.metadata.name });
    }
  } else {
    if (!x.pos.length) fail('error: You must provide one or more resources by argument or filename.\nExample resource specifications include:\n   \'-f rsrc.yaml\'\n   \'--filename=rsrc.json\'\n   \'<resource> <name>\'\n   \'<resource>\'');
    const groups = parseResourceArgs(x.c, x.pos, { verb: 'delete' });
    for (const g of groups) {
      if (g.names.length) for (const n of g.names) targets.push({ r: g.r, ns: g.r.namespaced ? x.ns : null, name: n });
      else if (f.all || f.selector || f['field-selector']) for (const o of x.c.list(g.r, nsOf(x, g.r), { labelSelector: f.selector, fieldSelector: f['field-selector'], user: x.user })) targets.push({ r: g.r, ns: o.metadata.namespace, name: o.metadata.name });
      else fail('error: resource(s) were provided, but no name was specified');
    }
    if (!targets.length) { x.io.eline(groups[0].r.namespaced ? `No resources found` : 'No resources found'); return 0; }
  }
  let grace;
  if (f['grace-period'] !== undefined) grace = Number(f['grace-period']);
  if (f.now) grace = 1;
  const force = !!f.force;
  if (force && grace === 0) x.io.eline('Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.');
  else if (force && grace === undefined) { grace = 0; x.io.eline('Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.'); }
  const propagation = f.cascade === 'orphan' || f.cascade === 'false' ? 'Orphan' : f.cascade === 'foreground' ? 'Foreground' : 'Background';
  let st = 0;
  const waitFor = [];
  for (const t of targets) {
    try {
      x.c.delete(t.r, t.ns, t.name, { user: x.user, gracePeriod: grace, propagation, dryRun: dry });
      const where = t.r.namespaced ? ` from ${t.ns} namespace` : '';
      x.io.line(`${kindPrefix(t.r)} "${t.name}" ${force && grace === 0 ? 'force deleted' : 'deleted'}${where}${dry ? ' (dry run)' : ''}`);
      if (!dry) waitFor.push(t);
    } catch (e) {
      if (e instanceof ApiError && e.code === 404 && f['ignore-not-found']) continue;
      x.io.eline(apiMsg(e));
      st = 1;
    }
  }
  // kubectl delete czeka domyślnie na usunięcie obiektów (--wait=true)
  if (f.wait !== 'false') {
    const deadline = x.c.now() + (f.timeout ? parseDuration(f.timeout) * 1000 : 3600e3);
    while (waitFor.some((t) => x.c.peek(t.r, t.ns, t.name)) && x.c.now() < deadline) yield* sleep(500);
  }
  return st;
}

// ------------------------------------------------------------------ logs
function pickContainer(x, pod, name, { quiet = false } = {}) {
  const all = [...(pod.spec.containers || []), ...(pod.spec.initContainers || [])];
  if (name) {
    if (!all.some((c) => c.name === name)) fail(`error: container ${name} is not valid for pod ${pod.metadata.name}`);
    return name;
  }
  const def = pod.metadata.annotations?.['kubectl.kubernetes.io/default-container'];
  const first = def || pod.spec.containers[0].name;
  if (all.length > 1 && !quiet) {
    x.io.eline(`Defaulted container "${first}" out of: ${[...pod.spec.containers.map((c) => c.name), ...(pod.spec.initContainers || []).map((c) => `${c.name} (init)`)].join(', ')}`);
  }
  return first;
}

export function resolvePodTarget(x, target, { verb = 'logs' } = {}) {
  if (!target) fail(`error: expected 'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]'.\nPOD or TYPE/NAME is a required argument for the logs command\nSee 'kubectl logs -h' for help and examples`);
  if (!target.includes('/') || /^(po|pod|pods)\//.test(target)) {
    const name = target.replace(/^(po|pod|pods)\//, '');
    return x.c.get('pods', x.ns, name, { user: x.user });
  }
  const [t, n] = target.split('/');
  const r = resolveType(x.c, t);
  const o = x.c.get(r, x.ns, n, { user: x.user });
  let sel = o.spec?.selector;
  if (r.kind === 'Service') sel = { matchLabels: o.spec.selector || {} };
  if (r.kind === 'CronJob') fail(`error: cannot get the logs from ${kindPrefix(r)}: selector for *v1.CronJob not implemented`);
  if (!sel) fail(`error: cannot get the logs from ${kindPrefix(r)}: selector for ${r.kind} not implemented`);
  const pods = x.c.all('pods', x.ns).filter((p) => matchLabelSelector(sel.matchLabels ? sel : { matchLabels: sel }, p.metadata.labels)).sort((a, b) => { const sc = (p) => (p.metadata.deletionTimestamp ? 2 : 0) + (p.status?.phase === 'Running' ? 0 : 1); return sc(a) - sc(b) || a.metadata.name.localeCompare(b.metadata.name); });
  if (!pods.length) fail(`error: timed out waiting for the condition`);
  if (pods.length > 1 && verb === 'logs') x.io.eline(`Found ${pods.length} pods, using pod/${pods[0].metadata.name}`);
  return clone(pods[0]);
}

function logLines(x, pod, cname, { previous, timestamps, since, tail, sinceTime }) {
  const rt = rtForPod(x.c, pod);
  const cs = [...(pod.status?.containerStatuses || []), ...(pod.status?.initContainerStatuses || [])].find((s) => s.name === cname);
  if (!rt || !cs) fail(`Error from server (BadRequest): container "${cname}" in pod "${pod.metadata.name}" is waiting to start: ContainerCreating`);
  const crt = [...rt.main, ...rt.init].find((y) => y.name === cname);
  if (previous) {
    if (!crt.restarts || !crt.everStarted || !(crt.prevLogs || []).length && crt.state === 'running') {
      if (!crt.restarts) fail(`Error from server (BadRequest): previous terminated container "${cname}" in pod "${pod.metadata.name}" not found`);
    }
  } else if (!crt.everStarted) {
    const w = cs.state?.waiting?.reason || 'ContainerCreating';
    const msg = ['ImagePullBackOff', 'ErrImagePull', 'InvalidImageName'].includes(w) ? 'trying and failing to pull image' : w;
    fail(`Error from server (BadRequest): container "${cname}" in pod "${pod.metadata.name}" is waiting to start: ${msg}`);
  }
  let logs = previous ? (crt.state === 'running' ? crt.prevLogs : crt.prevLogs?.length ? crt.prevLogs : crt.logs) : crt.logs;
  logs = [...(logs || [])];
  if (!previous && crt.partial) logs.push([x.c.now(), crt.partial]);
  if (since) { const cut = x.c.now() - parseDuration(since) * 1000; logs = logs.filter(([t]) => t >= cut); }
  if (sinceTime) { const cut = Date.parse(sinceTime); logs = logs.filter(([t]) => t >= cut); }
  if (tail !== undefined && Number(tail) >= 0) logs = logs.slice(Math.max(0, logs.length - Number(tail)));
  return { crt, lines: logs.map(([t, l]) => (timestamps ? `${new Date(t).toISOString().replace('Z', '').padEnd(23, '0')}000000Z ${l}` : l)) };
}

function* cmdLogs(x) {
  x.api();
  const f = x.f;
  let pods;
  if (f.selector) {
    pods = x.c.list('pods', x.ns, { labelSelector: f.selector, user: x.user });
    if (!pods.length) { x.io.eline(`No resources found in ${x.ns} namespace.`); return 0; }
  } else pods = [resolvePodTarget(x, x.pos[0])];
  let cname = f.container || x.pos[1];
  for (const pod of pods) {
    if (pod.spec.nodeName) kubeletReachable(x, pod);
    const names = f['all-containers'] ? [...(pod.spec.initContainers || []), ...pod.spec.containers].map((y) => y.name) : [pickContainer(x, pod, cname, { quiet: pods.length > 1 })];
    for (const n of names) {
      let res;
      try { res = logLines(x, pod, n, { previous: f.previous, timestamps: f.timestamps, since: f.since, tail: f.tail ?? (f.selector ? 10 : undefined), sinceTime: f['since-time'] }); } catch (e) {
        if (f['all-containers'] || pods.length > 1) { x.io.eline(e.message); continue; }
        throw e;
      }
      const prefix = f.prefix || (pods.length > 1 && f.prefix !== false && f.prefix) ? `[pod/${pod.metadata.name}/${n}] ` : '';
      for (const l of res.lines) x.io.line(prefix + l);
      if (f.follow && pods.length === 1 && names.length === 1) {
        let seen = res.crt.logs.length;
        let id = res.crt.id;
        while (true) {
          yield* sleep(1000);
          const rt = rtForPod(x.c, pod);
          if (!rt) return 0;
          const crt = [...rt.main, ...rt.init].find((y) => y.name === n);
          if (!crt || crt.id !== id) return 0;
          if (crt.logs.length > seen) { for (const [t, l] of crt.logs.slice(seen)) x.io.line(prefix + (f.timestamps ? `${new Date(t).toISOString()} ` : '') + l); seen = crt.logs.length; }
          if (crt.state !== 'running') return 0;
        }
      }
    }
  }
  return 0;
}

// ------------------------------------------------------------------ exec
function* cmdExec(x) {
  x.api();
  const f = x.f;
  if (!x.pos.length) fail("error: pod, type/name or --filename must be specified");
  if (!x.dashSeen) {
    if (x.pos.length > 1) fail(`error: exec [POD] [COMMAND] is not supported anymore. Use exec [POD] -- [COMMAND] instead\nSee 'kubectl exec -h' for help and examples`);
    fail("error: you must specify at least one command for the container");
  }
  if (!x.dash.length) fail('error: you must specify at least one command for the container');
  const pod = resolvePodTarget(x, x.pos[0], { verb: 'exec' });
  x.c.authz(x.user, 'create', x.c.res('pods'), pod.metadata.namespace, pod.metadata.name, 'exec');
  if (['Succeeded', 'Failed'].includes(pod.status?.phase)) fail(`error: cannot exec into a container in a completed pod; current phase is ${pod.status.phase}`);
  const cname = pickContainer(x, pod, f.container);
  if (pod.spec.nodeName) {
    const h = x.c.hosts[pod.spec.nodeName];
    if (!h || h.unit('kubelet').state !== 'active') fail(`error: unable to upgrade connection: error dialing backend: dial tcp ${h?.ip}:10250: connect: connection refused`);
  }
  const rt = rtForPod(x.c, pod);
  if (!rt) fail(`error: unable to upgrade connection: container not found ("${cname}")`);
  const r = execShell(x.c, rt, cname);
  if (!r.sh) fail(`error: unable to upgrade connection: container not found ("${cname}")`);
  const exe = x.dash[0];
  const base = exe.split('/').pop();
  const known = r.info.bin?.includes(base) || ['echo', 'test', '[', 'true', 'false', 'printf', 'sleep', 'cd', 'export'].includes(base) && r.info.bin?.length;
  if (!known) {
    x.io.eline(`error: Internal error occurred: Internal error occurred: error executing command in container: failed to exec in container: failed to start exec "${'0'.repeat(0)}${hexId()}": OCI runtime exec failed: exec failed: unable to start container process: exec: "${exe}": executable file not found in $PATH: unknown`);
    return 1;
  }
  const isShell = ['sh', 'bash', 'ash', 'dash'].includes(base) && x.dash.length === 1;
  if (isShell && f.stdin && f.tty) {
    r.sh.interactive = true;
    r.sh.vars.set('HOSTNAME', rt.spec.hostNetwork ? rt.node : rt.name);
    r.sh.vars.set('PS1', base === 'bash' ? `root@${rt.spec.hostNetwork ? rt.node : rt.name}:\\w# ` : '\\w # ');
    yield { type: 'subshell', shell: r.sh, kind: 'container' };
    return 0;
  }
  if (isShell && f.stdin && x.io.stdin) {
    const code = yield* runIn(r.sh, x.io.stdin, x.io);
    if (code) { x.io.eline(`command terminated with exit code ${code}`); return code; }
    return 0;
  }
  const code = yield* runIn(r.sh, x.dash.map(shQuote).join(' '), x.io);
  if (code) { x.io.eline(`command terminated with exit code ${code}`); return code; }
  return 0;
}
const hexId = () => Math.floor(Math.random() * 1e16).toString(16).padStart(14, '0');

export function* runIn(sh, script, io) {
  try { return yield* sh.run(script, io); } catch (e) {
    if (e?.constructor?.name === 'ExitSignal') return e.code;
    throw e;
  }
}

// ------------------------------------------------------------------ top
function metricsAvailable(c) {
  const d = c.peek('deployments', 'kube-system', 'metrics-server');
  return d && (d.status?.availableReplicas || 0) > 0;
}
function fmtCpuM(v) { return `${Math.max(0, Math.round(v * 1000))}m`; }
function fmtMiB(v) { return `${Math.round(v / 1048576)}Mi`; }

function* cmdTop(x) {
  x.api();
  const sub = x.pos[0];
  if (!['node', 'nodes', 'no', 'pod', 'pods', 'po'].includes(sub)) { x.io.line('Display resource (CPU/memory) usage.\n\nAvailable Commands:\n  node          Display resource (CPU/memory) usage of nodes\n  pod           Display resource (CPU/memory) usage of pods'); return 0; }
  if (!metricsAvailable(x.c)) fail('error: Metrics API not available');
  const c = x.c;
  if (sub.startsWith('no')) {
    x.c.authz(x.user, 'list', { group: 'metrics.k8s.io', plural: 'nodes', namespaced: false }, null);
    let nodes = c.list('nodes', null, { labelSelector: x.f.selector, user: x.user });
    if (x.pos[1]) nodes = nodes.filter((n) => n.metadata.name === x.pos[1]);
    const rows = [['NAME', 'CPU(cores)', 'CPU(%)', 'MEMORY(bytes)', 'MEMORY(%)']];
    const data = [];
    for (const n of nodes) {
      const ready = (n.status?.conditions || []).find((y) => y.type === 'Ready')?.status === 'True';
      let cpu = n.metadata.name.includes('cp') ? 0.12 : 0.04, mem = (n.metadata.name.includes('cp') ? 900 : 520) * 1048576;
      for (const rt of Object.values(c.runtime)) if (rt.node === n.metadata.name) for (const m of podMetrics(c, rt)) { cpu += m.cpu; mem += m.mem; }
      const capCpu = parseQty(n.status?.capacity?.cpu) || 2, capMem = parseQty(n.status?.capacity?.memory) || 4e9;
      data.push({ n, ready, cpu, mem, row: ready ? [n.metadata.name, fmtCpuM(cpu), `${Math.round((cpu / capCpu) * 100)}%`, fmtMiB(mem), `${Math.round((mem / capMem) * 100)}%`] : [n.metadata.name, '<unknown>', '<unknown>', '<unknown>', '<unknown>'] });
    }
    if (x.f['sort-by'] === 'cpu') data.sort((a, b) => b.cpu - a.cpu);
    if (x.f['sort-by'] === 'memory') data.sort((a, b) => b.mem - a.mem);
    rows.push(...data.map((d) => d.row));
    x.io.out(tableText(rows, x.f['no-headers']));
    return 0;
  }
  let pods = c.list('pods', x.allNs ? null : x.ns, { labelSelector: x.f.selector, user: x.user });
  if (x.pos[1]) { pods = pods.filter((p) => p.metadata.name === x.pos[1]); if (!pods.length) fail(`Error from server (NotFound): pods "${x.pos[1]}" not found`); }
  const data = [];
  for (const p of pods) {
    const rt = rtForPod(c, p);
    if (!rt || p.status?.phase !== 'Running') continue;
    const ms = podMetrics(c, rt);
    if (!ms.length) continue;
    if (x.f.containers) for (const m of ms) data.push({ cpu: m.cpu, mem: m.mem, row: [...(x.allNs ? [p.metadata.namespace] : []), p.metadata.name, m.name, fmtCpuM(m.cpu), fmtMiB(m.mem)] });
    else { const cpu = ms.reduce((a, m) => a + m.cpu, 0), mem = ms.reduce((a, m) => a + m.mem, 0); data.push({ cpu, mem, row: [...(x.allNs ? [p.metadata.namespace] : []), p.metadata.name, fmtCpuM(cpu), fmtMiB(mem)] }); }
  }
  if (!data.length) { x.io.eline(x.pos[1] ? `error: metrics not available yet` : `No resources found in ${x.ns} namespace.`); return x.pos[1] ? 1 : 0; }
  if (x.f['sort-by'] === 'cpu') data.sort((a, b) => b.cpu - a.cpu);
  if (x.f['sort-by'] === 'memory') data.sort((a, b) => b.mem - a.mem);
  const head = [...(x.allNs ? ['NAMESPACE'] : []), ...(x.f.containers ? ['POD', 'NAME'] : ['NAME']), 'CPU(cores)', 'MEMORY(bytes)'];
  x.io.out(tableText([head, ...data.map((d) => d.row)], x.f['no-headers']));
  return 0;
}

// ------------------------------------------------------------------ auth
function* cmdAuth(x) {
  const sub = x.pos[0];
  if (sub === 'whoami') {
    x.api();
    if (x.f.output === 'yaml' || x.f.output === 'json') {
      const o = { kind: 'SelfSubjectReview', apiVersion: 'authentication.k8s.io/v1', metadata: { creationTimestamp: null }, status: { userInfo: { username: x.user.name, groups: x.user.groups } } };
      x.io.out(x.f.output === 'yaml' ? dump(o) : JSON.stringify(o, null, 4) + '\n');
      return 0;
    }
    const rows = [['ATTRIBUTE', 'VALUE'], ['Username', x.user.name], ['Groups', `[${x.user.groups.join(' ')}]`]];
    x.io.out(tableText(rows));
    return 0;
  }
  if (sub === 'can-i') {
    x.api();
    if (x.f.list) {
      const rules = (x.user.groups || []).includes('system:masters') ? [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }] : rulesFor(x.c, x.user, x.ns);
      const rows = [['Resources', 'Non-Resource URLs', 'Resource Names', 'Verbs']];
      const merged = new Map();
      for (const r of rules) {
        if (r.nonResourceURLs) { rows.push(['', `[${r.nonResourceURLs.join(' ')}]`, '[]', `[${r.verbs.join(' ')}]`]); continue; }
        for (const res of r.resources || []) for (const g of r.apiGroups || ['']) {
          const k = `${g ? `${res}.${g}` : res}|${(r.resourceNames || []).join(' ')}`;
          merged.set(k, [...new Set([...(merged.get(k) || []), ...r.verbs])]);
        }
      }
      for (const [k, v] of [...merged.entries()].sort()) { const [res, names] = k.split('|'); rows.push([res, '[]', `[${names}]`, `[${v.join(' ')}]`]); }
      x.io.out(tableText(rows));
      return 0;
    }
    const verb = x.pos[1];
    let target = x.pos[2];
    if (!verb || !target) fail("error: you must specify two arguments: verb resource or verb resource/resourceName.\nSee 'kubectl auth can-i -h' for help and examples");
    if (target.startsWith('/')) { x.io.line('yes'); return 0; }
    let name;
    if (target.includes('/')) [target, name] = target.split('/');
    const sub2 = x.f.subresource;
    const r = x.c.registry.resolve(target);
    if (!r) {
      x.io.eline(`Warning: the server doesn't have a resource type '${target}'`);
      x.io.line('no');
      return 1;
    }
    const ok = authorize(x.c, x.user, { verb, group: r.group, resource: r.plural, subresource: sub2, namespace: r.namespaced ? (x.allNs ? '' : x.ns) : '', name });
    if (!r.namespaced && x.f.namespace) x.io.eline(`Warning: resource '${r.plural}' is not namespace scoped${r.group ? ` in group '${r.group}'` : ''}\n`);
    x.io.line(ok ? 'yes' : 'no');
    return ok ? 0 : 1;
  }
  if (sub === 'reconcile') { x.io.line('reconcile: brak zmian'); return 0; }
  x.io.line('Inspect authorization.\n\nAvailable Commands:\n  can-i         Check whether an action is allowed\n  reconcile     Reconciles rules for RBAC role, role binding, cluster role, and cluster role binding objects\n  whoami        Experimental: Check self subject attributes');
  return 0;
}

// ------------------------------------------------------------------ config
function* cmdConfig(x) {
  const sub = x.pos[0];
  const sh = x.sh;
  const { path, cfg, missing } = readKubeconfig(sh, x.f, { create: ['set-cluster', 'set-credentials', 'set-context', 'set', 'use-context'].includes(sub) });
  const save = () => { try { sh.fs.write(path, dump(cfg, { sort: false }), { user: sh.user, mode: 0o600 }); } catch (e) { fail(`error: open ${path}: permission denied`); } };
  const contexts = cfg.contexts || [];
  switch (sub) {
    case 'view': {
      let view = clone(cfg);
      if (x.f.minify) {
        const cur = view['current-context'];
        if (!cur) fail('error: current-context must exist in order to minify');
        const ctx = view.contexts.find((y) => y.name === cur);
        view.contexts = [ctx];
        view.clusters = view.clusters.filter((y) => y.name === ctx.context.cluster);
        view.users = view.users.filter((y) => y.name === ctx.context.user);
      }
      if (!x.f.raw) {
        for (const cl of view.clusters || []) if (cl.cluster?.['certificate-authority-data']) cl.cluster['certificate-authority-data'] = 'DATA+OMITTED';
        for (const u of view.users || []) {
          if (u.user?.['client-certificate-data']) u.user['client-certificate-data'] = 'DATA+OMITTED';
          if (u.user?.['client-key-data']) u.user['client-key-data'] = 'DATA+OMITTED';
          if (u.user?.token) u.user.token = 'REDACTED';
        }
      }
      view = { apiVersion: view.apiVersion || 'v1', clusters: view.clusters || null, contexts: view.contexts || null, 'current-context': view['current-context'] || '', kind: 'Config', preferences: view.preferences || {}, users: view.users || null };
      if (x.f.output) { x.io.out(render(x, [{ r: { kind: 'Config' }, items: [view] }], parseOutput(x.f.output), { single: true })); return 0; }
      x.io.out(dump(view, { sort: false }));
      return 0;
    }
    case 'get-contexts': {
      const rows = [['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE']];
      const sel = x.pos[1];
      for (const ctx of contexts) {
        if (sel && ctx.name !== sel) continue;
        rows.push([ctx.name === cfg['current-context'] ? '*' : '', ctx.name, ctx.context?.cluster || '', ctx.context?.user || '', ctx.context?.namespace || '']);
      }
      if (sel && rows.length === 1) fail(`error: context ${sel} not found`);
      if (x.f.output === 'name') { for (const r of rows.slice(1)) x.io.line(r[1]); return 0; }
      x.io.out(tableText(rows, x.f['no-headers']));
      return 0;
    }
    case 'current-context':
      if (!cfg['current-context']) fail('error: current-context is not set');
      x.io.line(cfg['current-context']);
      return 0;
    case 'use-context': case 'use': {
      const n = x.pos[1];
      if (!n) fail('error: Unexpected args: []');
      if (!contexts.some((y) => y.name === n)) fail(`error: no context exists with the name: "${n}"`);
      cfg['current-context'] = n;
      save();
      x.io.line(`Switched to context "${n}".`);
      return 0;
    }
    case 'set-context': {
      let n = x.pos[1];
      if (x.f.current) { n = cfg['current-context']; if (!n) fail('error: no current context is set'); }
      if (!n) fail("error: you must specify a non-empty context name or --current\nSee 'kubectl config set-context -h' for help and examples");
      let ctx = contexts.find((y) => y.name === n);
      const created = !ctx;
      if (!ctx) { ctx = { name: n, context: {} }; contexts.push(ctx); cfg.contexts = contexts; }
      if (x.f.namespace !== undefined) ctx.context.namespace = x.f.namespace;
      if (x.f.cluster) ctx.context.cluster = x.f.cluster;
      if (x.f.user) ctx.context.user = x.f.user;
      save();
      x.io.line(`Context "${n}" ${created ? 'created' : 'modified'}.`);
      return 0;
    }
    case 'set-credentials': {
      const n = x.pos[1];
      if (!n) fail('error: you must specify a non-empty user name');
      cfg.users = cfg.users || [];
      let u = cfg.users.find((y) => y.name === n);
      if (!u) { u = { name: n, user: {} }; cfg.users.push(u); }
      const embed = x.f['embed-certs'];
      const readF = (p) => { try { return sh.fs.read(sh.abs(p), sh.user); } catch { fail(`error: could not read client-certificate data from ${p}: open ${p}: no such file or directory`); } return ''; };
      if (x.f['client-certificate']) { if (embed) { u.user['client-certificate-data'] = b64enc(readF(x.f['client-certificate'])); delete u.user['client-certificate']; } else u.user['client-certificate'] = sh.abs(x.f['client-certificate']); }
      if (x.f['client-key']) { if (embed) { u.user['client-key-data'] = b64enc(readF(x.f['client-key'])); delete u.user['client-key']; } else u.user['client-key'] = sh.abs(x.f['client-key']); }
      if (x.f.token) u.user.token = x.f.token;
      if (x.f.username) u.user.username = x.f.username;
      if (x.f.password) u.user.password = x.f.password;
      save();
      x.io.line(`User "${n}" set.`);
      return 0;
    }
    case 'set-cluster': {
      const n = x.pos[1];
      if (!n) fail('error: you must specify a non-empty cluster name');
      cfg.clusters = cfg.clusters || [];
      let cl = cfg.clusters.find((y) => y.name === n);
      if (!cl) { cl = { name: n, cluster: {} }; cfg.clusters.push(cl); }
      if (x.f.server) cl.cluster.server = x.f.server;
      if (x.f['certificate-authority']) {
        if (x.f['embed-certs']) { cl.cluster['certificate-authority-data'] = b64enc(sh.fs.read(sh.abs(x.f['certificate-authority']), sh.user)); delete cl.cluster['certificate-authority']; } else cl.cluster['certificate-authority'] = sh.abs(x.f['certificate-authority']);
      }
      if (x.f['insecure-skip-tls-verify']) cl.cluster['insecure-skip-tls-verify'] = true;
      save();
      x.io.line(`Cluster "${n}" set.`);
      return 0;
    }
    case 'delete-context': {
      const n = x.pos[1];
      if (!contexts.some((y) => y.name === n)) fail(`error: cannot delete context ${n}, not in ${path}`);
      cfg.contexts = contexts.filter((y) => y.name !== n);
      if (cfg['current-context'] === n) x.io.eline('warning: this removed your active context, use "kubectl config use-context" to select a different one');
      save();
      x.io.line(`deleted context ${n} from ${path}`);
      return 0;
    }
    case 'delete-user': { cfg.users = (cfg.users || []).filter((y) => y.name !== x.pos[1]); save(); x.io.line(`deleted user ${x.pos[1]} from ${path}`); return 0; }
    case 'delete-cluster': { cfg.clusters = (cfg.clusters || []).filter((y) => y.name !== x.pos[1]); save(); x.io.line(`deleted cluster ${x.pos[1]} from ${path}`); return 0; }
    case 'rename-context': {
      const [, a, b] = x.pos;
      const ctx = contexts.find((y) => y.name === a);
      if (!ctx) fail(`error: cannot rename the context "${a}", it's not in ${path}`);
      ctx.name = b;
      if (cfg['current-context'] === a) cfg['current-context'] = b;
      save();
      x.io.line(`Context "${a}" renamed to "${b}".`);
      return 0;
    }
    case 'get-clusters': x.io.line('NAME'); for (const cl of cfg.clusters || []) x.io.line(cl.name); return 0;
    case 'get-users': x.io.line('NAME'); for (const u of cfg.users || []) x.io.line(u.name); return 0;
    case 'set': case 'unset': x.io.line(`Property "${x.pos[1]}" ${sub}.`); return 0;
    default:
      void missing;
      x.io.line('Modify kubeconfig files using subcommands like "kubectl config set current-context my-context".\n\nAvailable Commands:\n  current-context   Display the current-context\n  delete-cluster    Delete the specified cluster from the kubeconfig\n  delete-context    Delete the specified context from the kubeconfig\n  delete-user       Delete the specified user from the kubeconfig\n  get-clusters      Display clusters defined in the kubeconfig\n  get-contexts      Describe one or many contexts\n  get-users         Display users defined in the kubeconfig\n  rename-context    Rename a context from the kubeconfig file\n  set               Set an individual value in a kubeconfig file\n  set-cluster       Set a cluster entry in kubeconfig\n  set-context       Set a context entry in kubeconfig\n  set-credentials   Set a user entry in kubeconfig\n  unset             Unset an individual value in a kubeconfig file\n  use-context       Set the current-context in a kubeconfig file\n  view              Display merged kubeconfig settings or a specified kubeconfig file');
      return sub ? 1 : 0;
  }
}

// ------------------------------------------------------------------ api-resources / explain / version
function* cmdApiResources(x) {
  x.api();
  let list = x.c.registry.all().filter((r) => !r.alias && !r.hidden);
  if (x.f.namespaced !== undefined) list = list.filter((r) => String(r.namespaced) === String(x.f.namespaced));
  if (x.f['api-group'] !== undefined) list = list.filter((r) => r.group === x.f['api-group']);
  list.sort((a, b) => (a.group || '').localeCompare(b.group || '') || a.plural.localeCompare(b.plural));
  const core = list.filter((r) => !r.group), rest = list.filter((r) => r.group);
  list = [...core, ...rest];
  if (x.f.output === 'name') { for (const r of list) x.io.line(r.group ? `${r.plural}.${r.group}` : r.plural); return 0; }
  const rows = [['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND', ...(x.f.output === 'wide' ? ['VERBS', 'CATEGORIES'] : [])]];
  for (const r of list) rows.push([r.plural, (r.short || []).join(','), r.group ? `${r.group}/${r.version}` : r.version, String(r.namespaced), r.kind, ...(x.f.output === 'wide' ? ['create,delete,deletecollection,get,list,patch,update,watch', (r.categories || []).join(',')] : [])]);
  x.io.out(tableText(rows, x.f['no-headers']));
  return 0;
}

function* cmdApiVersions(x) {
  x.api();
  const set = new Set(x.c.registry.all().map((r) => (r.group ? `${r.group}/${r.version}` : r.version)));
  for (const v of [...set].sort()) x.io.line(v);
  return 0;
}

function* cmdExplain(x) {
  x.api();
  const arg = x.pos[0];
  if (!arg) fail('You must specify the type of resource to explain. Use "kubectl api-resources" for a complete list of supported resources.\n\nerror: Required resource not specified.');
  const [res, ...path] = arg.split('.');
  let r = x.c.registry.resolve(res);
  if (x.f['api-version']) r = x.c.registry.list.find((y) => y.plural === r?.plural && `${y.group ? y.group + '/' : ''}${y.version}` === x.f['api-version']) || r;
  if (!r) fail(`error: the server doesn't have a resource type "${res}"`);
  let out;
  if (r.crd) {
    const crd = x.c.peek('customresourcedefinitions', null, `${r.plural}.${r.group}`);
    const v = crd?.spec.versions.find((y) => y.name === r.version) || crd?.spec.versions[0];
    out = explainSchema(r.group, r.kind, r.version, v?.schema?.openAPIV3Schema || {}, path, { recursive: x.f.recursive });
  } else {
    const tn = KIND_TYPE[r.kind];
    if (!tn) fail(`error: couldn't find resource for "${r.group ? r.group + '/' : ''}${r.version}, Kind=${r.kind}"`);
    out = explainType(r.group, r.kind, r.version, tn, path, { recursive: x.f.recursive });
  }
  if (out.error) fail(out.error);
  x.io.out(out.text.replace(/\t/g, '\t'));
  return 0;
}

function clientVersion(sh) {
  const pk = sh.ctx?.host?.packages?.kubectl;
  return pk ? `v${pk.split('-')[0]}` : 'v1.37.1';
}

function* cmdVersion(x) {
  const cv = clientVersion(x.sh);
  if (x.f.output === 'yaml' || x.f.output === 'json') {
    const o = { clientVersion: { major: '1', minor: cv.split('.')[1], gitVersion: cv, platform: 'linux/amd64' }, kustomizeVersion: KUSTOMIZE_VERSION };
    if (!x.f.client) { try { x.api(); o.serverVersion = versionInfo(x.c); } catch { /* */ } }
    x.io.out(x.f.output === 'yaml' ? dump(o) : JSON.stringify(o, null, 2) + '\n');
    return 0;
  }
  x.io.line(`Client Version: ${cv}`);
  x.io.line(`Kustomize Version: ${KUSTOMIZE_VERSION}`);
  if (x.f.client) return 0;
  x.api();
  const sv = versionInfo(x.c).gitVersion;
  x.io.line(`Server Version: ${sv}`);
  const cm = Number(cv.split('.')[1]), sm = Number(sv.split('.')[1]);
  if (Math.abs(cm - sm) > 1) x.io.eline(`WARNING: version difference between client (1.${cm}) and server (1.${sm}) exceeds the supported minor version skew of +/-1`);
  return 0;
}

function* cmdClusterInfo(x) {
  const conn = x.api();
  if (x.pos[0] === 'dump') { x.io.line(toYaml({ kind: 'NodeList', items: x.c.all('nodes') })); return 0; }
  x.io.line(`\x1b[0;32mKubernetes control plane\x1b[0m is running at \x1b[0;33mhttps://${conn.server}\x1b[0m`);
  if (x.c.peek('services', 'kube-system', 'kube-dns')) x.io.line(`\x1b[0;32mCoreDNS\x1b[0m is running at \x1b[0;33mhttps://${conn.server}/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy\x1b[0m`);
  x.io.line("\nTo further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.");
  return 0;
}

// ------------------------------------------------------------------ certificate approve/deny
function* cmdCertificate(x) {
  x.api();
  const sub = x.pos[0];
  if (sub !== 'approve' && sub !== 'deny') { x.io.line('Modify certificate resources.\n\nAvailable Commands:\n  approve       Approve a certificate signing request\n  deny          Deny a certificate signing request'); return 0; }
  const names = x.pos.slice(1);
  if (!names.length && !x.f.filename) fail(`error: one or more CSRs must be specified as <name> or -f <filename>`);
  const r = x.c.res('certificatesigningrequests');
  let st = 0;
  for (const n of names) {
    try {
      x.c.authz(x.user, 'update', r, null, n, 'approval');
      const o = x.c.peek(r, null, n);
      if (!o) throw new ApiError(404, 'NotFound', `certificatesigningrequests.certificates.k8s.io "${n}" not found`);
      const conds = o.status?.conditions || [];
      const type = sub === 'approve' ? 'Approved' : 'Denied';
      if (conds.some((y) => y.type === type)) { x.io.line(`certificatesigningrequest.certificates.k8s.io/${n} ${sub === 'approve' ? 'approved' : 'denied'}`); continue; }
      if (conds.some((y) => y.type === (sub === 'approve' ? 'Denied' : 'Approved'))) fail(`error: certificate signing request "${n}" is already ${sub === 'approve' ? 'denied' : 'approved'}`);
      o.status = { ...(o.status || {}), conditions: [...conds, { type, status: 'True', reason: sub === 'approve' ? 'KubectlApprove' : 'KubectlDeny', message: `This CSR was ${sub === 'approve' ? 'approved' : 'denied'} by kubectl certificate ${sub}.`, lastUpdateTime: x.c.iso(), lastTransitionTime: x.c.iso() }] };
      x.c.put(o);
      x.io.line(`certificatesigningrequest.certificates.k8s.io/${n} ${sub === 'approve' ? 'approved' : 'denied'}`);
    } catch (e) { if (e instanceof KErr) throw e; x.io.eline(apiMsg(e)); st = 1; }
  }
  x.c.reconcile();
  return st;
}

// ------------------------------------------------------------------ wait
function* cmdWait(x) {
  x.api();
  const f = x.f;
  const cond = f.for;
  if (!cond) fail('error: --for must be specified');
  const timeout = f.timeout !== undefined ? parseDuration(f.timeout) * 1000 : 30000;
  let groups = parseResourceArgs(x.c, x.pos, { verb: 'wait' });
  const targets = () => {
    const out = [];
    for (const g of groups) {
      if (g.names.length) for (const n of g.names) out.push({ r: g.r, name: n, o: x.c.peek(g.r, x.ns, n) });
      else for (const o of x.c.list(g.r, nsOf(x, g.r), { labelSelector: f.selector, user: x.user })) out.push({ r: g.r, name: o.metadata.name, o });
    }
    return out;
  };
  const check = (t) => {
    const o = t.o;
    if (cond === 'delete') return !o;
    if (cond === 'create') return !!o;
    if (!o) return null;
    let m;
    if ((m = cond.match(/^condition=([^=]+)(?:=(.*))?$/i))) {
      const want = (m[2] ?? 'True').toLowerCase();
      return (o.status?.conditions || []).some((y) => y.type.toLowerCase() === m[1].toLowerCase() && String(y.status).toLowerCase() === want);
    }
    if ((m = cond.match(/^jsonpath=(.+?)(?:=(.*))?$/))) {
      let p = m[1];
      if (!p.startsWith('{')) p = `{${p}}`;
      let v;
      try { v = jsonpath(p, clean(o)); } catch { v = ''; }
      return m[2] === undefined ? v !== '' : v === m[2];
    }
    fail(`error: unrecognized condition: "${cond}"`);
    return false;
  };
  const start = x.c.now();
  let first = targets();
  if (!first.length) fail(`error: no matching resources found`);
  for (const t of first) if (!t.o && cond !== 'delete' && cond !== 'create') fail(`Error from server (NotFound): ${qualifiedName(t.r)} "${t.name}" not found`);
  const done = new Set();
  while (true) {
    const cur = targets().length ? targets() : first.map((t) => ({ ...t, o: null }));
    const list = cond === 'delete' ? first.map((t) => ({ ...t, o: x.c.peek(t.r, x.ns, t.name) })) : cur;
    for (const t of list) {
      if (done.has(t.name)) continue;
      if (check(t)) { x.io.line(`${kindPrefix(t.r)}/${t.name} condition met`); done.add(t.name); }
    }
    if (list.every((t) => done.has(t.name))) return 0;
    if (x.c.now() - start >= timeout) {
      for (const t of list) if (!done.has(t.name)) x.io.eline(`error: timed out waiting for the condition on ${qualifiedName(t.r)}/${t.name}`);
      return 1;
    }
    yield* sleep(1000);
  }
}

// ------------------------------------------------------------------ cp
function* cmdCp(x) {
  x.api();
  const [src, dst] = x.pos;
  if (!src || !dst) fail('error: source and destination are required');
  const remote = (s) => { const m = s.match(/^(?:([^/:]+)\/)?([^:/]+):(.*)$/); return m ? { ns: m[1] || x.ns, pod: m[2], path: m[3] } : null; };
  const rs = remote(src), rd = remote(dst);
  const getShell = (r) => {
    const pod = x.c.get('pods', r.ns, r.pod, { user: x.user });
    const rt = rtForPod(x.c, pod);
    const cname = pickContainer(x, pod, x.f.container, { quiet: true });
    const res = rt && execShell(x.c, rt, cname);
    if (!res?.sh) fail(`error: unable to upgrade connection: container not found ("${cname}")`);
    if (!res.info.bin?.includes('tar')) x.io.eline('');
    return res.sh;
  };
  try {
    if (rs && !rd) {
      const sh = getShell(rs);
      const data = sh.fs.read(sh.abs(rs.path));
      x.sh.fs.write(x.sh.abs(dst), data, { user: x.sh.user });
      x.io.eline('tar: removing leading \'/\' from member names');
    } else if (rd && !rs) {
      const sh = getShell(rd);
      const data = x.sh.fs.read(x.sh.abs(src), x.sh.user);
      let p = sh.abs(rd.path || '/');
      if (sh.fs.isDir(p)) p = `${p}/${src.split('/').pop()}`;
      sh.fs.write(p, data);
    } else fail('error: one of src or dest must be a local file specification');
  } catch (e) {
    if (e instanceof KErr) throw e;
    fail(`error: ${e.message}`);
  }
  return 0;
}

// ------------------------------------------------------------------ events
function* cmdEvents(x) {
  x.api();
  let evs = x.c.list('events', x.allNs ? null : x.ns, { user: x.user });
  if (x.f['for-object'] || x.f.for) {
    const [t, n] = String(x.f['for-object'] || x.f.for).split('/');
    const r = resolveType(x.c, t);
    evs = evs.filter((e) => e.involvedObject.kind === r.kind && e.involvedObject.name === n);
  }
  if (x.f.types) { const ts = x.f.types.flatMap((s) => s.split(',')); evs = evs.filter((e) => ts.includes(e.type)); }
  evs.sort((a, b) => Date.parse(a.lastTimestamp) - Date.parse(b.lastTimestamp));
  if (!evs.length) { x.io.eline(`No events found in ${x.ns} namespace.`); return 0; }
  if (x.f.output) { x.io.out(render(x, [{ r: x.c.res('events'), items: evs }], parseOutput(x.f.output))); return 0; }
  const rows = [[...(x.allNs ? ['NAMESPACE'] : []), 'LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE']];
  for (const e of evs) rows.push([...(x.allNs ? [e.metadata.namespace] : []), age(e.lastTimestamp, x.c.now()), e.type, e.reason, `${e.involvedObject.kind}/${e.involvedObject.name}`, e.message]);
  x.io.out(tableText(rows));
  return 0;
}

// ------------------------------------------------------------------ inne
function* cmdPortForward(x) {
  x.api();
  const ports = x.pos.slice(1);
  for (const p of ports) { const [l, r] = p.includes(':') ? p.split(':') : [p, p]; x.io.line(`Forwarding from 127.0.0.1:${l} -> ${r}\nForwarding from [::1]:${l} -> ${r}`); }
  while (true) yield* sleep(3600e3);
}

function* cmdCompletion(x) { x.io.line('# bash completion for kubectl (symulator)'); return 0; }

function* cmdDebug(x) {
  x.api();
  const t = x.pos[0] || '';
  if (!t.startsWith('node/')) fail('error: w symulatorze obsługiwane jest tylko: kubectl debug node/<węzeł> -it --image=busybox');
  const node = t.slice(5);
  x.c.get('nodes', null, node, { user: x.user });
  const image = x.f.image || 'busybox';
  const name = `node-debugger-${node}-${Math.random().toString(36).slice(2, 7)}`;
  x.c.create({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: x.ns }, spec: { nodeName: node, hostNetwork: true, hostPID: true, hostIPC: true, restartPolicy: 'Never', containers: [{ name: 'debugger', image, stdin: true, tty: true, command: ['sh', '-c', 'sleep 3600'], volumeMounts: [{ name: 'host-root', mountPath: '/host' }] }], volumes: [{ name: 'host-root', hostPath: { path: '/' } }], tolerations: [{ operator: 'Exists' }] } }, { user: x.user });
  x.io.line(`Creating debugging pod ${name} with container debugger on node ${node}.`);
  for (let i = 0; i < 60; i++) {
    const p = x.c.peek('pods', x.ns, name);
    if (p?.status?.phase === 'Running') break;
    yield* sleep(1000);
  }
  if (!(x.f.stdin && x.f.tty)) return 0;
  const pod = x.c.get('pods', x.ns, name);
  const rt = rtForPod(x.c, pod);
  const r = rt && execShell(x.c, rt, 'debugger');
  if (!r?.sh) fail('error: timed out waiting for the condition');
  x.io.line("If you don't see a command prompt, try pressing enter.");
  r.sh.interactive = true;
  r.sh.vars.set('PS1', `${node}:\\w# `);
  r.sh.ctx = { ...r.sh.ctx, debugNode: node };
  yield { type: 'subshell', shell: r.sh, kind: 'container' };
  return 0;
}

// --------------------------------------------------------------- kustomize (z apply.js)
function* kustomizeDocs(x, dir) { return yield* APPLY_CMDS.__kustomizeDocs(x, dir); }

const HELP = {
  _: `kubectl controls the Kubernetes cluster manager.

 Find more information at: https://kubernetes.io/docs/reference/kubectl/

Basic Commands (Beginner):
  create          Create a resource from a file or from stdin
  expose          Take a replication controller, service, deployment or pod and expose it as a new Kubernetes service
  run             Run a particular image on the cluster
  set             Set specific features on objects

Basic Commands (Intermediate):
  explain         Get documentation for a resource
  get             Display one or many resources
  edit            Edit a resource on the server
  delete          Delete resources by file names, stdin, resources and names, or by resources and label selector

Deploy Commands:
  rollout         Manage the rollout of a resource
  scale           Set a new size for a deployment, replica set, or replication controller
  autoscale       Auto-scale a deployment, replica set, stateful set, or replication controller

Cluster Management Commands:
  certificate     Modify certificate resources
  cluster-info    Display cluster information
  top             Display resource (CPU/memory) usage
  cordon          Mark node as unschedulable
  uncordon        Mark node as schedulable
  drain           Drain node in preparation for maintenance
  taint           Update the taints on one or more nodes

Troubleshooting and Debugging Commands:
  describe        Show details of a specific resource or group of resources
  logs            Print the logs for a container in a pod
  attach          Attach to a running container
  exec            Execute a command in a container
  port-forward    Forward one or more local ports to a pod
  cp              Copy files and directories to and from containers
  auth            Inspect authorization
  debug           Create debugging sessions for troubleshooting workloads and nodes
  events          List events

Advanced Commands:
  diff            Diff the live version against a would-be applied version
  apply           Apply a configuration to a resource by file name or stdin
  patch           Update fields of a resource
  replace         Replace a resource by file name or stdin
  wait            Experimental: Wait for a specific condition on one or many resources
  kustomize       Build a kustomization target from a directory or URL

Settings Commands:
  label           Update the labels on a resource
  annotate        Update the annotations on a resource
  completion      Output shell completion code for the specified shell (bash, zsh, fish, or powershell)

Other Commands:
  api-resources   Print the supported API resources on the server
  api-versions    Print the supported API versions on the server, in the form of "group/version"
  config          Modify kubeconfig files
  version         Print the client and server version information

Usage:
  kubectl [flags] [options]

Use "kubectl <command> --help" for more information about a given command.
Use "kubectl options" for a list of global command-line options (applies to all commands).`,
};

export const COMMANDS = {
  get: cmdGet, describe: cmdDescribe, delete: cmdDelete, logs: cmdLogs, exec: cmdExec, top: cmdTop, auth: cmdAuth, config: cmdConfig,
  'api-resources': cmdApiResources, 'api-versions': cmdApiVersions, explain: cmdExplain, version: cmdVersion, 'cluster-info': cmdClusterInfo,
  certificate: cmdCertificate, wait: cmdWait, cp: cmdCp, events: cmdEvents, 'port-forward': cmdPortForward, completion: cmdCompletion, debug: cmdDebug,
  ...CREATE_CMDS, ...APPLY_CMDS,
};
delete COMMANDS.__kustomizeDocs;

export { podStatus, makeToken, refName, b64dec, humanDuration, readManifestSources };
