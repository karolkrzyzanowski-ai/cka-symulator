// Klaster: API server + "etcd" + zegar + pętla kontrolerów.
import { Registry } from './resources.js';
import { clone, uuid, randSuffix, parseSelector, matchReqs, deepEqual, get, seedRandom, rand } from '../lib/util.js';
import { admitCreate, admitUpdate, onDelete } from './admission.js';
import { authorize } from './rbac.js';

export class ApiError extends Error {
  constructor(code, reason, message, extra = {}) {
    super(message);
    this.code = code;
    this.reason = reason;
    Object.assign(this, extra);
  }

  // komunikat w stylu kubectl
  kubectlMessage(ctx = '') {
    if (this.reason === 'ConnRefused') return this.message;
    if (this.reason === 'NoMatch') return this.message;
    if (this.reason === 'Invalid') return `The ${this.kind} "${this.name}" is invalid: ${this.message}`;
    return `Error from server (${this.reason})${ctx}: ${this.message}`;
  }
}

export const ADMIN = { name: 'kubernetes-admin', groups: ['kubeadm:cluster-admins', 'system:authenticated'] };
export const SYSTEM = { name: 'system:kube-controller-manager', groups: ['system:masters'] };

const nsKey = (ns, name) => `${ns || ''}/${name}`;

export class Cluster {
  constructor() {
    this.registry = new Registry();
    this.db = {};
    this.rv = 1000;
    this.clock = Date.now();
    this.hosts = {};
    this.runtime = {}; // stan kontenerów: uid poda -> {...}
    this.controllers = [];
    this.meta = { version: 'v1.37.1', clusterName: 'kubernetes', cpIp: '192.168.177.10' };
    this.listeners = [];
    this.dirty = false;
    this.alloc = { svcIPs: new Set(), nodePorts: new Set(), podIPs: {} };
    this.etcd = { dataDir: '/var/lib/etcd', stores: {} };
  }

  now() { return this.clock; }
  iso(t = this.clock) { return new Date(Math.floor(t / 1000) * 1000).toISOString().replace('.000Z', 'Z'); }

  // ------------------------------------------------------------------ dostęp do bazy
  res(nameOrRes) {
    if (typeof nameOrRes === 'object') return nameOrRes;
    const r = this.registry.resolve(nameOrRes);
    if (!r) throw new ApiError(404, 'NotFound', `the server doesn't have a resource type "${nameOrRes}"`, { noType: true });
    return r;
  }

  table(r) {
    const k = r.group ? `${r.plural}.${r.group}` : r.plural;
    if (!this.db[k]) this.db[k] = {};
    return this.db[k];
  }

  // bez autoryzacji - dla kontrolerów i sprawdzarek
  peek(res, ns, name) {
    const r = this.res(res);
    return this.table(r)[nsKey(r.namespaced ? ns : '', name)] || null;
  }

  all(res, ns) {
    const r = this.res(res);
    const t = this.table(r);
    const out = [];
    for (const [k, v] of Object.entries(t)) {
      if (r.namespaced && ns && !k.startsWith(`${ns}/`)) continue;
      out.push(v);
    }
    return out.sort((a, b) => (a.metadata.namespace || '').localeCompare(b.metadata.namespace || '') || a.metadata.name.localeCompare(b.metadata.name));
  }

  // zapis wewnętrzny (status, kontrolery). Zwraca true jeśli coś się zmieniło.
  put(obj) {
    if (obj.kind === 'CustomResourceDefinition') this.registry.syncCrd(obj);
    const r = this.registry.byKindAnyVersion(obj.apiVersion, obj.kind);
    if (!r) throw new Error(`brak typu ${obj.apiVersion} ${obj.kind}`);
    const t = this.table(r);
    const key = nsKey(r.namespaced ? obj.metadata.namespace : '', obj.metadata.name);
    const old = t[key];
    if (old && deepEqual(stripRv(old), stripRv(obj))) return false;
    if (!obj.metadata.uid) obj.metadata.uid = uuid();
    if (!obj.metadata.creationTimestamp) obj.metadata.creationTimestamp = this.iso();
    obj.metadata.resourceVersion = String(++this.rv);
    t[key] = obj;
    this.dirty = true;
    return true;
  }

