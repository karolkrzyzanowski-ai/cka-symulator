// Uzupełnianie Tab: polecenia, ścieżki, kubectl (podpolecenia, typy, nazwy obiektów), systemctl, ssh.
import { CORE, NET } from '../shell/commands/index.js';
import { BUILTINS } from '../shell/interp.js';
import { COMMANDS as KUBECTL } from '../kubectl/index.js';
import { resolveContext } from '../kubectl/context.js';

const EXTRA_HOST = ['ssh', 'sudo', 'su', 'systemctl', 'journalctl', 'crictl', 'apt', 'apt-get', 'apt-cache', 'apt-mark', 'dpkg', 'sysctl', 'modprobe', 'lsmod',
  'swapoff', 'swapon', 'reboot', 'shutdown', 'kubelet', 'containerd', 'ctr', 'kubeadm', 'etcdctl', 'etcdutl', 'openssl', 'hostnamectl', 'iptables', 'kubectl', 'helm', 'bash', 'sh'];

const KTYPES = ['pods', 'deployments', 'replicasets', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'services', 'endpoints', 'endpointslices', 'ingresses', 'ingressclasses',
  'networkpolicies', 'configmaps', 'secrets', 'serviceaccounts', 'namespaces', 'nodes', 'persistentvolumes', 'persistentvolumeclaims', 'storageclasses', 'roles',
  'rolebindings', 'clusterroles', 'clusterrolebindings', 'events', 'limitranges', 'resourcequotas', 'horizontalpodautoscalers', 'poddisruptionbudgets',
  'priorityclasses', 'customresourcedefinitions', 'certificatesigningrequests', 'leases', 'gatewayclasses', 'gateways', 'httproutes', 'all'];
const KSHORT = { po: 'pods', deploy: 'deployments', rs: 'replicasets', sts: 'statefulsets', ds: 'daemonsets', cj: 'cronjobs', svc: 'services', ep: 'endpoints', ing: 'ingresses',
  netpol: 'networkpolicies', cm: 'configmaps', sa: 'serviceaccounts', ns: 'namespaces', no: 'nodes', pv: 'persistentvolumes', pvc: 'persistentvolumeclaims', sc: 'storageclasses',
  ev: 'events', limits: 'limitranges', quota: 'resourcequotas', hpa: 'horizontalpodautoscalers', pdb: 'poddisruptionbudgets', pc: 'priorityclasses', crd: 'customresourcedefinitions', csr: 'certificatesigningrequests' };
const TYPED = new Set(['get', 'describe', 'delete', 'edit', 'label', 'annotate', 'patch', 'scale', 'explain', 'wait', 'set', 'autoscale', 'expose']);
const POD_CMDS = new Set(['logs', 'exec', 'attach', 'port-forward', 'cp', 'debug']);
const NODE_CMDS = new Set(['cordon', 'uncordon', 'drain', 'taint']);
const CREATE_SUB = ['clusterrole', 'clusterrolebinding', 'configmap', 'cronjob', 'deployment', 'ingress', 'job', 'namespace', 'poddisruptionbudget', 'priorityclass', 'quota',
  'role', 'rolebinding', 'secret', 'service', 'serviceaccount', 'token'];
const SUBSUB = {
  rollout: ['history', 'pause', 'restart', 'resume', 'status', 'undo'],
  config: ['current-context', 'delete-context', 'get-contexts', 'rename-context', 'set', 'set-cluster', 'set-context', 'set-credentials', 'unset', 'use-context', 'view'],
  auth: ['can-i', 'reconcile', 'whoami'],
  set: ['env', 'image', 'resources', 'selector', 'serviceaccount', 'subject'],
  certificate: ['approve', 'deny'],
  top: ['node', 'pod'],
  secret: ['docker-registry', 'generic', 'tls'],
  service: ['clusterip', 'externalname', 'loadbalancer', 'nodeport'],
};
const OUTPUTS = ['yaml', 'json', 'wide', 'name', 'jsonpath=', 'custom-columns=', 'go-template='];
const KFLAGS = ['--all-namespaces', '--dry-run=client', '--dry-run=server', '--output=', '--namespace=', '--selector=', '--show-labels', '--watch', '--filename=', '--force',
  '--grace-period=0', '--image=', '--replicas=', '--port=', '--target-port=', '--type=', '--overwrite', '--record', '--to-revision=', '--container=', '--previous',
  '--tail=', '--ignore-daemonsets', '--delete-emptydir-data', '--from-literal=', '--from-file=', '--verb=', '--resource=', '--role=', '--clusterrole=',
  '--serviceaccount=', '--user=', '--group=', '--as=', '--recursive', '--sort-by=', '--field-selector=', '--labels=', '--restart=Never', '--rm', '--command', '--env=',
  '--requests=', '--limits=', '--schedule=', '--timeout=', '--for=condition=', '--kubeconfig=', '--context=', '--server-side'];
