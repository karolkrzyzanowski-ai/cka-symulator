// Podstawowe narzędzia (coreutils, grep, sed, awk, yq ...).
import { ExitError, normPath, basename, dirname, b64enc, b64dec, globToRegex } from '../../lib/util.js';
import { parseAll, dump, parseOne } from '../../lib/yaml.js';
import { FsError } from '../vfs.js';
import { IO } from '../interp.js';

// ------------------------------------------------------------------ pomocnicze
export function parseOpts(args, spec) {
  // spec: { short: 'abc', withArg: 'nf', long: {name: 'arg'|'bool'} }
  const opts = {}, rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { rest.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--') && a.length > 2) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      const t = spec.long?.[k];
      if (t === 'arg') opts[k] = v ?? args[++i];
      else opts[k] = v ?? true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d+$/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if ((spec.withArg || '').includes(ch)) {
          opts[ch] = a.slice(j + 1) || args[++i];
          break;
        }
        opts[ch] = true;
      }
      continue;
    }
    rest.push(a);
  }
  return { opts, rest };
}

function readSources(files, io, sh, cmd) {
  const out = [];
  let err = false;
  if (!files.length || (files.length === 1 && files[0] === '-')) return { texts: [{ name: '-', text: io.stdin ?? '' }], err };
  for (const f of files) {
    if (f === '-') { out.push({ name: '-', text: io.stdin ?? '' }); continue; }
    try {
      out.push({ name: f, text: sh.fs.read(sh.abs(f), sh.user) });
    } catch (e) {
      io.eline(`${cmd}: ${f}: ${e.reason || 'No such file or directory'}`);
      err = true;
    }
  }
  return { texts: out, err };
}

const lines = (t) => { const l = t.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };

// BRE -> JS RegExp
export function bre(p, extended) {
  if (extended) return p.replace(/\\</g, '\\b').replace(/\\>/g, '\\b');
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\' && i + 1 < p.length) {
      const n = p[i + 1];
      if ('|+?(){}'.includes(n)) out += n;
      else if (n === '<' || n === '>') out += '\\b';
      else out += c + n;
      i++;
      continue;
    }
    if ('|+?(){}'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return out;
}