  remove(res, ns, name) {
    const r = this.res(res);
    const t = this.table(r);
    const key = nsKey(r.namespaced ? ns : '', name);
    const o = t[key];
    if (!o) return null;
    delete t[key];
    this.dirty = true;
    onDelete(this, r, o);
    return o;
  }

  // ------------------------------------------------------------------ dostępność API
  apiAvailable() {
    return !this.apiserverDown;
  }

  checkApi(server) {
    if (!this.apiAvailable()) {
      throw new ApiError(0, 'ConnRefused', `The connection to the server ${server || `${this.meta.cpIp}:6443`} was refused - did you specify the right host or port?`);
    }
  }

  // ------------------------------------------------------------------ API publiczne (kubectl)
  authz(user, verb, r, ns, name, sub) {
    if (!user) return;
    const ok = authorize(this, user, { verb, group: r.group, resource: r.plural, subresource: sub, namespace: r.namespaced ? ns : '', name });
    if (!ok) {
      const what = sub ? `${r.plural}/${sub}` : r.plural;
      const who = user.name.startsWith('system:serviceaccount:') ? `"${user.name}"` : `"${user.name}"`;
      const scope = r.namespaced && ns ? `in the namespace "${ns}"` : 'at the cluster scope';
      const target = name ? `${this.registry.qualified(r)} "${name}"` : this.registry.qualified(r);
      throw new ApiError(403, 'Forbidden', `${target} is forbidden: User ${who} cannot ${verb} resource "${what}" in API group "${r.group}" ${scope}`);
    }
  }

  get(res, ns, name, { user } = {}) {
    const r = this.res(res);
    this.checkApi();
    this.authz(user, 'get', r, ns, name);
    const o = this.peek(r, ns, name);
    if (!o) throw new ApiError(404, 'NotFound', `${this.registry.qualified(r)} "${name}" not found`);
    return clone(o);
  }

  list(res, ns, { labelSelector, fieldSelector, user } = {}) {
    const r = this.res(res);
    this.checkApi();
    this.authz(user, 'list', r, ns);
    let items = this.all(r, r.namespaced ? ns : null);
    if (labelSelector) {
      const reqs = parseSelector(labelSelector);
      items = items.filter((o) => matchReqs(reqs, o.metadata.labels));
    }
    if (fieldSelector) {
      const parts = fieldSelector.split(',').map((p) => p.match(/^([\w.]+)(!=|==|=)(.*)$/)).filter(Boolean);
      items = items.filter((o) => parts.every(([, f, op, v]) => {
        const actual = String(get(o, f, ''));
        return op === '!=' ? actual !== v : actual === v;
      }));
    }
    return items.map(clone);
  }

  create(obj, { user, dryRun = false, ns, fieldValidation = 'Strict' } = {}) {
    this.checkApi();
    const { r, o } = admitCreate(this, clone(obj), { user, ns, fieldValidation });
    if (dryRun) return o;
    this.put(o);
    this.afterWrite(r, o, null);
    return clone(o);
  }

  update(obj, { user, dryRun = false, subresource, fieldValidation = 'Strict' } = {}) {
    this.checkApi();
    const { r, o, old } = admitUpdate(this, clone(obj), { user, subresource, fieldValidation });
    if (dryRun) return o;
    this.put(o);
    this.afterWrite(r, o, old);
    return clone(o);
  }

  delete(res, ns, name, { user, gracePeriod, propagation = 'Background', dryRun = false } = {}) {
    const r = this.res(res);
    this.checkApi();
    this.authz(user, 'delete', r, ns, name);
    const o = this.peek(r, ns, name);
    if (!o) throw new ApiError(404, 'NotFound', `${this.registry.qualified(r)} "${name}" not found`);
    if (dryRun) return clone(o);
    return this.doDelete(r, o, { gracePeriod, propagation });
  }

