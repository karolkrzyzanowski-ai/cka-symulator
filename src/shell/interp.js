// Interpreter powłoki (generator). Efekty uboczne zwracane przez yield:
//   {type:'sleep', ms} {type:'input', prompt} {type:'edit', ...} {type:'clear'} {type:'busy'}
//   {type:'ssh', host, user, command?} {type:'su', user}
import { parse, ShellSyntaxError, Incomplete } from './parser.js';
import { normPath, ExitError } from '../lib/util.js';
import { FsError } from './vfs.js';

export class ExitSignal extends Error { constructor(code) { super('exit'); this.code = code; } }
export class BreakSignal extends Error { constructor(n = 1, cont = false) { super('break'); this.n = n; this.cont = cont; } }

export class IO {
  constructor(stdin = null) { this.stdin = stdin; this.o = ''; this.e = ''; this.sink = null; this.errSink = null; }
  out(s) { if (this.sink) this.sink(String(s)); else this.o += s; }
  err(s) { if (this.errSink) this.errSink(String(s)); else if (this.sink) this.sink(String(s)); else this.e += s; }
  line(s = '') { this.out(s + '\n'); }
  eline(s = '') { this.err(s + '\n'); }
}

const MAX_LOOP = 2000;

export class Shell {
  // opts: {host, fs, user, cwd, env, commands(name)->fn, mode:'host'|'container', name}
  constructor(opts) {
    this.opts = opts;
    this.fs = opts.fs;
    this.user = opts.user || 'root';
    this.vars = new Map(Object.entries(opts.env || {}));
    this.exported = new Set(Object.keys(opts.env || {}));
    this.aliases = new Map(Object.entries(opts.aliases || {}));
    this.cwd = opts.cwd || (this.user === 'root' ? '/root' : `/home/${this.user}`);
    this.status = 0;
    this.history = [];
    this.mode = opts.mode || 'host';
    this.shellName = this.mode === 'container' ? 'sh' : 'bash';
    this.loopBudget = 0;
    this.interactive = !!opts.interactive;
    this.vars.set('PWD', this.cwd);
  }

  get home() { return this.vars.get('HOME') || (this.user === 'root' ? '/root' : `/home/${this.user}`); }

  env() {
    const e = {};
    for (const k of this.exported) if (this.vars.has(k)) e[k] = this.vars.get(k);
    return e;
  }

  abs(p) {
    if (p === '~' || p.startsWith('~/')) p = this.home + p.slice(1);
    return normPath(p.startsWith('/') ? p : `${this.cwd}/${p}`);
  }

  // ---------------------------------------------------------------- uruchamianie skryptu
  *run(src, io) {
    let tree;
    try {
      tree = parse(src);
    } catch (e) {
      if (e instanceof Incomplete) { io.eline(`${this.shellName}: syntax error: unexpected end of file`); this.status = 2; return 2; }
      if (e instanceof ShellSyntaxError) { io.eline(`${this.shellName}: ${e.message}`); this.status = 2; return 2; }
      throw e;
    }
    return yield* this.exec(tree, io);
  }

  *exec(node, io) {
    if (node.redirs && node.type !== 'cmd') {
      return yield* this.withRedirs(node.redirs, io, (io2) => this.execNode(node, io2));
    }
    return yield* this.execNode(node, io);
  }

