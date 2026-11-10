// Wspólne pomocnicze dla poleceń kubectl.
import { dump, parseAll } from '../lib/yaml.js';
import { jsonpath, JsonPathError } from '../lib/jsonpath.js';
import { tableFor, customColumns, tableText, kindPrefix } from './printers.js';
import { ExitError, b64dec, get } from '../lib/util.js';
import { ApiError } from '../sim/cluster.js';

export class KErr extends ExitError {}
export const fail = (msg, code = 1) => { throw new KErr(code, msg); };

// usuwa pola wewnętrzne symulatora (__xxx)
export function clean(o) {
  if (Array.isArray(o)) return o.map(clean);
  if (!o || typeof o !== 'object') return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) if (!k.startsWith('__')) out[k] = clean(v);
  return out;
}

export function qualifiedName(r) { return r.group ? `${r.plural}.${r.group}` : r.plural; }
export function refName(r, o) { return `${kindPrefix(r)}/${o.metadata.name}`; }

export function apiMsg(e, ctx = '') {
  if (e instanceof ApiError) return e.kubectlMessage(ctx);
  return e.message;
}

// ------------------------------------------------------------------ argumenty zasobów
const ALL = ['pods', 'services', 'daemonsets.apps', 'deployments.apps', 'replicasets.apps', 'statefulsets.apps', 'horizontalpodautoscalers.autoscaling', 'jobs.batch', 'cronjobs.batch'];

export function resolveType(c, t) {
  const r = c.registry.resolve(t);
  if (!r) fail(`error: the server doesn't have a resource type "${t}"`);
  return r;
}

// "pods", "po x y", "po,svc", "deploy/x", "all"
export function parseResourceArgs(c, pos, { requireName = false, verb = 'get' } = {}) {
  if (!pos.length) return [];
  const groups = [];
  if (pos[0].includes('/')) {
    for (const p of pos) {
      if (!p.includes('/')) fail(`error: there is no need to specify a resource type as a separate argument when passing arguments in resource/name form (e.g. 'kubectl ${verb} resource/<resource_name>' instead of 'kubectl ${verb} resource resource/<resource_name>'`);
      const i = p.indexOf('/');
      const r = resolveType(c, p.slice(0, i));
      const name = p.slice(i + 1);
      const g = groups.find((x) => x.r === r);
      if (g) g.names.push(name); else groups.push({ r, names: [name] });
    }
    return groups;
  }
  const types = pos[0].split(',').filter(Boolean);
  const names = pos.slice(1);
  for (const n of names) if (n.includes('/')) fail(`error: there is no need to specify a resource type as a separate argument when passing arguments in resource/name form (e.g. 'kubectl ${verb} resource/<resource_name>' instead of 'kubectl ${verb} resource resource/<resource_name>'`);
  for (const t of types) {
    if (t === 'all') { for (const a of ALL) groups.push({ r: c.registry.resolve(a), names, all: true }); continue; }
    groups.push({ r: resolveType(c, t), names });
  }
  if (requireName && !names.length) fail(`error: resource(s) were provided, but no name was specified`);
  return groups;
}

// ------------------------------------------------------------------ pliki manifestów
export function readManifestSources(x, files, { recursive = false } = {}) {
  const docs = [];
  for (const f of files) {
    if (f === '-') { docs.push(...decodeDocs(x.io.stdin || '', '-')); continue; }
    if (/^https?:\/\//.test(f)) {
      const m = x.manifests?.(f);
      if (!m) fail(`error: unable to read URL "${f}", server reported 404 Not Found, status code=404`);
      docs.push(...decodeDocs(m, f));
      continue;
    }
    const p = x.sh.abs(f);
    if (!x.sh.fs.exists(p)) fail(`error: the path "${f}" does not exist`);
    if (x.sh.fs.isDir(p)) {
      const walk = (dir) => {
        for (const n of x.sh.fs.list(dir).sort()) {
          const fp = `${dir}/${n}`;
          if (x.sh.fs.isDir(fp)) { if (recursive) walk(fp); continue; }
          if (/\.(ya?ml|json)$/.test(n)) docs.push(...decodeDocs(x.sh.fs.read(fp, x.sh.user), fp.replace(p, f.replace(/\/$/, ''))));
        }
      };
      walk(p);
      continue;
    }
    let text;
    try { text = x.sh.fs.read(p, x.sh.user); } catch (e) { fail(`error: open ${f}: permission denied`); }
    docs.push(...decodeDocs(text, f));
  }
  return docs;
}