  doDelete(r, o, { gracePeriod, propagation = 'Background' } = {}) {
    if (r.kind === 'Pod') {
      if (gracePeriod === 0 || !o.spec.nodeName) { this.remove(r, o.metadata.namespace, o.metadata.name); return clone(o); }
      if (!o.metadata.deletionTimestamp) {
        const g = gracePeriod ?? o.spec.terminationGracePeriodSeconds ?? 30;
        o.metadata.deletionTimestamp = this.iso(this.clock + g * 1000);
        o.metadata.deletionGracePeriodSeconds = g;
        this.put(o);
      } else if (gracePeriod !== undefined && gracePeriod < (o.metadata.deletionGracePeriodSeconds ?? 30)) {
        o.metadata.deletionTimestamp = this.iso(this.clock + gracePeriod * 1000);
        o.metadata.deletionGracePeriodSeconds = gracePeriod;
        this.put(o);
      }
      return clone(o);
    }
    if (r.kind === 'Namespace') {
      if (!o.metadata.deletionTimestamp) {
        o.metadata.deletionTimestamp = this.iso();
        o.status = { phase: 'Terminating' };
        this.put(o);
      }
      return clone(o);
    }
    if ((o.metadata.finalizers || []).length) {
      if (!o.metadata.deletionTimestamp) {
        o.metadata.deletionTimestamp = this.iso();
        this.put(o);
      }
      return clone(o);
    }
    if (propagation === 'Orphan') {
      for (const d of this.dependents(o)) {
        d.metadata.ownerReferences = (d.metadata.ownerReferences || []).filter((x) => x.uid !== o.metadata.uid);
        if (!d.metadata.ownerReferences.length) delete d.metadata.ownerReferences;
        this.put(d);
      }
    }
    this.remove(r, o.metadata.namespace, o.metadata.name);
    return clone(o);
  }

  dependents(owner) {
    const out = [];
    for (const t of Object.values(this.db)) {
      for (const o of Object.values(t)) {
        if ((o.metadata.ownerReferences || []).some((x) => x.uid === owner.metadata.uid)) out.push(o);
      }
    }
    return out;
  }

  afterWrite(r, o, old) {
    for (const l of this.listeners) l(r, o, old);
  }

  // ------------------------------------------------------------------ zdarzenia
  event(obj, type, reason, message, component = 'default-scheduler') {
    if (!obj?.metadata) return;
    const ns = obj.metadata.namespace || 'default';
    const evs = this.table(this.res('events'));
    const existing = Object.values(evs).find((e) => e.metadata.namespace === ns && e.involvedObject.uid === obj.metadata.uid && e.reason === reason && e.message === message);
    if (existing) {
      existing.count = (existing.count || 1) + 1;
      existing.lastTimestamp = this.iso();
      this.put(existing);
      return;
    }
    const name = `${obj.metadata.name}.${(Math.floor(this.clock * 1000) + Math.floor(rand() * 1e6)).toString(16).slice(-16)}`;
    this.put({
      apiVersion: 'v1', kind: 'Event',
      metadata: { name, namespace: ns, creationTimestamp: this.iso() },
      involvedObject: { apiVersion: obj.apiVersion, kind: obj.kind, name: obj.metadata.name, namespace: obj.metadata.namespace, uid: obj.metadata.uid },
      reason, message, type, count: 1, source: { component },
      firstTimestamp: this.iso(), lastTimestamp: this.iso(), reportingComponent: component,
    });
  }

  eventsFor(obj) {
    return this.all('events', obj.metadata.namespace || 'default')
      .filter((e) => e.involvedObject.uid === obj.metadata.uid || (e.involvedObject.kind === obj.kind && e.involvedObject.name === obj.metadata.name))
      .sort((a, b) => Date.parse(a.lastTimestamp) - Date.parse(b.lastTimestamp));
  }

