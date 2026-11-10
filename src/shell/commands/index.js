// Rejestr poleceń: kontenery (wg listy binariów obrazu) i hosty (węzły + base).
import { CORE } from './core.js';
import { NET } from './net.js';
import { Shell } from '../interp.js';
import { httpRequest } from '../../sim/net.js';

// polecenia dostępne tylko w kontenerach
const CONTAINER_ONLY = {
  *podcli(args, io, sh) {
    if (args[0] === 'check' && args[1] === 'http') {
      const url = args[2]?.startsWith('http') ? args[2] : `http://${args[2]}`;
      const r = httpRequest(sh.ctx.cluster, { rt: sh.ctx.rt, fs: sh.fs }, url);
      if (r.error || r.status >= 400) { io.eline(`check failed ${url}`); return 1; }
      return 0;
    }
    if (args[0] === 'check' && args[1] === 'tcp') return 0;
    io.line('podcli version 6.17.0');
    return 0;
  },
  *sh(args, io, sh) { return yield* subShell(args, io, sh); },
  *ash(args, io, sh) { return yield* subShell(args, io, sh); },
  *bash(args, io, sh) { return yield* subShell(args, io, sh); },
  *dash(args, io, sh) { return yield* subShell(args, io, sh); },
  *kill(args, io) { if (!args.length) { io.eline('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid'); return 2; } return 0; },
  *top(args, io) { io.line('Mem: 1934112K used, 2071480K free, 2400K shrd, 98500K buff, 1100440K cached\nCPU:   1% usr   1% sys   0% nic  97% idle   0% io   0% irq   0% sirq\n  PID  PPID USER     STAT   VSZ %VSZ CPU %CPU COMMAND\n    1     0 root     S     1660   0%   0   0% sh'); return 0; },
  *mount(args, io) { io.line('overlay on / type overlay (rw,relatime)\nproc on /proc type proc (rw,nosuid,nodev,noexec,relatime)\ntmpfs on /dev type tmpfs (rw,nosuid,size=65536k,mode=755)'); return 0; },
  *du(args, io) { io.line(`4\t${args.filter((a) => !a.startsWith('-'))[0] || '.'}`); return 0; },
  *dd(args, io) { io.eline('0+0 records in\n0+0 records out'); return 0; },
  *od(args, io) { io.line('0000000'); return 0; },
  *nginx(args, io, sh) {
    if (args.includes('-t')) { io.eline('nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful'); return 0; }
    if (args.includes('-v') || args.includes('-V')) { io.eline('nginx version: nginx/1.28.0'); return 0; }
    if (args[0] === '-s') { io.eline(`${new Date(sh.ctx?.cluster?.now?.() || Date.now()).toISOString().replace('T', ' ').slice(0, 19).replace(/-/g, '/')} [notice] 42#42: signal process started`); return 0; }
    io.eline('nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address in use)');
    return 1;
  },
  *apk(args, io) { io.eline('ERROR: unable to select packages: brak dostępu do internetu w symulatorze'); return 1; },
  *apt(args, io) { io.eline('E: Unable to locate package (brak dostępu do internetu w symulatorze)'); return 100; },
  *'apt-get'(args, io) { io.eline('E: Unable to locate package (brak dostępu do internetu w symulatorze)'); return 100; },
  *psql(args, io) { io.eline('psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "root" does not exist'); return 2; },
  *'redis-cli'(args, io) { io.line(args.includes('ping') || args.includes('PING') ? 'PONG' : 'OK'); return 0; },
  *mysql(args, io) { io.eline("ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: NO)"); return 1; },
};

export function* subShell(args, io, sh) {
  const child = new Shell({ ...sh.opts, fs: sh.fs, user: sh.user, cwd: sh.cwd, env: sh.env() });
  child.ctx = sh.ctx;
  child.onListen = sh.onListen;
  child.aliases = new Map(sh.aliases);
  if (args[0] === '-c') {
    const script = args[1] ?? '';
    for (let i = 2; i < args.length; i++) child.vars.set(String(i - 2), args[i]);
    return yield* child.run(script, io);
  }
  const file = args.find((a) => !a.startsWith('-'));
  if (file) {
    let src;
    try { src = sh.fs.read(sh.abs(file), sh.user); } catch (e) { io.eline(`${sh.shellName}: can't open '${file}': No such file or directory`); return 127; }
    return yield* child.run(src, io);
  }
  if (io.stdin) return yield* child.run(io.stdin, io);
  // interaktywna powłoka zagnieżdżona - przekazujemy sterowanie do sesji
  if (sh.interactive) { yield { type: 'subshell', shell: child }; return 0; }
  return 0;
}

export function containerCommands(bin = []) {
  const set = new Set(bin);
  return (name) => {
    if (!set.has(name)) return null;
    return CONTAINER_ONLY[name] || NET[name] || CORE[name] || null;
  };
}

// polecenia hosta rejestrowane przez moduły systemowe (system.js, kubectl.js)
const HOST = {};
export function registerHostCommands(map) { Object.assign(HOST, map); }
export function hostCommands(host) {
  return (name) => {
    if (name === 'sh' || name === 'bash') return CONTAINER_ONLY.bash;
    const fn = HOST[name] || NET[name] || CORE[name];
    if (!fn) return null;
    // narzędzia instalowane jako pliki - brak pliku = brak polecenia
    const need = REQUIRES_FILE[name];
    if (need && host && !host.fs.exists(need)) return null;
    return fn;
  };
}
const REQUIRES_FILE = {
  kubeadm: '/usr/bin/kubeadm', kubelet: '/usr/bin/kubelet', crictl: '/usr/bin/crictl', etcdctl: '/usr/local/bin/etcdctl', etcdutl: '/usr/local/bin/etcdutl', helm: '/usr/local/bin/helm', containerd: '/usr/local/bin/containerd', ctr: '/usr/local/bin/ctr',
};

export { CORE, NET };
