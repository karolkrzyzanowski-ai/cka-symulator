// kubectl create / run / expose (generatory obiektów).
import { fail, KErr, apiMsg, readManifestSources, render, parseOutput, clean, resolveType, toYaml } from './common.js';
import { kindPrefix } from './printers.js';
import { ApiError } from '../sim/cluster.js';
import { b64enc, parseDuration, clone, shQuote, basename } from '../lib/util.js';
import { makeToken, parseToken } from './context.js';
import { parsePem, keyId } from '../sim/pki.js';
import { execShell } from '../sim/kubelet.js';
import { MODIFY_CMDS } from './modify.js';

const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

export function dryRunMode(f) {
  const d = f['dry-run'];
  if (d === undefined || d === 'none' || d === 'false') return null;
  if (d === 'unchanged') fail('error: Invalid dry-run value (unchanged). Must be "none", "server", or "client".');
  if (d === 'client' || d === 'true') return 'client';
  if (d === 'server') return 'server';
  fail(`error: Invalid dry-run value (${d}). Must be "none", "server", or "client".`);
  return null;
}

export function containerNameFromImage(image) {
  let n = image.split('@')[0];
  n = n.split('/').pop();
  n = n.split(':')[0];
  return n.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'container';
}

export function lastApplied(o) {
  const copy = clone(clean(o));
  if (copy.metadata?.annotations) {
    delete copy.metadata.annotations[LAST_APPLIED];
    if (!Object.keys(copy.metadata.annotations).length) delete copy.metadata.annotations;
  }
  return JSON.stringify(sortDeep(copy)) + '\n';
}
function sortDeep(o) {
  if (Array.isArray(o)) return o.map(sortDeep);
  if (!o || typeof o !== 'object') return o;
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortDeep(o[k])]));
}

// wspólne: wysłanie obiektu (z obsługą dry-run i -o)
export function* submit(x, obj, { verb = 'created', source } = {}) {
  const f = x.f;
  const mode = dryRunMode(f);
  const out = f.output ? parseOutput(f.output) : null;
  if (f['save-config']) { obj.metadata = obj.metadata || {}; obj.metadata.annotations = { ...(obj.metadata.annotations || {}), [LAST_APPLIED]: lastApplied(obj) }; }
  if (mode === 'client') {
    const r = x.c?.registry.byKindAnyVersion(obj.apiVersion, obj.kind) || { kind: obj.kind, singular: obj.kind.toLowerCase(), group: (obj.apiVersion.split('/')[1] ? obj.apiVersion.split('/')[0] : '') };
    if (r.namespaced && f.namespace && obj.metadata && !obj.metadata.namespace) obj.metadata.namespace = f.namespace;
    if (out) x.io.out(render(x, [{ r, items: [obj] }], out, { single: true, flags: f }));
    else x.io.line(`${kindPrefix(r)}/${obj.metadata.name} ${verb} (dry run)`);
    return obj;
  }
  x.api();
  let res;
  try {
    res = x.c.create(obj, { user: x.user, ns: obj.metadata?.namespace || x.ns, dryRun: mode === 'server' });
  } catch (e) {
    if (e instanceof ApiError) {
      const ctx = source ? `: error when creating "${source}"` : '';
      if (e.reason === 'Invalid' || e.reason === 'NoMatch') throw new KErr(1, e.kubectlMessage());
      throw new KErr(1, source ? `Error from server (${e.reason})${ctx}: ${e.message}` : e.kubectlMessage());
    }
    throw e;
  }
  for (const w of res.__warnings || []) x.io.eline(`Warning: ${w}`);
  const r = x.c.registry.byKindAnyVersion(res.apiVersion, res.kind);
  if (out) x.io.out(render(x, [{ r, items: [res] }], out, { single: true, flags: f }));
  else x.io.line(`${kindPrefix(r)}/${res.metadata.name} ${verb}${mode === 'server' ? ' (server dry run)' : ''}`);
  x.c.reconcile();
  return res;
}

const META = (name, extra = {}) => ({ creationTimestamp: null, ...extra, name });