  *execNode(node, io) {
    switch (node.type) {
      case 'seq': {
        let st = this.status;
        for (const it of node.items) {
          st = yield* this.exec(it, io);
          if (this.errexit && st !== 0 && ['cmd', 'pipe', 'subshell', 'group'].includes(it.type)) throw new ExitSignal(st);
        }
        return st;
      }
      case 'bg': return yield* this.exec(node.node, io);
      case 'and': {
        const a = yield* this.exec(node.left, io);
        if (a !== 0) return a;
        return yield* this.exec(node.right, io);
      }
      case 'or': {
        const a = yield* this.exec(node.left, io);
        if (a === 0) return 0;
        return yield* this.exec(node.right, io);
      }
      case 'not': {
        const a = yield* this.exec(node.node, io);
        this.status = a === 0 ? 1 : 0;
        return this.status;
      }
      case 'pipe': return yield* this.execPipe(node, io);
      case 'cmd': return yield* this.execCmd(node, io);
      case 'group': return yield* this.exec(node.body, io);
      case 'subshell': {
        const saved = { cwd: this.cwd, vars: new Map(this.vars), exported: new Set(this.exported) };
        try { return yield* this.exec(node.body, io); } catch (e) {
          if (e instanceof ExitSignal) return e.code;
          throw e;
        } finally { this.cwd = saved.cwd; this.vars = saved.vars; this.exported = saved.exported; }
      }
      case 'if': {
        for (const c of node.clauses) {
          const st = yield* this.exec(c.cond, io);
          if (st === 0) return yield* this.exec(c.body, io);
        }
        if (node.else) return yield* this.exec(node.else, io);
        this.status = 0;
        return 0;
      }
      case 'for': {
        let items = [];
        if (node.items) for (const w of node.items) items.push(...(yield* this.expandWord(w, io)));
        else items = (this.vars.get('@') || '').split(' ').filter(Boolean);
        let st = 0;
        for (const v of items) {
          this.vars.set(node.name, v);
          try { st = yield* this.exec(node.body, io); } catch (e) {
            if (e instanceof BreakSignal) { if (e.cont) continue; break; }
            throw e;
          }
          if (++this.loopBudget > MAX_LOOP) { yield { type: 'busy' }; this.loopBudget = 0; }
        }
        this.status = st;
        return st;
      }
      case 'case': {
        const val = (yield* this.expandWord(node.word, io, { split: false })).join('');
        for (const it of node.items) {
          for (const pw of it.pats) {
            const pat = (yield* this.expandWord(pw, io, { split: false })).join('');
            const re = new RegExp('^' + pat.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 's');
            if (re.test(val)) { const st = yield* this.exec(it.body, io); this.status = st; return st; }
          }
        }
        this.status = 0;
        return 0;
      }
      case 'while':
      case 'until': {
        let st = 0, n = 0;
        while (true) {
          const c = yield* this.exec(node.cond, io);
          if ((node.type === 'while') !== (c === 0)) break;
          try { st = yield* this.exec(node.body, io); } catch (e) {
            if (e instanceof BreakSignal) { if (e.cont) continue; break; }
            throw e;
          }
          n++;
          if (++this.loopBudget > MAX_LOOP) { yield { type: 'busy' }; this.loopBudget = 0; }
          if (this.mode === 'host' && n > 5000) { io.eline(`${this.shellName}: loop aborted after 5000 iterations`); break; }
        }
        this.status = st;
        return st;
      }
      default:
        throw new Error(`nieznany węzeł ${node.type}`);
    }
  }

  *execPipe(node, io) {
    let input = io.stdin;
    let st = 0;
    for (let i = 0; i < node.cmds.length; i++) {
      const last = i === node.cmds.length - 1;
      const sub = new IO(input);
      if (last) { sub.sink = (s) => io.out(s); }
      sub.errSink = (s) => io.err(s);
      st = yield* this.exec(node.cmds[i], sub);
      input = sub.o;
    }
    this.status = st;
    return st;
  }

