// helm (podzbiór): repozytoria, instalacja wbudowanych chartów, wydania jako Secrety.
import { connect } from '../../kubectl/context.js';
import { ApiError } from '../../sim/cluster.js';
import { parseOne, parseAll, dump } from '../../lib/yaml.js';
import { b64enc, b64dec, clone, hexHash } from '../../lib/util.js';
import { certManagerCrds } from '../../sim/crds.js';

const HELM_VERSION = 'v4.3.1';

// ------------------------------------------------------------------ katalog chartów
const CHARTS = {
  podinfo: {
    repo: 'https://stefanprodan.github.io/podinfo', versions: ['6.17.0', '6.16.1', '6.15.0'], app: (v) => v, description: 'Podinfo Helm chart for Kubernetes',
    values: (v) => ({ replicaCount: 1, logLevel: 'info', host: null, backend: null, ui: { color: '#34577c', message: '', logo: '' }, faults: { delay: false, error: false, unhealthy: false, unready: false }, image: { repository: 'ghcr.io/stefanprodan/podinfo', tag: v, pullPolicy: 'IfNotPresent' }, service: { enabled: true, annotations: {}, type: 'ClusterIP', metricsPort: 9797, httpPort: 9898, externalPort: 9898, grpcPort: 9999, nodePort: 31198 }, ingress: { enabled: false, className: '', hosts: [] }, serviceAccount: { enabled: false, name: null }, resources: { limits: null, requests: { cpu: '1m', memory: '16Mi' } }, nodeSelector: {}, tolerations: [], affinity: {}, podAnnotations: {} }),
    render: (rel, ns, v, cv) => {
      const full = rel.includes('podinfo') ? rel : `${rel}-podinfo`;
      const labels = { 'app.kubernetes.io/name': full, 'app.kubernetes.io/version': cv, 'helm.sh/chart': `podinfo-${cv}`, 'app.kubernetes.io/managed-by': 'Helm' };
      const out = [];
      if (v.service?.enabled !== false) {
        out.push({ src: 'podinfo/templates/service.yaml', obj: { apiVersion: 'v1', kind: 'Service', metadata: { name: full, labels, ...(v.service.annotations && Object.keys(v.service.annotations).length ? { annotations: v.service.annotations } : {}) }, spec: { type: v.service.type, ports: [{ port: Number(v.service.externalPort), targetPort: 'http', protocol: 'TCP', name: 'http', ...(v.service.type === 'NodePort' && v.service.nodePort ? { nodePort: Number(v.service.nodePort) } : {}) }, { port: Number(v.service.grpcPort), targetPort: 'grpc', protocol: 'TCP', name: 'grpc' }], selector: { 'app.kubernetes.io/name': full } } } });
      }
      const env = [{ name: 'PODINFO_UI_COLOR', value: v.ui?.color }];
      if (v.ui?.message) env.push({ name: 'PODINFO_UI_MESSAGE', value: String(v.ui.message) });
      if (v.ui?.logo) env.push({ name: 'PODINFO_UI_LOGO', value: v.ui.logo });
      out.push({ src: 'podinfo/templates/deployment.yaml', obj: { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: full, labels }, spec: { replicas: Number(v.replicaCount), strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1 } }, selector: { matchLabels: { 'app.kubernetes.io/name': full } }, template: { metadata: { labels: { 'app.kubernetes.io/name': full }, annotations: { 'prometheus.io/scrape': 'true', 'prometheus.io/port': '9898', ...(v.podAnnotations || {}) } }, spec: { terminationGracePeriodSeconds: 30, containers: [{ name: 'podinfo', image: `${v.image.repository}:${v.image.tag}`, imagePullPolicy: v.image.pullPolicy, command: ['./podinfo', `--port=${v.service.httpPort || 9898}`, `--port-metrics=${v.service.metricsPort}`, `--grpc-port=${v.service.grpcPort}`, '--grpc-service-name=podinfo', `--level=${v.logLevel}`, '--random-delay=false', '--random-error=false'], env, ports: [{ name: 'http', containerPort: Number(v.service.httpPort || 9898), protocol: 'TCP' }, { name: 'http-metrics', containerPort: 9797, protocol: 'TCP' }, { name: 'grpc', containerPort: 9999, protocol: 'TCP' }], livenessProbe: { exec: { command: ['podcli', 'check', 'http', `localhost:${v.service.httpPort || 9898}/healthz`] }, initialDelaySeconds: 1, timeoutSeconds: 5 }, readinessProbe: { exec: { command: ['podcli', 'check', 'http', `localhost:${v.service.httpPort || 9898}/readyz`] }, initialDelaySeconds: 1, timeoutSeconds: 5 }, resources: pruneNull(v.resources) }], ...(v.nodeSelector && Object.keys(v.nodeSelector).length ? { nodeSelector: v.nodeSelector } : {}), ...(v.tolerations?.length ? { tolerations: v.tolerations } : {}) } } } } });
      return out;
    },
    notes: (rel, ns, v) => `1. Get the application URL by running these commands:\n  echo "Visit http://127.0.0.1:8080 to use your application"\n  kubectl -n ${ns} port-forward deploy/${rel.includes('podinfo') ? rel : rel + '-podinfo'} 8080:${v.service.httpPort || 9898}`,
  },
  'cert-manager': {
    repo: 'https://charts.jetstack.io', versions: ['v1.21.3', 'v1.20.2'], app: (v) => v, description: 'A Helm chart for cert-manager',
    values: () => ({ crds: { enabled: false, keep: true }, installCRDs: false, replicaCount: 1, global: { leaderElection: { namespace: 'kube-system' } }, image: { repository: 'quay.io/jetstack/cert-manager-controller', tag: '' }, prometheus: { enabled: true } }),
    render: (rel, ns, v, cv) => {
      const out = [];
      if (v.crds?.enabled || v.installCRDs) for (const crd of certManagerCrds(cv)) out.push({ src: 'cert-manager/templates/crd-templates.yaml', obj: crd });
      for (const [name, image, extra] of [['cert-manager-cainjector', 'cert-manager-cainjector', {}], ['cert-manager', 'cert-manager-controller', { ports: [{ containerPort: 9402, name: 'http-metrics', protocol: 'TCP' }] }], ['cert-manager-webhook', 'cert-manager-webhook', { ports: [{ containerPort: 10250, name: 'https', protocol: 'TCP' }] }]]) {
        const comp = name === 'cert-manager' ? 'controller' : name.replace('cert-manager-', '');
        const labels = { app: name, 'app.kubernetes.io/name': name, 'app.kubernetes.io/instance': rel, 'app.kubernetes.io/component': comp, 'app.kubernetes.io/version': cv, 'app.kubernetes.io/managed-by': 'Helm', 'helm.sh/chart': `cert-manager-${cv}` };
        out.push({ src: `cert-manager/templates/${comp}-serviceaccount.yaml`, obj: { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name, namespace: ns, labels } } });
        out.push({ src: `cert-manager/templates/${comp}-deployment.yaml`, obj: { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels }, spec: { replicas: 1, selector: { matchLabels: { 'app.kubernetes.io/name': name, 'app.kubernetes.io/instance': rel, 'app.kubernetes.io/component': comp } }, template: { metadata: { labels }, spec: { serviceAccountName: name, containers: [{ name: `cert-manager-${comp}`, image: `quay.io/jetstack/${image}:${cv}`, imagePullPolicy: 'IfNotPresent', args: ['--v=2'], ...extra }], nodeSelector: { 'kubernetes.io/os': 'linux' } } } } } });
        if (comp !== 'cainjector') out.push({ src: `cert-manager/templates/${comp}-service.yaml`, obj: { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels }, spec: { type: 'ClusterIP', ports: [{ name: comp === 'webhook' ? 'https' : 'tcp-prometheus-servicemonitor', port: comp === 'webhook' ? 443 : 9402, protocol: 'TCP', targetPort: comp === 'webhook' ? 'https' : 'http-metrics' }], selector: { 'app.kubernetes.io/name': name, 'app.kubernetes.io/instance': rel, 'app.kubernetes.io/component': comp } } } });
      }
      return out;
    },
    notes: (rel, ns, v, cv) => `⚠️  WARNING: New default private key rotation policy for Certificate resources.\n\ncert-manager ${cv} has been deployed successfully!\n\nIn order to begin issuing certificates, you will need to set up a ClusterIssuer\nor Issuer resource (for example, by creating a 'letsencrypt-staging' issuer).${!(v.crds?.enabled || v.installCRDs) ? '\n\n⚠️  WARNING: CRDs were not installed (crds.enabled=false). Install them before creating Issuers.' : ''}`,
  },
  nginx: {
    repo: 'https://charts.bitnami.com/bitnami', versions: ['22.3.1', '22.1.0'], app: () => '1.29.3', description: 'NGINX Open Source is a web server that can be also used as a reverse proxy, load balancer, and HTTP cache.',
    values: () => ({ replicaCount: 1, image: { registry: 'docker.io', repository: 'nginx', tag: '1.29' }, service: { type: 'LoadBalancer', ports: { http: 80 } } }),
    render: (rel, ns, v, cv) => {
      const full = rel.includes('nginx') ? rel : `${rel}-nginx`;
      const labels = { 'app.kubernetes.io/name': 'nginx', 'app.kubernetes.io/instance': rel, 'app.kubernetes.io/managed-by': 'Helm', 'helm.sh/chart': `nginx-${cv}` };
      const sel = { 'app.kubernetes.io/name': 'nginx', 'app.kubernetes.io/instance': rel };
      return [
        { src: 'nginx/templates/svc.yaml', obj: { apiVersion: 'v1', kind: 'Service', metadata: { name: full, labels }, spec: { type: v.service.type, ports: [{ name: 'http', port: Number(v.service.ports?.http || 80), targetPort: 'http' }], selector: sel } } },
        { src: 'nginx/templates/deployment.yaml', obj: { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: full, labels }, spec: { replicas: Number(v.replicaCount), selector: { matchLabels: sel }, template: { metadata: { labels }, spec: { containers: [{ name: 'nginx', image: `${v.image.registry}/${v.image.repository}:${v.image.tag}`, ports: [{ name: 'http', containerPort: 80 }] }] } } } } },
      ];
    },
    notes: (rel) => `CHART NAME: nginx\n\n** Please be patient while the chart is being deployed **\nNGINX can be accessed through the following DNS name from within your cluster:\n\n    ${rel}-nginx.default.svc.cluster.local (port 80)`,
  },
};
const REPOS = { 'https://stefanprodan.github.io/podinfo': ['podinfo'], 'https://charts.jetstack.io': ['cert-manager'], 'https://charts.bitnami.com/bitnami': ['nginx'], 'oci://registry-1.docker.io/bitnamicharts': ['nginx'] };

