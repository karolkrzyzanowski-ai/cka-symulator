// Ogólne narzędzia używane w całym symulatorze.

export const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

export function deepEqual(a, b) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

export function sortKeys(o) {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === 'object') {
    const r = {};
    for (const k of Object.keys(o).sort()) r[k] = sortKeys(o[k]);
    return r;
  }
  return o;
}

export function get(o, path, dflt) {
  let cur = o;
  for (const p of path.split('.')) {
    if (cur == null) return dflt;
    cur = cur[p];
  }
  return cur === undefined ? dflt : cur;
}

export function set(o, path, val) {
  const parts = path.split('.');
  let cur = o;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
  return o;
}

// ---------------------------------------------------------------- losowość (deterministyczna per klaster)
let _seed = (Date.now() ^ 0x9e3779b9) >>> 0;
export function seedRandom(s) { _seed = s >>> 0 || 1; }
export function rand() {
  // mulberry32
  _seed = (_seed + 0x6d2b79f5) >>> 0;
  let t = _seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
export const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const ALNUM = 'bcdfghjklmnpqrstvwxz2456789'; // alfabet nazw generowanych przez Kubernetes
export function randSuffix(n = 5) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALNUM[Math.floor(rand() * ALNUM.length)];
  return s;
}
export function hex(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(rand() * 16)];
  return s;
}
export function uuid() {
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[randInt(0, 3)]}${hex(3)}-${hex(12)}`;
}

// skrót deterministyczny (np. pod-template-hash)
export function hashStr(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
export function safeHash(s, len = 10) {
  let n = hashStr(s);
  let out = '';
  while (out.length < len) {
    out += ALNUM[n % ALNUM.length];
    n = Math.floor(n / ALNUM.length) + 7919 * (out.length + 1);
  }
  return out;
}
export function hexHash(s, len = 64) {
  let out = '';
  let i = 0;
  while (out.length < len) out += hashStr(s + ':' + i++).toString(16).padStart(14, '0');
  return out.slice(0, len);
}

// ---------------------------------------------------------------- base64 (UTF-8)
export function b64enc(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
export function b64dec(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
export function isB64(s) {
  return typeof s === 'string' && /^[A-Za-z0-9+/\s]*={0,2}$/.test(s) && s.replace(/\s/g, '').length % 4 === 0;
}

// ---------------------------------------------------------------- ilości zasobów
const BIN = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DEC = { n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
export function parseQty(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return v;
  const m = String(v).trim().match(/^([+-]?[0-9.]+(?:[eE][+-]?\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|K|M|G|T|P|E)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  if (!m[2]) return n;
  return n * (BIN[m[2]] ?? DEC[m[2]]);
}
export const validQty = (v) => parseQty(v) !== null;
export function fmtCpu(cores) {
  const m = Math.round(cores * 1000);
  return m % 1000 === 0 ? String(m / 1000) : `${m}m`;
}
export function fmtMem(bytes) {
  for (const [u, f] of [['Gi', 2 ** 30], ['Mi', 2 ** 20], ['Ki', 2 ** 10]]) {
    if (bytes >= f && bytes % f === 0) return `${bytes / f}${u}`;
  }
  if (bytes >= 2 ** 20) return `${Math.round(bytes / 2 ** 20)}Mi`;
  return `${Math.round(bytes / 1024)}Ki`;
}

// czas trwania w stylu Go: 2160h, 1h30m, 90s, 500ms
export function parseDuration(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  let total = 0, found = false;
  const re = /([0-9.]+)(h|ms|m|s|us|ns)/g;
  let m;
  const str = String(s).trim();
  let consumed = 0;
  while ((m = re.exec(str))) {
    found = true;
    consumed += m[0].length;
    total += parseFloat(m[1]) * { h: 3600, m: 60, s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9 }[m[2]];
  }
  return found && consumed === str.length ? total : null;
}
export function fmtGoDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
  return `${h}h${m}m${s}s`;
}

// ---------------------------------------------------------------- wiek w stylu kubectl
export function humanDuration(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60 * 2) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 10) {
    const s = sec % 60;
    return s === 0 ? `${min}m` : `${min}m${s}s`;
  }
  if (min < 60 * 3) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 8) {
    const m = min % 60;
    return m === 0 ? `${h}h` : `${h}h${m}m`;
  }
  if (h < 48) return `${h}h`;
  if (h < 24 * 8) {
    const d = Math.floor(h / 24), hh = h % 24;
    return hh === 0 ? `${d}d` : `${d}d${hh}h`;
  }
  if (h < 24 * 365 * 2) return `${Math.floor(h / 24)}d`;
  return `${Math.floor(h / 24 / 365)}y`;
}
export function age(iso, now) {
  if (!iso) return '<unknown>';
  return humanDuration(now - Date.parse(iso));
}

// ---------------------------------------------------------------- tabela jak tabwriter kubectl (padding 3)
export function table(rows, { noHeaders = false } = {}) {
  const r = noHeaders ? rows.slice(1) : rows;
  if (!r.length) return '';
  const w = [];
  for (const row of rows) row.forEach((c, i) => { w[i] = Math.max(w[i] || 0, String(c).length); });
  return r.map((row) => row.map((c, i) => (i === row.length - 1 ? String(c) : String(c).padEnd(w[i] + 3))).join('').trimEnd()).join('\n') + '\n';
}

// ---------------------------------------------------------------- selektory etykiet
export function parseSelector(str) {
  // zwraca listę wymagań {key, op, values}
  if (!str || !str.trim()) return [];
  const reqs = [];
  // dzielimy po przecinkach poza nawiasami
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  for (let p of parts) {
    p = p.trim();
    if (!p) continue;
    let m;
    if ((m = p.match(/^([\w./-]+)\s+(in|notin)\s+\(([^)]*)\)$/i))) {
      reqs.push({ key: m[1], op: m[2].toLowerCase() === 'in' ? 'In' : 'NotIn', values: m[3].split(',').map((x) => x.trim()).filter(Boolean) });
    } else if ((m = p.match(/^!([\w./-]+)$/))) reqs.push({ key: m[1], op: 'DoesNotExist', values: [] });
    else if ((m = p.match(/^([\w./-]+)\s*(==|=|!=)\s*([\w.-]*)$/))) reqs.push({ key: m[1], op: m[2] === '!=' ? 'NotEquals' : 'Equals', values: [m[3]] });
    else if ((m = p.match(/^([\w./-]+)$/))) reqs.push({ key: m[1], op: 'Exists', values: [] });
    else throw new Error(`unable to parse requirement: ${p}`);
  }
  return reqs;
}
export function matchReqs(reqs, labels = {}) {
  labels = labels || {};
  return reqs.every((r) => {
    const has = Object.prototype.hasOwnProperty.call(labels, r.key);
    const v = labels[r.key];
    switch (r.op) {
      case 'Equals': return has && v === r.values[0];
      case 'NotEquals': return !has || v !== r.values[0];
      case 'In': return has && r.values.includes(v);
      case 'NotIn': return !has || !r.values.includes(v);
      case 'Exists': return has;
      case 'DoesNotExist': return !has;
      case 'Gt': return has && Number(v) > Number(r.values[0]);
      case 'Lt': return has && Number(v) < Number(r.values[0]);
      default: return false;
    }
  });
}
// LabelSelector z API (matchLabels + matchExpressions)
export function matchLabelSelector(sel, labels) {
  if (!sel) return false;
  const reqs = [];
  for (const [k, v] of Object.entries(sel.matchLabels || {})) reqs.push({ key: k, op: 'Equals', values: [v] });
  for (const e of sel.matchExpressions || []) reqs.push({ key: e.key, op: e.operator, values: e.values || [] });
  return matchReqs(reqs, labels);
}
export const isEmptySelector = (sel) => !sel || (!Object.keys(sel.matchLabels || {}).length && !(sel.matchExpressions || []).length);
export function selectorString(sel) {
  if (!sel) return '';
  const parts = Object.entries(sel.matchLabels || sel).filter(([k]) => k !== 'matchExpressions').map(([k, v]) => `${k}=${v}`);
  for (const e of sel.matchExpressions || []) {
    if (e.operator === 'In') parts.push(`${e.key} in (${(e.values || []).join(',')})`);
    else if (e.operator === 'NotIn') parts.push(`${e.key} notin (${(e.values || []).join(',')})`);
    else if (e.operator === 'Exists') parts.push(e.key);
    else if (e.operator === 'DoesNotExist') parts.push(`!${e.key}`);
  }
  return parts.join(',');
}
export const labelsString = (l) => (l && Object.keys(l).length ? Object.entries(l).map(([k, v]) => `${k}=${v}`).join(',') : '<none>');

// ---------------------------------------------------------------- łatki
export function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return clone(patch);
  const out = target && typeof target === 'object' && !Array.isArray(target) ? clone(target) : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

// strategic merge patch - listy obiektów scalane po kluczu (name/containerPort/mountPath...)
const MERGE_KEYS = {
  containers: 'name', initContainers: 'name', ephemeralContainers: 'name', volumes: 'name', env: 'name',
  volumeMounts: 'mountPath', ports: 'containerPort', imagePullSecrets: 'name', tolerations: null,
  conditions: 'type', hostAliases: 'ip',
};
export function strategicMerge(target, patch, key = null) {
  if (patch === null) return undefined;
  if (Array.isArray(patch)) {
    const mk = key === 'ports' ? ([...patch, ...(Array.isArray(target) ? target : [])].some((p) => p && 'containerPort' in p) ? 'containerPort' : 'port') : MERGE_KEYS[key];
    if (!mk || !Array.isArray(target)) return clone(patch);
    const out = clone(target);
    for (const item of patch) {
      if (item && item.$patch === 'delete') {
        const i = out.findIndex((x) => x[mk] === item[mk]);
        if (i >= 0) out.splice(i, 1);
        continue;
      }
      const i = out.findIndex((x) => x && item && x[mk] === item[mk]);
      if (i >= 0) out[i] = strategicMerge(out[i], item);
      else out.push(clone(item));
    }
    return out;
  }
  if (typeof patch !== 'object') return patch;
  const out = target && typeof target === 'object' && !Array.isArray(target) ? clone(target) : {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === '$patch') continue;
    if (v === null) delete out[k];
    else out[k] = strategicMerge(out[k], v, k);
  }
  return out;
}

// JSON Patch (RFC 6902)
export function jsonPatch(doc, ops) {
  let out = clone(doc);
  const unesc = (s) => s.replace(/~1/g, '/').replace(/~0/g, '~');
  const parse = (p) => {
    if (p === '') return [];
    if (!p.startsWith('/')) throw new Error(`invalid JSON pointer "${p}"`);
    return p.slice(1).split('/').map(unesc);
  };
  const walk = (parts) => {
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = Array.isArray(cur) ? Number(parts[i]) : parts[i];
      if (cur == null || cur[k] === undefined) throw new Error(`doc is missing path: "/${parts.join('/')}": missing value`);
      cur = cur[k];
    }
    return cur;
  };
  if (!Array.isArray(ops)) throw new Error('json: cannot unmarshal object into Go value of type jsonpatch.Patch');
  for (const op of ops) {
    const parts = parse(op.path);
    if (op.op === 'test') {
      const par = walk(parts);
      const k = parts[parts.length - 1];
      if (!deepEqual(par[k], op.value)) throw new Error(`testing value ${op.path} failed`);
      continue;
    }
    if (parts.length === 0) { if (op.op === 'replace' || op.op === 'add') out = clone(op.value); continue; }
    const par = walk(parts);
    const last = parts[parts.length - 1];
    if (par == null) throw new Error(`doc is missing path: "${op.path}"`);
    if (op.op === 'add') {
      if (Array.isArray(par)) {
        if (last === '-') par.push(clone(op.value));
        else {
          const i = Number(last);
          if (i > par.length) throw new Error(`add operation does not apply: doc is missing path: "${op.path}": missing value`);
          par.splice(i, 0, clone(op.value));
        }
      } else par[last] = clone(op.value);
    } else if (op.op === 'remove') {
      if (Array.isArray(par)) {
        const i = Number(last);
        if (i >= par.length) throw new Error(`remove operation does not apply: doc is missing path: "${op.path}": missing value`);
        par.splice(i, 1);
      } else {
        if (!(last in par)) throw new Error(`remove operation does not apply: doc is missing path: "${op.path}": missing value`);
        delete par[last];
      }
    } else if (op.op === 'replace') {
      if (Array.isArray(par)) par[Number(last)] = clone(op.value);
      else {
        if (!(last in par)) throw new Error(`replace operation does not apply: doc is missing key: ${op.path}: missing value`);
        par[last] = clone(op.value);
      }
    } else if (op.op === 'move' || op.op === 'copy') {
      const fromParts = parse(op.from);
      const fp = walk(fromParts);
      const fk = fromParts[fromParts.length - 1];
      const v = clone(fp[fk]);
      if (op.op === 'move') { if (Array.isArray(fp)) fp.splice(Number(fk), 1); else delete fp[fk]; }
      if (Array.isArray(par)) par.splice(last === '-' ? par.length : Number(last), 0, v); else par[last] = v;
    } else throw new Error(`Unexpected kind: ${op.op}`);
  }
  return out;
}

// ---------------------------------------------------------------- glob i ścieżki
export function globToRegex(g) {
  let re = '^';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const j = g.indexOf(']', i);
      if (j > i) { re += '[' + g.slice(i + 1, j).replace(/^!/, '^') + ']'; i = j; } else re += '\\[';
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(re + '$');
}

export function normPath(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return '/' + out.join('/');
}
export const dirname = (p) => { const n = normPath(p); const i = n.lastIndexOf('/'); return i <= 0 ? '/' : n.slice(0, i); };
export const basename = (p) => { const n = normPath(p); return n.slice(n.lastIndexOf('/') + 1); };

export function shQuote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

export class ExitError extends Error {
  constructor(code, msg = '') { super(msg); this.code = code; }
}