function envList(arr) {
  return arr.flatMap((s) => s.split(/,(?=[A-Za-z_][\w.-]*=)/)).map((e) => { const i = e.indexOf('='); return { name: e.slice(0, i), value: e.slice(i + 1) }; });
}

// ------------------------------------------------------------------ create <typ>
const GEN = {};

GEN.deployment = GEN.deploy = (x, name) => {
  const imgs = x.f.image ? [x.f.image] : [];
  if (!imgs.length) fail(`error: required flag(s) "image" not set`);
  const labels = { app: name };
  const ct = { image: imgs[0], name: containerNameFromImage(imgs[0]), resources: {} };
  if (x.dash.length) ct.command = [...x.dash];
  if (x.f.port) ct.ports = [{ containerPort: Number(x.f.port) }];
  return { apiVersion: 'apps/v1', kind: 'Deployment', metadata: META(name, { labels }), spec: { replicas: Number(x.f.replicas ?? 1), selector: { matchLabels: labels }, strategy: {}, template: { metadata: { creationTimestamp: null, labels }, spec: { containers: [ct] } } }, status: {} };
};

GEN.namespace = GEN.ns = (x, name) => ({ apiVersion: 'v1', kind: 'Namespace', metadata: META(name), spec: {}, status: {} });
GEN.serviceaccount = GEN.sa = (x, name) => ({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: META(name) });

function readFromFiles(x, specs) {
  const data = {};
  for (const s of specs) {
    let key = null, path = s;
    if (s.includes('=')) [key, path] = [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)];
    const p = x.sh.abs(path);
    if (!x.sh.fs.exists(p)) fail(`error: error reading ${path}: no such file or directory`);
    if (x.sh.fs.isDir(p)) {
      for (const n of x.sh.fs.list(p)) if (x.sh.fs.isFile(`${p}/${n}`)) data[n] = x.sh.fs.read(`${p}/${n}`, x.sh.user);
      continue;
    }
    try { data[key || basename(path)] = x.sh.fs.read(p, x.sh.user); } catch { fail(`error: error reading ${path}: permission denied`); }
  }
  return data;
}
function literals(arr) {
  const out = {};
  for (const l of arr) {
    const i = l.indexOf('=');
    if (i <= 0) fail(`error: invalid literal source ${l}, expected key=value`);
    const k = l.slice(0, i);
    if (out[k] !== undefined) fail(`error: cannot add key "${k}", another key by that name already exists in Data for ConfigMap "${''}"`);
    out[k] = l.slice(i + 1);
  }
  return out;
}
function envFile(x, files) {
  const out = {};
  for (const f of files) {
    const t = x.sh.fs.read(x.sh.abs(f), x.sh.user);
    for (const line of t.split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      out[s.slice(0, i)] = s.slice(i + 1);
    }
  }
  return out;
}

GEN.configmap = GEN.cm = (x, name) => {
  const data = { ...readFromFiles(x, x.f['from-file'] || []), ...literals(x.f['from-literal'] || []), ...envFile(x, x.f['from-env-file'] || []) };
  const o = { apiVersion: 'v1', kind: 'ConfigMap', metadata: META(name) };
  if (Object.keys(data).length) o.data = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
  return { apiVersion: o.apiVersion, ...(o.data ? { data: o.data } : {}), kind: o.kind, metadata: o.metadata };
};