function pruneNull(o) { if (!o || typeof o !== 'object') return o; const r = {}; for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) r[k] = typeof v === 'object' && !Array.isArray(v) ? pruneNull(v) : v; return r; }

function deepMerge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return clone(b);
  const out = a && typeof a === 'object' && !Array.isArray(a) ? clone(a) : {};
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : clone(v);
  return out;
}
function parseSet(s, asString) {
  const out = {};
  for (const part of s.split(/,(?=[\w.[\]-]+=)/)) {
    const i = part.indexOf('=');
    const path = part.slice(0, i), raw = part.slice(i + 1);
    let val = raw;
    if (!asString) { if (/^-?\d+(\.\d+)?$/.test(raw)) val = Number(raw); else if (raw === 'true' || raw === 'false') val = raw === 'true'; else if (raw === 'null') val = null; }
    const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    let cur = out;
    keys.forEach((k, j) => {
      if (j === keys.length - 1) cur[k] = val;
      else { cur[k] = cur[k] || (/^\d+$/.test(keys[j + 1]) ? [] : {}); cur = cur[k]; }
    });
  }
  return out;
}

// ------------------------------------------------------------------ stan (repo w ~/.config/helm)
function repoFile(sh) { return `${sh.home}/.config/helm/repositories.yaml`; }
function loadRepos(sh) {
  const t = sh.fs.tryRead(repoFile(sh));
  const y = t ? parseOne(t) || {} : {};
  return y.repositories || [];
}
function saveRepos(sh, list) {
  sh.fs.mkdir(`${sh.home}/.config/helm`, { p: true, user: sh.user });
  sh.fs.write(repoFile(sh), dump({ apiVersion: '', generated: '0001-01-01T00:00:00Z', repositories: list }, { sort: false }), { user: sh.user });
}

