// Testy warstwy aplikacji bez przeglądarki: Runner (sterowanie zadaniami terminala), uzupełnianie Tab, egzamin.
import assert from 'node:assert/strict';
import { newWorld } from '../src/sim/world.js';
import { Runner } from '../src/app/runner.js';
import { complete } from '../src/app/complete.js';
import { plan, score, allocate, EXAM_TASKS } from '../src/tasks/exam.js';
import { REGISTRY, DOMAINS } from '../src/tasks/index.js';

let fails = 0;
async function t(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); } catch (e) { fails++; console.log(`✗ ${name}\n   ${e.stack?.split('\n').slice(0, 4).join('\n   ')}`); }
}

class FakeTerm {
  constructor() { this.out = ''; this.prompt = ''; this.value = ''; }
  write(s) { this.out += s; }
  echo(p, c) { this.out += `${p}${c}\n`; }
  setPrompt(p) { this.prompt = p; }
  clear() { this.out = ''; }
  insert(s) { this.value += s; }
  scroll() {}
}
class FakeEditor {
  constructor(fn) { this.fn = fn; this.isOpen = false; }
  open(ef) { return Promise.resolve(this.fn(ef)); }
}
const idle = async (r, ms = 15000) => {
  const end = Date.now() + ms;
  await new Promise((res) => setTimeout(res, 5));
  while ((r.busy || r.queue.length || r.waiting) && Date.now() < end) await new Promise((res) => setTimeout(res, 5));
  assert.ok(!r.busy, 'polecenie nie zakończyło się w czasie');
};

const world = newWorld();
const term = new FakeTerm();
let edits = [];
const editor = new FakeEditor((ef) => { edits.push(ef); return ef.kubectlEdit ? { saved: true, content: ef.content.replace('replicas: 2', 'replicas: 3') } : { saved: true, content: 'hello: world\n' }; });
const r = new Runner({ world, term, editor, getTimeScale: () => 500 });
const run = async (line) => { term.out = ''; r.submit(line); await idle(r); return term.out; };

await t('runner: ssh na węzeł i prompt', async () => {
  await run('ssh cka-cp1');
  assert.match(term.prompt, /^candidate@cka-cp1:~\$ $/);
});
await t('runner: kubectl get nodes', async () => {
  const o = await run('k get nodes');
  assert.match(o, /cka-cp1\s+Ready\s+control-plane/);
});
await t('runner: vim zapisuje plik przez edytor', async () => {
  await run('vim /tmp/a.yaml');
  const o = await run('cat /tmp/a.yaml');
  assert.match(o, /hello: world/);
});
await t('runner: kubectl edit zmienia obiekt', async () => {
  await run('k create deploy web --image=nginx:1.28-alpine --replicas=2');
  const o = await run('k edit deploy web');
  assert.match(o, /deployment.apps\/web edited/);
  const g = await run("k get deploy web -o jsonpath='{.spec.replicas}'");
  assert.match(g, /^.*\n3/);
});
await t('runner: sudo -i i exit wracają do właściwych powłok', async () => {
  await run('sudo -i');
  assert.match(term.prompt, /^root@cka-cp1:~# $/);
  await run('exit');
  assert.match(term.prompt, /^candidate@cka-cp1/);
  const o = await run('exit');
  assert.match(o, /logout\nConnection to cka-cp1 closed\./);
  assert.match(term.prompt, /^candidate@base/);
});
await t('runner: wklejony heredoc wykonuje się linia po linii', async () => {
  await run('ssh cka-cp1');
  term.out = '';
  r.pasteLines(['cat <<EOF > /tmp/ns.yaml', 'apiVersion: v1', 'kind: Namespace', 'metadata:', '  name: wklejony', 'EOF', 'k apply -f /tmp/ns.yaml', '']);
  await idle(r);
  assert.match(term.out, /namespace\/wklejony created/);
});
await t('runner: Ctrl+C przerywa -w', async () => {
  term.out = '';
  r.submit('k get pods -A -w');
  await new Promise((res) => setTimeout(res, 50));
  assert.ok(r.busy);
  r.interrupt();
  assert.ok(!r.busy);
  assert.match(term.out, /\^C/);
});
await t('uzupełnianie: polecenia, ścieżki, kubectl', async () => {
  const sh = r.session.sh;
  assert.equal(complete(sh, 'systemctl rest').value, 'systemctl restart ');
  assert.equal(complete(sh, 'ls /etc/kubernetes/man').value, 'ls /etc/kubernetes/manifests/');
  assert.equal(complete(sh, 'k get po -n kube-system etcd').value, 'k get po -n kube-system etcd-cka-cp1 ');
  assert.equal(complete(sh, 'kubectl create secret ge').value, 'kubectl create secret generic ');
  assert.ok(complete(sh, 'k get no cka-').list.includes('cka-w1'));
});
await t('egzamin: przydział wg wag domen', async () => {
  const avail = Object.fromEntries(Object.keys(DOMAINS).map((d) => [d, Object.values(REGISTRY).filter((x) => x.domain === d && x.exam).length]));
  const a = allocate(EXAM_TASKS, avail);
  assert.equal(Object.values(a).reduce((x, y) => x + y, 0), EXAM_TASKS);
  assert.ok(a.troubleshooting >= a.storage);
  for (let i = 0; i < 20; i++) {
    const p = plan(EXAM_TASKS);
    assert.equal(p.length, EXAM_TASKS);
    assert.equal(new Set(p.map((x) => x.id)).size, EXAM_TASKS);
    const firstDisruptive = p.findIndex((x) => x.disruptive);
    if (firstDisruptive >= 0) assert.ok(p.slice(firstDisruptive).every((x) => x.disruptive));
  }
});
await t('egzamin: punktacja i próg', async () => {
  const p = plan(EXAM_TASKS);
  const all = Object.fromEntries(p.map((x) => [x.id, { fraction: 1 }]));
  assert.equal(score(p, all).pct, 100);
  assert.equal(score(p, {}).pct, 0);
  assert.equal(score(p, all).passed, true);
});

console.log(fails ? `\n${fails} błędów` : '\nwszystko OK');
process.exit(fails ? 1 : 0);