// ------------------------------------------------------------------ polecenia
export const CORE = {
  *cat(args, io, sh) {
    const { opts, rest } = parseOpts(args, { short: 'nAvE' });
    const { texts, err } = readSources(rest, io, sh, 'cat');
    let n = 1;
    for (const t of texts) {
      if (opts.n) io.out(lines(t.text).map((l) => `${String(n++).padStart(6)}\t${l}`).join('\n') + (t.text ? '\n' : ''));
      else io.out(t.text);
    }
    return err ? 1 : 0;
  },
  *tac(args, io, sh) { const { texts } = readSources(args, io, sh, 'tac'); for (const t of texts) io.out(lines(t.text).reverse().join('\n') + '\n'); return 0; },
  *head(args, io, sh) {
    let n = 10, bytes = null;
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-n') n = parseInt(args[++i], 10);
      else if (/^-n\d+$/.test(a)) n = parseInt(a.slice(2), 10);
      else if (/^-\d+$/.test(a)) n = parseInt(a.slice(1), 10);
      else if (a === '-c') bytes = parseInt(args[++i], 10);
      else files.push(a);
    }
    const { texts, err } = readSources(files, io, sh, 'head');
    for (const t of texts) {
      if (texts.length > 1) io.line(`==> ${t.name} <==`);
      if (bytes !== null) io.out(t.text.slice(0, bytes));
      else { const l = lines(t.text); io.out((n < 0 ? l.slice(0, n) : l.slice(0, n)).map((x) => x + '\n').join('')); }
    }
    return err ? 1 : 0;
  },
  *tail(args, io, sh) {
    let n = 10, from = null, follow = false;
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-n') { const v = args[++i]; if (v.startsWith('+')) from = parseInt(v, 10); else n = parseInt(v, 10); } else if (/^-n[+\d]/.test(a)) { const v = a.slice(2); if (v.startsWith('+')) from = parseInt(v, 10); else n = parseInt(v, 10); } else if (/^-n?\+\d+$/.test(a) || /^\+\d+$/.test(a)) from = parseInt(a.replace(/^-n?/, ''), 10);
      else if (/^-\d+$/.test(a)) n = parseInt(a.slice(1), 10);
      else if (a === '-f' || a === '-F' || a === '--follow') follow = true;
      else if (/^-[fFn]+$/.test(a)) { follow = true; }
      else if (a === '--retry' || a === '-s') { if (a === '-s') i++; } else files.push(a);
    }
    const pick = (text) => { const l = lines(text); return (from !== null ? l.slice(Math.max(0, from - 1)) : l.slice(Math.max(0, l.length - n))).map((x) => x + '\n').join(''); };
    if (!follow) {
      const { texts, err } = readSources(files, io, sh, 'tail');
      for (const t of texts) { if (texts.length > 1) io.line(`==> ${t.name} <==`); io.out(pick(t.text)); }
      return err ? 1 : 0;
    }
    // tryb śledzenia (długotrwały)
    const f = files[0];
    if (!f) { io.out(pick(io.stdin || '')); return 0; }
    let seen = 0, reported = false;
    while (true) {
      let text = null;
      try { text = sh.fs.read(sh.abs(f), sh.user); } catch { text = null; }
      if (text === null) {
        if (!reported) { io.eline(`tail: cannot open '${f}' for reading: No such file or directory`); reported = true; }
      } else {
        if (seen === 0 && text.length) { io.out(pick(text)); seen = text.length; } else if (text.length > seen) { io.out(text.slice(seen)); seen = text.length; } else if (text.length < seen) { io.eline(`tail: ${f}: file truncated`); seen = 0; }
      }
      yield { type: 'sleep', ms: 1000, follow: true };
    }
  },
  *grep(args, io, sh) {
    const { opts, rest } = parseOpts(args, { short: 'ivncloEFwqrRhHsxzP', withArg: 'eABCmf', long: { color: 'bool', colour: 'bool', include: 'arg', 'exclude-dir': 'arg' } });
    let pats = [];
    if (opts.e) pats.push(opts.e);
    const files = [...rest];
    if (!pats.length) { if (!files.length) { io.eline('Usage: grep [OPTION]... PATTERNS [FILE]...'); return 2; } pats.push(files.shift()); }
    let re;
    try {
      const src = pats.map((p) => (opts.F ? p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : bre(p, opts.E || opts.P))).map((p) => (opts.w ? `\\b(?:${p})\\b` : opts.x ? `^(?:${p})$` : p)).join('|');
      re = new RegExp(src, opts.i ? 'i' : '');
    } catch (e) { io.eline(`grep: Invalid regular expression`); return 2; }
    let targets = files;
    if ((opts.r || opts.R) && !files.length) targets = ['.'];
    let srcs = [];
    if (opts.r || opts.R) {
      for (const f of targets) {
        const p = sh.abs(f);
        if (sh.fs.isDir(p)) for (const fp of sh.fs.walkFiles(p)) { try { srcs.push({ name: f === '.' ? fp.slice(sh.cwd.length + 1) : (f.replace(/\/$/, '') + fp.slice(p.length)), text: sh.fs.read(fp, sh.user) }); } catch { /* */ } } else { const r = readSources([f], io, sh, 'grep'); srcs.push(...r.texts); }
      }
    } else {
      for (const f of targets) {
        if (f !== '-' && sh.fs.isDir(sh.abs(f))) { io.eline(`grep: ${f}: Is a directory`); continue; }
        srcs.push(...readSources([f], io, sh, 'grep').texts);
      }
      if (!targets.length) srcs = [{ name: '(standard input)', text: io.stdin ?? '' }];
    }
    const multi = srcs.length > 1 || opts.r || opts.R;
    let found = 0;
    const A = Number(opts.A || opts.C || 0), B = Number(opts.B || opts.C || 0);
    for (const s of srcs) {
      const ls = lines(s.text);
      let count = 0, lastPrinted = -1;
      const prefix = (i, sep = ':') => `${(multi && !opts.h) || opts.H ? s.name + sep : ''}${opts.n ? i + 1 + sep : ''}`;
      for (let i = 0; i < ls.length; i++) {
        const m = re.test(ls[i]) !== !!opts.v;
        if (!m) continue;
        count++;
        found++;
        if (opts.q) return 0;
        if (opts.l || opts.c) continue;
        if (opts.m && count > Number(opts.m)) break;
        if (A || B) {
          if (lastPrinted >= 0 && i - B > lastPrinted + 1) io.line('--');
          for (let k = Math.max(lastPrinted + 1, i - B); k < i; k++) io.line(prefix(k, '-') + ls[k]);
        }
        if (opts.o && !opts.v) {
          const g = new RegExp(re.source, re.flags + 'g');
          for (const mm of ls[i].match(g) || []) io.line(prefix(i) + mm);
        } else io.line(prefix(i) + ls[i]);
        lastPrinted = i;
        if (A) {
          for (let k = i + 1; k <= Math.min(ls.length - 1, i + A); k++) {
            if (re.test(ls[k]) !== !!opts.v) break;
            io.line(prefix(k, '-') + ls[k]);
            lastPrinted = k;
          }
        }
      }
      if (opts.c) io.line((multi ? s.name + ':' : '') + count);
      if (opts.l && count) io.line(s.name);
    }
    return found ? 0 : 1;
  },
  *egrep(args, io, sh) { return yield* CORE.grep(['-E', ...args], io, sh); },
  *fgrep(args, io, sh) { return yield* CORE.grep(['-F', ...args], io, sh); },
  *wc(args, io, sh) {
    const { opts, rest } = parseOpts(args, { short: 'lwcm' });
    const { texts, err } = readSources(rest, io, sh, 'wc');
    const all = !opts.l && !opts.w && !opts.c && !opts.m;
    for (const t of texts) {
      const parts = [];
      if (opts.l || all) parts.push((t.text.match(/\n/g) || []).length);
      if (opts.w || all) parts.push(t.text.split(/\s+/).filter(Boolean).length);
      if (opts.c || opts.m || all) parts.push(new TextEncoder().encode(t.text).length);
      const w = all ? 7 : 1;
      io.line(parts.map((x) => String(x).padStart(texts.length > 1 || rest.length ? w : 1)).join(' ') + (t.name !== '-' ? ` ${t.name}` : ''));
    }
    return err ? 1 : 0;
  },
  *sort(args, io, sh) {
    const { opts, rest } = parseOpts(args, { short: 'nruhVfb', withArg: 'kt' });
    const { texts } = readSources(rest, io, sh, 'sort');
    let ls = texts.flatMap((t) => lines(t.text));
    const key = (l) => {
      if (!opts.k) return l;
      const k = parseInt(String(opts.k), 10) - 1;
      const f = opts.t ? l.split(opts.t) : l.trim().split(/\s+/);
      return f.slice(k).join(opts.t || ' ');
    };
    const hnum = (s) => { const m = String(s).trim().match(/^([\d.]+)([KMGTP]i?)?/i); if (!m) return 0; return parseFloat(m[1]) * ({ k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[(m[2] || '')[0]?.toLowerCase()] || 1); };
    const vkey = (s) => String(s).split(/(\d+)/).map((x) => (/^\d+$/.test(x) ? x.padStart(12, '0') : x)).join('');
    ls.sort((a, b) => {
      const ka = key(a), kb = key(b);
      let r;
      if (opts.n) r = (parseFloat(ka) || 0) - (parseFloat(kb) || 0);
      else if (opts.h) r = hnum(ka) - hnum(kb);
      else if (opts.V) r = vkey(ka) < vkey(kb) ? -1 : vkey(ka) > vkey(kb) ? 1 : 0;
      else { const x = opts.f ? ka.toLowerCase() : ka, y = opts.f ? kb.toLowerCase() : kb; r = x < y ? -1 : x > y ? 1 : 0; }
      return opts.r ? -r : r;
    });
    if (opts.u) ls = ls.filter((l, i) => i === 0 || key(l) !== key(ls[i - 1]));
    io.out(ls.map((l) => l + '\n').join(''));
    return 0;
  },
  *uniq(args, io, sh) {
    const { opts, rest } = parseOpts(args, { short: 'cdui' });
    const { texts } = readSources(rest, io, sh, 'uniq');
    const ls = lines(texts[0]?.text || '');
    const groups = [];
    for (const l of ls) { const last = groups[groups.length - 1]; if (last && (opts.i ? last[0].toLowerCase() === l.toLowerCase() : last[0] === l)) last[1]++; else groups.push([l, 1]); }
    for (const [l, n] of groups) {
      if (opts.d && n < 2) continue;
      if (opts.u && n > 1) continue;
      io.line(opts.c ? `${String(n).padStart(7)} ${l}` : l);
    }
    return 0;
  },
  *cut(args, io, sh) {
    const { opts, rest } = parseOpts(args, { short: 's', withArg: 'dfc', long: { delimiter: 'arg', fields: 'arg' } });
    const d = opts.d ?? opts.delimiter ?? '\t';
    const spec = opts.f ?? opts.fields ?? opts.c;
    if (!spec) { io.eline('cut: you must specify a list of bytes, characters, or fields'); return 1; }
    const sel = (n) => String(spec).split(',').some((r) => {
      const [a, b] = r.split('-');
      if (b === undefined) return n === Number(a);
      return n >= (a === '' ? 1 : Number(a)) && n <= (b === '' ? Infinity : Number(b));
    });
    const { texts } = readSources(rest, io, sh, 'cut');
    for (const l of texts.flatMap((t) => lines(t.text))) {
      if (opts.c) { io.line([...l].filter((_, i) => sel(i + 1)).join('')); continue; }
      if (!l.includes(d)) { if (!opts.s) io.line(l); continue; }
      io.line(l.split(d).filter((_, i) => sel(i + 1)).join(d));
    }
    return 0;
  },
  *tr(args, io) {
    const { opts, rest } = parseOpts(args, { short: 'dsc' });
    const expand = (s) => {
      s = s.replace(/\[:upper:\]/g, 'A-Z').replace(/\[:lower:\]/g, 'a-z').replace(/\[:digit:\]/g, '0-9').replace(/\[:space:\]/g, ' \t\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      let out = '';
      for (let i = 0; i < s.length; i++) {
        if (s[i + 1] === '-' && s[i + 2]) { for (let c = s.charCodeAt(i); c <= s.charCodeAt(i + 2); c++) out += String.fromCharCode(c); i += 2; } else out += s[i];
      }
      return out;
    };
    const a = expand(rest[0] || ''), b = expand(rest[1] || '');
    let t = io.stdin || '';
    if (opts.d) t = [...t].filter((ch) => !a.includes(ch)).join('');
    else if (b) t = [...t].map((ch) => { const i = a.indexOf(ch); return i >= 0 ? (b[i] ?? b[b.length - 1]) : ch; }).join('');
    if (opts.s) { const set = b || a; t = t.replace(new RegExp(`([${set.replace(/[\]\\^-]/g, '\\$&')}])\\1+`, 'g'), '$1'); }
    io.out(t);
    return 0;
  },
  *sed(args, io, sh) {
    let inplace = false, quiet = false, ext = false;
    const scripts = [], files = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-i' || a.startsWith('-i')) inplace = true;
      else if (a === '-n') quiet = true;
      else if (a === '-E' || a === '-r') ext = true;
      else if (a === '-e') scripts.push(args[++i]);
      else if (/^-[nEr]+$/.test(a)) { if (a.includes('n')) quiet = true; if (/[Er]/.test(a)) ext = true; } else if (!scripts.length && !a.startsWith('-')) scripts.push(a);
      else files.push(a);
    }
    if (!scripts.length) { io.eline('Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...'); return 1; }
    let prog;
    try { prog = scripts.flatMap((s) => s.split(/;(?![^/]*\/[^/]*\/)|\n/).map((x) => x.trim()).filter(Boolean)).map((s) => parseSed(s, ext)); } catch (e) { io.eline(`sed: -e expression #1, char ${e.pos || 1}: ${e.message}`); return 1; }
    const run = (text) => {
      const ls = lines(text);
      const out = [];
      for (let i = 0; i < ls.length; i++) {
        let line = ls[i];
        let del = false;
        const extra = [];
        for (const cmd of prog) {
          if (!sedAddr(cmd.addr, line, i, ls.length)) continue;
          if (cmd.op === 'd') { del = true; break; }
          if (cmd.op === 'p') extra.push(line);
          if (cmd.op === 's') {
            const before = line;
            line = line.replace(cmd.re, cmd.rep);
            if (cmd.print && before !== line) extra.push(line);
          }
          if (cmd.op === 'a') { out.push(...(quiet ? [] : [line]), cmd.text); del = true; break; }
          if (cmd.op === 'i') out.push(cmd.text);
          if (cmd.op === 'c') { line = cmd.text; }
        }
        if (!del && !quiet) out.push(line);
        out.push(...extra);
      }
      return out.length ? out.join('\n') + '\n' : '';
    };
    if (inplace) {
      for (const f of files) {
        try { sh.fs.write(sh.abs(f), run(sh.fs.read(sh.abs(f), sh.user)), { user: sh.user }); } catch (e) {
          io.eline(e.code === 'EACCES' ? `sed: couldn't open temporary file ${dirname(sh.abs(f))}/sed${Math.random().toString(36).slice(2, 8)}: Permission denied` : `sed: can't read ${f}: No such file or directory`);
          return 4;
        }
      }
      return 0;
    }
    const { texts, err } = readSources(files, io, sh, 'sed');
    for (const t of texts) io.out(run(t.text));
    return err ? 2 : 0;
  },
  *awk(args, io, sh) {
    let fs = null, prog = null;
    const files = [], vars = {};
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-F') fs = args[++i];
      else if (a.startsWith('-F')) fs = a.slice(2);
      else if (a === '-v') { const [k, v] = args[++i].split('='); vars[k] = v; } else if (prog === null) prog = a;
      else files.push(a);
    }
    if (prog === null) { io.eline("usage: awk [-F fs][-v var=value][prog | -f progfile][file ...]"); return 2; }
    let compiled;
    try { compiled = compileAwk(prog); } catch (e) { io.eline(`awk: syntax error at source line 1\n context is\n\t${prog}`); return 2; }
    const { texts } = readSources(files, io, sh, 'awk');
    const text = texts.map((t) => t.text).join('');
    try { io.out(compiled(lines(text), fs, vars)); } catch (e) { io.eline(`awk: ${e.message}`); return 2; }
    return 0;
  },
  *tee(args, io, sh) {
    const { opts, rest } = parseOpts(args, { short: 'a' });
    const data = io.stdin ?? '';
    let st = 0;
    for (const f of rest) {
      try { sh.fs.write(sh.abs(f), data, { append: !!opts.a, user: sh.user }); } catch (e) { io.eline(`tee: ${f}: ${e.reason || e.message}`); st = 1; }
    }
    io.out(data);
    return st;
  },
  *ls(args, io, sh) {
    const { opts, rest } = parseOpts(args, { short: 'laAh1RdtrSF', long: { color: 'bool', all: 'bool' } });
    const targets = rest.length ? rest : ['.'];
    let st = 0;
    const fmtMode = (s, path) => {
      const t = s.type === 'dir' ? 'd' : '-';
      const m = s.mode ?? 0o644;
      const bits = [6, 3, 0].map((sft) => `${m >> sft & 4 ? 'r' : '-'}${m >> sft & 2 ? 'w' : '-'}${m >> sft & 1 ? (m & 0o1000 && sft === 0 ? 't' : 'x') : (m & 0o1000 && sft === 0 ? 'T' : '-')}`).join('');
      void path;
      return t + bits;
    };
    const longLine = (name, p) => {
      const s = sh.fs.stat(p);
      const d = new Date(sh.opts.clock?.() || Date.now());
      const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
      const size = opts.h && s.size > 1024 ? `${(s.size / 1024).toFixed(1)}K` : String(s.size);
      return `${fmtMode(s, p)} ${s.type === 'dir' ? 2 : 1} ${(s.owner || 'root').padEnd(9)} ${(s.owner || 'root').padEnd(9)} ${size.padStart(6)} ${mon} ${String(d.getUTCDate()).padStart(2)} ${d.toISOString().slice(11, 16)} ${name}`;
    };
    targets.forEach((t, idx) => {
      const p = sh.abs(t);
      try {
        if (!sh.fs.exists(p)) throw new FsError('ENOENT', t);
        if (!sh.fs.isDir(p) || opts.d) { io.line(opts.l ? longLine(t, p) : t); return; }
        let names = sh.fs.list(p, sh.user);
        if (!opts.a && !opts.A && !opts.all) names = names.filter((n) => !n.startsWith('.'));
        if (opts.a || opts.all) names = ['.', '..', ...names];
        if (opts.r) names.reverse();
        if (targets.length > 1) { if (idx) io.line(''); io.line(`${t}:`); }
        if (opts.l) {
          io.line(`total ${names.length * 4}`);
          for (const n of names) io.line(longLine(n + (opts.F && sh.fs.isDir(p + '/' + n) ? '/' : ''), n === '.' || n === '..' ? p : normPath(p + '/' + n)));
        } else if (opts['1'] || io.sink === null) io.out(names.map((n) => n + '\n').join(''));
        else if (names.length) io.line(names.map((n) => n + (opts.F && sh.fs.isDir(p + '/' + n) ? '/' : '')).join('  '));
        if (opts.R) for (const n of names) if (sh.fs.isDir(normPath(p + '/' + n)) && n !== '.' && n !== '..') { io.line(''); CORE.ls(['-R', ...(opts.l ? ['-l'] : []), normPath(t + '/' + n)], io, sh).next(); }
      } catch (e) {
        io.eline(e.code === 'EACCES' ? `ls: cannot open directory '${t}': Permission denied` : `ls: cannot access '${t}': No such file or directory`);
        st = 2;
      }
    });
    return st;
  },
  *mkdir(args, io, sh) {
    const { opts, rest } = parseOpts(args, { short: 'pv', withArg: 'm' });
    let st = 0;
    for (const d of rest) {
      try { sh.fs.mkdir(sh.abs(d), { p: !!opts.p, user: sh.user }); } catch (e) {
        io.eline(`mkdir: cannot create directory '${d}': ${e.code === 'EEXIST' ? 'File exists' : e.reason}`);
        st = 1;
      }
    }
    return st;
  },
  *rmdir(args, io, sh) { for (const d of args) { try { sh.fs.rmdir(sh.abs(d)); } catch (e) { io.eline(`rmdir: failed to remove '${d}': ${e.reason}`); return 1; } } return 0; },
  *rm(args, io, sh) {
    const { opts, rest } = parseOpts(args, { short: 'rfRiv' });
    let st = 0;
    for (const f of rest) {
      const p = sh.abs(f);
      try {
        if (sh.fs.isDir(p) && !opts.r && !opts.R) { io.eline(`rm: cannot remove '${f}': Is a directory`); st = 1; continue; }
        sh.fs.remove(p, { recursive: !!(opts.r || opts.R), user: sh.user, force: !!opts.f });
      } catch (e) {
        if (!opts.f || e.code !== 'ENOENT') { io.eline(`rm: cannot remove '${f}': ${e.reason}`); st = 1; }
      }
    }
    return st;
  },
  *cp(args, io, sh) {
    const { opts, rest } = parseOpts(args, { short: 'rRpaf' });
    if (rest.length < 2) { io.eline(`cp: missing destination file operand after '${rest[0] || ''}'`); return 1; }
    const dst = rest.pop();
    let st = 0;
    for (const s of rest) {
      try { sh.fs.copy(sh.abs(s), sh.abs(dst), { user: sh.user, recursive: !!(opts.r || opts.R || opts.a) }); } catch (e) {
        if (e.code === 'EISDIR') io.eline(`cp: -r not specified; omitting directory '${s}'`);
        else io.eline(e.code === 'EACCES' ? `cp: cannot create regular file '${dst}': Permission denied` : `cp: cannot stat '${s}': No such file or directory`);
        st = 1;
      }
    }
    return st;
  },
  *mv(args, io, sh) {
    const { rest } = parseOpts(args, { short: 'fiv' });
    if (rest.length < 2) { io.eline(`mv: missing destination file operand after '${rest[0] || ''}'`); return 1; }
    const dst = rest.pop();
    for (const s of rest) {
      try { sh.fs.move(sh.abs(s), sh.abs(dst), { user: sh.user }); } catch (e) {
        io.eline(e.code === 'EACCES' ? `mv: cannot move '${s}' to '${dst}': Permission denied` : `mv: cannot stat '${s}': No such file or directory`);
        return 1;
      }
    }
    return 0;
  },
  *touch(args, io, sh) {
    for (const f of args.filter((a) => !a.startsWith('-'))) {
      const p = sh.abs(f);
      try { if (!sh.fs.exists(p)) sh.fs.write(p, '', { user: sh.user }); } catch (e) { io.eline(`touch: cannot touch '${f}': ${e.reason}`); return 1; }
    }
    return 0;
  },
  *chmod(args, io, sh) {
    const rest = args.filter((a) => a !== '-R');
    const mode = rest.shift();
    for (const f of rest) {
      const p = sh.abs(f);
      if (!sh.fs.exists(p)) { io.eline(`chmod: cannot access '${f}': No such file or directory`); return 1; }
      if (sh.user !== 'root' && sh.fs.stat(p).owner !== sh.user) { io.eline(`chmod: changing permissions of '${f}': Operation not permitted`); return 1; }
      let m = sh.fs.stat(p).mode;
      if (/^[0-7]+$/.test(mode)) m = parseInt(mode, 8);
      else {
        const mm = mode.match(/^([ugoa]*)([+-=])([rwx]+)$/);
        if (mm) {
          const who = mm[1] || 'a';
          let bits = 0;
          for (const ch of mm[3]) bits |= { r: 4, w: 2, x: 1 }[ch];
          let mask = 0;
          if (who.includes('u') || who.includes('a')) mask |= bits << 6;
          if (who.includes('g') || who.includes('a')) mask |= bits << 3;
          if (who.includes('o') || who.includes('a')) mask |= bits;
          m = mm[2] === '+' ? m | mask : mm[2] === '-' ? m & ~mask : mask;
        }
      }
      sh.fs.chmod(p, m);
    }
    return 0;
  },
  *chown(args, io, sh) {
    const rest = args.filter((a) => a !== '-R');
    const owner = rest.shift().split(':')[0];
    if (sh.user !== 'root') { io.eline(`chown: changing ownership of '${rest[0]}': Operation not permitted`); return 1; }
    for (const f of rest) { try { sh.fs.chown(sh.abs(f), owner); } catch (e) { io.eline(`chown: cannot access '${f}': No such file or directory`); return 1; } }
    return 0;
  },
  *ln(args, io, sh) {
    const rest = args.filter((a) => !a.startsWith('-'));
    try { sh.fs.write(sh.abs(rest[1]), sh.fs.read(sh.abs(rest[0])), { user: sh.user }); } catch (e) { io.eline(`ln: failed to create link: ${e.reason}`); return 1; }
    return 0;
  },
  *find(args, io, sh) {
    const paths = [];
    let i = 0;
    while (i < args.length && !args[i].startsWith('-')) paths.push(args[i++]);
    if (!paths.length) paths.push('.');
    const conds = [];
    let maxdepth = Infinity;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === '-name' || a === '-iname') { const re = globToRegex(args[++i]); conds.push((p) => (a === '-iname' ? new RegExp(re.source, 'i') : re).test(basename(p))); } else if (a === '-type') { const t = args[++i]; conds.push((p) => (t === 'd' ? sh.fs.isDir(p) : sh.fs.isFile(p))); } else if (a === '-maxdepth') maxdepth = Number(args[++i]);
      else if (a === '-path') { const re = globToRegex(args[++i]); conds.push((p) => re.test(p)); }
    }
    for (const base of paths) {
      const root = sh.abs(base);
      if (!sh.fs.exists(root)) { io.eline(`find: '${base}': No such file or directory`); continue; }
      const walk = (p, depth) => {
        const disp = base === '.' ? (p === root ? '.' : './' + p.slice(root.length + (root === '/' ? 0 : 1))) : (base.replace(/\/$/, '') + p.slice(root.length));
        if (conds.every((f) => f(p))) io.line(disp);
        if (depth >= maxdepth) return;
        if (sh.fs.isDir(p)) { try { for (const n of sh.fs.list(p, sh.user)) walk(normPath(p + '/' + n), depth + 1); } catch { io.eline(`find: '${disp}': Permission denied`); } }
      };
      walk(root, 0);
    }
    return 0;
  },
  *basename(args, io) { let b = basename(args[0] || ''); if (args[1] && b.endsWith(args[1])) b = b.slice(0, -args[1].length); io.line(b); return 0; },
  *dirname(args, io) { io.line(dirname(args[0] || '.')); return 0; },
  *base64(args, io, sh) {
    const { opts, rest } = parseOpts(args, { short: 'di', withArg: 'w', long: { decode: 'bool', wrap: 'arg' } });
    const { texts, err } = readSources(rest, io, sh, 'base64');
    if (err) return 1;
    const data = texts.map((t) => t.text).join('');
    if (opts.d || opts.decode) {
      try { io.out(b64dec(data)); } catch { io.eline('base64: invalid input'); return 1; }
      return 0;
    }
    const enc = b64enc(data);
    const wrap = opts.w !== undefined ? Number(opts.w) : opts.wrap !== undefined ? Number(opts.wrap) : 76;
    io.out((wrap ? enc.match(new RegExp(`.{1,${wrap}}`, 'g')) || [''] : [enc]).join('\n') + '\n');
    return 0;
  },
  *xargs(args, io, sh) {
    const { opts, rest } = parseOpts(args, { short: 'rt0', withArg: 'Inl' });
    const items = (io.stdin || '').split(opts['0'] ? '\0' : /\s+/).filter(Boolean);
    const cmd = rest.length ? rest : ['echo'];
    if (!items.length && opts.r) return 0;
    let st = 0;
    const runOne = function* (argv) { const sub = new IO(null); sub.sink = (s) => io.out(s); sub.errSink = (s) => io.err(s); const r = yield* sh.invoke(argv, sub); if (r) st = 123; };
    if (opts.I) { for (const it of items) yield* runOne(cmd.map((a) => a.split(opts.I).join(it))); } else if (opts.n) { const n = Number(opts.n); for (let i = 0; i < items.length; i += n) yield* runOne([...cmd, ...items.slice(i, i + n)]); } else yield* runOne([...cmd, ...items]);
    return st;
  },
  *column(args, io, sh) {
    const { opts, rest } = parseOpts(args, { short: 't', withArg: 's' });
    const { texts } = readSources(rest, io, sh, 'column');
    const rows = texts.flatMap((t) => lines(t.text)).map((l) => (opts.s ? l.split(opts.s) : l.trim().split(/\s+/)));
    const w = [];
    for (const r of rows) r.forEach((c, i) => { w[i] = Math.max(w[i] || 0, c.length); });
    for (const r of rows) io.line(r.map((c, i) => (i < r.length - 1 ? c.padEnd(w[i] + 2) : c)).join(''));
    return 0;
  },
  *env(args, io, sh) {
    if (args.length && !args[0].includes('=')) return yield* sh.invoke(args, io);
    const e = sh.env();
    for (const a of args) { const [k, v] = a.split(/=(.*)/s); e[k] = v; }
    for (const [k, v] of Object.entries(e)) io.line(`${k}=${v}`);
    return 0;
  },
  *printenv(args, io, sh) {
    const e = sh.env();
    if (args.length) { let st = 0; for (const a of args) { if (e[a] !== undefined) io.line(e[a]); else st = 1; } return st; }
    for (const [k, v] of Object.entries(e)) io.line(`${k}=${v}`);
    return 0;
  },
  *id(args, io, sh) { io.line(sh.user === 'root' ? 'uid=0(root) gid=0(root) groups=0(root)' : `uid=1000(${sh.user}) gid=1000(${sh.user}) groups=1000(${sh.user}),4(adm),27(sudo)`); return 0; },
  *whoami(args, io, sh) { io.line(sh.user); return 0; },
  *hostname(args, io, sh) {
    if (args[0] === '-I' || args[0] === '-i') { io.line(sh.ctx?.podIP ? `${sh.ctx.podIP} ` : `${sh.opts.host?.ip || '127.0.0.1'} `); return 0; }
    io.line((sh.fs.tryRead('/etc/hostname') || 'localhost').trim());
    return 0;
  },
  *uname(args, io, sh) {
    const h = (sh.fs.tryRead('/etc/hostname') || 'localhost').trim();
    if (args.includes('-r')) io.line('6.8.0-147-generic');
    else if (args.includes('-a')) io.line(`Linux ${h} 6.8.0-147-generic #147-Ubuntu SMP PREEMPT_DYNAMIC x86_64 x86_64 x86_64 GNU/Linux`);
    else if (args.includes('-m')) io.line('x86_64');
    else io.line('Linux');
    return 0;
  },
  *date(args, io, sh) {
    const d = new Date(sh.opts.clock ? sh.opts.clock() : Date.now());
    const f = args.find((a) => a.startsWith('+'));
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (f) {
      io.line(f.slice(1).replace(/%([a-zA-Z%])/g, (m, c) => ({ Y: d.getUTCFullYear(), m: pad(d.getUTCMonth() + 1), d: pad(d.getUTCDate()), H: pad(d.getUTCHours()), M: pad(d.getUTCMinutes()), S: pad(d.getUTCSeconds()), s: Math.floor(d.getTime() / 1000), F: d.toISOString().slice(0, 10), T: d.toISOString().slice(11, 19), a: days[d.getUTCDay()], b: mons[d.getUTCMonth()], Z: 'UTC', z: '+0000', N: '000000000', '%': '%' }[c] ?? m)));
    } else if (args.includes('-u') || args.includes('-R') || !args.length) io.line(`${days[d.getUTCDay()]} ${mons[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${d.toISOString().slice(11, 19)} UTC ${d.getUTCFullYear()}`);
    else io.line(d.toISOString());
    return 0;
  },
  *seq(args, io) {
    const n = args.map(Number);
    const [a, step, b] = n.length === 1 ? [1, 1, n[0]] : n.length === 2 ? [n[0], 1, n[1]] : [n[0], n[1], n[2]];
    for (let i = a; step > 0 ? i <= b : i >= b; i += step) io.line(String(i));
    return 0;
  },
  *yes(args, io) { for (let i = 0; i < 100; i++) io.line(args.join(' ') || 'y'); return 0; },
  *expr(args, io) {
    try {
      const s = args.join(' ').replace(/\\\*/g, '*');
      const v = s.match(/^[\d\s+\-*/%()]+$/) ? Function(`return (${s})`)() : args.join(' ');
      io.line(String(Math.trunc(v)));
      return v === 0 ? 1 : 0;
    } catch { io.eline('expr: syntax error'); return 2; }
  },
  *md5sum(args, io, sh) { const { texts } = readSources(args, io, sh, 'md5sum'); for (const t of texts) io.line(`${hashHex(t.text, 32)}  ${t.name}`); return 0; },
  *sha256sum(args, io, sh) { const { texts } = readSources(args, io, sh, 'sha256sum'); for (const t of texts) io.line(`${hashHex(t.text, 64)}  ${t.name}`); return 0; },
  *diff(args, io, sh) {
    const files = args.filter((a) => !a.startsWith('-'));
    const { texts, err } = readSources(files, io, sh, 'diff');
    if (err || texts.length < 2) return 2;
    const a = lines(texts[0].text), b = lines(texts[1].text);
    if (a.join('\n') === b.join('\n')) return 0;
    io.line(`--- ${files[0]}`); io.line(`+++ ${files[1]}`);
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      if (a[i] === b[i]) continue;
      if (a[i] !== undefined) io.line(`-${a[i]}`);
      if (b[i] !== undefined) io.line(`+${b[i]}`);
    }
    return 1;
  },
  *stat(args, io, sh) {
    for (const f of args.filter((a) => !a.startsWith('-'))) {
      try {
        const s = sh.fs.stat(sh.abs(f));
        io.line(`  File: ${f}\n  Size: ${s.size}\t\tBlocks: 8          IO Block: 4096   ${s.type === 'dir' ? 'directory' : 'regular file'}\nAccess: (0${(s.mode || 0o644).toString(8)})  Uid: (    0/    ${s.owner || 'root'})`);
      } catch (e) { io.eline(`stat: cannot statx '${f}': No such file or directory`); return 1; }
    }
    return 0;
  },
  *file(args, io, sh) { for (const f of args) { const t = sh.fs.tryRead(sh.abs(f)); io.line(`${f}: ${t === null ? (sh.fs.isDir(sh.abs(f)) ? 'directory' : 'cannot open') : t.startsWith('\x7fELF') ? 'ELF 64-bit LSB executable, x86-64' : /^-----BEGIN/.test(t) ? 'PEM certificate' : 'ASCII text'}`); } return 0; },
  *less(args, io, sh) { return yield* CORE.cat(args.filter((a) => !a.startsWith('-')), io, sh); },
  *more(args, io, sh) { return yield* CORE.cat(args, io, sh); },
  *view(args, io, sh) { return yield* editFile(args, io, sh, true); },
  *watch(args, io, sh) {
    const rest = [];
    for (let i = 0; i < args.length; i++) { if (args[i] === '-n') i++; else if (!args[i].startsWith('-')) rest.push(args[i]); }
    io.line(`Every 2.0s: ${rest.join(' ')}\n`);
    return yield* sh.run(rest.join(' '), io);
  },
  *timeout(args, io, sh) { const rest = args.filter((a, i) => i > 0 || !/^\d/.test(a)).filter((a) => !a.startsWith('-')); return yield* sh.invoke(rest.slice(args[0] && /^\d/.test(args[0]) ? 0 : 0), io); },
  *nohup(args, io, sh) { return yield* sh.invoke(args, io); },
  *man(args, io) { io.eline(`No manual entry for ${args[0] || ''}\n(symulator: użyj '${args[0] || 'polecenie'} --help' lub 'kubectl explain')`); return 16; },
  *vim(args, io, sh) { return yield* editFile(args, io, sh, false); },
  *vi(args, io, sh) { return yield* editFile(args, io, sh, false); },
  *nano(args, io, sh) { return yield* editFile(args, io, sh, false); },
  *ps(args, io, sh) {
    const procs = sh.opts.processes ? sh.opts.processes() : [{ pid: 1, user: 'root', cmd: '/sbin/init' }];
    if (args.some((a) => a.includes('aux') || a === '-ef' || a === '-e')) {
      io.line('USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND');
      for (const p of procs) io.line(`${p.user.padEnd(10)} ${String(p.pid).padStart(5)}  ${(p.cpu || '0.0').padStart(3)}  ${(p.mem || '0.1').padStart(3)} ${String(p.vsz || 12345).padStart(6)} ${String(p.rss || 4567).padStart(5)} ?        Ssl  08:00   0:01 ${p.cmd}`);
    } else {
      io.line('    PID TTY          TIME CMD');
      io.line(`   ${String(procs[0]?.pid || 1).padStart(4)} pts/0    00:00:00 ${sh.shellName}`);
    }
    return 0;
  },
  *df(args, io) {
    io.line('Filesystem      Size  Used Avail Use% Mounted on');
    io.line('/dev/vda1        29G  6.1G   23G  22% /');
    io.line('tmpfs           2.0G     0  2.0G   0% /dev/shm');
    return 0;
  },
  *free(args, io, sh) {
    const mem = sh.opts.host?.memMi || 4096;
    io.line('               total        used        free      shared  buff/cache   available');
    io.line(`Mem:           ${String(mem).padStart(5)}        ${String(Math.round(mem * 0.38)).padStart(4)}        ${String(Math.round(mem * 0.22)).padStart(4)}           2        ${String(Math.round(mem * 0.4)).padStart(4)}        ${String(Math.round(mem * 0.6)).padStart(4)}`);
    io.line(`Swap:              ${sh.opts.host?.kernel?.swap ? 2047 : 0}           0           ${sh.opts.host?.kernel?.swap ? 2047 : 0}`);
    return 0;
  },
  *uptime(args, io) { io.line(' 16:09:00 up  2:31,  1 user,  load average: 0.21, 0.18, 0.15'); return 0; },
  *yq(args, io, sh) { return yield* yqCmd(args, io, sh); },
  *jq(args, io, sh) { return yield* jqCmd(args, io, sh); },
};

