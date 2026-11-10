// Parser powłoki w stylu bash (podzbiór wystarczający do pracy z kubectl).

export class ShellSyntaxError extends Error {}
export class Incomplete extends Error {}

const RESERVED = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', '{', '}', '!', 'case', 'esac']);

// --------------------------------------------------------------------------- lekser
class Lexer {
  constructor(src) {
    this.s = src;
    this.i = 0;
    this.tokens = [];
    this.pendingHeredocs = [];
  }

  peekc(o = 0) { return this.s[this.i + o]; }

  run() {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === ' ' || c === '\t' || c === '\r') { this.i++; continue; }
      if (c === '\\' && s[this.i + 1] === '\n') { this.i += 2; continue; }
      if (c === '#') { while (this.i < s.length && s[this.i] !== '\n') this.i++; continue; }
      if (c === '\n') {
        this.tokens.push({ op: '\n' });
        this.i++;
        if (this.pendingHeredocs.length) this.readHeredocs();
        continue;
      }
      const two = s.slice(this.i, this.i + 2), three = s.slice(this.i, this.i + 3);
      // przekierowania z deskryptorem: 2>, 2>>, 2>&1, 1>
      const fdm = s.slice(this.i).match(/^(\d)(>>|>&|>|<)/);
      if (fdm && (this.tokens.length === 0 || this.prevIsBoundary())) {
        this.i += fdm[0].length;
        this.pushRedir(fdm[2], Number(fdm[1]));
        continue;
      }
      if (three === '<<-') { this.i += 3; this.pushRedir('<<-', 0); continue; }
      if (three === '<<<') { this.i += 3; this.pushRedir('<<<', 0); continue; }
      if (three === '&>>') { this.i += 3; this.pushRedir('&>>', 1); continue; }
      if (two === '&&' || two === '||' || two === ';;') { this.tokens.push({ op: two }); this.i += 2; continue; }
      if (two === '<<') { this.i += 2; this.pushRedir('<<', 0); continue; }
      if (two === '>>') { this.i += 2; this.pushRedir('>>', 1); continue; }
      if (two === '&>') { this.i += 2; this.pushRedir('&>', 1); continue; }
      if (two === '>&') { this.i += 2; this.pushRedir('>&', 1); continue; }
      if (c === '>') { this.i++; this.pushRedir('>', 1); continue; }
      if (c === '<') { this.i++; this.pushRedir('<', 0); continue; }
      if (c === '|' || c === ';' || c === '&' || c === '(' || c === ')') { this.tokens.push({ op: c }); this.i++; continue; }
      this.tokens.push({ word: this.readWord() });
    }
    if (this.pendingHeredocs.length) throw new Incomplete('heredoc');
    return this.tokens;
  }

  prevIsBoundary() {
    const p = this.s[this.i - 1];
    return p === undefined || /[\s;|&()]/.test(p);
  }

  pushRedir(op, fd) {
    this.tokens.push({ redir: op, fd });
    if (op === '<<' || op === '<<-') {
      // ogranicznik heredoc
      while (this.s[this.i] === ' ' || this.s[this.i] === '\t') this.i++;
      const w = this.readWord();
      if (!w.length) throw new ShellSyntaxError("syntax error near unexpected token `newline'");
      const quoted = w.some((p) => p.t !== 'lit');
      const delim = w.map((p) => (p.t === 'lit' ? p.v : p.t === 'sq' ? p.v : p.t === 'dq' ? p.parts.map((x) => x.v ?? '').join('') : '')).join('');
      const tok = { heredoc: true, delim, quoted, strip: op === '<<-', content: null };
      this.tokens.push(tok);
      this.pendingHeredocs.push(tok);
    }
  }

  readHeredocs() {
    while (this.pendingHeredocs.length) {
      const h = this.pendingHeredocs[0];
      const lines = [];
      let found = false;
      while (this.i < this.s.length) {
        let j = this.s.indexOf('\n', this.i);
        if (j < 0) j = this.s.length;
        let line = this.s.slice(this.i, j);
        this.i = j + 1;
        const cmp = h.strip ? line.replace(/^\t+/, '') : line;
        if (cmp.trimEnd() === h.delim) { found = true; break; }
        if (h.strip) line = line.replace(/^\t+/, '');
        lines.push(line);
      }
      if (!found) throw new Incomplete('heredoc');
      h.content = lines.length ? lines.join('\n') + '\n' : '';
      this.pendingHeredocs.shift();
    }
  }

  // słowo: lista części {t:'lit'|'sq'|'dq'|'var'|'cmdsub'|'arith'}
  readWord() {
    const s = this.s;
    const parts = [];
    let lit = '';
    const flush = () => { if (lit) { parts.push({ t: 'lit', v: lit }); lit = ''; } };
    while (this.i < s.length) {
      const c = s[this.i];
      if (/[\s|&;<>()]/.test(c)) {
        // ( po = w przypisaniu tablicy nie obsługujemy
        break;
      }
      if (c === '\\') {
        if (this.i + 1 >= s.length) throw new Incomplete('backslash');
        if (s[this.i + 1] === '\n') { this.i += 2; continue; }
        flush();
        parts.push({ t: 'sq', v: s[this.i + 1] });
        this.i += 2;
        continue;
      }
      if (c === "'") {
        const j = s.indexOf("'", this.i + 1);
        if (j < 0) throw new Incomplete('quote');
        flush();
        parts.push({ t: 'sq', v: s.slice(this.i + 1, j) });
        this.i = j + 1;
        continue;
      }
      if (c === '"') {
        flush();
        this.i++;
        parts.push({ t: 'dq', parts: this.readDouble() });
        continue;
      }
      if (c === '$' || c === '`') {
        const p = this.readDollar();
        if (p) { flush(); parts.push(p); continue; }
      }
      lit += c;
      this.i++;
    }
    flush();
    return parts;
  }

  readDouble() {
    const s = this.s;
    const parts = [];
    let lit = '';
    const flush = () => { if (lit) { parts.push({ t: 'lit', v: lit }); lit = ''; } };
    while (true) {
      if (this.i >= s.length) throw new Incomplete('dquote');
      const c = s[this.i];
      if (c === '"') { this.i++; break; }
      if (c === '\\') {
        const n = s[this.i + 1];
        if (n === undefined) throw new Incomplete('dquote');
        if ('$`"\\\n'.includes(n)) { if (n !== '\n') lit += n; this.i += 2; continue; }
        lit += c;
        this.i++;
        continue;
      }
      if (c === '$' || c === '`') {
        const p = this.readDollar();
        if (p) { flush(); parts.push(p); continue; }
      }
      lit += c;
      this.i++;
    }
    flush();
    return parts;
  }

  readDollar() {
    const s = this.s;
    if (s[this.i] === '`') {
      const j = s.indexOf('`', this.i + 1);
      if (j < 0) throw new Incomplete('backtick');
      const inner = s.slice(this.i + 1, j);
      this.i = j + 1;
      return { t: 'cmdsub', src: inner };
    }
    const n = s[this.i + 1];
    if (n === '(' && s[this.i + 2] === '(') {
      const end = findClose(s, this.i + 3, '((', '))');
      if (end < 0) throw new Incomplete('arith');
      const expr = s.slice(this.i + 3, end);
      this.i = end + 2;
      return { t: 'arith', expr };
    }
    if (n === '(') {
      const end = findParen(s, this.i + 2);
      if (end < 0) throw new Incomplete('cmdsub');
      const inner = s.slice(this.i + 2, end);
      this.i = end + 1;
      return { t: 'cmdsub', src: inner };
    }
    if (n === '{') {
      const j = s.indexOf('}', this.i + 2);
      if (j < 0) throw new Incomplete('brace');
      const inner = s.slice(this.i + 2, j);
      this.i = j + 1;
      const m = inner.match(/^(#?)([A-Za-z_][A-Za-z0-9_]*|\d+|[?$#@*!])(?:(:?[-=+?])(.*)|(##?|%%?)(.*)|\/(.*?)\/(.*))?$/s);
      if (!m) throw new ShellSyntaxError(`\${${inner}}: bad substitution`);
      if (m[1]) return { t: 'var', name: m[2], len: true };
      if (m[3]) return { t: 'var', name: m[2], op: m[3], arg: m[4] };
      if (m[5]) return { t: 'var', name: m[2], trim: m[5], arg: m[6] };
      if (m[7] !== undefined) return { t: 'var', name: m[2], repl: [m[7], m[8]] };
      return { t: 'var', name: m[2] };
    }
    const m = s.slice(this.i + 1).match(/^([A-Za-z_][A-Za-z0-9_]*|[0-9?$#@*!-])/);
    if (m) {
      this.i += 1 + m[1].length;
      return { t: 'var', name: m[1] };
    }
    return null;
  }
}

function findParen(s, from) {
  let depth = 1, inS = false, inD = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inS) { if (c === "'") inS = false; continue; }
    if (c === '\\') { i++; continue; }
    if (inD) { if (c === '"') inD = false; continue; }
    if (c === "'") inS = true;
    else if (c === '"') inD = true;
    else if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function findClose(s, from, open, close) {
  let depth = 1;
  for (let i = from; i < s.length - 1; i++) {
    if (s.startsWith(open, i)) { depth++; i++; continue; }
    if (s.startsWith(close, i)) { depth--; if (depth === 0) return i; i++; }
  }
  return -1;
}

// --------------------------------------------------------------------------- parser
const litOf = (tok) => (tok && tok.word && tok.word.length === 1 && tok.word[0].t === 'lit' ? tok.word[0].v : null);

class Parser {
  constructor(tokens) { this.t = tokens; this.i = 0; }
  peek() { return this.t[this.i]; }
  next() { return this.t[this.i++]; }
  atEnd() { return this.i >= this.t.length; }
  isOp(op) { const k = this.peek(); return k && k.op === op; }
  isWord(w) { return litOf(this.peek()) === w; }
  skipNewlines() { while (this.isOp('\n') || this.isOp(';')) this.i++; }
  skipNL() { while (this.isOp('\n')) this.i++; }

  expectWord(w) {
    this.skipNewlines();
    if (this.atEnd()) throw new Incomplete(w);
    if (!this.isWord(w)) throw new ShellSyntaxError(`syntax error near unexpected token \`${litOf(this.peek()) ?? this.peek().op ?? 'newline'}'`);
    this.i++;
  }

  // lista poleceń aż do jednego z terminatorów (słów zastrzeżonych)
  list(terms = []) {
    const items = [];
    while (true) {
      this.skipNewlines();
      if (this.atEnd()) break;
      if (terms.some((w) => this.isWord(w)) || this.isOp(')') || this.isOp(';;')) break;
      let n = this.andOr();
      if (this.isOp('&')) { this.i++; n = { type: 'bg', node: n }; }
      items.push(n);
      if (this.isOp(';') || this.isOp('\n')) continue;
      if (this.atEnd()) break;
      if (terms.some((w) => this.isWord(w)) || this.isOp(')') || this.isOp(';;')) break;
      if (this.isOp('&')) continue;
      const k = this.peek();
      throw new ShellSyntaxError(`syntax error near unexpected token \`${litOf(k) ?? k.op ?? k.redir}'`);
    }
    return { type: 'seq', items };
  }

  andOr() {
    let left = this.pipeline();
    while (this.isOp('&&') || this.isOp('||')) {
      const op = this.next().op;
      this.skipNL();
      if (this.atEnd()) throw new Incomplete(op);
      const right = this.pipeline();
      left = { type: op === '&&' ? 'and' : 'or', left, right };
    }
    return left;
  }

  pipeline() {
    let neg = false;
    if (this.isWord('!')) { this.i++; neg = true; }
    const cmds = [this.command()];
    while (this.isOp('|')) {
      this.i++;
      this.skipNL();
      if (this.atEnd()) throw new Incomplete('|');
      cmds.push(this.command());
    }
    const node = cmds.length === 1 ? cmds[0] : { type: 'pipe', cmds };
    return neg ? { type: 'not', node } : node;
  }

  command() {
    const k = this.peek();
    if (!k) throw new Incomplete('command');
    const w = litOf(k);
    if (w === 'if') return this.withRedirs(this.ifClause());
    if (w === 'for') return this.withRedirs(this.forClause());
    if (w === 'while' || w === 'until') return this.withRedirs(this.whileClause(w));
    if (w === 'case') return this.withRedirs(this.caseClause());
    if (w === '{') { this.i++; const body = this.list(['}']); this.expectWord('}'); return this.withRedirs({ type: 'group', body }); }
    if (k.op === '(') {
      this.i++;
      const body = this.list([]);
      this.skipNewlines();
      if (this.atEnd()) throw new Incomplete(')');
      if (!this.isOp(')')) throw new ShellSyntaxError("syntax error near unexpected token `('");
      this.i++;
      return this.withRedirs({ type: 'subshell', body });
    }
    return this.simple();
  }

  withRedirs(node) {
    const redirs = [];
    while (this.peek()?.redir) redirs.push(this.redir());
    if (redirs.length) node.redirs = redirs;
    return node;
  }

  redir() {
    const r = this.next();
    if (r.redir === '<<' || r.redir === '<<-') {
      const h = this.next();
      return { op: '<<', fd: 0, heredoc: h };
    }
    const target = this.next();
    if (!target || !target.word) {
      if (!target) throw new Incomplete('redir');
      throw new ShellSyntaxError(`syntax error near unexpected token \`${target.op === '\n' ? 'newline' : target.op}'`);
    }
    return { op: r.redir, fd: r.fd, target: target.word };
  }

  simple() {
    const assigns = [], words = [], redirs = [];
    while (!this.atEnd()) {
      const k = this.peek();
      if (k.redir) { redirs.push(this.redir()); continue; }
      if (!k.word) break;
      const w = litOf(k);
      if (!words.length && w !== null && RESERVED.has(w) && !['{', '}', '!'].includes(w)) {
        if (!assigns.length) throw new ShellSyntaxError(`syntax error near unexpected token \`${w}'`);
        break;
      }
      if (!words.length && w === '}') break;
      // przypisanie VAR=...
      const first = k.word[0];
      if (!words.length && first.t === 'lit') {
        const m = first.v.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
        if (m) {
          this.i++;
          const val = [];
          if (m[2]) val.push({ t: 'lit', v: m[2] });
          val.push(...k.word.slice(1));
          assigns.push({ name: m[1], value: val });
          continue;
        }
      }
      words.push(k.word);
      this.i++;
    }
    if (!words.length && !assigns.length && !redirs.length) {
      const k = this.peek();
      throw new ShellSyntaxError(`syntax error near unexpected token \`${k ? (k.op === '\n' ? 'newline' : (k.op || litOf(k))) : 'newline'}'`);
    }
    return { type: 'cmd', assigns, words, redirs };
  }

  ifClause() {
    this.i++; // if
    const clauses = [];
    let cond = this.list(['then']);
    this.expectWord('then');
    let body = this.list(['elif', 'else', 'fi']);
    clauses.push({ cond, body });
    let elseBody = null;
    while (true) {
      this.skipNewlines();
      if (this.atEnd()) throw new Incomplete('fi');
      if (this.isWord('elif')) {
        this.i++;
        cond = this.list(['then']);
        this.expectWord('then');
        body = this.list(['elif', 'else', 'fi']);
        clauses.push({ cond, body });
      } else if (this.isWord('else')) {
        this.i++;
        elseBody = this.list(['fi']);
      } else if (this.isWord('fi')) { this.i++; break; } else throw new ShellSyntaxError('syntax error: expected fi');
    }
    return { type: 'if', clauses, else: elseBody };
  }

  forClause() {
    this.i++; // for
    const v = this.next();
    if (!v) throw new Incomplete('for');
    const name = litOf(v);
    if (!name || !/^[A-Za-z_]\w*$/.test(name)) throw new ShellSyntaxError(`\`${name}': not a valid identifier`);
    let items = null;
    this.skipNL();
    if (this.isWord('in')) {
      this.i++;
      items = [];
      while (!this.atEnd() && this.peek().word) { items.push(this.next().word); }
    }
    this.expectWord('do');
    const body = this.list(['done']);
    this.expectWord('done');
    return { type: 'for', name, items, body };
  }

  caseClause() {
    this.i++; // case
    const wt = this.next();
    if (!wt) throw new Incomplete('case');
    if (!wt.word) throw new ShellSyntaxError("syntax error near unexpected token `newline'");
    this.expectWord('in');
    const items = [];
    while (true) {
      this.skipNewlines();
      if (this.atEnd()) throw new Incomplete('esac');
      if (this.isWord('esac')) { this.i++; break; }
      if (this.isOp('(')) this.i++;
      const pats = [];
      while (true) {
        const t = this.next();
        if (!t) throw new Incomplete('case');
        if (!t.word) throw new ShellSyntaxError(`syntax error near unexpected token \`${t.op === '\n' ? 'newline' : t.op}'`);
        pats.push(t.word);
        if (this.isOp('|')) { this.i++; continue; }
        break;
      }
      if (this.atEnd()) throw new Incomplete('case');
      if (!this.isOp(')')) throw new ShellSyntaxError(`syntax error near unexpected token \`${litOf(this.peek()) ?? this.peek().op}'`);
      this.i++;
      const body = this.list(['esac']);
      this.skipNL();
      if (this.isOp(';;')) this.i++;
      else if (this.atEnd()) throw new Incomplete('esac');
      items.push({ pats, body });
    }
    return { type: 'case', word: wt.word, items };
  }

  whileClause(kind) {
    this.i++;
    const cond = this.list(['do']);
    this.expectWord('do');
    const body = this.list(['done']);
    this.expectWord('done');
    return { type: kind, cond, body };
  }
}

export function parse(src) {
  const toks = new Lexer(src).run();
  const p = new Parser(toks);
  const tree = p.list([]);
  if (!p.atEnd()) {
    const k = p.peek();
    if (k.op === ')') throw new ShellSyntaxError("syntax error near unexpected token `)'");
    if (k.op === ';;') throw new ShellSyntaxError("syntax error near unexpected token `;;'");
    const w = litOf(k);
    if (['fi', 'done', 'then', 'else', 'elif', 'do', '}', 'esac'].includes(w)) throw new ShellSyntaxError(`syntax error near unexpected token \`${w}'`);
  }
  return tree;
}

// czy wejście jest kompletne (do obsługi kontynuacji "> ")
export function isComplete(src) {
  try { parse(src); return true; } catch (e) { return !(e instanceof Incomplete); }
}

export function wordToString(word) {
  return word.map((p) => (p.t === 'lit' || p.t === 'sq' ? p.v : p.t === 'dq' ? wordToString(p.parts) : '')).join('');
}
