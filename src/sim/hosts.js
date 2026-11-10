// Hosty (węzły VM i "base"): system plików, jednostki systemd, pakiety, dziennik.
import { VFS } from '../shell/vfs.js';
import { hashStr } from '../lib/util.js';

export class Host {
  constructor(name, ip, role) {
    this.name = name;
    this.ip = ip;
    this.role = role; // control-plane | worker | base
    this.fs = new VFS();
    this.units = {};
    this.packages = {};
    this.holds = [];
    this.apt = { updated: false };
    this.kernel = { modules: ['overlay', 'br_netfilter', 'nf_conntrack', 'ip_tables'], sysctl: { 'net.ipv4.ip_forward': '1', 'net.bridge.bridge-nf-call-iptables': '1', 'net.bridge.bridge-nf-call-ip6tables': '1' } };
    this.journal = {};
    this.bootTime = 0;
    this.cpu = 2;
    this.memMi = 4096;
  }

  toJSON() {
    return { ...this, fs: this.fs.toJSON() };
  }

  static from(j) {
    const h = new Host(j.name, j.ip, j.role);
    Object.assign(h, { ...j, fs: new VFS(j.fs) });
    return h;
  }

  log(unit, clock, msg) {
    const j = (this.journal[unit] = this.journal[unit] || []);
    j.push([clock, msg]);
    if (j.length > 400) j.splice(0, j.length - 400);
  }

  // ---------------------------------------------------------------- systemd
  unitPaths(unit) {
    const base = [`/etc/systemd/system/${unit}.service`, `/usr/lib/systemd/system/${unit}.service`, `/lib/systemd/system/${unit}.service`, `/usr/local/lib/systemd/system/${unit}.service`]
      .find((p) => this.fs.isFile(p));
    const drop = {};
    for (const dir of [`/usr/lib/systemd/system/${unit}.service.d`, `/lib/systemd/system/${unit}.service.d`, `/etc/systemd/system/${unit}.service.d`]) {
      if (!this.fs.isDir(dir)) continue;
      for (const f of this.fs.list(dir)) if (f.endsWith('.conf')) drop[f] = `${dir}/${f}`;
    }
    const dropins = Object.keys(drop).sort().map((k) => drop[k]);
    return { base, dropins };
  }

  unitHash(unit) {
    const { base, dropins } = this.unitPaths(unit);
    return String(hashStr([base, ...dropins].map((p) => (p ? p + this.fs.tryRead(p) : '')).join('\n')));
  }

  // parsuje jednostkę: ExecStart, Environment, EnvironmentFile
  parseUnit(unit) {
    const { base, dropins } = this.unitPaths(unit);
    const res = { execStart: null, env: {}, envFiles: [], base, dropins, restart: null };
    for (const p of [base, ...dropins]) {
      if (!p) continue;
      const text = this.fs.tryRead(p) || '';
      let section = '';
      const lines = text.replace(/\\\n/g, ' ').split('\n');
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        const sec = line.match(/^\[(\w+)\]$/);
        if (sec) { section = sec[1]; continue; }
        if (section !== 'Service') continue;
        const kv = line.match(/^(\w+)=(.*)$/);
        if (!kv) continue;
        const [, k, v] = kv;
        if (k === 'ExecStart') res.execStart = v.trim() === '' ? null : v.trim();
        else if (k === 'Environment') {
          for (const m of v.matchAll(/"([^"=]+)=([^"]*)"|([^\s"=]+)=(\S*)/g)) res.env[m[1] || m[3]] = m[2] ?? m[4];
        } else if (k === 'EnvironmentFile') res.envFiles.push(v.trim());
        else if (k === 'Restart') res.restart = v.trim();
      }
    }
    // pliki środowiska (- = opcjonalny)
    for (let ef of res.envFiles) {
      const optional = ef.startsWith('-');
      if (optional) ef = ef.slice(1);
      const text = this.fs.tryRead(ef);
      if (text === null) { if (!optional) res.missingEnvFile = ef; continue; }
      for (const l of text.split('\n')) {
        const m = l.trim().match(/^([A-Za-z_]\w*)=(.*)$/);
        if (m) res.env[m[1]] = m[2].replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1');
      }
    }
    return res;
  }

  unit(name) {
    if (!this.units[name]) this.units[name] = { enabled: false, state: 'inactive', since: 0, loadedHash: this.unitHash(name) };
    return this.units[name];
  }

  // rozwija zmienne w ExecStart i dzieli na argv
  expandExec(parsed) {
    if (!parsed.execStart) return null;
    const s = parsed.execStart.replace(/\$\{?(\w+)\}?/g, (_, k) => parsed.env[k] ?? '');
    return s.split(/\s+/).filter(Boolean);
  }
}

export function sockPath(endpoint) {
  return String(endpoint || '').replace(/^unix:\/\//, '').replace(/^\/var\/run\//, '/run/');
}