const SYSTEMCTL = ['daemon-reload', 'disable', 'enable', 'is-active', 'is-enabled', 'list-units', 'mask', 'restart', 'show', 'start', 'status', 'stop', 'unmask', 'cat'];
const UNITS = ['kubelet', 'containerd', 'ssh', 'systemd-resolved'];
const HOSTS = ['cka-cp1', 'cka-w1', 'cka-w2'];

// prosta tokenizacja ostatniego polecenia w linii (do kursora)
function tokenize(s) {
  const out = [];
  let cur = '', q = null, started = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; started = true; continue; }
    if (ch === '\\' && i + 1 < s.length) { cur += s[++i]; started = true; continue; }
    if (/\s/.test(ch)) { if (started || cur) out.push(cur); cur = ''; started = false; continue; }
    if ('|;&()'.includes(ch)) { if (started || cur) out.push(cur); cur = ''; started = false; out.push({ sep: ch }); continue; }
    cur += ch; started = true;
  }
  return { words: out, current: cur, quote: q };
}

function commonPrefix(list) {
  if (!list.length) return '';
  let p = list[0];
  for (const s of list) { while (!s.startsWith(p)) p = p.slice(0, -1); }
  return p;
}

function allCommandNames(sh) {
  const names = new Set([...Object.keys(CORE), ...Object.keys(NET), ...EXTRA_HOST, ...Object.keys(BUILTINS), ...sh.aliases.keys()]);
  return [...names].filter((n) => BUILTINS[n] || sh.aliases.has(n) || sh.opts.commands?.(n, sh));
}

function pathCands(sh, word, { dirsOnly = false } = {}) {
  let dirPart = '', base = word;
  const slash = word.lastIndexOf('/');
  if (slash >= 0) { dirPart = word.slice(0, slash + 1); base = word.slice(slash + 1); }
  const dirAbs = sh.abs(dirPart || '.');
  let names;
  try { names = sh.fs.list(dirAbs, sh.user); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.startsWith(base)) continue;
    if (n.startsWith('.') && !base.startsWith('.')) continue;
    const full = `${dirAbs.replace(/\/$/, '')}/${n}`;
    const isDir = sh.fs.isDir(full);
    if (dirsOnly && !isDir) continue;
    out.push({ text: dirPart + n + (isDir ? '/' : ''), dir: isDir, label: n + (isDir ? '/' : '') });
  }
  return out;
}

function clusterOf(sh) { return sh.ctx?.cluster || null; }

function namesOf(sh, type, ns) {
  const c = clusterOf(sh);
  if (!c) return [];
  try {
    const r = c.registry.resolve(KSHORT[type] || type);
    if (!r) return [];
    const items = c.list(r, r.namespaced ? ns : null) || [];
    return items.map((o) => o.metadata?.name).filter(Boolean).sort();
  } catch { return []; }
}

function kubeNs(sh, words) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if ((w === '-n' || w === '--namespace') && typeof words[i + 1] === 'string') return words[i + 1];
    const m = typeof w === 'string' && w.match(/^(?:--namespace=|-n=?)(.+)$/);
    if (m && w !== '-n') return m[1];
    if (w === '-A' || w === '--all-namespaces') return null;
  }
  try { return resolveContext(sh, {}).namespace || 'default'; } catch { return 'default'; }
}

