// Wirtualny system plików (węzły, kontenery). Serializowalny do JSON.
import { normPath, dirname, basename, globToRegex } from '../lib/util.js';

export class FsError extends Error {
  constructor(code, path) {
    const msg = { ENOENT: 'No such file or directory', EACCES: 'Permission denied', EISDIR: 'Is a directory', ENOTDIR: 'Not a directory', EEXIST: 'File exists', ENOTEMPTY: 'Directory not empty', EROFS: 'Read-only file system' }[code] || code;
    super(`${path}: ${msg}`);
    this.code = code;
    this.path = path;
    this.reason = msg;
  }
}

const mkdirNode = (owner = 'root', mode = 0o755) => ({ t: 'd', c: {}, owner, mode });

export class VFS {
  constructor(data) {
    this.root = data || mkdirNode();
    this.readOnly = []; // prefiksy tylko do odczytu (np. wolumeny configMap)
    this.mounts = null; // dla kontenerów: [{path, fs, sub, ro}]
  }

  toJSON() { return this.root; }

  _walk(path, { create = false, owner = 'root' } = {}) {
    const p = normPath(path);
    if (p === '/') return { node: this.root, parent: null, name: '' };
    const parts = p.slice(1).split('/');
    let cur = this.root, parent = null;
    for (let i = 0; i < parts.length; i++) {
      if (cur.t !== 'd') throw new FsError('ENOTDIR', p);
      parent = cur;
      let next = cur.c[parts[i]];
      if (!next && create && i < parts.length - 1) {
        next = cur.c[parts[i]] = mkdirNode(owner);
      }
      if (!next) return { node: null, parent: i === parts.length - 1 ? cur : null, name: parts[i] };
      cur = next;
    }
    return { node: cur, parent, name: parts[parts.length - 1] };
  }

  // --------------------------------------------------------------- montowania (kontenery)
  _mount(path) {
    if (!this.mounts) return null;
    const p = normPath(path);
    let best = null;
    for (const m of this.mounts) {
      if (p === m.path || p.startsWith(m.path === '/' ? '/' : m.path + '/')) {
        if (!best || m.path.length > best.path.length) best = m;
      }
    }
    if (!best) return null;
    const rel = p.slice(best.path.length) || '';
    return { m: best, inner: normPath((best.sub || '/') + '/' + rel) };
  }

  _route(path, write = false) {
    const r = this._mount(path);
    if (r) {
      if (write && r.m.ro) throw new FsError('EROFS', path);
      return { fs: r.m.fs, path: r.inner, mounted: true };
    }
    return { fs: this, path: normPath(path), mounted: false };
  }

  // --------------------------------------------------------------- uprawnienia
  canRead(node, user) {
    if (user === 'root' || !node) return true;
    if (node.owner === user) return true;
    return (node.mode & 0o004) !== 0;
  }

  canWrite(node, user) {
    if (user === 'root' || !node) return true;
    if (node.owner === user) return (node.mode & 0o200) !== 0;
    return (node.mode & 0o002) !== 0;
  }

  // --------------------------------------------------------------- API
  exists(path) {
    const r = this._route(path);
    if (r.mounted) return r.fs.exists(r.path);
    try { return !!this._walk(path).node; } catch { return false; }
  }

  isDir(path) {
    const r = this._route(path);
    if (r.mounted) return r.fs.isDir(r.path);
    try { return this._walk(path).node?.t === 'd'; } catch { return false; }
  }

  isFile(path) {
    const r = this._route(path);
    if (r.mounted) return r.fs.isFile(r.path);
    try { return this._walk(path).node?.t === 'f'; } catch { return false; }
  }

  stat(path) {
    const r = this._route(path);
    if (r.mounted) return r.fs.stat(r.path);
    const { node } = this._walk(path);
    if (!node) throw new FsError('ENOENT', path);
    return { type: node.t === 'd' ? 'dir' : 'file', size: node.t === 'f' ? node.data.length : 4096, mode: node.mode, owner: node.owner, mtime: node.mtime || 0 };
  }

