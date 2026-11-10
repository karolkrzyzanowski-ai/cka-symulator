// Drukowanie tabel `kubectl get` (kolumny jak w serwerowym printerze Kubernetes).
import { age, humanDuration, labelsString, selectorString, parseQty, fmtMem } from '../lib/util.js';
import { jsonpath } from '../lib/jsonpath.js';

const none = (v) => (v === undefined || v === null || v === '' ? '<none>' : v);

// ------------------------------------------------------------------ pod
export function podStatus(p) {
  const st = p.status || {};
  let reason = st.phase || 'Pending';
  if (st.reason) reason = st.reason;
  let restarts = 0, ready = 0, lastRestart = 0;
  const spec = p.spec || {};
  const sidecars = new Set((spec.initContainers || []).filter((c) => c.restartPolicy === 'Always').map((c) => c.name));
  const total = (spec.containers || []).length + sidecars.size;
  let initializing = false;
  const initSt = st.initContainerStatuses || [];
  const noteRestart = (cs) => {
    restarts += cs.restartCount || 0;
    const fin = cs.lastState?.terminated?.finishedAt;
    if (fin && Date.parse(fin) > lastRestart) lastRestart = Date.parse(fin);
  };
  for (let i = 0; i < initSt.length; i++) {
    const cs = initSt[i];
    noteRestart(cs);
    if (sidecars.has(cs.name) && cs.started) { if (cs.ready) ready++; continue; }
    if (cs.state?.terminated && cs.state.terminated.exitCode === 0) continue;
    if (cs.state?.terminated) {
      const t = cs.state.terminated;
      reason = 'Init:' + (t.reason || (t.signal ? `Signal:${t.signal}` : `ExitCode:${t.exitCode}`));
    } else if (cs.state?.waiting?.reason && cs.state.waiting.reason !== 'PodInitializing') reason = 'Init:' + cs.state.waiting.reason;
    else reason = `Init:${i}/${(spec.initContainers || []).length}`;
    initializing = true;
    break;
  }
  if (!initializing) {
    let hasRunning = false;
    const cst = [...(st.containerStatuses || [])].reverse();
    for (const cs of cst) {
      noteRestart(cs);
      if (cs.state?.waiting?.reason) reason = cs.state.waiting.reason;
      else if (cs.state?.terminated?.reason) reason = cs.state.terminated.reason;
      else if (cs.state?.terminated) reason = cs.state.terminated.signal ? `Signal:${cs.state.terminated.signal}` : `ExitCode:${cs.state.terminated.exitCode}`;
      else if (cs.ready && cs.state?.running) { hasRunning = true; ready++; }
    }
    if (reason === 'Completed' && hasRunning) reason = (st.conditions || []).some((x) => x.type === 'Ready' && x.status === 'True') ? 'Running' : 'NotReady';
  }
  if (p.metadata.deletionTimestamp) reason = st.reason === 'NodeLost' ? 'Unknown' : 'Terminating';
  return { reason, ready, total, restarts, lastRestart };
}

function restartsCol(s, now) {
  if (!s.restarts) return '0';
  return s.lastRestart ? `${s.restarts} (${humanDuration(now - s.lastRestart)} ago)` : String(s.restarts);
}

const containersOf = (tpl) => (tpl?.spec?.containers || []);
const cNames = (tpl) => containersOf(tpl).map((c) => c.name).join(',');
const cImages = (tpl) => containersOf(tpl).map((c) => c.image).join(',');

