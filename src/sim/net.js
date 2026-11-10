// Sieć klastra: DNS (CoreDNS), Service/NodePort, NetworkPolicy, HTTP (nginx, Ingress, Gateway API).
import { matchLabelSelector, rand } from '../lib/util.js';
import { allListening } from './kubelet.js';
import { NGINX_PAGE } from './images.js';

export const KUBE_DNS_IP = '10.96.0.10';
const EXTERNAL = { 'google.com': '142.250.186.46', 'www.google.com': '142.250.186.68', 'github.com': '140.82.121.4', 'kubernetes.io': '147.75.40.148', 'example.com': '93.184.215.14', 'registry.k8s.io': '34.96.108.209', 'docker.io': '54.236.113.205', 'cloud.google.com': '142.250.74.110' };

// ------------------------------------------------------------------ wyszukiwanie obiektów po IP
export function podRtByIP(c, ip) {
  return Object.values(c.runtime).find((r) => r.ip === ip && !r.spec.hostNetwork && r.state !== 'gone' && r.sandbox) || null;
}
const hostByIP = (c, ip) => Object.values(c.hosts).find((h) => h.ip === ip && h.role !== 'base') || null;
const serviceByIP = (c, ip) => c.all('services').find((s) => s.spec?.clusterIP === ip) || null;
function podObj(c, rt) { return rt.static ? c.peek('pods', rt.ns, rt.name) : c.peek('pods', rt.ns, rt.name); }

