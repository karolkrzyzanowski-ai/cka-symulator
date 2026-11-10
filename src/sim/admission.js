// Admission: wartości domyślne, walidacja, wtyczki (LimitRanger, ResourceQuota, ...).
import { ApiError } from './cluster.js';
import { strictCheck, KIND_TYPE, validateSchema, applySchemaDefaults } from './schema.js';
import { clone, uuid, randSuffix, parseQty, validQty, matchLabelSelector, deepEqual, b64enc, isB64, b64dec, fmtCpu, fmtMem, rand } from '../lib/util.js';
import { cronValid } from './cron.js';

const DNS1123_SUB = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const LABEL_VAL = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/;
const LABEL_KEY = /^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;

const SUB_MSG = (v) => `Invalid value: "${v}": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character (e.g. 'example.com', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*')`;
const LABEL_MSG = (v) => `Invalid value: "${v}": a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character (e.g. 'my-name',  or '123-abc', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?')`;

const LABEL_NAMED = new Set(['Namespace', 'Service', 'Node']);

function invalid(r, o, causes) {
  const name = o.metadata?.name || o.metadata?.generateName || '';
  return new ApiError(422, 'Invalid', causes.join(', '), { kind: r.kind, name });
}

// ===================================================================== CREATE
export function admitCreate(c, o, { user, ns, fieldValidation }) {
  if (!o || typeof o !== 'object') throw new ApiError(400, 'BadRequest', 'Object \'Kind\' is missing');
  if (!o.apiVersion || !o.kind) {
    const miss = !o.kind ? "Object 'Kind' is missing in" : "Object 'apiVersion' is missing in";
    throw new ApiError(400, 'BadRequest', `${miss} '${JSON.stringify(o).slice(0, 120)}'`, { decode: true });
  }
  const r = c.registry.byKind(o.apiVersion, o.kind);
  if (!r) {
    const any = c.registry.byKindAnyVersion(o.apiVersion, o.kind);
    const hint = any ? '' : '\nensure CRDs are installed first';
    throw new ApiError(404, 'NoMatch', `no matches for kind "${o.kind}" in version "${o.apiVersion}"${hint}`, { kind: o.kind });
  }
  o.metadata = o.metadata || {};
  if (r.namespaced) o.metadata.namespace = o.metadata.namespace || ns || 'default';
  else delete o.metadata.namespace;
  const namespace = o.metadata.namespace;

  // strict decoding (nieznane pola, typy)
  decodeCheck(c, r, o, fieldValidation);

  // nazwa
  if (!o.metadata.name && o.metadata.generateName) o.metadata.name = o.metadata.generateName + randSuffix(5);
  if (!o.metadata.name) throw invalid(r, o, ['metadata.name: Required value: name or generateName is required']);

  c.authz(user, 'create', r, namespace, o.metadata.name);

  // NamespaceLifecycle
  if (r.namespaced) {
    const nso = c.peek('namespaces', null, namespace);
    if (!nso) throw new ApiError(404, 'NotFound', `namespaces "${namespace}" not found`);
    if (nso.metadata.deletionTimestamp) throw new ApiError(403, 'Forbidden', `${r.plural} "${o.metadata.name}" is forbidden: unable to create new content in namespace ${namespace} because it is being terminated`);
  }

  defaults(c, r, o, user, true);
  mutatingAdmission(c, r, o, true);
  const errs = validate(c, r, o, null);
  if (errs.length) throw invalid(r, o, errs);
  validatingAdmission(c, r, o, null);

  if (c.peek(r, namespace, o.metadata.name)) {
    throw new ApiError(409, 'AlreadyExists', `${c.registry.qualified(r)} "${o.metadata.name}" already exists`);
  }
  allocate(c, r, o, null);
  o.metadata.uid = uuid();
  o.metadata.creationTimestamp = c.iso();
  if (hasGeneration(r)) o.metadata.generation = 1;
  delete o.metadata.resourceVersion;
  delete o.metadata.deletionTimestamp;
  return { r, o };
}