function releases(c, ns) {
  return c.all('secrets', ns || null).filter((s) => s.type === 'helm.sh/release.v1' && s.metadata.labels?.owner === 'helm').map((s) => { try { return { secret: s, rel: JSON.parse(b64dec(s.data.release)) }; } catch { return null; } }).filter(Boolean);
}
function latest(c, ns, name) {
  const rs = releases(c, ns).filter((r) => r.rel.name === name).sort((a, b) => b.rel.version - a.rel.version);
  return rs[0] || null;
}
function fmtTime(ms) { const d = new Date(ms); return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}.${String(ms % 1000).padStart(3, '0')}123456 +0000 UTC`; }
function deployedLine(ms) { const d = new Date(ms); return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()}`; }

function table(rows) {
  const w = [];
  for (const r of rows) r.forEach((x, i) => { w[i] = Math.max(w[i] || 0, String(x).length); });
  return rows.map((r) => r.map((x, i) => (i < r.length - 1 ? String(x).padEnd(w[i] + 1) : x)).join('\t')).join('\n') + '\n';
}

// ------------------------------------------------------------------ rozwiązywanie chartu
function resolveChart(sh, ref, version) {
  if (ref.startsWith('./') || ref.startsWith('/') || ref.startsWith('../') || (sh.fs.exists(sh.abs(ref)) && sh.fs.isDir(sh.abs(ref)))) {
    const dir = sh.abs(ref);
    const ch = parseOne(sh.fs.tryRead(`${dir}/Chart.yaml`) || '');
    if (!ch) return { error: `Error: INSTALLATION FAILED: path "${ref}" not found` };
    const def = CHARTS[ch.name];
    if (!def) return { error: `Error: INSTALLATION FAILED: symulator nie potrafi renderować chartu "${ch.name}"` };
    const local = parseOne(sh.fs.tryRead(`${dir}/values.yaml`) || '') || {};
    return { name: ch.name, def, version: ch.version, localValues: local };
  }
  if (ref.startsWith('oci://')) {
    const name = ref.split('/').pop();
    if (name === 'nginx-gateway-fabric') return { error: 'Error: INSTALLATION FAILED: cannot re-use a name that is still in use' };
    const def = CHARTS[name];
    if (!def) return { error: `Error: INSTALLATION FAILED: failed to do request: Head "https://${ref.slice(6).split('/')[0]}/v2/${ref.slice(6).split('/').slice(1).join('/')}/manifests/latest": dial tcp: lookup ${ref.slice(6).split('/')[0]}: no such host` };
    return { name, def, version: version || def.versions[0] };
  }
  const [repoName, chartName] = ref.split('/');
  if (!chartName) return { error: `Error: INSTALLATION FAILED: non-absolute URLs should be in form of repo_name/path_to_chart, got: ${ref}` };
  const repo = loadRepos(sh).find((r) => r.name === repoName);
  if (!repo) return { error: `Error: INSTALLATION FAILED: repo ${repoName} not found` };
  const charts = REPOS[repo.url] || [];
  if (!charts.includes(chartName)) return { error: `Error: INSTALLATION FAILED: chart "${chartName}" matching ${version || ''} not found in ${repoName} index. (try 'helm repo update'): no chart name found` };
  const def = CHARTS[chartName];
  const v = version ? def.versions.find((x) => x === version || x === `v${version}` || x.replace(/^v/, '') === version) : def.versions[0];
  if (!v) return { error: `Error: INSTALLATION FAILED: chart "${chartName}" matching ${version} not found in ${repoName} index. (try 'helm repo update'): no chart version found for ${chartName}-${version}` };
  return { name: chartName, def, version: v };
}