function inCidr(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const n = Number(bits ?? 32);
  const toInt = (x) => x.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

// ------------------------------------------------------------------ NetworkPolicy
function nsLabels(c, ns) { return c.peek('namespaces', null, ns)?.metadata?.labels || { 'kubernetes.io/metadata.name': ns }; }

function peerMatches(c, peer, policyNs, other) {
  if (peer.ipBlock) {
    if (!other.ip || !inCidr(other.ip, peer.ipBlock.cidr)) return false;
    return !(peer.ipBlock.except || []).some((e) => inCidr(other.ip, e));
  }
  if (!other.pod) return false;
  const nsOk = peer.namespaceSelector ? matchLabelSelector(peer.namespaceSelector, nsLabels(c, other.pod.ns)) || (isEmpty(peer.namespaceSelector)) : other.pod.ns === policyNs;
  if (!nsOk) return false;
  if (peer.podSelector) return isEmpty(peer.podSelector) || matchLabelSelector(peer.podSelector, other.pod.labels);
  return true;
}
const isEmpty = (sel) => !sel || (!Object.keys(sel.matchLabels || {}).length && !(sel.matchExpressions || []).length);

function portMatches(rulePorts, port, proto, dstRt) {
  if (!rulePorts || !rulePorts.length) return true;
  return rulePorts.some((p) => {
    if ((p.protocol || 'TCP') !== proto) return false;
    if (p.port === undefined) return true;
    let num = p.port;
    if (typeof num === 'string' && !/^\d+$/.test(num)) {
      num = null;
      for (const ct of dstRt?.spec?.containers || []) for (const cp of ct.ports || []) if (cp.name === p.port) num = cp.containerPort;
      if (num === null) return false;
    }
    num = Number(num);
    if (p.endPort) return port >= num && port <= p.endPort;
    return port === num;
  });
}

const selects = (np, pod) => np.metadata.namespace === pod.ns && (isEmpty(np.spec?.podSelector) || matchLabelSelector(np.spec.podSelector, pod.labels));
const types = (np) => np.spec?.policyTypes || (np.spec?.egress ? ['Ingress', 'Egress'] : ['Ingress']);

// src/dst: {pod:{ns, labels, rt}, ip}
export function netpolAllows(c, src, dst, port, proto = 'TCP') {
  const nps = c.all('networkpolicies');
  if (src.pod) {
    const eg = nps.filter((np) => types(np).includes('Egress') && selects(np, src.pod));
    if (eg.length && !eg.some((np) => (np.spec.egress || []).some((r) => (!r.to?.length || r.to.some((peer) => peerMatches(c, peer, np.metadata.namespace, dst))) && portMatches(r.ports, port, proto, dst.pod?.rt)))) return false;
  }
  if (dst.pod) {
    // ruch z węzła, na którym działa pod (kubelet, sondy) jest zawsze dozwolony
    if (!src.pod && src.ip && c.hosts[dst.pod.rt.node]?.ip === src.ip) return true;
    const ing = nps.filter((np) => types(np).includes('Ingress') && selects(np, dst.pod));
    if (ing.length && !ing.some((np) => (np.spec.ingress || []).some((r) => (!r.from?.length || r.from.some((peer) => peerMatches(c, peer, np.metadata.namespace, src))) && portMatches(r.ports, port, proto, dst.pod.rt)))) return false;
  }
  return true;
}

function podIdent(c, rt) {
  const p = podObj(c, rt);
  return { pod: { ns: rt.ns, labels: p?.metadata?.labels || rt.meta?.labels || {}, rt }, ip: rt.ip };
}

// ------------------------------------------------------------------ Corefile
export function parseCorefile(text) {
  const blocks = [];
  if (!text) return blocks;
  const src = text.replace(/#.*$/gm, '');
  let i = 0;
  const readBlock = () => {
    let depth = 0, start = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { i++; return src.slice(start, i); } }
    }
    throw new Error('Unexpected EOF');
  };
  while (i < src.length) {
    const m = src.slice(i).match(/^\s*([^\s{]+(?:\s+[^\s{]+)*)\s*\{/);
    if (!m) { if (src.slice(i).trim()) throw new Error(`Corefile: parse error near "${src.slice(i).trim().slice(0, 20)}"`); break; }
    const keys = m[1].trim().split(/\s+/);
    i += m[0].length - 1;
    const body = readBlock().slice(1, -1);
    const plugins = parsePlugins(body);
    blocks.push({ zones: keys.map((k) => k.replace(/^(dns:\/\/)?/, '').replace(/:\d+$/, '').replace(/\.$/, '') || '.'), plugins });
  }
  return blocks;
}

function parsePlugins(body) {
  const out = [];
  const lines = body.split('\n');
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k].trim();
    if (!l) continue;
    const [name, ...args] = l.replace(/\{\s*$/, '').trim().split(/\s+/);
    const p = { name, args, body: [] };
    if (l.endsWith('{')) {
      let depth = 1;
      while (++k < lines.length) {
        const x = lines[k].trim();
        if (x.endsWith('{')) depth++;
        if (x === '}') { depth--; if (depth === 0) break; }
        p.body.push(x);
      }
    }
    out.push(p);
  }
  return out;
}

function zoneMatch(name, zone) {
  if (zone === '.' || zone === '') return true;
  return name === zone || name.endsWith('.' + zone);
}

// odpowiedź serwera CoreDNS dla FQDN (bez kropki końcowej)
function coreResolve(c, fqdn, depth = 0) {
  const blocks = c.meta.corefileBlocks || [];
  let best = null, bestLen = -1;
  for (const b of blocks) for (const z of b.zones) if (zoneMatch(fqdn, z) && (z === '.' ? 0 : z.length) > bestLen) { best = b; bestLen = z === '.' ? 0 : z.length; }
  if (!best) return { rcode: 'REFUSED' };
  for (const p of best.plugins) {
    if (p.name === 'hosts') {
      const entries = [];
      let fall = false;
      for (const l of p.body) {
        const parts = l.split(/\s+/);
        if (parts[0] === 'fallthrough') fall = true;
        else if (/^\d+\.\d+\.\d+\.\d+$/.test(parts[0])) for (const n of parts.slice(1)) entries.push([n.replace(/\.$/, ''), parts[0]]);
      }
      const zones = p.args.filter((a) => !a.startsWith('/'));
      const inZone = zones.length ? zones.some((z) => zoneMatch(fqdn, z.replace(/\.$/, ''))) : true;
      if (!inZone) continue;
      const hit = entries.filter(([n]) => n === fqdn).map(([, ip]) => ip);
      if (hit.length) return { rcode: 'NOERROR', ips: hit };
      if (!fall) return { rcode: 'NXDOMAIN' };
    }
    if (p.name === 'kubernetes') {
      const zones = p.args.length ? p.args : best.zones;
      const kz = zones.map((z) => z.replace(/\.$/, '')).find((z) => z !== 'in-addr.arpa' && z !== 'ip6.arpa' && zoneMatch(fqdn, z));
      if (kz) {
        const r = k8sRecord(c, fqdn, kz, depth);
        if (r) return r;
        if (!p.body.some((x) => x.startsWith('fallthrough') && (x.split(/\s+/).length === 1 || x.split(/\s+/).slice(1).some((z) => zoneMatch(fqdn, z))))) return { rcode: 'NXDOMAIN' };
      }
    }
    if (p.name === 'rewrite') {
      // rewrite name A B
      const a = p.args;
      if (a[0] === 'name' && a.length >= 3) {
        const [from, to] = a[1] === 'exact' || a[1] === 'regex' ? [a[2], a[3]] : [a[1], a[2]];
        if (fqdn === from.replace(/\.$/, '') && depth < 3) return coreResolve(c, to.replace(/\.$/, ''), depth + 1);
      }
    }
    if (p.name === 'forward') {
      if (EXTERNAL[fqdn]) return { rcode: 'NOERROR', ips: [EXTERNAL[fqdn]] };
      const h = Object.values(c.hosts).find((x) => x.name === fqdn && x.role !== 'base');
      if (h) return { rcode: 'NOERROR', ips: [h.ip] };
      return { rcode: 'NXDOMAIN' };
    }
  }
  return { rcode: 'NXDOMAIN' };
}

function k8sRecord(c, fqdn, zone, depth) {
  const rel = fqdn.slice(0, fqdn.length - zone.length - 1);
  const parts = rel.split('.');
  // <svc>.<ns>.svc / <host>.<svc>.<ns>.svc
  if (parts[parts.length - 1] === 'svc' && parts.length >= 3) {
    const ns = parts[parts.length - 2], svc = parts[parts.length - 3];
    const s = c.peek('services', ns, svc);
    if (!s) return { rcode: 'NXDOMAIN' };
    if (parts.length === 4) {
      const host = parts[0];
      const ips = endpointIPs(c, s, host);
      return ips.length ? { rcode: 'NOERROR', ips } : { rcode: 'NXDOMAIN' };
    }
    if (parts.length > 4) return { rcode: 'NXDOMAIN' };
    if (s.spec.type === 'ExternalName') {
      const r = depth < 3 ? coreResolve(c, s.spec.externalName.replace(/\.$/, ''), depth + 1) : { rcode: 'NXDOMAIN' };
      return { ...r, cname: s.spec.externalName };
    }
    if (s.spec.clusterIP === 'None') {
      const ips = endpointIPs(c, s);
      return ips.length ? { rcode: 'NOERROR', ips } : { rcode: 'NXDOMAIN' };
    }
    return { rcode: 'NOERROR', ips: [s.spec.clusterIP] };
  }
  if (parts[parts.length - 1] === 'pod' && parts.length === 3) {
    const ip = parts[0].replace(/-/g, '.');
    return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? { rcode: 'NOERROR', ips: [ip] } : { rcode: 'NXDOMAIN' };
  }
  return null;
}

function endpointIPs(c, s, hostname) {
  const out = [];
  for (const es of c.all('endpointslices', s.metadata.namespace)) {
    if (es.metadata.labels?.['kubernetes.io/service-name'] !== s.metadata.name) continue;
    for (const ep of es.endpoints || []) {
      if (ep.conditions?.ready === false && !s.spec.publishNotReadyAddresses) continue;
      if (hostname && ep.hostname !== hostname) {
        // StatefulSet: hostname poda = nazwa poda
        const p = ep.targetRef && c.peek('pods', ep.targetRef.namespace, ep.targetRef.name);
        if (!p || p.spec.hostname !== hostname) continue;
      }
      out.push(...(ep.addresses || []));
    }
  }
  return out;
}

// ------------------------------------------------------------------ DNS z perspektywy klienta
// src: {rt} (pod) lub {host}
export function dnsLookup(c, src, name, { searchOverride } = {}) {
  let resolv = null;
  if (src.rt) {
    const dnsHost = (src.rt.spec.hostNetwork && src.rt.spec.dnsPolicy !== 'ClusterFirstWithHostNet') || src.rt.spec.dnsPolicy === 'Default';
    if (!dnsHost) resolv = { ns: KUBE_DNS_IP, search: [`${src.rt.ns}.svc.cluster.local`, 'svc.cluster.local', 'cluster.local'], ndots: 5 };
  }
  const clean = name.replace(/\.$/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(clean)) return { ok: true, ips: [clean], fqdn: clean, server: resolv?.ns || '192.168.177.1' };
  // /etc/hosts
  const hostsFile = src.fs ? src.fs.tryRead('/etc/hosts') : src.host?.fs.tryRead('/etc/hosts');
  if (hostsFile) {
    for (const l of hostsFile.split('\n')) {
      const p = l.replace(/#.*/, '').trim().split(/\s+/);
      if (p.length > 1 && p.slice(1).includes(clean)) return { ok: true, ips: [p[0]], fqdn: clean, server: resolv?.ns || '192.168.177.1', fromHosts: true };
    }
  }
  if (!resolv) {
    // resolver hosta: dnsmasq libvirt zna węzły, internet - znane nazwy
    const h = Object.values(c.hosts).find((x) => x.name === clean && x.role !== 'base');
    if (h) return { ok: true, ips: [h.ip], fqdn: clean, server: '192.168.177.1' };
    if (EXTERNAL[clean]) return { ok: true, ips: [EXTERNAL[clean]], fqdn: clean, server: '192.168.177.1' };
    return { ok: false, error: 'NXDOMAIN', fqdn: clean, server: '192.168.177.1' };
  }
  // ścieżka do CoreDNS
  const reach = dnsReachable(c, src.rt);
  if (!reach.ok) return { ok: false, error: 'timeout', server: KUBE_DNS_IP };
  const candidates = [];
  const absolute = name.endsWith('.');
  const dots = (clean.match(/\./g) || []).length;
  const search = searchOverride || resolv.search;
  if (absolute) candidates.push(clean);
  else {
    if (dots >= resolv.ndots) candidates.push(clean);
    for (const s of search) candidates.push(`${clean}.${s}`);
    if (dots < resolv.ndots) candidates.push(clean);
  }
  for (const fq of candidates) {
    const r = coreResolve(c, fq);
    if (r.rcode === 'NOERROR' && r.ips?.length) return { ok: true, ips: r.ips, fqdn: fq, server: KUBE_DNS_IP, cname: r.cname };
    if (r.rcode === 'REFUSED') return { ok: false, error: 'REFUSED', server: KUBE_DNS_IP, fqdn: fq };
  }
  return { ok: false, error: 'NXDOMAIN', fqdn: candidates[candidates.length - 1], server: KUBE_DNS_IP };
}

function dnsReachable(c, srcRt) {
  const svc = serviceByIP(c, KUBE_DNS_IP);
  if (!svc) return { ok: false };
  if (!c.meta.corefileBlocks?.length) return { ok: false };
  const ips = endpointIPs(c, svc);
  const pods = ips.map((ip) => podRtByIP(c, ip)).filter((rt) => rt && allListening(rt).includes(53));
  if (!pods.length) return { ok: false };
  const src = podIdent(c, srcRt);
  return { ok: pods.some((dst) => netpolAllows(c, src, podIdent(c, dst), 53, 'UDP')) };
}

// ------------------------------------------------------------------ połączenia TCP
const rr = {};
function pickEndpoint(c, svc, sp) {
  const eps = [];
  for (const es of c.all('endpointslices', svc.metadata.namespace)) {
    if (es.metadata.labels?.['kubernetes.io/service-name'] !== svc.metadata.name) continue;
    const port = (es.ports || []).find((p) => (p.name || '') === (sp.name || '')) || ((es.ports || []).length === 1 && !sp.name ? es.ports[0] : null);
    if (!port) continue;
    for (const ep of es.endpoints || []) {
      if (ep.conditions?.ready === false) continue;
      for (const a of ep.addresses || []) eps.push({ ip: a, port: port.port });
    }
  }
  if (!eps.length) return null;
  const k = `${svc.metadata.namespace}/${svc.metadata.name}/${sp.port}`;
  rr[k] = ((rr[k] ?? Math.floor(rand() * eps.length)) + 1) % eps.length;
  return eps[rr[k]];
}

// zwraca {ok, rt?, port, kind?, error: 'refused'|'timeout'|'unreachable'}
export function connect(c, src, ip, port, proto = 'TCP') {
  let tip = ip, tport = port;
  const svc = serviceByIP(c, ip);
  const node = hostByIP(c, ip);
  if (svc) {
    const sp = (svc.spec.ports || []).find((p) => p.port === port && (p.protocol || 'TCP') === proto);
    if (!sp) return { ok: false, error: 'timeout' };
    const ep = pickEndpoint(c, svc, sp);
    if (!ep) return { ok: false, error: 'refused' };
    tip = ep.ip; tport = ep.port;
  } else if (node) {
    const np = c.all('services').find((s) => (s.spec.ports || []).some((p) => p.nodePort === port));
    if (np) {
      const sp = np.spec.ports.find((p) => p.nodePort === port);
      const ep = pickEndpoint(c, np, sp);
      if (!ep) return { ok: false, error: 'refused' };
      tip = ep.ip; tport = ep.port;
      src = { ...src, pod: null, ip: node.ip, viaNodePort: true };
    } else {
      if (port === 6443 && node.role === 'control-plane') return c.apiAvailable() ? { ok: true, kind: 'apiserver', port } : { ok: false, error: 'refused' };
      if (port === 10250 && node.unit('kubelet').state === 'active') return { ok: true, kind: 'kubelet', port };
      if (port === 22) return { ok: true, kind: 'ssh', port };
      if (port === 2379 && node.role === 'control-plane' && c.comp?.etcd) return { ok: true, kind: 'etcd', port };
      const hn = Object.values(c.runtime).find((r) => r.spec.hostNetwork && r.node === node.name && allListening(r).includes(port));
      if (hn) return { ok: true, rt: hn, port, host: true };
      return { ok: false, error: 'refused' };
    }
  }
  const dst = podRtByIP(c, tip) || Object.values(c.runtime).find((r) => r.spec.hostNetwork && c.hosts[r.node]?.ip === tip && allListening(r).includes(tport));
  if (!dst) {
    const h2 = hostByIP(c, tip);
    if (h2) return connect(c, src, tip, tport, proto);
    if (/^(142|140|147|93|34|54)\./.test(tip)) {
      const sIdent = src.pod ? src : null;
      if (sIdent && !netpolAllows(c, sIdent, { ip: tip }, tport, proto)) return { ok: false, error: 'timeout' };
      return { ok: true, kind: 'external', port: tport };
    }
    return { ok: false, error: 'unreachable' };
  }
  if (dst.state !== 'running') return { ok: false, error: 'refused' };
  const srcIdent = src.pod ? src : { ip: src.ip };
  if (!dst.spec.hostNetwork && !netpolAllows(c, srcIdent, podIdent(c, dst), tport, proto)) return { ok: false, error: 'timeout' };
  if (!allListening(dst).includes(tport)) return { ok: false, error: 'refused' };
  return { ok: true, rt: dst, port: tport };
}

export function srcFromRt(c, rt) { return podIdent(c, rt); }
export function srcFromHost(h) { return { ip: h.ip }; }

// ------------------------------------------------------------------ HTTP
export function parseUrl(u) {
  const m = String(u).match(/^(?:(https?):\/\/)?([^/:?#]+)(?::(\d+))?([^?#]*)?(\?[^#]*)?/);
  if (!m) return null;
  const scheme = m[1] || 'http';
  return { scheme, host: m[2], port: Number(m[3] || (scheme === 'https' ? 443 : 80)), path: (m[4] || '/') || '/', query: m[5] || '' };
}

// src: {rt} | {host}; zwraca {status, body, headers, error, ip, port}
export function httpRequest(c, src, url, { method = 'GET', headers = {} } = {}) {
  const u = parseUrl(url);
  if (!u) return { error: 'badurl' };
  const dns = dnsLookup(c, src.rt ? { rt: src.rt, fs: src.fs } : { host: src.host }, u.host);
  if (!dns.ok) return { error: dns.error === 'timeout' ? 'dnstimeout' : 'resolve', host: u.host };
  let ip = dns.ips[0];
  const ident = src.rt ? podIdent(c, src.rt) : { ip: src.host.ip };
  // pętla zwrotna: własny pod / własny host
  if (/^127\./.test(ip)) ip = src.rt ? (src.rt.spec.hostNetwork ? c.hosts[src.rt.node]?.ip : src.rt.ip) : src.host.ip;
  const conn = src.rt && ip === src.rt.ip && !src.rt.spec.hostNetwork
    ? (allListening(src.rt).includes(u.port) ? { ok: true, rt: src.rt, port: u.port } : { ok: false, error: 'refused' })
    : connect(c, ident, ip, u.port);
  if (!conn.ok) return { error: conn.error, ip, port: u.port };
  const hostHeader = headers.Host || headers.host || u.host + (u.port !== 80 && u.port !== 443 ? `:${u.port}` : '');
  const req = { method, path: u.path || '/', query: u.query, host: hostHeader.replace(/:\d+$/, ''), headers: lower(headers), srcIP: ident.ip, scheme: u.scheme };
  const resp = serve(c, conn, req, 0);
  return { ...resp, ip, port: u.port };
}

const lower = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

export function httpProbe(c, rt, port, path) {
  const r = serve(c, { ok: true, rt, port }, { method: 'GET', path, host: rt.ip, headers: { 'user-agent': 'kube-probe/1.37' }, srcIP: c.hosts[rt.node]?.ip }, 0);
  return r;
}

const NOT_FOUND = '<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';
const BAD_GW = (code, text) => `<html>\r\n<head><title>${code} ${text}</title></head>\r\n<body>\r\n<center><h1>${code} ${text}</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n`;

function serve(c, conn, req, depth) {
  if (depth > 4) return { status: 508, body: 'loop' };
  if (conn.kind === 'apiserver') {
    if (req.path === '/healthz' || req.path === '/livez' || req.path === '/readyz') return { status: 200, body: 'ok' };
    if (req.path === '/version') return { status: 200, body: JSON.stringify({ major: '1', minor: '37', gitVersion: c.meta.version, platform: 'linux/amd64' }, null, 2) + '\n' };
    return { status: 403, body: JSON.stringify({ kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', message: `forbidden: User "system:anonymous" cannot get path "${req.path}"`, reason: 'Forbidden', details: {}, code: 403 }, null, 2) + '\n', tls: true };
  }
  if (conn.kind === 'external') return { status: 200, body: '<!doctype html><html><head><title>External site</title></head><body>OK</body></html>\n' };
  if (conn.kind) return { status: 404, body: '404 page not found\n' };
  const rt = conn.rt;
  const crt = [...rt.main, ...rt.init].find((x) => x.state === 'running' && (x.listen || []).includes(conn.port));
  if (!crt) return { error: 'refused' };
  const kind = crt.server || (crt.kind === 'shell' ? 'shellhttpd' : crt.kind);
  let resp;
  if (kind === 'nginx') resp = serveNginx(c, rt, crt, conn.port, req);
  else if (kind === 'httpd') resp = serveFile(c, rt, crt, '/usr/local/apache2/htdocs', req) || { status: 404, body: '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>404 Not Found</title>\n</head><body>\n<h1>Not Found</h1>\n<p>The requested URL was not found on this server.</p>\n</body></html>\n' };
  else if (kind === 'podinfo') resp = servePodinfo(c, rt, crt, req);
  else if (kind === 'ingress') resp = serveIngress(c, rt, req, depth);
  else if (kind === 'gateway') resp = serveGateway(c, rt, req, depth);
  else if (kind === 'component') resp = /^\/(livez|readyz|healthz|health)/.test(req.path) ? { status: 200, body: 'ok' } : { status: 403, body: '{"kind":"Status","status":"Failure","reason":"Forbidden","code":403}\n' };
  else if (kind === 'coredns') resp = req.path === '/health' || req.path === '/ready' ? { status: 200, body: 'OK' } : { status: 404, body: '404 page not found\n' };
  else if (kind === 'shellhttpd') resp = serveFile(c, rt, crt, crt.httpRoot || '/www', req) || { status: 404, body: '<HTML><HEAD><TITLE>404 Not Found</TITLE></HEAD>\n<BODY><H1>404 Not Found</H1>\nThe requested URL was not found\n</BODY></HTML>\n' };
  else if (kind === 'redis' || kind === 'postgres' || kind === 'mysql') return { error: 'emptyreply' };
  else resp = { status: 404, body: '404 page not found\n' };
  if (kind === 'nginx' && resp.status) {
    const d = new Date(c.now());
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
    const ts = `${String(d.getUTCDate()).padStart(2, '0')}/${mon}/${d.getUTCFullYear()}:${d.toISOString().slice(11, 19)} +0000`;
    const ua = req.headers['user-agent'] || 'Wget';
    crt.logs.push([c.now(), `${req.srcIP || '-'} - - [${ts}] "${req.method} ${req.path}${req.query || ''} HTTP/1.1" ${resp.status} ${(resp.body || '').length} "-" "${ua}" "-"`]);
  }
  return resp;
}

function containerFs(c, rt, crt) {
  // lazy import: unikamy cyklu na poziomie modułu
  const spec = [...(rt.spec.containers || []), ...(rt.spec.initContainers || [])].find((x) => x.name === crt.name);
  return c.buildContainerFs(c, rt, crt, spec);
}

function serveFile(c, rt, crt, root, req) {
  const fs = containerFs(c, rt, crt);
  let p = (root + req.path).replace(/\/+/g, '/');
  if (fs.isDir(p)) p = p.replace(/\/$/, '') + '/index.html';
  const data = fs.tryRead(p);
  if (data === null) return null;
  return { status: 200, body: data };
}

function serveNginx(c, rt, crt, port, req) {
  const fs = containerFs(c, rt, crt);
  let conf = '';
  try { for (const f of fs.list('/etc/nginx/conf.d')) if (f.endsWith('.conf')) conf += (fs.tryRead(`/etc/nginx/conf.d/${f}`) || '') + '\n'; } catch { /* */ }
  const servers = [];
  const re = /server\s*\{/g;
  let m;
  while ((m = re.exec(conf))) {
    let depth = 1, i = m.index + m[0].length;
    for (; i < conf.length && depth; i++) { if (conf[i] === '{') depth++; if (conf[i] === '}') depth--; }
    servers.push(conf.slice(m.index + m[0].length, i - 1));
  }
  const srv = servers.find((s) => new RegExp(`listen\\s+(\\[::\\]:)?${port}\\b`).test(s)) || servers[0];
  if (!srv) return { status: 200, body: NGINX_PAGE };
  const rootM = srv.match(/^\s*root\s+([^;]+);/m);
  const locs = [];
  const lre = /location\s+(=|~\*?|\^~)?\s*([^\s{]+)\s*\{([^}]*)\}/g;
  while ((m = lre.exec(srv))) locs.push({ mod: m[1] || '', path: m[2], body: m[3] });
  const path = req.path || '/';
  let best = null;
  for (const l of locs) {
    if (l.mod === '=' && l.path === path) { best = l; break; }
    if ((l.mod === '' || l.mod === '^~') && path.startsWith(l.path) && (!best || l.path.length > best.path.length)) best = l;
    if (l.mod.startsWith('~')) { try { if (new RegExp(l.path, l.mod === '~*' ? 'i' : '').test(path)) { best = l; break; } } catch { /* */ } }
  }
  const body = best ? best.body : '';
  const ret = body.match(/return\s+(\d{3})(?:\s+(?:'([^']*)'|"([^"]*)"|([^;]+)))?\s*;/s);
  if (ret) {
    const text = (ret[2] ?? ret[3] ?? ret[4] ?? '').replace(/\\n/g, '\n');
    const st = Number(ret[1]);
    if (st >= 300 && st < 400) return { status: st, body: '', headers: { location: text } };
    return { status: st, body: text };
  }
  const rootL = body.match(/root\s+([^;]+);/) || rootM;
  const root = (rootL ? rootL[1] : '/usr/share/nginx/html').trim();
  const f = serveFile(c, rt, crt, root, req);
  if (f) return f;
  return { status: 404, body: NOT_FOUND };
}

function servePodinfo(c, rt, crt, req) {
  const msg = crt.env?.PODINFO_UI_MESSAGE || 'greetings from podinfo v6.17.0';
  if (req.path === '/healthz' || req.path === '/readyz') return { status: 200, body: '{\n  "status": "OK"\n}\n' };
  if (req.path === '/version') return { status: 200, body: '{\n  "commit": "unknown",\n  "version": "6.17.0"\n}\n' };
  return { status: 200, body: JSON.stringify({ hostname: rt.name, version: '6.17.0', revision: '', color: crt.env?.PODINFO_UI_COLOR || '#34577c', logo: 'https://raw.githubusercontent.com/stefanprodan/podinfo/gh-pages/cuddle_clap.gif', message: msg, goos: 'linux', goarch: 'amd64', runtime: 'go1.24.6', num_goroutine: '8', num_cpu: '2' }, null, 2) + '\n' };
}

// przekazanie do usługi z poziomu poda proxy (ingress/gateway)
function forward(c, fromRt, ns, svcName, portSpec, req, depth) {
  const svc = c.peek('services', ns, svcName);
  if (!svc) return { status: 503, body: BAD_GW(503, 'Service Temporarily Unavailable') };
  const sp = (svc.spec.ports || []).find((p) => (portSpec.number !== undefined ? p.port === portSpec.number : p.name === portSpec.name));
  if (!sp) return { status: 503, body: BAD_GW(503, 'Service Temporarily Unavailable') };
  const conn = connect(c, podIdent(c, fromRt), svc.spec.clusterIP, sp.port);
  if (!conn.ok) return { status: conn.error === 'refused' ? 503 : 504, body: conn.error === 'refused' ? BAD_GW(503, 'Service Temporarily Unavailable') : BAD_GW(504, 'Gateway Time-out') };
  return serve(c, conn, { ...req, srcIP: fromRt.ip }, depth + 1);
}

// ------------------------------------------------------------------ Ingress (ingress-nginx)
function hostMatch(pattern, host) {
  if (!pattern) return true;
  if (pattern.startsWith('*.')) { const suf = pattern.slice(1); return host.endsWith(suf) && host.split('.').length === pattern.split('.').length; }
  return pattern === host;
}
function prefixMatch(prefix, path) {
  if (prefix === '/' || prefix === '') return true;
  const p = prefix.replace(/\/$/, '');
  return path === p || path.startsWith(p + '/');
}

function serveIngress(c, rt, req, depth) {
  const classes = c.all('ingressclasses').filter((x) => x.spec?.controller === 'k8s.io/ingress-nginx').map((x) => x.metadata.name);
  const defClass = c.all('ingressclasses').find((x) => x.metadata.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true')?.metadata.name;
  const ings = c.all('ingresses').filter((i) => {
    const cls = i.spec?.ingressClassName || i.metadata.annotations?.['kubernetes.io/ingress.class'] || defClass;
    return classes.includes(cls);
  });
  let best = null;
  for (const ing of ings) {
    for (const rule of ing.spec.rules || []) {
      if (!hostMatch(rule.host, req.host)) continue;
      for (const p of rule.http?.paths || []) {
        const pth = p.path || '/';
        let ok = false, len = pth.length;
        if (p.pathType === 'Exact') ok = req.path === pth;
        else if (p.pathType === 'Prefix') ok = prefixMatch(pth, req.path);
        else {
          if (ing.metadata.annotations?.['nginx.ingress.kubernetes.io/use-regex'] === 'true' || ing.metadata.annotations?.['nginx.ingress.kubernetes.io/rewrite-target']) {
            try { ok = new RegExp('^' + pth).test(req.path); } catch { ok = false; }
          } else ok = req.path.startsWith(pth);
        }
        if (!ok) continue;
        const score = (rule.host ? 10000 : 0) + (p.pathType === 'Exact' ? 5000 : 0) + len;
        if (!best || score > best.score) best = { score, ing, p };
      }
    }
    if (!best && ing.spec.defaultBackend?.service && (ing.spec.rules || []).length === 0) best = { score: 0, ing, p: { backend: ing.spec.defaultBackend, path: '/' } };
  }
  if (!best) return { status: 404, body: NOT_FOUND };
  let path = req.path;
  const rw = best.ing.metadata.annotations?.['nginx.ingress.kubernetes.io/rewrite-target'];
  if (rw) {
    try {
      const m = req.path.match(new RegExp('^' + (best.p.path || '/')));
      path = rw.replace(/\$(\d)/g, (_, n) => (m?.[Number(n)] ?? '')) || '/';
    } catch { path = rw; }
  }
  const be = best.p.backend.service;
  return forward(c, rt, best.ing.metadata.namespace, be.name, be.port || {}, { ...req, path }, depth);
}

// ------------------------------------------------------------------ Gateway API (NGINX Gateway Fabric)
export function gatewayOfPod(c, rt) {
  const p = podObj(c, rt);
  const gwName = p?.metadata?.labels?.['gateway.networking.k8s.io/gateway-name'];
  return gwName ? c.peek('gateways', rt.ns, gwName) : null;
}

export function routeAttached(c, route, gw) {
  return (route.spec.parentRefs || []).some((ref) => (ref.kind || 'Gateway') === 'Gateway' && ref.name === gw.metadata.name && (ref.namespace || route.metadata.namespace) === gw.metadata.namespace);
}

export function listenerAllows(c, l, gw, route) {
  const from = l.allowedRoutes?.namespaces?.from || 'Same';
  if (from === 'All') return true;
  if (from === 'Same') return route.metadata.namespace === gw.metadata.namespace;
  if (from === 'Selector') return matchLabelSelector(l.allowedRoutes.namespaces.selector, nsLabels(c, route.metadata.namespace));
  return false;
}

function serveGateway(c, rt, req, depth) {
  const gw = gatewayOfPod(c, rt);
  if (!gw) return { status: 404, body: NOT_FOUND };
  const listeners = (gw.spec.listeners || []).filter((l) => l.protocol === 'HTTP' && hostMatch(l.hostname, req.host));
  if (!listeners.length) return { status: 404, body: NOT_FOUND };
  const routes = c.all('httproutes').filter((r) => routeAttached(c, r, gw) && listeners.some((l) => listenerAllows(c, l, gw, r) && (r.spec.parentRefs || []).some((ref) => !ref.sectionName || ref.sectionName === l.name)))
    .filter((r) => !(r.spec.hostnames || []).length || r.spec.hostnames.some((h) => hostMatch(h, req.host)))
    .sort((a, b) => Date.parse(a.metadata.creationTimestamp) - Date.parse(b.metadata.creationTimestamp));
  let best = null;
  for (const r of routes) {
    (r.spec.rules || []).forEach((rule, ri) => {
      const matches = rule.matches?.length ? rule.matches : [{ path: { type: 'PathPrefix', value: '/' } }];
      for (const m of matches) {
        const pth = m.path || { type: 'PathPrefix', value: '/' };
        const val = pth.value ?? '/';
        let ok = false;
        if ((pth.type || 'PathPrefix') === 'Exact') ok = req.path === val;
        else if ((pth.type || 'PathPrefix') === 'PathPrefix') ok = prefixMatch(val, req.path);
        else { try { ok = new RegExp('^' + val).test(req.path); } catch { ok = false; } }
        if (!ok) continue;
        if (m.method && m.method !== req.method) continue;
        if ((m.headers || []).some((hm) => {
          const v = req.headers[(hm.name || '').toLowerCase()];
          if ((hm.type || 'Exact') === 'Exact') return v !== hm.value;
          try { return !new RegExp(hm.value).test(v || ''); } catch { return true; }
        })) continue;
        const q = new URLSearchParams(req.query || '');
        if ((m.queryParams || []).some((qp) => q.get(qp.name) !== qp.value)) continue;
        const score = ((pth.type || 'PathPrefix') === 'Exact' ? 1e6 : 0) + val.length * 1000 + (m.method ? 100 : 0) + (m.headers || []).length * 10 + (m.queryParams || []).length;
        if (!best || score > best.score) best = { score, route: r, rule, ri };
      }
    });
  }
  if (!best) return { status: 404, body: NOT_FOUND };
  // filtry
  for (const f of best.rule.filters || []) {
    if (f.type === 'RequestRedirect') {
      const rr2 = f.requestRedirect || {};
      const loc = `${rr2.scheme || 'http'}://${rr2.hostname || req.host}${rr2.port ? ':' + rr2.port : ''}${rr2.path?.replaceFullPath || req.path}`;
      return { status: rr2.statusCode || 302, body: '', headers: { location: loc } };
    }
  }
  let path = req.path;
  for (const f of best.rule.filters || []) {
    if (f.type === 'URLRewrite' && f.urlRewrite?.path) {
      const pr = f.urlRewrite.path;
      if (pr.type === 'ReplaceFullPath') path = pr.replaceFullPath;
      if (pr.type === 'ReplacePrefixMatch') {
        const m = (best.rule.matches || [])[0]?.path?.value || '/';
        path = (pr.replacePrefixMatch + path.slice(m.length)).replace(/\/\//g, '/') || '/';
      }
    }
  }
  const backends = (best.rule.backendRefs || []).filter((b) => (b.weight ?? 1) > 0);
  if (!backends.length) return { status: 500, body: BAD_GW(500, 'Internal Server Error') };
  const total = backends.reduce((s, b) => s + (b.weight ?? 1), 0);
  let x = rand() * total;
  let be = backends[0];
  for (const b of backends) { x -= b.weight ?? 1; if (x < 0) { be = b; break; } }
  const ns = be.namespace || best.route.metadata.namespace;
  if (ns !== best.route.metadata.namespace && !referenceGranted(c, best.route, ns, be.name)) return { status: 500, body: BAD_GW(500, 'Internal Server Error') };
  return forward(c, rt, ns, be.name, { number: be.port }, { ...req, path }, depth);
}

export function referenceGranted(c, route, ns, name) {
  return c.all('referencegrants', ns).some((g) => (g.spec?.from || []).some((f) => f.kind === 'HTTPRoute' && f.namespace === route.metadata.namespace)
    && (g.spec?.to || []).some((t) => (t.kind || 'Service') === 'Service' && (!t.name || t.name === name)));
}
