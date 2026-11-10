// Model zadania, rejestr, ocenianie (port ckalib.task z labu).
import { Grader, TaskCtx, TaskUnavailable, CFG } from './ctx.js';

export const DOMAINS = {
  troubleshooting: ['Troubleshooting', 30],
  cluster: ['Cluster Architecture, Installation & Configuration', 25],
  networking: ['Services & Networking', 20],
  workloads: ['Workloads & Scheduling', 15],
  storage: ['Storage', 10],
};
export const DOMAIN_SHORT = { troubleshooting: 'TRBL', cluster: 'ARCH', networking: 'NET', workloads: 'WORK', storage: 'STOR' };
export const DOMAIN_PL = { troubleshooting: 'Rozwiązywanie problemów', cluster: 'Architektura i instalacja', networking: 'Sieć i Service', workloads: 'Workloady i scheduling', storage: 'Storage' };

export const REGISTRY = {};

export function task(t) {
  const def = { host: 'cp', minutes: 6, exam: true, conflicts: [], disruptive: false, requires: [], namespaces: [], ...t };
  if (REGISTRY[def.id]) throw new Error(`duplikat zadania ${def.id}`);
  if (!DOMAINS[def.domain]) throw new Error(`${def.id}: nieznana domena ${def.domain}`);
  def.text = def.text.replace(/^\n+|\s+$/g, '');
  def.solution = (def.solution || '').replace(/^\n+|\s+$/g, '');
  REGISTRY[def.id] = def;
  return def;
}

export function hostName(t) { return { cp: CFG.cp, w1: CFG.w1, w2: CFG.w2 }[t.host] || t.host; }

export function render(text, values) {
  return String(text).replace(/<<([a-zA-Z0-9_]+)>>/g, (m, k) => (values[k] !== undefined ? String(values[k]) : m));
}

export function values(state) { return { ...CFG.placeholders(), ...(state || {}) }; }

export function runSetup(ctx, t) {
  if (t.available) t.available(ctx);
  for (const ns of t.namespaces) ctx.fresh_ns(ns);
  if (t.setup) t.setup(ctx);
}

export function runCheck(ctx, t) {
  const g = new Grader();
  try { t.check(ctx, g); } catch (e) {
    g.ok('Sprawdzanie przerwane błędem', false, String(e?.stack || e).split('\n').slice(0, 3).join(' | '));
  }
  if (!g.items.length) g.ok('Brak kryteriów', false);
  return g;
}

export function runCleanup(ctx, t) {
  const errors = [];
  if (t.cleanup) { try { t.cleanup(ctx); } catch (e) { errors.push(String(e.message || e)); } }
  for (const ns of t.namespaces) ctx.kubectl('delete', 'namespace', ns, '--ignore-not-found', '--wait=false');
  return errors;
}

export { TaskCtx, TaskUnavailable };

// ------------------------------------------------------------------ manifesty (port ckalib.manifests)
export const NGINX = 'nginx:1.28-alpine';
export const NGINX_OLD = 'nginx:1.27-alpine';
export const BUSYBOX = 'busybox:1.36';
export const GRACE = 2;

export function meta(name, ns, labels, annotations) {
  const m = { name };
  if (ns) m.namespace = ns;
  if (labels) m.labels = { ...labels };
  if (annotations) m.annotations = { ...annotations };
  return m;
}

export function container(name, image = NGINX, { command, ports, env, resources, mounts } = {}) {
  const c = { name, image };
  if (command) c.command = typeof command === 'string' ? ['sh', '-c', command] : command;
  if (ports) c.ports = ports.map((p) => (typeof p === 'object' ? p : { containerPort: p }));
  if (env) c.env = env;
  if (resources) c.resources = resources;
  if (mounts) c.volumeMounts = mounts;
  return c;
}

export function deployment(name, ns, image = NGINX, { replicas = 1, labels, containers, command, ports, volumes, extraSpec, annotations } = {}) {
  labels = labels || { app: name };
  const spec = { terminationGracePeriodSeconds: GRACE, containers: containers || [container(name, image, { command, ports })] };
  if (volumes) spec.volumes = volumes;
  if (extraSpec) Object.assign(spec, extraSpec);
  return { apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta(name, ns, labels, annotations), spec: { replicas, selector: { matchLabels: { ...labels } }, template: { metadata: { labels: { ...labels } }, spec } } };
}

export function pod(name, ns, image = NGINX, { labels, command, containers, volumes, extraSpec } = {}) {
  const spec = { terminationGracePeriodSeconds: GRACE, containers: containers || [container(name, image, { command })] };
  if (volumes) spec.volumes = volumes;
  if (extraSpec) Object.assign(spec, extraSpec);
  return { apiVersion: 'v1', kind: 'Pod', metadata: meta(name, ns, labels || { app: name }), spec };
}

export function service(name, ns, selector, { port = 80, target = 80, type, portName } = {}) {
  const p = { port, targetPort: target, protocol: 'TCP' };
  if (portName) p.name = portName;
  const spec = { selector: { ...selector }, ports: [p] };
  if (type) spec.type = type;
  return { apiVersion: 'v1', kind: 'Service', metadata: meta(name, ns), spec };
}

export function configmap(name, ns, data) { return { apiVersion: 'v1', kind: 'ConfigMap', metadata: meta(name, ns), data: { ...data } }; }

// nginx zwracający stały tekst dla każdej ścieżki
export function echoApp(name, ns, body, { replicas = 1, labels, svcPort, hostNetworkPort, node } = {}) {
  labels = labels || { app: name };
  const listen = hostNetworkPort || 80;
  const conf = `server {\n  listen ${listen};\n  location / {\n    default_type text/plain;\n    return 200 '${body}\\n';\n  }\n}\n`;
  const cm = configmap(`${name}-conf`, ns, { 'default.conf': conf });
  const extra = {};
  if (hostNetworkPort) { extra.hostNetwork = true; extra.dnsPolicy = 'ClusterFirstWithHostNet'; }
  if (node) extra.nodeSelector = { 'kubernetes.io/hostname': node };
  const c = container(name, NGINX, { ports: [listen], mounts: [{ name: 'conf', mountPath: '/etc/nginx/conf.d' }] });
  const d = deployment(name, ns, NGINX, { replicas, labels, containers: [c], volumes: [{ name: 'conf', configMap: { name: `${name}-conf` } }], extraSpec: extra });
  const objs = [cm, d];
  if (svcPort) objs.push(service(name, ns, labels, { port: svcPort, target: 80 }));
  return objs;
}
