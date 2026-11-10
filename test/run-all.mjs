// Uruchamia wszystkie testy (używane lokalnie i w GitHub Actions).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
let failed = false;
for (const f of ['app.mjs', 'run-tasks.mjs']) {
  console.log(`\n=== ${f}`);
  const r = spawnSync(process.execPath, [join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
