// Tworzenie powłok hostów (base, węzły) i prompt.
import { Shell } from './interp.js';
import { hostCommands } from './commands/index.js';
import './commands/system.js';

export function hostEnv(host, user) {
  const home = user === 'root' ? '/root' : `/home/${user}`;
  return {
    HOME: home, USER: user, LOGNAME: user, SHELL: '/bin/bash', TERM: 'xterm-256color', LANG: 'C.UTF-8',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin', HOSTNAME: host.name, EDITOR: 'vim',
  };
}

export function makeHostShell(world, host, user = 'candidate', { cwd, login = true, manifests } = {}) {
  const c = world.cluster || world;
  const sh = new Shell({
    fs: host.fs, user, cwd: cwd || (user === 'root' ? '/root' : `/home/${user}`), env: hostEnv(host, user), mode: 'host',
    commands: hostCommands(host), interactive: true, host, clock: () => c.now(),
    processes: () => hostProcesses(c, host),
  });
  sh.ctx = { cluster: c, host, world, manifests: manifests || world.manifests };
  sh.vars.set('PS1', user === 'root' ? '\\u@\\h:\\w# ' : '\\u@\\h:\\w\\$ ');
  if (login) sourceRc(sh);
  return sh;
}

// wczytuje ~/.bashrc (aliasy, zmienne) bez efektów ubocznych
export function sourceRc(sh) {
  const rc = sh.fs.tryRead(`${sh.home}/.bashrc`);
  if (!rc) return;
  const safe = rc.split('\n').filter((l) => !/<\(|^\s*complete\b|^\s*source\s|^\s*\.\s/.test(l)).join('\n');
  const g = sh.run(safe, { out() {}, err() {}, line() {}, eline() {}, stdin: null });
  try { let r = g.next(); let n = 0; while (!r.done && n++ < 200) r = g.next(); } catch { /* */ }
}

export function promptString(sh) {
  const ps1 = sh.vars.get('PS1') || '$ ';
  const host = (sh.fs.tryRead('/etc/hostname') || sh.vars.get('HOSTNAME') || 'localhost').trim();
  const home = sh.home;
  const cwd = sh.cwd === home ? '~' : sh.cwd.startsWith(home + '/') ? '~' + sh.cwd.slice(home.length) : sh.cwd;
  return ps1
    .replace(/\\\[|\\\]/g, '')
    .replace(/\\u/g, sh.user)
    .replace(/\\h/g, host.split('.')[0])
    .replace(/\\H/g, host)
    .replace(/\\w/g, cwd)
    .replace(/\\W/g, cwd === '~' ? '~' : cwd.split('/').pop() || '/')
    .replace(/\\\$/g, sh.user === 'root' ? '#' : '$')
    .replace(/\\n/g, '\n');
}

export function hostProcesses(c, h) {
  const out = [{ pid: 1, user: 'root', cmd: '/sbin/init' }, { pid: 512, user: 'root', cmd: 'sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups' }];
  if (h.role === 'base') return out;
  const cd = h.unit('containerd');
  if (cd.state === 'active') out.push({ pid: cd.pid || 812, user: 'root', cmd: '/usr/local/bin/containerd', cpu: '0.6', mem: '1.1' });
  const kl = h.unit('kubelet');
  if (kl.state === 'active') {
    const argv = h.expandExec(kl.loaded || h.parseUnit('kubelet')) || ['/usr/bin/kubelet'];
    out.push({ pid: kl.pid || 2481, user: 'root', cmd: argv.join(' '), cpu: '1.8', mem: '2.4' });
  }
  let pid = 3000;
  for (const rt of Object.values(c.runtime)) {
    if (rt.node !== h.name) continue;
    for (const crt of rt.main) {
      if (crt.state !== 'running') continue;
      const spec = rt.spec.containers.find((x) => x.name === crt.name) || {};
      const argv = [...(spec.command || []), ...(spec.args || [])];
      out.push({ pid: pid++, user: 'root', cmd: argv.length ? argv.join(' ') : crt.server || crt.kind || crt.name, cpu: '0.1', mem: '0.5' });
    }
  }
  return out;
}
