// Kontrolery (kube-controller-manager + local-path-provisioner).
import { clone, randSuffix, safeHash, matchLabelSelector, parseQty, deepEqual, b64dec, sortKeys } from '../lib/util.js';
import { nextRun } from './cron.js';
import { podQuotaRequest, quotaUsage } from './admission.js';
import { parsePem, makeCert } from './pki.js';
import { podMetrics } from './kubelet.js';

const kcmUp = (c) => !!c.comp?.kcm;

function ownerRef(o, controller = true) {
  return { apiVersion: o.apiVersion, blockOwnerDeletion: true, controller, kind: o.kind, name: o.metadata.name, uid: o.metadata.uid };
}
const ownedBy = (o, owner) => (o.metadata.ownerReferences || []).some((r) => r.uid === owner.metadata.uid && r.controller);

function podReady(p) {
  return p.status?.phase === 'Running' && p.status?.conditions?.find((x) => x.type === 'Ready')?.status === 'True' && !p.metadata.deletionTimestamp;
}
const podActive = (p) => !p.metadata.deletionTimestamp && !['Succeeded', 'Failed'].includes(p.status?.phase);

function intOrPercent(v, total, roundUp) {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return v;
  const s = String(v);
  if (s.endsWith('%')) {
    const x = (parseFloat(s) / 100) * total;
    return roundUp ? Math.ceil(x) : Math.floor(x);
  }
  return parseInt(s, 10) || 0;
}

// tworzenie poda z szablonu (z obsługą błędów admission jako zdarzenie FailedCreate)
function createPod(c, owner, template, { name, generateName, extraLabels = {}, extra = {} }) {
  const pod = {
    apiVersion: 'v1', kind: 'Pod',
    metadata: {
      ...(name ? { name } : { generateName }), namespace: owner.metadata.namespace,
      labels: { ...(template.metadata?.labels || {}), ...extraLabels },
      annotations: template.metadata?.annotations ? { ...template.metadata.annotations } : undefined,
      ownerReferences: [ownerRef(owner)],
    },
    spec: { ...clone(template.spec), ...extra },
  };
  if (!pod.metadata.annotations) delete pod.metadata.annotations;
  try {
    const p = c.create(pod, { user: null });
    c.event(owner, 'Normal', 'SuccessfulCreate', `Created pod: ${p.metadata.name}`, `${owner.kind.toLowerCase()}-controller`);
    return p;
  } catch (e) {
    const key = `${owner.metadata.uid}:fc`;
    c.failBackoff = c.failBackoff || {};
    c.failBackoff[key] = c.now();
    c.event(owner, 'Warning', 'FailedCreate', `Error creating: ${e.message}`, `${owner.kind.toLowerCase()}-controller`);
    return null;
  }
}

function inFailBackoff(c, owner) {
  const t = c.failBackoff?.[`${owner.metadata.uid}:fc`];
  return t && c.now() - t < 10000;
}

function deletePod(c, p, owner) {
  c.doDelete(c.res('pods'), p);
  if (owner) c.event(owner, 'Normal', 'SuccessfulDelete', `Deleted pod: ${p.metadata.name}`, `${owner.kind.toLowerCase()}-controller`);
}

// ============================================================================== ReplicaSet
const replicaSetCtrl = {
  name: 'replicaset',
  run(c) {
    if (!kcmUp(c)) return false;
    let changed = false;
    const allPods = c.all('pods');
    for (const rs of c.all('replicasets')) {
      if (rs.metadata.deletionTimestamp) continue;
      const pods = allPods.filter((p) => p.metadata.namespace === rs.metadata.namespace && ownedBy(p, rs));
      const active = pods.filter(podActive);
      const want = rs.spec.replicas ?? 1;
      if (active.length < want && !inFailBackoff(c, rs)) {
        for (let i = active.length; i < want; i++) {
          if (!createPod(c, rs, rs.spec.template, { generateName: `${rs.metadata.name}-` })) break;
          changed = true;
        }
      } else if (active.length > want) {
        const ranked = [...active].sort((a, b) => rank(a) - rank(b) || Date.parse(b.metadata.creationTimestamp) - Date.parse(a.metadata.creationTimestamp));
        for (const p of ranked.slice(0, active.length - want)) { deletePod(c, p, rs); changed = true; }
      }
      const fresh = c.all('pods', rs.metadata.namespace).filter((p) => ownedBy(p, rs));
      const status = {
        replicas: fresh.filter(podActive).length,
        fullyLabeledReplicas: fresh.filter(podActive).length,
        readyReplicas: fresh.filter(podReady).length,
        availableReplicas: fresh.filter(podReady).length,
        terminatingReplicas: fresh.filter((p) => p.metadata.deletionTimestamp).length,
        observedGeneration: rs.metadata.generation,
      };
      for (const k of ['readyReplicas', 'availableReplicas', 'terminatingReplicas']) if (!status[k]) delete status[k];
      if (!status.fullyLabeledReplicas) delete status.fullyLabeledReplicas;
      const fc = c.failBackoff?.[`${rs.metadata.uid}:fc`];
      if (fc && c.now() - fc < 60000 && status.replicas < want) {
        const ev = c.eventsFor(rs).filter((e) => e.reason === 'FailedCreate').pop();
        status.conditions = [{ lastTransitionTime: c.iso(fc), message: ev?.message?.replace(/^Error creating: /, '') || 'failed to create pods', reason: 'FailedCreate', status: 'True', type: 'ReplicaFailure' }];
      }
      if (!deepEqual(status, rs.status)) { rs.status = status; c.put(rs); changed = true; }
    }
    return changed;
  },
};
function rank(p) {
  if (!p.spec.nodeName) return 0;
  if (p.status?.phase === 'Pending') return 1;
  if (!podReady(p)) return 2;
  return 3;
}

// ============================================================================== Deployment
function templateHash(tpl) {
  const t = clone(tpl);
  if (t.metadata?.labels) delete t.metadata.labels['pod-template-hash'];
  return safeHash(JSON.stringify(sortKeys(t)), 10);
}

const deploymentCtrl = {
  name: 'deployment',
  run(c) {
    if (!kcmUp(c)) return false;
    let changed = false;
    for (const d of c.all('deployments')) {
      if (d.metadata.deletionTimestamp) continue;
      if (syncDeployment(c, d)) changed = true;
    }
    return changed;
  },
};

