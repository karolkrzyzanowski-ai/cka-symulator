// Egzamin próbny: dobór zadań wg wag domen, wagi punktowe, próg 66%.
import { DOMAINS, REGISTRY } from './registry.js';

export const PASS = 66;
export const EXAM_TASKS = 17;
export const EXAM_MINUTES = 120;

export function allocate(count, available) {
  const raw = Object.fromEntries(Object.entries(DOMAINS).map(([d, [, w]]) => [d, (count * w) / 100]));
  const alloc = Object.fromEntries(Object.keys(DOMAINS).map((d) => [d, Math.min(Math.floor(raw[d]), available[d] || 0)]));
  const rest = Object.keys(DOMAINS).sort((a, b) => (raw[b] - Math.floor(raw[b])) - (raw[a] - Math.floor(raw[a])));
  const sum = () => Object.values(alloc).reduce((a, b) => a + b, 0);
  while (sum() < count) {
    let progressed = false;
    for (const d of rest) {
      if (sum() >= count) break;
      if (alloc[d] < (available[d] || 0)) { alloc[d]++; progressed = true; }
    }
    if (!progressed) break;
  }
  return alloc;
}

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function plan(count = EXAM_TASKS, rng = Math.random, exclude = []) {
  const pool = Object.values(REGISTRY).filter((t) => t.exam && !exclude.includes(t.id));
  const byDom = Object.fromEntries(Object.keys(DOMAINS).map((d) => [d, pool.filter((t) => t.domain === d)]));
  const alloc = allocate(count, Object.fromEntries(Object.entries(byDom).map(([d, v]) => [d, v.length])));
  const chosen = [];
  const groups = new Set();
  for (const d of Object.keys(DOMAINS)) {
    for (const t of shuffle(byDom[d], rng)) {
      if (chosen.filter((x) => x.domain === d).length >= alloc[d]) break;
      if (t.conflicts.some((g) => groups.has(g))) continue;
      chosen.push(t);
      t.conflicts.forEach((g) => groups.add(g));
    }
  }
  // kolejność jak na egzaminie: wymieszana, zadania psujące klaster na końcu
  const mixed = shuffle(chosen, rng);
  return [...mixed.filter((t) => !t.disruptive), ...mixed.filter((t) => t.disruptive)];
}

export function weights(tasks) {
  const per = {};
  for (const t of tasks) per[t.domain] = (per[t.domain] || 0) + 1;
  const totalW = Object.keys(per).reduce((a, d) => a + DOMAINS[d][1], 0) || 1;
  return Object.fromEntries(tasks.map((t) => [t.id, Math.round(((DOMAINS[t.domain][1] * 100) / totalW / per[t.domain]) * 10) / 10]));
}

// wynik: suma (waga * ułamek zdobytych punktów)
export function score(tasks, results) {
  const w = weights(tasks);
  let total = 0, max = 0;
  const perDomain = {};
  for (const t of tasks) {
    const frac = results[t.id]?.fraction ?? 0;
    total += w[t.id] * frac;
    max += w[t.id];
    const d = (perDomain[t.domain] = perDomain[t.domain] || { got: 0, max: 0 });
    d.got += w[t.id] * frac;
    d.max += w[t.id];
  }
  const pct = max ? (total / max) * 100 : 0;
  return { pct: Math.round(pct * 10) / 10, passed: pct >= PASS, perDomain, weights: w };
}