  // ---------------------------------------------------------------- przekierowania
  *withRedirs(redirs, io, fn) {
    const sub = new IO(io.stdin);
    let outFile = null, outAppend = false, errFile = null, errAppend = false, errToOut = false, outToErr = false;
    let outDevNull = false, errDevNull = false;
    for (const r of redirs) {
      if (r.op === '<<') {
        const h = r.heredoc;
        sub.stdin = h.quoted ? h.content : yield* this.expandHeredoc(h.content, io);
        continue;
      }
      const target = (yield* this.expandWord(r.target, io)).join(' ');
      if (r.op === '<<<') { sub.stdin = target + '\n'; continue; }
      if (r.op === '<') {
        try { sub.stdin = this.readFile(target); } catch (e) {
          io.eline(`${this.shellName}: ${target}: ${e.reason || 'No such file or directory'}`);
          this.status = 1;
          return 1;
        }
        continue;
      }
      if (r.op === '>&' || (r.op === '>' && false)) {
        if (target === '1' && r.fd === 2) { errToOut = true; continue; }
        if (target === '2' && r.fd === 1) { outToErr = true; continue; }
        // >& plik
        outFile = target; errToOut = true; continue;
      }
      const isNull = target === '/dev/null';
      if (r.op === '&>' || r.op === '&>>') {
        if (isNull) { outDevNull = true; errDevNull = true; } else { outFile = target; outAppend = r.op === '&>>'; errToOut = true; }
        continue;
      }
      if (r.fd === 2) {
        if (isNull) errDevNull = true; else { errFile = target; errAppend = r.op === '>>'; }
      } else if (isNull) outDevNull = true; else { outFile = target; outAppend = r.op === '>>'; }
    }
    // przygotuj pliki (obcięcie przed wykonaniem jak w bash)
    for (const [f, app] of [[outFile, outAppend], [errFile, errAppend]]) {
      if (!f) continue;
      try {
        if (!app || !this.fs.exists(this.abs(f))) this.fs.write(this.abs(f), '', { user: this.user });
      } catch (e) {
        io.eline(`${this.shellName}: ${f}: ${e.reason || e.message}`);
        this.status = 1;
        return 1;
      }
    }
    const appendTo = (f, s) => { try { this.fs.write(this.abs(f), s, { append: true, user: this.user }); } catch { /* */ } };
    sub.sink = (s) => {
      if (outDevNull) return;
      if (outToErr) return io.err(s);
      if (outFile) return appendTo(outFile, s);
      io.out(s);
    };
    sub.errSink = (s) => {
      if (errDevNull) return;
      if (errToOut) { if (outDevNull) return; if (outFile) return appendTo(outFile, s); return io.out(s); }
      if (errFile) return appendTo(errFile, s);
      io.err(s);
    };
    return yield* fn(sub);
  }

  readFile(p) { return this.fs.read(this.abs(p), this.user); }

  // ---------------------------------------------------------------- polecenie proste
  *execCmd(node, io) {
    if (node.redirs.length) {
      return yield* this.withRedirs(node.redirs, io, (io2) => this.execCmdNoRedir(node, io2));
    }
    return yield* this.execCmdNoRedir(node, io);
  }

  *execCmdNoRedir(node, io) {
    let argv = [];
    for (const w of node.words) argv.push(...(yield* this.expandWord(w, io, { glob: true })));
    const assigns = [];
    for (const a of node.assigns) assigns.push([a.name, (yield* this.expandWord(a.value, io, { split: false })).join('')]);
    if (!argv.length) {
      for (const [k, v] of assigns) this.vars.set(k, v);
      this.status = 0;
      return 0;
    }
    // aliasy (tylko pierwsze słowo, jak w bash interaktywnym)
    if (this.aliases.has(argv[0])) {
      const al = this.aliases.get(argv[0]);
      const extra = [];
      // alias może zawierać wiele słów
      const tree = parse(al);
      const first = tree.items[0];
      if (first && first.type === 'cmd') for (const w of first.words) extra.push(...(yield* this.expandWord(w, io)));
      argv = [...extra, ...argv.slice(1)];
    }
    const saved = [];
    for (const [k, v] of assigns) { saved.push([k, this.vars.get(k), this.exported.has(k)]); this.vars.set(k, v); this.exported.add(k); }
    try {
      const st = yield* this.invoke(argv, io);
      this.status = st;
      return st;
    } finally {
      for (const [k, v, ex] of saved) {
        if (v === undefined) this.vars.delete(k); else this.vars.set(k, v);
        if (!ex) this.exported.delete(k);
      }
    }
  }

  *invoke(argv, io) {
    const name = argv[0];
    const b = BUILTINS[name];
    if (b) {
      try { return (yield* b.call(this, argv.slice(1), io)) ?? 0; } catch (e) {
        if (e instanceof ExitError) { if (e.message) io.eline(e.message); return e.code; }
        throw e;
      }
    }
    let fn = this.opts.commands?.(name, this);
    if (!fn && name.includes('/')) {
      const base = name.split('/').pop();
      if (this.fs.exists(this.abs(name))) fn = this.opts.commands?.(base, this);
    }
    if (!fn) {
      if (this.mode === 'container') io.eline(`sh: ${name}: not found`);
      else io.eline(`${name}: command not found`);
      return 127;
    }
    try {
      const r = yield* fn(argv.slice(1), io, this, name);
      return r ?? 0;
    } catch (e) {
      if (e instanceof ExitError) { if (e.message) io.eline(e.message); return e.code; }
      if (e instanceof FsError) { io.eline(`${name}: ${e.message}`); return 1; }
      throw e;
    }
  }