function syncDeployment(c, d) {
  let changed = false;
  const ns = d.metadata.namespace;
  const rss = c.all('replicasets', ns).filter((rs) => ownedBy(rs, d));
  const hash = templateHash(d.spec.template);
  let newRS = rss.find((rs) => rs.metadata.labels?.['pod-template-hash'] === hash);
  const maxRev = Math.max(0, ...rss.map((rs) => Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] || 0)));
  const replicas = d.spec.replicas ?? 1;
  if (d.spec.paused) { return updateDeployStatus(c, d, rss, newRS); }
  if (!newRS) {
    const tpl = clone(d.spec.template);
    tpl.metadata = tpl.metadata || {};
    tpl.metadata.labels = { ...(tpl.metadata.labels || {}), 'pod-template-hash': hash };
    const ann = { 'deployment.kubernetes.io/desired-replicas': String(replicas), 'deployment.kubernetes.io/max-replicas': String(replicas + intOrPercent(d.spec.strategy?.rollingUpdate?.maxSurge, replicas, true)), 'deployment.kubernetes.io/revision': String(maxRev + 1) };
    if (d.metadata.annotations?.['kubernetes.io/change-cause']) ann['kubernetes.io/change-cause'] = d.metadata.annotations['kubernetes.io/change-cause'];
    const rs = {
      apiVersion: 'apps/v1', kind: 'ReplicaSet',
      metadata: { name: `${d.metadata.name}-${hash}`, namespace: ns, labels: { ...(d.spec.template.metadata?.labels || {}), 'pod-template-hash': hash }, annotations: ann, ownerReferences: [ownerRef(d)] },
      spec: { replicas: 0, selector: { matchLabels: { ...(d.spec.selector.matchLabels || {}), 'pod-template-hash': hash }, ...(d.spec.selector.matchExpressions ? { matchExpressions: d.spec.selector.matchExpressions } : {}) }, template: tpl },
    };
    try {
      newRS = c.create(rs, { user: null });
      c.event(d, 'Normal', 'ScalingReplicaSet', `Scaled up replica set ${newRS.metadata.name} from 0 to ${d.spec.strategy?.type === 'Recreate' ? replicas : Math.min(replicas, 1)}`, 'deployment-controller');
      rss.push(newRS);
      changed = true;
    } catch (e) {
      // istnieje już RS o tej nazwie (np. powrót do starej rewizji) - przejmij
      newRS = c.peek('replicasets', ns, rs.metadata.name);
      if (!newRS) return changed;
    }
  } else {
    // rollback do starej rewizji -> nowy numer rewizji
    const rev = Number(newRS.metadata.annotations?.['deployment.kubernetes.io/revision'] || 0);
    if (rev < maxRev) {
      newRS.metadata.annotations['deployment.kubernetes.io/revision'] = String(maxRev + 1);
      const hist = newRS.metadata.annotations['deployment.kubernetes.io/revision-history'];
      newRS.metadata.annotations['deployment.kubernetes.io/revision-history'] = hist ? `${hist},${rev}` : String(rev);
      if (d.metadata.annotations?.['kubernetes.io/change-cause']) newRS.metadata.annotations['kubernetes.io/change-cause'] = d.metadata.annotations['kubernetes.io/change-cause'];
      c.put(newRS);
      changed = true;
    }
    if (newRS.metadata.annotations?.['deployment.kubernetes.io/desired-replicas'] !== String(replicas)) {
      newRS.metadata.annotations['deployment.kubernetes.io/desired-replicas'] = String(replicas);
      c.put(newRS);
    }
  }
  const old = rss.filter((rs) => rs.metadata.uid !== newRS.metadata.uid);
  const podsOf = (rs) => c.all('pods', ns).filter((p) => ownedBy(p, rs));
  const avail = (rs) => podsOf(rs).filter(podReady).length;
  const scale = (rs, n, why) => {
    const cur = rs.spec.replicas ?? 0;
    if (cur === n) return;
    const r = c.peek('replicasets', ns, rs.metadata.name);
    if (!r) return;
    r.spec.replicas = n;
    c.put(r);
    rs.spec.replicas = n;
    c.event(d, 'Normal', 'ScalingReplicaSet', `Scaled ${n > cur ? 'up' : 'down'} replica set ${rs.metadata.name} from ${cur} to ${n}`, 'deployment-controller');
    changed = true;
    void why;
  };
  if (d.spec.strategy?.type === 'Recreate') {
    for (const rs of old) scale(rs, 0);
    const oldPods = old.flatMap(podsOf).filter((p) => !['Succeeded', 'Failed'].includes(p.status?.phase));
    if (!oldPods.length) scale(newRS, replicas);
  } else {
    const ru = d.spec.strategy?.rollingUpdate || {};
    const maxSurge = intOrPercent(ru.maxSurge ?? '25%', replicas, true);
    let maxUnavail = intOrPercent(ru.maxUnavailable ?? '25%', replicas, false);
    if (maxSurge === 0 && maxUnavail === 0) maxUnavail = 1;
    const oldTotal = old.reduce((s, rs) => s + (rs.spec.replicas ?? 0), 0);
    if (!old.length || oldTotal === 0) {
      scale(newRS, replicas);
    } else {
      // skalowanie w górę nowego RS
      const total = oldTotal + (newRS.spec.replicas ?? 0);
      const maxTotal = replicas + maxSurge;
      if ((newRS.spec.replicas ?? 0) < replicas && total < maxTotal) {
        scale(newRS, Math.min(replicas, (newRS.spec.replicas ?? 0) + (maxTotal - total)));
      } else if ((newRS.spec.replicas ?? 0) > replicas) scale(newRS, replicas);
      // skalowanie w dół starych (najpierw niedostępne)
      const minAvail = replicas - maxUnavail;
      const newAvail = avail(newRS);
      let oldAvail = old.reduce((s, rs) => s + avail(rs), 0);
      for (const rs of old.sort((a, b) => Date.parse(a.metadata.creationTimestamp) - Date.parse(b.metadata.creationTimestamp))) {
        const cur = rs.spec.replicas ?? 0;
        if (!cur) continue;
        const unavailInRs = cur - avail(rs);
        let canRemove = unavailInRs;
        const surplus = newAvail + oldAvail - minAvail;
        canRemove += Math.max(0, Math.min(surplus, avail(rs)));
        const totalNow = old.reduce((s, x) => s + (x.spec.replicas ?? 0), 0) + (newRS.spec.replicas ?? 0);
        if (totalNow <= replicas && unavailInRs === 0 && surplus <= 0) continue;
        const remove = Math.min(cur, Math.max(0, canRemove));
        if (remove > 0) {
          oldAvail -= Math.min(avail(rs), Math.max(0, remove - unavailInRs));
          scale(rs, cur - remove);
        }
      }
    }
  }
  // sprzątanie historii
  const limit = d.spec.revisionHistoryLimit ?? 10;
  const idle = old.filter((rs) => (rs.spec.replicas ?? 0) === 0 && !podsOf(rs).length)
    .sort((a, b) => Number(a.metadata.annotations?.['deployment.kubernetes.io/revision'] || 0) - Number(b.metadata.annotations?.['deployment.kubernetes.io/revision'] || 0));
  while (idle.length > limit) { const rs = idle.shift(); c.remove('replicasets', ns, rs.metadata.name); changed = true; }
  if (updateDeployStatus(c, d, c.all('replicasets', ns).filter((rs) => ownedBy(rs, d)), newRS)) changed = true;
  return changed;
}