GEN.secret = (x, name, sub) => {
  if (!sub || !['generic', 'tls', 'docker-registry'].includes(sub)) fail('Create a secret with specified type.\n\nAvailable Commands:\n  docker-registry   Create a secret for use with a Docker registry\n  generic           Create a secret from a local file, directory, or literal value\n  tls               Create a TLS secret');
  if (sub === 'generic') {
    const raw = { ...readFromFiles(x, x.f['from-file'] || []), ...literals(x.f['from-literal'] || []), ...envFile(x, x.f['from-env-file'] || []) };
    const data = Object.fromEntries(Object.entries(raw).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, b64enc(v)]));
    return { apiVersion: 'v1', ...(Object.keys(data).length ? { data } : {}), kind: 'Secret', metadata: META(name), ...(x.f.type ? { type: x.f.type } : {}) };
  }
  if (sub === 'tls') {
    if (!x.f.cert || !x.f.key) fail('error: required flag(s) "cert", "key" not set');
    let crt, key;
    try { crt = x.sh.fs.read(x.sh.abs(x.f.cert), x.sh.user); } catch { fail(`error: open ${x.f.cert}: no such file or directory`); }
    try { key = x.sh.fs.read(x.sh.abs(x.f.key), x.sh.user); } catch { fail(`error: open ${x.f.key}: no such file or directory`); }
    const cm = parsePem(crt)?.meta;
    if (!cm) fail('error: failed to load key pair tls: failed to find any PEM data in certificate input');
    if (!parsePem(key)) fail('error: failed to load key pair tls: failed to find any PEM data in key input');
    if (cm.k && keyId(key) && cm.k !== keyId(key)) fail('error: failed to load key pair tls: private key does not match public key');
    return { apiVersion: 'v1', data: { 'tls.crt': b64enc(crt), 'tls.key': b64enc(key) }, kind: 'Secret', metadata: META(name), type: 'kubernetes.io/tls' };
  }
  const server = x.f['docker-server'] || 'https://index.docker.io/v1/';
  const auth = { auths: { [server]: { username: x.f['docker-username'] || '', password: x.f['docker-password'] || '', ...(x.f['docker-email'] ? { email: x.f['docker-email'] } : {}), auth: b64enc(`${x.f['docker-username'] || ''}:${x.f['docker-password'] || ''}`) } } };
  return { apiVersion: 'v1', data: { '.dockerconfigjson': b64enc(JSON.stringify(auth)) }, kind: 'Secret', metadata: META(name), type: 'kubernetes.io/dockerconfigjson' };
};

const VERBS = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection', 'use', 'bind', 'escalate', 'impersonate', 'approve', 'sign', '*', 'proxy'];

function roleRules(x, cluster) {
  const verbs = (x.f.verb || []).flatMap((v) => v.split(',')).filter(Boolean);
  const resources = (x.f.resource || []).flatMap((v) => v.split(',')).filter(Boolean);
  const names = (x.f['resource-name'] || []).flatMap((v) => v.split(',')).filter(Boolean);
  if (!verbs.length) fail('error: at least one verb must be specified');
  for (const v of verbs) if (!VERBS.includes(v)) fail(`error: invalid verb: '${v}'`);
  const rules = [];
  if (resources.length) {
    const byGroup = new Map();
    for (const res of resources) {
      let [base, sub] = res.split('/');
      let group = null;
      if (base === '*') group = '*';
      else {
        const r = x.c.registry.resolve(base);
        if (!r) fail(`error: resource "${base}" not found`);
        base = r.plural;
        group = r.group;
      }
      const name = sub ? `${base}/${sub}` : base;
      if (!byGroup.has(group)) byGroup.set(group, []);
      if (!byGroup.get(group).includes(name)) byGroup.get(group).push(name);
    }
    for (const [g, rs] of byGroup) rules.push({ apiGroups: [g], resources: rs, ...(names.length ? { resourceNames: names } : {}), verbs });
  }
  const nru = (x.f['non-resource-url'] || []).flatMap((v) => v.split(','));
  if (nru.length) { if (!cluster) fail('error: --non-resource-url only valid for ClusterRole'); rules.push({ nonResourceURLs: nru, verbs }); }
  if (!rules.length) fail('error: at least one resource must be specified');
  return rules;
}

GEN.role = (x, name) => { x.api(); return { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: META(name), rules: roleRules(x, false) }; };
GEN.clusterrole = (x, name) => {
  x.api();
  if (x.f['aggregation-rule']) {
    const sel = Object.fromEntries(x.f['aggregation-rule'].split(',').map((kv) => kv.split('=')));
    return { aggregationRule: { clusterRoleSelectors: [{ matchLabels: sel }] }, apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: META(name), rules: null };
  }
  return { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: META(name), rules: roleRules(x, true) };
};

