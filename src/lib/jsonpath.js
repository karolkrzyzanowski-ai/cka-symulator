// JSONPath w wariancie kubectl: {.items[*].metadata.name}, {range ...}{end}, filtry ?(@.x=="y")

export class JsonPathError extends Error {}

function tokenizeTemplate(tpl) {
  // dzieli szablon na tekst i wyrażenia {...}
  const parts = [];
  let i = 0;
  while (i < tpl.length) {
    const s = tpl.indexOf('{', i);
    if (s < 0) { parts.push({ text: tpl.slice(i) }); break; }
    if (s > i) parts.push({ text: tpl.slice(i, s) });
    // znajdź pasujący }
    let depth = 0, j = s, inStr = null;
    for (; j < tpl.length; j++) {
      const c = tpl[j];
      if (inStr) { if (c === inStr && tpl[j - 1] !== '\\') inStr = null; continue; }
      if (c === '"' || c === "'") { inStr = c; continue; }
      if (c === '{') depth++;
      if (c === '}') { depth--; if (depth === 0) break; }
    }
    if (j >= tpl.length) throw new JsonPathError(`error parsing jsonpath ${tpl}, unclosed action`);
    parts.push({ expr: tpl.slice(s + 1, j).trim() });
    i = j + 1;
  }
  return parts;
}

function unescapeText(s) {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

// parsuje ścieżkę w segmenty
function parsePath(expr) {
  const segs = [];
  let i = 0;
  if (expr.startsWith('$')) i = 1;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '.') {
      if (expr[i + 1] === '.') { segs.push({ recursive: true }); i += 2; continue; }
      i++;
      let j = i;
      while (j < expr.length && /[^.\[]/.test(expr[j])) j++;
      const name = expr.slice(i, j);
      if (name) segs.push(name === '*' ? { wildcard: true } : { key: name });
      i = j;
    } else if (c === '[') {
      let depth = 0, j = i, inStr = null;
      for (; j < expr.length; j++) {
        const ch = expr[j];
        if (inStr) { if (ch === inStr) inStr = null; continue; }
        if (ch === '"' || ch === "'") { inStr = ch; continue; }
        if (ch === '[') depth++;
        if (ch === ']') { depth--; if (depth === 0) break; }
      }
      const inner = expr.slice(i + 1, j).trim();
      i = j + 1;
      if (inner === '*') segs.push({ wildcard: true });
      else if (inner.startsWith('?(')) segs.push({ filter: inner.slice(2, -1).trim() });
      else if (/^['"]/.test(inner)) segs.push({ key: inner.slice(1, -1) });
      else if (inner.includes(':')) {
        const [a, b] = inner.split(':').map((x) => (x.trim() === '' ? null : Number(x)));
        segs.push({ slice: [a, b] });
      } else if (inner.includes(',')) segs.push({ union: inner.split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')) });
      else segs.push({ index: Number(inner) });
    } else if (c === ' ') i++;
    else {
      let j = i;
      while (j < expr.length && /[^.\[]/.test(expr[j])) j++;
      segs.push({ key: expr.slice(i, j) });
      i = j;
    }
  }
  return segs;
}

function evalFilter(f, item) {
  // obsługa: @.a.b == "x", @.a != 'x', @.a (istnienie), @.a > 3
  const m = f.match(/^@((?:\.[\w-]+|\[[^\]]+\])*)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (m) {
    const vals = select(item, parsePath(m[1]));
    let rhs = m[3].trim();
    if (/^['"]/.test(rhs)) rhs = rhs.slice(1, -1);
    else if (!Number.isNaN(Number(rhs))) rhs = Number(rhs);
    else if (rhs === 'true' || rhs === 'false') rhs = rhs === 'true';
    return vals.some((v) => {
      switch (m[2]) {
        case '==': return v == rhs; // eslint-disable-line eqeqeq
        case '!=': return v != rhs; // eslint-disable-line eqeqeq
        case '>': return v > rhs;
        case '<': return v < rhs;
        case '>=': return v >= rhs;
        case '<=': return v <= rhs;
        default: return false;
      }
    });
  }
  const e = f.match(/^@((?:\.[\w-]+)*)$/);
  if (e) return select(item, parsePath(e[1])).length > 0;
  throw new JsonPathError(`unrecognized filter: ${f}`);
}

function select(root, segs) {
  let cur = [root];
  for (const s of segs) {
    const next = [];
    for (const v of cur) {
      if (v == null) continue;
      if (s.key !== undefined) { if (typeof v === 'object' && !Array.isArray(v) && v[s.key] !== undefined) next.push(v[s.key]); }
      else if (s.wildcard) { if (Array.isArray(v)) next.push(...v); else if (typeof v === 'object') next.push(...Object.values(v)); }
      else if (s.index !== undefined) { if (Array.isArray(v)) { const i = s.index < 0 ? v.length + s.index : s.index; if (v[i] !== undefined) next.push(v[i]); } }
      else if (s.slice) { if (Array.isArray(v)) next.push(...v.slice(s.slice[0] ?? 0, s.slice[1] ?? v.length)); }
      else if (s.union) { for (const k of s.union) { const x = Array.isArray(v) ? v[Number(k)] : v[k]; if (x !== undefined) next.push(x); } }
      else if (s.filter) { if (Array.isArray(v)) next.push(...v.filter((x) => evalFilter(s.filter, x))); }
      else if (s.recursive) {
        const walk = (x) => { next.push(x); if (x && typeof x === 'object') Object.values(x).forEach(walk); };
        walk(v);
      }
    }
    cur = next;
  }
  return cur;
}

function fmt(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function jsonpath(tpl, data) {
  let t = tpl.trim();
  // kubectl: jsonpath bez nawiasów {} jest akceptowany jako całe wyrażenie
  if (!t.includes('{')) t = `{${t}}`;
  const parts = tokenizeTemplate(t);
  let out = '';
  const run = (parts, ctx) => {
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.text !== undefined) { out += unescapeText(p.text); continue; }
      const e = p.expr;
      if (e.startsWith('range ')) {
        // znajdź pasujące end
        let depth = 1, j = i + 1;
        for (; j < parts.length; j++) {
          if (parts[j].expr?.startsWith('range ')) depth++;
          if (parts[j].expr === 'end') { depth--; if (depth === 0) break; }
        }
        if (j >= parts.length) throw new JsonPathError('error parsing jsonpath: not in range, nothing to end');
        const items = select(ctx, parsePath(e.slice(6).trim()));
        const body = parts.slice(i + 1, j);
        const list = items.length === 1 && Array.isArray(items[0]) ? items[0] : items;
        for (const it of list) run(body, it);
        i = j;
        continue;
      }
      if (e === 'end') continue;
      if (/^["']/.test(e)) { out += unescapeText(e.slice(1, -1)); continue; }
      if (e === '@' || e === '.') { out += fmt(ctx); continue; }
      const vals = select(ctx, parsePath(e.startsWith('@') ? e.slice(1) : e));
      out += vals.map(fmt).join(' ');
    }
  };
  run(parts, data);
  return out;
}