export function decodeDocs(text, source) {
  let list;
  try {
    const t = text.trim();
    list = t.startsWith('{') ? [JSON.parse(t)] : parseAll(text);
  } catch (e) {
    fail(`error: error parsing ${source}: ${e.message}`);
  }
  const out = [];
  for (const d of list) {
    if (!d) continue;
    if (typeof d !== 'object') fail(`error: error validating "${source}": error validating data: invalid object to validate; if you choose to ignore these errors, turn validation off with --validate=false`);
    if (d.kind === 'List' || (d.kind && d.kind.endsWith('List') && Array.isArray(d.items))) { for (const it of d.items || []) out.push({ obj: it, source }); continue; }
    out.push({ obj: d, source });
  }
  return out;
}

// ------------------------------------------------------------------ wypisywanie
export function parseOutput(o) {
  if (!o) return { kind: 'table' };
  if (o === 'wide') return { kind: 'table', wide: true };
  if (o === 'yaml' || o === 'json' || o === 'name') return { kind: o };
  let m;
  if ((m = o.match(/^jsonpath(-as-json)?=(.*)$/s))) return { kind: 'jsonpath', tpl: m[2] };
  if ((m = o.match(/^jsonpath-file=(.*)$/))) return { kind: 'jsonpath-file', file: m[1] };
  if ((m = o.match(/^custom-columns=(.*)$/s))) return { kind: 'cc', spec: m[1] };
  if ((m = o.match(/^custom-columns-file=(.*)$/))) return { kind: 'cc-file', file: m[1] };
  if ((m = o.match(/^go-template=(.*)$/s))) return { kind: 'gotpl', tpl: m[1] };
  if ((m = o.match(/^go-template-file=(.*)$/))) return { kind: 'gotpl-file', file: m[1] };
  if (o === 'jsonpath' || o === 'custom-columns' || o === 'go-template') fail(`error: ${o} template format specified but no template given`);
  fail(`error: unable to match a printer suitable for the output format "${o}", allowed formats are: custom-columns,custom-columns-file,go-template,go-template-file,json,jsonpath,jsonpath-as-json,jsonpath-file,name,template,templatefile,wide,yaml`);
}

export function toYaml(o) { return dump(clean(o)); }
export function toJson(o) { return JSON.stringify(clean(o), null, 4) + '\n'; }

export function asList(items) {
  return { apiVersion: 'v1', items: items.map(clean), kind: 'List', metadata: { resourceVersion: '' } };
}

// zwraca tekst; groups: [{r, items}]; single = jeden nazwany obiekt
export function render(x, groups, out, { single = false, flags = {} } = {}) {
  const allItems = groups.flatMap((g) => g.items);
  if (out.kind === 'yaml') return single && allItems.length === 1 ? toYaml(allItems[0]) : toYaml(asList(allItems));
  if (out.kind === 'json') return single && allItems.length === 1 ? toJson(allItems[0]) : toJson(asList(allItems));
  if (out.kind === 'name') return groups.flatMap((g) => g.items.map((o) => `${kindPrefix(g.r)}/${o.metadata.name}\n`)).join('');
  if (out.kind === 'jsonpath' || out.kind === 'jsonpath-file') {
    const tpl = out.kind === 'jsonpath' ? out.tpl : x.sh.fs.read(x.sh.abs(out.file));
    const data = single && allItems.length === 1 ? clean(allItems[0]) : asList(allItems);
    try { return jsonpath(tpl, data); } catch (e) {
      if (e instanceof JsonPathError) fail(`error: error executing jsonpath "${tpl}": ${e.message}. Printing more information for debugging the template:\n\ttemplate was:\n\t\t${tpl}\n\tobject given to jsonpath engine was:\n\t\t${JSON.stringify(data).slice(0, 200)}\n\n`);
      throw e;
    }
  }
  if (out.kind === 'gotpl' || out.kind === 'gotpl-file') {
    const tpl = out.kind === 'gotpl' ? out.tpl : x.sh.fs.read(x.sh.abs(out.file));
    const data = single && allItems.length === 1 ? clean(allItems[0]) : asList(allItems);
    return goTemplate(tpl, data);
  }
  if (out.kind === 'cc' || out.kind === 'cc-file') {
    let spec = out.spec;
    if (out.kind === 'cc-file') {
      const t = x.sh.fs.read(x.sh.abs(out.file)).trim().split('\n');
      const heads = t[0].trim().split(/\s+/), paths = (t[1] || '').trim().split(/\s+/);
      spec = heads.map((h, i) => `${h}:${paths[i]}`).join(',');
    }
    let rows;
    try { rows = customColumns(spec, allItems); } catch (e) { fail(`error: ${e.message}`); }
    return tableText(rows, flags['no-headers']);
  }
  // tabele
  const multi = groups.length > 1 || groups.some((g) => g.all);
  const parts = [];
  for (const g of groups) {
    if (!g.items.length) continue;
    const t = tableFor(g.r, g.items, { wide: out.wide, showKind: multi || flags['show-kind'], allNs: x.allNs, showLabels: flags['show-labels'], labelCols: (flags['label-columns'] || []).flatMap((s) => s.split(',')), noHeaders: flags['no-headers'], now: x.c.now() });
    parts.push(t.text);
  }
  return parts.join('\n');
}