function updateDeployStatus(c, d, rss, newRS) {
  const ns = d.metadata.namespace;
  const pods = c.all('pods', ns).filter((p) => rss.some((rs) => ownedBy(p, rs)));
  const active = pods.filter(podActive);
  const ready = pods.filter(podReady);
  const updated = newRS ? pods.filter((p) => ownedBy(p, newRS) && podActive(p)) : [];
  const replicas = d.spec.replicas ?? 1;
  const st = {
    observedGeneration: d.metadata.generation,
    replicas: active.length,
    updatedReplicas: updated.length,
    readyReplicas: ready.length,
    availableReplicas: ready.length,
    unavailableReplicas: Math.max(0, replicas - ready.length),
    terminatingReplicas: pods.filter((p) => p.metadata.deletionTimestamp).length,
  };
  for (const k of ['readyReplicas', 'availableReplicas', 'unavailableReplicas', 'updatedReplicas', 'terminatingReplicas', 'replicas']) if (!st[k]) delete st[k];
  const prev = d.status?.conditions || [];
  const pc = (t) => prev.find((x) => x.type === t);
  const now = c.iso();
  const availOk = ready.length >= replicas - intOrPercent(d.spec.strategy?.rollingUpdate?.maxUnavailable ?? '25%', replicas, false);
  const complete = updated.length === replicas && ready.length >= replicas && active.length === replicas;
  const started = pc('Progressing')?.lastTransitionTime;
  let progReason = complete ? 'NewReplicaSetAvailable' : 'ReplicaSetUpdated';
  let progStatus = 'True';
  const deadline = (d.spec.progressDeadlineSeconds ?? 600) * 1000;
  if (!complete && newRS && c.now() - Date.parse(newRS.metadata.creationTimestamp) > deadline) { progReason = 'ProgressDeadlineExceeded'; progStatus = 'False'; }
  const mk = (type, status, reason, message) => {
    const p = pc(type);
    return { lastTransitionTime: p && p.status === status ? p.lastTransitionTime : now, lastUpdateTime: p && p.status === status && p.reason === reason ? p.lastUpdateTime : now, message, reason, status, type };
  };
  st.conditions = [
    mk('Available', availOk ? 'True' : 'False', availOk ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable', availOk ? 'Deployment has minimum availability.' : 'Deployment does not have minimum availability.'),
    mk('Progressing', progStatus, progReason, progReason === 'NewReplicaSetAvailable' ? `ReplicaSet "${newRS?.metadata.name}" has successfully progressed.` : progReason === 'ProgressDeadlineExceeded' ? `ReplicaSet "${newRS?.metadata.name}" has timed out progressing.` : `ReplicaSet "${newRS?.metadata.name}" is progressing.`),
  ];
  void started;
  const strip = (s) => { const x = clone(s || {}); for (const cc of x.conditions || []) { delete cc.lastUpdateTime; delete cc.lastTransitionTime; } return x; };
  if (!deepEqual(strip(st), strip(d.status))) { d.status = st; return c.put(d); }
  return false;
}

// ============================================================================== StatefulSet
const statefulSetCtrl = {
  name: 'statefulset',
  run(c) {
    if (!kcmUp(c)) return false;
    let changed = false;
    for (const s of c.all('statefulsets')) {
      if (s.metadata.deletionTimestamp) continue;
      const ns = s.metadata.namespace;
      const want = s.spec.replicas ?? 1;
      const pods = c.all('pods', ns).filter((p) => ownedBy(p, s));
      const byOrd = {};
      for (const p of pods) byOrd[Number(p.metadata.name.slice(s.metadata.name.length + 1))] = p;
      const parallel = s.spec.podManagementPolicy === 'Parallel';
      const rev = `${s.metadata.name}-${safeHash(JSON.stringify(sortKeys(s.spec.template)), 10)}`;
      for (let i = 0; i < want; i++) {
        const p = byOrd[i];
        if (p) {
          if (p.status?.phase === 'Failed' || p.status?.phase === 'Succeeded') { c.remove('pods', ns, p.metadata.name); changed = true; break; }
          if (p.metadata.labels?.['controller-revision-hash'] !== rev && !p.metadata.deletionTimestamp && podReady(p) && Object.values(byOrd).every(podReady)) {
            deletePod(c, p, s); changed = true; break;
          }
          if (!parallel && !podReady(p)) break;
          continue;
        }
        if (inFailBackoff(c, s)) break;
        // PVC z szablonów
        for (const t of s.spec.volumeClaimTemplates || []) {
          const pvcName = `${t.metadata.name}-${s.metadata.name}-${i}`;
          if (!c.peek('persistentvolumeclaims', ns, pvcName)) {
            try {
              c.create({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace: ns, labels: { ...(s.spec.selector.matchLabels || {}) } }, spec: clone(t.spec) }, { user: null });
              c.event(s, 'Normal', 'SuccessfulCreate', `create Claim ${pvcName} Pod ${s.metadata.name}-${i} in StatefulSet ${s.metadata.name} success`, 'statefulset-controller');
            } catch { /* */ }
          }
        }
        const tpl = clone(s.spec.template);
        const vols = tpl.spec.volumes || [];
        for (const t of s.spec.volumeClaimTemplates || []) {
          if (!vols.some((v) => v.name === t.metadata.name)) vols.push({ name: t.metadata.name, persistentVolumeClaim: { claimName: `${t.metadata.name}-${s.metadata.name}-${i}` } });
        }
        tpl.spec.volumes = vols;
        const p2 = createPod(c, s, tpl, {
          name: `${s.metadata.name}-${i}`,
          extraLabels: { 'apps.kubernetes.io/pod-index': String(i), 'controller-revision-hash': rev, 'statefulset.kubernetes.io/pod-name': `${s.metadata.name}-${i}` },
          extra: { hostname: `${s.metadata.name}-${i}`, subdomain: s.spec.serviceName || undefined },
        });
        changed = changed || !!p2;
        if (!parallel) break;
      }
      // skalowanie w dół (od najwyższego)
      const extra = Object.keys(byOrd).map(Number).filter((i) => i >= want).sort((a, b) => b - a);
      for (const i of extra) {
        const p = byOrd[i];
        if (!p.metadata.deletionTimestamp) { deletePod(c, p, s); changed = true; }
        if (!parallel) break;
      }
      const fresh = c.all('pods', ns).filter((p) => ownedBy(p, s));
      const st = {
        availableReplicas: fresh.filter(podReady).length, collisionCount: 0, currentReplicas: fresh.filter(podActive).length,
        currentRevision: rev, observedGeneration: s.metadata.generation, readyReplicas: fresh.filter(podReady).length,
        replicas: fresh.filter(podActive).length, updateRevision: rev, updatedReplicas: fresh.filter((p) => p.metadata.labels?.['controller-revision-hash'] === rev && podActive(p)).length,
      };
      if (!st.readyReplicas) delete st.readyReplicas;
      if (!deepEqual(st, s.status)) { s.status = st; c.put(s); changed = true; }
    }
    return changed;
  },
};

// ============================================================================== DaemonSet
const daemonSetCtrl = {
  name: 'daemonset',
  run(c) {
    if (!kcmUp(c)) return false;
    let changed = false;
    const nodes = c.all('nodes');
    for (const ds of c.all('daemonsets')) {
      if (ds.metadata.deletionTimestamp) continue;
      const ns = ds.metadata.namespace;
      const pods = c.all('pods', ns).filter((p) => ownedBy(p, ds));
      const tpl = ds.spec.template;
      const tols = [...(tpl.spec.tolerations || []),
        { key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoExecute' }, { key: 'node.kubernetes.io/unreachable', operator: 'Exists', effect: 'NoExecute' },
        { key: 'node.kubernetes.io/disk-pressure', operator: 'Exists', effect: 'NoSchedule' }, { key: 'node.kubernetes.io/memory-pressure', operator: 'Exists', effect: 'NoSchedule' },
        { key: 'node.kubernetes.io/pid-pressure', operator: 'Exists', effect: 'NoSchedule' }, { key: 'node.kubernetes.io/unschedulable', operator: 'Exists', effect: 'NoSchedule' }];
      const eligible = nodes.filter((n) => {
        for (const t of n.spec?.taints || []) if ((t.effect === 'NoSchedule' || t.effect === 'NoExecute') && !tols.some((x) => (!x.key && x.operator === 'Exists') || (x.key === t.key && (!x.effect || x.effect === t.effect) && (x.operator === 'Exists' || (x.value || '') === (t.value || ''))))) return false;
        for (const [k, v] of Object.entries(tpl.spec.nodeSelector || {})) if (n.metadata.labels?.[k] !== v) return false;
        const req = tpl.spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
        if (req?.nodeSelectorTerms?.length && !req.nodeSelectorTerms.some((t) => (t.matchExpressions || []).every((e) => {
          const v = n.metadata.labels?.[e.key];
          return e.operator === 'In' ? (e.values || []).includes(v) : e.operator === 'NotIn' ? !(e.values || []).includes(v) : e.operator === 'Exists' ? v !== undefined : e.operator === 'DoesNotExist' ? v === undefined : true;
        }))) return false;
        return true;
      });
      const hash = safeHash(JSON.stringify(sortKeys(tpl)), 10);
      for (const n of eligible) {
        const mine = pods.filter((p) => podNode(p) === n.metadata.name && podActive(p));
        if (mine.length) {
          const p = mine[0];
          if (p.metadata.labels?.['controller-revision-hash'] !== hash && !p.metadata.deletionTimestamp) { deletePod(c, p, ds); changed = true; }
          continue;
        }
        if (pods.some((p) => podNode(p) === n.metadata.name && p.metadata.deletionTimestamp)) continue;
        if (inFailBackoff(c, ds)) break;
        const t2 = clone(tpl);
        t2.spec.tolerations = tols.filter((t, i) => i >= (tpl.spec.tolerations || []).length ? true : true);
        t2.spec.affinity = { ...(t2.spec.affinity || {}), nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchFields: [{ key: 'metadata.name', operator: 'In', values: [n.metadata.name] }] }] } } };
        if (createPod(c, ds, t2, { generateName: `${ds.metadata.name}-`, extraLabels: { 'controller-revision-hash': hash, 'pod-template-generation': String(ds.metadata.generation || 1) } })) changed = true;
      }
      for (const p of pods) {
        if (!eligible.some((n) => n.metadata.name === podNode(p)) && !p.metadata.deletionTimestamp) { deletePod(c, p, ds); changed = true; }
      }
      const fresh = c.all('pods', ns).filter((p) => ownedBy(p, ds) && podActive(p));
      const st = {
        currentNumberScheduled: fresh.filter((p) => p.spec.nodeName).length, desiredNumberScheduled: eligible.length,
        numberAvailable: fresh.filter(podReady).length, numberMisscheduled: 0, numberReady: fresh.filter(podReady).length,
        observedGeneration: ds.metadata.generation, updatedNumberScheduled: fresh.filter((p) => p.metadata.labels?.['controller-revision-hash'] === hash).length,
      };
      if (st.numberReady < st.desiredNumberScheduled) st.numberUnavailable = st.desiredNumberScheduled - st.numberReady;
      if (!st.numberAvailable) delete st.numberAvailable;
      if (!deepEqual(st, ds.status)) { ds.status = st; c.put(ds); changed = true; }
    }
    return changed;
  },
};
function podNode(p) {
  return p.spec.nodeName || p.spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms?.[0]?.matchFields?.[0]?.values?.[0];
}

