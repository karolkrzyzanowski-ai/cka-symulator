// `kubectl describe` - formaty zbliżone do describerów kubectl.
import { age, humanDuration, labelsString, selectorString, b64dec, parseQty } from '../lib/util.js';
import { podStatus, nodeStatus, accessModes, hpaTargets } from './printers.js';
import { podReady } from '../sim/controllers.js';

// ------------------------------------------------------------------ tabwriter (Go, padding 2)
export function tabwrite(text, padding = 2) {
  const lines = text.split('\n');
  const rows = lines.map((l) => l.split('\t'));
  const widths = rows.map(() => []);
  const maxCols = Math.max(...rows.map((r) => r.length));
  for (let j = 0; j < maxCols - 1; j++) {
    let i = 0;
    while (i < rows.length) {
      if (rows[i].length > j + 1) {
        const start = i;
        let w = 0;
        while (i < rows.length && rows[i].length > j + 1) { w = Math.max(w, rows[i][j].length); i++; }
        for (let k = start; k < i; k++) widths[k][j] = w + padding;
      } else i++;
    }
  }
  return rows.map((r, i) => r.map((cell, j) => (j < r.length - 1 ? cell.padEnd(widths[i][j]) : cell)).join('')).join('\n');
}

class W {
  constructor() { this.buf = []; }
  // poziom wcięcia (0,1,2...) jak PrefixWriter kubectl
  w(level, fmt) { this.buf.push('  '.repeat(level) + fmt); }
  kv(level, k, v) { this.w(level, `${k}:\t${v}`); }
  toString() { return tabwrite(this.buf.join('\n')) + '\n'; }
}