// ------------------------------------------------------------------ go-template (podzbiór)
export function goTemplate(tpl, data) {
  const toks = [];
  const re = /\{\{-?\s*(.*?)\s*-?\}\}/gs;
  let last = 0, m;
  while ((m = re.exec(tpl))) {
    if (m.index > last) toks.push({ t: 'text', v: tpl.slice(last, m.index) });
    toks.push({ t: 'act', v: m[1] });
    last = re.lastIndex;
  }
  if (last < tpl.length) toks.push({ t: 'text', v: tpl.slice(last) });
  let i = 0;
  const evalExpr = (expr, dot, vars) => {
    const parts = expr.split('|').map((s) => s.trim());
    let v = evalTerm(parts[0], dot, vars);
    for (const f of parts.slice(1)) {
      if (f === 'base64decode') v = b64dec(String(v ?? ''));
      else if (f === 'base64encode') v = btoa(String(v));
      else if (f === 'len') v = Array.isArray(v) ? v.length : Object.keys(v || {}).length;
      else if (f === 'printf "%s\\n"') v = `${v}\n`;
    }
    return v;
  };
  const evalTerm = (t, dot, vars) => {
    let mm;
    if ((mm = t.match(/^index\s+(\S+)\s+"([^"]*)"$/))) { const base = evalTerm(mm[1], dot, vars); return base?.[mm[2]]; }
    if ((mm = t.match(/^printf\s+"([^"]*)"\s+(.*)$/))) { const args = mm[2].split(/\s+/).map((a) => evalTerm(a, dot, vars)); let k = 0; return mm[1].replace(/%[sdv]/g, () => String(args[k++] ?? '')).replace(/\\n/g, '\n').replace(/\\t/g, '\t'); }
    if ((mm = t.match(/^"(.*)"$/))) return mm[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    if (t === '.') return dot;
    if (t.startsWith('$')) { const [vn, ...rest] = t.split('.'); const base = vars[vn]; return rest.length ? get(base, rest.join('.')) : base; }
    if (t.startsWith('.')) return get(dot, t.slice(1));
    return t;
  };
  const run = (dot, vars, stopAt) => {
    let out = '';
    while (i < toks.length) {
      const tk = toks[i];
      if (tk.t === 'text') { out += tk.v; i++; continue; }
      const a = tk.v;
      if (stopAt.includes(a.split(/\s/)[0])) return out;
      i++;
      let mm;
      if ((mm = a.match(/^range\s+(?:(\$\w+)\s*,\s*(\$\w+)\s*:=\s*)?(.+)$/))) {
        const coll = evalExpr(mm[3], dot, vars);
        const start = i;
        const entries = Array.isArray(coll) ? coll.map((v, k) => [k, v]) : coll && typeof coll === 'object' ? Object.entries(coll).sort(([p], [q]) => (p < q ? -1 : 1)) : [];
        if (!entries.length) { run(dot, vars, ['end']); i++; continue; }
        for (const [k, v] of entries) {
          i = start;
          const nv = { ...vars };
          if (mm[1]) { nv[mm[1]] = k; nv[mm[2]] = v; }
          out += run(v, nv, ['end']);
        }
        i++;
        continue;
      }
      if ((mm = a.match(/^if\s+(.+)$/))) {
        const cond = evalExpr(mm[1], dot, vars);
        const yes = cond && !(Array.isArray(cond) && !cond.length);
        const a1 = run(dot, vars, ['else', 'end']);
        let a2 = '';
        if (toks[i]?.v === 'else') { i++; a2 = run(dot, vars, ['end']); }
        i++;
        out += yes ? a1 : a2;
        continue;
      }
      if (a === 'end' || a === 'else') continue;
      const v = evalExpr(a, dot, vars);
      out += v === undefined || v === null ? '<no value>' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    return out;
  };
  return run(data, { $: data }, []);
}