// ============================================================================== Job / CronJob
const jobCtrl = {
  name: 'job',
  run(c) {
    if (!kcmUp(c)) return false;
    let changed = false;
    for (const j of c.all('jobs')) {
      if (j.metadata.deletionTimestamp) continue;
      const ns = j.metadata.namespace;
      const pods = c.all('pods', ns).filter((p) => ownedBy(p, j));
      const succeeded = pods.filter((p) => p.status?.phase === 'Succeeded').length;
      const failed = pods.filter((p) => p.status?.phase === 'Failed').length + (j.status?.uncountedFailed || 0);
      const active = pods.filter(podActive);
      const completions = j.spec.completions ?? 1;
      const done = j.status?.conditions?.some((x) => (x.type === 'Complete' || x.type === 'Failed') && x.status === 'True');
      const st = clone(j.status || {});
      const now = c.iso();
      if (!st.startTime && !j.spec.suspend) st.startTime = now;
      if (!done) {
        const deadline = j.spec.activeDeadlineSeconds && st.startTime && c.now() > Date.parse(st.startTime) + j.spec.activeDeadlineSeconds * 1000;
        if (succeeded >= completions) {
          st.conditions = [{ lastProbeTime: now, lastTransitionTime: now, message: 'Reached expected number of succeeded pods', reason: 'CompletionsReached', status: 'True', type: 'SuccessCriteriaMet' }, { lastProbeTime: now, lastTransitionTime: now, message: 'Reached expected number of succeeded pods', reason: 'CompletionsReached', status: 'True', type: 'Complete' }];
          st.completionTime = now;
          c.event(j, 'Normal', 'Completed', 'Job completed', 'job-controller');
        } else if (failed > (j.spec.backoffLimit ?? 6) || deadline) {
          const reason = deadline ? 'DeadlineExceeded' : 'BackoffLimitExceeded';
          const msg = deadline ? 'Job was active longer than specified deadline' : 'Job has reached the specified backoff limit';
          st.conditions = [{ lastProbeTime: now, lastTransitionTime: now, message: msg, reason, status: 'True', type: 'FailureTarget' }, { lastProbeTime: now, lastTransitionTime: now, message: msg, reason, status: 'True', type: 'Failed' }];
          for (const p of active) deletePod(c, p, null);
          c.event(j, 'Warning', reason, msg, 'job-controller');
        } else if (!j.spec.suspend) {
          const want = Math.min(j.spec.parallelism ?? 1, completions - succeeded);
          if (active.length < want && !inFailBackoff(c, j)) {
            // backoff po porażkach
            const lastFail = pods.filter((p) => p.status?.phase === 'Failed').map((p) => Date.parse(p.status?.containerStatuses?.[0]?.state?.terminated?.finishedAt || p.metadata.creationTimestamp)).sort().pop();
            const delay = failed ? Math.min(360, 10 * 2 ** (failed - 1)) * 1000 : 0;
            if (!lastFail || c.now() - lastFail >= delay) {
              for (let i = active.length; i < want; i++) {
                const p = createPod(c, j, j.spec.template, { generateName: `${j.metadata.name}-` });
                if (!p) break;
                changed = true;
              }
            }
          }
        }
      }
      st.active = c.all('pods', ns).filter((p) => ownedBy(p, j) && podActive(p)).length || undefined;
      st.succeeded = succeeded || undefined;
      st.failed = failed || undefined;
      st.ready = c.all('pods', ns).filter((p) => ownedBy(p, j) && podReady(p)).length;
      st.terminating = 0;
      st.uncountedTerminatedPods = {};
      for (const k of ['active', 'succeeded', 'failed']) if (st[k] === undefined) delete st[k];
      if (!deepEqual(st, j.status)) { j.status = st; c.put(j); changed = true; }
    }
    return changed;
  },
};

const cronJobCtrl = {
  name: 'cronjob',
  run(c) {
    if (!kcmUp(c)) return false;
    let changed = false;
    for (const cj of c.all('cronjobs')) {
      if (cj.spec.suspend || cj.metadata.deletionTimestamp) continue;
      const ns = cj.metadata.namespace;
      const jobs = c.all('jobs', ns).filter((j) => ownedBy(j, cj));
      const last = cj.status?.lastScheduleTime ? Date.parse(cj.status.lastScheduleTime) : Date.parse(cj.metadata.creationTimestamp);
      const next = nextRun(cj.spec.schedule, last);
      if (next && c.now() >= next) {
        const activeJobs = jobs.filter((j) => !j.status?.conditions?.some((x) => (x.type === 'Complete' || x.type === 'Failed') && x.status === 'True'));
        const st = clone(cj.status || {});
        st.lastScheduleTime = new Date(next).toISOString().replace('.000Z', 'Z');
        if (cj.spec.concurrencyPolicy === 'Forbid' && activeJobs.length) {
          c.event(cj, 'Normal', 'JobAlreadyActive', 'Not starting job because prior execution is running and concurrency policy is Forbid', 'cronjob-controller');
        } else {
          if (cj.spec.concurrencyPolicy === 'Replace') for (const j of activeJobs) c.doDelete(c.res('jobs'), j);
          const name = `${cj.metadata.name}-${Math.floor(next / 60000)}`;
          if (!c.peek('jobs', ns, name)) {
            try {
              const tpl = cj.spec.jobTemplate || {};
              c.create({ apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace: ns, labels: { ...(tpl.metadata?.labels || {}) }, annotations: { 'batch.kubernetes.io/cronjob-scheduled-timestamp': st.lastScheduleTime }, ownerReferences: [ownerRef(cj)] }, spec: clone(tpl.spec) }, { user: null });
              c.event(cj, 'Normal', 'SuccessfulCreate', `Created job ${name}`, 'cronjob-controller');
            } catch (e) {
              c.event(cj, 'Warning', 'FailedCreate', `Error creating job: ${e.message}`, 'cronjob-controller');
            }
          }
        }
        cj.status = st;
        c.put(cj);
        changed = true;
      }
      // historia
      const finished = (type) => jobs.filter((j) => j.status?.conditions?.some((x) => x.type === type && x.status === 'True')).sort((a, b) => Date.parse(a.metadata.creationTimestamp) - Date.parse(b.metadata.creationTimestamp));
      for (const [type, limit] of [['Complete', cj.spec.successfulJobsHistoryLimit ?? 3], ['Failed', cj.spec.failedJobsHistoryLimit ?? 1]]) {
        const list = finished(type);
        while (list.length > limit) { const j = list.shift(); c.doDelete(c.res('jobs'), j, { propagation: 'Background' }); changed = true; }
      }
      const active = c.all('jobs', ns).filter((j) => ownedBy(j, cj) && !j.status?.conditions?.some((x) => (x.type === 'Complete' || x.type === 'Failed') && x.status === 'True'));
      const st = clone(cj.status || {});
      if (active.length) st.active = active.map((j) => ({ apiVersion: 'batch/v1', kind: 'Job', name: j.metadata.name, namespace: ns, resourceVersion: j.metadata.resourceVersion, uid: j.metadata.uid })); else delete st.active;
      const lastOk = finished('Complete').pop();
      if (lastOk?.status?.completionTime) st.lastSuccessfulTime = lastOk.status.completionTime;
      if (!deepEqual(st, cj.status || {})) { cj.status = st; c.put(cj); changed = true; }
    }
    return changed;
  },
};