const rfc1123 = (iso) => {
  if (!iso) return '<unset>';
  const d = new Date(iso);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getUTCDay()]}, ${String(d.getUTCDate()).padStart(2, '0')} ${mons[d.getUTCMonth()]} ${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)} +0000`;
};

function mapLines(w, level, title, m, { sep = '=', sortKeys = true } = {}) {
  const entries = Object.entries(m || {});
  if (!entries.length) { w.kv(level, title, '<none>'); return; }
  if (sortKeys) entries.sort(([a], [b]) => a.localeCompare(b));
  entries.forEach(([k, v], i) => {
    const val = sep === '=' ? `${k}=${v}` : `${k}: ${String(v).length > 200 ? String(v).slice(0, 200) + '...' : v}`;
    if (i === 0) w.kv(level, title, val); else w.w(level, `\t${val}`);
  });
}

function annotationsFiltered(m) {
  const o = { ...(m || {}) };
  delete o['kubectl.kubernetes.io/last-applied-configuration'];
  return o;
}

function eventsBlock(w, c, obj) {
  const evs = c.eventsFor(obj);
  if (!evs.length) { w.kv(0, 'Events', '<none>'); return; }
  w.w(0, 'Events:');
  w.w(1, 'Type\tReason\tAge\tFrom\tMessage');
  w.w(1, '----\t------\t----\t----\t-------');
  const now = c.now();
  for (const e of evs.slice(-25)) {
    const a = e.count > 1 ? `${age(e.lastTimestamp, now)} (x${e.count} over ${age(e.firstTimestamp, now)})` : age(e.lastTimestamp || e.metadata.creationTimestamp, now);
    w.w(1, `${e.type}\t${e.reason}\t${a}\t${e.source?.component || e.reportingComponent || ''}\t${e.message}`);
  }
}

function header(w, o, { ns = true } = {}) {
  w.kv(0, 'Name', o.metadata.name);
  if (ns && o.metadata.namespace) w.kv(0, 'Namespace', o.metadata.namespace);
}

// ------------------------------------------------------------------ kontenery
function resourceLines(w, lvl, res) {
  for (const k of ['limits', 'requests']) {
    if (!res?.[k] || !Object.keys(res[k]).length) continue;
    w.w(lvl, `${k[0].toUpperCase()}${k.slice(1)}:`);
    for (const [r, v] of Object.entries(res[k]).sort()) w.kv(lvl + 1, r, v);
  }
}
function envLines(w, lvl, ct, c, ns) {
  const env = ct.env || [], from = ct.envFrom || [];
  if (!env.length && !from.length) { w.kv(lvl, 'Environment', '<none>'); return; }
  if (from.length) {
    w.w(lvl, 'Environment Variables from:');
    for (const f of from) {
      if (f.configMapRef) w.w(lvl + 1, `${f.configMapRef.name}\tConfigMap\tOptional: ${!!f.configMapRef.optional}`);
      if (f.secretRef) w.w(lvl + 1, `${f.secretRef.name}\tSecret\tOptional: ${!!f.secretRef.optional}`);
    }
  }
  if (!env.length) { w.kv(lvl, 'Environment', '<none>'); return; }
  w.w(lvl, 'Environment:');
  for (const e of env) {
    if (e.value !== undefined) w.kv(lvl + 1, e.name, e.value);
    else if (e.valueFrom?.configMapKeyRef) w.kv(lvl + 1, e.name, `<set to the key '${e.valueFrom.configMapKeyRef.key}' of config map '${e.valueFrom.configMapKeyRef.name}'>\tOptional: ${!!e.valueFrom.configMapKeyRef.optional}`);
    else if (e.valueFrom?.secretKeyRef) w.kv(lvl + 1, e.name, `<set to the key '${e.valueFrom.secretKeyRef.key}' in secret '${e.valueFrom.secretKeyRef.name}'>\tOptional: ${!!e.valueFrom.secretKeyRef.optional}`);
    else if (e.valueFrom?.fieldRef) w.kv(lvl + 1, e.name, ` (${e.valueFrom.fieldRef.apiVersion || 'v1'}:${e.valueFrom.fieldRef.fieldPath})`);
    else if (e.valueFrom?.resourceFieldRef) w.kv(lvl + 1, e.name, `${e.valueFrom.resourceFieldRef.resource} (${e.valueFrom.resourceFieldRef.containerName || ct.name})`);
    else w.kv(lvl + 1, e.name, '');
  }
  void c; void ns;
}
function probeLine(p) {
  const t = `delay=${p.initialDelaySeconds || 0}s timeout=${p.timeoutSeconds || 1}s period=${p.periodSeconds || 10}s #success=${p.successThreshold || 1} #failure=${p.failureThreshold || 3}`;
  if (p.httpGet) return `http-get ${(p.httpGet.scheme || 'HTTP').toLowerCase()}://${p.httpGet.host || ''}:${p.httpGet.port}${p.httpGet.path || '/'} ${t}`;
  if (p.tcpSocket) return `tcp-socket :${p.tcpSocket.port} ${t}`;
  if (p.exec) return `exec [${(p.exec.command || []).join(' ')}] ${t}`;
  if (p.grpc) return `grpc <pod>:${p.grpc.port} ${p.grpc.service || ''} ${t}`;
  return t;
}
function stateLines(w, lvl, title, s) {
  if (!s || !Object.keys(s).length) { w.kv(lvl, title, 'Waiting'); return; }
  if (s.running) { w.kv(lvl, title, 'Running'); w.kv(lvl + 1, 'Started', rfc1123(s.running.startedAt)); return; }
  if (s.waiting) { w.kv(lvl, title, 'Waiting'); w.kv(lvl + 1, 'Reason', s.waiting.reason || ''); if (s.waiting.message) w.kv(lvl + 1, 'Message', s.waiting.message); return; }
  if (s.terminated) {
    const t = s.terminated;
    w.kv(lvl, title, 'Terminated');
    w.kv(lvl + 1, 'Reason', t.reason || '');
    if (t.message) w.kv(lvl + 1, 'Message', t.message);
    w.kv(lvl + 1, 'Exit Code', t.exitCode);
    w.kv(lvl + 1, 'Started', rfc1123(t.startedAt));
    w.kv(lvl + 1, 'Finished', rfc1123(t.finishedAt));
  }
}
function containerBlock(w, lvl, ct, cs, pod, { template = false, c } = {}) {
  w.w(lvl, `${ct.name}:`);
  const l = lvl + 1;
  if (!template) w.kv(l, 'Container ID', cs?.containerID || '');
  w.kv(l, 'Image', ct.image);
  if (!template) w.kv(l, 'Image ID', cs?.imageID || '');
  const ports = (ct.ports || []);
  if (ports.length > 1) {
    w.kv(l, 'Ports', ports.map((p) => `${p.containerPort}/${p.protocol || 'TCP'}${p.name ? ` (${p.name})` : ''}`).join(', '));
    w.kv(l, 'Host Ports', ports.map((p) => `${p.hostPort || 0}/${p.protocol || 'TCP'}${p.name ? ` (${p.name})` : ''}`).join(', '));
  } else {
    w.kv(l, 'Port', ports[0] ? `${ports[0].containerPort}/${ports[0].protocol || 'TCP'}${ports[0].name ? ` (${ports[0].name})` : ''}` : '<none>');
    w.kv(l, 'Host Port', ports[0] ? `${ports[0].hostPort || 0}/${ports[0].protocol || 'TCP'}${ports[0].name ? ` (${ports[0].name})` : ''}` : '<none>');
  }
  if (ct.command) { w.w(l, 'Command:'); for (const x of ct.command) w.w(l + 1, x); }
  if (ct.args) { w.w(l, 'Args:'); for (const x of ct.args) w.w(l + 1, x); }
  if (!template) {
    stateLines(w, l, 'State', cs?.state);
    if (cs?.lastState && Object.keys(cs.lastState).length) stateLines(w, l, 'Last State', cs.lastState);
    w.kv(l, 'Ready', cs?.ready ? 'True' : 'False');
    w.kv(l, 'Restart Count', cs?.restartCount || 0);
  }
  if (ct.restartPolicy) w.kv(l, 'Restart Policy', ct.restartPolicy);
  resourceLines(w, l, ct.resources);
  if (ct.livenessProbe) w.kv(l, 'Liveness', probeLine(ct.livenessProbe));
  if (ct.readinessProbe) w.kv(l, 'Readiness', probeLine(ct.readinessProbe));
  if (ct.startupProbe) w.kv(l, 'Startup', probeLine(ct.startupProbe));
  envLines(w, l, ct, c, pod?.metadata?.namespace);
  const mounts = ct.volumeMounts || [];
  if (!mounts.length) w.kv(l, 'Mounts', '<none>');
  else {
    w.w(l, 'Mounts:');
    for (const m of mounts) w.w(l + 1, `${m.mountPath} from ${m.name} (${m.readOnly ? 'ro' : 'rw'}${m.subPath ? `,path="${m.subPath}"` : ''})`);
  }
}
function volumeLines(w, lvl, vols) {
  if (!vols?.length) { w.kv(lvl, 'Volumes', '<none>'); return; }
  w.w(lvl, 'Volumes:');
  const l = lvl + 1;
  for (const v of vols) {
    w.w(l, `${v.name}:`);
    const k = l + 1;
    if (v.emptyDir) { w.kv(k, 'Type', 'EmptyDir (a temporary directory that shares a pod\'s lifetime)'); w.kv(k, 'Medium', v.emptyDir.medium || ''); w.kv(k, 'SizeLimit', v.emptyDir.sizeLimit || '<unset>'); } else if (v.configMap) { w.kv(k, 'Type', 'ConfigMap (a volume populated by a ConfigMap)'); w.kv(k, 'Name', v.configMap.name); w.kv(k, 'Optional', !!v.configMap.optional); } else if (v.secret) { w.kv(k, 'Type', 'Secret (a volume populated by a Secret)'); w.kv(k, 'SecretName', v.secret.secretName); w.kv(k, 'Optional', !!v.secret.optional); } else if (v.hostPath) { w.kv(k, 'Type', 'HostPath (bare host directory volume)'); w.kv(k, 'Path', v.hostPath.path); w.kv(k, 'HostPathType', v.hostPath.type || ''); } else if (v.persistentVolumeClaim) { w.kv(k, 'Type', 'PersistentVolumeClaim (a reference to a PersistentVolumeClaim in the same namespace)'); w.kv(k, 'ClaimName', v.persistentVolumeClaim.claimName); w.kv(k, 'ReadOnly', !!v.persistentVolumeClaim.readOnly); } else if (v.projected) {
      w.kv(k, 'Type', 'Projected (a volume that contains injected data from multiple sources)');
      for (const s of v.projected.sources || []) {
        if (s.serviceAccountToken) w.kv(k, 'TokenExpirationSeconds', s.serviceAccountToken.expirationSeconds || 3607);
        if (s.configMap) { w.kv(k, 'ConfigMapName', s.configMap.name); w.kv(k, 'Optional', !!s.configMap.optional); }
        if (s.downwardAPI) w.kv(k, 'DownwardAPI', 'true');
      }
    } else if (v.nfs) { w.kv(k, 'Type', 'NFS (an NFS mount that lasts the lifetime of a pod)'); w.kv(k, 'Server', v.nfs.server); w.kv(k, 'Path', v.nfs.path); w.kv(k, 'ReadOnly', !!v.nfs.readOnly); } else if (v.downwardAPI) w.kv(k, 'Type', 'DownwardAPI (a volume populated by information about the pod)');
    else w.kv(k, 'Type', 'Unknown');
  }
}
function tolerationLines(w, lvl, tols) {
  if (!tols?.length) { w.kv(lvl, 'Tolerations', '<none>'); return; }
  tols.forEach((t, i) => {
    let s = t.key || '';
    if (t.value) s += `=${t.value}`;
    if (t.effect) s += `:${t.effect}`;
    if (t.operator === 'Exists' && !t.key) s = t.effect ? `:${t.effect} op=Exists` : 'op=Exists';
    else if (t.operator === 'Exists') s += ' op=Exists';
    if (t.tolerationSeconds !== undefined) s += ` for ${t.tolerationSeconds}s`;
    if (i === 0) w.kv(lvl, 'Tolerations', s); else w.w(lvl, `\t${s}`);
  });
}
function podTemplate(w, tpl, c) {
  w.w(0, 'Pod Template:');
  mapLines(w, 1, 'Labels', tpl.metadata?.labels);
  if (tpl.metadata?.annotations && Object.keys(tpl.metadata.annotations).length) mapLines(w, 1, 'Annotations', tpl.metadata.annotations, { sep: ':' });
  if (tpl.spec.serviceAccountName && tpl.spec.serviceAccountName !== 'default') w.kv(1, 'Service Account', tpl.spec.serviceAccountName);
  if (tpl.spec.initContainers?.length) { w.w(1, 'Init Containers:'); for (const ct of tpl.spec.initContainers) containerBlock(w, 2, ct, null, null, { template: true, c }); }
  w.w(1, 'Containers:');
  for (const ct of tpl.spec.containers || []) containerBlock(w, 2, ct, null, null, { template: true, c });
  volumeLines(w, 1, tpl.spec.volumes);
  w.kv(1, 'Node-Selectors', labelsString(tpl.spec.nodeSelector));
  tolerationLines(w, 1, tpl.spec.tolerations);
}

