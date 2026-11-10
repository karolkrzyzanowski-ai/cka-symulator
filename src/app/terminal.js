// Terminal oparty o DOM (lepiej działa z klawiaturą ekranową niż canvas).
const MAX_LINES = 4000;

const ANSI = { 30: 'k', 31: 'r', 32: 'g', 33: 'y', 34: 'b', 35: 'm', 36: 'c', 37: 'w', 90: 'k', 91: 'r', 92: 'g', 93: 'y', 94: 'b', 95: 'm', 96: 'c', 97: 'w' };

export class Terminal {
  constructor(root, { onSubmit, onTab, onInterrupt, onEof, onHistory, onPasteLines }) {
    this.root = root;
    this.cb = { onSubmit, onTab, onInterrupt, onEof, onHistory, onPasteLines };
    root.classList.add('term');
    root.innerHTML = '<div class="term-out" aria-live="polite"></div><div class="term-line"><span class="term-prompt"></span><input class="term-in" type="text" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="send" aria-label="Polecenie"></div>';
    this.out = root.querySelector('.term-out');
    this.line = root.querySelector('.term-line');
    this.promptEl = root.querySelector('.term-prompt');
    this.input = root.querySelector('.term-in');
    this.cur = null; // bieżący element linii
    this.color = null;
    this.lineCount = 0;
    this.secret = false;
    this.input.addEventListener('keydown', (e) => this.key(e));
    this.input.addEventListener('paste', (e) => {
      const t = (e.clipboardData || window.clipboardData)?.getData('text') || '';
      if (t.includes('\n')) {
        e.preventDefault();
        const lines = (this.input.value + t).replace(/\r/g, '').split('\n');
        this.input.value = '';
        this.cb.onPasteLines?.(lines);
      }
    });
    root.addEventListener('click', (e) => {
      if (window.getSelection()?.toString()) return;
      if (e.target.closest('a,button')) return;
      this.focus();
    });
  }

  key(e) {
    if (e.key === 'Enter') { e.preventDefault(); const v = this.input.value; this.input.value = ''; this.cb.onSubmit?.(v); return; }
    if (e.key === 'Tab') { e.preventDefault(); this.cb.onTab?.(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); this.cb.onHistory?.(-1); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); this.cb.onHistory?.(1); return; }
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) { if (this.input.selectionStart !== this.input.selectionEnd) return; e.preventDefault(); this.cb.onInterrupt?.(); return; }
    if (e.ctrlKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); if (!this.input.value) this.cb.onEof?.(); return; }
    if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); this.clear(); return; }
    if (e.ctrlKey && (e.key === 'u' || e.key === 'U')) { e.preventDefault(); this.input.value = ''; return; }
    if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); this.input.setSelectionRange(0, 0); return; }
    if (e.ctrlKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); const n = this.input.value.length; this.input.setSelectionRange(n, n); }
  }

  focus() { this.input.focus({ preventScroll: true }); this.scroll(); }
  get value() { return this.input.value; }
  set value(v) { this.input.value = v; const n = v.length; try { this.input.setSelectionRange(n, n); } catch { /* */ } }

  insert(text) {
    const el = this.input;
    const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, s) + text + el.value.slice(e);
    const p = s + text.length;
    try { el.setSelectionRange(p, p); } catch { /* */ }
    el.focus({ preventScroll: true });
  }

  setPrompt(p, { secret = false, hidden = false } = {}) {
    this.promptEl.textContent = p;
    this.secret = secret;
    this.input.type = secret ? 'password' : 'text';
    this.line.style.visibility = hidden ? 'hidden' : 'visible';
    this.scroll();
  }

  newLine() {
    const d = document.createElement('div');
    d.className = 'tl';
    this.out.appendChild(d);
    this.cur = d;
    this.lineCount++;
    if (this.lineCount > MAX_LINES) {
      const drop = this.lineCount - MAX_LINES;
      for (let i = 0; i < drop; i++) this.out.firstChild?.remove();
      this.lineCount = MAX_LINES;
    }
    return d;
  }

  // tekst może zawierać \n i sekwencje ANSI kolorów
  write(text, isErr = false) {
    if (!text) return;
    const parts = String(text).split(/(\x1b\[[0-9;]*m)/);
    for (const part of parts) {
      if (!part) continue;
      const m = part.match(/^\x1b\[([0-9;]*)m$/);
      if (m) {
        const codes = m[1].split(';').map(Number);
        for (const c of codes) { if (c === 0) this.color = null; else if (ANSI[c]) this.color = ANSI[c]; }
        continue;
      }
      // this.cur = otwarta linia; null = jesteśmy na początku nowej (jeszcze pustej) linii
      const segs = part.split('\n');
      segs.forEach((seg, i) => {
        if (i > 0) {
          if (!this.cur) this.newLine(); // pusta linia
          this.cur = null;
        }
        if (!seg) return;
        if (!this.cur) this.newLine();
        const span = document.createElement('span');
        span.textContent = seg.replace(/\t/g, '        ').replace(/\r/g, '');
        if (this.color) span.className = `c-${this.color}`;
        else if (isErr) span.className = 'c-err';
        this.cur.appendChild(span);
      });
    }
    this.scroll();
  }

  // linia z promptem i wpisanym poleceniem (echo)
  echo(prompt, cmd) {
    this.newLine();
    const p = document.createElement('span'); p.className = 'c-prompt'; p.textContent = prompt;
    const c = document.createElement('span'); c.textContent = cmd;
    this.cur.append(p, c);
    this.cur = null;
    this.scroll();
  }

  clear() { this.out.innerHTML = ''; this.cur = null; this.lineCount = 0; }

  // przybliżona liczba kolumn widocznych na ekranie
  cols() {
    const probe = document.createElement('span');
    probe.textContent = 'MMMMMMMMMM';
    probe.style.visibility = 'hidden';
    probe.style.position = 'absolute';
    this.out.appendChild(probe);
    const w = probe.getBoundingClientRect().width / 10 || 8;
    probe.remove();
    return Math.max(20, Math.floor((this.root.clientWidth - 16) / w));
  }

  // lista propozycji w kolumnach (jak podwójny Tab w bashu)
  columns(items) {
    const width = Math.max(...items.map((s) => s.length)) + 2;
    const per = Math.max(1, Math.floor(this.cols() / width));
    const rows = Math.ceil(items.length / per);
    let s = '';
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let c = 0; c < per; c++) { const it = items[c * rows + r]; if (it !== undefined) line += it.padEnd(width); }
      s += `${line.trimEnd()}\n`;
    }
    this.write(s);
  }

  scroll() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this.root.scrollTop = this.root.scrollHeight; });
  }
}