// ============================================================================== Endpoints / EndpointSlice
function resolveTargetPort(pod, sp) {
  const tp = sp.targetPort ?? sp.port;
  if (typeof tp === 'number' || /^\d+$/.test(String(tp))) return Number(tp);
  for (const ct of pod.spec.containers || []) for (const p of ct.ports || []) if (p.name === tp) return p.containerPort;
  return null;
}

const endpointsCtrl = {
  name: 'endpoints',
  run(c) {
    if (!kcmUp(c)) return false;
    let changed = false;
    const allPods = c.all('pods');
    for (const s of c.all('services')) {
      if (!s.spec?.selector || !Object.keys(s.spec.selector).length) continue;
      const ns = s.metadata.namespace;
      const pods = allPods.filter((p) => p.metadata.namespace === ns && p.status?.podIP && !['Succeeded', 'Failed'].includes(p.status?.phase) && Object.entries(s.spec.selector).every(([k, v]) => p.metadata.labels?.[k] === v));
      const ports = (s.spec.ports || []).map((sp) => ({ sp, num: pods.map((p) => resolveTargetPort(p, sp)).find((x) => x) ?? (typeof sp.targetPort === 'number' ? sp.targetPort : null) }));
      const eps = pods.filter((p) => ports.every((x) => x.num) || !ports.length).map((p) => {
        const ready = podReady(p) || (s.spec.publishNotReadyAddresses && !p.metadata.deletionTimestamp);
        return { addresses: [p.status.podIP], conditions: { ready, serving: ready || (podReady({ ...p, metadata: { ...p.metadata, deletionTimestamp: undefined } })), terminating: !!p.metadata.deletionTimestamp }, nodeName: p.spec.nodeName, targetRef: { kind: 'Pod', name: p.metadata.name, namespace: ns, uid: p.metadata.uid }, ...(p.spec.hostname && p.spec.subdomain ? { hostname: p.spec.hostname } : {}) };
      }).sort((a, b) => a.addresses[0].localeCompare(b.addresses[0], undefined, { numeric: true }));
      const slicePorts = ports.filter((x) => x.num).map((x) => ({ name: x.sp.name || '', port: x.num, protocol: x.sp.protocol || 'TCP', ...(x.sp.appProtocol ? { appProtocol: x.sp.appProtocol } : {}) }));
      let slice = c.all('endpointslices', ns).find((es) => es.metadata.labels?.['kubernetes.io/service-name'] === s.metadata.name && es.metadata.labels?.['endpointslice.kubernetes.io/managed-by'] === 'endpointslice-controller.k8s.io');
      const body = { addressType: 'IPv4', endpoints: eps.length ? eps : null, ports: slicePorts.length ? slicePorts : null };
      if (!slice) {
        slice = {
          apiVersion: 'discovery.k8s.io/v1', kind: 'EndpointSlice',
          metadata: { name: `${s.metadata.name}-${randSuffix(5)}`, namespace: ns, generateName: `${s.metadata.name}-`, labels: { 'endpointslice.kubernetes.io/managed-by': 'endpointslice-controller.k8s.io', 'kubernetes.io/service-name': s.metadata.name }, ownerReferences: [ownerRef(s)] },
          ...body,
        };
        c.put(slice);
        changed = true;
      } else if (!deepEqual(body.endpoints, slice.endpoints) || !deepEqual(body.ports, slice.ports)) {
        Object.assign(slice, body);
        c.put(slice);
        changed = true;
      }
      // Endpoints (v1, przestarzałe ale wciąż obecne)
      const subsets = eps.length && slicePorts.length ? [{
        addresses: eps.filter((e) => e.conditions.ready).map((e) => ({ ip: e.addresses[0], nodeName: e.nodeName, targetRef: e.targetRef, ...(e.hostname ? { hostname: e.hostname } : {}) })),
        notReadyAddresses: eps.filter((e) => !e.conditions.ready).map((e) => ({ ip: e.addresses[0], nodeName: e.nodeName, targetRef: e.targetRef })),
        ports: slicePorts.map((p) => ({ name: p.name || undefined, port: p.port, protocol: p.protocol })),
      }] : undefined;
      if (subsets) for (const ss of subsets) { if (!ss.addresses.length) delete ss.addresses; if (!ss.notReadyAddresses.length) delete ss.notReadyAddresses; for (const p of ss.ports) if (!p.name) delete p.name; }
      let ep = c.peek('endpoints', ns, s.metadata.name);
      if (!ep) {
        ep = { apiVersion: 'v1', kind: 'Endpoints', metadata: { name: s.metadata.name, namespace: ns, labels: { ...(s.metadata.labels || {}), 'endpoints.kubernetes.io/managed-by': 'endpoint-controller' } }, ...(subsets ? { subsets } : {}) };
        c.put(ep);
        changed = true;
      } else if (!deepEqual(ep.subsets, subsets)) {
        if (subsets) ep.subsets = subsets; else delete ep.subsets;
        c.put(ep);
        changed = true;
      }
    }
    // usuń Endpoints dla nieistniejących serwisów
    for (const ep of c.all('endpoints')) {
      if (ep.metadata.labels?.['endpoints.kubernetes.io/managed-by'] === 'endpoint-controller' && !c.peek('services', ep.metadata.namespace, ep.metadata.name)) { c.remove('endpoints', ep.metadata.namespace, ep.metadata.name); changed = true; }
    }
    return changed;
  },
};