function hashHex(s, len) {
  let h = 2166136261, out = '';
  for (let r = 0; out.length < len; r++) {
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i) + r; h = Math.imul(h, 16777619) >>> 0; }
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, len);
}

// ------------------------------------------------------------------ edytor
export function* editFile(args, io, sh, readonly) {
  const files = args.filter((a) => !a.startsWith('-') && !a.startsWith('+'));
  const f = files[0];
  if (!f) { io.eline('Ten symulator wymaga nazwy pliku: vim <plik>'); return 1; }
  const p = sh.abs(f);
  let content = '';
  let exists = false;
  try { content = sh.fs.read(p, sh.user); exists = true; } catch (e) {
    if (e.code === 'EACCES') { io.eline(`"${f}" [Permission Denied]`); return 1; }
    if (e.code === 'EISDIR') { io.eline(`"${f}" is a directory`); return 1; }
  }
  let ro = readonly;
  if (!ro && exists) {
    try { sh.fs.write(p, content, { user: sh.user }); } catch { ro = true; }
  } else if (!ro) {
    if (!sh.fs.isDir(dirname(p))) ro = 'nodir';
    else { try { sh.fs.write(p, '', { user: sh.user }); sh.fs.remove(p, { user: 'root' }); } catch { ro = true; } }
  }
  const res = yield { type: 'edit', path: p, name: f, content, readonly: !!ro, newFile: !exists };
  if (!res || !res.saved) return 0;
  if (ro === 'nodir') { io.eline(`"${f}" E212: Can't open file for writing`); return 1; }
  if (ro) { io.eline(`"${f}" E212: Can't open file for writing`); return 1; }
  try { sh.fs.write(p, res.content, { user: sh.user }); } catch (e) { io.eline(`"${f}" E212: Can't open file for writing`); return 1; }
  return 0;
}

