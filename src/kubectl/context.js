// kubeconfig, tożsamość i połączenie z API server.
import { parseOne } from '../lib/yaml.js';
import { b64dec, ExitError, b64enc, hex } from '../lib/util.js';
import { certInfo, fingerprint } from '../sim/pki.js';
import { authorize } from '../sim/rbac.js';

export class KubeError extends ExitError {}

export function kubeconfigPath(sh, flags) {
  if (flags.kubeconfig) return { path: sh.abs(flags.kubeconfig), explicit: true };
  const env = sh.vars.get('KUBECONFIG');
  if (env) return { path: sh.abs(env.split(':')[0]), explicit: false, env: true };
  return { path: `${sh.home}/.kube/config`, explicit: false };
}

export function readKubeconfig(sh, flags, { allowMissing = true, create = false } = {}) {
  const { path, explicit } = kubeconfigPath(sh, flags);
  let text;
  try {
    text = sh.fs.read(path, sh.user);
  } catch (e) {
    if (e.code === 'EACCES') throw new KubeError(1, `error: error loading config file "${path}": open ${path}: permission denied`);
    if (explicit && !create) throw new KubeError(1, `error: stat ${path}: no such file or directory`);
    if (!allowMissing) throw new KubeError(1, 'error: current-context is not set');
    return { path, cfg: { apiVersion: 'v1', kind: 'Config', clusters: [], contexts: [], users: [], 'current-context': '', preferences: {} }, missing: true };
  }
  let cfg;
  try { cfg = parseOne(text) || {}; } catch (e) {
    throw new KubeError(1, `error: error loading config file "${path}": ${e.message.replace(/^error converting YAML to JSON: /, '')}`);
  }
  for (const k of ['clusters', 'contexts', 'users']) cfg[k] = cfg[k] || [];
  return { path, cfg };
}

export function writeKubeconfig(sh, path, cfg, dump) {
  sh.fs.write(path, dump(cfg, { sort: false }), { user: sh.user, mode: 0o600 });
}

// zwraca {server, user, namespace, ctxName}
export function resolveContext(sh, flags) {
  const { path, cfg, missing } = readKubeconfig(sh, flags);
  const ctxName = flags.context || cfg['current-context'] || '';
  let ctx = null;
  if (ctxName) {
    ctx = (cfg.contexts || []).find((x) => x.name === ctxName)?.context;
    if (!ctx) {
      if (flags.context) throw new KubeError(1, `error: context "${ctxName}" does not exist`);
      // current-context wskazuje na nieistniejący kontekst
      throw new KubeError(1, `error: current-context "${ctxName}" does not exist in kubeconfig`);
    }
  }
  const clusterName = flags.cluster || ctx?.cluster;
  const cluster = (cfg.clusters || []).find((x) => x.name === clusterName)?.cluster || null;
  const userName = flags.user || ctx?.user;
  const user = (cfg.users || []).find((x) => x.name === userName)?.user || null;
  const server = flags.server || cluster?.server || '';
  return { path, cfg, missing, ctxName, ctx, cluster, clusterName, user, userName, server, namespace: flags.namespace || ctx?.namespace || 'default' };
}

function fileOrData(sh, data, file) {
  if (data) { try { return b64dec(data); } catch { return null; } }
  if (file) { try { return sh.fs.read(sh.abs(file), sh.user); } catch { return undefined; } }
  return null;
}

// --------------------------------------------------------------------- tokeny SA
export function makeToken(ns, sa, exp, aud = ['https://kubernetes.default.svc.cluster.local']) {
  const head = b64enc(JSON.stringify({ alg: 'RS256', kid: 'sim' })).replace(/=+$/, '');
  const body = b64enc(JSON.stringify({ aud, exp: Math.floor(exp / 1000), iss: 'https://kubernetes.default.svc.cluster.local', 'kubernetes.io': { namespace: ns, serviceaccount: { name: sa } }, sub: `system:serviceaccount:${ns}:${sa}` })).replace(/=+$/, '');
  return `${head}.${body}.${hex(43)}`;
}
export function parseToken(t) {
  try {
    const parts = String(t).split('.');
    const pad = (s) => s + '='.repeat((4 - (s.length % 4)) % 4);
    return JSON.parse(b64dec(pad(parts[1])));
  } catch { return null; }
}