  read(path, user = 'root') {
    const r = this._route(path);
    if (r.mounted) return r.fs.read(r.path, 'root');
    const { node } = this._walk(path);
    if (!node) throw new FsError('ENOENT', path);
    if (node.t === 'd') throw new FsError('EISDIR', path);
    if (!this.canRead(node, user)) throw new FsError('EACCES', path);
    return node.data;
  }

  tryRead(path) {
    try { return this.read(path); } catch { return null; }
  }

  write(path, data, { append = false, user = 'root', mode, owner, mtime } = {}) {
    const r = this._route(path, true);
    if (r.mounted) return r.fs.write(r.path, data, { append, user: 'root', mode, mtime });
    const p = normPath(path);
    const { node, parent, name } = this._walk(p);
    if (node && node.t === 'd') throw new FsError('EISDIR', p);
    if (!parent) throw new FsError('ENOENT', p);
    if (node) {
      if (!this.canWrite(node, user)) throw new FsError('EACCES', p);
      node.data = append ? node.data + data : data;
      node.mtime = mtime ?? node.mtime;
      if (mode !== undefined) node.mode = mode;
      return;
    }
    if (!this.canWrite(parent, user)) throw new FsError('EACCES', p);
    parent.c[name] = { t: 'f', data: String(data), owner: owner || user, mode: mode ?? 0o644, mtime: mtime || 0 };
  }

  // zapis z tworzeniem katalogów (do budowania stanu, bez sprawdzania uprawnień)
  put(path, data, { mode = 0o644, owner = 'root' } = {}) {
    const p = normPath(path);
    this.mkdir(dirname(p), { p: true, owner: 'root' });
    const { parent, name } = this._walk(p);
    parent.c[name] = { t: 'f', data: String(data), owner, mode, mtime: 0 };
  }

  mkdir(path, { p = false, user = 'root', owner, mode = 0o755 } = {}) {
    const r = this._route(path, true);
    if (r.mounted) return r.fs.mkdir(r.path, { p, mode });
    const np = normPath(path);
    if (np === '/') return;
    const parts = np.slice(1).split('/');
    let cur = this.root;
    let sofar = '';
    for (let i = 0; i < parts.length; i++) {
      sofar += '/' + parts[i];
      let next = cur.c[parts[i]];
      if (next) {
        if (next.t !== 'd') throw new FsError(i === parts.length - 1 ? 'EEXIST' : 'ENOTDIR', sofar);
        if (i === parts.length - 1 && !p) throw new FsError('EEXIST', np);
      } else {
        if (i < parts.length - 1 && !p) throw new FsError('ENOENT', np);
        if (!this.canWrite(cur, user)) throw new FsError('EACCES', np);
        next = cur.c[parts[i]] = mkdirNode(owner || user, mode);
      }
      cur = next;
    }
  }

  list(path, user = 'root') {
    const r = this._route(path);
    let names;
    if (r.mounted) names = r.fs.list(r.path, 'root');
    else {
      const { node } = this._walk(path);
      if (!node) throw new FsError('ENOENT', path);
      if (node.t !== 'd') return [basename(path)];
      if (!this.canRead(node, user)) throw new FsError('EACCES', path);
      names = Object.keys(node.c);
    }
    // punkty montowania widoczne w katalogu nadrzędnym
    if (this.mounts) {
      const p = normPath(path);
      for (const m of this.mounts) {
        if (dirname(m.path) === p && !names.includes(basename(m.path))) names.push(basename(m.path));
      }
    }
    return names.sort();
  }

