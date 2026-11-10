// Wykonywanie poleceń w terminalu: sterowanie generatorami sesji i efektami (sleep, input, edycja, subshell).
import { Session } from '../sim/session.js';

export class Runner {
  constructor({ world, term, editor, getTimeScale, onActivity }) {
    this.world = world;
    this.term = term;
    this.editor = editor;
    this.getTimeScale = getTimeScale || (() => 1);
    this.onActivity = onActivity || (() => {});
    this.session = new Session(world);
    this.job = null;          // aktualnie sterowane zadanie
    this.waiting = null;      // {type:'input', resolve}
    this.sleepTimer = null;
    this.histPos = null;
    this.queue = [];          // wklejone linie
    this.showPrompt();
  }

  setWorld(world) {
    this.abortAll();
    this.world = world;
    this.session = new Session(world);
    this.term.write('\n');
    this.showPrompt();
  }

  get busy() { return !!this.job; }

  showPrompt() {
    if (this.waiting?.type === 'input') return;
    if (this.job) { this.term.setPrompt('', { hidden: false }); return; }
    this.term.setPrompt(this.session.prompt());
  }

  // ------------------------------------------------------------------ wejście
  submit(line) {
    this.histPos = null;
    if (this.waiting?.type === 'input') {
      const w = this.waiting;
      this.waiting = null;
      this.term.echo(w.prompt, w.secret ? '' : line);
      w.resolve(line);
      return;
    }
    if (this.job) {
      // polecenie działa (np. -w / -f) - linie trafiają do kolejki jak w prawdziwym terminalu
      this.term.write(`${line}\n`);
      this.queue.push(line);
      return;
    }
    const prompt = this.session.prompt();
    this.term.echo(prompt, line);
    this.onActivity(line);
    const job = this.session.start(line, { onOut: (s, isErr) => this.term.write(s, isErr) });
    if (!job) { this.showPrompt(); this.drainQueue(); return; }
    if (job.done) { this.showPrompt(); this.drainQueue(); return; }
    this.run(job);
  }

  // wklejony tekst wielowierszowy: pełne linie są wykonywane po kolei, ostatni fragment zostaje w linii poleceń
  pasteLines(lines) {
    const tail = lines.pop() ?? '';
    this.queue.push(...lines);
    this.term.value = tail;
    if (!this.job && !this.waiting) this.drainQueue();
  }

  drainQueue() {
    if (this.job || this.waiting || !this.queue.length) return;
    const next = this.queue.shift();
    setTimeout(() => this.submit(next), 0);
  }

  history(dir) {
    const h = this.session.sh.history;
    if (!h.length) return;
    if (this.histPos === null) { this.histPos = h.length; this.draft = this.term.value; }
    this.histPos = Math.max(0, Math.min(h.length, this.histPos + dir));
    this.term.value = this.histPos === h.length ? this.draft || '' : h[this.histPos];
  }

  interrupt() {
    if (this.waiting?.type === 'input') {
      const w = this.waiting;
      this.waiting = null;
      this.term.echo(w.prompt, '^C');
      this.abortJob();
      return;
    }
    if (this.job) {
      this.term.write('^C\n');
      this.queue = [];
      this.abortJob();
      return;
    }
    this.session.cancelPending();
    this.term.echo(this.session.prompt(), `${this.term.value}^C`);
    this.term.value = '';
    this.showPrompt();
  }

  eof() {
    if (this.job) return;
    this.term.echo(this.session.prompt(), '');
    const r = this.session.exitFrame({ done: false, onOut: (s) => this.term.write(s) }, 0);
    if (r.type === 'resume-parent') this.run(r.job);
    else this.showPrompt();
  }

  abortJob() {
    clearTimeout(this.sleepTimer);
    const j = this.job;
    this.job = null;
    if (j) this.session.abort(j);
    this.showPrompt();
  }

  abortAll() { this.queue = []; this.waiting = null; this.abortJob(); }

  // ------------------------------------------------------------------ pętla zadania
  run(job, resume) {
    this.job = job;
    this.term.setPrompt('');
    let steps = 0;
    const loop = (res) => {
      if (this.job !== job) return;
      while (true) {
        let ef;
        try { ef = this.session.step(job, res); } catch (e) { this.term.write(`błąd symulatora: ${e.message}\n`, true); ef = { type: 'done' }; }
        res = undefined;
        if (ef.type === 'done') { this.job = null; this.showPrompt(); this.drainQueue(); return; }
        if (ef.type === 'resume-parent') { job = ef.job; this.job = job; continue; }
        if (ef.type === 'subshell-enter') {
          // zadanie nadrzędne czeka; użytkownik pracuje w nowej powłoce
          this.job = null;
          this.showPrompt();
          this.drainQueue();
          return;
        }
        if (ef.type === 'clear') { this.term.clear(); continue; }
        if (ef.type === 'busy' || ++steps % 400 === 0) { setTimeout(() => loop(), 0); return; }
        if (ef.type === 'sleep') {
          const scale = Math.max(1, this.getTimeScale());
          const ms = Math.min(ef.ms, 24 * 3600e3) / scale;
          this.sleepTimer = setTimeout(() => loop(), Math.max(10, ms));
          return;
        }
        if (ef.type === 'input') {
          this.waiting = { type: 'input', prompt: ef.prompt || '', secret: !!ef.secret, resolve: (v) => { this.term.setPrompt(''); loop(v); } };
          this.term.setPrompt(ef.prompt || '', { secret: !!ef.secret });
          if (this.queue.length) { const q = this.queue.shift(); setTimeout(() => this.submit(q), 0); }
          return;
        }
        if (ef.type === 'edit') {
          this.editor.open(ef).then((result) => loop(result));
          return;
        }
        // nieznany efekt - kontynuuj
      }
    };
    loop(resume);
  }
}