// ------------------------------------------------------------------ sed
function parseSed(s, ext) {
  let i = 0;
  let addr = null;
  const readAddr = () => {
    if (s[i] === '/') { const j = s.indexOf('/', i + 1); const re = new RegExp(bre(s.slice(i + 1, j), ext)); i = j + 1; return { re }; }
    const m = s.slice(i).match(/^(\d+|\$)/);
    if (m) { i += m[0].length; return { line: m[0] === '$' ? '$' : Number(m[0]) }; }
    return null;
  };
  const a1 = readAddr();
  if (a1) {
    addr = { a: a1 };
    if (s[i] === ',') { i++; addr.b = readAddr(); }
  }
  while (s[i] === ' ') i++;
  const op = s[i];
  if (op === 's') {
    const d = s[i + 1];
    const parts = [];
    let cur = '', k = i + 2;
    for (; k < s.length && parts.length < 2; k++) {
      if (s[k] === '\\' && s[k + 1] === d) { cur += d; k++; continue; }
      if (s[k] === d) { parts.push(cur); cur = ''; continue; }
      cur += s[k];
    }
    if (parts.length < 2) { const e = new Error(`unterminated \`s' command`); e.pos = s.length; throw e; }
    const flags = s.slice(k);
    const re = new RegExp(bre(parts[0], ext), (flags.includes('g') ? 'g' : '') + (flags.includes('i') || flags.includes('I') ? 'i' : ''));
    const rep = parts[1].replace(/\$/g, '$$$$').replace(/\\(\d)/g, '$$$1').replace(/(^|[^\\])&/g, '$1$$&').replace(/\\&/g, '&').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    return { op: 's', addr, re, rep, print: flags.includes('p') };
  }
  if (op === 'd' || op === 'p') return { op, addr };
  if (op === 'a' || op === 'i' || op === 'c') return { op, addr, text: s.slice(i + 1).replace(/^\\?\s*/, '') };
  const e = new Error(`unknown command: \`${op}'`);
  e.pos = i + 1;
  throw e;
}
function sedAddr(addr, line, idx, total) {
  if (!addr) return true;
  const m = (a) => (a.re ? a.re.test(line) : a.line === '$' ? idx === total - 1 : idx + 1 === a.line);
  if (!addr.b) return m(addr.a);
  const start = addr.a.line !== undefined ? (addr.a.line === '$' ? total - 1 : addr.a.line - 1) : null;
  const end = addr.b.line !== undefined ? (addr.b.line === '$' ? total - 1 : addr.b.line - 1) : null;
  if (start !== null && end !== null) return idx >= start && idx <= end;
  return m(addr.a);
}