// ------------------------------------------------------------------ describery
const D = {};

D.Pod = (c, p) => {
  const w = new W();
  header(w, p);
  w.kv(0, 'Priority', p.spec.priority ?? 0);
  if (p.spec.priorityClassName) w.kv(0, 'Priority Class Name', p.spec.priorityClassName);
  if (p.spec.runtimeClassName) w.kv(0, 'Runtime Class Name', p.spec.runtimeClassName);
  w.kv(0, 'Service Account', p.spec.serviceAccountName || 'default');
  const nodeIp = c.peek('nodes', null, p.spec.nodeName)?.status?.addresses?.find((a) => a.type === 'InternalIP')?.address;
  w.kv(0, 'Node', p.spec.nodeName ? `${p.spec.nodeName}/${nodeIp || ''}` : '<none>');
  if (p.status?.startTime) w.kv(0, 'Start Time', rfc1123(p.status.startTime));
  mapLines(w, 0, 'Labels', p.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(p.metadata.annotations), { sep: ':' });
  const ps = podStatus(p);
  if (p.metadata.deletionTimestamp) {
    w.kv(0, 'Status', `Terminating (lasts ${humanDuration(Math.max(0, c.now() - Date.parse(p.metadata.deletionTimestamp) + (p.metadata.deletionGracePeriodSeconds || 30) * 1000))})`);
    w.kv(0, 'Termination Grace Period', `${p.metadata.deletionGracePeriodSeconds ?? 30}s`);
  } else w.kv(0, 'Status', p.status?.phase || 'Pending');
  if (p.status?.reason) w.kv(0, 'Reason', p.status.reason);
  if (p.status?.message) w.kv(0, 'Message', p.status.message);
  if (p.spec.securityContext?.seccompProfile) w.kv(0, 'SeccompProfile', p.spec.securityContext.seccompProfile.type);
  w.kv(0, 'IP', p.status?.podIP || '');
  if (p.status?.podIP) { w.w(0, 'IPs:'); w.kv(1, 'IP', p.status.podIP); } else w.kv(0, 'IPs', '<none>');
  const ctrl = (p.metadata.ownerReferences || []).find((o) => o.controller);
  if (ctrl) w.kv(0, 'Controlled By', `${ctrl.kind}/${ctrl.name}`);
  if (p.status?.nominatedNodeName) w.kv(0, 'NominatedNodeName', p.status.nominatedNodeName);
  if (p.spec.initContainers?.length) {
    w.w(0, 'Init Containers:');
    for (const ct of p.spec.initContainers) containerBlock(w, 1, ct, (p.status?.initContainerStatuses || []).find((s) => s.name === ct.name), p, { c });
  }
  w.w(0, 'Containers:');
  for (const ct of p.spec.containers || []) containerBlock(w, 1, ct, (p.status?.containerStatuses || []).find((s) => s.name === ct.name), p, { c });
  const conds = p.status?.conditions || [];
  if (conds.length) {
    w.w(0, 'Conditions:');
    w.w(1, 'Type\tStatus');
    const order = ['PodReadyToStartContainers', 'Initialized', 'Ready', 'ContainersReady', 'PodScheduled'];
    for (const t of order) { const x = conds.find((y) => y.type === t); if (x) w.w(1, `${x.type} \t${x.status} `); }
    for (const x of conds) if (!order.includes(x.type)) w.w(1, `${x.type} \t${x.status} `);
  }
  volumeLines(w, 0, p.spec.volumes);
  w.kv(0, 'QoS Class', p.status?.qosClass || 'BestEffort');
  w.kv(0, 'Node-Selectors', labelsString(p.spec.nodeSelector));
  tolerationLines(w, 0, p.spec.tolerations);
  eventsBlock(w, c, p);
  void ps;
  return w.toString();
};

function replicasLine(o) {
  return `${o.spec.replicas ?? 1} desired | ${o.status?.updatedReplicas || 0} updated | ${o.status?.replicas || 0} total | ${o.status?.availableReplicas || 0} available | ${o.status?.unavailableReplicas || 0} unavailable`;
}

D.Deployment = (c, d) => {
  const w = new W();
  header(w, d);
  w.kv(0, 'CreationTimestamp', rfc1123(d.metadata.creationTimestamp));
  mapLines(w, 0, 'Labels', d.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(d.metadata.annotations), { sep: ':' });
  w.kv(0, 'Selector', selectorString(d.spec.selector));
  w.kv(0, 'Replicas', replicasLine(d));
  w.kv(0, 'StrategyType', d.spec.strategy?.type || 'RollingUpdate');
  w.kv(0, 'MinReadySeconds', d.spec.minReadySeconds || 0);
  if ((d.spec.strategy?.type || 'RollingUpdate') === 'RollingUpdate') {
    const ru = d.spec.strategy?.rollingUpdate || {};
    w.kv(0, 'RollingUpdateStrategy', `${ru.maxUnavailable ?? '25%'} max unavailable, ${ru.maxSurge ?? '25%'} max surge`);
  }
  podTemplate(w, d.spec.template, c);
  const conds = d.status?.conditions || [];
  if (conds.length) {
    w.w(0, 'Conditions:');
    w.w(1, 'Type\tStatus\tReason');
    w.w(1, '----\t------\t------');
    for (const x of conds) w.w(1, `${x.type} \t${x.status}\t${x.reason || ''}`);
  }
  const rss = c.all('replicasets', d.metadata.namespace).filter((r) => (r.metadata.ownerReferences || []).some((o) => o.uid === d.metadata.uid));
  const tplHash = d.status?.__newRS;
  const newRs = rss.find((r) => r.metadata.annotations?.['deployment.kubernetes.io/revision'] === d.metadata.annotations?.['deployment.kubernetes.io/revision']) || rss.find((r) => r.metadata.name === tplHash);
  const old = rss.filter((r) => r !== newRs && (r.spec.replicas || 0) > 0);
  w.kv(0, 'OldReplicaSets', old.length ? old.map((r) => `${r.metadata.name} (${r.status?.replicas || 0}/${r.spec.replicas} replicas created)`).join(', ') : '<none>');
  w.kv(0, 'NewReplicaSet', newRs ? `${newRs.metadata.name} (${newRs.status?.replicas || 0}/${newRs.spec.replicas} replicas created)` : '<none>');
  eventsBlock(w, c, d);
  return w.toString();
};

function ownedPodsStatus(c, o) {
  const pods = c.all('pods', o.metadata.namespace).filter((p) => (p.metadata.ownerReferences || []).some((r) => r.uid === o.metadata.uid));
  const cnt = (ph) => pods.filter((p) => (p.status?.phase || 'Pending') === ph).length;
  return `${cnt('Running')} Running / ${cnt('Pending')} Waiting / ${cnt('Succeeded')} Succeeded / ${cnt('Failed')} Failed`;
}

