// Edytor plików (zastępuje vim/nano/kubectl edit). Zwraca {saved, content} po zamknięciu.
const PAIRS = [
  ['⇥', 'indent'], ['⇤', 'dedent'], ['- ', '- '], [': ', ': '], ['"', '"'], ["'", "'"], ['[ ]', '[]'], ['{ }', '{}'],
  ['/', '/'], ['|', '|'], ['=', '='], ['#', '#'], ['Usuń linię', 'delline'], ['Kopiuj linię', 'dupline'], ['Szukaj', 'find'],
];

export class Editor {
  constructor(root) {
    this.root = root;
    root.className = 'editor';
    root.hidden = true;
    root.innerHTML = `
      <header class="ed-bar">
        <div class="ed-file"><span class="ed-name"></span><span class="ed-flag"></span></div>
        <div class="ed-pos" aria-live="off"></div>
      </header>
      <div class="ed-find" hidden>
        <input class="ed-find-in" type="text" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Szukaj w pliku" enterkeyhint="search">
        <button type="button" class="ed-find-next">Dalej</button>
        <button type="button" class="ed-find-close" aria-label="Zamknij wyszukiwanie">✕</button>
      </div>
      <div class="ed-body">
        <pre class="ed-gutter" aria-hidden="true"></pre>
        <textarea class="ed-text" wrap="off" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Zawartość pliku"></textarea>
      </div>
      <div class="ed-keys keyrow" role="toolbar" aria-label="Znaki pomocnicze"></div>
      <footer class="ed-actions">
        <button type="button" class="btn btn-ghost ed-quit">Wyjdź</button>
        <button type="button" class="btn btn-quiet ed-save">Zapisz</button>
        <button type="button" class="btn btn-primary ed-savequit">Zapisz i wyjdź</button>
      </footer>
      <div class="ed-confirm" hidden>
        <div class="ed-confirm-box">
          <p>Plik ma niezapisane zmiany.</p>
          <div class="ed-confirm-actions">
            <button type="button" class="btn btn-ghost ed-c-discard">Odrzuć zmiany</button>
            <button type="button" class="btn btn-quiet ed-c-back">Wróć do edycji</button>
            <button type="button" class="btn btn-primary ed-c-save">Zapisz i wyjdź</button>
          </div>
        </div>
      </div>`;
    this.ta = root.querySelector('.ed-text');
    this.gutter = root.querySelector('.ed-gutter');
    this.posEl = root.querySelector('.ed-pos');
    this.nameEl = root.querySelector('.ed-name');
    this.flagEl = root.querySelector('.ed-flag');
    this.findBar = root.querySelector('.ed-find');
    this.findIn = root.querySelector('.ed-find-in');
    this.confirmEl = root.querySelector('.ed-confirm');
    const keys = root.querySelector('.ed-keys');
    for (const [label, act] of PAIRS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'key';
      b.textContent = label;
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', () => this.action(act));
      keys.appendChild(b);
    }
    this.ta.addEventListener('input', () => { this.refreshGutter(); this.updatePos(); });
    this.ta.addEventListener('scroll', () => { this.gutter.style.transform = `translateY(${-this.ta.scrollTop}px)`; });
    for (const ev of ['keyup', 'click', 'select']) this.ta.addEventListener(ev, () => this.updatePos());
    document.addEventListener('selectionchange', () => { if (!this.root.hidden && document.activeElement === this.ta) this.updatePos(); });
    this.ta.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') { e.preventDefault(); this.newline(); }
    });
    this.ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); this.action(e.shiftKey ? 'dedent' : 'indent'); }
      if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.save(); }
    });
    root.querySelector('.ed-save').addEventListener('click', () => this.save());
    root.querySelector('.ed-savequit').addEventListener('click', () => { this.save(); this.finish(); });
    root.querySelector('.ed-quit').addEventListener('click', () => this.quit());
    root.querySelector('.ed-c-discard').addEventListener('click', () => { this.confirmEl.hidden = true; this.finish(); });
    root.querySelector('.ed-c-back').addEventListener('click', () => { this.confirmEl.hidden = true; this.ta.focus(); });
    root.querySelector('.ed-c-save').addEventListener('click', () => { this.confirmEl.hidden = true; this.save(); this.finish(); });
    root.querySelector('.ed-find-next').addEventListener('click', () => this.findNext());
    root.querySelector('.ed-find-close').addEventListener('click', () => { this.findBar.hidden = true; this.ta.focus(); });
    this.findIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.findNext(); } });
  }

  get isOpen() { return !this.root.hidden; }

  open(ef) {
    this.ef = ef;
    this.original = ef.content ?? '';
    this.savedContent = null;
    this.lastSavedText = this.original;
    this.ta.value = this.original;
    this.nameEl.textContent = ef.name || ef.path || 'plik';
    this.flagEl.textContent = ef.readonly ? 'tylko do odczytu' : ef.newFile ? 'nowy plik' : ef.kubectlEdit ? 'kubectl edit' : '';
    this.flagEl.hidden = !this.flagEl.textContent;
    this.root.hidden = false;
    this.findBar.hidden = true;
    this.confirmEl.hidden = true;
    this.refreshGutter();
    this.ta.scrollTop = 0;
    this.ta.setSelectionRange(0, 0);
    requestAnimationFrame(() => { this.ta.focus({ preventScroll: true }); this.updatePos(); });
    return new Promise((resolve) => { this.resolve = resolve; });
  }

  // klawisz wstecz w Androidzie
  back() {
    if (!this.confirmEl.hidden) { this.confirmEl.hidden = true; return; }
    if (!this.findBar.hidden) { this.findBar.hidden = true; return; }
    this.quit();
  }

  save() {
    this.savedContent = this.ta.value;
    this.lastSavedText = this.ta.value;
    this.flash(this.ef.readonly ? 'Plik jest tylko do odczytu' : 'Zapisano');
  }

  quit() {
    if (this.ta.value !== this.lastSavedText) { this.confirmEl.hidden = false; return; }
    this.finish();
  }

  finish() {
    this.root.hidden = true;
    const r = this.savedContent === null ? { saved: false } : { saved: true, content: this.savedContent };
    const res = this.resolve;
    this.resolve = null;
    res?.(r);
  }

  flash(msg) {
    this.posEl.textContent = msg;
    clearTimeout(this._flash);
    this._flash = setTimeout(() => this.updatePos(), 1200);
  }

  refreshGutter() {
    const n = this.ta.value.split('\n').length;
    if (n === this._lines) return;
    this._lines = n;
    let s = '';
    for (let i = 1; i <= n; i++) s += `${i}\n`;
    this.gutter.textContent = s;
    this.gutter.style.transform = `translateY(${-this.ta.scrollTop}px)`;
  }

  updatePos() {
    const v = this.ta.value, p = this.ta.selectionStart ?? 0;
    const before = v.slice(0, p);
    const line = before.split('\n').length;
    const col = p - before.lastIndexOf('\n');
    this.posEl.textContent = `wiersz ${line}, kol. ${col}`;
  }

  insert(text, selectFrom = null) {
    const ta = this.ta;
    ta.focus({ preventScroll: true });
    // execCommand zachowuje historię cofania w polu tekstowym
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
    if (!ok) {
      const s = ta.selectionStart, e = ta.selectionEnd;
      ta.setRangeText(text, s, e, 'end');
      ta.dispatchEvent(new Event('input'));
    }
    if (selectFrom !== null) { const p = ta.selectionStart - selectFrom; ta.setSelectionRange(p, p); }
  }

  lineBounds() {
    const v = this.ta.value, s = this.ta.selectionStart, e = this.ta.selectionEnd;
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    let le = v.indexOf('\n', e === s ? e : e - 1);
    if (le < 0) le = v.length;
    return { v, s, e, ls, le };
  }

  newline() {
    const { v, s, ls } = this.lineBounds();
    const cur = v.slice(ls, s);
    let ind = cur.match(/^\s*/)[0];
    const trimmed = cur.trimEnd();
    if (/:$/.test(trimmed) || /^\s*- [^:]+:\s*$/.test(trimmed)) ind += '  ';
    else if (/^\s*- /.test(cur) && trimmed !== '-') ind = cur.match(/^\s*/)[0] + '  ';
    this.insert(`\n${ind}`);
  }

  replaceLines(fn) {
    const ta = this.ta;
    const { v, s, e, ls, le } = this.lineBounds();
    const block = v.slice(ls, le);
    const next = fn(block);
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ls, le);
    this.insert(next);
    const delta = next.length - block.length;
    if (s === e) { const p = Math.max(ls, s + (next.split('\n')[0].length - block.split('\n')[0].length)); ta.setSelectionRange(p, p); } else ta.setSelectionRange(ls, le + delta);
    this.updatePos();
  }

  action(act) {
    const ta = this.ta;
    if (act === 'indent') {
      if (ta.selectionStart !== ta.selectionEnd) this.replaceLines((b) => b.split('\n').map((l) => `  ${l}`).join('\n'));
      else this.insert('  ');
      return;
    }
    if (act === 'dedent') { this.replaceLines((b) => b.split('\n').map((l) => l.replace(/^ {1,2}/, '')).join('\n')); return; }
    if (act === 'delline') {
      const { v, ls, le } = this.lineBounds();
      const end = le < v.length ? le + 1 : le;
      const start = le >= v.length && ls > 0 ? ls - 1 : ls;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(start, end);
      this.insert('');
      return;
    }
    if (act === 'dupline') {
      const { v, ls, le } = this.lineBounds();
      const line = v.slice(ls, le);
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(le, le);
      this.insert(`\n${line}`);
      return;
    }
    if (act === 'find') { this.findBar.hidden = false; this.findIn.focus(); this.findIn.select(); return; }
    if (act === '[]' || act === '{}') { this.insert(act, 1); return; }
    if (act === '"' || act === "'") { this.insert(act); return; }
    this.insert(act);
  }

  findNext() {
    const q = this.findIn.value;
    if (!q) return;
    const v = this.ta.value;
    let i = v.indexOf(q, this.ta.selectionEnd);
    if (i < 0) i = v.indexOf(q);
    if (i < 0) { this.flash('Nie znaleziono'); return; }
    this.ta.focus({ preventScroll: true });
    this.ta.setSelectionRange(i, i + q.length);
    // przewiń do zaznaczenia
    const line = v.slice(0, i).split('\n').length - 1;
    const lh = parseFloat(getComputedStyle(this.ta).lineHeight) || 18;
    this.ta.scrollTop = Math.max(0, line * lh - this.ta.clientHeight / 3);
    this.updatePos();
  }
}
