// Aplikacja: terminal + zadania + egzamin próbny, zapis stanu, zegar klastra.
import { App as CapApp } from '@capacitor/app';
import { newWorld, worldFromJSON, snapshot } from '../sim/world.js';
import { REGISTRY, DOMAINS, DOMAIN_PL, TaskCtx, TaskUnavailable, runSetup, runCheck, runCleanup, render, values, hostName } from '../tasks/index.js';
import { plan, score, weights, PASS, EXAM_TASKS, EXAM_MINUTES } from '../tasks/exam.js';
import { Terminal } from './terminal.js';
import { Editor } from './editor.js';
import { Runner } from './runner.js';
import { complete } from './complete.js';
import { reflow } from './reflow.js';
import { loadApp, saveApp, loadCluster, saveCluster } from './store.js';

const $ = (sel, el = document) => el.querySelector(sel);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

const TASKS = Object.values(REGISTRY);
const app = loadApp();
let world = null;
let baseJson = null;
let term, editor, runner;
let dirty = false;
let busyNow = false;
let sheetOpen = true;
let lastTick = performance.now();
let solutionShown = false;

// ------------------------------------------------------------------ zapis
function persist({ cluster = true } = {}) {
  if (runner) app.history = runner.session.frames[0].sh.history.slice(-300);
  saveApp(app);
  if (cluster && world) {
    if (!saveCluster(snapshot(world))) toast('Brak miejsca na zapis stanu klastra');
  }
  dirty = false;
}

