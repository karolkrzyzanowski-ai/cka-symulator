// YAML: parsowanie (js-yaml) i zapis w stylu kubectl (sigs.k8s.io/yaml).
import { loadAll, load } from 'js-yaml';

export class YamlError extends Error {}

function wrapErr(e) {
  const m = String(e.message || e).split('\n')[0];
  const pos = e.mark ? ` (line ${e.mark.line + 1}, column ${e.mark.column + 1})` : '';
  return new YamlError(`error converting YAML to JSON: yaml: ${m.replace(/\s*\(\d+:\d+\)\s*$/, '')}${pos}`);
}

export function parseAll(text) {
  try {
    return loadAll(text).filter((d) => d !== null && d !== undefined);
  } catch (e) {
    throw wrapErr(e);
  }
}

export function parseOne(text) {
  try {
    return load(text);
  } catch (e) {
    throw wrapErr(e);
  }
}

// --------------------------------------------------------------------------- dump
const RESERVED = /^(true|false|yes|no|on|off|y|n|null|~|True|False|TRUE|FALSE|Yes|No|YES|NO|On|Off|ON|OFF|Null|NULL|Y|N)$/;

// Jak yaml.v2: tekst wyglądający na inny typ -> "podwójne", tekst niedozwolony jako plain -> 'pojedyncze'
function looksTyped(s) {
  if (s === '') return true;
  if (RESERVED.test(s)) return true;
  if (/^[-+]?(\d[\d_]*)?\.?\d+([eE][-+]?\d+)?$/.test(s)) return true;
  if (/^[-+]?0x[0-9a-fA-F]+$/.test(s) || /^0o?[0-7]+$/.test(s) || /^[-+]?\.(inf|nan)$/i.test(s)) return true;
  if (/^\d{4}-\d\d-\d\d([Tt ]|$)/.test(s)) return true;
  return false;
}
function plainUnsafe(s) {
  if (/^\s|\s$/.test(s)) return true;
  if (/^[,\[\]{}#&*!|>'"%@`]/.test(s)) return true;
  if (/^[-?:](\s|$)/.test(s)) return true;
  if (/: |\s#|:$/.test(s)) return true;
  return false;
}
const hasCtrl = (s) => /[\x00-\x08\x0b-\x1f\x7f\t]/.test(s);

function quote(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\t/g, '\\t').replace(/\r/g, '\\r')
    .replace(/[\x00-\x08\x0b-\x1f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '"';
}
function strScalar(s) {
  if (looksTyped(s) || hasCtrl(s)) return quote(s);
  if (plainUnsafe(s)) return `'${s.replace(/'/g, "''")}'`;
  return s;
}
const needsQuote = (k) => strScalar(k) !== k;

function scalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : (Number.isNaN(v) ? '.nan' : (v > 0 ? '.inf' : '-.inf'));
  return strScalar(String(v));
}

function blockString(s, indent) {
  const pad = ' '.repeat(indent);
  const chomp = s.endsWith('\n') ? (s.endsWith('\n\n') ? '+' : '') : '-';
  const body = (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n').map((l) => (l ? pad + l : '')).join('\n');
  const ind = /^\s/.test(s) ? String(indent) : '';
  return `|${ind}${chomp}\n${body}`;
}

function isScalar(v) {
  return v === null || v === undefined || typeof v !== 'object';
}

function emit(v, indent, out, sort) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    for (const item of v) {
      if (isScalar(item)) {
        out.push(`${pad}- ${typeof item === 'string' && item.includes('\n') ? blockString(item, indent + 2) : scalar(item)}`);
      } else if (Array.isArray(item)) {
        if (!item.length) out.push(`${pad}- []`);
        else { out.push(`${pad}-`); emit(item, indent + 2, out, sort); }
      } else {
        const keys = sort ? Object.keys(item).sort() : Object.keys(item);
        if (!keys.length) { out.push(`${pad}- {}`); continue; }
        const sub = [];
        emit(item, indent + 2, sub, sort);
        sub[0] = `${pad}- ${sub[0].slice(indent + 2)}`;
        out.push(...sub);
      }
    }
    return;
  }
  const keys = sort ? Object.keys(v).sort() : Object.keys(v);
  for (const k of keys) {
    const val = v[k];
    if (val === undefined) continue;
    const key = needsQuote(k) ? strScalar(k) : k;
    if (isScalar(val)) {
      if (typeof val === 'string' && val.includes('\n')) out.push(`${pad}${key}: ${blockString(val, indent + 2)}`);
      else out.push(`${pad}${key}: ${scalar(val)}`);
    } else if (Array.isArray(val)) {
      if (!val.length) out.push(`${pad}${key}: []`);
      else { out.push(`${pad}${key}:`); emit(val, indent, out, sort); }
    } else {
      if (!Object.keys(val).filter((x) => val[x] !== undefined).length) out.push(`${pad}${key}: {}`);
      else { out.push(`${pad}${key}:`); emit(val, indent + 2, out, sort); }
    }
  }
}

export function dump(obj, { sort = true } = {}) {
  if (isScalar(obj)) return scalar(obj) + '\n';
  const out = [];
  emit(obj, 0, out, sort);
  return out.join('\n') + '\n';
}

export function dumpAll(objs, opts) {
  return objs.map((o) => dump(o, opts)).join('---\n');
}