  // ---------------------------------------------------------------- rozwijanie słów
  *expandHeredoc(text, io) {
    // rozwija $VAR, ${...}, $(...), $((...)) w treści heredoc
    let out = '';
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '\\' && (text[i + 1] === '$' || text[i + 1] === '`' || text[i + 1] === '\\')) { out += text[i + 1]; i += 2; continue; }
      if (c === '$' || c === '`') {
        // użyj leksera słów na fragmencie
        const { word, len } = lexPiece(text.slice(i));
        if (word) { out += (yield* this.expandParts(word, io, { split: false })).join(''); i += len; continue; }
      }
      out += c;
      i++;
    }
    return out;
  }

  *expandWord(word, io, { split = true, glob = false } = {}) {
    return yield* this.expandParts(word, io, { split, glob });
  }

  // zwraca listę pól
  *expandParts(parts, io, { split = true, glob = false } = {}) {
    // budujemy pola; nieprzytoczone wyniki podstawień podlegają podziałowi
    let fields = [''];
    let started = false;
    let hasGlob = false;
    let quotedEmpty = false;
    const add = (s, splittable) => {
      if (splittable && split) {
        const pieces = s.split(/[ \t\n]+/);
        if (s.length && /^[ \t\n]/.test(s) && fields[fields.length - 1] !== '') fields.push('');
        pieces.forEach((p, idx) => {
          if (idx > 0 && p === '' && idx === pieces.length - 1) { fields.push(''); return; }
          if (idx > 0) fields.push('');
          fields[fields.length - 1] += p;
        });
      } else fields[fields.length - 1] += s;
      started = true;
    };
    for (let pi = 0; pi < parts.length; pi++) {
      const p = parts[pi];
      if (p.t === 'lit') {
        let v = p.v;
        if (pi === 0 && (v === '~' || v.startsWith('~/'))) v = this.home + v.slice(1);
        else if (pi === 0 && /^~[a-z_][\w-]*(\/|$)/.test(v)) { const u = v.match(/^~([a-z_][\w-]*)/)[1]; v = (u === 'root' ? '/root' : `/home/${u}`) + v.slice(u.length + 1); }
        if (/[*?[]/.test(v)) hasGlob = true;
        add(v, false);
      } else if (p.t === 'sq') { add(p.v, false); quotedEmpty = true; } else if (p.t === 'dq') {
        const inner = yield* this.expandParts(p.parts, io, { split: false });
        add(inner.join(''), false);
        quotedEmpty = true;
      } else if (p.t === 'var') add(this.expandVar(p, io), true);
      else if (p.t === 'cmdsub') {
        const sub = new IO(null);
        sub.errSink = (s) => io.err(s);
        const saved = this.status;
        yield* this.run(p.src, sub);
        void saved;
        add(sub.o.replace(/\n+$/, ''), true);
      } else if (p.t === 'arith') {
        add(String(this.arith(p.expr)), true);
      }
    }
    if (!started) return [];
    let out = fields;
    if (split) out = fields.filter((f, i) => f !== '' || (quotedEmpty && fields.length === 1) || (i > 0 && i < fields.length - 1 && false));
    if (split && !out.length && quotedEmpty) out = [''];
    if (glob && hasGlob) {
      const g = [];
      for (const f of out) g.push(...this.fs.glob(f, this.cwd));
      out = g;
    }
    return out;
  }

  expandVar(p) {
    let v;
    const n = p.name;
    if (n === '?') v = String(this.status);
    else if (n === '$') v = '4242';
    else if (n === '#') v = String((this.vars.get('@') || '').split(' ').filter(Boolean).length);
    else if (n === '!') v = '';
    else if (n === '-') v = this.interactive ? 'himBHs' : 'hB';
    else v = this.vars.get(n);
    if (p.len) return String((v || '').length);
    if (p.op) {
      const unset = v === undefined, empty = unset || v === '';
      const cond = p.op.startsWith(':') ? empty : unset;
      const op = p.op.replace(':', '');
      if (op === '-') return cond ? this.simpleExpand(p.arg) : v;
      if (op === '=') { if (cond) { v = this.simpleExpand(p.arg); this.vars.set(n, v); } return v; }
      if (op === '+') return cond ? '' : this.simpleExpand(p.arg);
      if (op === '?') { if (cond) throw new ExitError(1, `${this.shellName}: ${n}: ${p.arg || 'parameter null or not set'}`); return v; }
    }
    if (p.trim) {
      const re = new RegExp(p.trim.startsWith('#') ? '^' + globPat(p.arg, p.trim === '##') : globPat(p.arg, p.trim === '%%') + '$');
      return (v || '').replace(re, '');
    }
    if (p.repl) {
      const [pat, rep] = p.repl;
      const all = pat.startsWith('/');
      const re = new RegExp(globPat(all ? pat.slice(1) : pat, true), all ? 'g' : '');
      return (v || '').replace(re, rep);
    }
    return v ?? '';
  }

  simpleExpand(s) {
    return String(s || '').replace(/\$\{?([A-Za-z_]\w*)\}?/g, (_, k) => this.vars.get(k) ?? '');
  }

  arith(expr) {
    const src = expr.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (_, k) => this.vars.get(k) || '0');
    return evalArith(src, this.vars);
  }
}