function hasGeneration(r) {
  return ['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'HorizontalPodAutoscaler', 'NetworkPolicy', 'Ingress', 'PodDisruptionBudget', 'CustomResourceDefinition', 'PriorityClass', 'Pod'].includes(r.kind) || r.crd;
}

function decodeCheck(c, r, o, fieldValidation) {
  const tn = KIND_TYPE[r.kind];
  let unknown = [], typeErrors = [];
  if (tn) ({ unknown, typeErrors } = strictCheck(o, tn));
  else if (r.crd) {
    const crd = c.peek('customresourcedefinitions', null, `${r.plural}.${r.group}`);
    const ver = crd?.spec?.versions?.find((v) => `${crd.spec.group}/${v.name}` === o.apiVersion) || crd?.spec?.versions?.[0];
    const schema = ver?.schema?.openAPIV3Schema;
    if (schema) {
      const res = validateSchema(o, schema);
      unknown = res.unknown.filter((p) => !p.startsWith('metadata'));
      if (res.errs.length) throw invalid(r, o, res.errs);
    }
  }
  if (typeErrors.length) {
    throw new ApiError(400, 'BadRequest', `${r.kind} in version "${r.version}" cannot be handled as a ${r.kind}: ${typeErrors[0]}`, { decode: true });
  }
  if (unknown.length && fieldValidation === 'Strict') {
    throw new ApiError(400, 'BadRequest', `${r.kind} in version "${r.version}" cannot be handled as a ${r.kind}: strict decoding error: ${unknown.map((u) => `unknown field "${u}"`).join(', ')}`, { decode: true });
  }
  if (unknown.length && fieldValidation === 'Warn') o.__warnings = unknown.map((u) => `unknown field "${u}"`);
  // dane Secret muszą być base64
  if (r.kind === 'Secret' && o.data) {
    for (const [k, v] of Object.entries(o.data)) {
      if (typeof v === 'string' && !isB64(v)) throw new ApiError(400, 'BadRequest', `Secret in version "v1" cannot be handled as a Secret: illegal base64 data at input byte ${Math.min(v.length, 4)}`, { decode: true, key: k });
    }
  }
}

// ===================================================================== UPDATE
const POD_MUTABLE_MSG = 'spec: Forbidden: pod updates may not change fields other than `spec.containers[*].image`,`spec.initContainers[*].image`,`spec.activeDeadlineSeconds`,`spec.tolerations` (only additions to existing tolerations),`spec.terminationGracePeriodSeconds` (allow it to be set to 1 if it was previously negative)';

export function admitUpdate(c, o, { user, subresource, fieldValidation }) {
  const r = c.registry.byKind(o.apiVersion, o.kind) || c.registry.byKindAnyVersion(o.apiVersion, o.kind);
  if (!r) throw new ApiError(404, 'NoMatch', `no matches for kind "${o.kind}" in version "${o.apiVersion}"`);
  const ns = r.namespaced ? o.metadata.namespace : undefined;
  c.authz(user, subresource === 'scale' ? 'update' : 'update', r, ns, o.metadata.name, subresource === 'scale' ? 'scale' : undefined);
  const old = c.peek(r, ns, o.metadata.name);
  if (!old) throw new ApiError(404, 'NotFound', `${c.registry.qualified(r)} "${o.metadata.name}" not found`);
  decodeCheck(c, r, o, fieldValidation);
  // metadane systemowe zostają
  for (const k of ['uid', 'creationTimestamp', 'deletionTimestamp', 'deletionGracePeriodSeconds', 'ownerReferences', 'generation']) {
    if (k === 'ownerReferences' && o.metadata.ownerReferences) continue;
    if (old.metadata[k] !== undefined) o.metadata[k] = old.metadata[k];
    else delete o.metadata[k];
  }
  if (o.metadata.ownerReferences === undefined && old.metadata.ownerReferences) { /* usunięte przez użytkownika - pozwalamy */ }
  // status nie jest zmieniany przez zwykły update
  if (old.status !== undefined && r.kind !== 'Namespace') o.status = clone(old.status);
  else if (r.kind === 'Namespace') o.status = clone(old.status);
  defaults(c, r, o, user, false, old);
  mutatingAdmission(c, r, o, false);
  const errs = validate(c, r, o, old);
  if (errs.length) throw invalid(r, o, errs);
  validatingAdmission(c, r, o, old);
  allocate(c, r, o, old);
  if (hasGeneration(r)) {
    const specOld = JSON.stringify(old.spec ?? null), specNew = JSON.stringify(o.spec ?? null);
    o.metadata.generation = (old.metadata.generation || 1) + (specOld !== specNew ? 1 : 0);
  }
  return { r, o, old };
}

// ===================================================================== DELETE (po usunięciu)
export function onDelete(c, r, o) {
  if (r.kind === 'Service') {
    if (o.spec?.clusterIP && o.spec.clusterIP !== 'None') c.alloc.svcIPs.delete(o.spec.clusterIP);
    for (const p of o.spec?.ports || []) if (p.nodePort) c.alloc.nodePorts.delete(p.nodePort);
  }
  if (r.kind === 'CustomResourceDefinition') {
    const g = o.spec?.group, pl = o.spec?.names?.plural;
    const cr = c.registry.list.find((x) => x.group === g && x.plural === pl);
    if (cr) {
      delete c.db[`${cr.plural}.${cr.group}`];
      c.registry.remove(g, pl);
    }
  }
}

// ===================================================================== DEFAULTS
function imagePullPolicy(img) {
  if (!img) return 'IfNotPresent';
  const last = img.split('/').pop();
  if (last.includes('@')) return 'IfNotPresent';
  if (!last.includes(':') || last.endsWith(':latest')) return 'Always';
  return 'IfNotPresent';
}

function defaultProbe(p) {
  if (!p) return;
  p.timeoutSeconds ??= 1;
  p.periodSeconds ??= 10;
  p.successThreshold ??= 1;
  p.failureThreshold ??= 3;
  if (p.httpGet) p.httpGet.scheme ??= 'HTTP';
}

export function defaultPodSpec(spec, { isPod = false } = {}) {
  if (!spec) return;
  spec.restartPolicy ??= 'Always';
  spec.dnsPolicy ??= 'ClusterFirst';
  spec.schedulerName ??= 'default-scheduler';
  spec.securityContext ??= {};
  spec.terminationGracePeriodSeconds ??= 30;
  if (spec.serviceAccount && !spec.serviceAccountName) spec.serviceAccountName = spec.serviceAccount;
  for (const list of [spec.containers, spec.initContainers]) {
    for (const ct of list || []) {
      ct.imagePullPolicy ??= imagePullPolicy(ct.image);
      ct.terminationMessagePath ??= '/dev/termination-log';
      ct.terminationMessagePolicy ??= 'File';
      ct.resources ??= {};
      // limit bez requestu -> request = limit
      if (ct.resources.limits) {
        ct.resources.requests = ct.resources.requests || {};
        for (const [k, v] of Object.entries(ct.resources.limits)) if (ct.resources.requests[k] === undefined) ct.resources.requests[k] = v;
      }
      for (const p of ct.ports || []) p.protocol ??= 'TCP';
      defaultProbe(ct.livenessProbe); defaultProbe(ct.readinessProbe); defaultProbe(ct.startupProbe);
    }
  }
  for (const v of spec.volumes || []) {
    if (v.configMap) v.configMap.defaultMode ??= 420;
    if (v.secret) v.secret.defaultMode ??= 420;
    if (v.hostPath) v.hostPath.type ??= '';
  }
  if (isPod) {
    spec.enableServiceLinks ??= true;
    spec.preemptionPolicy ??= 'PreemptLowerPriority';
  }
}

function defaults(c, r, o, user, creating, old) {
  const k = r.kind;
  if (k === 'Pod') {
    defaultPodSpec(o.spec, { isPod: true });
    if (creating) {
      o.status = { phase: 'Pending', qosClass: qosClass(o.spec) };
    }
  } else if (['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet'].includes(k)) {
    o.spec = o.spec || {};
    if (k !== 'DaemonSet') o.spec.replicas ??= 1;
    if (k !== 'ReplicaSet') o.spec.revisionHistoryLimit ??= 10;
    if (k === 'Deployment') {
      o.spec.progressDeadlineSeconds ??= 600;
      o.spec.strategy ??= {};
      o.spec.strategy.type ??= 'RollingUpdate';
      if (o.spec.strategy.type === 'RollingUpdate') {
        o.spec.strategy.rollingUpdate ??= {};
        o.spec.strategy.rollingUpdate.maxSurge ??= '25%';
        o.spec.strategy.rollingUpdate.maxUnavailable ??= '25%';
      }
    }
    if (k === 'StatefulSet') {
      o.spec.podManagementPolicy ??= 'OrderedReady';
      o.spec.updateStrategy ??= { type: 'RollingUpdate', rollingUpdate: { partition: 0 } };
      o.spec.persistentVolumeClaimRetentionPolicy ??= { whenDeleted: 'Retain', whenScaled: 'Retain' };
      for (const t of o.spec.volumeClaimTemplates || []) {
        t.apiVersion ??= 'v1'; t.kind ??= 'PersistentVolumeClaim';
        t.spec = t.spec || {};
        t.spec.volumeMode ??= 'Filesystem';
      }
    }
    if (k === 'DaemonSet') o.spec.updateStrategy ??= { type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } };
    defaultPodSpec(o.spec.template?.spec);
    if (o.spec.template) o.spec.template.metadata = o.spec.template.metadata || {};
    if (creating) o.status = {};
  } else if (k === 'Job') {
    o.spec = o.spec || {};
    o.spec.backoffLimit ??= 6;
    o.spec.completions ??= 1;
    o.spec.parallelism ??= 1;
    o.spec.completionMode ??= 'NonIndexed';
    o.spec.suspend ??= false;
    o.spec.podReplacementPolicy ??= 'TerminatingOrFailed';
    o.spec.manualSelector ??= undefined;
    if (creating) {
      const uid = o.metadata.uid || uuid();
      o.metadata.uid = uid;
      if (!o.spec.selector) {
        o.spec.selector = { matchLabels: { 'batch.kubernetes.io/controller-uid': uid } };
        o.spec.template = o.spec.template || {};
        o.spec.template.metadata = o.spec.template.metadata || {};
        o.spec.template.metadata.labels = { ...(o.spec.template.metadata.labels || {}), 'batch.kubernetes.io/controller-uid': uid, 'batch.kubernetes.io/job-name': o.metadata.name, 'controller-uid': uid, 'job-name': o.metadata.name };
      }
      o.metadata.labels = o.metadata.labels || { 'batch.kubernetes.io/controller-uid': uid, 'batch.kubernetes.io/job-name': o.metadata.name, 'controller-uid': uid, 'job-name': o.metadata.name };
      o.status = {};
    }
    defaultPodSpec(o.spec.template?.spec);
  } else if (k === 'CronJob') {
    o.spec = o.spec || {};
    o.spec.concurrencyPolicy ??= 'Allow';
    o.spec.failedJobsHistoryLimit ??= 1;
    o.spec.successfulJobsHistoryLimit ??= 3;
    o.spec.suspend ??= false;
    const js = o.spec.jobTemplate?.spec;
    if (js) { js.backoffLimit ??= 6; js.completionMode ??= undefined; defaultPodSpec(js.template?.spec); }
    if (creating) o.status = {};
  } else if (k === 'Service') {
    o.spec = o.spec || {};
    o.spec.type ??= 'ClusterIP';
    o.spec.sessionAffinity ??= 'None';
    o.spec.internalTrafficPolicy ??= 'Cluster';
    if (o.spec.type === 'NodePort' || o.spec.type === 'LoadBalancer') o.spec.externalTrafficPolicy ??= 'Cluster';
    if (o.spec.type !== 'ExternalName') { o.spec.ipFamilies ??= ['IPv4']; o.spec.ipFamilyPolicy ??= 'SingleStack'; }
    for (const p of o.spec.ports || []) {
      p.protocol ??= 'TCP';
      if (p.targetPort === undefined && p.port !== undefined) p.targetPort = p.port;
    }
    if (creating) o.status = { loadBalancer: {} };
  } else if (k === 'PersistentVolumeClaim') {
    o.spec = o.spec || {};
    o.spec.volumeMode ??= 'Filesystem';
    if (creating) o.status = { phase: 'Pending' };
  } else if (k === 'PersistentVolume') {
    o.spec = o.spec || {};
    o.spec.volumeMode ??= 'Filesystem';
    o.spec.persistentVolumeReclaimPolicy ??= 'Retain';
    if (creating) o.status = { phase: 'Pending' };
  } else if (k === 'StorageClass') {
    o.reclaimPolicy ??= 'Delete';
    o.volumeBindingMode ??= 'Immediate';
  } else if (k === 'Secret') {
    o.type ??= 'Opaque';
    if (o.stringData) {
      o.data = o.data || {};
      for (const [kk, v] of Object.entries(o.stringData)) o.data[kk] = b64enc(String(v));
      delete o.stringData;
    }
  } else if (k === 'Namespace') {
    o.metadata.labels = { ...(o.metadata.labels || {}), 'kubernetes.io/metadata.name': o.metadata.name };
    o.spec = o.spec || { finalizers: ['kubernetes'] };
    if (creating) o.status = { phase: 'Active' };
  } else if (k === 'HorizontalPodAutoscaler') {
    o.spec = o.spec || {};
    o.spec.minReplicas ??= 1;
    if (creating) o.status = { currentReplicas: 0, desiredReplicas: 0 };
  } else if (k === 'PriorityClass') {
    o.preemptionPolicy ??= 'PreemptLowerPriority';
  } else if (k === 'NetworkPolicy') {
    o.spec = o.spec || {};
    o.spec.podSelector ??= {};
    if (!o.spec.policyTypes) o.spec.policyTypes = o.spec.egress ? ['Ingress', 'Egress'] : ['Ingress'];
  } else if (k === 'EndpointSlice') {
    for (const p of o.ports || []) p.protocol ??= 'TCP';
  } else if (k === 'CertificateSigningRequest') {
    if (creating) {
      o.spec = o.spec || {};
      o.spec.username = user?.name || 'kubernetes-admin';
      o.spec.groups = user?.groups || ['system:authenticated'];
      o.status = {};
    }
  } else if (k === 'Ingress') {
    if (creating) o.status = { loadBalancer: {} };
  } else if (r.crd) {
    const crd = c.peek('customresourcedefinitions', null, `${r.plural}.${r.group}`);
    const ver = crd?.spec?.versions?.find((v) => `${crd.spec.group}/${v.name}` === o.apiVersion) || crd?.spec?.versions?.[0];
    applySchemaDefaults(o, ver?.schema?.openAPIV3Schema);
  }
  void old;
}