function subjects(x) {
  const out = [];
  for (const u of (x.f.user || '').split(',').filter(Boolean)) out.push({ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: u });
  for (const g of x.f.group || []) for (const gg of g.split(',')) out.push({ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: gg });
  for (const s of x.f.serviceaccount || []) {
    for (const ss of s.split(',')) {
      const p = ss.split(':');
      if (p.length !== 2 || !p[0] || !p[1]) fail(`error: serviceaccount must be <namespace>:<name>`);
      out.push({ kind: 'ServiceAccount', name: p[1], namespace: p[0] });
    }
  }
  return out;
}
GEN.rolebinding = (x, name) => {
  if (!x.f.role && !x.f.clusterrole) fail('error: exactly one of clusterrole or role must be specified');
  if (x.f.role && x.f.clusterrole) fail('error: exactly one of clusterrole or role must be specified');
  return { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: META(name), roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: x.f.role ? 'Role' : 'ClusterRole', name: x.f.role || x.f.clusterrole }, subjects: subjects(x) };
};
GEN.clusterrolebinding = (x, name) => {
  if (!x.f.clusterrole) fail('error: required flag(s) "clusterrole" not set');
  return { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: META(name), roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: x.f.clusterrole }, subjects: subjects(x) };
};

GEN.job = (x, name) => {
  if (x.f.from) {
    x.api();
    const [t, n] = x.f.from.split('/');
    if (!/^(cronjob|cronjobs|cj)$/.test(t)) fail(`error: from must be an existing cronjob: ${x.f.from}`);
    const cj = x.c.get('cronjobs', x.ns, n, { user: x.user });
    const tpl = clone(cj.spec.jobTemplate);
    return { apiVersion: 'batch/v1', kind: 'Job', metadata: { annotations: { 'cronjob.kubernetes.io/instantiate': 'manual', ...(tpl.metadata?.annotations || {}) }, creationTimestamp: null, labels: tpl.metadata?.labels, name, ownerReferences: [{ apiVersion: 'batch/v1', controller: true, kind: 'CronJob', name: cj.metadata.name, uid: cj.metadata.uid }] }, spec: tpl.spec, status: {} };
  }
  if (!x.f.image) fail('error: either --image or --from must be specified');
  const ct = { image: x.f.image, name, resources: {} };
  if (x.dash.length) ct.command = [...x.dash];
  return { apiVersion: 'batch/v1', kind: 'Job', metadata: META(name), spec: { template: { metadata: { creationTimestamp: null }, spec: { containers: [ct], restartPolicy: 'Never' } } }, status: {} };
};

GEN.cronjob = GEN.cj = (x, name) => {
  if (!x.f.image) fail('error: required flag(s) "image" not set');
  if (!x.f.schedule) fail('error: required flag(s) "schedule" not set');
  const ct = { image: x.f.image, name, resources: {} };
  if (x.dash.length) ct.command = [...x.dash];
  return { apiVersion: 'batch/v1', kind: 'CronJob', metadata: META(name), spec: { jobTemplate: { metadata: { creationTimestamp: null, name }, spec: { template: { metadata: { creationTimestamp: null }, spec: { containers: [ct], restartPolicy: x.f.restart || 'OnFailure' } } } }, schedule: x.f.schedule }, status: {} };
};