// ============================================================================== PV / PVC
const pvCtrl = {
  name: 'persistentvolume',
  run(c) {
    if (!kcmUp(c)) return false;
    let changed = false;
    const pvs = c.all('persistentvolumes');
    const pvcs = c.all('persistentvolumeclaims');
    // stan PV
    for (const pv of pvs) {
      if (pv.metadata.deletionTimestamp && !(pv.metadata.finalizers || []).length) continue;
      let phase = 'Available';
      const cr = pv.spec.claimRef;
      if (cr) {
        const pvc = pvcs.find((p) => p.metadata.namespace === cr.namespace && p.metadata.name === cr.name);
        if (pvc && (!cr.uid || cr.uid === pvc.metadata.uid)) phase = pvc.spec.volumeName === pv.metadata.name ? 'Bound' : (cr.uid ? 'Bound' : 'Available');
        else if (cr.uid) phase = 'Released';
        else phase = 'Available';
      }
      if (phase === 'Released' && pv.spec.persistentVolumeReclaimPolicy === 'Delete') {
        const h = Object.values(c.hosts).find((x) => x.role !== 'base' && pv.spec.hostPath?.path && x.fs.exists(pv.spec.hostPath.path) && pv.metadata.annotations?.['pv.kubernetes.io/provisioned-by']);
        if (h) h.fs.remove(pv.spec.hostPath.path, { recursive: true, force: true });
        c.remove('persistentvolumes', null, pv.metadata.name);
        changed = true;
        continue;
      }
      if (pv.status?.phase !== phase) {
        pv.status = { ...(pv.status || {}), phase, lastPhaseTransitionTime: c.iso() };
        c.put(pv);
        changed = true;
      }
    }
    // wiązanie PVC
    for (const pvc of c.all('persistentvolumeclaims')) {
      if (pvc.metadata.deletionTimestamp) continue;
      if (pvc.status?.phase === 'Bound') {
        const pv = c.peek('persistentvolumes', null, pvc.spec.volumeName);
        if (!pv) { pvc.status = { phase: 'Lost' }; c.put(pvc); changed = true; }
        continue;
      }
      const ns = pvc.metadata.namespace;
      const sc = pvc.spec.storageClassName ? c.peek('storageclasses', null, pvc.spec.storageClassName) : null;
      const req = parseQty(pvc.spec.resources?.requests?.storage) || 0;
      let pv = null;
      if (pvc.spec.volumeName) {
        pv = c.peek('persistentvolumes', null, pvc.spec.volumeName);
        if (pv) {
          const cr = pv.spec.claimRef;
          const takenByOther = cr && (cr.name !== pvc.metadata.name || cr.namespace !== ns || (cr.uid && cr.uid !== pvc.metadata.uid));
          const mismatch = (pv.spec.storageClassName || '') !== (pvc.spec.storageClassName || '') || (parseQty(pv.spec.capacity?.storage) || 0) < req || !(pvc.spec.accessModes || []).every((m) => (pv.spec.accessModes || []).includes(m));
          if (takenByOther || mismatch) {
            const why = takenByOther ? `volume "${pv.metadata.name}" already bound to a different claim.` : `Cannot bind to requested volume "${pv.metadata.name}": ${(pv.spec.storageClassName || '') !== (pvc.spec.storageClassName || '') ? 'storageClassName does not match' : (parseQty(pv.spec.capacity?.storage) || 0) < req ? 'requested PV is too small' : 'incompatible accessMode'}`;
            if (!c.eventsFor(pvc).some((e) => e.message === why)) c.event(pvc, 'Warning', 'FailedBinding', why, 'persistentvolume-controller');
            pv = null;
          }
        }
      } else {
        const cands = c.all('persistentvolumes').filter((x) => {
          if (x.metadata.deletionTimestamp) return false;
          const cr = x.spec.claimRef;
          if (cr && !(cr.name === pvc.metadata.name && cr.namespace === ns && (!cr.uid || cr.uid === pvc.metadata.uid))) return false;
          if (x.status?.phase === 'Released') return false;
          if ((x.spec.storageClassName || '') !== (pvc.spec.storageClassName || '')) return false;
          if ((parseQty(x.spec.capacity?.storage) || 0) < req) return false;
          if (!(pvc.spec.accessModes || []).every((m) => (x.spec.accessModes || []).includes(m))) return false;
          if (pvc.spec.selector && !matchLabelSelector(pvc.spec.selector, x.metadata.labels || {})) return false;
          return true;
        }).sort((a, b) => (parseQty(a.spec.capacity.storage) - parseQty(b.spec.capacity.storage)));
        pv = cands[0] || null;
        if (pv && sc?.volumeBindingMode === 'WaitForFirstConsumer' && !pvc.metadata.annotations?.['volume.kubernetes.io/selected-node']) pv = null;
      }
      if (pv) {
        bind(c, pv, pvc);
        changed = true;
        continue;
      }
      // provisioning dynamiczny
      if (!pvc.spec.volumeName && pvc.spec.storageClassName) {
        if (!sc) {
          const msg = `storageclass.storage.k8s.io "${pvc.spec.storageClassName}" not found`;
          if (!c.eventsFor(pvc).some((e) => e.message === msg)) { c.event(pvc, 'Warning', 'ProvisioningFailed', msg, 'persistentvolume-controller'); changed = true; }
          continue;
        }
        if (sc.provisioner === 'kubernetes.io/no-provisioner') {
          const msg = sc.volumeBindingMode === 'WaitForFirstConsumer' ? 'waiting for first consumer to be created before binding' : 'no persistent volumes available for this claim and no storage class is set';
          if (!c.eventsFor(pvc).some((e) => e.message === msg)) { c.event(pvc, 'Normal', sc.volumeBindingMode === 'WaitForFirstConsumer' ? 'WaitForFirstConsumer' : 'FailedBinding', msg, 'persistentvolume-controller'); changed = true; }
          continue;
        }
        const node = pvc.metadata.annotations?.['volume.kubernetes.io/selected-node'];
        if (sc.volumeBindingMode === 'WaitForFirstConsumer' && !node) {
          const msg = 'waiting for first consumer to be created before binding';
          if (!c.eventsFor(pvc).some((e) => e.message === msg)) { c.event(pvc, 'Normal', 'WaitForFirstConsumer', msg, 'persistentvolume-controller'); changed = true; }
          continue;
        }
        if (sc.provisioner === 'rancher.io/local-path') {
          if (!provisionerUp(c)) {
            const msg = `waiting for a volume to be created either by the external provisioner 'rancher.io/local-path' or manually by the system administrator. If volume creation is delayed, please verify that the provisioner is running and correctly registered.`;
            if (!c.eventsFor(pvc).some((e) => e.reason === 'ExternalProvisioning')) { c.event(pvc, 'Normal', 'ExternalProvisioning', msg, 'persistentvolume-controller'); changed = true; }
            continue;
          }
          const target = node || Object.values(c.hosts).find((h) => h.role === 'worker')?.name;
          const name = `pvc-${pvc.metadata.uid}`;
          const path = `/opt/local-path-provisioner/${name}_${ns}_${pvc.metadata.name}`;
          const h = c.hosts[target];
          if (h) h.fs.mkdir(path, { p: true });
          const nv = {
            apiVersion: 'v1', kind: 'PersistentVolume',
            metadata: { name, annotations: { 'local.path.provisioner/selected-node': target, 'pv.kubernetes.io/provisioned-by': 'rancher.io/local-path' }, finalizers: ['kubernetes.io/pv-protection'] },
            spec: {
              accessModes: pvc.spec.accessModes, capacity: { storage: pvc.spec.resources.requests.storage },
              claimRef: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', name: pvc.metadata.name, namespace: ns, resourceVersion: pvc.metadata.resourceVersion, uid: pvc.metadata.uid },
              hostPath: { path, type: 'DirectoryOrCreate' },
              nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [target] }] }] } },
              persistentVolumeReclaimPolicy: sc.reclaimPolicy || 'Delete', storageClassName: sc.metadata.name, volumeMode: 'Filesystem',
            },
            status: { phase: 'Bound' },
          };
          c.put(nv);
          c.event(pvc, 'Normal', 'Provisioning', `External provisioner is provisioning volume for claim "${ns}/${pvc.metadata.name}"`, 'rancher.io/local-path_local-path-provisioner');
          c.event(pvc, 'Normal', 'ProvisioningSucceeded', `Successfully provisioned volume ${name}`, 'rancher.io/local-path_local-path-provisioner');
          bind(c, nv, pvc);
          changed = true;
        }
      } else if (!pvc.spec.storageClassName && !pvc.spec.volumeName) {
        const msg = 'no persistent volumes available for this claim and no storage class is set';
        if (!c.eventsFor(pvc).some((e) => e.message === msg)) { c.event(pvc, 'Normal', 'FailedBinding', msg, 'persistentvolume-controller'); changed = true; }
      }
    }
    return changed;
  },
};

function provisionerUp(c) {
  return c.all('pods', 'local-path-storage').some((p) => p.metadata.name.startsWith('local-path-provisioner') && p.status?.phase === 'Running');
}

function bind(c, pv, pvc) {
  pv.spec.claimRef = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', name: pvc.metadata.name, namespace: pvc.metadata.namespace, resourceVersion: pvc.metadata.resourceVersion, uid: pvc.metadata.uid };
  pv.status = { phase: 'Bound', lastPhaseTransitionTime: c.iso() };
  pv.metadata.annotations = { ...(pv.metadata.annotations || {}), 'pv.kubernetes.io/bound-by-controller': 'yes' };
  c.put(pv);
  const p = c.peek('persistentvolumeclaims', pvc.metadata.namespace, pvc.metadata.name);
  p.spec.volumeName = pv.metadata.name;
  p.metadata.annotations = { ...(p.metadata.annotations || {}), 'pv.kubernetes.io/bind-completed': 'yes', 'pv.kubernetes.io/bound-by-controller': 'yes' };
  if (pv.metadata.annotations?.['pv.kubernetes.io/provisioned-by']) p.metadata.annotations['volume.beta.kubernetes.io/storage-provisioner'] = pv.metadata.annotations['pv.kubernetes.io/provisioned-by'];
  p.metadata.finalizers = Array.from(new Set([...(p.metadata.finalizers || []), 'kubernetes.io/pvc-protection']));
  p.status = { accessModes: pv.spec.accessModes, capacity: pv.spec.capacity, phase: 'Bound' };
  c.put(p);
}