D.ReplicaSet = (c, r) => {
  const w = new W();
  header(w, r);
  w.kv(0, 'Selector', selectorString(r.spec.selector));
  mapLines(w, 0, 'Labels', r.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(r.metadata.annotations), { sep: ':' });
  const ctrl = (r.metadata.ownerReferences || []).find((o) => o.controller);
  if (ctrl) w.kv(0, 'Controlled By', `${ctrl.kind}/${ctrl.name}`);
  w.kv(0, 'Replicas', `${r.status?.replicas || 0} current / ${r.spec.replicas ?? 1} desired`);
  w.kv(0, 'Pods Status', ownedPodsStatus(c, r));
  podTemplate(w, r.spec.template, c);
  const conds = r.status?.conditions || [];
  if (conds.length) { w.w(0, 'Conditions:'); w.w(1, 'Type\tStatus\tReason'); w.w(1, '----\t------\t------'); for (const x of conds) w.w(1, `${x.type} \t${x.status}\t${x.reason || ''}`); }
  eventsBlock(w, c, r);
  return w.toString();
};

D.StatefulSet = (c, s) => {
  const w = new W();
  header(w, s);
  w.kv(0, 'CreationTimestamp', rfc1123(s.metadata.creationTimestamp));
  w.kv(0, 'Selector', selectorString(s.spec.selector));
  mapLines(w, 0, 'Labels', s.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(s.metadata.annotations), { sep: ':' });
  w.kv(0, 'Replicas', `${s.spec.replicas ?? 1} desired | ${s.status?.replicas || 0} total`);
  w.kv(0, 'Update Strategy', s.spec.updateStrategy?.type || 'RollingUpdate');
  if ((s.spec.updateStrategy?.type || 'RollingUpdate') === 'RollingUpdate') w.kv(1, 'Partition', s.spec.updateStrategy?.rollingUpdate?.partition || 0);
  w.kv(0, 'Pods Status', ownedPodsStatus(c, s));
  podTemplate(w, s.spec.template, c);
  const vct = s.spec.volumeClaimTemplates || [];
  if (!vct.length) w.kv(0, 'Volume Claims', '<none>');
  else {
    w.w(0, 'Volume Claims:');
    for (const v of vct) {
      w.kv(1, 'Name', v.metadata.name);
      w.kv(1, 'StorageClass', v.spec.storageClassName || '');
      mapLines(w, 1, 'Labels', v.metadata.labels);
      mapLines(w, 1, 'Annotations', v.metadata.annotations, { sep: ':' });
      w.kv(1, 'Capacity', v.spec.resources?.requests?.storage || '');
      w.kv(1, 'Access Modes', (v.spec.accessModes || []).join(', '));
    }
  }
  eventsBlock(w, c, s);
  return w.toString();
};

D.DaemonSet = (c, d) => {
  const w = new W();
  header(w, d);
  w.kv(0, 'Selector', selectorString(d.spec.selector));
  w.kv(0, 'Node-Selector', labelsString(d.spec.template.spec.nodeSelector));
  mapLines(w, 0, 'Labels', d.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(d.metadata.annotations), { sep: ':' });
  w.kv(0, 'Desired Number of Nodes Scheduled', d.status?.desiredNumberScheduled || 0);
  w.kv(0, 'Current Number of Nodes Scheduled', d.status?.currentNumberScheduled || 0);
  w.kv(0, 'Number of Nodes Scheduled with Up-to-date Pods', d.status?.updatedNumberScheduled || 0);
  w.kv(0, 'Number of Nodes Scheduled with Available Pods', d.status?.numberAvailable || 0);
  w.kv(0, 'Number of Nodes Misscheduled', d.status?.numberMisscheduled || 0);
  w.kv(0, 'Pods Status', ownedPodsStatus(c, d));
  podTemplate(w, d.spec.template, c);
  eventsBlock(w, c, d);
  return w.toString();
};

D.Job = (c, j) => {
  const w = new W();
  header(w, j);
  w.kv(0, 'Selector', selectorString(j.spec.selector));
  mapLines(w, 0, 'Labels', j.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(j.metadata.annotations), { sep: ':' });
  const ctrl = (j.metadata.ownerReferences || []).find((o) => o.controller);
  if (ctrl) w.kv(0, 'Controlled By', `${ctrl.kind}/${ctrl.name}`);
  w.kv(0, 'Parallelism', j.spec.parallelism ?? 1);
  w.kv(0, 'Completions', j.spec.completions ?? 1);
  w.kv(0, 'Completion Mode', j.spec.completionMode || 'NonIndexed');
  w.kv(0, 'Suspend', j.spec.suspend ? 'true' : 'false');
  w.kv(0, 'Backoff Limit', j.spec.backoffLimit ?? 6);
  if (j.spec.activeDeadlineSeconds) w.kv(0, 'Active Deadline Seconds', `${j.spec.activeDeadlineSeconds}s`);
  if (j.spec.ttlSecondsAfterFinished !== undefined) w.kv(0, 'TTL Seconds After Finished', j.spec.ttlSecondsAfterFinished);
  if (j.status?.startTime) w.kv(0, 'Start Time', rfc1123(j.status.startTime));
  if (j.status?.completionTime) { w.kv(0, 'Completed At', rfc1123(j.status.completionTime)); w.kv(0, 'Duration', humanDuration(Date.parse(j.status.completionTime) - Date.parse(j.status.startTime))); }
  w.kv(0, 'Pods Statuses', `${j.status?.active || 0} Active (${j.status?.ready || 0} Ready) / ${j.status?.succeeded || 0} Succeeded / ${j.status?.failed || 0} Failed`);
  podTemplate(w, j.spec.template, c);
  eventsBlock(w, c, j);
  return w.toString();
};

D.CronJob = (c, j) => {
  const w = new W();
  header(w, j);
  mapLines(w, 0, 'Labels', j.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(j.metadata.annotations), { sep: ':' });
  w.kv(0, 'Schedule', j.spec.schedule);
  w.kv(0, 'Concurrency Policy', j.spec.concurrencyPolicy || 'Allow');
  w.kv(0, 'Suspend', j.spec.suspend ? 'True' : 'False');
  w.kv(0, 'Successful Job History Limit', j.spec.successfulJobsHistoryLimit ?? 3);
  w.kv(0, 'Failed Job History Limit', j.spec.failedJobsHistoryLimit ?? 1);
  w.kv(0, 'Starting Deadline Seconds', j.spec.startingDeadlineSeconds ?? '<unset>');
  w.kv(0, 'Selector', '<unset>');
  const js = j.spec.jobTemplate.spec;
  w.kv(0, 'Parallelism', js.parallelism ?? '<unset>');
  w.kv(0, 'Completions', js.completions ?? '<unset>');
  if (js.activeDeadlineSeconds) w.kv(0, 'Active Deadline Seconds', `${js.activeDeadlineSeconds}s`);
  podTemplate(w, js.template, c);
  w.kv(0, 'Last Schedule Time', j.status?.lastScheduleTime ? rfc1123(j.status.lastScheduleTime) : '<unset>');
  w.kv(0, 'Active Jobs', (j.status?.active || []).map((a) => a.name).join(', ') || '<none>');
  eventsBlock(w, c, j);
  return w.toString();
};