function globPat(g, greedy) {
  let re = '';
  for (const c of g || '') {
    if (c === '*') re += greedy ? '.*' : '.*?';
    else if (c === '?') re += '.';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}

// lekser fragmentu $... w heredoc
function lexPiece(s) {
  if (s.startsWith('$((')) {
    let depth = 0;
    for (let i = 1; i < s.length - 1; i++) {
      if (s[i] === '(') depth++;
      if (s[i] === ')') { depth--; if (depth === 0) return { word: [{ t: 'arith', expr: s.slice(3, i - 1) }], len: i + 1 }; }
    }
    return { word: null, len: 1 };
  }
  if (s.startsWith('$(')) {
    let depth = 0;
    for (let i = 1; i < s.length; i++) {
      if (s[i] === '(') depth++;
      if (s[i] === ')') { depth--; if (depth === 0) return { word: [{ t: 'cmdsub', src: s.slice(2, i) }], len: i + 1 }; }
    }
    return { word: null, len: 1 };
  }
  if (s.startsWith('`')) {
    const j = s.indexOf('`', 1);
    if (j > 0) return { word: [{ t: 'cmdsub', src: s.slice(1, j) }], len: j + 1 };
    return { word: null, len: 1 };
  }
  if (s.startsWith('${')) {
    const j = s.indexOf('}');
    if (j > 0) {
      const inner = s.slice(2, j);
      const m = inner.match(/^(#?)([A-Za-z_]\w*|\d+|[?$#@*!])(?:(:?[-=+?])(.*))?$/s);
      if (m) return { word: [m[1] ? { t: 'var', name: m[2], len: true } : m[3] ? { t: 'var', name: m[2], op: m[3], arg: m[4] } : { t: 'var', name: m[2] }], len: j + 1 };
    }
    return { word: null, len: 1 };
  }
  const m = s.slice(1).match(/^([A-Za-z_]\w*|[0-9?$#@*!])/);
  if (m) return { word: [{ t: 'var', name: m[1] }], len: 1 + m[1].length };
  return { word: null, len: 1 };
}

// arytmetyka $(( ))
export function evalArith(src, vars) {
  const toks = src.match(/\d+|[A-Za-z_]\w*|\*\*|<=|>=|==|!=|&&|\|\||\+\+|--|[-+*/%()<>!]/g) || [];
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const val = (t) => (/^\d+$/.test(t) ? parseInt(t, 10) : parseInt(vars?.get(t) || '0', 10) || 0);
  function primary() {
    const t = next();
    if (t === '(') { const v = expr(); next(); return v; }
    if (t === '-') return -primary();
    if (t === '+') return primary();
    if (t === '!') return primary() ? 0 : 1;
    if (t === undefined) return 0;
    return val(t);
  }
  function pow() { let a = primary(); while (peek() === '**') { next(); a = a ** primary(); } return a; }
  function mul() { let a = pow(); while (['*', '/', '%'].includes(peek())) { const o = next(); const b = pow(); a = o === '*' ? a * b : o === '/' ? (b ? Math.trunc(a / b) : 0) : (b ? a % b : 0); } return a; }
  function add() { let a = mul(); while (['+', '-'].includes(peek())) { const o = next(); const b = mul(); a = o === '+' ? a + b : a - b; } return a; }
  function cmp() { let a = add(); while (['<', '>', '<=', '>='].includes(peek())) { const o = next(); const b = add(); a = Number(o === '<' ? a < b : o === '>' ? a > b : o === '<=' ? a <= b : a >= b); } return a; }
  function eq() { let a = cmp(); while (['==', '!='].includes(peek())) { const o = next(); const b = cmp(); a = Number(o === '==' ? a === b : a !== b); } return a; }
  function and() { let a = eq(); while (peek() === '&&') { next(); const b = eq(); a = Number(a && b); } return a; }
  function expr() { let a = and(); while (peek() === '||') { next(); const b = and(); a = Number(a || b); } return a; }
  return expr();
}

// ---------------------------------------------------------------------------- wbudowane
function testExpr(args, sh) {
  const a = [...args];
  const unary = (op, x) => {
    const p = sh.abs(x);
    switch (op) {
      case '-n': return x.length > 0;
      case '-z': return x.length === 0;
      case '-f': return sh.fs.isFile(p);
      case '-d': return sh.fs.isDir(p);
      case '-e': case '-a': return sh.fs.exists(p);
      case '-s': return sh.fs.isFile(p) && sh.fs.tryRead(p)?.length > 0;
      case '-r': case '-w': case '-x': return sh.fs.exists(p);
      case '-L': case '-h': return false;
      default: return null;
    }
  };
  const evalOne = (xs) => {
    if (!xs.length) return false;
    if (xs[0] === '!') return !evalOne(xs.slice(1));
    // -a / -o
    const oi = xs.indexOf('-o');
    if (oi > 0) return evalOne(xs.slice(0, oi)) || evalOne(xs.slice(oi + 1));
    const ai = xs.lastIndexOf('-a');
    if (ai > 0 && xs.length > 3) return evalOne(xs.slice(0, ai)) && evalOne(xs.slice(ai + 1));
    if (xs.length === 1) return xs[0].length > 0;
    if (xs.length === 2) { const r = unary(xs[0], xs[1]); return r === null ? false : r; }
    if (xs.length === 3) {
      const [l, op, r] = xs;
      switch (op) {
        case '=': case '==': return l === r;
        case '!=': return l !== r;
        case '-eq': return Number(l) === Number(r);
        case '-ne': return Number(l) !== Number(r);
        case '-lt': return Number(l) < Number(r);
        case '-le': return Number(l) <= Number(r);
        case '-gt': return Number(l) > Number(r);
        case '-ge': return Number(l) >= Number(r);
        case '=~': return new RegExp(r).test(l);
        default: return false;
      }
    }
    return false;
  };
  return evalOne(a);
}

function* noop() { return 0; }

export const BUILTINS = {
  *cd(args) {
    const target = args[0] === undefined ? this.home : args[0] === '-' ? (this.vars.get('OLDPWD') || this.cwd) : args[0];
    const p = this.abs(target);
    if (!this.fs.exists(p)) throw new ExitError(1, `${this.shellName}: cd: ${target}: No such file or directory`);
    if (!this.fs.isDir(p)) throw new ExitError(1, `${this.shellName}: cd: ${target}: Not a directory`);
    this.vars.set('OLDPWD', this.cwd);
    this.cwd = p;
    this.vars.set('PWD', p);
    return 0;
  },
  *pwd(args, io) { io.line(this.cwd); return 0; },
  *echo(args, io) {
    let nl = true, esc = false;
    while (args[0] && /^-[neE]+$/.test(args[0])) {
      if (args[0].includes('n')) nl = false;
      if (args[0].includes('e')) esc = true;
      args = args.slice(1);
    }
    let s = args.join(' ');
    if (esc) s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
    io.out(s + (nl ? '\n' : ''));
    return 0;
  },
  *printf(args, io) {
    if (!args.length) throw new ExitError(2, 'printf: usage: printf [-v var] format [arguments]');
    const fmt = args[0].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
    let rest = args.slice(1);
    let out = '';
    do {
      let used = 0;
      out += fmt.replace(/%(-?\d*)(\.\d+)?([sdqbf%])/g, (m, w, prec, c) => {
        if (c === '%') return '%';
        const v = rest[used++] ?? '';
        let s = c === 'd' ? String(parseInt(v, 10) || 0) : c === 'f' ? (parseFloat(v) || 0).toFixed(prec ? Number(prec.slice(1)) : 6) : c === 'b' ? v.replace(/\\n/g, '\n') : v;
        const width = parseInt(w, 10);
        if (width) s = width < 0 ? s.padEnd(-width) : s.padStart(width);
        return s;
      });
      rest = rest.slice(used);
      if (!used) break;
    } while (rest.length);
    io.out(out);
    return 0;
  },
  *export(args, io) {
    if (!args.length || args[0] === '-p') {
      for (const k of [...this.exported].sort()) io.line(`declare -x ${k}="${this.vars.get(k) ?? ''}"`);
      return 0;
    }
    for (const a of args) {
      const m = a.match(/^([A-Za-z_]\w*)(?:=(.*))?$/s);
      if (!m) { io.eline(`${this.shellName}: export: \`${a}': not a valid identifier`); continue; }
      if (m[2] !== undefined) this.vars.set(m[1], m[2]);
      this.exported.add(m[1]);
    }
    return 0;
  },
  *unset(args) {
    for (const a of args.filter((x) => !x.startsWith('-'))) { this.vars.delete(a); this.exported.delete(a); }
    return 0;
  },
  *alias(args, io) {
    if (!args.length) {
      for (const [k, v] of this.aliases) io.line(`alias ${k}='${v}'`);
      return 0;
    }
    for (const a of args) {
      const m = a.match(/^([^=]+)=(.*)$/s);
      if (m) this.aliases.set(m[1], m[2]);
      else if (this.aliases.has(a)) io.line(`alias ${a}='${this.aliases.get(a)}'`);
      else { io.eline(`${this.shellName}: alias: ${a}: not found`); return 1; }
    }
    return 0;
  },
  *unalias(args) { for (const a of args) this.aliases.delete(a); return 0; },
  *exit(args) { throw new ExitSignal(args.length ? (parseInt(args[0], 10) & 255) : this.status); },
  *logout(args) { throw new ExitSignal(0); },
  *return(args) { throw new ExitSignal(args.length ? parseInt(args[0], 10) : this.status); },
  *break(args) { throw new BreakSignal(Number(args[0] || 1)); },
  *continue(args) { throw new BreakSignal(Number(args[0] || 1), true); },
  true: noop,
  ':': noop,
  *false() { return 1; },
  *test(args) { return testExpr(args, this) ? 0 : 1; },
  *'['(args, io) {
    if (args[args.length - 1] !== ']') { io.eline(`${this.shellName}: [: missing \`]'`); return 2; }
    return testExpr(args.slice(0, -1), this) ? 0 : 1;
  },
  *'[['(args, io) {
    if (args[args.length - 1] !== ']]') { io.eline(`${this.shellName}: syntax error in conditional expression`); return 2; }
    const a = args.slice(0, -1);
    // && i || wewnątrz [[ ]]
    const oi = a.indexOf('||');
    if (oi >= 0) return (testExpr(a.slice(0, oi), this) || testExpr(a.slice(oi + 1), this)) ? 0 : 1;
    const ai = a.indexOf('&&');
    if (ai >= 0) return (testExpr(a.slice(0, ai), this) && testExpr(a.slice(ai + 1), this)) ? 0 : 1;
    return testExpr(a, this) ? 0 : 1;
  },
  *source(args, io) {
    if (!args.length) { io.eline(`${this.shellName}: source: filename argument required`); return 2; }
    let src;
    try { src = this.readFile(args[0]); } catch (e) { io.eline(`${this.shellName}: ${args[0]}: ${e.reason || 'No such file or directory'}`); return 1; }
    return yield* this.run(src, io);
  },
  *eval(args, io) { return yield* this.run(args.join(' '), io); },
  *set(args, io) {
    if (!args.length) { for (const [k, v] of [...this.vars].sort()) io.line(`${k}=${v}`); }
    for (const a of args) {
      if (/^-[a-z]*e/.test(a)) this.errexit = true;
      if (/^\+[a-z]*e/.test(a)) this.errexit = false;
      if (a === '-o' || a === '+o') continue;
    }
    if (args[0] === '-o' && args[1] === 'errexit') this.errexit = true;
    return 0;
  },
  *shopt() { return 0; },
  *complete() { return 0; },
  *local(args) { for (const a of args) { const m = a.match(/^([A-Za-z_]\w*)=(.*)$/s); if (m) this.vars.set(m[1], m[2]); } return 0; },
  *read(args, io) {
    let prompt = null;
    const names = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-p') prompt = args[++i];
      else if (args[i] === '-r' || args[i] === '-s') continue;
      else names.push(args[i]);
    }
    let line;
    if (io.stdin !== null && io.stdin !== undefined) {
      const idx = io.stdin.indexOf('\n');
      line = idx < 0 ? io.stdin : io.stdin.slice(0, idx);
      io.stdin = idx < 0 ? '' : io.stdin.slice(idx + 1);
      if (line === '' && idx < 0) return 1;
    } else {
      line = yield { type: 'input', prompt: prompt || '' };
      if (line === null) return 1;
    }
    const vals = line.trim().split(/\s+/);
    if (!names.length) names.push('REPLY');
    names.forEach((n, i) => this.vars.set(n, i === names.length - 1 ? vals.slice(i).join(' ') : (vals[i] || '')));
    return 0;
  },
  *type(args, io) {
    let st = 0;
    for (const a of args) {
      if (this.aliases.has(a)) io.line(`${a} is aliased to \`${this.aliases.get(a)}'`);
      else if (BUILTINS[a]) io.line(`${a} is a shell builtin`);
      else if (this.opts.commands?.(a, this)) io.line(`${a} is ${binPath(a)}`);
      else { io.eline(`${this.shellName}: type: ${a}: not found`); st = 1; }
    }
    return st;
  },
  *which(args, io) {
    let st = 0;
    for (const a of args.filter((x) => !x.startsWith('-'))) {
      if (this.opts.commands?.(a, this)) io.line(binPath(a)); else st = 1;
    }
    return st;
  },
  *command(args, io) {
    if (args[0] === '-v') {
      const a = args[1];
      if (this.aliases.has(a)) { io.line(`alias ${a}='${this.aliases.get(a)}'`); return 0; }
      if (BUILTINS[a]) { io.line(a); return 0; }
      if (this.opts.commands?.(a, this)) { io.line(binPath(a)); return 0; }
      return 1;
    }
    return yield* this.invoke(args, io);
  },
  *history(args, io) {
    if (args[0] === '-c') { this.history.length = 0; return 0; }
    const n = parseInt(args[0], 10);
    const h = n ? this.history.slice(-n) : this.history;
    const base = this.history.length - h.length;
    h.forEach((l, i) => io.line(`${String(base + i + 1).padStart(5)}  ${l}`));
    return 0;
  },
  *clear() { yield { type: 'clear' }; return 0; },
  *reset() { yield { type: 'clear' }; return 0; },
  *sleep(args, io) {
    let total = 0;
    for (const a of args) {
      const m = String(a).match(/^([0-9.]+)([smhd]?)$/);
      if (a === 'infinity') { total = 1e12; break; }
      if (!m) { io.eline(`sleep: invalid time interval '${a}'`); return 1; }
      total += parseFloat(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
    }
    if (!args.length) { io.eline('sleep: missing operand'); return 1; }
    yield { type: 'sleep', ms: total * 1000 };
    return 0;
  },
  *wait() { return 0; },
  *trap() { return 0; },
  *ulimit() { return 0; },
  *umask() { return 0; },
  *hash() { return 0; },
};

export function binPath(name) {
  const local = ['kubectl', 'helm', 'yq', 'crictl', 'etcdctl', 'etcdutl', 'containerd', 'runc', 'cka'];
  if (['kubeadm', 'kubelet', 'kubectl'].includes(name)) return `/usr/bin/${name}`;
  if (local.includes(name)) return `/usr/local/bin/${name}`;
  if (['systemctl', 'journalctl', 'modprobe', 'sysctl', 'swapoff', 'iptables', 'ip', 'ss', 'reboot'].includes(name)) return `/usr/sbin/${name}`;
  return `/usr/bin/${name}`;
}

export { ShellSyntaxError, Incomplete };