export function qosClass(spec) {
  const cs = [...(spec?.containers || []), ...(spec?.initContainers || [])];
  let anySet = false, allGuaranteed = cs.length > 0;
  for (const ct of cs) {
    const req = ct.resources?.requests || {}, lim = ct.resources?.limits || {};
    if (Object.keys(req).length || Object.keys(lim).length) anySet = true;
    for (const res of ['cpu', 'memory']) {
      if (!lim[res] || (req[res] && parseQty(req[res]) !== parseQty(lim[res]))) allGuaranteed = false;
    }
  }
  if (!anySet) return 'BestEffort';
  return allGuaranteed ? 'Guaranteed' : 'Burstable';
}

// ===================================================================== MUTATING
function mutatingAdmission(c, r, o, creating) {
  if (r.kind === 'Pod' && creating) {
    const spec = o.spec;
    // ServiceAccount
    const saName = spec.serviceAccountName || 'default';
    spec.serviceAccountName = saName;
    spec.serviceAccount = saName;
    if (!c.peek('serviceaccounts', o.metadata.namespace, saName)) {
      throw new ApiError(403, 'Forbidden', `pods "${o.metadata.name}" is forbidden: error looking up service account ${o.metadata.namespace}/${saName}: serviceaccount "${saName}" not found`);
    }
    if (spec.automountServiceAccountToken !== false && !(spec.volumes || []).some((v) => v.name?.startsWith('kube-api-access-'))) {
      const vn = `kube-api-access-${randSuffix(5)}`;
      spec.volumes = [...(spec.volumes || []), {
        name: vn,
        projected: { defaultMode: 420, sources: [
          { serviceAccountToken: { expirationSeconds: 3607, path: 'token' } },
          { configMap: { name: 'kube-root-ca.crt', items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
          { downwardAPI: { items: [{ fieldRef: { apiVersion: 'v1', fieldPath: 'metadata.namespace' }, path: 'namespace' }] } },
        ] },
      }];
      for (const ct of [...(spec.containers || []), ...(spec.initContainers || [])]) {
        ct.volumeMounts = [...(ct.volumeMounts || []), { mountPath: '/var/run/secrets/kubernetes.io/serviceaccount', name: vn, readOnly: true }];
      }
    }
    // PriorityClass
    if (spec.priorityClassName) {
      const pc = c.peek('priorityclasses', null, spec.priorityClassName);
      if (!pc) throw new ApiError(403, 'Forbidden', `pods "${o.metadata.name}" is forbidden: no PriorityClass with name ${spec.priorityClassName} was found`);
      spec.priority = pc.value;
      spec.preemptionPolicy = pc.preemptionPolicy || 'PreemptLowerPriority';
    } else {
      const def = c.all('priorityclasses').find((p) => p.globalDefault);
      if (def) { spec.priorityClassName = def.metadata.name; spec.priority = def.value; } else spec.priority = 0;
    }
    // DefaultTolerationSeconds
    spec.tolerations = spec.tolerations || [];
    for (const key of ['node.kubernetes.io/not-ready', 'node.kubernetes.io/unreachable']) {
      if (!spec.tolerations.some((t) => t.key === key || (t.operator === 'Exists' && !t.key))) {
        spec.tolerations.push({ effect: 'NoExecute', key, operator: 'Exists', tolerationSeconds: 300 });
      }
    }
    // LimitRanger
    limitRangerDefaults(c, o);
    o.status.qosClass = qosClass(spec);
  }
  if (r.kind === 'PersistentVolumeClaim' && creating) {
    if (o.spec.storageClassName === undefined || o.spec.storageClassName === null) {
      const defs = c.all('storageclasses').filter((s) => s.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true');
      if (defs.length) {
        defs.sort((a, b) => Date.parse(b.metadata.creationTimestamp) - Date.parse(a.metadata.creationTimestamp));
        o.spec.storageClassName = defs[0].metadata.name;
      }
    }
  }
  if (r.kind === 'Ingress' && creating && !o.spec?.ingressClassName) {
    const def = c.all('ingressclasses').find((x) => x.metadata.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true');
    if (def) o.spec.ingressClassName = def.metadata.name;
  }
}

function limitRangerDefaults(c, pod) {
  const lrs = c.all('limitranges', pod.metadata.namespace);
  for (const lr of lrs) {
    for (const item of lr.spec?.limits || []) {
      if (item.type !== 'Container') continue;
      const anns = [];
      for (const ct of [...(pod.spec.containers || []), ...(pod.spec.initContainers || [])]) {
        ct.resources = ct.resources || {};
        const req = ct.resources.requests || {}, lim = ct.resources.limits || {};
        let changed = false;
        for (const [res, v] of Object.entries(item.default || {})) if (lim[res] === undefined) { lim[res] = v; changed = true; anns.push(`${res} limit for container ${ct.name}`); }
        for (const [res, v] of Object.entries(item.defaultRequest || {})) if (req[res] === undefined) { req[res] = lim[res] && !item.defaultRequest ? lim[res] : v; changed = true; anns.push(`${res} request for container ${ct.name}`); }
        // request = limit gdy brak defaultRequest
        for (const [res, v] of Object.entries(lim)) if (req[res] === undefined) req[res] = v;
        if (Object.keys(req).length) ct.resources.requests = req;
        if (Object.keys(lim).length) ct.resources.limits = lim;
        void changed;
      }
      if (anns.length) {
        pod.metadata.annotations = { ...(pod.metadata.annotations || {}), 'kubernetes.io/limit-ranger': `LimitRanger plugin set: ${anns.join('; ')}` };
      }
    }
  }
}

// ===================================================================== VALIDATING ADMISSION
function validatingAdmission(c, r, o, old) {
  if (r.kind === 'Pod' && !old) {
    // LimitRanger min/max
    for (const lr of c.all('limitranges', o.metadata.namespace)) {
      for (const item of lr.spec?.limits || []) {
        if (item.type !== 'Container') continue;
        for (const ct of o.spec.containers || []) {
          for (const [res, max] of Object.entries(item.max || {})) {
            const lim = ct.resources?.limits?.[res];
            if (!lim) throw new ApiError(403, 'Forbidden', `pods "${o.metadata.name}" is forbidden: maximum ${res} usage per Container is ${max}.  No limit is specified`);
            if (parseQty(lim) > parseQty(max)) throw new ApiError(403, 'Forbidden', `pods "${o.metadata.name}" is forbidden: maximum ${res} usage per Container is ${max}, but limit is ${lim}`);
          }
          for (const [res, min] of Object.entries(item.min || {})) {
            const req = ct.resources?.requests?.[res];
            if (req && parseQty(req) < parseQty(min)) throw new ApiError(403, 'Forbidden', `pods "${o.metadata.name}" is forbidden: minimum ${res} usage per Container is ${min}, but request is ${req}`);
          }
        }
      }
    }
    // ResourceQuota
    for (const q of c.all('resourcequotas', o.metadata.namespace)) {
      const hard = q.spec?.hard || {};
      const missing = [];
      for (const key of ['limits.cpu', 'limits.memory', 'requests.cpu', 'requests.memory']) {
        if (hard[key] === undefined) continue;
        const [kind, res] = key.split('.');
        const miss = (o.spec.containers || []).filter((ct) => !ct.resources?.[kind === 'limits' ? 'limits' : 'requests']?.[res]).map((ct) => ct.name);
        if (miss.length) missing.push(`${key} for: ${miss.join(',')}`);
      }
      if (hard.cpu !== undefined && (o.spec.containers || []).some((ct) => !ct.resources?.requests?.cpu)) missing.push(`cpu for: ${o.spec.containers.filter((ct) => !ct.resources?.requests?.cpu).map((x) => x.name).join(',')}`);
      if (missing.length) throw new ApiError(403, 'Forbidden', `pods "${o.metadata.name}" is forbidden: failed quota: ${q.metadata.name}: must specify ${missing.join('; ')}`);
      const used = quotaUsage(c, o.metadata.namespace);
      const req = podQuotaRequest(o);
      const exceeded = [];
      for (const [key, lim] of Object.entries(hard)) {
        if (req[key] === undefined) continue;
        const u = used[key] || 0;
        if (u + req[key] > parseQty(lim) + 1e-9) exceeded.push([key, req[key], u, lim]);
      }
      if (exceeded.length) {
        const f = (key, v) => (key.includes('memory') ? fmtMem(v) : key.includes('cpu') ? fmtCpu(v) : String(v));
        throw new ApiError(403, 'Forbidden', `pods "${o.metadata.name}" is forbidden: exceeded quota: ${q.metadata.name}, requested: ${exceeded.map(([k, v]) => `${k}=${f(k, v)}`).join(',')}, used: ${exceeded.map(([k, , u]) => `${k}=${f(k, u)}`).join(',')}, limited: ${exceeded.map(([k, , , l]) => `${k}=${l}`).join(',')}`);
      }
    }
  }
  if (!old) {
    for (const q of c.all('resourcequotas', o.metadata?.namespace || '-')) {
      const hard = q.spec?.hard || {};
      const countKey = { Service: 'services', ConfigMap: 'configmaps', Secret: 'secrets', PersistentVolumeClaim: 'persistentvolumeclaims' }[r.kind];
      const key = countKey && (hard[countKey] !== undefined ? countKey : hard[`count/${countKey}`] !== undefined ? `count/${countKey}` : null);
      if (key) {
        const n = c.all(r, o.metadata.namespace).length;
        if (n + 1 > parseQty(hard[key])) throw new ApiError(403, 'Forbidden', `${r.plural} "${o.metadata.name}" is forbidden: exceeded quota: ${q.metadata.name}, requested: ${key}=1, used: ${key}=${n}, limited: ${key}=${hard[key]}`);
      }
      if (r.kind === 'PersistentVolumeClaim' && hard['requests.storage'] !== undefined) {
        const used = c.all('persistentvolumeclaims', o.metadata.namespace).reduce((s, p) => s + (parseQty(p.spec?.resources?.requests?.storage) || 0), 0);
        const reqd = parseQty(o.spec?.resources?.requests?.storage) || 0;
        if (used + reqd > parseQty(hard['requests.storage'])) throw new ApiError(403, 'Forbidden', `persistentvolumeclaims "${o.metadata.name}" is forbidden: exceeded quota: ${q.metadata.name}, requested: requests.storage=${o.spec.resources.requests.storage}, used: requests.storage=${fmtMem(used)}, limited: requests.storage=${hard['requests.storage']}`);
      }
    }
  }
}

export function podQuotaRequest(pod) {
  const sum = (kind, res) => (pod.spec.containers || []).reduce((s, ct) => s + (parseQty(ct.resources?.[kind]?.[res]) || 0), 0);
  return {
    pods: 1, 'requests.cpu': sum('requests', 'cpu'), cpu: sum('requests', 'cpu'), 'requests.memory': sum('requests', 'memory'), memory: sum('requests', 'memory'),
    'limits.cpu': sum('limits', 'cpu'), 'limits.memory': sum('limits', 'memory'),
  };
}

export function quotaUsage(c, ns) {
  const used = { pods: 0, 'requests.cpu': 0, cpu: 0, 'requests.memory': 0, memory: 0, 'limits.cpu': 0, 'limits.memory': 0 };
  for (const p of c.all('pods', ns)) {
    if (['Succeeded', 'Failed'].includes(p.status?.phase)) continue;
    const q = podQuotaRequest(p);
    for (const k of Object.keys(used)) used[k] += q[k];
  }
  used.services = c.all('services', ns).length;
  used.configmaps = c.all('configmaps', ns).length;
  used.secrets = c.all('secrets', ns).length;
  used.persistentvolumeclaims = c.all('persistentvolumeclaims', ns).length;
  used['requests.storage'] = c.all('persistentvolumeclaims', ns).reduce((s, p) => s + (parseQty(p.spec?.resources?.requests?.storage) || 0), 0);
  return used;
}

// ===================================================================== ALOKACJA (IP serwisów, NodePorty)
function allocate(c, r, o, old) {
  if (r.kind !== 'Service') return;
  const s = o.spec;
  if (old) {
    s.clusterIP = old.spec.clusterIP;
    s.clusterIPs = old.spec.clusterIPs;
  }
  if (s.type === 'ExternalName') { delete s.clusterIP; return; }
  if (!s.clusterIP) {
    let ip;
    do { ip = `10.${96 + Math.floor(rand() * 16)}.${Math.floor(rand() * 256)}.${1 + Math.floor(rand() * 254)}`; } while (c.alloc.svcIPs.has(ip));
    s.clusterIP = ip;
  }
  if (s.clusterIP !== 'None') c.alloc.svcIPs.add(s.clusterIP);
  s.clusterIPs = [s.clusterIP];
  const needNP = s.type === 'NodePort' || s.type === 'LoadBalancer';
  const oldPorts = new Set((old?.spec?.ports || []).map((p) => p.nodePort).filter(Boolean));
  for (const p of s.ports || []) {
    if (!needNP) { delete p.nodePort; continue; }
    if (p.nodePort) {
      if (c.alloc.nodePorts.has(p.nodePort) && !oldPorts.has(p.nodePort)) {
        throw new ApiError(422, 'Invalid', `spec.ports[${s.ports.indexOf(p)}].nodePort: Invalid value: ${p.nodePort}: provided port is already allocated`, { kind: 'Service', name: o.metadata.name });
      }
    } else {
      const reuse = (old?.spec?.ports || []).find((x) => x.port === p.port && x.nodePort)?.nodePort;
      if (reuse) p.nodePort = reuse;
      else {
        let np;
        do { np = 30000 + Math.floor(rand() * 2768); } while (c.alloc.nodePorts.has(np));
        p.nodePort = np;
      }
    }
    c.alloc.nodePorts.add(p.nodePort);
  }
  if (old) for (const np of oldPorts) if (!(s.ports || []).some((p) => p.nodePort === np)) c.alloc.nodePorts.delete(np);
}

// ===================================================================== WALIDACJA
function validate(c, r, o, old) {
  const errs = [];
  const m = o.metadata;
  // nazwa
  if (r.kind !== 'Event' && !r.crd) {
    const re = LABEL_NAMED.has(r.kind) && r.kind !== 'Node' ? DNS1123_LABEL : DNS1123_SUB;
    if (!re.test(m.name) || m.name.length > 253) errs.push(`metadata.name: ${re === DNS1123_LABEL ? LABEL_MSG(m.name) : SUB_MSG(m.name)}`);
  } else if (r.crd && !DNS1123_SUB.test(m.name)) errs.push(`metadata.name: ${SUB_MSG(m.name)}`);
  for (const [k, v] of Object.entries(m.labels || {})) {
    if (!LABEL_KEY.test(k)) errs.push(`metadata.labels: Invalid value: "${k}": name part must consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyName',  or 'my.name',  or '123-abc', regex used for validation is '([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]')`);
    if (typeof v !== 'string' || !LABEL_VAL.test(v) || v.length > 63) errs.push(`metadata.labels: Invalid value: "${v}": a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyValue',  or 'my_value',  or '12345', regex used for validation is '(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?')`);
  }
  if (old && old.metadata.name !== m.name) errs.push('metadata.name: Invalid value: field is immutable');
  const V = VALIDATORS[r.kind];
  if (V) V(c, o, old, errs);
  return errs;
}

function validatePodSpec(spec, p, errs, { forTemplate = false, restartPolicies = null, extraVolumes = [] } = {}) {
  if (!spec) { errs.push(`${p}: Required value`); return; }
  const cs = spec.containers;
  if (!cs || !cs.length) errs.push(`${p}.containers: Required value`);
  const vols = new Set([...(spec.volumes || []).map((v) => v.name), ...extraVolumes]);
  const names = new Set();
  (spec.volumes || []).forEach((v, i) => {
    if (!v.name) errs.push(`${p}.volumes[${i}].name: Required value`);
    else if (!DNS1123_LABEL.test(v.name)) errs.push(`${p}.volumes[${i}].name: ${LABEL_MSG(v.name)}`);
    const srcs = ['emptyDir', 'hostPath', 'configMap', 'secret', 'persistentVolumeClaim', 'projected', 'downwardAPI', 'nfs', 'csi', 'ephemeral', 'image', 'iscsi', 'local'].filter((s) => v[s] !== undefined);
    if (!srcs.length) errs.push(`${p}.volumes[${i}]: Required value: must specify a volume type`);
    if (srcs.length > 1) errs.push(`${p}.volumes[${i}].${srcs[1]}: Forbidden: may not specify more than 1 volume type`);
    if (v.persistentVolumeClaim && !v.persistentVolumeClaim.claimName) errs.push(`${p}.volumes[${i}].persistentVolumeClaim.claimName: Required value`);
    if (v.hostPath && !v.hostPath.path) errs.push(`${p}.volumes[${i}].hostPath.path: Required value`);
  });
  const checkC = (ct, cp, init) => {
    if (!ct.name) errs.push(`${cp}.name: Required value`);
    else {
      if (!DNS1123_LABEL.test(ct.name)) errs.push(`${cp}.name: ${LABEL_MSG(ct.name)}`);
      if (names.has(ct.name)) errs.push(`${cp}.name: Duplicate value: "${ct.name}"`);
      names.add(ct.name);
    }
    if (!ct.image && !forTemplate) errs.push(`${cp}.image: Required value`);
    else if (!ct.image && forTemplate) errs.push(`${cp}.image: Required value`);
    (ct.ports || []).forEach((po, i) => {
      if (po.containerPort === undefined) errs.push(`${cp}.ports[${i}].containerPort: Required value`);
      else if (po.containerPort < 1 || po.containerPort > 65535) errs.push(`${cp}.ports[${i}].containerPort: Invalid value: ${po.containerPort}: must be between 1 and 65535, inclusive`);
      if (po.name && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(po.name)) errs.push(`${cp}.ports[${i}].name: Invalid value: "${po.name}": must contain only alpha-numeric characters (a-z, 0-9), and hyphens (-)`);
      if (po.name && po.name.length > 15) errs.push(`${cp}.ports[${i}].name: Invalid value: "${po.name}": must be no more than 15 characters`);
    });
    (ct.volumeMounts || []).forEach((vm, i) => {
      if (!vm.name) errs.push(`${cp}.volumeMounts[${i}].name: Required value`);
      else if (!vols.has(vm.name)) errs.push(`${cp}.volumeMounts[${i}].name: Not found: "${vm.name}"`);
      if (!vm.mountPath) errs.push(`${cp}.volumeMounts[${i}].mountPath: Required value`);
    });
    const res = ct.resources || {};
    for (const kind of ['requests', 'limits']) {
      for (const [k, v] of Object.entries(res[kind] || {})) {
        if (!validQty(v)) errs.push(`${cp}.resources.${kind}[${k}]: Invalid value: "${v}": quantities must match the regular expression '^([+-]?[0-9.]+)([eEinumkKMGTP]*[-+]?[0-9]*)$'`);
      }
    }
    for (const k of Object.keys(res.requests || {})) {
      if (res.limits?.[k] !== undefined && parseQty(res.requests[k]) > parseQty(res.limits[k])) {
        errs.push(`${cp}.resources.requests: Invalid value: "${res.requests[k]}": must be less than or equal to ${k} limit of ${res.limits[k]}`);
      }
    }
    for (const pn of ['livenessProbe', 'readinessProbe', 'startupProbe']) {
      const pr = ct[pn];
      if (!pr) continue;
      const h = ['exec', 'httpGet', 'tcpSocket', 'grpc'].filter((x) => pr[x]);
      if (!h.length) errs.push(`${cp}.${pn}: Required value: must specify a handler type`);
      if (pn === 'livenessProbe' && pr.successThreshold && pr.successThreshold !== 1) errs.push(`${cp}.livenessProbe.successThreshold: Invalid value: ${pr.successThreshold}: must be 1`);
    }
    if (init && ct.restartPolicy && ct.restartPolicy !== 'Always') errs.push(`${cp}.restartPolicy: Unsupported value: "${ct.restartPolicy}": supported values: "Always"`);
    if (!init && ct.restartPolicy) errs.push(`${cp}.restartPolicy: Forbidden: may not be set for non-init containers`);
    if (init && ct.restartPolicy !== 'Always') {
      for (const pn of ['livenessProbe', 'readinessProbe', 'startupProbe']) if (ct[pn]) errs.push(`${cp}.${pn}: Forbidden: may not be set for init containers without restartPolicy=Always`);
    }
    (ct.env || []).forEach((e, i) => {
      if (!e.name) errs.push(`${cp}.env[${i}].name: Required value`);
      if (e.value !== undefined && e.valueFrom) errs.push(`${cp}.env[${i}].valueFrom: Invalid value: "": may not be specified when \`value\` is not empty`);
      if (e.valueFrom?.configMapKeyRef && !e.valueFrom.configMapKeyRef.key) errs.push(`${cp}.env[${i}].valueFrom.configMapKeyRef.key: Required value`);
      if (e.valueFrom?.secretKeyRef && !e.valueFrom.secretKeyRef.key) errs.push(`${cp}.env[${i}].valueFrom.secretKeyRef.key: Required value`);
    });
  };
  (cs || []).forEach((ct, i) => checkC(ct, `${p}.containers[${i}]`, false));
  (spec.initContainers || []).forEach((ct, i) => checkC(ct, `${p}.initContainers[${i}]`, true));
  const rp = restartPolicies || ['Always', 'OnFailure', 'Never'];
  if (spec.restartPolicy && !rp.includes(spec.restartPolicy)) {
    errs.push(`${p}.restartPolicy: ${restartPolicies ? 'Required value' : 'Unsupported value: "' + spec.restartPolicy + '"'}: ${restartPolicies ? 'valid values: ' : 'supported values: '}${rp.map((x) => `"${x}"`).join(', ')}`);
  }
  (spec.tolerations || []).forEach((t, i) => {
    if (t.operator && !['Exists', 'Equal'].includes(t.operator)) errs.push(`${p}.tolerations[${i}].operator: Unsupported value: "${t.operator}": supported values: "Equal", "Exists"`);
    if (t.operator === 'Exists' && t.value) errs.push(`${p}.tolerations[${i}].operator: Invalid value: "${t.value}": value must be empty when \`operator\` is 'Exists'`);
    if (t.effect && !['NoSchedule', 'PreferNoSchedule', 'NoExecute'].includes(t.effect)) errs.push(`${p}.tolerations[${i}].effect: Unsupported value: "${t.effect}": supported values: "NoSchedule", "PreferNoSchedule", "NoExecute"`);
  });
  const na = spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
  if (na) {
    (na.nodeSelectorTerms || []).forEach((t, i) => (t.matchExpressions || []).forEach((e, j) => {
      const ep = `${p}.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[${i}].matchExpressions[${j}]`;
      if (!['In', 'NotIn', 'Exists', 'DoesNotExist', 'Gt', 'Lt'].includes(e.operator)) errs.push(`${ep}.operator: Invalid value: "${e.operator}": not a valid selector operator`);
      if (['In', 'NotIn'].includes(e.operator) && !(e.values || []).length) errs.push(`${ep}.values: Required value: must be specified when \`operator\` is 'In' or 'NotIn'`);
    }));
  }
  if (spec.dnsPolicy && !['ClusterFirst', 'ClusterFirstWithHostNet', 'Default', 'None'].includes(spec.dnsPolicy)) errs.push(`${p}.dnsPolicy: Unsupported value: "${spec.dnsPolicy}": supported values: "ClusterFirstWithHostNet", "ClusterFirst", "Default", "None"`);
}

function selectorMatchesTemplate(o, errs) {
  const sel = o.spec?.selector;
  if (!sel) { errs.push('spec.selector: Required value'); return; }
  if (!Object.keys(sel.matchLabels || {}).length && !(sel.matchExpressions || []).length) {
    errs.push('spec.selector: Invalid value: v1.LabelSelector{MatchLabels:map[string]string(nil), MatchExpressions:[]v1.LabelSelectorRequirement(nil)}: empty selector is invalid for deployment');
    return;
  }
  const labels = o.spec?.template?.metadata?.labels || {};
  if (!matchLabelSelector(sel, labels)) {
    const fmt = Object.entries(labels).map(([k, v]) => `"${k}":"${v}"`).join(', ');
    errs.push(`spec.template.metadata.labels: Invalid value: map[string]string{${fmt}}: \`selector\` does not match template \`labels\``);
  }
}

const VALIDATORS = {
  Pod(c, o, old, errs) {
    validatePodSpec(o.spec, 'spec', errs);
    if (old) {
      // tylko obraz, activeDeadlineSeconds, tolerations(+) są zmienne
      const strip = (s) => {
        const x = clone(s);
        for (const ct of [...(x.containers || []), ...(x.initContainers || [])]) delete ct.image;
        delete x.activeDeadlineSeconds;
        delete x.tolerations;
        delete x.terminationGracePeriodSeconds;
        delete x.nodeName;
        return x;
      };
      if (!deepEqual(strip(o.spec), strip(old.spec))) errs.push(POD_MUTABLE_MSG);
      else if (old.spec.nodeName && o.spec.nodeName !== old.spec.nodeName) errs.push(POD_MUTABLE_MSG);
    }
  },
  Deployment(c, o, old, errs) {
    selectorMatchesTemplate(o, errs);
    if (o.spec.replicas < 0) errs.push(`spec.replicas: Invalid value: ${o.spec.replicas}: must be greater than or equal to 0`);
    const st = o.spec.strategy?.type;
    if (st && !['Recreate', 'RollingUpdate'].includes(st)) errs.push(`spec.strategy.type: Unsupported value: "${st}": supported values: "Recreate", "RollingUpdate"`);
    if (st === 'Recreate' && o.spec.strategy.rollingUpdate) errs.push("spec.strategy.rollingUpdate: Forbidden: may not be specified when strategy `type` is 'Recreate'");
    const ru = o.spec.strategy?.rollingUpdate;
    if (ru && String(ru.maxSurge) === '0' && String(ru.maxUnavailable) === '0') errs.push('spec.strategy.rollingUpdate.maxUnavailable: Invalid value: 0: may not be 0 when `maxSurge` is 0');
    validatePodSpec(o.spec.template?.spec, 'spec.template.spec', errs, { forTemplate: true, restartPolicies: ['Always'] });
    if (old && !deepEqual(old.spec.selector, o.spec.selector)) {
      errs.push(`spec.selector: Invalid value: v1.LabelSelector{MatchLabels:map[string]string{${Object.entries(o.spec.selector?.matchLabels || {}).map(([k, v]) => `"${k}":"${v}"`).join(', ')}}, MatchExpressions:[]v1.LabelSelectorRequirement(nil)}: field is immutable`);
    }
  },
  ReplicaSet(c, o, old, errs) { selectorMatchesTemplate(o, errs); validatePodSpec(o.spec.template?.spec, 'spec.template.spec', errs, { forTemplate: true }); },
  StatefulSet(c, o, old, errs) {
    selectorMatchesTemplate(o, errs);
    validatePodSpec(o.spec.template?.spec, 'spec.template.spec', errs, { forTemplate: true, restartPolicies: ['Always'], extraVolumes: (o.spec.volumeClaimTemplates || []).map((v) => v.metadata?.name) });
    const pmp = o.spec.podManagementPolicy;
    if (pmp && !['OrderedReady', 'Parallel'].includes(pmp)) errs.push(`spec.podManagementPolicy: Unsupported value: "${pmp}": supported values: "OrderedReady", "Parallel"`);
    (o.spec.volumeClaimTemplates || []).forEach((t, i) => {
      if (!t.metadata?.name) errs.push(`spec.volumeClaimTemplates[${i}].metadata.name: Required value`);
      if (!(t.spec?.accessModes || []).length) errs.push(`spec.volumeClaimTemplates[${i}].spec.accessModes: Required value: at least 1 access mode is required`);
      if (!t.spec?.resources?.requests?.storage) errs.push(`spec.volumeClaimTemplates[${i}].spec.resources[storage]: Required value`);
    });
    if (old) {
      const strip = (s) => { const x = clone(s); for (const k of ['replicas', 'ordinals', 'template', 'updateStrategy', 'persistentVolumeClaimRetentionPolicy', 'minReadySeconds']) delete x[k]; return x; };
      if (!deepEqual(strip(o.spec), strip(old.spec))) errs.push("spec: Forbidden: updates to statefulset spec for fields other than 'replicas', 'ordinals', 'template', 'updateStrategy', 'persistentVolumeClaimRetentionPolicy' and 'minReadySeconds' are forbidden");
    }
  },
  DaemonSet(c, o, old, errs) {
    selectorMatchesTemplate(o, errs);
    validatePodSpec(o.spec.template?.spec, 'spec.template.spec', errs, { forTemplate: true, restartPolicies: ['Always'] });
    if (old && !deepEqual(old.spec.selector, o.spec.selector)) errs.push('spec.selector: Invalid value: field is immutable');
  },
  Job(c, o, old, errs) {
    validatePodSpec(o.spec?.template?.spec, 'spec.template.spec', errs, { forTemplate: true, restartPolicies: ['OnFailure', 'Never'] });
    if (o.spec?.template?.spec && !['OnFailure', 'Never'].includes(o.spec.template.spec.restartPolicy) && !errs.some((e) => e.includes('restartPolicy'))) {
      errs.push('spec.template.spec.restartPolicy: Required value: valid values: "OnFailure", "Never"');
    }
    if (old && !deepEqual(old.spec.template, o.spec.template)) errs.push('spec.template: Invalid value: field is immutable');
  },
  CronJob(c, o, old, errs) {
    if (!o.spec?.schedule) errs.push('spec.schedule: Required value');
    else if (!cronValid(o.spec.schedule)) errs.push(`spec.schedule: Invalid value: "${o.spec.schedule}": unparseable schedule`);
    const cp = o.spec?.concurrencyPolicy;
    if (cp && !['Allow', 'Forbid', 'Replace'].includes(cp)) errs.push(`spec.concurrencyPolicy: Unsupported value: "${cp}": supported values: "Allow", "Forbid", "Replace"`);
    const ts = o.spec?.jobTemplate?.spec?.template?.spec;
    validatePodSpec(ts, 'spec.jobTemplate.spec.template.spec', errs, { forTemplate: true, restartPolicies: ['OnFailure', 'Never'] });
    if (ts && !['OnFailure', 'Never'].includes(ts.restartPolicy) && !errs.some((e) => e.includes('restartPolicy'))) {
      errs.push('spec.jobTemplate.spec.template.spec.restartPolicy: Required value: valid values: "OnFailure", "Never"');
    }
  },
  Service(c, o, old, errs) {
    const s = o.spec || {};
    if (!['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName'].includes(s.type)) errs.push(`spec.type: Unsupported value: "${s.type}": supported values: "ClusterIP", "ExternalName", "LoadBalancer", "NodePort"`);
    const ports = s.ports || [];
    if (!ports.length && s.type !== 'ExternalName' && s.clusterIP !== 'None') errs.push('spec.ports: Required value');
    ports.forEach((p, i) => {
      if (p.port === undefined) errs.push(`spec.ports[${i}].port: Required value`);
      else if (p.port < 1 || p.port > 65535) errs.push(`spec.ports[${i}].port: Invalid value: ${p.port}: must be between 1 and 65535, inclusive`);
      if (ports.length > 1 && !p.name) errs.push(`spec.ports[${i}].name: Required value`);
      if (p.nodePort !== undefined && (p.nodePort < 30000 || p.nodePort > 32767)) errs.push(`spec.ports[${i}].nodePort: Invalid value: ${p.nodePort}: provided port is not in the valid range. The range of valid ports is 30000-32767`);
      if (p.nodePort !== undefined && s.type === 'ClusterIP') errs.push(`spec.ports[${i}].nodePort: Forbidden: may not be used when \`type\` is 'ClusterIP'`);
      if (typeof p.targetPort === 'number' && (p.targetPort < 1 || p.targetPort > 65535)) errs.push(`spec.ports[${i}].targetPort: Invalid value: ${p.targetPort}: must be between 1 and 65535, inclusive`);
    });
    const pn = ports.map((p) => p.name).filter(Boolean);
    if (new Set(pn).size !== pn.length) errs.push('spec.ports[1].name: Duplicate value');
    if (old && old.spec.clusterIP && s.clusterIP && s.clusterIP !== old.spec.clusterIP && old.spec.clusterIP !== 'None') errs.push('spec.clusterIPs[0]: Invalid value: []string{"' + s.clusterIP + '"}: may not change once set');
  },
  PersistentVolumeClaim(c, o, old, errs) {
    const s = o.spec || {};
    if (!(s.accessModes || []).length) errs.push('spec.accessModes: Required value: at least 1 access mode is required');
    for (const am of s.accessModes || []) if (!['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany', 'ReadWriteOncePod'].includes(am)) errs.push(`spec.accessModes: Unsupported value: "${am}": supported values: "ReadOnlyMany", "ReadWriteMany", "ReadWriteOnce", "ReadWriteOncePod"`);
    if (!s.resources?.requests?.storage) errs.push('spec.resources[storage]: Required value');
    if (old) {
      const strip = (x) => { const y = clone(x); delete y.resources; delete y.volumeAttributesClassName; if (!old.spec.volumeName) delete y.volumeName; return y; };
      if (!deepEqual(strip(s), strip(old.spec))) errs.push('spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims');
    }
  },
  PersistentVolume(c, o, old, errs) {
    const s = o.spec || {};
    if (!s.capacity?.storage) errs.push('spec.capacity: Required value');
    if (!(s.accessModes || []).length) errs.push('spec.accessModes: Required value');
    const srcs = ['hostPath', 'local', 'nfs', 'csi', 'iscsi', 'fc', 'cephfs'].filter((x) => s[x]);
    if (!srcs.length) errs.push('spec: Required value: must specify a volume type');
    if (s.local && !s.nodeAffinity) errs.push('spec.nodeAffinity: Required value: Local volume requires node affinity');
    const rp = s.persistentVolumeReclaimPolicy;
    if (rp && !['Retain', 'Delete', 'Recycle'].includes(rp)) errs.push(`spec.persistentVolumeReclaimPolicy: Unsupported value: "${rp}": supported values: "Delete", "Recycle", "Retain"`);
  },
  StorageClass(c, o, old, errs) {
    if (!o.provisioner) errs.push('provisioner: Required value');
    if (o.reclaimPolicy && !['Retain', 'Delete'].includes(o.reclaimPolicy)) errs.push(`reclaimPolicy: Unsupported value: "${o.reclaimPolicy}": supported values: "Delete", "Retain"`);
    if (o.volumeBindingMode && !['Immediate', 'WaitForFirstConsumer'].includes(o.volumeBindingMode)) errs.push(`volumeBindingMode: Unsupported value: "${o.volumeBindingMode}": supported values: "Immediate", "WaitForFirstConsumer"`);
    if (old) {
      if (old.provisioner !== o.provisioner) errs.push('provisioner: Forbidden: updates to provisioner are forbidden.');
      if (!deepEqual(old.parameters, o.parameters)) errs.push('parameters: Forbidden: updates to parameters are forbidden.');
      if (old.reclaimPolicy !== o.reclaimPolicy) errs.push('reclaimPolicy: Forbidden: updates to reclaimPolicy are forbidden.');
      if (old.volumeBindingMode !== o.volumeBindingMode) errs.push('volumeBindingMode: Invalid value: field is immutable');
    }
  },
  Role(c, o, old, errs) { validateRules(o.rules, errs); },
  ClusterRole(c, o, old, errs) { validateRules(o.rules, errs, true); },
  RoleBinding(c, o, old, errs) { validateBinding(o, old, errs, false); },
  ClusterRoleBinding(c, o, old, errs) { validateBinding(o, old, errs, true); },
  NetworkPolicy(c, o, old, errs) {
    for (const t of o.spec?.policyTypes || []) if (!['Ingress', 'Egress'].includes(t)) errs.push(`spec.policyTypes: Unsupported value: "${t}": supported values: "Ingress", "Egress"`);
    const chk = (rules, kind) => (rules || []).forEach((rule, i) => (rule.ports || []).forEach((p, j) => {
      if (p.protocol && !['TCP', 'UDP', 'SCTP'].includes(p.protocol)) errs.push(`spec.${kind}[${i}].ports[${j}].protocol: Unsupported value: "${p.protocol}": supported values: "SCTP", "TCP", "UDP"`);
    }));
    chk(o.spec?.ingress, 'ingress'); chk(o.spec?.egress, 'egress');
  },
  Ingress(c, o, old, errs) {
    (o.spec?.rules || []).forEach((rule, i) => (rule.http?.paths || []).forEach((p, j) => {
      const pp = `spec.rules[${i}].http.paths[${j}]`;
      if (!p.pathType) errs.push(`${pp}.pathType: Required value: pathType must be specified`);
      else if (!['Exact', 'Prefix', 'ImplementationSpecific'].includes(p.pathType)) errs.push(`${pp}.pathType: Unsupported value: "${p.pathType}": supported values: "Exact", "ImplementationSpecific", "Prefix"`);
      if (p.pathType !== 'ImplementationSpecific' && p.path && !p.path.startsWith('/')) errs.push(`${pp}.path: Invalid value: "${p.path}": must be an absolute path`);
      if (!p.backend) errs.push(`${pp}.backend: Required value`);
      else if (p.backend.service && !p.backend.service.port) errs.push(`${pp}.backend.service.port: Required value: port name or number is required`);
    }));
  },
  HorizontalPodAutoscaler(c, o, old, errs) {
    const s = o.spec || {};
    if (!s.scaleTargetRef?.kind) errs.push('spec.scaleTargetRef.kind: Required value');
    if (!s.scaleTargetRef?.name) errs.push('spec.scaleTargetRef.name: Required value');
    if (!s.maxReplicas) errs.push('spec.maxReplicas: Invalid value: 0: must be greater than or equal to 1');
    if (s.minReplicas !== undefined && s.maxReplicas && s.minReplicas > s.maxReplicas) errs.push(`spec.maxReplicas: Invalid value: ${s.maxReplicas}: must be greater than or equal to \`minReplicas\``);
    (s.metrics || []).forEach((m, i) => {
      if (!['ContainerResource', 'External', 'Object', 'Pods', 'Resource'].includes(m.type)) errs.push(`spec.metrics[${i}].type: Unsupported value: "${m.type}": supported values: "ContainerResource", "External", "Object", "Pods", "Resource"`);
      if (m.type === 'Resource' && !m.resource) errs.push(`spec.metrics[${i}].resource: Required value: must populate information for the given metric source`);
      if (m.resource?.target && !['Utilization', 'Value', 'AverageValue'].includes(m.resource.target.type)) errs.push(`spec.metrics[${i}].resource.target.type: Unsupported value: "${m.resource.target.type}"`);
    });
  },
  PriorityClass(c, o, old, errs) {
    if (o.value === undefined) errs.push('value: Required value');
    if (o.value > 1000000000 && !o.metadata.name.startsWith('system-')) errs.push(`value: Forbidden: maximum allowed value of a user defined priority is 1000000000`);
    if (o.globalDefault) {
      const other = c.all('priorityclasses').find((p) => p.globalDefault && p.metadata.name !== o.metadata.name);
      if (other) errs.push(`globalDefault: Invalid value: true: PriorityClass ${other.metadata.name} is already marked as default. Only one default can exist`);
    }
    if (old && old.value !== o.value) errs.push('value: Forbidden: may not be changed in an update.');
    if (o.preemptionPolicy && !['Never', 'PreemptLowerPriority'].includes(o.preemptionPolicy)) errs.push(`preemptionPolicy: Unsupported value: "${o.preemptionPolicy}": supported values: "Never", "PreemptLowerPriority"`);
  },
  LimitRange(c, o, old, errs) {
    (o.spec?.limits || []).forEach((it, i) => {
      if (!['Container', 'Pod', 'PersistentVolumeClaim'].includes(it.type)) errs.push(`spec.limits[${i}].type: Unsupported value: "${it.type}"`);
      for (const [res, v] of Object.entries(it.default || {})) {
        if (it.max?.[res] && parseQty(v) > parseQty(it.max[res])) errs.push(`spec.limits[${i}].default[${res}]: Invalid value: "${v}": default value ${v} is greater than max value ${it.max[res]}`);
      }
      for (const [res, v] of Object.entries(it.defaultRequest || {})) {
        if (it.default?.[res] && parseQty(v) > parseQty(it.default[res])) errs.push(`spec.limits[${i}].defaultRequest[${res}]: Invalid value: "${v}": default request value ${v} is greater than default limit value ${it.default[res]}`);
        if (it.max?.[res] && parseQty(v) > parseQty(it.max[res])) errs.push(`spec.limits[${i}].defaultRequest[${res}]: Invalid value: "${v}": default request value ${v} is greater than max value ${it.max[res]}`);
      }
      for (const kind of ['max', 'min', 'default', 'defaultRequest']) {
        for (const [res, v] of Object.entries(it[kind] || {})) if (!validQty(v)) errs.push(`spec.limits[${i}].${kind}[${res}]: Invalid value: "${v}": quantities must match the regular expression '^([+-]?[0-9.]+)([eEinumkKMGTP]*[-+]?[0-9]*)$'`);
      }
    });
  },
  ResourceQuota(c, o, old, errs) {
    for (const [k, v] of Object.entries(o.spec?.hard || {})) if (!validQty(v)) errs.push(`spec.hard[${k}]: Invalid value: "${v}": quantities must match the regular expression '^([+-]?[0-9.]+)([eEinumkKMGTP]*[-+]?[0-9]*)$'`);
  },
  ConfigMap(c, o, old, errs) {
    for (const k of Object.keys(o.data || {})) if (!/^[-._a-zA-Z0-9]+$/.test(k)) errs.push(`data[${k}]: Invalid value: "${k}": a valid config key must consist of alphanumeric characters, '-', '_' or '.' (e.g. 'key.name',  or 'KEY_NAME',  or 'key-name', regex used for validation is '[-._a-zA-Z0-9]+')`);
    if (old?.immutable && !deepEqual(old.data, o.data)) errs.push('data: Forbidden: field is immutable when `immutable` is set');
  },
  Secret(c, o, old, errs) {
    for (const k of Object.keys(o.data || {})) if (!/^[-._a-zA-Z0-9]+$/.test(k)) errs.push(`data[${k}]: Invalid value: "${k}": a valid config key must consist of alphanumeric characters, '-', '_' or '.' (e.g. 'key.name',  or 'KEY_NAME',  or 'key-name', regex used for validation is '[-._a-zA-Z0-9]+')`);
    if (o.type === 'kubernetes.io/tls' && (!o.data?.['tls.crt'] || !o.data?.['tls.key'])) errs.push(`data[${!o.data?.['tls.crt'] ? 'tls.crt' : 'tls.key'}]: Required value`);
    if (old && old.type !== o.type) errs.push('type: Invalid value: field is immutable');
  },
  CertificateSigningRequest(c, o, old, errs) {
    const s = o.spec || {};
    if (!s.signerName) errs.push('spec.signerName: Required value');
    if (!s.request) errs.push('spec.request: Required value');
    else {
      let pem = '';
      try { pem = b64dec(s.request); } catch { pem = ''; }
      if (!/-----BEGIN CERTIFICATE REQUEST-----/.test(pem)) errs.push('spec.request: Invalid value: []byte{...}: PEM block type must be CERTIFICATE REQUEST');
    }
    if (s.signerName === 'kubernetes.io/kube-apiserver-client') {
      const bad = (s.usages || []).filter((u) => !['client auth', 'digital signature', 'key encipherment'].includes(u));
      if (!(s.usages || []).includes('client auth') || bad.length) errs.push(`spec.usages: Unsupported value: "${bad[0] || (s.usages || [])[0] || ''}": supported values: "client auth", "digital signature", "key encipherment"`);
    }
    if (s.expirationSeconds !== undefined && s.expirationSeconds < 600) errs.push(`spec.expirationSeconds: Invalid value: ${s.expirationSeconds}: may not specify a duration less than 600 seconds (10 minutes)`);
  },
  Namespace(c, o, old, errs) { void c; void old; void errs; },
  EndpointSlice(c, o, old, errs) {
    if (!o.addressType) errs.push('addressType: Required value');
    else if (!['IPv4', 'IPv6', 'FQDN'].includes(o.addressType)) errs.push(`addressType: Unsupported value: "${o.addressType}": supported values: "FQDN", "IPv4", "IPv6"`);
    (o.endpoints || []).forEach((e, i) => {
      if (!(e.addresses || []).length) errs.push(`endpoints[${i}].addresses: Required value: must contain at least 1 address`);
      for (const a of e.addresses || []) if (o.addressType === 'IPv4' && !/^\d+\.\d+\.\d+\.\d+$/.test(a)) errs.push(`endpoints[${i}].addresses[0]: Invalid value: "${a}": must be a valid IPv4 address`);
    });
  },
  CustomResourceDefinition(c, o, old, errs) {
    const s = o.spec || {};
    if (!s.group) errs.push('spec.group: Required value');
    if (!s.names?.plural) errs.push('spec.names.plural: Required value');
    if (!s.names?.kind) errs.push('spec.names.kind: Required value');
    if (!['Namespaced', 'Cluster'].includes(s.scope)) errs.push(`spec.scope: Unsupported value: "${s.scope}": supported values: "Cluster", "Namespaced"`);
    if (!(s.versions || []).length) errs.push('spec.versions: Invalid value: null: must have exactly one version marked as storage version');
    if (s.group && s.names?.plural && o.metadata.name !== `${s.names.plural}.${s.group}`) errs.push(`metadata.name: Invalid value: "${o.metadata.name}": must be spec.names.plural+"."+spec.group`);
  },
};

function validateRules(rules, errs, cluster = false) {
  (rules || []).forEach((r, i) => {
    if (!(r.verbs || []).length) errs.push(`rules[${i}].verbs: Required value: verbs must contain at least one value`);
    if ((r.resources || []).length && !(r.apiGroups || []).length) errs.push(`rules[${i}].apiGroups: Required value: resource rules must supply at least one api group`);
    if (!(r.resources || []).length && !(r.nonResourceURLs || []).length) errs.push(`rules[${i}].resources: Required value: resource rules must supply at least one resource`);
    if (!cluster && (r.nonResourceURLs || []).length) errs.push(`rules[${i}].nonResourceURLs: Invalid value: ${JSON.stringify(r.nonResourceURLs)}: namespaced rules cannot apply to non-resource URLs`);
  });
}

function validateBinding(o, old, errs, cluster) {
  const rr = o.roleRef;
  if (!rr) errs.push('roleRef.name: Required value');
  else {
    if (!rr.name) errs.push('roleRef.name: Required value');
    if (!['Role', 'ClusterRole'].includes(rr.kind) || (cluster && rr.kind === 'Role')) errs.push(`roleRef.kind: Unsupported value: "${rr.kind}": supported values: ${cluster ? '"ClusterRole"' : '"ClusterRole", "Role"'}`);
    if (rr.apiGroup !== 'rbac.authorization.k8s.io') errs.push(`roleRef.apiGroup: Unsupported value: "${rr.apiGroup || ''}": supported values: "rbac.authorization.k8s.io"`);
  }
  (o.subjects || []).forEach((s, i) => {
    if (!['User', 'Group', 'ServiceAccount'].includes(s.kind)) errs.push(`subjects[${i}].kind: Unsupported value: "${s.kind}": supported values: "ServiceAccount", "User", "Group"`);
    if (!s.name) errs.push(`subjects[${i}].name: Required value`);
    if (s.kind === 'ServiceAccount' && cluster && !s.namespace) errs.push(`subjects[${i}].namespace: Required value`);
    if ((s.kind === 'User' || s.kind === 'Group') && s.apiGroup !== 'rbac.authorization.k8s.io') errs.push(`subjects[${i}].apiGroup: Unsupported value: "${s.apiGroup || ''}": supported values: "rbac.authorization.k8s.io"`);
  });
  if (old && !deepEqual(old.roleRef, o.roleRef)) errs.push(`roleRef: Invalid value: rbac.RoleRef{APIGroup:"rbac.authorization.k8s.io", Kind:"${rr?.kind}", Name:"${rr?.name}"}: cannot change roleRef`);
}
