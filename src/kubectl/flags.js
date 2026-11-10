// Parser flag w stylu pflag (cobra) dla kubectl.
// typy: b - bool, s - string, a - string powtarzalny, i - int, d - dry-run (wymaga wartości)

export const LONG = {
  // globalne
  namespace: 's', kubeconfig: 's', context: 's', cluster: 's', user: 's', server: 's', token: 's', as: 's', 'as-group': 'a', 'as-uid': 's',
  'insecure-skip-tls-verify': 'b', 'certificate-authority': 's', 'client-certificate': 's', 'client-key': 's', 'request-timeout': 's', v: 's', 'log-flush-frequency': 's',
  'all-namespaces': 'b', help: 'b', client: 'b', 'api-version': 's',
  // wyjście
  output: 's', 'show-labels': 'b', 'label-columns': 'a', 'no-headers': 'b', 'sort-by': 's', watch: 'b', 'watch-only': 'b', 'show-kind': 'b', 'output-watch-events': 'b', 'show-managed-fields': 'b', 'chunk-size': 's', 'ignore-not-found': 'b', raw: 's', 'server-print': 'b',
  selector: 's', 'field-selector': 's', filename: 'a', recursive: 'b', kustomize: 's', subresource: 's', template: 's',
  // tworzenie / zmiany
  'dry-run': 'd', 'save-config': 'b', validate: 's', 'field-manager': 's', 'server-side': 'b', 'force-conflicts': 'b', prune: 'b', overwrite: 'b', all: 'b', local: 'b', record: 'b', 'edit-last-applied': 'b', 'windows-line-endings': 'b', 'output-patch': 'b',
  image: 's', port: 's', replicas: 's', env: 'a', labels: 's', restart: 's', command: 'b', rm: 'b', stdin: 'b', tty: 'b', attach: 'b', expose: 'b', 'image-pull-policy': 's', 'pod-running-timeout': 's', annotations: 'a', overrides: 's', privileged: 'b', quiet: 'b',
  'target-port': 's', protocol: 's', type: 's', name: 's', 'external-ip': 's', 'cluster-ip': 's', 'load-balancer-ip': 's', 'session-affinity': 's', 'node-port': 's', tcp: 'a', 'external-name': 's',
  'from-literal': 'a', 'from-file': 'a', 'from-env-file': 'a', 'append-hash': 'b', cert: 's', key: 's', 'docker-server': 's', 'docker-username': 's', 'docker-password': 's', 'docker-email': 's',
  verb: 'a', resource: 'a', 'resource-name': 'a', 'aggregation-rule': 's', 'non-resource-url': 'a', clusterrole: 's', role: 's', serviceaccount: 'a', group: 'a',
  schedule: 's', 'concurrency-policy': 's', from: 's', hard: 's', scopes: 's', value: 's', 'global-default': 'b', description: 's', 'preemption-policy': 's',
  rule: 'a', class: 's', 'default-backend': 's', 'min-available': 's', 'max-unavailable': 's', duration: 's', 'bound-object-kind': 's', 'bound-object-name': 's', audience: 'a',
  'current-replicas': 's', 'resource-version': 's', timeout: 's', min: 's', max: 's', 'cpu-percent': 's', cpu: 's', memory: 's',
  containers: 'b', limits: 's', requests: 's', 'use-protocol-buffers': 'b', 'sort-by-cpu': 'b',
  patch: 's', 'patch-file': 's', force: 'b', 'grace-period': 's', now: 'b', wait: 's', cascade: 'o', 'ignore-daemonsets': 'b', 'delete-emptydir-data': 'b', 'disable-eviction': 'b', 'skip-wait-for-delete-timeout': 's', 'pod-selector': 's',
  container: 's', previous: 'b', follow: 'b', tail: 's', since: 's', 'since-time': 's', timestamps: 'b', 'all-containers': 'b', prefix: 'b', 'max-log-requests': 's', 'limit-bytes': 's', 'ignore-errors': 'b', 'pod-running-timeout2': 's',
  'to-revision': 's', revision: 's', 'change-cause': 's',
  for: 's', list: 'b', 'no-headers2': 'b', 'api-group': 's', namespaced: 's', verbs: 'a', recursive2: 'b', 'output-version': 's',
  minify: 'b', flatten: 'b', current: 'b', 'set-raw-bytes': 's', 'embed-certs': 'b', 'client-certificate2': 's',
  target: 's', profile: 's', 'share-processes': 'b', 'copy-to': 's', 'set-image': 'a', 'keep-labels': 'b', 'env-from': 's', 'show-events': 'b', 'chunk-size2': 's', 'for-object': 's', types: 'a', event: 'a', 'all-namespaces2': 'b', 'no-preserve': 'b', retries: 's', address: 'a', 'enable-helm': 'b', 'load-restrictor': 's', 'show-hidden-metrics-for-version': 's', 'warnings-as-errors': 'b', 'disable-compression': 'b', 'match-server-version': 'b', 'tls-server-name': 's', password: 's', username: 's', 'kustomize2': 's', 'auth-provider': 's', 'exec-command': 's', 'deprecated': 'b', 'skip-headers': 'b',
};