D.Service = (c, s) => {
  const w = new W();
  header(w, s);
  mapLines(w, 0, 'Labels', s.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(s.metadata.annotations), { sep: ':' });
  w.kv(0, 'Selector', s.spec.selector ? labelsString(s.spec.selector) : '<none>');
  w.kv(0, 'Type', s.spec.type || 'ClusterIP');
  w.kv(0, 'IP Family Policy', s.spec.ipFamilyPolicy || 'SingleStack');
  w.kv(0, 'IP Families', (s.spec.ipFamilies || ['IPv4']).join(','));
  if (s.spec.type === 'ExternalName') w.kv(0, 'External Name', s.spec.externalName);
  else { w.kv(0, 'IP', s.spec.clusterIP); w.kv(0, 'IPs', (s.spec.clusterIPs || [s.spec.clusterIP]).join(',')); }
  const slices = c.all('endpointslices', s.metadata.namespace).filter((e) => e.metadata.labels?.['kubernetes.io/service-name'] === s.metadata.name);
  for (const p of s.spec.ports || []) {
    const name = p.name || '<unset>';
    w.kv(0, 'Port', `${name}\t${p.port}/${p.protocol || 'TCP'}`);
    w.kv(0, 'TargetPort', `${p.targetPort ?? p.port}/${p.protocol || 'TCP'}`);
    if (p.nodePort) w.kv(0, 'NodePort', `${name}\t${p.nodePort}/${p.protocol || 'TCP'}`);
    const eps = [];
    for (const es of slices) {
      const ep = (es.ports || []).find((x) => (x.name || '') === (p.name || ''));
      if (!ep) continue;
      for (const e of es.endpoints || []) if (e.conditions?.ready !== false) for (const a of e.addresses || []) eps.push(`${a}:${ep.port}`);
    }
    w.kv(0, 'Endpoints', eps.length ? (eps.length > 3 ? `${eps.slice(0, 3).join(',')} + ${eps.length - 3} more...` : eps.join(',')) : '');
  }
  w.kv(0, 'Session Affinity', s.spec.sessionAffinity || 'None');
  if (s.spec.type === 'NodePort' || s.spec.type === 'LoadBalancer') w.kv(0, 'External Traffic Policy', s.spec.externalTrafficPolicy || 'Cluster');
  w.kv(0, 'Internal Traffic Policy', s.spec.internalTrafficPolicy || 'Cluster');
  eventsBlock(w, c, s);
  return w.toString();
};

D.Node = (c, n) => {
  const w = new W();
  w.kv(0, 'Name', n.metadata.name);
  const roles = Object.keys(n.metadata.labels || {}).filter((k) => k.startsWith('node-role.kubernetes.io/')).map((k) => k.split('/')[1]);
  w.kv(0, 'Roles', roles.length ? roles.join(',') : '<none>');
  mapLines(w, 0, 'Labels', n.metadata.labels);
  mapLines(w, 0, 'Annotations', n.metadata.annotations, { sep: ':' });
  w.kv(0, 'CreationTimestamp', rfc1123(n.metadata.creationTimestamp));
  const taints = n.spec.taints || [];
  if (!taints.length) w.kv(0, 'Taints', '<none>');
  else taints.forEach((t, i) => { const s = `${t.key}${t.value ? '=' + t.value : ''}:${t.effect}`; if (i === 0) w.kv(0, 'Taints', s); else w.w(0, `\t${s}`); });
  w.kv(0, 'Unschedulable', n.spec.unschedulable ? 'true' : 'false');
  w.w(0, 'Lease:');
  w.kv(1, 'HolderIdentity', n.metadata.name);
  w.kv(1, 'AcquireTime', '<unset>');
  w.kv(1, 'RenewTime', rfc1123(c.iso()));
  w.w(0, 'Conditions:');
  w.w(1, 'Type\tStatus\tLastHeartbeatTime\tLastTransitionTime\tReason\tMessage');
  w.w(1, '----\t------\t-----------------\t------------------\t------\t-------');
  for (const x of n.status?.conditions || []) w.w(1, `${x.type} \t${x.status} \t${rfc1123(x.lastHeartbeatTime)} \t${rfc1123(x.lastTransitionTime)} \t${x.reason || ''} \t${x.message || ''}`);
  w.w(0, 'Addresses:');
  for (const a of n.status?.addresses || []) w.kv(1, a.type, a.address);
  for (const k of ['capacity', 'allocatable']) {
    w.w(0, `${k[0].toUpperCase()}${k.slice(1)}:`);
    for (const [r, v] of Object.entries(n.status?.[k] || {})) w.kv(1, r, v);
  }
  const ni = n.status?.nodeInfo || {};
  w.w(0, 'System Info:');
  w.kv(1, 'Machine ID', ni.machineID || '');
  w.kv(1, 'System UUID', ni.systemUUID || '');
  w.kv(1, 'Boot ID', ni.bootID || '');
  w.kv(1, 'Kernel Version', ni.kernelVersion || '');
  w.kv(1, 'OS Image', ni.osImage || '');
  w.kv(1, 'Operating System', 'linux');
  w.kv(1, 'Architecture', 'amd64');
  w.kv(1, 'Container Runtime Version', ni.containerRuntimeVersion || '');
  w.kv(1, 'Kubelet Version', ni.kubeletVersion || '');
  w.kv(1, 'Kube-Proxy Version', ni.kubeletVersion || '');
  if (n.spec.podCIDR) { w.kv(0, 'PodCIDR', n.spec.podCIDR); w.kv(0, 'PodCIDRs', (n.spec.podCIDRs || [n.spec.podCIDR]).join(',')); }
  const pods = c.all('pods').filter((p) => p.spec.nodeName === n.metadata.name && !['Succeeded', 'Failed'].includes(p.status?.phase));
  const cpuCap = parseQty(n.status?.allocatable?.cpu) || 1, memCap = parseQty(n.status?.allocatable?.memory) || 1;
  w.w(0, `Non-terminated Pods:\t(${pods.length} in total)`);
  w.w(1, 'Namespace\tName\tCPU Requests\tCPU Limits\tMemory Requests\tMemory Limits\tAge');
  w.w(1, '---------\t----\t------------\t----------\t---------------\t-------------\t---');
  let tot = { rc: 0, lc: 0, rm: 0, lm: 0 };
  const pct = (v, cap) => `${Math.floor((v / cap) * 100)}%`;
  const fmtC = (v) => (v ? `${Math.round(v * 1000)}m` : '0');
  const fmtM = (v) => (!v ? '0' : v % 1073741824 === 0 ? `${v / 1073741824}Gi` : v % 1048576 === 0 ? `${v / 1048576}Mi` : `${v}`);
  for (const p of pods) {
    let rc = 0, lc = 0, rm = 0, lm = 0;
    for (const ct of p.spec.containers || []) {
      rc += parseQty(ct.resources?.requests?.cpu) || 0; lc += parseQty(ct.resources?.limits?.cpu) || 0;
      rm += parseQty(ct.resources?.requests?.memory) || 0; lm += parseQty(ct.resources?.limits?.memory) || 0;
    }
    tot = { rc: tot.rc + rc, lc: tot.lc + lc, rm: tot.rm + rm, lm: tot.lm + lm };
    w.w(1, `${p.metadata.namespace}\t${p.metadata.name}\t${fmtC(rc)} (${pct(rc, cpuCap)})\t${fmtC(lc)} (${pct(lc, cpuCap)})\t${fmtM(rm)} (${pct(rm, memCap)})\t${fmtM(lm)} (${pct(lm, memCap)})\t${age(p.metadata.creationTimestamp, c.now())}`);
  }
  w.w(0, 'Allocated resources:');
  w.w(1, '(Total limits may be over 100 percent, i.e., overcommitted.)');
  w.w(1, 'Resource\tRequests\tLimits');
  w.w(1, '--------\t--------\t------');
  w.w(1, `cpu\t${fmtC(tot.rc)} (${pct(tot.rc, cpuCap)})\t${fmtC(tot.lc)} (${pct(tot.lc, cpuCap)})`);
  w.w(1, `memory\t${fmtM(tot.rm)} (${pct(tot.rm, memCap)})\t${fmtM(tot.lm)} (${pct(tot.lm, memCap)})`);
  w.w(1, 'ephemeral-storage\t0 (0%)\t0 (0%)');
  eventsBlock(w, c, n);
  void nodeStatus;
  return w.toString();
};