  // ------------------------------------------------------------------ czas i kontrolery
  // przesuwa zegar o ms, wykonując kontrolery krokami
  advance(ms, step = 1000) {
    let left = ms;
    while (left > 0) {
      const d = Math.min(step, left);
      this.clock += d;
      left -= d;
      this.reconcile();
    }
    if (ms <= 0) this.reconcile();
  }

  reconcile() {
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      for (const c of this.controllers) {
        try {
          if (c.run(this)) changed = true;
        } catch (e) {
          if (!this._ctrlErr) console.error('kontroler', c.name, e); // eslint-disable-line no-console
          this._ctrlErr = true;
        }
      }
      if (!changed) break;
    }
  }

  // ------------------------------------------------------------------ serializacja
  toJSON() {
    return {
      v: 2, clock: this.clock, rv: this.rv, db: this.db, meta: this.meta,
      hosts: Object.fromEntries(Object.entries(this.hosts).map(([k, h]) => [k, h.toJSON()])),
      runtime: this.runtime,
      crds: this.registry.list.filter((r) => r.crd).map((r) => ({ ...r })),
      etcd: this.etcd, apiserverDown: !!this.apiserverDown, comp: this.comp || null, nfs: this.nfs || {},
      alloc: { svcIPs: [...this.alloc.svcIPs], nodePorts: [...this.alloc.nodePorts], podIPs: this.alloc.podIPs },
      failBackoff: this.failBackoff || {}, heartbeats: this.heartbeats || {}, extra: this.extra || {},
    };
  }

  // odtworzenie; HostCls przekazany z zewnątrz (unikamy cyklu importów)
  static fromJSON(j, HostCls) {
    const c = new Cluster();
    c.clock = j.clock; c.rv = j.rv; c.db = j.db; c.meta = j.meta;
    for (const r of j.crds || []) c.registry.add(r);
    c.hosts = Object.fromEntries(Object.entries(j.hosts).map(([k, h]) => [k, HostCls.from(h)]));
    c.runtime = j.runtime || {};
    c.etcd = j.etcd; c.apiserverDown = j.apiserverDown; c.comp = j.comp || undefined; c.nfs = j.nfs || {};
    c.alloc = { svcIPs: new Set(j.alloc?.svcIPs || []), nodePorts: new Set(j.alloc?.nodePorts || []), podIPs: j.alloc?.podIPs || {} };
    c.failBackoff = j.failBackoff || {}; c.heartbeats = j.heartbeats || {}; c.extra = j.extra || {};
    return c;
  }

  // przesunięcie całej osi czasu (np. po wczytaniu zapisu - "teraz" = czas rzeczywisty)
  rebase(newNow) {
    const d = newNow - this.clock;
    if (!d) return;
    const shiftIso = (v) => {
      if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v)) return v;
      return this.iso(Date.parse(v) + d);
    };
    const walk = (o, depth = 0) => {
      if (!o || typeof o !== 'object' || depth > 40) return;
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v === 'string') o[k] = shiftIso(v);
        else if (typeof v === 'number' && /(At|Ms|Until|Time|^t$|^wake$|lastStart|lastReady|lastLive|lastMountEvent|created)$/.test(k) && v > 1e12) o[k] = v + d;
        else if (typeof v === 'object') walk(v, depth + 1);
      }
    };
    walk(this.db);
    walk(this.runtime);
    for (const h of Object.values(this.hosts)) {
      for (const j of Object.values(h.journal || {})) for (const e of j) e[0] += d;
      for (const u of Object.values(h.units || {})) walk(u);
      if (h.bootTime) h.bootTime += d;
    }
    for (const k of Object.keys(this.heartbeats || {})) this.heartbeats[k] += d;
    for (const k of Object.keys(this.failBackoff || {})) this.failBackoff[k] += d;
    if (this.meta.createdAt) this.meta.createdAt += d;
    this.clock = newNow;
  }
}

function stripRv(o) {
  const c = { ...o, metadata: { ...o.metadata } };
  delete c.metadata.resourceVersion;
  return c;
}

export { nsKey, seedRandom, randSuffix };
