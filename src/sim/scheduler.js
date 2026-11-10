// kube-scheduler: filtrowanie węzłów, wybór, zdarzenia FailedScheduling.
import { parseQty, matchReqs, matchLabelSelector } from '../lib/util.js';

function nodeReady(n) {
  return n.status?.conditions?.find((x) => x.type === 'Ready')?.status === 'True';
}

export function tolerates(tols, taint) {
  return (tols || []).some((t) => {
    if (t.effect && t.effect !== taint.effect) return false;
    if (!t.key) return t.operator === 'Exists';
    if (t.key !== taint.key) return false;
    if (t.operator === 'Exists') return true;
    return (t.value || '') === (taint.value || '');
  });
}

function nodeTaints(n) {
  const taints = [...(n.spec?.taints || [])];
  if (n.spec?.unschedulable && !taints.some((t) => t.key === 'node.kubernetes.io/unschedulable')) taints.push({ key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' });
  if (!nodeReady(n) && !taints.some((t) => t.key === 'node.kubernetes.io/not-ready' || t.key === 'node.kubernetes.io/unreachable')) {
    taints.push({ key: 'node.kubernetes.io/not-ready', effect: 'NoSchedule' });
  }
  return taints;
}

function termMatches(term, node) {
  const exprs = (term.matchExpressions || []).map((e) => ({ key: e.key, op: e.operator, values: e.values || [] }));
  if (!matchReqs(exprs, node.metadata.labels || {})) return false;
  for (const f of term.matchFields || []) {
    const v = f.key === 'metadata.name' ? node.metadata.name : undefined;
    if (!matchReqs([{ key: 'f', op: f.operator, values: f.values || [] }], v === undefined ? {} : { f: v })) return false;
  }
  return true;
}

export function nodeAffinityMatches(spec, node) {
  for (const [k, v] of Object.entries(spec.nodeSelector || {})) if ((node.metadata.labels || {})[k] !== v) return false;
  const req = spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
  if (req && (req.nodeSelectorTerms || []).length) {
    if (!req.nodeSelectorTerms.some((t) => termMatches(t, node))) return false;
  }
  return true;
}

export function podRequests(spec) {
  let cpu = 0, mem = 0;
  for (const ct of spec.containers || []) {
    cpu += parseQty(ct.resources?.requests?.cpu) || 0;
    mem += parseQty(ct.resources?.requests?.memory) || 0;
  }
  // init: maksimum z init kontenerów (sidecary sumowane)
  let icpu = 0, imem = 0, scpu = 0, smem = 0;
  for (const ct of spec.initContainers || []) {
    const c1 = parseQty(ct.resources?.requests?.cpu) || 0, m1 = parseQty(ct.resources?.requests?.memory) || 0;
    if (ct.restartPolicy === 'Always') { scpu += c1; smem += m1; } else { icpu = Math.max(icpu, c1 + scpu); imem = Math.max(imem, m1 + smem); }
  }
  return { cpu: Math.max(cpu + scpu, icpu), mem: Math.max(mem + smem, imem) };
}

function allocatable(n) {
  return { cpu: parseQty(n.status?.allocatable?.cpu) || 2, mem: parseQty(n.status?.allocatable?.memory) || 4 * 2 ** 30, pods: parseQty(n.status?.allocatable?.pods) || 110 };
}

export function nodeUsage(c, nodeName) {
  let cpu = 0, mem = 0, pods = 0;
  for (const p of c.all('pods')) {
    if (p.spec?.nodeName !== nodeName) continue;
    if (p.status?.phase === 'Succeeded' || p.status?.phase === 'Failed') continue;
    const r = podRequests(p.spec);
    cpu += r.cpu; mem += r.mem; pods++;
  }
  return { cpu, mem, pods };
}

function podAffinityOk(c, pod, node) {
  const aff = pod.spec.affinity;
  if (!aff) return { ok: true };
  const nodes = c.all('nodes');
  const topo = (n, key) => (n.metadata.labels || {})[key];
  const podsIn = (term, ns) => c.all('pods').filter((p) => p.spec.nodeName && p.metadata.uid !== pod.metadata.uid
    && (term.namespaces?.length ? term.namespaces.includes(p.metadata.namespace) : p.metadata.namespace === ns)
    && term.labelSelector && matchLabelSelector(term.labelSelector, p.metadata.labels || {}));
  for (const term of aff.podAffinity?.requiredDuringSchedulingIgnoredDuringExecution || []) {
    const matching = podsIn(term, pod.metadata.namespace);
    const v = topo(node, term.topologyKey);
    if (!matching.some((p) => topo(nodes.find((n) => n.metadata.name === p.spec.nodeName) || { metadata: {} }, term.topologyKey) === v)) return { ok: false, why: "didn't match pod affinity rules" };
  }
  for (const term of aff.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution || []) {
    const matching = podsIn(term, pod.metadata.namespace);
    const v = topo(node, term.topologyKey);
    if (v !== undefined && matching.some((p) => topo(nodes.find((n) => n.metadata.name === p.spec.nodeName) || { metadata: {} }, term.topologyKey) === v)) return { ok: false, why: "didn't match pod anti-affinity rules" };
  }
  return { ok: true };
}

// sprawdza PVC poda; zwraca {ok, why, node?}
function volumesOk(c, pod, node) {
  for (const v of pod.spec.volumes || []) {
    if (!v.persistentVolumeClaim) continue;
    const pvc = c.peek('persistentvolumeclaims', pod.metadata.namespace, v.persistentVolumeClaim.claimName);
    if (!pvc) return { ok: false, global: `persistentvolumeclaim "${v.persistentVolumeClaim.claimName}" not found` };
    if (pvc.metadata.deletionTimestamp) return { ok: false, global: `persistentvolumeclaim "${pvc.metadata.name}" is being deleted` };
    if (pvc.status?.phase !== 'Bound') {
      const sc = pvc.spec.storageClassName ? c.peek('storageclasses', null, pvc.spec.storageClassName) : null;
      if (sc?.volumeBindingMode === 'WaitForFirstConsumer') continue;
      return { ok: false, global: 'pod has unbound immediate PersistentVolumeClaims' };
    }
    const pv = c.peek('persistentvolumes', null, pvc.spec.volumeName);
    const req = pv?.spec?.nodeAffinity?.required;
    if (req && !(req.nodeSelectorTerms || []).some((t) => termMatches(t, node))) return { ok: false, why: "had volume node affinity conflict" };
  }
  return { ok: true };
}

export const schedulerController = {
  name: 'scheduler',
  run(c) {
    if (!c.comp?.scheduler) return false;
    let changed = false;
    const nodes = c.all('nodes');
    const pending = c.all('pods').filter((p) => !p.spec?.nodeName && !p.metadata.deletionTimestamp && (p.spec?.schedulerName || 'default-scheduler') === 'default-scheduler')
      .sort((a, b) => (b.spec.priority || 0) - (a.spec.priority || 0) || Date.parse(a.metadata.creationTimestamp) - Date.parse(b.metadata.creationTimestamp));
    for (const pod of pending) {
      const reasons = {};
      const add = (r) => { reasons[r] = (reasons[r] || 0) + 1; };
      let global = null;
      const feasible = [];
      const req = podRequests(pod.spec);
      for (const n of nodes) {
        const taints = nodeTaints(n).filter((t) => t.effect === 'NoSchedule' || t.effect === 'NoExecute');
        const bad = taints.find((t) => !tolerates(pod.spec.tolerations, t));
        if (bad) { add(`node(s) had untolerated taint {${bad.key}: ${bad.value || ''}}`); continue; }
        if (!nodeAffinityMatches(pod.spec, n)) { add("node(s) didn't match Pod's node affinity/selector"); continue; }
        const vol = volumesOk(c, pod, n);
        if (!vol.ok) { if (vol.global) { global = vol.global; break; } add(`node(s) ${vol.why}`); continue; }
        const pa = podAffinityOk(c, pod, n);
        if (!pa.ok) { add(`node(s) ${pa.why}`); continue; }
        const alloc = allocatable(n), used = nodeUsage(c, n.metadata.name);
        if (used.pods + 1 > alloc.pods) { add('Too many pods'); continue; }
        const shortCpu = used.cpu + req.cpu > alloc.cpu + 1e-9;
        const shortMem = used.mem + req.mem > alloc.mem;
        if (shortCpu || shortMem) { if (shortCpu) add('Insufficient cpu'); if (shortMem) add('Insufficient memory'); continue; }
        feasible.push({ n, used, alloc });
      }
      if (global || !feasible.length) {
        const total = nodes.length;
        const parts = Object.entries(reasons).map(([r, n]) => `${n} ${r}`).sort();
        const msg = global ? `0/${total} nodes are available: ${global}. preemption: 0/${total} nodes are available: ${total} Preemption is not helpful for scheduling.`
          : total === 0 ? 'no nodes available to schedule pods'
            : `0/${total} nodes are available: ${parts.join(', ')}. preemption: 0/${total} nodes are available: ${preemptionMsg(reasons, total)}.`;
        const cond = pod.status?.conditions?.find((x) => x.type === 'PodScheduled');
        if (!cond || cond.message !== msg) {
          pod.status = { ...(pod.status || {}), phase: 'Pending', conditions: [{ lastProbeTime: null, lastTransitionTime: c.iso(), message: msg, reason: 'Unschedulable', status: 'False', type: 'PodScheduled' }] };
          c.put(pod);
          c.event(pod, 'Warning', 'FailedScheduling', msg, 'default-scheduler');
          changed = true;
        }
        continue;
      }
      // wybór: najmniej obciążony, potem rozproszenie podów tego samego właściciela
      const owner = pod.metadata.ownerReferences?.[0]?.uid;
      const sameOwner = (name) => c.all('pods').filter((p) => p.spec.nodeName === name && owner && p.metadata.ownerReferences?.[0]?.uid === owner).length;
      feasible.sort((a, b) => (sameOwner(a.n.metadata.name) - sameOwner(b.n.metadata.name)) || ((a.used.cpu + req.cpu) / a.alloc.cpu + (a.used.mem + req.mem) / a.alloc.mem) - ((b.used.cpu + req.cpu) / b.alloc.cpu + (b.used.mem + req.mem) / b.alloc.mem) || a.n.metadata.name.localeCompare(b.n.metadata.name));
      const target = feasible[0].n.metadata.name;
      // PVC z WaitForFirstConsumer -> wskazanie węzła
      for (const v of pod.spec.volumes || []) {
        if (!v.persistentVolumeClaim) continue;
        const pvc = c.peek('persistentvolumeclaims', pod.metadata.namespace, v.persistentVolumeClaim.claimName);
        if (pvc && pvc.status?.phase !== 'Bound' && !pvc.metadata.annotations?.['volume.kubernetes.io/selected-node']) {
          pvc.metadata.annotations = { ...(pvc.metadata.annotations || {}), 'volume.kubernetes.io/selected-node': target };
          c.put(pvc);
        }
      }
      pod.spec.nodeName = target;
      pod.status = { ...(pod.status || {}), phase: 'Pending', conditions: [{ lastProbeTime: null, lastTransitionTime: c.iso(), status: 'True', type: 'PodScheduled' }] };
      c.put(pod);
      c.event(pod, 'Normal', 'Scheduled', `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${target}`, 'default-scheduler');
      changed = true;
    }
    return changed;
  },
};

function preemptionMsg(reasons, total) {
  const noVictims = Object.entries(reasons).filter(([r]) => r.startsWith('Insufficient')).reduce((s, [, n]) => s + n, 0);
  const notHelpful = total - Math.min(total, noVictims);
  const parts = [];
  if (notHelpful) parts.push(`${notHelpful} Preemption is not helpful for scheduling`);
  if (noVictims) parts.push(`${Math.min(total, noVictims)} No preemption victims found for incoming pod`);
  return parts.join(', ');
}

export { nodeReady, nodeTaints };