// ------------------------------------------------------------------ awk (podzbiór)
function compileAwk(prog) {
  const items = [];
  let s = prog.trim();
  while (s.length) {
    let pattern = null, action = null;
    if (s.startsWith('BEGIN')) { pattern = 'BEGIN'; s = s.slice(5).trim(); } else if (s.startsWith('END')) { pattern = 'END'; s = s.slice(3).trim(); } else if (!s.startsWith('{')) {
      const j = s.indexOf('{');
      pattern = (j < 0 ? s : s.slice(0, j)).trim();
      s = j < 0 ? '' : s.slice(j);
    }
    if (s.startsWith('{')) {
      let depth = 0, k = 0, inStr = false;
      for (; k < s.length; k++) {
        if (s[k] === '"' && s[k - 1] !== '\\') inStr = !inStr;
        if (inStr) continue;
        if (s[k] === '{') depth++;
        if (s[k] === '}') { depth--; if (!depth) break; }
      }
      action = s.slice(1, k);
      s = s.slice(k + 1).trim();
    }
    items.push({ pattern, action });
    s = s.replace(/^[;\s]+/, '');
  }
  const tr = (e) => e
    .replace(/\$\(([^)]+)\)/g, '$F($1)')
    .replace(/\$NF\b/g, '$F(NF)').replace(/\$(\d+)/g, '$F($1)')
    .replace(/\b(NR|NF|FS|OFS)\b/g, 'V.$1')
    .replace(/(^|[^\w.$'"])([a-z_][a-zA-Z0-9_]*)\b(?!\s*\()/g, (m, p, v) => (['V', 'length', 'tolower', 'toupper', 'substr', 'index', 'split', 'printf', 'print', 'int', 'sprintf', 'in', 'gsub', 'sub', 'match'].includes(v) ? m : `${p}V.u.${v}`))
    .replace(/(^|[^=!<>])~\s*\/([^/]*)\//g, '$1.match(/$2/) !== null && true || false ? 1 : 0')
    .replace(/\/([^/]+)\//g, '/$1/.test($F(0))');
  const compileStmt = (st) => {
    st = st.trim();
    if (!st) return '';
    if (st === 'next') return 'continue __rec;';
    let m;
    if ((m = st.match(/^printf\s*\(?(.*?)\)?$/s))) return `__out.push(sprintf(${tr(m[1])}));`;
    if ((m = st.match(/^print\s*(.*)$/s))) {
      const exprs = m[1].trim() ? splitTop(m[1]).map(tr) : ['$F(0)'];
      return `__out.push([${exprs.join(',')}].join(V.OFS)+"\\n");`;
    }
    if ((m = st.match(/^if\s*\((.+)\)\s*(.+)$/s))) return `if (${tr(m[1])}) { ${compileStmt(m[2])} }`;
    return tr(st) + ';';
  };
  const body = items.map((it) => {
    const act = it.action === null ? '__out.push($F(0)+"\\n");' : splitStmts(it.action).map(compileStmt).join('\n');
    return { pattern: it.pattern, code: act };
  });
  const begin = body.filter((b) => b.pattern === 'BEGIN').map((b) => b.code).join('\n');
  const end = body.filter((b) => b.pattern === 'END').map((b) => b.code).join('\n');
  const main = body.filter((b) => b.pattern !== 'BEGIN' && b.pattern !== 'END').map((b) => (b.pattern ? `if (${tr(b.pattern)}) { ${b.code} }` : b.code)).join('\n');
  const src = `
    const sprintf = (f, ...a) => { let i=0; return String(f).replace(/%(-?\\d*)(\\.\\d+)?([sdfi%])/g,(m,w,p,c)=>{ if(c==='%')return '%'; let v=a[i++]; v = c==='d'||c==='i' ? String(Math.trunc(Number(v)||0)) : c==='f' ? (Number(v)||0).toFixed(p?Number(p.slice(1)):6) : String(v ?? ''); const n=parseInt(w,10); if(n) v = n<0? v.padEnd(-n): v.padStart(n); return v; }); };
    const length = (s) => String(s === undefined ? $F(0) : s).length;
    const tolower = (s) => String(s).toLowerCase(), toupper = (s) => String(s).toUpperCase();
    const substr = (s, a, b) => String(s).substr(a - 1, b), index = (s, t) => String(s).indexOf(t) + 1, int = (x) => Math.trunc(Number(x));
    let __f = [];
    const $F = (n) => (n === 0 ? __f.line : (__f[n - 1] ?? ''));
    const __out = [];
    ${begin}
    __rec: for (let __i = 0; __i < __lines.length; __i++) {
      const line = __lines[__i];
      const parts = V.FS === ' ' ? line.trim().split(/\\s+/).filter(Boolean) : line.split(V.FS);
      __f = parts; __f.line = line; V.NR = __i + 1; V.NF = parts.length;
      ${main}
    }
    ${end}
    return __out.join('');`;
  const fn = new Function('__lines', 'V', src); // eslint-disable-line no-new-func
  return (ls, fs, vars) => {
    const V = { NR: 0, NF: 0, FS: fs ?? ' ', OFS: ' ', u: new Proxy({ ...vars }, { get: (t, k) => (k in t ? t[k] : 0) }) };
    return fn(ls, V);
  };
}
function splitTop(s) {
  const out = [];
  let depth = 0, cur = '', str = false;
  for (const ch of s) {
    if (ch === '"') str = !str;
    if (!str && ch === '(') depth++;
    if (!str && ch === ')') depth--;
    if (!str && depth === 0 && ch === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function splitStmts(s) {
  const out = [];
  let cur = '', str = false, depth = 0;
  for (const ch of s) {
    if (ch === '"') str = !str;
    if (!str && (ch === '(' || ch === '{')) depth++;
    if (!str && (ch === ')' || ch === '}')) depth--;
    if (!str && depth === 0 && (ch === ';' || ch === '\n')) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.filter((x) => x.trim());
}

// ------------------------------------------------------------------ yq / jq (podzbiór)
function pathSegments(expr) {
  const segs = [];
  const re = /\.([A-Za-z0-9_$-]+)|\.?\[(\d*|"[^"]*")\]|\."([^"]+)"/g;
  let m;
  const e = expr.trim();
  if (e === '.' || e === '') return segs;
  while ((m = re.exec(e))) {
    if (m[1] !== undefined) segs.push(m[1]);
    else if (m[2] !== undefined) segs.push(m[2] === '' ? '*' : /^"/.test(m[2]) ? m[2].slice(1, -1) : Number(m[2]));
    else if (m[3] !== undefined) segs.push(m[3]);
  }
  return segs;
}
function getPath(doc, segs) {
  let cur = [doc];
  for (const s of segs) {
    const next = [];
    for (const c of cur) {
      if (c == null) { next.push(null); continue; }
      if (s === '*') { if (Array.isArray(c)) next.push(...c); else if (typeof c === 'object') next.push(...Object.values(c)); } else next.push(c[s] === undefined ? null : c[s]);
    }
    cur = next;
  }
  return cur;
}
function setPath(doc, segs, val) {
  let cur = doc;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (cur[s] == null) cur[s] = typeof segs[i + 1] === 'number' ? [] : {};
    cur = cur[s];
  }
  cur[segs[segs.length - 1]] = val;
}
function delPath(doc, segs) {
  let cur = doc;
  for (let i = 0; i < segs.length - 1; i++) { cur = cur?.[segs[i]]; if (cur == null) return; }
  if (Array.isArray(cur)) cur.splice(segs[segs.length - 1], 1); else delete cur[segs[segs.length - 1]];
}
function scalarOut(v, json) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'object') return json ? JSON.stringify(v, null, 2) : dump(v, { sort: false }).trimEnd();
  return String(v);
}

function* yqCmd(args, io, sh) {
  let inplace = false, outJson = false, expr = null;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === 'e' || a === 'eval' || a === 'eval-all' || a === 'ea') continue;
    if (a === '-i' || a === '--inplace') inplace = true;
    else if (a === '-o' || a === '--output-format') outJson = args[++i] === 'json';
    else if (a === '-oj' || a === '-o=json') outJson = true;
    else if (a === '-r' || a === '-P' || a === '-e') continue;
    else if (expr === null) expr = a;
    else files.push(a);
  }
  if (expr === null) expr = '.';
  const { texts, err } = readSources(files, io, sh, 'yq');
  if (err) return 1;
  let st = 0;
  for (const t of texts) {
    let docs;
    try { docs = t.text.trim().startsWith('{') || t.text.trim().startsWith('[') ? [JSON.parse(t.text)] : parseAll(t.text); } catch (e) { io.eline(`Error: bad file '${t.name}': ${e.message}`); return 1; }
    const outDocs = [];
    for (const doc of docs) {
      let m;
      if ((m = expr.match(/^del\((.+)\)$/))) { delPath(doc, pathSegments(m[1])); outDocs.push(scalarOut(doc, outJson)); continue; }
      if ((m = expr.match(/^(\.[^=|]*?)\s*(=|\|=)\s*(.+)$/))) {
        let v = m[3].trim();
        try { v = /^["']/.test(v) ? v.slice(1, -1) : parseOne(v); } catch { /* */ }
        setPath(doc, pathSegments(m[1]), v);
        outDocs.push(scalarOut(doc, outJson));
        continue;
      }
      if ((m = expr.match(/^(\.[^|]*)\|\s*length$/))) { const v = getPath(doc, pathSegments(m[1]))[0]; outDocs.push(String(Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : String(v ?? '').length)); continue; }
      if (expr === 'keys' || /\|\s*keys$/.test(expr)) { const v = getPath(doc, pathSegments(expr.replace(/\|\s*keys$/, '')))[0]; outDocs.push(Object.keys(v || {}).map((k) => `- ${k}`).join('\n')); continue; }
      const vals = getPath(doc, pathSegments(expr));
      outDocs.push(...vals.map((v) => scalarOut(v, outJson)));
    }
    if (inplace && t.name !== '-') {
      try { sh.fs.write(sh.abs(t.name), outDocs.join('\n---\n') + '\n', { user: sh.user }); } catch (e) { io.eline(`Error: ${e.message}`); st = 1; }
    } else io.out(outDocs.join('\n') + '\n');
  }
  return st;
}

function* jqCmd(args, io, sh) {
  let raw = false, expr = null;
  const files = [];
  for (const a of args) {
    if (a === '-r' || a === '--raw-output') raw = true;
    else if (a === '-c') continue;
    else if (expr === null) expr = a;
    else files.push(a);
  }
  const { texts, err } = readSources(files, io, sh, 'jq');
  if (err) return 2;
  for (const t of texts) {
    let doc;
    try { doc = JSON.parse(t.text); } catch { io.eline('jq: error (at <stdin>:0): Cannot parse input'); return 2; }
    const e = (expr || '.').replace(/\[\]/g, '[*]');
    let m;
    if ((m = e.match(/^(.*)\|\s*length$/))) { const v = getPath(doc, pathSegments(m[1]))[0]; io.line(String(Array.isArray(v) ? v.length : Object.keys(v || {}).length)); continue; }
    for (const v of getPath(doc, pathSegments(e.replace(/\[\*\]/g, '[]')))) io.line(typeof v === 'string' && raw ? v : JSON.stringify(v, null, 2));
  }
  return 0;
}

export { lines, readSources };
void ExitError;