// ------------------------------------------------------------------ nakładki
function busy(msg, fn) {
  return new Promise((resolve) => {
    const el = $('#busy');
    $('.busy-msg', el).textContent = msg;
    el.hidden = false;
    busyNow = true;
    setTimeout(() => {
      let r, err;
      try { r = fn(); } catch (e) { err = e; }
      el.hidden = true;
      busyNow = false;
      lastTick = performance.now();
      if (err) { console.error(err); resolve({ error: err }); } else resolve({ value: r });
    }, 40);
  });
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function modal({ title, body, actions }) {
  return new Promise((resolve) => {
    const root = $('#modal');
    root.innerHTML = '';
    const close = (v) => { root.hidden = true; root.innerHTML = ''; resolve(v); };
    const box = h('div', { class: 'modal-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' },
      h('h2', { id: 'modal-title' }, title),
      typeof body === 'string' ? h('p', {}, body) : body,
      h('div', { class: 'modal-actions' }, actions.map((a) => h('button', { type: 'button', class: `btn ${a.primary ? 'btn-primary' : a.danger ? 'btn-danger' : 'btn-quiet'}`, onclick: () => close(a.value) }, a.label))));
    root.append(box);
    root.hidden = false;
    root.onclick = (e) => { if (e.target === root) close(null); };
    root._close = () => close(null);
    box.querySelector('.btn-primary, .btn-danger, .btn')?.focus();
  });
}

// ------------------------------------------------------------------ klaster
async function fetchBase() {
  if (baseJson) return baseJson;
  try {
    const r = await fetch('base-cluster.json');
    if (r.ok) { baseJson = await r.text(); return baseJson; }
  } catch { /* */ }
  baseJson = snapshot(newWorld());
  return baseJson;
}

function seed() { return Math.floor(Math.random() * 1e9); }

async function resetCluster({ quiet = false } = {}) {
  const json = await fetchBase();
  await busy('Przywracam świeży klaster…', () => {
    world = worldFromJSON(json, seed());
    runner.setWorld(world);
    app.active = null;
    persist();
  });
  if (!quiet) { term.write('\x1b[36m[Klaster przywrócony]\x1b[0m\n'); runner.showPrompt(); }
  renderSheet();
}

function tick() {
  const now = performance.now();
  const dt = Math.min(5000, now - lastTick);
  lastTick = now;
  if (busyNow || document.hidden || !world) return;
  const ms = dt * (app.settings.timeScale || 1);
  try { world.cluster.advance(ms, 1000); } catch (e) { console.error(e); }
  dirty = true;
  updateTimer();
}

// ------------------------------------------------------------------ zadania (ćwiczenia)
function ctxFor(state) { return new TaskCtx(world, state); }

async function startTask(id) {
  const t = REGISTRY[id];
  if (app.exam && !app.exam.finished) { toast('Najpierw zakończ egzamin'); return; }
  closePanel();
  if (app.active) await endTask({ silent: true });
  const state = { __seed: seed() };
  const r = await busy('Przygotowuję zadanie…', () => runSetup(ctxFor(state), t));
  if (r.error) {
    const msg = r.error instanceof TaskUnavailable ? r.error.message : `Nie udało się przygotować zadania: ${r.error.message}`;
    await modal({ title: 'Zadanie niedostępne', body: msg, actions: [{ label: 'OK', value: true, primary: true }] });
    return;
  }
  app.active = { id, state, startedAt: Date.now(), result: null };
  solutionShown = false;
  sheetOpen = true;
  persist();
  renderSheet();
}

async function checkTask() {
  const a = app.active;
  if (!a) return;
  const t = REGISTRY[a.id];
  const r = await busy('Sprawdzam rozwiązanie…', () => runCheck(ctxFor(a.state), t));
  if (r.error) { toast(`Błąd sprawdzania: ${r.error.message}`); return; }
  const g = r.value;
  a.result = { fraction: g.fraction, items: g.items, at: Date.now() };
  const p = (app.progress[a.id] = app.progress[a.id] || { best: 0, attempts: 0 });
  p.attempts++;
  p.best = Math.max(p.best || 0, g.fraction);
  p.last = g.fraction;
  persist({ cluster: false });
  sheetOpen = true;
  renderSheet();
  $('.sheet-body')?.querySelector('.results')?.scrollIntoView({ block: 'nearest' });
}

async function endTask({ silent = false } = {}) {
  const a = app.active;
  if (!a) return;
  const t = REGISTRY[a.id];
  await busy('Sprzątam po zadaniu…', () => runCleanup(ctxFor(a.state), t));
  app.active = null;
  persist();
  if (!silent) renderSheet();
}

function randomTask() {
  const pool = TASKS.filter((t) => (app.progress[t.id]?.best || 0) < 1);
  const list = pool.length ? pool : TASKS;
  startTask(list[Math.floor(Math.random() * list.length)].id);
}

// ------------------------------------------------------------------ egzamin
async function startExam() {
  const ok = await modal({
    title: 'Egzamin próbny',
    body: `${EXAM_TASKS} zadań, ${EXAM_MINUTES} minut, próg zaliczenia ${PASS}%. Klaster zostanie przywrócony do stanu początkowego, a bieżące zadanie porzucone. Wynik zobaczysz dopiero po zakończeniu.`,
    actions: [{ label: 'Anuluj', value: false }, { label: 'Rozpocznij egzamin', value: true, primary: true }],
  });
  if (!ok) return;
  closePanel();
  await resetCluster({ quiet: true });
  const ids = plan(EXAM_TASKS).map((t) => t.id);
  app.exam = { ids, states: {}, visited: {}, flags: {}, failed: {}, startedAt: Date.now(), endsAt: Date.now() + EXAM_MINUTES * 60e3, current: 0, finished: false, results: null, score: null };
  app.active = null;
  persist();
  term.write(`\x1b[36m[Egzamin: ${ids.length} zadań, ${EXAM_MINUTES} min]\x1b[0m\n`);
  runner.showPrompt();
  await gotoQuestion(0);
}

async function gotoQuestion(i) {
  const ex = app.exam;
  if (!ex) return;
  ex.current = Math.max(0, Math.min(ex.ids.length - 1, i));
  const id = ex.ids[ex.current];
  if (!ex.visited[id] && !ex.finished) {
    const state = { __seed: seed() };
    const r = await busy(`Przygotowuję zadanie ${ex.current + 1}…`, () => runSetup(ctxFor(state), REGISTRY[id]));
    ex.visited[id] = true;
    ex.states[id] = state;
    if (r.error) ex.failed[id] = String(r.error.message || r.error);
    persist();
  }
  sheetOpen = true;
  renderSheet();
}

async function finishExam({ auto = false } = {}) {
  const ex = app.exam;
  if (!ex || ex.finished) return;
  if (!auto) {
    const left = ex.ids.filter((id) => !ex.visited[id]).length;
    const ok = await modal({
      title: 'Zakończyć egzamin?',
      body: left ? `Nie otwarto jeszcze ${left} zadań – liczą się jako 0 punktów.` : 'Po zakończeniu wszystkie zadania zostaną ocenione.',
      actions: [{ label: 'Wróć do egzaminu', value: false }, { label: 'Zakończ i oceń', value: true, primary: true }],
    });
    if (!ok) return;
  }
  const tasks = ex.ids.map((id) => REGISTRY[id]);
  const r = await busy('Oceniam zadania…', () => {
    const results = {};
    for (const t of tasks) {
      if (!ex.visited[t.id] || ex.failed[t.id]) { results[t.id] = { fraction: 0, items: [], skipped: true }; continue; }
      const g = runCheck(ctxFor(ex.states[t.id]), t);
      results[t.id] = { fraction: g.fraction, items: g.items };
    }
    return results;
  });
  ex.results = r.value || {};
  ex.score = score(tasks, ex.results);
  ex.finished = true;
  ex.finishedAt = Date.now();
  for (const t of tasks) {
    const res = ex.results[t.id];
    if (res?.skipped) continue;
    const p = (app.progress[t.id] = app.progress[t.id] || { best: 0, attempts: 0 });
    p.attempts++;
    p.best = Math.max(p.best || 0, res.fraction);
    p.last = res.fraction;
  }
  persist();
  updateTimer();
  renderSheet();
  if (auto) toast('Czas minął – egzamin oceniony');
  openPanel('results');
}

function fmtTime(ms) {
  const t = Math.floor(ms / 1000), m = Math.floor(t / 60), s = t % 60;
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function updateTimer() {
  const el = $('#timer');
  const ex = app.exam;
  if (!ex || ex.finished) {
    // ćwiczenie: stoper od rozpoczęcia zadania
    if (app.active) {
      el.hidden = false;
      el.classList.remove('low');
      el.classList.add('watch');
      el.textContent = fmtTime(Date.now() - app.active.startedAt);
      el.setAttribute('aria-label', 'Czas od rozpoczęcia zadania');
    } else el.hidden = true;
    return;
  }
  el.classList.remove('watch');
  const left = Math.max(0, ex.endsAt - Date.now());
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  el.hidden = false;
  el.textContent = `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  el.classList.toggle('low', left < 10 * 60e3);
  el.setAttribute('aria-label', `Pozostało ${m} min`);
  if (left <= 0 && !busyNow) finishExam({ auto: true });
}

// ------------------------------------------------------------------ treść zadania
const TOKEN = /[/~.]?[A-Za-z0-9][\w.:/=@-]*[\w/]|[A-Za-z0-9]/g;
function tappable(tok) { return !/^\d+$/.test(tok) && (/[-./:=@_0-9]/.test(tok) || /[a-z][A-Z]/.test(tok)); }

function taskTextNode(text) {
  const pre = h('div', { class: 'task-text' });
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (!tappable(m[0])) continue;
    if (m.index > last) pre.append(text.slice(last, m.index));
    const tok = m[0];
    pre.append(h('span', { class: 'tok', role: 'button', tabindex: '0', title: 'Wstaw do terminala', onclick: (e) => { insertToken(tok, e.currentTarget); } }, tok));
    last = m.index + tok.length;
  }
  pre.append(text.slice(last));
  return pre;
}

function insertToken(tok, el) {
  term.insert(tok);
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function resultsNode(res) {
  if (!res) return null;
  const pct = Math.round(res.fraction * 100);
  const passed = res.items.filter((i) => i.passed).length;
  return h('section', { class: 'results', 'aria-label': 'Wynik sprawdzenia' },
    h('div', { class: `results-head ${pct === 100 ? 'ok' : 'bad'}` },
      h('strong', {}, `${pct}%`), h('span', {}, `${passed} z ${res.items.length} kryteriów spełnionych`)),
    h('ul', { class: 'criteria' }, res.items.map((i) => h('li', { class: i.passed ? 'ok' : 'bad' },
      h('span', { class: 'mark', 'aria-label': i.passed ? 'spełnione' : 'niespełnione' }, i.passed ? '✓' : '✗'),
      h('span', { class: 'crit' }, i.desc, i.detail ? h('small', {}, String(i.detail).slice(0, 400)) : null)))));
}

function solutionNode(t, state) {
  const sol = render(t.solution, values(state));
  return h('section', { class: 'solution' },
    h('div', { class: 'solution-head' }, h('span', {}, `Przykładowe rozwiązanie (na ${hostName(t)})`),
      h('button', { type: 'button', class: 'btn btn-small btn-quiet', onclick: () => copy(sol) }, 'Kopiuj')),
    h('pre', {}, sol));
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Skopiowano'); } catch {
    const ta = h('textarea', {}, text); document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast('Skopiowano'); } catch { toast('Nie udało się skopiować'); }
    ta.remove();
  }
}

function hostLine(t) {
  const cmd = `ssh ${hostName(t)}`;
  return h('div', { class: 'host-line' },
    h('span', {}, 'Rozwiązuj na węźle'),
    h('button', { type: 'button', class: 'code-btn', onclick: () => { term.value = cmd; term.focus(); } }, cmd));
}

function renderSheet() {
  const sheet = $('#sheet');
  const chip = $('#taskChip');
  const ex = app.exam && !app.exam.finished ? app.exam : null;
  sheet.innerHTML = '';
  if (!ex && !app.active) {
    sheet.hidden = true;
    chip.textContent = 'Wybierz zadanie';
    chip.classList.remove('has-task');
    updateTimer();
    term?.scroll();
    return;
  }
  sheet.hidden = false;
  sheet.classList.toggle('open', sheetOpen);
  let t, state, head, body = [], actions = [];
  if (ex) {
    const id = ex.ids[ex.current];
    t = REGISTRY[id];
    state = ex.states[id] || {};
    const w = weights(ex.ids.map((x) => REGISTRY[x]));
    chip.textContent = `Egzamin, zadanie ${ex.current + 1} z ${ex.ids.length}`;
    head = [h('span', { class: 'sh-title' }, `Zadanie ${ex.current + 1}`), h('span', { class: 'sh-meta' }, `waga ${w[id]}%`)];
    body.push(h('nav', { class: 'qstrip', 'aria-label': 'Zadania egzaminu' }, ex.ids.map((qid, i) => h('button', {
      type: 'button',
      class: `q${i === ex.current ? ' cur' : ''}${ex.visited[qid] ? ' seen' : ''}${ex.flags[qid] ? ' flag' : ''}`,
      'aria-current': i === ex.current ? 'true' : null,
      'aria-label': `Zadanie ${i + 1}${ex.flags[qid] ? ', oznaczone' : ''}`,
      onclick: () => gotoQuestion(i),
    }, String(i + 1)))));
    if (ex.failed[id]) body.push(h('p', { class: 'warn' }, `Nie udało się przygotować tego zadania (${ex.failed[id]}). Przejdź do następnego – nie wpływa na wynik.`));
    body.push(hostLine(t), taskTextNode(reflow(render(t.text, values(state)))));
    actions = [
      h('button', { type: 'button', class: 'btn btn-quiet', disabled: ex.current === 0 ? true : null, onclick: () => gotoQuestion(ex.current - 1) }, 'Poprzednie'),
      h('button', { type: 'button', class: `btn btn-quiet${ex.flags[id] ? ' on' : ''}`, 'aria-pressed': ex.flags[id] ? 'true' : 'false', onclick: () => { ex.flags[id] = !ex.flags[id]; persist({ cluster: false }); renderSheet(); } }, ex.flags[id] ? 'Oznaczone' : 'Oznacz'),
      ex.current < ex.ids.length - 1
        ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => gotoQuestion(ex.current + 1) }, 'Następne')
        : h('button', { type: 'button', class: 'btn btn-primary', onclick: () => finishExam() }, 'Zakończ egzamin'),
    ];
  } else {
    const a = app.active;
    t = REGISTRY[a.id];
    state = a.state;
    chip.textContent = 'Ćwiczenie';
    head = [h('span', { class: 'sh-title' }, t.title), h('span', { class: 'sh-meta' }, `ok. ${t.minutes} min`)];
    body.push(h('p', { class: 'sh-domain' }, DOMAIN_PL[t.domain]));
    body.push(hostLine(t), taskTextNode(reflow(render(t.text, values(state)))));
    const rn = resultsNode(a.result);
    if (rn) body.push(rn);
    if (solutionShown) body.push(solutionNode(t, state));
    actions = [
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: async () => { const ok = await modal({ title: 'Zakończyć zadanie?', body: 'Obiekty utworzone przez zadanie zostaną usunięte z klastra.', actions: [{ label: 'Wróć', value: false }, { label: 'Zakończ zadanie', value: true, primary: true }] }); if (ok) endTask(); } }, 'Zakończ'),
      h('button', { type: 'button', class: `btn btn-quiet${solutionShown ? ' on' : ''}`, 'aria-pressed': solutionShown ? 'true' : 'false', onclick: () => { solutionShown = !solutionShown; renderSheet(); if (solutionShown) $('.solution')?.scrollIntoView({ block: 'start' }); } }, solutionShown ? 'Ukryj rozwiązanie' : 'Rozwiązanie'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => checkTask() }, 'Sprawdź'),
    ];
  }
  chip.classList.add('has-task');
  const header = h('button', { type: 'button', class: 'sheet-head', 'aria-expanded': sheetOpen ? 'true' : 'false', onclick: () => { sheetOpen = !sheetOpen; sheet.classList.toggle('open', sheetOpen); header.setAttribute('aria-expanded', sheetOpen ? 'true' : 'false'); term.scroll(); } },
    h('span', { class: 'grip', 'aria-hidden': 'true' }), ...head, h('span', { class: 'chev', 'aria-hidden': 'true' }));
  sheet.append(header, h('div', { class: 'sheet-body' }, body), h('div', { class: 'sheet-actions' }, actions));
  updateTimer();
  term?.scroll();
}

// ------------------------------------------------------------------ panel (menu)
function openPanel(view = 'home') {
  const p = $('#panel');
  p.innerHTML = '';
  p.append(view === 'results' ? resultsView() : view === 'help' ? helpView() : homeView());
  p.hidden = false;
  p.scrollTop = 0;
  document.activeElement?.blur?.();
  requestAnimationFrame(() => {
    p.classList.add('in');
    requestAnimationFrame(() => p.querySelectorAll('.gauge-fill').forEach((f) => { f.style.width = f.dataset.w; }));
  });
}
function closePanel() { const p = $('#panel'); p.classList.remove('in'); p.hidden = true; }

function panelHead(title, { back } = {}) {
  return h('header', { class: 'panel-head' },
    back ? h('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: back }, 'Wstecz') : h('span'),
    h('h1', {}, title),
    h('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: closePanel }, 'Terminal'));
}

function homeView() {
  const ex = app.exam;
  const inExam = ex && !ex.finished;
  const solved = TASKS.filter((t) => (app.progress[t.id]?.best || 0) >= 1).length;
  const wrap = h('div', { class: 'panel-inner' }, panelHead('CKA Symulator'));

  // egzamin
  const exSec = h('section', { class: 'p-sec exam-sec' }, h('h2', {}, 'Egzamin próbny'));
  if (inExam) {
    const left = Math.max(0, Math.round((ex.endsAt - Date.now()) / 60000));
    exSec.append(h('p', {}, `W toku: otwarte ${Object.keys(ex.visited).length} z ${ex.ids.length} zadań, zostało ${left} min.`),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { closePanel(); sheetOpen = true; renderSheet(); } }, 'Wróć do egzaminu'),
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { closePanel(); finishExam(); } }, 'Zakończ i oceń')));
  } else {
    exSec.append(h('p', {}, `${EXAM_TASKS} zadań z wagami domen jak w CKA, ${EXAM_MINUTES} minut, próg ${PASS}%. Ocena po zakończeniu.`),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: startExam }, 'Rozpocznij egzamin'),
        ex?.finished ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => openPanel('results') }, `Ostatni wynik: ${ex.score.pct}%`) : null));
  }
  wrap.append(exSec);

  // zadania
  const tSec = h('section', { class: 'p-sec' },
    h('div', { class: 'sec-head' }, h('h2', {}, 'Zadania'), h('span', { class: 'muted' }, `rozwiązane ${solved} z ${TASKS.length}`)));
  if (inExam) tSec.append(h('p', { class: 'muted' }, 'Ćwiczenia są niedostępne w trakcie egzaminu.'));
  else {
    tSec.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn btn-quiet', onclick: randomTask }, 'Losowe nierozwiązane')));
    for (const [d, [, weight]] of Object.entries(DOMAINS)) {
      const list = TASKS.filter((t) => t.domain === d);
      const grp = h('div', { class: 'dom' }, h('h3', {}, h('span', {}, DOMAIN_PL[d]), h('span', { class: 'muted' }, `${weight}% egzaminu`)));
      const ul = h('ul', { class: 'tasks' });
      for (const t of list) {
        const p = app.progress[t.id];
        const st = !p ? 'none' : p.best >= 1 ? 'done' : 'part';
        const cur = app.active?.id === t.id;
        ul.append(h('li', {}, h('button', { type: 'button', class: `task-row ${st}${cur ? ' cur' : ''}`, onclick: () => (cur ? (closePanel(), (sheetOpen = true), renderSheet()) : startTask(t.id)) },
          h('span', { class: 'st', 'aria-label': st === 'done' ? 'rozwiązane' : st === 'part' ? 'częściowo' : 'nie próbowano' }, st === 'done' ? '✓' : st === 'part' ? `${Math.round(p.best * 100)}%` : ''),
          h('span', { class: 'tt' }, t.title, cur ? h('small', {}, 'w toku') : null),
          h('span', { class: 'tm muted' }, `${t.minutes} min`))));
      }
      grp.append(ul);
      tSec.append(grp);
    }
  }
  wrap.append(tSec);

  // klaster i ustawienia
  const scales = [1, 2, 5, 10];
  const fs = app.settings.fontSize;
  wrap.append(h('section', { class: 'p-sec' }, h('h2', {}, 'Klaster i ustawienia'),
    h('div', { class: 'setting' }, h('span', {}, 'Tempo czasu w klastrze'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Tempo czasu' }, scales.map((s) => h('button', { type: 'button', class: app.settings.timeScale === s ? 'on' : '', 'aria-pressed': app.settings.timeScale === s ? 'true' : 'false', onclick: () => { app.settings.timeScale = s; persist({ cluster: false }); openPanel(); } }, `${s}×`)))),
    h('div', { class: 'setting' }, h('span', {}, 'Rozmiar czcionki terminala'),
      h('div', { class: 'seg' },
        h('button', { type: 'button', 'aria-label': 'Mniejsza', onclick: () => setFont(fs - 1) }, 'A−'),
        h('span', { class: 'seg-val' }, `${fs}px`),
        h('button', { type: 'button', 'aria-label': 'Większa', onclick: () => setFont(fs + 1) }, 'A+'))),
    h('div', { class: 'setting' }, h('span', {}, 'Zawijanie długich linii'),
      h('div', { class: 'seg' }, [['Wyłączone', false], ['Włączone', true]].map(([l, v]) => h('button', { type: 'button', class: app.settings.wrap === v ? 'on' : '', 'aria-pressed': app.settings.wrap === v ? 'true' : 'false', onclick: () => { app.settings.wrap = v; applySettings(); persist({ cluster: false }); openPanel(); } }, l)))),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn-danger', onclick: async () => { const ok = await modal({ title: 'Przywrócić klaster?', body: inExam ? 'Trwa egzamin – reset usunie Twoje zmiany w klastrze, ale nie zatrzyma zegara.' : 'Wszystkie zmiany w klastrze i plikach na węzłach zostaną utracone. Postęp w zadaniach zostaje.', actions: [{ label: 'Anuluj', value: false }, { label: 'Przywróć klaster', value: true, danger: true }] }); if (ok) { closePanel(); resetCluster(); } } }, 'Przywróć świeży klaster'),
      h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => openPanel('help') }, 'Jak to działa'))));
  return wrap;
}

function setFont(px) {
  app.settings.fontSize = Math.max(10, Math.min(20, px));
  applySettings();
  persist({ cluster: false });
  openPanel();
}

function applySettings() {
  document.documentElement.style.setProperty('--term-fs', `${app.settings.fontSize}px`);
  document.body.classList.toggle('wrap', !!app.settings.wrap);
}

function helpView() {
  const wrap = h('div', { class: 'panel-inner' }, panelHead('Jak to działa', { back: () => openPanel() }));
  wrap.append(h('section', { class: 'p-sec prose', html: `
<p>Cały klaster działa w telefonie, bez internetu: Kubernetes v1.37 zbudowany kubeadm, węzły <code>cka-cp1</code> (control plane), <code>cka-w1</code> i <code>cka-w2</code>, sieć Calico, containerd.</p>
<p>Zaczynasz na stacji <code>base</code>, tak jak w terminalu egzaminacyjnym. Na węzeł przechodzisz przez <code>ssh cka-cp1</code>, uprawnienia roota daje <code>sudo -i</code>, wracasz przez <code>exit</code>. Na węzłach działają <code>kubectl</code> (z aliasem <code>k</code>), <code>crictl</code>, <code>systemctl</code>, <code>journalctl</code>, <code>kubeadm</code>, <code>etcdctl</code>, <code>helm</code> i typowe narzędzia powłoki.</p>
<p><code>vim</code>, <code>nano</code> i <code>kubectl edit</code> otwierają edytor z numerami wierszy, automatycznym wcięciem YAML i przyciskami zapisu. Tab uzupełnia polecenia, ścieżki oraz nazwy zasobów.</p>
<p>W treści zadania stuknij nazwę, ścieżkę lub wartość, aby wstawić ją do linii poleceń – jak kopiowanie na egzaminie.</p>
<p>Czas w klastrze płynie normalnie. Jeśli czekanie na pody jest uciążliwe, przyspiesz go w ustawieniach.</p>
<p>Symulator odtwarza najczęstsze polecenia i komunikaty, ale nie wszystkie opcje. Gdy coś zachowuje się inaczej niż prawdziwy klaster, sprawdź to w dokumentacji Kubernetesa – tę samą, z której korzystasz na egzaminie.</p>` }));
  return wrap;
}

function resultsView() {
  const ex = app.exam;
  const wrap = h('div', { class: 'panel-inner' }, panelHead('Wynik egzaminu', { back: () => openPanel() }));
  if (!ex?.score) { wrap.append(h('p', { class: 'p-sec' }, 'Brak wyniku.')); return wrap; }
  const sc = ex.score;
  const pct = sc.pct;
  const ticks = h('div', { class: 'gauge-scale', 'aria-hidden': 'true' }, [0, 20, 40, 60, 80, 100].map((v) => h('span', { style: `left:${v}%` }, String(v))));
  wrap.append(h('section', { class: `gauge ${sc.passed ? 'pass' : 'fail'}`, 'aria-label': `Wynik ${pct} procent, ${sc.passed ? 'zdany' : 'niezdany'}` },
    h('div', { class: 'gauge-num' }, String(pct).replace('.', ','), h('span', {}, '%')),
    h('div', { class: 'gauge-verdict' }, sc.passed ? 'Zdany' : `Niezdany, do progu brakuje ${String(Math.round((PASS - pct) * 10) / 10).replace('.', ',')} p.p.`),
    h('div', { class: 'gauge-track' },
      h('div', { class: 'gauge-fill', 'data-w': `${Math.min(100, pct)}%` }),
      h('div', { class: 'gauge-mark', style: `left:${PASS}%` }, h('span', {}, `próg ${PASS}%`))),
    ticks));
  const dom = h('section', { class: 'p-sec' }, h('h2', {}, 'Domeny'));
  for (const d of Object.keys(DOMAINS).filter((x) => sc.perDomain[x])) {
    const v = sc.perDomain[d];
    const p = v.max ? Math.round((v.got / v.max) * 100) : 0;
    dom.append(h('div', { class: 'dbar' }, h('div', { class: 'dbar-l' }, h('span', {}, DOMAIN_PL[d]), h('span', { class: 'muted' }, `${p}%`)),
      h('div', { class: 'dbar-t' }, h('i', { style: `width:${p}%` }))));
  }
  wrap.append(dom);
  const list = h('section', { class: 'p-sec' }, h('h2', {}, 'Zadania'));
  ex.ids.forEach((id, i) => {
    const t = REGISTRY[id];
    const r = ex.results[id] || { fraction: 0, items: [] };
    const p = Math.round(r.fraction * 100);
    const det = h('details', { class: 'ex-task' },
      h('summary', {}, h('span', { class: 'n' }, String(i + 1)), h('span', { class: 'tt' }, t.title), h('span', { class: `pc ${p === 100 ? 'ok' : p === 0 ? 'bad' : 'mid'}` }, r.skipped ? 'pominięte' : `${p}%`)),
      r.items.length ? resultsNode(r) : h('p', { class: 'muted' }, 'Zadanie nie zostało otwarte.'),
      solutionNode(t, ex.states[id] || {}));
    list.append(det);
  });
  wrap.append(list);
  wrap.append(h('div', { class: 'p-sec row' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: closePanel }, 'Wróć do terminala')));
  return wrap;
}

// ------------------------------------------------------------------ klawisze pomocnicze
const KEYS = [
  ['Tab', 'tab'], ['↑', 'up'], ['↓', 'down'], ['^C', 'ctrlc'], ['|', '|'], ['-', '-'], ['/', '/'], ['~', '~'], ['>', '>'], ['$', '$'], ['"', '"'], ["'", "'"],
  ['=', '='], ['*', '*'], ['&&', ' && '], ['{', '{'], ['}', '}'], ['←', 'left'], ['→', 'right'], ['^L', 'ctrll'], ['^D', 'ctrld'],
  [null], ['k', 'k '], ['-n', '-n '], ['-A', '-A '], ['-o yaml', '-o yaml '], ['--dry-run', '--dry-run=client -o yaml '], ['sudo -i', 'sudo -i'],
];

function buildKeys() {
  const row = $('#keys');
  for (const [label, act] of KEYS) {
    if (!label) { row.append(h('span', { class: 'key-gap', 'aria-hidden': 'true' })); continue; }
    const b = h('button', { type: 'button', class: `key${act.length > 3 && !['tab', 'up', 'down', 'left', 'right', 'ctrlc', 'ctrll', 'ctrld'].includes(act) ? ' snip' : ''}` }, label);
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => keyAction(act));
    row.append(b);
  }
}

function keyAction(act) {
  if (editor.isOpen) return;
  switch (act) {
    case 'tab': doComplete(); break;
    case 'up': runner.history(-1); break;
    case 'down': runner.history(1); break;
    case 'ctrlc': runner.interrupt(); break;
    case 'ctrll': term.clear(); runner.showPrompt(); break;
    case 'ctrld': if (!term.value) runner.eof(); break;
    case 'left': case 'right': {
      const el = term.input;
      const p = Math.max(0, Math.min(el.value.length, (el.selectionStart ?? 0) + (act === 'left' ? -1 : 1)));
      el.setSelectionRange(p, p);
      el.focus({ preventScroll: true });
      break;
    }
    default: term.insert(act);
  }
}

let lastTab = { value: null, at: 0 };
function doComplete() {
  if (runner.busy || runner.waiting) return;
  const el = term.input;
  const r = complete(runner.session.sh, el.value, el.selectionStart ?? el.value.length);
  if (r.list) {
    const now = Date.now();
    // jak w bashu: lista dopiero przy drugim Tab
    if (lastTab.value === el.value && now - lastTab.at < 4000) {
      term.echo(runner.session.prompt(), el.value);
      term.columns(r.list.length > 120 ? [...r.list.slice(0, 120), `… (${r.list.length - 120} więcej)`] : r.list);
      lastTab = { value: null, at: 0 };
    } else lastTab = { value: el.value, at: now };
  } else lastTab = { value: null, at: 0 };
  if (r.value !== el.value) { el.value = r.value; el.setSelectionRange(r.cursor, r.cursor); }
  el.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ Android: przycisk wstecz, rozmiar okna
function onBack() {
  if (editor.isOpen) { editor.back(); return; }
  const m = $('#modal');
  if (!m.hidden) { m._close?.(); return; }
  const p = $('#panel');
  if (!p.hidden) { closePanel(); return; }
  if (sheetOpen && !$('#sheet').hidden) { sheetOpen = false; renderSheet(); return; }
  persist();
  CapApp.minimizeApp?.().catch?.(() => {});
}

let fullHeight = 0;
function fitViewport() {
  const vv = window.visualViewport;
  const hgt = vv ? vv.height : window.innerHeight;
  fullHeight = Math.max(fullHeight, hgt);
  document.documentElement.style.setProperty('--vh', `${Math.round(hgt)}px`);
  const kb = hgt < fullHeight * 0.75;
  const was = document.body.classList.contains('kb');
  document.body.classList.toggle('kb', kb);
  // klawiatura zajmuje pół ekranu - przy pisaniu w terminalu zwijamy treść zadania
  if (kb && !was && term && document.activeElement === term.input && sheetOpen && !$('#sheet').hidden) { sheetOpen = false; renderSheet(); }
  term?.scroll();
}

// ------------------------------------------------------------------ start
async function boot() {
  applySettings();
  fitViewport();
  window.visualViewport?.addEventListener('resize', fitViewport);
  window.addEventListener('resize', fitViewport);
  $('#busy').hidden = false;
  $('.busy-msg').textContent = 'Uruchamiam klaster…';
  let json = loadCluster();
  try {
    if (!json) json = await fetchBase();
    world = worldFromJSON(json, seed());
  } catch (e) {
    console.error(e);
    json = await fetchBase();
    world = worldFromJSON(json, seed());
    app.active = null;
  }
  term = new Terminal($('#term'), {
    onSubmit: (v) => runner.submit(v),
    onTab: () => doComplete(),
    onInterrupt: () => runner.interrupt(),
    onEof: () => runner.eof(),
    onHistory: (d) => runner.history(d),
    onPasteLines: (lines) => runner.pasteLines(lines),
  });
  editor = new Editor($('#editor'));
  // terminal zmienia wysokość (arkusz zadania, klawiatura) - trzymamy widok przy ostatniej linii
  if (window.ResizeObserver) new ResizeObserver(() => term.scroll()).observe($('#term'));
  if (!app.welcomed) {
    term.write('\x1b[36mSymulowany klaster Kubernetes v1.37\n'
      + 'węzły: cka-cp1, cka-w1, cka-w2\n'
      + 'Jesteś na stacji base.\n'
      + '  na węzeł:  ssh cka-cp1\n'
      + '  root:      sudo -i\n'
      + '  powrót:    exit\n'
      + 'Zadania i egzamin: przycisk Menu.\x1b[0m\n\n');
    app.welcomed = true;
  }
  runner = new Runner({ world, term, editor, getTimeScale: () => app.settings.timeScale || 1, onActivity: () => { dirty = true; } });
  runner.session.frames[0].sh.history.push(...(app.history || []));
  buildKeys();
  $('#busy').hidden = true;
  $('#menuBtn').addEventListener('click', () => openPanel());
  $('#taskChip').addEventListener('click', () => {
    if (app.active || (app.exam && !app.exam.finished)) { sheetOpen = !sheetOpen; renderSheet(); } else openPanel();
  });
  renderSheet();
  updateTimer();
  lastTick = performance.now();
  setInterval(tick, 1000);
  setInterval(() => { if (dirty && !busyNow) persist(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) persist(); else lastTick = performance.now(); });
  window.addEventListener('pagehide', () => persist());
  try { CapApp.addListener('backButton', onBack); CapApp.addListener('pause', () => persist()); } catch { /* przeglądarka */ }
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') onBack(); });
  if (app.exam && !app.exam.finished && !app.exam.visited[app.exam.ids[app.exam.current]]) gotoQuestion(app.exam.current);
  persist();
}

window.__cka = { get world() { return world; }, get runner() { return runner; }, app };
boot();