// skróty globalne
const GLOBAL_SHORT = { n: 'namespace', s: 'server', A: 'all-namespaces', h: 'help', v: 'v' };

// skróty zależne od polecenia
const CMD_SHORT = {
  get: { o: 'output', l: 'selector', w: 'watch', f: 'filename', R: 'recursive', L: 'label-columns', k: 'kustomize' },
  describe: { l: 'selector', f: 'filename', R: 'recursive', k: 'kustomize' },
  create: { o: 'output', f: 'filename', R: 'recursive', k: 'kustomize', l: 'selector' },
  apply: { o: 'output', f: 'filename', R: 'recursive', k: 'kustomize', l: 'selector' },
  replace: { o: 'output', f: 'filename', R: 'recursive', k: 'kustomize' },
  delete: { f: 'filename', R: 'recursive', k: 'kustomize', l: 'selector', o: 'output' },
  edit: { o: 'output', f: 'filename', R: 'recursive', k: 'kustomize' },
  patch: { o: 'output', f: 'filename', R: 'recursive', k: 'kustomize', p: 'patch' },
  label: { o: 'output', f: 'filename', R: 'recursive', k: 'kustomize', l: 'selector' },
  annotate: { o: 'output', f: 'filename', R: 'recursive', k: 'kustomize', l: 'selector' },
  scale: { o: 'output', f: 'filename', R: 'recursive', k: 'kustomize', l: 'selector' },
  autoscale: { o: 'output', f: 'filename', R: 'recursive', k: 'kustomize' },
  expose: { o: 'output', f: 'filename', R: 'recursive', k: 'kustomize', l: 'labels' },
  run: { o: 'output', l: 'labels', i: 'stdin', t: 'tty', q: 'quiet' },
  set: { o: 'output', f: 'filename', R: 'recursive', k: 'kustomize', l: 'selector', e: 'env', c: 'containers2' },
  logs: { f: 'follow', p: 'previous', c: 'container', l: 'selector' },
  exec: { c: 'container', i: 'stdin', t: 'tty', q: 'quiet', f: 'filename' },
  attach: { c: 'container', i: 'stdin', t: 'tty', q: 'quiet' },
  cp: { c: 'container' },
  top: { l: 'selector' },
  rollout: { o: 'output', f: 'filename', R: 'recursive', k: 'kustomize', l: 'selector', w: 'watch' },
  wait: { o: 'output', f: 'filename', R: 'recursive', l: 'selector' },
  taint: { o: 'output', l: 'selector' },
  cordon: { l: 'selector' },
  uncordon: { l: 'selector' },
  drain: { l: 'selector' },
  auth: { o: 'output' },
  config: { o: 'output' },
  'api-resources': { o: 'output' },
  explain: {},
  certificate: { o: 'output', f: 'filename', R: 'recursive', k: 'kustomize' },
  kustomize: { o: 'output' },
  debug: { i: 'stdin', t: 'tty', q: 'quiet', c: 'container', f: 'filename' },
  events: { o: 'output', w: 'watch' },
  version: { o: 'output' },
  diff: { f: 'filename', R: 'recursive', k: 'kustomize', l: 'selector' },
  'port-forward': {},
};
// rozwinięcia flag zależnych od polecenia
const CMD_LONG = {
  set: { containers2: 's', containers: 's' },
  top: { containers: 'b' },
  autoscale: { name: 's' },
  'create-role': {},
  debug: { image: 's' },
  config: { raw: 'b', namespace: 's' },
};