  remove(path, { recursive = false, user = 'root', force = false } = {}) {
    const r = this._route(path, true);
    if (r.mounted) return r.fs.remove(r.path, { recursive, force });
    const p = normPath(path);
    const { node, parent, name } = this._walk(p);
    if (!node) { if (force) return; throw new FsError('ENOENT', p); }
    if (node.t === 'd' && !recursive) throw new FsError('EISDIR', p);
    if (!this.canWrite(parent, user)) throw new FsError('EACCES', p);
    delete parent.c[name];
  }

  rmdir(path) {
    const { node, parent, name } = this._walk(path);
    if (!node) throw new FsError('ENOENT', path);
    if (node.t !== 'd') throw new FsError('ENOTDIR', path);
    if (Object.keys(node.c).length) throw new FsError('ENOTEMPTY', path);
    delete parent.c[name];
  }

  copy(src, dst, { user = 'root', recursive = false } = {}) {
    if (this.isDir(src)) {
      if (!recursive) throw new FsError('EISDIR', src);
      const target = this.isDir(dst) ? normPath(dst + '/' + basename(src)) : dst;
      this.mkdir(target, { p: true, user });
      for (const n of this.list(src)) this.copy(src + '/' + n, target + '/' + n, { user, recursive });
      return;
    }
    const data = this.read(src, user);
    const target = this.isDir(dst) ? normPath(dst + '/' + basename(src)) : dst;
    this.write(target, data, { user });
  }

  move(src, dst, { user = 'root' } = {}) {
    const target = this.isDir(dst) ? normPath(dst + '/' + basename(src)) : normPath(dst);
    const s = this._walk(src);
    if (!s.node) throw new FsError('ENOENT', src);
    if (!this.canWrite(s.parent, user)) throw new FsError('EACCES', src);
    const t = this._walk(target);
    if (!t.parent) throw new FsError('ENOENT', target);
    if (!this.canWrite(t.parent, user)) throw new FsError('EACCES', target);
    t.parent.c[t.name] = s.node;
    delete s.parent.c[s.name];
  }

  chmod(path, mode) {
    const { node } = this._walk(path);
    if (!node) throw new FsError('ENOENT', path);
    node.mode = mode;
  }

  chown(path, owner) {
    const { node } = this._walk(path);
    if (!node) throw new FsError('ENOENT', path);
    node.owner = owner;
    if (node.t === 'd') for (const n of Object.keys(node.c)) this.chown(normPath(path + '/' + n), owner);
  }

  // rozwija wzorzec glob względem cwd; zwraca listę ścieżek (w formie jak podana)
  glob(pattern, cwd = '/') {
    if (!/[*?[]/.test(pattern)) return [pattern];
    const abs = pattern.startsWith('/');
    const full = abs ? pattern : (cwd === '/' ? '' : cwd) + '/' + pattern;
    const parts = normPath(full).slice(1).split('/');
    let paths = ['/'];
    for (const part of parts) {
      const next = [];
      for (const base of paths) {
        if (/[*?[]/.test(part)) {
          const re = globToRegex(part);
          let names = [];
          try { names = this.list(base); } catch { /* brak */ }
          for (const n of names) if (re.test(n) && (!n.startsWith('.') || part.startsWith('.'))) next.push(normPath(base + '/' + n));
        } else {
          const p = normPath(base + '/' + part);
          if (this.exists(p)) next.push(p);
        }
      }
      paths = next;
    }
    if (!paths.length) return [pattern];
    if (abs) return paths.sort();
    const pre = cwd === '/' ? '/' : cwd + '/';
    return paths.map((p) => (p.startsWith(pre) ? p.slice(pre.length) : p)).sort();
  }

  // wszystkie pliki pod katalogiem (rekurencyjnie) - do grep -r, find
  walkFiles(path) {
    const out = [];
    const rec = (p) => {
      if (this.isDir(p)) { for (const n of this.list(p)) rec(normPath(p + '/' + n)); } else out.push(p);
    };
    if (this.exists(path)) rec(normPath(path));
    return out;
  }
}
