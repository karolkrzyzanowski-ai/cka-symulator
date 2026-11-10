// Sesja terminala: stos powłok (base -> ssh węzeł -> sudo -i -> kubectl exec ...),
// sterowanie generatorami poleceń i obsługa efektów.
import { makeHostShell, promptString } from '../shell/hostshell.js';
import { IO, ExitSignal } from '../shell/interp.js';
import { isComplete } from '../shell/parser.js';

export class Session {
  // world: { cluster, manifests }
  constructor(world, { hostName = 'base', user = 'candidate' } = {}) {
    this.world = world;
    this.frames = [];
    const h = world.cluster.hosts[hostName];
    this.frames.push({ sh: makeHostShell(world, h, user), kind: 'login', job: null });
    this.job = null;
    this.pending = '';
  }

  get c() { return this.world.cluster; }
  get top() { return this.frames[this.frames.length - 1]; }
  get sh() { return this.top.sh; }

  prompt() {
    if (this.pending) return '> ';
    const sh = this.sh;
    if (sh.mode === 'container') {
      const ps1 = sh.vars.get('PS1') || '\\w # ';
      const cwd = sh.cwd;
      return ps1.replace(/\\w/g, cwd).replace(/\\\$/g, '#').replace(/\\u/g, 'root').replace(/\\h/g, (sh.vars.get('HOSTNAME') || 'pod'));
    }
    return promptString(sh);
  }

  // rozpoczyna wykonanie linii; zwraca obiekt zadania lub null (linia niepełna)
  start(line, { onOut } = {}) {
    const src = this.pending ? `${this.pending}\n${line}` : line;
    if (!isComplete(src)) { this.pending = src; return null; }
    this.pending = '';
    if (!src.trim()) return { done: true, empty: true };
    const sh = this.sh;
    sh.history.push(src);
    const io = new IO(null);
    io.sink = (s) => onOut?.(s, false);
    io.errSink = (s) => onOut?.(s, true);
    const frame = this.top;
    const gen = sh.run(src, io);
    const job = { gen, io, frame, done: false, resume: undefined, onOut };
    this.job = job;
    return job;
  }

  cancelPending() { this.pending = ''; }

  // jeden krok zadania: zwraca efekt do obsłużenia przez UI lub {type:'done'}
  step(job, resume) {
    let r;
    try {
      r = job.gen.next(resume);
    } catch (e) {
      if (e instanceof ExitSignal) return this.exitFrame(job, e.code);
      job.done = true;
      job.onOut?.(`bash: błąd wewnętrzny symulatora: ${e.message}\n`, true);
      if (typeof process !== 'undefined' && process.env?.SIM_DEBUG) console.error(e); // eslint-disable-line no-console
      return { type: 'done', code: 1 };
    }
    if (r.done) {
      job.done = true;
      if (job.parentJob) {
        // zakończył się skrypt w powłoce zagnieżdżonej - nic
      }
      return { type: 'done', code: r.value ?? 0 };
    }
    const ef = r.value || {};
    if (ef.type === 'subshell') {
      // powłoka interaktywna: odkładamy bieżące zadanie
      const fr = { sh: ef.shell, kind: ef.kind || 'sub', exitMsg: ef.exitMsg, parentJob: job };
      ef.shell.interactive = true;
      this.frames.push(fr);
      return { type: 'subshell-enter', frame: fr };
    }
    return ef;
  }

  // wyjście z bieżącej ramki (exit / logout / Ctrl+D)
  exitFrame(job, code = 0) {
    if (job) job.done = true;
    if (this.frames.length === 1) {
      // powłoka logowania: tworzymy nową (jak nowa karta terminala)
      const f = this.frames[0];
      job?.onOut?.('logout\n', false);
      const h = f.sh.ctx.host;
      this.frames[0] = { sh: makeHostShell(this.world, h, f.sh.user), kind: 'login' };
      return { type: 'done', code };
    }
    const fr = this.frames.pop();
    if (fr.exitMsg) job?.onOut?.(`${fr.exitMsg}\n`, false);
    else if (fr.kind === 'sudo' || fr.kind === 'ssh') job?.onOut?.('logout\n', false);
    if (fr.parentJob && !fr.parentJob.done) return { type: 'resume-parent', job: fr.parentJob };
    return { type: 'done', code };
  }

  abort(job) {
    if (!job || job.done) return;
    try { job.gen.return(130); } catch { /* */ }
    job.done = true;
  }
}

// ------------------------------------------------------------------ tryb wsadowy (testy, setupy)
// Uruchamia skrypt w sesji (linia po linii jak w terminalu). Czas symulacji jest przewijany.
export function runScriptInSession(session, script, { input = [], editor = null, maxSimMs = 30 * 60e3, onOut = null, log = null } = {}) {
  const c = session.c;
  let out = '';
  const sink = (s, isErr) => { out += s; onOut?.(s, isErr); };
  const lines = script.split('\n');
  let li = 0;
  const startClock = c.now();
  const runJob = (job) => {
    let resume;
    let steps = 0;
    let followBudget = 0;
    while (true) {
      if (++steps > 200000) { sink('\n[symulator: przerwano - zbyt wiele kroków]\n', true); session.abort(job); return; }
      const ef = session.step(job, resume);
      resume = undefined;
      if (ef.type === 'done') return;
      if (ef.type === 'resume-parent') return;
      if (ef.type === 'sleep') {
        const ms = Math.min(ef.ms, 3600e3);
        if (ef.follow || ms >= 3600e3) { followBudget++; if (followBudget > 3) { session.abort(job); sink('^C\n', false); return; } }
        c.advance(Math.min(ms, 600e3), 1000);
        if (c.now() - startClock > maxSimMs) { session.abort(job); sink('^C\n', false); return; }
        continue;
      }
      if (ef.type === 'input') { resume = input.length ? input.shift() : null; if (resume !== null) sink(`${resume}\n`, false); continue; }
      if (ef.type === 'edit') {
        if (editor) { const r = editor(ef.content, ef); resume = r == null ? { saved: false } : { saved: true, content: r }; } else resume = { saved: false };
        continue;
      }
      if (ef.type === 'subshell-enter') {
        // kolejne linie skryptu trafiają do powłoki zagnieżdżonej, aż do exit
        while (li < lines.length && session.frames.includes(ef.frame)) {
          const j = session.start(lines[li++], { onOut: sink });
          if (j && !j.done) runJob(j);
        }
        if (session.frames.includes(ef.frame)) {
          // koniec skryptu w środku powłoki - zamknij ją
          const r = session.exitFrame(null, 0);
          if (r.type === 'resume-parent') continue;
          return;
        }
        // ramka zamknięta przez exit - wróć do zadania nadrzędnego
        if (job.done) return;
        continue;
      }
      if (ef.type === 'clear') continue;
    }
  };
  while (li < lines.length) {
    const line = lines[li++];
    if (log) log(`${session.prompt()}${line}`);
    const job = session.start(line, { onOut: sink });
    if (!job || job.done) continue;
    runJob(job);
  }
  return out;
}