export class FlagError extends Error {}

// parsuje całą linię; zwraca { cmd, pos:[], flags:{}, dash:[] }
export function parseArgs(argv) {
  // znajdź polecenie (pierwsze słowo nie będące flagą globalną ani jej wartością)
  let cmd = null, cmdIdx = -1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') break;
    if (a.startsWith('--')) {
      const name = a.slice(2).split('=')[0];
      if (!a.includes('=') && ['s', 'a', 'i'].includes(LONG[name]) && Object.prototype.hasOwnProperty.call(LONG, name) && isGlobalLong(name)) i++;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      const ch = a[1];
      if ((ch === 'n' || ch === 's') && a.length === 2) i++;
      continue;
    }
    cmd = a; cmdIdx = i; break;
  }
  const shorts = { ...GLOBAL_SHORT, ...(CMD_SHORT[cmd] || {}) };
  const longs = { ...LONG, ...(CMD_LONG[cmd] || {}) };
  const flags = {}, pos = [], dash = [];
  let dashSeen = false;
  const setFlag = (name, val, type) => {
    if (type === 'a') (flags[name] = flags[name] || []).push(val);
    else flags[name] = val;
  };
  for (let i = 0; i < argv.length; i++) {
    if (i === cmdIdx) continue;
    const a = argv[i];
    if (dashSeen) { dash.push(a); continue; }
    if (a === '--') { dashSeen = true; continue; }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const type = longs[name];
      if (!type) throw new FlagError(`unknown flag: --${name}`);
      if (type === 'b') {
        const v = eq > 0 ? a.slice(eq + 1) : 'true';
        if (!['true', 'false', '1', '0', 't', 'f', 'True', 'False'].includes(v)) throw new FlagError(`invalid argument "${v}" for "--${name}" flag: strconv.ParseBool: parsing "${v}": invalid syntax`);
        flags[name] = ['true', '1', 't', 'True'].includes(v);
      } else if (type === 'd') {
        flags[name] = eq > 0 ? a.slice(eq + 1) : 'unchanged';
      } else if (type === 'o') {
        flags[name] = eq > 0 ? a.slice(eq + 1) : 'background';
      } else {
        let v;
        if (eq > 0) v = a.slice(eq + 1);
        else {
          if (i + 1 >= argv.length) throw new FlagError(`flag needs an argument: --${name}`);
          v = argv[++i];
        }
        setFlag(name, v, type);
      }
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        const name = shorts[ch];
        if (!name) throw new FlagError(`unknown shorthand flag: '${ch}' in ${a}`);
        const type = longs[name] || 's';
        if (type === 'b') { flags[name] = true; continue; }
        let v = a.slice(j + 1);
        if (v.startsWith('=')) v = v.slice(1);
        if (!v) {
          if (i + 1 >= argv.length) throw new FlagError(`flag needs an argument: '${ch}' in -${ch}`);
          v = argv[++i];
        }
        setFlag(name, v, type);
        break;
      }
      continue;
    }
    pos.push(a);
  }
  return { cmd, pos, flags, dash, dashSeen };
}

function isGlobalLong(n) {
  return ['namespace', 'kubeconfig', 'context', 'cluster', 'user', 'server', 'token', 'as', 'as-group', 'request-timeout', 'v', 'certificate-authority', 'client-certificate', 'client-key'].includes(n);
}

// pomocnicze
export const flagStr = (f, k) => (f[k] === undefined ? undefined : String(f[k]));
export const flagArr = (f, k) => (f[k] === undefined ? [] : Array.isArray(f[k]) ? f[k] : [f[k]]);