// ------------------------------------------------------------------ polecenie
export function* helm(args, io, sh) {
  const c = sh.ctx.cluster;
  const opts = { set: [], setString: [], values: [] };
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = () => (a.includes('=') && a.startsWith('--') ? a.slice(a.indexOf('=') + 1) : args[++i]);
    const name = a.startsWith('--') ? a.slice(2).split('=')[0] : (a.startsWith('-') ? `\u0000${a}` : `\u0001${a}`);
    if (a === '-n' || name === 'namespace') opts.ns = val();
    else if (name === 'set') opts.set.push(val());
    else if (name === 'set-string') opts.setString.push(val());
    else if (a === '-f' || name === 'values') opts.values.push(val());
    else if (name === 'version') opts.version = val();
    else if (name === 'create-namespace') opts.createNs = true;
    else if (name === 'dry-run') opts.dry = true;
    else if (name === 'wait') opts.wait = true;
    else if (name === 'timeout') opts.timeout = val();
    else if (name === 'install' || a === '-i') opts.install = true;
    else if (a === '-A' || name === 'all-namespaces') opts.all = true;
    else if (a === '-a' || name === 'all') opts.allValues = true;
    else if (name === 'reuse-values') opts.reuse = true;
    else if (name === 'reset-values') opts.reset = true;
    else if (name === 'untar') opts.untar = true;
    else if (name === 'versions') opts.versions = true;
    else if (a === '-o' || name === 'output') opts.output = val();
    else if (name === 'kubeconfig') opts.kubeconfig = val();
    else if (name === 'force-update' || name === 'atomic' || name === 'debug' || name === 'skip-crds' || name === 'devel' || name === 'no-hooks' || name === 'keep-history' || name === 'generate-name' || name === 'rollback-on-failure') opts[name] = true;
    else if (name === 'description' || name === 'repo' || name === 'username' || name === 'password' || name === 'untardir' || name === 'destination' || a === '-d') opts[name] = val();
    else if (a === '-h' || name === 'help') opts.help = true;
    else if (a.startsWith('-')) { io.eline(`Error: unknown flag: ${a}`); return 1; } else pos.push(a);
  }
  const sub = pos[0];
  if (!sub || opts.help) { io.line('The Kubernetes package manager\n\nUsage:\n  helm [command]\n\nAvailable Commands:\n  create, dependency, env, get, history, install, lint, list, package, pull, push, registry, repo, rollback, search, show, status, template, test, uninstall, upgrade, version'); return 0; }
  if (sub === 'version') { io.line(`version.BuildInfo{Version:"${HELM_VERSION}", GitCommit:"6f9d2a7e0c4a5b3d1e8f9a0b2c4d6e8f0a1b3c5d", GitTreeState:"clean", GoVersion:"go1.25.7", KubeClientVersion:"v1.37"}`); return 0; }
  if (sub === 'env') { io.line(`HELM_NAMESPACE="default"\nHELM_REPOSITORY_CONFIG="${repoFile(sh)}"\nHELM_CACHE_HOME="${sh.home}/.cache/helm"`); return 0; }
  if (sub === 'repo') {
    const act = pos[1];
    const list = loadRepos(sh);
    if (act === 'add') {
      const [, , name, url] = pos;
      if (!name || !url) { io.eline('Error: "helm repo add" requires 2 arguments'); return 1; }
      const ex = list.find((r) => r.name === name);
      if (ex && ex.url === url) { io.line(`"${name}" already exists with the same configuration, skipping`); return 0; }
      if (ex && !opts['force-update']) { io.eline(`Error: repository name (${name}) already exists, please specify a different name`); return 1; }
      if (!REPOS[url.replace(/\/$/, '')]) { yield { type: 'sleep', ms: 1500 }; io.eline(`Error: looks like "${url}" is not a valid chart repository or cannot be reached: failed to fetch ${url.replace(/\/$/, '')}/index.yaml : 404 Not Found`); return 1; }
      saveRepos(sh, [...list.filter((r) => r.name !== name), { name, url: url.replace(/\/$/, '') }]);
      io.line(`"${name}" has been added to your repositories`);
      return 0;
    }
    if (act === 'list' || act === 'ls') {
      if (opts.output === 'json') { io.line(JSON.stringify(list.map((r) => ({ name: r.name, url: r.url })))); return 0; }
      if (opts.output === 'yaml') { io.out(dump(list.map((r) => ({ name: r.name, url: r.url })), { sort: false })); return 0; }
      if (!list.length) { io.eline('Error: no repositories to show'); return 1; }
      io.out(table([['NAME', 'URL'], ...list.map((r) => [r.name, r.url])]));
      return 0;
    }
    if (act === 'update' || act === 'up') {
      if (!list.length) { io.eline('Error: no repositories found. You must add one before updating'); return 1; }
      io.line('Hang tight while we grab the latest from your chart repositories...');
      yield { type: 'sleep', ms: 1200 };
      for (const r of list) io.line(`...Successfully got an update from the "${r.name}" chart repository`);
      io.line('Update Complete. ⎈Happy Helming!⎈');
      return 0;
    }
    if (act === 'remove' || act === 'rm') {
      for (const n of pos.slice(2)) { if (!list.some((r) => r.name === n)) { io.eline(`Error: no repo named "${n}" found`); return 1; } io.line(`"${n}" has been removed from your repositories`); }
      saveRepos(sh, list.filter((r) => !pos.slice(2).includes(r.name)));
      return 0;
    }
    io.eline('Error: unknown command for "helm repo"');
    return 1;
  }
  if (sub === 'search') {
    if (pos[1] === 'hub') { io.out(table([['URL', 'CHART VERSION', 'APP VERSION', 'DESCRIPTION'], ...Object.entries(CHARTS).filter(([n]) => !pos[2] || n.includes(pos[2])).map(([n, d]) => [`https://artifacthub.io/packages/helm/${n}/${n}`, d.versions[0], d.app(d.versions[0]), d.description])])); return 0; }
    const kw = pos[2] || '';
    const rows = [['NAME', 'CHART VERSION', 'APP VERSION', 'DESCRIPTION']];
    for (const r of loadRepos(sh)) for (const ch of REPOS[r.url] || []) {
      const d = CHARTS[ch];
      if (kw && !`${r.name}/${ch}`.includes(kw) && !d.description.toLowerCase().includes(kw.toLowerCase())) continue;
      for (const v of opts.versions ? d.versions : [d.versions[0]]) rows.push([`${r.name}/${ch}`, v, d.app(v), d.description]);
    }
    if (rows.length === 1) { io.line('No results found'); return 0; }
    io.out(table(rows));
    return 0;
  }
  if (sub === 'show' || sub === 'inspect') {
    const r = resolveChart(sh, pos[2] || '', opts.version);
    if (r.error) { io.eline(r.error.replace('INSTALLATION FAILED: ', '')); return 1; }
    if (pos[1] === 'values') { io.out(dump({ ...r.def.values(r.version), ...(r.localValues || {}) }, { sort: false })); return 0; }
    if (pos[1] === 'chart' || pos[1] === 'all') { io.out(`apiVersion: v2\nappVersion: ${r.def.app(r.version)}\ndescription: ${r.def.description}\nname: ${r.name}\nversion: ${r.version.replace(/^v/, '')}\n`); return 0; }
    if (pos[1] === 'readme') { io.line(`# ${r.name}\n\n${r.def.description}`); return 0; }
    io.eline('Error: unknown command for "helm show"');
    return 1;
  }
  if (sub === 'pull' || sub === 'fetch') {
    const r = resolveChart(sh, pos[1] || '', opts.version);
    if (r.error) { io.eline(r.error.replace('INSTALLATION FAILED: ', '')); return 1; }
    const ver = r.version.replace(/^v/, '');
    const base = sh.abs(opts.untardir || opts.destination || opts.d || '.');
    if (opts.untar) {
      const dir = `${base}/${r.name}`;
      sh.fs.mkdir(`${dir}/templates`, { p: true, user: sh.user });
      sh.fs.write(`${dir}/Chart.yaml`, `apiVersion: v2\nappVersion: ${r.def.app(r.version)}\ndescription: ${r.def.description}\nname: ${r.name}\nversion: ${ver}\n`, { user: sh.user });
      sh.fs.write(`${dir}/values.yaml`, dump(r.def.values(r.version), { sort: false }), { user: sh.user });
      for (const d of r.def.render('RELEASE-NAME', 'default', r.def.values(r.version), r.version)) sh.fs.write(`${dir}/templates/${d.src.split('/').pop()}`, `# szablon (symulator - renderowany wewnętrznie)\n${dump(d.obj)}`, { user: sh.user });
    } else sh.fs.write(`${base}/${r.name}-${ver}.tgz`, `\x1f\x8bhelm-chart ${r.name} ${ver}`, { user: sh.user });
    return 0;
  }
  // ---- operacje na klastrze
  let conn;
  try { conn = connect(sh, { kubeconfig: opts.kubeconfig, namespace: opts.ns }, c); } catch (e) {
    io.eline(`Error: ${sub === 'install' ? 'INSTALLATION FAILED: ' : ''}Kubernetes cluster unreachable: ${String(e.message).replace(/^error: /, '')}`);
    return 1;
  }
  const user = conn.user;
  const ns = opts.ns || conn.namespace || 'default';
  const computeValues = (r, base = {}) => {
    let v = deepMerge(r.def.values(r.version), r.localValues || {});
    v = deepMerge(v, base);
    for (const f of opts.values) {
      let t;
      try { t = sh.fs.read(sh.abs(f), sh.user); } catch { throw new Error(`open ${f}: no such file or directory`); }
      v = deepMerge(v, parseOne(t) || {});
    }
    for (const s of opts.set) v = deepMerge(v, parseSet(s, false));
    for (const s of opts.setString) v = deepMerge(v, parseSet(s, true));
    return v;
  };
  const userSupplied = (base = {}) => {
    let u = clone(base);
    for (const f of opts.values) u = deepMerge(u, parseOne(sh.fs.read(sh.abs(f), sh.user)) || {});
    for (const s of opts.set) u = deepMerge(u, parseSet(s, false));
    for (const s of opts.setString) u = deepMerge(u, parseSet(s, true));
    return u;
  };
  const deploy = function* (name, r, values, user0, revision, prevManifest, description) {
    const docs = r.def.render(name, ns, values, r.version).map((d) => ({ ...d, obj: { ...d.obj, metadata: { ...d.obj.metadata, namespace: d.obj.kind === 'CustomResourceDefinition' ? undefined : d.obj.metadata.namespace || ns, labels: { ...(d.obj.metadata.labels || {}), 'app.kubernetes.io/managed-by': 'Helm' }, annotations: { ...(d.obj.metadata.annotations || {}), 'meta.helm.sh/release-name': name, 'meta.helm.sh/release-namespace': ns } } } }));
    for (const d of docs) if (d.obj.kind === 'CustomResourceDefinition') { delete d.obj.metadata.namespace; }
    const manifest = docs.map((d) => `---\n# Source: ${d.src}\n${dump(d.obj, { sort: false })}`).join('');
    if (opts.dry) return { manifest, docs };
    // zastosuj
    const keep = new Set();
    for (const d of [...docs].sort((a, b) => (a.obj.kind === 'CustomResourceDefinition' ? -1 : 0) - (b.obj.kind === 'CustomResourceDefinition' ? -1 : 0))) {
      const reg = c.registry.byKindAnyVersion(d.obj.apiVersion, d.obj.kind);
      const ons = reg?.namespaced ? d.obj.metadata.namespace : null;
      keep.add(`${d.obj.kind}/${ons}/${d.obj.metadata.name}`);
      const live = reg && c.peek(reg, ons, d.obj.metadata.name);
      if (live) {
        if (!live.metadata.annotations?.['meta.helm.sh/release-name'] && revision === 1) throw new ApiError(409, 'Conflict', `rendered manifests contain a resource that already exists. Unable to continue with install: ${d.obj.kind} "${d.obj.metadata.name}" in namespace "${ns}" exists and cannot be imported into the current release: invalid ownership metadata; label validation error: missing key "app.kubernetes.io/managed-by": must be set to "Helm"`);
        const n = { ...clone(live), ...clone(d.obj), metadata: { ...live.metadata, labels: d.obj.metadata.labels, annotations: { ...(live.metadata.annotations || {}), ...d.obj.metadata.annotations } } };
        c.update(n, { user });
      } else c.create(clone(d.obj), { user, ns: d.obj.metadata.namespace || ns });
      if (d.obj.kind === 'CustomResourceDefinition') c.reconcile();
    }
    // usuń zasoby, których nie ma w nowej wersji
    for (const d of prevManifest || []) {
      const reg = c.registry.byKindAnyVersion(d.apiVersion, d.kind);
      const ons = reg?.namespaced ? d.metadata.namespace || ns : null;
      if (!keep.has(`${d.kind}/${ons}/${d.metadata.name}`) && reg && c.peek(reg, ons, d.metadata.name)) c.delete(reg, ons, d.metadata.name, { user });
    }
    const now = c.now();
    for (const old of releases(c, ns).filter((x) => x.rel.name === name && x.rel.status === 'deployed')) {
      old.rel.status = 'superseded';
      old.secret.data.release = b64enc(JSON.stringify(old.rel));
      old.secret.metadata.labels.status = 'superseded';
      c.put(old.secret);
    }
    const rel = { name, namespace: ns, version: revision, chart: r.name, chartVersion: r.version, appVersion: r.def.app(r.version), status: 'deployed', values: user0, computed: values, updated: now, description, manifest: docs.map((d) => d.obj), notes: r.def.notes(name, ns, values, r.version) };
    c.create({ apiVersion: 'v1', kind: 'Secret', type: 'helm.sh/release.v1', metadata: { name: `sh.helm.release.v1.${name}.v${revision}`, namespace: ns, labels: { name, owner: 'helm', status: 'deployed', version: String(revision) } }, data: { release: b64enc(JSON.stringify(rel)) } }, { user });
    c.reconcile();
    if (opts.wait) {
      const t0 = c.now();
      const limit = opts.timeout ? (parseFloat(opts.timeout) || 300) * (/m$/.test(opts.timeout) ? 60 : 1) * 1000 : 300000;
      while (c.now() - t0 < limit) {
        const notReady = docs.filter((d) => d.obj.kind === 'Deployment').some((d) => { const o = c.peek('deployments', ns, d.obj.metadata.name); return !o || (o.status?.readyReplicas || 0) < (o.spec.replicas ?? 1); });
        if (!notReady) break;
        yield { type: 'sleep', ms: 1000 };
      }
    }
    return { rel, manifest };
  };
  const printRelease = (rel, { manifest = null } = {}) => {
    io.line(`NAME: ${rel.name}\nLAST DEPLOYED: ${deployedLine(rel.updated ?? c.now())}\nNAMESPACE: ${rel.namespace}\nSTATUS: ${rel.status}\nREVISION: ${rel.version}${rel.description ? `\nDESCRIPTION: ${rel.description}` : ''}${manifest ? `\nTEST SUITE: None\nHOOKS:\nMANIFEST:\n${manifest}` : ''}${rel.notes ? `\nNOTES:\n${rel.notes}` : ''}`);
  };
  try {
    switch (sub) {
      case 'install': {
        let [, name, chart] = pos;
        if (opts['generate-name']) { chart = name; name = `${(chart || '').split('/').pop()}-${Math.floor(c.now() / 1000)}`; }
        if (!name || !chart) { io.eline(`Error: INSTALLATION FAILED: must either provide a name or specify --generate-name`); return 1; }
        if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 53) { io.eline(`Error: INSTALLATION FAILED: release name "${name}": invalid release name, must match regex ^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$ and the length must not be longer than 53`); return 1; }
        if (latest(c, ns, name) && latest(c, ns, name).rel.status !== 'uninstalled') { io.eline('Error: INSTALLATION FAILED: cannot re-use a name that is still in use'); return 1; }
        const r = resolveChart(sh, chart, opts.version);
        if (r.error) { io.eline(r.error); return 1; }
        if (!c.peek('namespaces', null, ns)) {
          if (!opts.createNs) { io.eline(`Error: INSTALLATION FAILED: create: failed to create: namespaces "${ns}" not found`); return 1; }
          if (!opts.dry) c.create({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns } }, { user });
        }
        const values = computeValues(r);
        const res = yield* deploy(name, r, values, userSupplied(), 1, null, 'Install complete');
        if (opts.dry) { io.line(`NAME: ${name}\nLAST DEPLOYED: ${deployedLine(c.now())}\nNAMESPACE: ${ns}\nSTATUS: pending-install\nREVISION: 1\nTEST SUITE: None\nHOOKS:\nMANIFEST:\n${res.manifest}\nNOTES:\n${r.def.notes(name, ns, values, r.version)}`); return 0; }
        printRelease(res.rel);
        return 0;
      }
      case 'upgrade': {
        const [, name, chart] = pos;
        if (!name || !chart) { io.eline('Error: "helm upgrade" requires 2 arguments'); return 1; }
        const cur = latest(c, ns, name);
        if (!cur) {
          if (!opts.install) { io.eline(`Error: UPGRADE FAILED: "${name}" has no deployed releases`); return 1; }
          io.line(`Release "${name}" does not exist. Installing it now.`);
          return yield* helm(['install', name, chart, ...args.filter((a) => a !== 'upgrade' && a !== name && a !== chart && a !== '--install' && a !== '-i')], io, sh);
        }
        const r = resolveChart(sh, chart, opts.version);
        if (r.error) { io.eline(r.error.replace('INSTALLATION', 'UPGRADE')); return 1; }
        const base = opts.reuse ? cur.rel.values || {} : {};
        const values = computeValues(r, base);
        const res = yield* deploy(name, r, values, userSupplied(base), cur.rel.version + 1, cur.rel.manifest, 'Upgrade complete');
        if (opts.dry) { io.out(res.manifest); return 0; }
        io.line(`Release "${name}" has been upgraded. Happy Helming!`);
        printRelease(res.rel);
        return 0;
      }
      case 'uninstall': case 'delete': case 'un': case 'del': {
        for (const name of pos.slice(1)) {
          const cur = latest(c, ns, name);
          if (!cur) { io.eline(`Error: uninstall: Release not loaded: ${name}: release: not found`); return 1; }
          for (const d of cur.rel.manifest || []) {
            const reg = c.registry.byKindAnyVersion(d.apiVersion, d.kind);
            if (!reg || d.kind === 'CustomResourceDefinition') continue;
            const ons = reg.namespaced ? d.metadata.namespace || ns : null;
            if (c.peek(reg, ons, d.metadata.name)) c.delete(reg, ons, d.metadata.name, { user });
          }
          for (const s of releases(c, ns).filter((x) => x.rel.name === name)) c.delete('secrets', ns, s.secret.metadata.name, { user });
          c.reconcile();
          if (cur.rel.manifest?.some((d) => d.kind === 'CustomResourceDefinition')) io.line('These resources were kept due to the resource policy:\n' + cur.rel.manifest.filter((d) => d.kind === 'CustomResourceDefinition').map((d) => `[CustomResourceDefinition] ${d.metadata.name}`).join('\n') + '\n');
          io.line(`release "${name}" uninstalled`);
        }
        return 0;
      }
      case 'list': case 'ls': {
        const all = releases(c, opts.all ? null : ns);
        const byName = new Map();
        for (const r of all) { const k = `${r.rel.namespace}/${r.rel.name}`; if (!byName.has(k) || byName.get(k).rel.version < r.rel.version) byName.set(k, r); }
        const rows = [['NAME', 'NAMESPACE', 'REVISION', 'UPDATED', 'STATUS', 'CHART', 'APP VERSION']];
        for (const { rel } of [...byName.values()].sort((a, b) => a.rel.name.localeCompare(b.rel.name))) rows.push([rel.name, rel.namespace, String(rel.version), fmtTime(rel.updated || 0), rel.status, `${rel.chart}-${String(rel.chartVersion).replace(/^v(?=\d)/, rel.chart === 'cert-manager' ? 'v' : '')}`, rel.appVersion]);
        if (opts.output === 'json') { io.line(JSON.stringify([...byName.values()].map(({ rel }) => ({ name: rel.name, namespace: rel.namespace, revision: String(rel.version), status: rel.status, chart: `${rel.chart}-${rel.chartVersion}`, app_version: rel.appVersion })))); return 0; }
        io.out(table(rows));
        return 0;
      }
      case 'status': {
        const cur = latest(c, ns, pos[1]);
        if (!cur) { io.eline('Error: release: not found'); return 1; }
        printRelease(cur.rel);
        return 0;
      }
      case 'get': {
        const what = pos[1];
        const cur = latest(c, ns, pos[2]);
        if (!cur) { io.eline('Error: release: not found'); return 1; }
        if (what === 'values') {
          if (opts.output === 'json') { io.line(JSON.stringify(opts.allValues ? cur.rel.computed : cur.rel.values || {})); return 0; }
          if (opts.allValues) { io.line('COMPUTED VALUES:'); io.out(dump(cur.rel.computed || {}, { sort: true })); } else { io.line('USER-SUPPLIED VALUES:'); io.out(Object.keys(cur.rel.values || {}).length ? dump(cur.rel.values, { sort: true }) : 'null\n'); }
          return 0;
        }
        if (what === 'manifest') { io.out((cur.rel.manifest || []).map((o) => `---\n${dump(o, { sort: false })}`).join('')); return 0; }
        if (what === 'notes') { io.line(`NOTES:\n${cur.rel.notes || ''}`); return 0; }
        if (what === 'all') { printRelease(cur.rel); return 0; }
        io.eline('Error: unknown command for "helm get"');
        return 1;
      }
      case 'history': case 'hist': {
        const rs = releases(c, ns).filter((x) => x.rel.name === pos[1]).sort((a, b) => a.rel.version - b.rel.version);
        if (!rs.length) { io.eline('Error: release: not found'); return 1; }
        io.out(table([['REVISION', 'UPDATED', 'STATUS', 'CHART', 'APP VERSION', 'DESCRIPTION'], ...rs.map(({ rel }) => [String(rel.version), deployedLine(rel.updated || 0), rel.status, `${rel.chart}-${rel.chartVersion}`, rel.appVersion, rel.description || ''])]));
        return 0;
      }
      case 'rollback': {
        const name = pos[1];
        const rs = releases(c, ns).filter((x) => x.rel.name === name).sort((a, b) => a.rel.version - b.rel.version);
        if (!rs.length) { io.eline('Error: release: not found'); return 1; }
        const curRel = rs[rs.length - 1].rel;
        const target = pos[2] ? rs.find((x) => x.rel.version === Number(pos[2]))?.rel : rs[rs.length - 2]?.rel;
        if (!target) { io.eline(`Error: release has no ${pos[2] || 'previous'} version`); return 1; }
        const def = CHARTS[target.chart];
        yield* deploy(name, { name: target.chart, def, version: target.chartVersion }, target.computed, target.values, curRel.version + 1, curRel.manifest, `Rollback to ${target.version}`);
        io.line('Rollback was a success! Happy Helming!');
        return 0;
      }
      case 'template': {
        const [, name, chart] = pos;
        const r = resolveChart(sh, chart || name, opts.version);
        if (r.error) { io.eline(r.error.replace('INSTALLATION FAILED: ', '')); return 1; }
        const values = computeValues(r);
        io.out(r.def.render(chart ? name : 'release-name', ns, values, r.version).map((d) => `---\n# Source: ${d.src}\n${dump(d.obj, { sort: false })}`).join(''));
        return 0;
      }
      case 'lint': io.line('==> Linting .\n[INFO] Chart.yaml: icon is recommended\n\n1 chart(s) linted, 0 chart(s) failed'); return 0;
      default: io.eline(`Error: unknown command "${sub}" for "helm"\nRun 'helm --help' for usage.`); return 1;
    }
  } catch (e) {
    const prefix = sub === 'install' ? 'INSTALLATION FAILED: ' : sub === 'upgrade' ? 'UPGRADE FAILED: ' : '';
    if (e instanceof ApiError) { io.eline(`Error: ${prefix}${e.message}`); return 1; }
    if (e instanceof Error && !(e.constructor?.name === 'ExitSignal')) { io.eline(`Error: ${prefix}${e.message}`); return 1; }
    throw e;
  }
}
void parseAll; void hexHash;