GEN.quota = GEN.resourcequota = (x, name) => {
  const hard = {};
  for (const kv of (x.f.hard || '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); hard[k] = v; }
  return { apiVersion: 'v1', kind: 'ResourceQuota', metadata: META(name), spec: { hard, ...(x.f.scopes ? { scopes: x.f.scopes.split(',') } : {}) }, status: {} };
};

GEN.priorityclass = GEN.pc = (x, name) => ({
  apiVersion: 'scheduling.k8s.io/v1', ...(x.f.description !== undefined ? { description: x.f.description } : {}), globalDefault: !!x.f['global-default'], kind: 'PriorityClass', metadata: META(name), preemptionPolicy: x.f['preemption-policy'] || 'PreemptLowerPriority', value: Number(x.f.value || 0),
});

GEN.ingress = GEN.ing = (x, name) => {
  const rules = [];
  const tls = [];
  for (const r of x.f.rule || []) {
    const m = r.match(/^([^/]*)(\/[^=]*)?=([^:]+):([^,]+)(?:,tls(?:=(.+))?)?$/);
    if (!m) fail(`error: rule ${r} is invalid and should be in format host/path=svcname:svcport[,tls[=secret]]`);
    const [, host, rawPath = '/', svc, port, secret] = m;
    let path = rawPath, pathType = 'Exact';
    if (path.endsWith('*')) { path = path.slice(0, -1).replace(/\/$/, '') || '/'; pathType = 'Prefix'; }
    const backend = { service: { name: svc, port: /^\d+$/.test(port) ? { number: Number(port) } : { name: port } } };
    let rule = rules.find((y) => y.host === (host || undefined));
    if (!rule) { rule = { ...(host ? { host } : {}), http: { paths: [] } }; rules.push(rule); }
    rule.http.paths.push({ backend, path, pathType });
    if (r.includes(',tls')) tls.push({ hosts: [host], ...(secret ? { secretName: secret } : {}) });
  }
  const spec = { ...(x.f.class ? { ingressClassName: x.f.class } : {}), rules };
  if (x.f['default-backend']) { const [s, p] = x.f['default-backend'].split(':'); spec.defaultBackend = { service: { name: s, port: /^\d+$/.test(p) ? { number: Number(p) } : { name: p } } }; }
  if (tls.length) spec.tls = tls;
  return { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: META(name, x.f.annotation ? { annotations: Object.fromEntries(x.f.annotation.map((a) => a.split('='))) } : {}), spec, status: { loadBalancer: {} } };
};

GEN.poddisruptionbudget = GEN.pdb = (x, name) => {
  const sel = {};
  for (const kv of (x.f.selector || '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); sel[k] = v; }
  const spec = { selector: { matchLabels: sel } };
  if (x.f['min-available']) spec.minAvailable = /^\d+$/.test(x.f['min-available']) ? Number(x.f['min-available']) : x.f['min-available'];
  if (x.f['max-unavailable']) spec.maxUnavailable = /^\d+$/.test(x.f['max-unavailable']) ? Number(x.f['max-unavailable']) : x.f['max-unavailable'];
  return { apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: META(name), spec, status: { currentHealthy: 0, desiredHealthy: 0, disruptionsAllowed: 0, expectedPods: 0 } };
};

GEN.service = GEN.svc = (x, name, sub) => {
  const types = { clusterip: 'ClusterIP', nodeport: 'NodePort', loadbalancer: 'LoadBalancer', externalname: 'ExternalName' };
  if (!types[sub]) fail('Create a service using a specified subcommand.\n\nAvailable Commands:\n  clusterip       Create a ClusterIP service\n  externalname    Create an ExternalName service\n  loadbalancer    Create a LoadBalancer service\n  nodeport        Create a NodePort service');
  const spec = { type: types[sub] };
  if (sub === 'externalname') {
    if (!x.f['external-name']) fail('error: required flag(s) "external-name" not set');
    return { apiVersion: 'v1', kind: 'Service', metadata: META(name, { labels: { app: name } }), spec: { externalName: x.f['external-name'], selector: { app: name }, type: 'ExternalName' }, status: { loadBalancer: {} } };
  }
  const tcp = (x.f.tcp || []).flatMap((t) => t.split(','));
  if (!tcp.length && x.f['cluster-ip'] !== 'None') fail('error: at least one tcp port specifier must be provided');
  spec.ports = tcp.map((t) => {
    const [p, tp] = t.split(':');
    const port = { name: `${p}-${tp ?? p}`, port: Number(p), protocol: 'TCP', targetPort: /^\d+$/.test(tp ?? p) ? Number(tp ?? p) : tp };
    if (sub === 'nodeport' && x.f['node-port']) port.nodePort = Number(x.f['node-port']);
    return port;
  });
  if (x.f['cluster-ip']) spec.clusterIP = x.f['cluster-ip'];
  const ordered = { ...(spec.clusterIP ? { clusterIP: spec.clusterIP } : {}), ports: spec.ports, selector: { app: name }, type: spec.type };
  return { apiVersion: 'v1', kind: 'Service', metadata: META(name, { labels: { app: name } }), spec: ordered, status: { loadBalancer: {} } };
};

// ------------------------------------------------------------------ create
function* cmdCreate(x) {
  const f = x.f;
  if (f.filename?.length || f.kustomize) {
    const mode = dryRunMode(f);
    if (mode !== 'client') x.api();
    const docs = f.kustomize ? (yield* x.kustomizeDocs(x, f.kustomize)) : readManifestSources(x, f.filename, { recursive: f.recursive });
    let st = 0;
    for (const d of docs) {
      try { yield* submit(x, d.obj, { source: d.source }); } catch (e) {
        if (e instanceof KErr) { x.io.eline(e.message); st = 1; continue; }
        throw e;
      }
    }
    return st;
  }
  const [type, ...rest] = x.pos;
  if (!type) fail("error: must specify one of -f and -k\n\nCreate a resource from a file or from stdin.");
  if (type === 'token') return yield* createToken(x, rest[0]);
  const gen = GEN[type];
  if (!gen) fail(`error: unknown command "${type}" for "kubectl create"`);
  let sub = null, name;
  if (type === 'secret' || type === 'service' || type === 'svc') { sub = rest[0]; name = rest[1]; } else name = rest[0];
  if (!name && !(type === 'secret' || type === 'service' || type === 'svc') || ((type === 'secret' || type === 'service' || type === 'svc') && sub && !name)) fail(`error: exactly one NAME is required, got 0\nSee 'kubectl create ${type} -h' for help and examples`);
  const obj = gen(x, name, sub);
  if (!dryRunMode(f)) x.api();
  if (obj.metadata && f.namespace && !['Namespace', 'ClusterRole', 'ClusterRoleBinding', 'PriorityClass'].includes(obj.kind)) obj.metadata.namespace = f.namespace;
  const toSend = clone(obj);
  if (!dryRunMode(f)) stripNulls(toSend);
  yield* submit(x, dryRunMode(f) ? obj : toSend);
  return 0;
}

export function stripNulls(o) {
  if (!o || typeof o !== 'object') return;
  for (const k of Object.keys(o)) {
    if (o[k] === null) delete o[k];
    else if (typeof o[k] === 'object') stripNulls(o[k]);
  }
}

function* createToken(x, sa) {
  x.api();
  if (!sa) fail('error: exactly one NAME is required, got 0');
  x.c.get('serviceaccounts', x.ns, sa, { user: x.user });
  x.c.authz(x.user, 'create', x.c.res('serviceaccounts'), x.ns, sa, 'token');
  const dur = x.f.duration ? parseDuration(x.f.duration) * 1000 : 3600e3;
  x.io.line(makeToken(x.ns, sa, x.c.now() + dur, x.f.audience?.length ? x.f.audience : undefined));
  void parseToken;
  return 0;
}

// ------------------------------------------------------------------ run
function* cmdRun(x) {
  const f = x.f;
  const name = x.pos[0];
  if (!name) fail("error: NAME is required for run\nSee 'kubectl run -h' for help and examples");
  if (!f.image) fail('error: required flag(s) "image" not set');
  if (f.replicas) fail('error: unknown flag: --replicas');
  const labels = f.labels ? Object.fromEntries(f.labels.split(',').map((kv) => kv.split('='))) : { run: name };
  const ct = { image: f.image, name, resources: {} };
  if (x.dash.length) { if (f.command) ct.command = [...x.dash]; else ct.args = [...x.dash]; }
  if (f.env?.length) ct.env = envList(f.env);
  if (f.port) ct.ports = [{ containerPort: Number(f.port) }];
  if (f['image-pull-policy']) ct.imagePullPolicy = f['image-pull-policy'];
  if (f.stdin) { ct.stdin = true; if (f.tty) ct.tty = true; ct.stdinOnce = true; }
  const restart = f.restart || 'Always';
  if (!['Always', 'OnFailure', 'Never'].includes(restart)) fail(`error: invalid restart policy: ${restart}`);
  if (f.rm && !f.stdin && !f.attach) fail('error: --rm should only be used for attached containers');
  const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { creationTimestamp: null, labels, name, ...(f.annotations?.length ? { annotations: Object.fromEntries(f.annotations.map((a) => a.split('='))) } : {}) }, spec: { containers: [ct], dnsPolicy: 'ClusterFirst', restartPolicy: restart }, status: {} };
  if (f.overrides) {
    try { mergeOverrides(pod, JSON.parse(f.overrides)); } catch (e) { fail(`error: Invalid JSON Patch: ${e.message}`); }
  }
  const mode = dryRunMode(f);
  if (f.expose) {
    if (!f.port) fail("error: --port must be set when exposing a service");
    const svc = { apiVersion: 'v1', kind: 'Service', metadata: { creationTimestamp: null, name }, spec: { ports: [{ port: Number(f.port), protocol: 'TCP', targetPort: Number(f.port) }], selector: labels }, status: { loadBalancer: {} } };
    if (mode) yield* submit(x, svc);
    else { const s = clone(svc); stripNulls(s); yield* submit(x, s); }
  }
  if (mode) { yield* submit(x, pod); return 0; }
  const send = clone(pod);
  stripNulls(send);
  delete send.status;
  const attached = f.stdin || f.attach;
  if (!attached) { yield* submit(x, send); return 0; }
  // tryb dołączony
  x.api();
  try { x.c.create(send, { user: x.user, ns: x.ns }); } catch (e) { throw new KErr(1, apiMsg(e)); }
  x.c.reconcile();
  const ns = x.ns;
  const t0 = x.c.now();
  let p;
  while (true) {
    p = x.c.peek('pods', ns, name);
    if (!p) fail(`error: pods "${name}" not found`);
    const st = p.status?.phase;
    if (st === 'Running' || st === 'Succeeded' || st === 'Failed') break;
    if (x.c.now() - t0 > 60000) { x.io.eline('error: timed out waiting for the condition'); return 1; }
    yield { type: 'sleep', ms: 500 };
  }
  const isShell = f.stdin && f.tty && ['sh', 'bash', 'ash'].includes((x.dash[0] || '').split('/').pop()) && x.dash.length === 1;
  if (isShell && p.status.phase === 'Running') {
    const rt = x.c.runtime[p.metadata.uid];
    const r = rt && execShell(x.c, rt, name);
    if (r?.sh) {
      x.io.line("If you don't see a command prompt, try pressing enter.");
      r.sh.interactive = true;
      r.sh.vars.set('PS1', '\\w # ');
      yield { type: 'subshell', shell: r.sh, kind: 'container' };
    }
  } else {
    // strumień logów do zakończenia
    let seen = 0;
    while (true) {
      const rt = x.c.runtime[p.metadata.uid];
      const crt = rt?.main?.[0];
      if (crt) {
        const logs = crt.logs || [];
        for (const [, l] of logs.slice(seen)) x.io.line(l);
        seen = logs.length;
        if (crt.state === 'terminated' || crt.restarts > 0) break;
      }
      const cur = x.c.peek('pods', ns, name);
      if (!cur || ['Succeeded', 'Failed'].includes(cur.status?.phase)) break;
      if (x.c.now() - t0 > 3600e3) break;
      yield { type: 'sleep', ms: 500 };
    }
  }
  const fin = x.c.peek('pods', ns, name);
  if (f.rm) {
    x.c.doDelete(x.c.res('pods'), fin || p, { gracePeriod: 0 });
    x.c.reconcile();
    x.io.line(`pod "${name}" deleted from ${ns} namespace`);
  } else if (isShell) x.io.line(`Session ended, resume using 'kubectl attach ${name} -c ${name} -i -t' command when the pod is running`);
  const failed = fin?.status?.containerStatuses?.[0]?.state?.terminated;
  if (failed && failed.exitCode) { if (!f.rm) x.io.eline(`pod ${ns}/${name} terminated (${failed.reason})`); return 1; }
  return 0;
}

function mergeOverrides(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') mergeOverrides(target[k], v);
    else target[k] = v;
  }
}

// ------------------------------------------------------------------ expose
function* cmdExpose(x) {
  x.api();
  const f = x.f;
  let r, o;
  if (f.filename?.length) {
    const d = readManifestSources(x, f.filename)[0];
    r = x.c.registry.byKindAnyVersion(d.obj.apiVersion, d.obj.kind);
    o = x.c.get(r, d.obj.metadata.namespace || x.ns, d.obj.metadata.name, { user: x.user });
  } else {
    let [t, n] = x.pos;
    if (t?.includes('/')) [t, n] = t.split('/');
    if (!t || !n) fail("error: You must provide one or more resources by argument or filename.\nExample resource specifications include:\n   '-f rsrc.yaml'\n   '--filename=rsrc.json'\n   '<resource> <name>'\n   '<resource>'");
    r = resolveType(x.c, t);
    o = x.c.get(r, x.ns, n, { user: x.user });
  }
  if (!['Pod', 'Service', 'Deployment', 'ReplicaSet', 'ReplicationController', 'StatefulSet'].includes(r.kind)) fail(`error: cannot expose a ${r.kind}.${r.group || ''}`);
  let selector;
  if (f.selector) selector = Object.fromEntries(f.selector.split(',').map((kv) => kv.split('=')));
  else if (r.kind === 'Pod') { selector = o.metadata.labels; if (!selector || !Object.keys(selector).length) fail("error: couldn't retrieve selectors via --selector flag or introspection: the pod has no labels and cannot be exposed\nSee 'kubectl expose -h' for help and examples"); } else if (r.kind === 'Service') selector = o.spec.selector;
  else {
    if (o.spec.selector?.matchExpressions?.length) fail(`error: couldn't retrieve selectors via --selector flag or introspection: couldn't convert expressions - "${o.spec.selector.matchExpressions[0].key}" to map-based selector format`);
    selector = o.spec.selector?.matchLabels;
  }
  let ports = [];
  const proto = f.protocol || 'TCP';
  if (f.port) ports = [{ port: Number(f.port), protocol: proto, targetPort: f['target-port'] ? (/^\d+$/.test(f['target-port']) ? Number(f['target-port']) : f['target-port']) : Number(f.port) }];
  else {
    const tplSpec = r.kind === 'Pod' ? o.spec : r.kind === 'Service' ? null : o.spec.template.spec;
    const cps = r.kind === 'Service' ? (o.spec.ports || []).map((p) => ({ containerPort: p.port, protocol: p.protocol, name: p.name })) : (tplSpec.containers || []).flatMap((ct) => ct.ports || []);
    if (!cps.length) fail("error: couldn't find port via --port flag or introspection\nSee 'kubectl expose -h' for help and examples");
    ports = cps.map((p, i) => ({ ...(cps.length > 1 ? { name: `port-${i + 1}` } : {}), port: p.containerPort, protocol: p.protocol || 'TCP', targetPort: f['target-port'] ? (/^\d+$/.test(f['target-port']) ? Number(f['target-port']) : f['target-port']) : p.containerPort }));
  }
  if (f.name === undefined && r.kind === 'Service') fail('error: --name is required for service');
  const name = f.name || o.metadata.name;
  const spec = { ports, selector };
  if (f.type) spec.type = { clusterip: 'ClusterIP', nodeport: 'NodePort', loadbalancer: 'LoadBalancer' }[f.type.toLowerCase()] || f.type;
  if (f['cluster-ip']) spec.clusterIP = f['cluster-ip'];
  if (f['external-ip']) spec.externalIPs = [f['external-ip']];
  if (f['session-affinity']) spec.sessionAffinity = f['session-affinity'];
  const labels = f.labels ? Object.fromEntries(f.labels.split(',').map((kv) => kv.split('='))) : o.metadata.labels;
  const svc = { apiVersion: 'v1', kind: 'Service', metadata: { creationTimestamp: null, ...(labels && Object.keys(labels).length ? { labels } : {}), name }, spec, status: { loadBalancer: {} } };
  const mode = dryRunMode(f);
  if (!mode) { stripNulls(svc); delete svc.status; svc.metadata.namespace = o.metadata.namespace; }
  yield* submit(x, svc, { verb: 'exposed' });
  return 0;
}

export const CREATE_CMDS = { create: cmdCreate, run: cmdRun, expose: cmdExpose, ...MODIFY_CMDS };
export { LAST_APPLIED, toYaml, shQuote };
