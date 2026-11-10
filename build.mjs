// Budowanie aplikacji webowej do www/ (używanej przez Capacitor):
//  - bundle JS (esbuild), HTML, CSS, czcionki offline
//  - base-cluster.json: gotowa migawka świeżego klastra (szybki start w telefonie)
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newWorld, snapshot } from './src/sim/world.js';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'www');
const dev = process.argv.includes('--dev');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'fonts'), { recursive: true });

await build({
  entryPoints: [join(root, 'src/app/main.js')],
  bundle: true,
  format: 'esm',
  target: ['chrome100'],
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  outfile: join(out, 'app.js'),
  logLevel: 'warning',
});

copyFileSync(join(root, 'src/app/index.html'), join(out, 'index.html'));
copyFileSync(join(root, 'src/app/style.css'), join(out, 'style.css'));

const fonts = [
  ['@fontsource/jetbrains-mono', /^jetbrains-mono-latin(-ext)?-(400|700)-normal\.woff2$/],
  ['@fontsource/ibm-plex-sans', /^ibm-plex-sans-latin(-ext)?-(400|500|600)-normal\.woff2$/],
];
for (const [pkg, re] of fonts) {
  const dir = join(root, 'node_modules', pkg, 'files');
  for (const f of readdirSync(dir)) if (re.test(f)) copyFileSync(join(dir, f), join(out, 'fonts', f));
}

const t0 = Date.now();
const json = snapshot(newWorld());
writeFileSync(join(out, 'base-cluster.json'), json);
console.log(`www/ gotowe (migawka klastra ${(json.length / 1024).toFixed(0)} KB w ${Date.now() - t0} ms)`);