D.Namespace = (c, n) => {
  const w = new W();
  w.kv(0, 'Name', n.metadata.name);
  mapLines(w, 0, 'Labels', n.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(n.metadata.annotations), { sep: ':' });
  w.kv(0, 'Status', n.status?.phase || 'Active');
  w.w(0, '');
  const qs = c.all('resourcequotas', n.metadata.name);
  if (!qs.length) w.w(0, 'No resource quota.');
  for (const q of qs) {
    w.w(0, 'Resource Quotas');
    w.kv(1, 'Name', q.metadata.name);
    w.w(1, 'Resource\tUsed\tHard');
    w.w(1, '--------\t---\t---');
    for (const [k, v] of Object.entries(q.spec.hard || {}).sort()) w.w(1, `${k}\t${q.status?.used?.[k] ?? '0'}\t${v}`);
  }
  w.w(0, '');
  const lrs = c.all('limitranges', n.metadata.name);
  if (!lrs.length) w.w(0, 'No LimitRange resource.');
  for (const l of lrs) describeLimitsInto(w, l, 'Resource Limits');
  return w.toString();
};

function describeLimitsInto(w, l, title) {
  w.w(0, title);
  w.w(1, 'Type\tResource\tMin\tMax\tDefault Request\tDefault Limit\tMax Limit/Request Ratio');
  w.w(1, '----\t--------\t---\t---\t---------------\t-------------\t-----------------------');
  for (const it of l.spec.limits || []) {
    const res = new Set([...Object.keys(it.min || {}), ...Object.keys(it.max || {}), ...Object.keys(it.default || {}), ...Object.keys(it.defaultRequest || {})]);
    for (const r of [...res].sort()) w.w(1, `${it.type}\t${r}\t${it.min?.[r] || '-'}\t${it.max?.[r] || '-'}\t${it.defaultRequest?.[r] || '-'}\t${it.default?.[r] || '-'}\t${it.maxLimitRequestRatio?.[r] || '-'}`);
  }
}

D.LimitRange = (c, l) => { const w = new W(); header(w, l); describeLimitsInto(w, l, ''); w.buf.splice(2, 1); return w.toString(); };

D.ResourceQuota = (c, q) => {
  const w = new W();
  header(w, q);
  w.w(0, 'Resource\tUsed\tHard');
  w.w(0, '--------\t----\t----');
  for (const [k, v] of Object.entries(q.spec.hard || {}).sort()) w.w(0, `${k}\t${q.status?.used?.[k] ?? '0'}\t${v}`);
  return w.toString();
};

D.ConfigMap = (c, cm) => {
  const w = new W();
  header(w, cm);
  mapLines(w, 0, 'Labels', cm.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(cm.metadata.annotations), { sep: ':' });
  const lines = ['', 'Data', '===='];
  for (const [k, v] of Object.entries(cm.data || {}).sort()) lines.push(`${k}:`, '----', String(v), '');
  if (!Object.keys(cm.data || {}).length) lines.push('');
  lines.push('', 'BinaryData', '====', '');
  let out = w.toString() + lines.join('\n') + '\n';
  const evs = c.eventsFor(cm);
  out += evs.length ? '' : 'Events:  <none>\n';
  return out;
};

D.Secret = (c, s) => {
  const w = new W();
  header(w, s);
  mapLines(w, 0, 'Labels', s.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(s.metadata.annotations), { sep: ':' });
  w.w(0, '');
  w.kv(0, 'Type', s.type || 'Opaque');
  w.w(0, '');
  w.w(0, 'Data');
  w.w(0, '====');
  for (const [k, v] of Object.entries(s.data || {}).sort()) { let len = 0; try { len = new TextEncoder().encode(b64dec(v)).length; } catch { len = 0; } w.w(0, `${k}:\t${len} bytes`); }
  return w.toString();
};

D.ServiceAccount = (c, s) => {
  const w = new W();
  header(w, s);
  mapLines(w, 0, 'Labels', s.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(s.metadata.annotations), { sep: ':' });
  w.kv(0, 'Image pull secrets', (s.imagePullSecrets || []).map((x) => x.name).join(', ') || '<none>');
  w.kv(0, 'Mountable secrets', (s.secrets || []).map((x) => x.name).join(', ') || '<none>');
  w.kv(0, 'Tokens', '<none>');
  eventsBlock(w, c, s);
  return w.toString();
};

