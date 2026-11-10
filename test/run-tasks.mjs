// Test zadań: dla każdego zadania (i każdego wariantu awarii) wykonuje setup,
// sprawdza że przed rozwiązaniem ocena NIE jest pełna, uruchamia skrypt rozwiązania
// w symulowanym terminalu (start na hoście base), a potem wymaga 100% punktów.
import { newWorld, worldFromJSON, snapshot } from '../src/sim/world.js';
import { Session, runScriptInSession } from '../src/sim/session.js';
import { REGISTRY, TaskCtx, runSetup, runCheck, render, values, hostName } from '../src/tasks/index.js';

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const verbose = process.argv.includes('-v');
const base = snapshot(newWorld());

let failed = 0, passed = 0;
const t0 = Date.now();
for (const t of Object.values(REGISTRY)) {
  if (only.length && !only.some((o) => t.id === o || t.id.startsWith(o))) continue;
  const variants = t.variants || [null];
  for (const v of variants) {
    const label = v ? `${t.id} [${v}]` : t.id;
    const start = Date.now();
    const world = worldFromJSON(base);
    const state = { __seed: 7, ...(v ? { force_variant: v } : {}) };
    const ctx = new TaskCtx(world, state);
    let log = '';
    try {
      runSetup(ctx, t);
    } catch (e) {
      console.log(`✗ ${label}: setup: ${e.message}`);
      failed++;
      continue;
    }
    const pre = runCheck(ctx, t);
    const preFull = pre.items.every((i) => i.passed);
    const script = render((v && t.tests?.[v]) || t.test || t.solution, values(state));
    const session = new Session(world);
    log += runScriptInSession(session, `ssh ${hostName(t)}\n${script}`, { log: (l) => { log += `${l}\n`; } });
    world.cluster.advance(60000, 1000);
    const g = runCheck(new TaskCtx(world, state), t);
    const bad = g.items.filter((i) => !i.passed);
    const ms = Date.now() - start;
    if (!bad.length && !preFull) { passed++; console.log(`✓ ${label}  (${g.items.length} kryteriów, ${ms} ms)`); } else {
      failed++;
      console.log(`✗ ${label}${preFull ? '  [UWAGA: ocena pełna już przed rozwiązaniem]' : ''}`);
      for (const b of bad) console.log(`    - ${b.desc}${b.detail ? `  :: ${String(b.detail).slice(0, 300)}` : ''}`);
      if (verbose || bad.length) console.log(log.split('\n').map((l) => `      | ${l}`).slice(-80).join('\n'));
    }
  }
}
console.log(`\n${passed} OK, ${failed} błędów, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(failed ? 1 : 0);