// --------------------------------------------------------------------- połączenie
// zwraca {user: {name, groups}, server}
export function connect(sh, flags, c) {
  const k = resolveContext(sh, flags);
  let server = k.server;
  if (!server) server = 'http://localhost:8080';
  const m = server.match(/^(https?):\/\/([^/:]+)(?::(\d+))?/);
  if (!m) throw new KubeError(1, `error: invalid server address "${server}"`);
  const scheme = m[1], host = m[2];
  const port = Number(m[3] || (scheme === 'https' ? 443 : 80));
  const hostPort = `${host}:${port}`;
  // rozwiązywanie nazwy
  const h = sh.ctx?.host;
  let ip = host;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const hostsFile = h?.fs?.tryRead('/etc/hosts') || '';
    const line = hostsFile.split('\n').find((l) => l.split(/\s+/).slice(1).includes(host));
    if (line) ip = line.split(/\s+/)[0];
    else if (host === 'localhost') ip = '127.0.0.1';
    else if (Object.values(c.hosts).some((x) => x.name === host)) ip = Object.values(c.hosts).find((x) => x.name === host).ip;
    else throw new KubeError(1, `Unable to connect to the server: dial tcp: lookup ${host} on 127.0.0.53:53: no such host`);
  }
  if (ip === '127.0.0.1' && h) ip = h.ip;
  const cp = Object.values(c.hosts).find((x) => x.role === 'control-plane');
  const refused = () => new KubeError(1, `The connection to the server ${hostPort} was refused - did you specify the right host or port?`);
  const isApi = (ip === cp?.ip && port === 6443) || ((ip === '10.96.0.1') && port === 443);
  if (!isApi) {
    if (Object.values(c.hosts).some((x) => x.ip === ip)) throw refused();
    throw new KubeError(1, `Unable to connect to the server: dial tcp ${hostPort}: i/o timeout`);
  }
  if (!c.apiAvailable()) throw refused();
  if (scheme === 'http') throw new KubeError(1, 'Error from server (BadRequest): the server rejects plain HTTP connections');
  // CA
  if (!flags['insecure-skip-tls-verify'] && !k.cluster?.['insecure-skip-tls-verify']) {
    const caPem = fileOrData(sh, k.cluster?.['certificate-authority-data'], flags['certificate-authority'] || k.cluster?.['certificate-authority']);
    const realCa = cp.fs.tryRead('/etc/kubernetes/pki/ca.crt');
    if (caPem === undefined) throw new KubeError(1, `error: unable to read certificate-authority ${k.cluster?.['certificate-authority']} for ${k.clusterName} due to open ${k.cluster?.['certificate-authority']}: no such file or directory`);
    if (caPem && realCa && fingerprint(caPem) !== fingerprint(realCa)) throw new KubeError(1, 'Unable to connect to the server: tls: failed to verify certificate: x509: certificate signed by unknown authority');
    if (!caPem) throw new KubeError(1, 'Unable to connect to the server: tls: failed to verify certificate: x509: certificate signed by unknown authority');
  }
  // tożsamość
  const now = c.now();
  const unauthorized = () => new KubeError(1, 'error: You must be logged in to the server (Unauthorized)');
  let user = null;
  const token = flags.token || k.user?.token || (k.user?.tokenFile ? h?.fs?.tryRead(k.user.tokenFile)?.trim() : null);
  if (token) {
    const t = parseToken(token);
    if (!t || !t.sub) throw unauthorized();
    if (t.exp && t.exp * 1000 < now) throw unauthorized();
    const [, , ns, name] = t.sub.split(':');
    if (!c.peek('serviceaccounts', ns, name)) throw unauthorized();
    user = { name: t.sub, groups: ['system:serviceaccounts', `system:serviceaccounts:${ns}`, 'system:authenticated'] };
  } else {
    const certPem = fileOrData(sh, k.user?.['client-certificate-data'], flags['client-certificate'] || k.user?.['client-certificate']);
    const keyPem = fileOrData(sh, k.user?.['client-key-data'], flags['client-key'] || k.user?.['client-key']);
    if (certPem === undefined) throw new KubeError(1, `error: unable to read client-cert ${k.user['client-certificate']} for ${k.userName} due to open ${k.user['client-certificate']}: no such file or directory`);
    if (keyPem === undefined) throw new KubeError(1, `error: unable to read client-key ${k.user['client-key']} for ${k.userName} due to open ${k.user['client-key']}: no such file or directory`);
    if (!certPem) {
      if (k.missing || !k.ctx) throw new KubeError(1, 'The connection to the server localhost:8080 was refused - did you specify the right host or port?');
      // anonim
      throw new KubeError(1, 'Error from server (Forbidden): forbidden: User "system:anonymous" cannot get path "/api"');
    }
    const info = certInfo(certPem);
    if (!info) throw new KubeError(1, 'error: tls: failed to find any PEM data in certificate input');
    if (!keyPem) throw new KubeError(1, 'error: tls: failed to find any PEM data in key input');
    const caInfo = certInfo(cp.fs.tryRead('/etc/kubernetes/pki/ca.crt') || '');
    if (info.iss !== (caInfo?.cn || 'kubernetes')) throw unauthorized();
    if (info.na < now || info.nb > now + 300000) throw unauthorized();
    user = { name: info.cn, groups: [...(info.o || []), 'system:authenticated'] };
  }
  // impersonacja
  if (flags.as) {
    if (!authorize(c, user, { verb: 'impersonate', group: '', resource: flags.as.startsWith('system:serviceaccount:') ? 'serviceaccounts' : 'users', namespace: '', name: flags.as })) {
      throw new KubeError(1, `Error from server (Forbidden): users "${flags.as}" is forbidden: User "${user.name}" cannot impersonate resource "users" in API group "" at the cluster scope`);
    }
    const sa = flags.as.match(/^system:serviceaccount:([^:]+):(.+)$/);
    user = { name: flags.as, groups: [...(flags['as-group'] || []), ...(sa ? ['system:serviceaccounts', `system:serviceaccounts:${sa[1]}`] : []), 'system:authenticated'] };
  }
  return { user, server: hostPort, namespace: k.namespace, k };
}