// pvc-protection / pv-protection
const protectionCtrl = {
  name: 'protection',
  run(c) {
    if (!kcmUp(c)) return false;
    let changed = false;
    for (const pvc of c.all('persistentvolumeclaims')) {
      if (!pvc.metadata.finalizers?.length && !pvc.metadata.deletionTimestamp) {
        pvc.metadata.finalizers = ['kubernetes.io/pvc-protection'];
        c.put(pvc);
        changed = true;
        continue;
      }
      if (!pvc.metadata.deletionTimestamp) continue;
      const used = c.all('pods', pvc.metadata.namespace).some((p) => p.spec.nodeName && (p.spec.volumes || []).some((v) => v.persistentVolumeClaim?.claimName === pvc.metadata.name) && !['Succeeded', 'Failed'].includes(p.status?.phase));
      if (!used) { c.remove('persistentvolumeclaims', pvc.metadata.namespace, pvc.metadata.name); changed = true; }
    }
    for (const pv of c.all('persistentvolumes')) {
      if (!pv.metadata.deletionTimestamp) continue;
      if (pv.status?.phase !== 'Bound') { c.remove('persistentvolumes', null, pv.metadata.name); changed = true; }
    }
    return changed;
  },
};

// ============================================================================== przestrzenie nazw, SA, root CA, GC
const namespaceCtrl = {
  name: 'namespace',
  run(c) {
    if (!kcmUp(c)) return false;
    let changed = false;
    const ca = c.hosts[Object.keys(c.hosts).find((n) => c.hosts[n].role === 'control-plane')]?.fs.tryRead('/etc/kubernetes/pki/ca.crt') || '';
    for (const ns of c.all('namespaces')) {
      const name = ns.metadata.name;
      if (ns.metadata.deletionTimestamp) {
        let left = 0;
        for (const r of c.registry.list) {
          if (!r.namespaced || r.hidden || r.alias) continue;
          for (const o of c.all(r, name)) {
            left++;
            if (!o.metadata.deletionTimestamp) c.doDelete(r, o, { gracePeriod: r.kind === 'Pod' ? undefined : undefined });
            else if (r.kind !== 'Pod' && (o.metadata.finalizers || []).length && r.kind !== 'PersistentVolumeClaim') { o.metadata.finalizers = []; c.remove(r, name, o.metadata.name); }
          }
        }
        if (!left) { c.remove('namespaces', null, name); changed = true; }
        else changed = true;
        continue;
      }
      if (!c.peek('serviceaccounts', name, 'default')) {
        c.put({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'default', namespace: name } });
        changed = true;
      }
      if (!c.peek('configmaps', name, 'kube-root-ca.crt') && ca) {
        c.put({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'kube-root-ca.crt', namespace: name, annotations: { 'kubernetes.io/description': 'CA bundle for verifying the kube-apiserver via in-cluster endpoints.' } }, data: { 'ca.crt': ca } });
        changed = true;
      }
    }
    return changed;
  },
};

const gcCtrl = {
  name: 'garbagecollector',
  run(c) {
    if (!kcmUp(c)) return false;
    let changed = false;
    const uids = new Set();
    for (const t of Object.values(c.db)) for (const o of Object.values(t)) uids.add(o.metadata.uid);
    for (const [key, t] of Object.entries(c.db)) {
      for (const o of Object.values(t)) {
        const refs = o.metadata.ownerReferences || [];
        if (!refs.length) continue;
        if (refs.some((r) => r.kind === 'Node')) continue;
        if (refs.every((r) => !uids.has(r.uid))) {
          const r = c.registry.list.find((x) => (x.group ? `${x.plural}.${x.group}` : x.plural) === key);
          if (r) { c.doDelete(r, o); changed = true; }
        }
      }
    }
    // stare zdarzenia (1h)
    for (const e of c.all('events')) {
      if (c.now() - Date.parse(e.lastTimestamp || e.metadata.creationTimestamp) > 3600000) { c.remove('events', e.metadata.namespace, e.metadata.name); changed = true; }
    }
    return changed;
  },
};

// ============================================================================== CSR
const csrCtrl = {
  name: 'csrsigning',
  run(c) {
    if (!kcmUp(c)) return false;
    let changed = false;
    for (const csr of c.all('certificatesigningrequests')) {
      const approved = csr.status?.conditions?.some((x) => x.type === 'Approved' && x.status === 'True');
      const denied = csr.status?.conditions?.some((x) => x.type === 'Denied' && x.status === 'True');
      if (!approved || denied || csr.status?.certificate) continue;
      if (!['kubernetes.io/kube-apiserver-client', 'kubernetes.io/kube-apiserver-client-kubelet', 'kubernetes.io/kubelet-serving'].includes(csr.spec.signerName)) continue;
      let meta = null;
      try { meta = parsePem(b64dec(csr.spec.request))?.meta; } catch { meta = null; }
      if (!meta) continue;
      const cert = makeCert({ cn: meta.cn, o: meta.o || [], issuer: 'kubernetes', notBefore: c.now() - 60000, seconds: Math.min(csr.spec.expirationSeconds || 31536000, 31536000), usage: csr.spec.usages || [] });
      csr.status.certificate = btoa(cert);
      c.put(csr);
      changed = true;
    }
    return changed;
  },
};

// ============================================================================== cykl życia węzłów
const nodeLifecycleCtrl = {
  name: 'nodelifecycle',
  run(c) {
    if (!kcmUp(c)) return false;
    let changed = false;
    c.heartbeats = c.heartbeats || {};
    for (const n of c.all('nodes')) {
      const last = c.heartbeats[n.metadata.name];
      const stale = last === undefined || c.now() - last > 40000;
      const ready = n.status?.conditions?.find((x) => x.type === 'Ready');
      const taints = (n.spec.taints || []).filter((t) => !['node.kubernetes.io/unreachable', 'node.kubernetes.io/not-ready'].includes(t.key));
      if (stale && ready && ready.status !== 'Unknown' && last !== undefined) {
        for (const cond of n.status.conditions) {
          if (['Ready', 'MemoryPressure', 'DiskPressure', 'PIDPressure'].includes(cond.type)) {
            cond.status = 'Unknown';
            cond.reason = 'NodeStatusUnknown';
            cond.message = 'Kubelet stopped posting node status.';
            cond.lastTransitionTime = c.iso();
          }
        }
        c.event({ ...n, metadata: { ...n.metadata, namespace: 'default' } }, 'Normal', 'NodeNotReady', `Node ${n.metadata.name} status is now: NodeNotReady`, 'node-controller');
      }
      const cur = n.status?.conditions?.find((x) => x.type === 'Ready')?.status;
      const want = [...taints];
      if (cur === 'Unknown') want.push({ effect: 'NoSchedule', key: 'node.kubernetes.io/unreachable', timeAdded: c.iso() }, { effect: 'NoExecute', key: 'node.kubernetes.io/unreachable', timeAdded: c.iso() });
      else if (cur === 'False') want.push({ effect: 'NoSchedule', key: 'node.kubernetes.io/not-ready', timeAdded: c.iso() });
      if (n.spec.unschedulable && !want.some((t) => t.key === 'node.kubernetes.io/unschedulable')) want.push({ effect: 'NoSchedule', key: 'node.kubernetes.io/unschedulable', timeAdded: c.iso() });
      if (!n.spec.unschedulable) for (let i = want.length - 1; i >= 0; i--) if (want[i].key === 'node.kubernetes.io/unschedulable') want.splice(i, 1);
      const norm = (ts) => JSON.stringify((ts || []).map((t) => `${t.key}=${t.value || ''}:${t.effect}`).sort());
      if (norm(want) !== norm(n.spec.taints)) {
        const keep = (n.spec.taints || []).filter((t) => want.some((w) => w.key === t.key && w.effect === t.effect));
        const add = want.filter((w) => !keep.some((t) => t.key === w.key && t.effect === w.effect));
        n.spec.taints = [...keep, ...add];
        if (!n.spec.taints.length) delete n.spec.taints;
        c.put(n);
        changed = true;
      } else if (stale && ready && ready.status !== 'Unknown' && last !== undefined) { c.put(n); changed = true; }
    }
    return changed;
  },
};

