// Symulowane klucze, CSR i certyfikaty X.509 (PEM z zakodowanymi metadanymi).
import { b64enc, b64dec, hexHash, hex } from '../lib/util.js';

const wrap = (s) => s.match(/.{1,64}/g).join('\n');

function pem(type, meta) {
  const payload = b64enc(JSON.stringify(meta) + '#' + hexHash(JSON.stringify(meta), 300));
  return `-----BEGIN ${type}-----\n${wrap(payload)}\n-----END ${type}-----\n`;
}

export function parsePem(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/-----BEGIN ([A-Z ]+)-----\s*([\s\S]*?)\s*-----END \1-----/);
  if (!m) return null;
  try {
    const raw = b64dec(m[2].replace(/\s+/g, ''));
    const json = raw.slice(0, raw.indexOf('#') >= 0 ? raw.indexOf('#') : raw.length);
    return { type: m[1], meta: JSON.parse(json) };
  } catch {
    return { type: m[1], meta: null };
  }
}

export const makeKey = (bits = 2048) => pem('PRIVATE KEY', { k: hex(16), bits });
export const keyId = (keyPem) => parsePem(keyPem)?.meta?.k || null;

export function makeCsr({ cn, o = [], key }) {
  return pem('CERTIFICATE REQUEST', { t: 'csr', cn, o, k: keyId(key) || hex(16) });
}

export function makeCert({ cn, o = [], issuer = 'kubernetes', notBefore, days = 365, seconds, san = [], ca = false, key = null, usage = [] }) {
  const nb = notBefore;
  const na = nb + (seconds ? seconds * 1000 : days * 86400000);
  return pem('CERTIFICATE', { t: 'cert', cn, o, iss: issuer, nb, na, serial: hex(16), san, ca, k: key ? keyId(key) : hex(16), usage });
}

export function certInfo(text) {
  const p = parsePem(text);
  if (!p || p.type !== 'CERTIFICATE' || !p.meta) return null;
  return p.meta;
}

export function fingerprint(text) {
  const info = certInfo(text);
  if (!info) return null;
  const h = hexHash(JSON.stringify(info), 64).toUpperCase();
  return h.match(/.{2}/g).join(':');
}

export function opensslDate(ms) {
  const d = new Date(ms);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const pad = (n) => String(n).padStart(2, '0');
  return `${mon} ${String(d.getUTCDate()).padStart(2, ' ')} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()} GMT`;
}

export function dn(meta) {
  const parts = [];
  for (const o of meta.o || []) parts.push(`O = ${o}`);
  parts.push(`CN = ${meta.cn}`);
  return parts.join(', ');
}

// certyfikaty, które tworzy kubeadm init (nazwa pliku -> definicja)
export const KUBEADM_CERTS = [
  { file: 'apiserver', cn: 'kube-apiserver', ca: 'ca', san: true, name: 'apiserver' },
  { file: 'apiserver-etcd-client', cn: 'kube-apiserver-etcd-client', ca: 'etcd-ca', name: 'apiserver-etcd-client' },
  { file: 'apiserver-kubelet-client', cn: 'kube-apiserver-kubelet-client', o: ['kubeadm:cluster-admins'], ca: 'ca', name: 'apiserver-kubelet-client' },
  { file: 'front-proxy-client', cn: 'front-proxy-client', ca: 'front-proxy-ca', name: 'front-proxy-client' },
  { file: 'etcd/healthcheck-client', cn: 'kube-etcd-healthcheck-client', ca: 'etcd-ca', name: 'etcd-healthcheck-client' },
  { file: 'etcd/peer', cn: 'cka-cp1', ca: 'etcd-ca', name: 'etcd-peer' },
  { file: 'etcd/server', cn: 'cka-cp1', ca: 'etcd-ca', name: 'etcd-server' },
];
export const KUBEADM_KUBECONFIGS = [
  { file: 'admin.conf', name: 'admin.conf', user: 'kubernetes-admin', o: ['kubeadm:cluster-admins'] },
  { file: 'super-admin.conf', name: 'super-admin.conf', user: 'kubernetes-super-admin', o: ['system:masters'] },
  { file: 'controller-manager.conf', name: 'controller-manager.conf', user: 'system:kube-controller-manager' },
  { file: 'scheduler.conf', name: 'scheduler.conf', user: 'system:kube-scheduler' },
];