function kubectlCands(sh, args, cur) {
  // args: słowa po "kubectl"
  const prev = args[args.length - 1];
  if (prev === '-n' || prev === '--namespace') return namesOf(sh, 'namespaces');
  if (prev === '-o' || prev === '--output') return OUTPUTS;
  if (prev === '-f' || prev === '--filename' || prev === '-k' || prev === '--kustomize') return null; // ścieżki
  if (prev === '--context') return [];
  if (cur.startsWith('--')) {
    if (cur.startsWith('--namespace=')) return namesOf(sh, 'namespaces').map((n) => `--namespace=${n}`);
    if (cur.startsWith('--output=') || cur.startsWith('-o=')) return OUTPUTS.map((o) => cur.replace(/=.*/, '=') + o);
    if (cur.startsWith('--filename=')) return null;
    return KFLAGS;
  }
  if (cur.startsWith('-')) return [];
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') continue;
    if (['-n', '--namespace', '-o', '--output', '-f', '--filename', '-l', '--selector', '-c', '--container', '--context', '--image', '--type', '-p'].includes(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  const ns = kubeNs(sh, args);
  if (!pos.length) return Object.keys(KUBECTL).filter((k) => !k.startsWith('__')).concat(['apply', 'cluster-info', 'kustomize']).filter((v, i, a) => a.indexOf(v) === i).sort();
  const cmd = pos[0];
  if (cmd === 'create') {
    if (pos.length === 1) return CREATE_SUB;
    if (pos.length === 2 && SUBSUB[pos[1]]) return SUBSUB[pos[1]];
    return [];
  }
  if (SUBSUB[cmd] && pos.length === 1) return SUBSUB[cmd];
  if (cmd === 'rollout') {
    if (pos.length === 2) return ['deployment', 'daemonset', 'statefulset', 'deployment/', 'daemonset/', 'statefulset/'];
    return typeNameCands(sh, pos[2], cur, ns);
  }
  if (cmd === 'top') return pos[1] === 'node' ? namesOf(sh, 'nodes') : namesOf(sh, 'pods', ns);
  if (cmd === 'config') {
    if (['use-context', 'delete-context', 'rename-context'].includes(pos[1])) {
      try { return (resolveContext(sh, {}).cfg?.contexts || []).map((c) => c.name); } catch { return []; }
    }
    return [];
  }
  if (NODE_CMDS.has(cmd)) return namesOf(sh, 'nodes');
  if (POD_CMDS.has(cmd)) {
    if (cur.includes('/')) return typeNameCands(sh, null, cur, ns);
    return namesOf(sh, 'pods', ns);
  }
  if (cmd === 'set' && pos.length >= 2) {
    if (pos.length === 2) return ['deployment', 'daemonset', 'statefulset', 'pod'];
    return typeNameCands(sh, pos[2], cur, ns);
  }
  if (TYPED.has(cmd)) {
    if (cur.includes('/')) return typeNameCands(sh, null, cur, ns);
    if (pos.length === 1) return [...KTYPES, ...Object.keys(KSHORT)].sort();
    if (pos[1].includes('/') || pos[1].includes(',')) return [];
    return namesOf(sh, pos[1], ns);
  }
  return [];
}

function typeNameCands(sh, type, cur, ns) {
  if (cur.includes('/')) {
    const [t] = cur.split('/');
    return namesOf(sh, t, ns).map((n) => `${t}/${n}`);
  }
  return type ? namesOf(sh, type, ns) : [];
}

// zwraca {value, list} - nowa wartość linii i ewentualna lista propozycji do wyświetlenia
export function complete(sh, line, cursor = line.length) {
  const head = line.slice(0, cursor), tail = line.slice(cursor);
  const { words, current, quote } = tokenize(head);
  // ostatnie polecenie
  let start = 0;
  words.forEach((w, i) => { if (typeof w === 'object') start = i + 1; });
  let cmdWords = words.slice(start).filter((w) => typeof w === 'string');
  // sudo/watch/time/xargs - dalsze słowo jest poleceniem
  while (cmdWords.length && ['sudo', 'watch', 'time', 'xargs', 'nohup', 'timeout'].includes(cmdWords[0])) {
    cmdWords = cmdWords.slice(1);
    if (cmdWords[0] === '-n' || cmdWords[0] === '-u') cmdWords = cmdWords.slice(2);
    while (cmdWords.length && /^-|^\d+s?$/.test(cmdWords[0])) cmdWords = cmdWords.slice(1);
  }
  let cands = null; // null = ścieżki
  let isPath = false;
  if (!cmdWords.length) {
    if (current.includes('/') || current.startsWith('.') || current.startsWith('~')) cands = null;
    else cands = allCommandNames(sh);
  } else {
    let cmd = cmdWords[0];
    const alias = sh.aliases.get(cmd);
    let args = cmdWords.slice(1);
    if (alias) { const at = alias.trim().split(/\s+/); cmd = at[0]; args = [...at.slice(1), ...args]; }
    if (cmd === 'kubectl') cands = kubectlCands(sh, args, current);
    else if (cmd === 'systemctl') cands = args.filter((a) => !a.startsWith('-')).length ? UNITS : SYSTEMCTL;
    else if (cmd === 'journalctl') cands = args[args.length - 1] === '-u' ? UNITS : null;
    else if (cmd === 'ssh' || cmd === 'scp' || cmd === 'ping') cands = args.length ? null : [...HOSTS, 'root@cka-cp1', 'root@cka-w1', 'root@cka-w2'];
    else if (cmd === 'cd' || cmd === 'mkdir' || cmd === 'rmdir') { cands = pathCands(sh, current, { dirsOnly: true }); isPath = true; }
    else if (cmd === 'helm' && !args.filter((a) => !a.startsWith('-')).length) cands = ['create', 'dependency', 'env', 'get', 'history', 'install', 'lint', 'list', 'pull', 'repo', 'rollback', 'search', 'show', 'status', 'template', 'uninstall', 'upgrade', 'version'];
    else if (cmd === 'crictl' && !args.length) cands = ['images', 'info', 'inspect', 'inspectp', 'logs', 'pods', 'ps', 'pull', 'rm', 'rmi', 'stats', 'stop', 'version'];
    else if (cmd === 'kubeadm' && !args.length) cands = ['certs', 'config', 'init', 'join', 'reset', 'token', 'upgrade', 'version'];
    else if (cmd === 'etcdctl' && !args.filter((a) => !a.startsWith('-')).length && !current.startsWith('-')) cands = ['endpoint', 'get', 'member', 'snapshot', 'version'];
    else if ((cmd === 'etcdctl' || cmd === 'etcdutl') && current.startsWith('--')) cands = ['--endpoints=https://127.0.0.1:2379', '--cacert=', '--cert=', '--key=', '--data-dir=', '--write-out=table'];
  }
  if (cands === null) { cands = pathCands(sh, current); isPath = true; }
  const items = isPath ? cands : cands.map((t) => ({ text: t, label: t }));
  const matches = items.filter((i) => i.text.startsWith(current));
  const before = head.slice(0, head.length - current.length - (quote ? 1 : 0)) + (quote || '');
  if (!matches.length) return { value: line, cursor, list: null };
  if (matches.length === 1) {
    const m = matches[0];
    const open = m.dir || /[=/]$/.test(m.text);
    const v = before + escapeWord(m.text, quote) + (open ? '' : quote ? `${quote} ` : ' ') + tail;
    return { value: v, cursor: v.length - tail.length, list: null };
  }
  const pre = commonPrefix(matches.map((m) => m.text));
  if (pre.length > current.length) {
    const v = before + escapeWord(pre, quote) + tail;
    return { value: v, cursor: v.length - tail.length, list: null };
  }
  const labels = [...new Set(matches.map((m) => m.label))];
  return { value: line, cursor, list: labels };
}

function escapeWord(w, quote) {
  if (quote) return w;
  return w.replace(/([ \t"'$`\\!&;|<>()*?])/g, '\\$1');
}