// ============================================================================== HPA
const hpaCtrl = {
  name: 'hpa',
  run(c) {
    if (!kcmUp(c)) return false;
    let changed = false;
    const msUp = c.all('pods', 'kube-system').some((p) => p.metadata.name.startsWith('metrics-server') && p.status?.conditions?.find((x) => x.type === 'Ready')?.status === 'True');
    for (const h of c.all('horizontalpodautoscalers')) {
      if (c.now() - (h._lastSync || 0) < 0) continue;
      const ref = h.spec.scaleTargetRef || {};
      const res = ref.kind === 'Deployment' ? 'deployments' : ref.kind === 'StatefulSet' ? 'statefulsets' : ref.kind === 'ReplicaSet' ? 'replicasets' : null;
      const target = res ? c.peek(res, h.metadata.namespace, ref.name) : null;
      const st = clone(h.status || {});
      const now = c.iso();
      const conds = [];
      const prev = (t) => (h.status?.conditions || []).find((x) => x.type === t);
      const mk = (type, status, reason, message) => ({ lastTransitionTime: prev(type)?.status === status ? prev(type).lastTransitionTime : now, message, reason, status, type });
      if (!target) {
        conds.push(mk('AbleToScale', 'False', 'FailedGetScale', `the HPA controller was unable to get the target's current scale: ${res || ref.kind?.toLowerCase() + 's'}.apps "${ref.name}" not found`));
      } else {
        conds.push(mk('AbleToScale', 'True', 'ReadyForNewScale', 'recommended size matches current size'));
        const sel = target.spec.selector;
        const pods = c.all('pods', h.metadata.namespace).filter((p) => matchLabelSelector(sel, p.metadata.labels || {}) && p.status?.phase === 'Running');
        const metrics = h.spec.metrics?.length ? h.spec.metrics : [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 80 } } }];
        const cur = target.spec.replicas ?? 1;
        let desired = cur;
        const current = [];
        let ok = true, failMsg = '';
        for (const m of metrics) {
          if (m.type !== 'Resource') continue;
          const rname = m.resource.name;
          if (!msUp) { ok = false; failMsg = `failed to get ${rname} utilization: unable to get metrics for resource ${rname}: unable to fetch metrics from resource metrics API: the server could not find the requested resource (get pods.metrics.k8s.io)`; break; }
          let used = 0, reqd = 0, missing = null;
          for (const p of pods) {
            const rt = c.runtime[p.metadata.uid];
            const mets = rt ? podMetrics(c, rt) : [];
            for (const ct of p.spec.containers) {
              const r = parseQty(ct.resources?.requests?.[rname]);
              if (!r) { missing = missing || `missing request for ${rname} in container ${ct.name} of Pod ${p.metadata.name}`; continue; }
              reqd += r;
              const mm = mets.find((x) => x.name === ct.name);
              used += mm ? (rname === 'cpu' ? mm.cpu : mm.mem) : 0;
            }
          }
          if (missing) { ok = false; failMsg = `failed to get ${rname} utilization: ${missing}`; break; }
          if (!pods.length) { ok = false; failMsg = `failed to get ${rname} utilization: did not receive metrics for targeted pods (pods might be unready)`; break; }
          const util = reqd ? Math.round((used / reqd) * 100) : 0;
          const tgt = m.resource.target;
          if (tgt.type === 'Utilization') {
            const want = tgt.averageUtilization || 80;
            const ratio = util / want;
            if (Math.abs(ratio - 1) > 0.1) desired = Math.max(desired === cur ? 0 : desired, Math.ceil(pods.length * ratio));
            current.push({ type: 'Resource', resource: { name: rname, current: { averageUtilization: util, averageValue: rname === 'cpu' ? `${Math.round((used / Math.max(1, pods.length)) * 1000)}m` : `${Math.round(used / Math.max(1, pods.length) / 1024)}Ki` } } });
          } else {
            current.push({ type: 'Resource', resource: { name: rname, current: { averageValue: rname === 'cpu' ? `${Math.round((used / Math.max(1, pods.length)) * 1000)}m` : `${Math.round(used / Math.max(1, pods.length) / 1024)}Ki` } } });
          }
        }
        const min = h.spec.minReplicas ?? 1, max = h.spec.maxReplicas;
        if (ok) {
          conds.push(mk('ScalingActive', 'True', 'ValidMetricFound', 'the HPA was able to successfully calculate a replica count from cpu resource utilization (percentage of request)'));
          if (desired === 0) desired = cur;
        } else {
          conds.push(mk('ScalingActive', 'False', 'FailedGetResourceMetric', `the HPA was unable to compute the replica count: ${failMsg}`));
          desired = cur;
          if (!c.eventsFor(h).some((e) => e.message.includes(failMsg.slice(0, 40)))) c.event(h, 'Warning', 'FailedGetResourceMetric', failMsg, 'horizontal-pod-autoscaler');
        }
        let limited = false;
        if (desired < min) { desired = min; limited = true; }
        if (desired > max) { desired = max; limited = true; }
        // stabilizacja w dół
        const win = (h.spec.behavior?.scaleDown?.stabilizationWindowSeconds ?? 300) * 1000;
        if (desired < cur && ok && !(cur > max)) {
          h._downSince = h._downSince || c.now();
          if (c.now() - h._downSince < win && cur <= max) desired = cur;
        } else h._downSince = null;
        conds.push(mk('ScalingLimited', limited ? 'True' : 'False', limited ? (desired === min ? 'TooFewReplicas' : 'TooManyReplicas') : 'DesiredWithinRange', limited ? `the desired replica count is ${desired === min ? 'less' : 'more'} than the ${desired === min ? 'minimum' : 'maximum'} replica count` : 'the desired count is within the acceptable range'));
        if (desired !== cur) {
          target.spec.replicas = desired;
          c.put(target);
          c.event(h, 'Normal', 'SuccessfulRescale', `New size: ${desired}; reason: ${desired === min && limited ? 'Current number of replicas below Spec.MinReplicas' : desired === max && limited ? 'Current number of replicas above Spec.MaxReplicas' : 'cpu resource utilization (percentage of request) above target'}`, 'horizontal-pod-autoscaler');
          st.lastScaleTime = now;
          changed = true;
        }
        st.currentReplicas = target.status?.replicas ?? cur;
        st.desiredReplicas = desired;
        if (current.length && ok) st.currentMetrics = current; else st.currentMetrics = ok ? null : [{ type: '' }];
        if (!ok) st.currentMetrics = null;
      }
      st.conditions = conds;
      if (st.currentMetrics === null) delete st.currentMetrics;
      const strip = (s) => { const x = clone(s || {}); for (const k of x.conditions || []) delete k.lastTransitionTime; return x; };
      if (!deepEqual(strip(st), strip(h.status))) { h.status = st; c.put(h); changed = true; }
    }
    return changed;
  },
};

// ============================================================================== ResourceQuota status
const quotaCtrl = {
  name: 'resourcequota',
  run(c) {
    if (!kcmUp(c)) return false;
    let changed = false;
    for (const q of c.all('resourcequotas')) {
      const used = quotaUsage(c, q.metadata.namespace);
      const fmt = (k, v) => (k.includes('memory') || k.includes('storage') ? (v === 0 ? '0' : `${Math.round(v / 1048576)}Mi`) : k.includes('cpu') ? (v === 0 ? '0' : Number.isInteger(v) ? String(v) : `${Math.round(v * 1000)}m`) : String(v));
      const st = { hard: { ...(q.spec.hard || {}) }, used: {} };
      for (const k of Object.keys(q.spec.hard || {})) {
        const key = k.startsWith('count/') ? k.slice(6) : k;
        st.used[k] = fmt(k, used[key] ?? 0);
      }
      if (!deepEqual(st, q.status)) { q.status = st; c.put(q); changed = true; }
    }
    void podQuotaRequest;
    return changed;
  },
};

export const KCM_CONTROLLERS = [namespaceCtrl, deploymentCtrl, replicaSetCtrl, statefulSetCtrl, daemonSetCtrl, jobCtrl, cronJobCtrl, endpointsCtrl, pvCtrl, protectionCtrl, gcCtrl, csrCtrl, nodeLifecycleCtrl, hpaCtrl, quotaCtrl];
export { templateHash, ownerRef, podReady };