const describeRole = (c, r) => {
  const w = new W();
  w.kv(0, 'Name', r.metadata.name);
  mapLines(w, 0, 'Labels', r.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(r.metadata.annotations), { sep: ':' });
  w.w(0, 'PolicyRule:');
  w.w(1, 'Resources\tNon-Resource URLs\tResource Names\tVerbs');
  w.w(1, '---------\t-----------------\t--------------\t-----');
  const rows = [];
  for (const rule of r.rules || []) {
    const groups = rule.apiGroups || [''];
    for (const res of rule.resources || []) for (const g of groups) rows.push([g ? `${res}.${g}` : res, '[]', `[${(rule.resourceNames || []).join(' ')}]`, `[${(rule.verbs || []).join(' ')}]`]);
    if (rule.nonResourceURLs) rows.push(['', `[${rule.nonResourceURLs.join(' ')}]`, '[]', `[${(rule.verbs || []).join(' ')}]`]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  for (const x of rows) w.w(1, x.join('\t'));
  return w.toString();
};
D.Role = describeRole;
D.ClusterRole = describeRole;

const describeBinding = (c, b) => {
  const w = new W();
  w.kv(0, 'Name', b.metadata.name);
  mapLines(w, 0, 'Labels', b.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(b.metadata.annotations), { sep: ':' });
  w.w(0, 'Role:');
  w.kv(1, 'Kind', b.roleRef.kind);
  w.kv(1, 'Name', b.roleRef.name);
  w.w(0, 'Subjects:');
  w.w(1, 'Kind\tName\tNamespace');
  w.w(1, '----\t----\t---------');
  for (const s of b.subjects || []) w.w(1, `${s.kind}\t${s.name}\t${s.namespace || ''}`);
  return w.toString();
};
D.RoleBinding = describeBinding;
D.ClusterRoleBinding = describeBinding;

function peerLines(w, lvl, peers) {
  for (const p of peers) {
    if (p.ipBlock) { w.w(lvl, 'IPBlock:'); w.kv(lvl + 1, 'CIDR', p.ipBlock.cidr); w.kv(lvl + 1, 'Except', (p.ipBlock.except || []).join(', ')); continue; }
    if (p.namespaceSelector) w.kv(lvl, 'NamespaceSelector', selectorString(p.namespaceSelector) || '<none>');
    if (p.podSelector) w.kv(lvl, 'PodSelector', selectorString(p.podSelector) || '<none>');
    if (!p.podSelector && !p.namespaceSelector) w.w(lvl, '<any>');
  }
}
D.NetworkPolicy = (c, n) => {
  const w = new W();
  header(w, n);
  w.kv(0, 'Created on', `${n.metadata.creationTimestamp.replace('T', ' ').replace('Z', '')} +0000 UTC`);
  mapLines(w, 0, 'Labels', n.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(n.metadata.annotations), { sep: ':' });
  w.w(0, 'Spec:');
  w.kv(1, 'PodSelector', `${selectorString(n.spec.podSelector) || '<none>'} (${selectorString(n.spec.podSelector) ? 'Allowing the specific traffic to pods matching selector' : 'Allowing the specific traffic to all pods in this namespace'})`);
  const types = n.spec.policyTypes || ['Ingress'];
  if (types.includes('Ingress')) {
    w.w(1, 'Allowing ingress traffic:');
    const ing = n.spec.ingress || [];
    if (!ing.length) w.w(2, '<none> (Selected pods are isolated for ingress connectivity)');
    ing.forEach((r, i) => {
      if (i) w.w(2, '----------');
      const ports = r.ports || [];
      if (!ports.length) w.kv(2, 'To Port', '<any> (traffic allowed to all ports)');
      for (const p of ports) w.kv(2, 'To Port', `${p.port ?? '<any>'}${p.endPort ? `-${p.endPort}` : ''}/${p.protocol || 'TCP'}`);
      if (!(r.from || []).length) w.kv(2, 'From', '<any> (traffic not restricted by source)');
      else { w.w(2, 'From:'); peerLines(w, 3, r.from); }
    });
  } else w.w(1, 'Not affecting ingress traffic');
  if (types.includes('Egress')) {
    w.w(1, 'Allowing egress traffic:');
    const eg = n.spec.egress || [];
    if (!eg.length) w.w(2, '<none> (Selected pods are isolated for egress connectivity)');
    eg.forEach((r, i) => {
      if (i) w.w(2, '----------');
      const ports = r.ports || [];
      if (!ports.length) w.kv(2, 'To Port', '<any> (traffic allowed to all ports)');
      for (const p of ports) w.kv(2, 'To Port', `${p.port ?? '<any>'}${p.endPort ? `-${p.endPort}` : ''}/${p.protocol || 'TCP'}`);
      if (!(r.to || []).length) w.kv(2, 'To', '<any> (traffic not restricted by destination)');
      else { w.w(2, 'To:'); peerLines(w, 3, r.to); }
    });
  } else w.w(1, 'Not affecting egress traffic');
  w.kv(1, 'Policy Types', types.join(', '));
  return w.toString();
};

D.Ingress = (c, i) => {
  const w = new W();
  w.kv(0, 'Name', i.metadata.name);
  mapLines(w, 0, 'Labels', i.metadata.labels);
  w.kv(0, 'Namespace', i.metadata.namespace);
  w.kv(0, 'Address', (i.status?.loadBalancer?.ingress || []).map((a) => a.ip).join(','));
  w.kv(0, 'Ingress Class', i.spec.ingressClassName || '<none>');
  const be = (b) => {
    if (!b?.service) return '<default>';
    const svc = c.peek('services', i.metadata.namespace, b.service.name);
    const port = b.service.port?.number ?? b.service.port?.name;
    if (!svc) return `${b.service.name}:${port} (<error: services "${b.service.name}" not found>)`;
    const eps = [];
    for (const es of c.all('endpointslices', i.metadata.namespace).filter((e) => e.metadata.labels?.['kubernetes.io/service-name'] === svc.metadata.name)) for (const e of es.endpoints || []) for (const a of e.addresses || []) eps.push(`${a}:${(es.ports || [])[0]?.port}`);
    return `${b.service.name}:${port} (${eps.join(',')})`;
  };
  w.kv(0, 'Default backend', i.spec.defaultBackend ? be(i.spec.defaultBackend) : '<default>');
  if (i.spec.tls?.length) { w.w(0, 'TLS:'); for (const t of i.spec.tls) w.w(1, `${t.secretName} terminates ${(t.hosts || []).join(',')}`); }
  w.w(0, 'Rules:');
  w.w(1, 'Host\tPath\tBackends');
  w.w(1, '----\t----\t--------');
  for (const r of i.spec.rules || []) {
    w.w(1, `${r.host || '*'}\t\t`);
    for (const p of r.http?.paths || []) w.w(1, `\t${p.path || '/'}  \t${be(p.backend)}`);
  }
  mapLines(w, 0, 'Annotations', annotationsFiltered(i.metadata.annotations), { sep: ':' });
  eventsBlock(w, c, i);
  return w.toString();
};

D.HorizontalPodAutoscaler = (c, h) => {
  const w = new W();
  header(w, h);
  mapLines(w, 0, 'Labels', h.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(h.metadata.annotations), { sep: ':' });
  w.kv(0, 'CreationTimestamp', rfc1123(h.metadata.creationTimestamp));
  w.kv(0, 'Reference', `${h.spec.scaleTargetRef.kind}/${h.spec.scaleTargetRef.name}`);
  w.w(0, 'Metrics:\t( current / target )');
  for (const t of hpaTargets(h).split(', ')) {
    const [name, v] = t.split(': ');
    w.w(1, `resource ${name} on pods  (as a percentage of request):\t${(v || '').replace('/', ' / ')}`);
  }
  w.kv(0, 'Min replicas', h.spec.minReplicas ?? 1);
  w.kv(0, 'Max replicas', h.spec.maxReplicas);
  w.kv(0, `${h.spec.scaleTargetRef.kind} pods`, `${h.status?.currentReplicas ?? 0} current / ${h.status?.desiredReplicas ?? 0} desired`);
  const conds = h.status?.conditions || [];
  if (conds.length) {
    w.w(0, 'Conditions:');
    w.w(1, 'Type\tStatus\tReason\tMessage');
    w.w(1, '----\t------\t------\t-------');
    for (const x of conds) w.w(1, `${x.type}\t${x.status}\t${x.reason}\t${x.message}`);
  }
  eventsBlock(w, c, h);
  return w.toString();
};

D.PersistentVolume = (c, v) => {
  const w = new W();
  w.kv(0, 'Name', v.metadata.name);
  mapLines(w, 0, 'Labels', v.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(v.metadata.annotations), { sep: ':' });
  w.kv(0, 'Finalizers', `[${(v.metadata.finalizers || []).join(' ')}]`);
  w.kv(0, 'StorageClass', v.spec.storageClassName || '');
  w.kv(0, 'Status', v.status?.phase || 'Pending');
  w.kv(0, 'Claim', v.spec.claimRef ? `${v.spec.claimRef.namespace}/${v.spec.claimRef.name}` : '');
  w.kv(0, 'Reclaim Policy', v.spec.persistentVolumeReclaimPolicy || 'Retain');
  w.kv(0, 'Access Modes', accessModes(v.spec.accessModes));
  w.kv(0, 'VolumeMode', v.spec.volumeMode || 'Filesystem');
  w.kv(0, 'Capacity', v.spec.capacity?.storage || '');
  if (v.spec.nodeAffinity) {
    w.w(0, 'Node Affinity:');
    w.w(1, 'Required Terms:');
    for (const t of v.spec.nodeAffinity.required?.nodeSelectorTerms || []) w.w(2, `Term 0:        ${(t.matchExpressions || []).map((e) => `${e.key} ${e.operator.toLowerCase()} [${(e.values || []).join(', ')}]`).join(', ')}`);
  } else w.kv(0, 'Node Affinity', '<none>');
  w.kv(0, 'Message', v.status?.message || '');
  w.w(0, 'Source:');
  if (v.spec.hostPath) { w.kv(1, 'Type', 'HostPath (bare host directory volume)'); w.kv(1, 'Path', v.spec.hostPath.path); w.kv(1, 'HostPathType', v.spec.hostPath.type || ''); } else if (v.spec.local) { w.kv(1, 'Type', 'LocalVolume (a persistent volume backed by local storage on a node)'); w.kv(1, 'Path', v.spec.local.path); } else if (v.spec.nfs) { w.kv(1, 'Type', 'NFS (an NFS mount that lasts the lifetime of a pod)'); w.kv(1, 'Server', v.spec.nfs.server); w.kv(1, 'Path', v.spec.nfs.path); w.kv(1, 'ReadOnly', !!v.spec.nfs.readOnly); }
  eventsBlock(w, c, v);
  return w.toString();
};

D.PersistentVolumeClaim = (c, v) => {
  const w = new W();
  header(w, v);
  w.kv(0, 'StorageClass', v.spec.storageClassName ?? '');
  w.kv(0, 'Status', v.status?.phase || 'Pending');
  w.kv(0, 'Volume', v.spec.volumeName || '');
  mapLines(w, 0, 'Labels', v.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(v.metadata.annotations), { sep: ':' });
  w.kv(0, 'Finalizers', `[${(v.metadata.finalizers || []).join(' ')}]`);
  w.kv(0, 'Capacity', v.status?.capacity?.storage || '');
  w.kv(0, 'Access Modes', accessModes(v.status?.accessModes || []));
  w.kv(0, 'VolumeMode', v.spec.volumeMode || 'Filesystem');
  const users = c.all('pods', v.metadata.namespace).filter((p) => (p.spec.volumes || []).some((x) => x.persistentVolumeClaim?.claimName === v.metadata.name)).map((p) => p.metadata.name);
  w.kv(0, 'Used By', users.length ? users.join('\n\t') : '<none>');
  eventsBlock(w, c, v);
  return w.toString();
};

D.StorageClass = (c, s) => {
  const w = new W();
  w.kv(0, 'Name', s.metadata.name);
  w.kv(0, 'IsDefaultClass', s.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' ? 'Yes' : 'No');
  w.kv(0, 'Annotations', Object.entries(annotationsFiltered(s.metadata.annotations)).map(([k, x]) => `${k}=${x}`).join(',') || '<none>');
  w.kv(0, 'Provisioner', s.provisioner);
  w.kv(0, 'Parameters', Object.entries(s.parameters || {}).map(([k, x]) => `${k}=${x}`).join(',') || '<none>');
  w.kv(0, 'AllowVolumeExpansion', s.allowVolumeExpansion === undefined ? '<unset>' : String(s.allowVolumeExpansion));
  w.kv(0, 'MountOptions', '<none>');
  w.kv(0, 'ReclaimPolicy', s.reclaimPolicy || 'Delete');
  w.kv(0, 'VolumeBindingMode', s.volumeBindingMode || 'Immediate');
  eventsBlock(w, c, s);
  return w.toString();
};

D.PriorityClass = (c, p) => {
  const w = new W();
  w.kv(0, 'Name', p.metadata.name);
  w.kv(0, 'Value', p.value);
  w.kv(0, 'GlobalDefault', String(!!p.globalDefault));
  w.kv(0, 'PreemptionPolicy', p.preemptionPolicy || 'PreemptLowerPriority');
  w.kv(0, 'Description', p.description || '');
  mapLines(w, 0, 'Annotations', annotationsFiltered(p.metadata.annotations), { sep: ':' });
  eventsBlock(w, c, p);
  return w.toString();
};

D.Endpoints = (c, e) => {
  const w = new W();
  header(w, e);
  mapLines(w, 0, 'Labels', e.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(e.metadata.annotations), { sep: ':' });
  w.w(0, 'Subsets:');
  for (const s of e.subsets || []) {
    w.kv(1, 'Addresses', (s.addresses || []).map((a) => a.ip).join(',') || '<none>');
    w.kv(1, 'NotReadyAddresses', (s.notReadyAddresses || []).map((a) => a.ip).join(',') || '<none>');
    w.w(1, 'Ports:');
    w.w(2, 'Name\tPort\tProtocol');
    w.w(2, '----\t----\t--------');
    for (const p of s.ports || []) w.w(2, `${p.name || '<unset>'}\t${p.port}\t${p.protocol || 'TCP'}`);
  }
  eventsBlock(w, c, e);
  return w.toString();
};

D.CertificateSigningRequest = (c, r) => {
  const w = new W();
  w.kv(0, 'Name', r.metadata.name);
  mapLines(w, 0, 'Labels', r.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(r.metadata.annotations), { sep: ':' });
  w.kv(0, 'CreationTimestamp', rfc1123(r.metadata.creationTimestamp));
  w.kv(0, 'Requesting User', r.spec.username || '');
  w.kv(0, 'Signer', r.spec.signerName);
  if (r.spec.expirationSeconds) w.kv(0, 'Requested Duration', humanDuration(r.spec.expirationSeconds * 1000));
  const conds = (r.status?.conditions || []).map((x) => x.type);
  w.kv(0, 'Status', conds.length ? conds.join(',') + (r.status?.certificate ? ',Issued' : '') : 'Pending');
  w.w(0, 'Subject:');
  w.kv(1, 'Common Name', r.__cn || '');
  w.kv(1, 'Serial Number', '');
  if (r.__o) w.kv(1, 'Organization', r.__o);
  eventsBlock(w, c, r);
  return w.toString();
};

// --------------------------------------------------------------- ogólny (CR, CRD, inne)
const title = (k) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (s) => s.toUpperCase()).replace(/\bU I D\b/, 'UID').replace(/Ip\b/g, 'IP');
function genericValue(w, lvl, v) {
  if (Array.isArray(v)) {
    for (const it of v) {
      if (it && typeof it === 'object') { genericObj(w, lvl, it); } else w.w(lvl, String(it));
    }
    return;
  }
  genericObj(w, lvl, v);
}
function genericObj(w, lvl, o) {
  for (const [k, v] of Object.entries(o).sort(([a], [b]) => a.localeCompare(b))) {
    if (v && typeof v === 'object') {
      if (Array.isArray(v) && !v.length) continue;
      w.w(lvl, `${title(k)}:`);
      genericValue(w, lvl + 1, v);
    } else w.kv(lvl, title(k), v === null ? '<nil>' : String(v));
  }
}
function genericDescribe(c, o) {
  const w = new W();
  header(w, o);
  mapLines(w, 0, 'Labels', o.metadata.labels);
  mapLines(w, 0, 'Annotations', annotationsFiltered(o.metadata.annotations), { sep: ':' });
  w.kv(0, 'API Version', o.apiVersion);
  w.kv(0, 'Kind', o.kind);
  const meta = { ...o.metadata };
  for (const k of ['name', 'namespace', 'labels', 'annotations']) delete meta[k];
  w.w(0, 'Metadata:');
  genericObj(w, 1, meta);
  for (const [k, v] of Object.entries(o)) {
    if (['apiVersion', 'kind', 'metadata'].includes(k)) continue;
    if (v && typeof v === 'object') { w.w(0, `${title(k)}:`); genericValue(w, 1, v); } else w.kv(0, title(k), String(v));
  }
  eventsBlock(w, c, o);
  return w.toString();
}

export function describe(c, r, o) {
  const fn = D[r.kind];
  if (fn && !r.crd) return fn(c, o);
  return genericDescribe(c, o);
}

export { rfc1123, podReady };