function svcPorts(s) {
  const ps = s.spec.ports || [];
  if (!ps.length) return '<none>';
  return ps.map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol || 'TCP'}`).join(',');
}
function svcExternal(s) {
  if (s.spec.type === 'ExternalName') return s.spec.externalName;
  const ing = s.status?.loadBalancer?.ingress || [];
  if (s.spec.type === 'LoadBalancer') return ing.length ? ing.map((i) => i.ip || i.hostname).join(',') : '<pending>';
  return (s.spec.externalIPs || []).join(',') || '<none>';
}

function nodeStatus(n) {
  const r = (n.status?.conditions || []).find((c) => c.type === 'Ready');
  let s = !r ? 'Unknown' : r.status === 'True' ? 'Ready' : r.status === 'False' ? 'NotReady' : 'Unknown';
  if (n.spec?.unschedulable) s += ',SchedulingDisabled';
  return s;
}
function nodeRoles(n) {
  const roles = Object.keys(n.metadata.labels || {}).filter((k) => k.startsWith('node-role.kubernetes.io/')).map((k) => k.split('/')[1]).filter(Boolean);
  if (n.metadata.labels?.['kubernetes.io/role']) roles.push(n.metadata.labels['kubernetes.io/role']);
  return roles.length ? roles.sort().join(',') : '<none>';
}

function jobStatus(j) {
  const conds = j.status?.conditions || [];
  const has = (t) => conds.some((c) => c.type === t && c.status === 'True');
  if (has('Complete')) return 'Complete';
  if (has('Failed')) return 'Failed';
  if (has('FailureTarget')) return 'FailureTarget';
  if (has('Suspended')) return 'Suspended';
  return 'Running';
}
function jobDuration(j, now) {
  const s = j.status?.startTime;
  if (!s) return '';
  const e = j.status?.completionTime ? Date.parse(j.status.completionTime) : now;
  return humanDuration(e - Date.parse(s));
}

function accessModes(m = []) {
  const map = { ReadWriteOnce: 'RWO', ReadOnlyMany: 'ROX', ReadWriteMany: 'RWX', ReadWriteOncePod: 'RWOP' };
  return m.map((x) => map[x] || x).join(',');
}

function subjectsOf(b, kind) {
  return (b.subjects || []).filter((s) => s.kind === kind).map((s) => (kind === 'ServiceAccount' ? `${s.namespace || ''}/${s.name}` : s.name)).join(', ');
}

function hpaTargets(h) {
  const out = [];
  for (const m of h.spec.metrics || []) {
    if (m.type !== 'Resource') continue;
    const name = m.resource.name;
    const cur = (h.status?.currentMetrics || []).find((x) => x.type === 'Resource' && x.resource?.name === name);
    const t = m.resource.target || {};
    let target, current;
    if (t.type === 'Utilization') { target = `${t.averageUtilization}%`; current = cur?.resource?.current?.averageUtilization != null ? `${cur.resource.current.averageUtilization}%` : '<unknown>'; } else { target = t.averageValue || t.value; current = cur?.resource?.current?.averageValue || '<unknown>'; }
    out.push(`${name}: ${current}/${target}`);
  }
  return out.length ? out.join(', ') : '<none>';
}

function quotaCols(q) {
  const req = [], lim = [];
  const used = q.status?.used || {};
  for (const [k, v] of Object.entries(q.spec?.hard || q.status?.hard || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const s = `${k}: ${used[k] ?? '0'}/${v}`;
    if (k.startsWith('limits.')) lim.push(s); else req.push(s);
  }
  return [req.join(', '), lim.join(', ')];
}

function epString(list, max = 3) {
  if (!list.length) return '<none>';
  const shown = list.slice(0, max).join(',');
  return list.length > max ? `${shown} + ${list.length - max} more...` : shown;
}

function eventObj(e) { return `${(e.involvedObject.kind || '').toLowerCase()}/${e.involvedObject.name}`; }

// ------------------------------------------------------------------ definicje kolumn
// każda: { cols: [...], row(o, ctx) -> [...], wide?: {cols, row} }
export const PRINTERS = {
  Pod: {
    cols: ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'],
    row: (p, x) => { const s = podStatus(p); return [p.metadata.name, `${s.ready}/${s.total}`, s.reason, restartsCol(s, x.now), age(p.metadata.creationTimestamp, x.now)]; },
    wide: { cols: ['IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES'], row: (p) => [p.status?.podIP || '<none>', p.spec.nodeName || '<none>', p.status?.nominatedNodeName || '<none>', (p.spec.readinessGates || []).length ? '0/' + p.spec.readinessGates.length : '<none>'] },
  },
  Deployment: {
    cols: ['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'],
    row: (d, x) => [d.metadata.name, `${d.status?.readyReplicas || 0}/${d.spec.replicas ?? 1}`, d.status?.updatedReplicas || 0, d.status?.availableReplicas || 0, age(d.metadata.creationTimestamp, x.now)],
    wide: { cols: ['CONTAINERS', 'IMAGES', 'SELECTOR'], row: (d) => [cNames(d.spec.template), cImages(d.spec.template), selectorString(d.spec.selector)] },
  },
  ReplicaSet: {
    cols: ['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE'],
    row: (r, x) => [r.metadata.name, r.spec.replicas ?? 1, r.status?.replicas || 0, r.status?.readyReplicas || 0, age(r.metadata.creationTimestamp, x.now)],
    wide: { cols: ['CONTAINERS', 'IMAGES', 'SELECTOR'], row: (d) => [cNames(d.spec.template), cImages(d.spec.template), selectorString(d.spec.selector)] },
  },
  StatefulSet: {
    cols: ['NAME', 'READY', 'AGE'],
    row: (s, x) => [s.metadata.name, `${s.status?.readyReplicas || 0}/${s.spec.replicas ?? 1}`, age(s.metadata.creationTimestamp, x.now)],
    wide: { cols: ['CONTAINERS', 'IMAGES'], row: (d) => [cNames(d.spec.template), cImages(d.spec.template)] },
  },
  DaemonSet: {
    cols: ['NAME', 'DESIRED', 'CURRENT', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'NODE SELECTOR', 'AGE'],
    row: (d, x) => [d.metadata.name, d.status?.desiredNumberScheduled || 0, d.status?.currentNumberScheduled || 0, d.status?.numberReady || 0, d.status?.updatedNumberScheduled || 0, d.status?.numberAvailable || 0, labelsString(d.spec.template.spec.nodeSelector), age(d.metadata.creationTimestamp, x.now)],
    wide: { cols: ['CONTAINERS', 'IMAGES', 'SELECTOR'], row: (d) => [cNames(d.spec.template), cImages(d.spec.template), selectorString(d.spec.selector)] },
  },
  Job: {
    cols: ['NAME', 'STATUS', 'COMPLETIONS', 'DURATION', 'AGE'],
    row: (j, x) => [j.metadata.name, jobStatus(j), `${j.status?.succeeded || 0}/${j.spec.completions ?? 1}`, jobDuration(j, x.now), age(j.metadata.creationTimestamp, x.now)],
    wide: { cols: ['CONTAINERS', 'IMAGES', 'SELECTOR'], row: (d) => [cNames(d.spec.template), cImages(d.spec.template), selectorString(d.spec.selector)] },
  },
  CronJob: {
    cols: ['NAME', 'SCHEDULE', 'TIMEZONE', 'SUSPEND', 'ACTIVE', 'LAST SCHEDULE', 'AGE'],
    row: (j, x) => [j.metadata.name, j.spec.schedule, j.spec.timeZone || '<none>', j.spec.suspend ? 'True' : 'False', (j.status?.active || []).length, j.status?.lastScheduleTime ? age(j.status.lastScheduleTime, x.now) : '<none>', age(j.metadata.creationTimestamp, x.now)],
    wide: { cols: ['CONTAINERS', 'IMAGES', 'SELECTOR'], row: (d) => [cNames(d.spec.jobTemplate.spec.template), cImages(d.spec.jobTemplate.spec.template), '<none>'] },
  },
  Service: {
    cols: ['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE'],
    row: (s, x) => [s.metadata.name, s.spec.type || 'ClusterIP', s.spec.clusterIP || '<none>', svcExternal(s), svcPorts(s), age(s.metadata.creationTimestamp, x.now)],
    wide: { cols: ['SELECTOR'], row: (s) => [s.spec.selector ? labelsString(s.spec.selector) : '<none>'] },
  },
  Endpoints: {
    cols: ['NAME', 'ENDPOINTS', 'AGE'],
    row: (e, x) => {
      const list = [];
      for (const ss of e.subsets || []) for (const a of ss.addresses || []) for (const p of ss.ports || [{}]) list.push(p.port ? `${a.ip}:${p.port}` : a.ip);
      return [e.metadata.name, epString(list), age(e.metadata.creationTimestamp, x.now)];
    },
  },
  EndpointSlice: {
    cols: ['NAME', 'ADDRESSTYPE', 'PORTS', 'ENDPOINTS', 'AGE'],
    row: (e, x) => [e.metadata.name, e.addressType, (e.ports || []).map((p) => p.port).join(',') || '<unset>', epString((e.endpoints || []).flatMap((p) => p.addresses || [])).replace('<none>', '<unset>'), age(e.metadata.creationTimestamp, x.now)],
  },
  Node: {
    cols: ['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION'],
    row: (n, x) => [n.metadata.name, nodeStatus(n), nodeRoles(n), age(n.metadata.creationTimestamp, x.now), n.status?.nodeInfo?.kubeletVersion || ''],
    wide: { cols: ['INTERNAL-IP', 'EXTERNAL-IP', 'OS-IMAGE', 'KERNEL-VERSION', 'CONTAINER-RUNTIME'], row: (n) => [(n.status?.addresses || []).find((a) => a.type === 'InternalIP')?.address || '<none>', '<none>', n.status?.nodeInfo?.osImage || '', n.status?.nodeInfo?.kernelVersion || '', n.status?.nodeInfo?.containerRuntimeVersion || ''] },
  },
  Namespace: { cols: ['NAME', 'STATUS', 'AGE'], row: (n, x) => [n.metadata.name, n.status?.phase || 'Active', age(n.metadata.creationTimestamp, x.now)] },
  ConfigMap: { cols: ['NAME', 'DATA', 'AGE'], row: (c, x) => [c.metadata.name, Object.keys(c.data || {}).length + Object.keys(c.binaryData || {}).length, age(c.metadata.creationTimestamp, x.now)] },
  Secret: { cols: ['NAME', 'TYPE', 'DATA', 'AGE'], row: (s, x) => [s.metadata.name, s.type || 'Opaque', Object.keys(s.data || {}).length, age(s.metadata.creationTimestamp, x.now)] },
  ServiceAccount: { cols: ['NAME', 'SECRETS', 'AGE'], row: (s, x) => [s.metadata.name, (s.secrets || []).length, age(s.metadata.creationTimestamp, x.now)] },
  PersistentVolume: {
    cols: ['NAME', 'CAPACITY', 'ACCESS MODES', 'RECLAIM POLICY', 'STATUS', 'CLAIM', 'STORAGECLASS', 'VOLUMEATTRIBUTESCLASS', 'REASON', 'AGE'],
    row: (v, x) => [v.metadata.name, v.spec.capacity?.storage || '', accessModes(v.spec.accessModes), v.spec.persistentVolumeReclaimPolicy || 'Retain', v.status?.phase || 'Pending', v.spec.claimRef ? `${v.spec.claimRef.namespace}/${v.spec.claimRef.name}` : '', v.spec.storageClassName || '', v.spec.volumeAttributesClassName || '<unset>', v.status?.reason || '', age(v.metadata.creationTimestamp, x.now)],
    wide: { cols: ['VOLUMEMODE'], row: (v) => [v.spec.volumeMode || 'Filesystem'] },
  },
  PersistentVolumeClaim: {
    cols: ['NAME', 'STATUS', 'VOLUME', 'CAPACITY', 'ACCESS MODES', 'STORAGECLASS', 'VOLUMEATTRIBUTESCLASS', 'AGE'],
    row: (v, x) => [v.metadata.name, v.status?.phase || 'Pending', v.spec.volumeName || '', v.status?.capacity?.storage || '', accessModes(v.status?.accessModes || []), v.spec.storageClassName ?? '<unset>', v.spec.volumeAttributesClassName || '<unset>', age(v.metadata.creationTimestamp, x.now)],
    wide: { cols: ['VOLUMEMODE'], row: (v) => [v.spec.volumeMode || 'Filesystem'] },
  },
  StorageClass: {
    cols: ['NAME', 'PROVISIONER', 'RECLAIMPOLICY', 'VOLUMEBINDINGMODE', 'ALLOWVOLUMEEXPANSION', 'AGE'],
    row: (s, x) => [s.metadata.name + (s.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' ? ' (default)' : ''), s.provisioner, s.reclaimPolicy || 'Delete', s.volumeBindingMode || 'Immediate', s.allowVolumeExpansion ? 'true' : 'false', age(s.metadata.creationTimestamp, x.now)],
  },
  Role: { cols: ['NAME', 'CREATED AT'], row: (r) => [r.metadata.name, r.metadata.creationTimestamp] },
  ClusterRole: { cols: ['NAME', 'CREATED AT'], row: (r) => [r.metadata.name, r.metadata.creationTimestamp] },
  RoleBinding: {
    cols: ['NAME', 'ROLE', 'AGE'], row: (b, x) => [b.metadata.name, `${b.roleRef.kind}/${b.roleRef.name}`, age(b.metadata.creationTimestamp, x.now)],
    wide: { cols: ['USERS', 'GROUPS', 'SERVICEACCOUNTS'], row: (b) => [subjectsOf(b, 'User'), subjectsOf(b, 'Group'), subjectsOf(b, 'ServiceAccount')] },
  },
  ClusterRoleBinding: {
    cols: ['NAME', 'ROLE', 'AGE'], row: (b, x) => [b.metadata.name, `${b.roleRef.kind}/${b.roleRef.name}`, age(b.metadata.creationTimestamp, x.now)],
    wide: { cols: ['USERS', 'GROUPS', 'SERVICEACCOUNTS'], row: (b) => [subjectsOf(b, 'User'), subjectsOf(b, 'Group'), subjectsOf(b, 'ServiceAccount')] },
  },
  NetworkPolicy: { cols: ['NAME', 'POD-SELECTOR', 'AGE'], row: (n, x) => [n.metadata.name, selectorString(n.spec.podSelector) || '<none>', age(n.metadata.creationTimestamp, x.now)] },
  Ingress: {
    cols: ['NAME', 'CLASS', 'HOSTS', 'ADDRESS', 'PORTS', 'AGE'],
    row: (i, x) => [i.metadata.name, i.spec.ingressClassName || '<none>', (i.spec.rules || []).map((r) => r.host || '*').join(',') || '*', (i.status?.loadBalancer?.ingress || []).map((a) => a.ip || a.hostname).join(','), i.spec.tls?.length ? '80, 443' : '80', age(i.metadata.creationTimestamp, x.now)],
  },
  IngressClass: { cols: ['NAME', 'CONTROLLER', 'PARAMETERS', 'AGE'], row: (i, x) => [i.metadata.name, i.spec.controller, i.spec.parameters ? `${i.spec.parameters.kind}/${i.spec.parameters.name}` : '<none>', age(i.metadata.creationTimestamp, x.now)] },
  HorizontalPodAutoscaler: {
    cols: ['NAME', 'REFERENCE', 'TARGETS', 'MINPODS', 'MAXPODS', 'REPLICAS', 'AGE'],
    row: (h, x) => [h.metadata.name, `${h.spec.scaleTargetRef.kind}/${h.spec.scaleTargetRef.name}`, hpaTargets(h), h.spec.minReplicas ?? 1, h.spec.maxReplicas, h.status?.currentReplicas ?? 0, age(h.metadata.creationTimestamp, x.now)],
  },
  PriorityClass: { cols: ['NAME', 'VALUE', 'GLOBAL-DEFAULT', 'AGE', 'PREEMPTIONPOLICY'], row: (p, x) => [p.metadata.name, p.value, p.globalDefault ? 'true' : 'false', age(p.metadata.creationTimestamp, x.now), p.preemptionPolicy || 'PreemptLowerPriority'] },
  LimitRange: { cols: ['NAME', 'CREATED AT'], row: (l) => [l.metadata.name, l.metadata.creationTimestamp] },
  ResourceQuota: { cols: ['NAME', 'REQUEST', 'LIMIT', 'AGE'], row: (q, x) => { const [r, l] = quotaCols(q); return [q.metadata.name, r, l, age(q.metadata.creationTimestamp, x.now)]; } },
  Event: {
    cols: ['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'],
    row: (e, x) => [e.lastTimestamp ? age(e.lastTimestamp, x.now) : age(e.eventTime || e.metadata.creationTimestamp, x.now), e.type, e.reason, eventObj(e), e.message],
  },
  CertificateSigningRequest: {
    cols: ['NAME', 'AGE', 'SIGNERNAME', 'REQUESTOR', 'REQUESTEDDURATION', 'CONDITION'],
    row: (r, x) => {
      const conds = (r.status?.conditions || []).map((c) => c.type);
      if (r.status?.certificate && conds.includes('Approved')) conds.push('Issued');
      return [r.metadata.name, age(r.metadata.creationTimestamp, x.now), r.spec.signerName, r.spec.username || '', r.spec.expirationSeconds ? humanDuration(r.spec.expirationSeconds * 1000) : '<none>', conds.length ? conds.join(',') : 'Pending'];
    },
  },
  CustomResourceDefinition: { cols: ['NAME', 'CREATED AT'], row: (r) => [r.metadata.name, r.metadata.creationTimestamp] },
  PodDisruptionBudget: { cols: ['NAME', 'MIN AVAILABLE', 'MAX UNAVAILABLE', 'ALLOWED DISRUPTIONS', 'AGE'], row: (p, x) => [p.metadata.name, p.spec.minAvailable ?? 'N/A', p.spec.maxUnavailable ?? 'N/A', p.status?.disruptionsAllowed ?? 0, age(p.metadata.creationTimestamp, x.now)] },
  Lease: { cols: ['NAME', 'HOLDER', 'AGE'], row: (l, x) => [l.metadata.name, l.spec?.holderIdentity || '', age(l.metadata.creationTimestamp, x.now)] },
  ControllerRevision: { cols: ['NAME', 'CONTROLLER', 'REVISION', 'AGE'], row: (r, x) => [r.metadata.name, r.metadata.ownerReferences?.[0] ? `${r.metadata.ownerReferences[0].kind.toLowerCase()}.apps/${r.metadata.ownerReferences[0].name}` : '', r.revision, age(r.metadata.creationTimestamp, x.now)] },
  ComponentStatus: { cols: ['NAME', 'STATUS', 'MESSAGE', 'ERROR'], row: (s) => [s.metadata.name, 'Healthy', 'ok', ''] },
};

const DEFAULT = { cols: ['NAME', 'AGE'], row: (o, x) => [o.metadata.name, age(o.metadata.creationTimestamp, x.now)] };

function crdPrinter(r) {
  if (!r.columns?.length) return DEFAULT;
  const cols = r.columns.filter((c) => !c.priority);
  const wideCols = r.columns.filter((c) => c.priority);
  const val = (o, c, x) => {
    let v;
    try { v = jsonpath(`{${c.jsonPath}}`, o); } catch { v = ''; }
    if (c.type === 'date') return v ? age(v, x.now) : '<unknown>';
    return v === '' || v === undefined ? (c.type === 'string' ? '' : '<none>') : v;
  };
  const hasAge = cols.some((c) => c.name.toUpperCase() === 'AGE');
  return {
    cols: ['NAME', ...cols.map((c) => c.name.toUpperCase()), ...(hasAge ? [] : ['AGE'])],
    row: (o, x) => [o.metadata.name, ...cols.map((c) => val(o, c, x)), ...(hasAge ? [] : [age(o.metadata.creationTimestamp, x.now)])],
    wide: wideCols.length ? { cols: wideCols.map((c) => c.name.toUpperCase()), row: (o, x) => wideCols.map((c) => val(o, c, x)) } : null,
  };
}

export function printerFor(r) {
  if (r.crd) return crdPrinter(r);
  return PRINTERS[r.kind] || DEFAULT;
}

// tabela dla listy obiektów jednego typu
// opts: {wide, showKind, allNs, showLabels, labelCols:[], noHeaders, now}
export function tableFor(r, items, opts) {
  const p = printerFor(r);
  const x = { now: opts.now };
  let cols = [...p.cols];
  if (opts.wide && p.wide) cols = cols.concat(p.wide.cols);
  for (const l of opts.labelCols || []) cols.push(l.split('/').pop().toUpperCase());
  if (opts.showLabels) cols.push('LABELS');
  if (opts.allNs && r.namespaced) cols = ['NAMESPACE', ...cols];
  const rows = [cols];
  const prefix = opts.showKind ? `${kindPrefix(r)}/` : '';
  for (const o of items) {
    let row = p.row(o, x).map((v) => (v === undefined || v === null ? '' : String(v)));
    if (r.kind !== 'Event') row[0] = prefix + row[0];
    else if (prefix) row[3] = row[3];
    if (opts.wide && p.wide) row = row.concat(p.wide.row(o, x).map((v) => String(v ?? '')));
    for (const l of opts.labelCols || []) row.push(o.metadata.labels?.[l] ?? '');
    if (opts.showLabels) row.push(labelsString(o.metadata.labels));
    if (opts.allNs && r.namespaced) row = [o.metadata.namespace, ...row];
    rows.push(row);
  }
  return { rows, text: tableText(rows, opts.noHeaders) };
}

export function tableText(rows, noHeaders) {
  const body = noHeaders ? rows.slice(1) : rows;
  if (!body.length) return '';
  const w = [];
  for (const row of rows) row.forEach((c, i) => { w[i] = Math.max(w[i] || 0, String(c).length); });
  return body.map((row) => row.map((c, i) => (i === row.length - 1 ? String(c) : String(c).padEnd(w[i] + 3))).join('').replace(/\s+$/, '')).join('\n') + '\n';
}

export function kindPrefix(r) {
  return r.group ? `${r.singular || r.kind.toLowerCase()}.${r.group}` : (r.singular || r.kind.toLowerCase());
}

// ------------------------------------------------------------------ custom-columns
export function customColumns(spec, items) {
  const defs = spec.split(',').map((d) => {
    const i = d.indexOf(':');
    if (i < 0) throw new Error(`expected <header>:<json-path-expr>, got ${d}`);
    let p = d.slice(i + 1).trim();
    if (!p.startsWith('{')) p = `{${p.startsWith('.') ? p : '.' + p}}`;
    return { h: d.slice(0, i), p };
  });
  const rows = [defs.map((d) => d.h)];
  for (const o of items) {
    rows.push(defs.map((d) => {
      let v;
      try { v = jsonpath(d.p.replace(/\[\*\]/g, '[*]'), o); } catch { v = ''; }
      if (v === '' || v === undefined) return '<none>';
      return String(v).replace(/ /g, ',');
    }));
  }
  return rows;
}

export { none, nodeStatus, nodeRoles, jobStatus, accessModes, svcPorts, hpaTargets, quotaCols, fmtMem, parseQty };
