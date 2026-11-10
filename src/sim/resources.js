// Rejestr typów zasobów (odpowiednik kubectl api-resources).

const R = (group, version, kind, plural, short = [], namespaced = true, extra = {}) => ({
  group, version, kind, plural, singular: kind.toLowerCase(), short, namespaced,
  apiVersion: group ? `${group}/${version}` : version, ...extra,
});

export const BUILTIN = [
  R('', 'v1', 'Binding', 'bindings', [], true, { hidden: true }),
  R('', 'v1', 'ComponentStatus', 'componentstatuses', ['cs'], false, { hidden: true }),
  R('', 'v1', 'ConfigMap', 'configmaps', ['cm']),
  R('', 'v1', 'Endpoints', 'endpoints', ['ep']),
  R('', 'v1', 'Event', 'events', ['ev']),
  R('', 'v1', 'LimitRange', 'limitranges', ['limits']),
  R('', 'v1', 'Namespace', 'namespaces', ['ns'], false),
  R('', 'v1', 'Node', 'nodes', ['no'], false),
  R('', 'v1', 'PersistentVolumeClaim', 'persistentvolumeclaims', ['pvc']),
  R('', 'v1', 'PersistentVolume', 'persistentvolumes', ['pv'], false),
  R('', 'v1', 'Pod', 'pods', ['po']),
  R('', 'v1', 'PodTemplate', 'podtemplates', []),
  R('', 'v1', 'ReplicationController', 'replicationcontrollers', ['rc']),
  R('', 'v1', 'ResourceQuota', 'resourcequotas', ['quota']),
  R('', 'v1', 'Secret', 'secrets', []),
  R('', 'v1', 'ServiceAccount', 'serviceaccounts', ['sa']),
  R('', 'v1', 'Service', 'services', ['svc']),
  R('admissionregistration.k8s.io', 'v1', 'MutatingWebhookConfiguration', 'mutatingwebhookconfigurations', [], false),
  R('admissionregistration.k8s.io', 'v1', 'ValidatingWebhookConfiguration', 'validatingwebhookconfigurations', [], false),
  R('apiextensions.k8s.io', 'v1', 'CustomResourceDefinition', 'customresourcedefinitions', ['crd', 'crds'], false),
  R('apiregistration.k8s.io', 'v1', 'APIService', 'apiservices', [], false),
  R('apps', 'v1', 'ControllerRevision', 'controllerrevisions', []),
  R('apps', 'v1', 'DaemonSet', 'daemonsets', ['ds']),
  R('apps', 'v1', 'Deployment', 'deployments', ['deploy']),
  R('apps', 'v1', 'ReplicaSet', 'replicasets', ['rs']),
  R('apps', 'v1', 'StatefulSet', 'statefulsets', ['sts']),
  R('authentication.k8s.io', 'v1', 'SelfSubjectReview', 'selfsubjectreviews', [], false, { hidden: true }),
  R('authentication.k8s.io', 'v1', 'TokenReview', 'tokenreviews', [], false, { hidden: true }),
  R('authorization.k8s.io', 'v1', 'SelfSubjectAccessReview', 'selfsubjectaccessreviews', [], false, { hidden: true }),
  R('authorization.k8s.io', 'v1', 'SubjectAccessReview', 'subjectaccessreviews', [], false, { hidden: true }),
  R('autoscaling', 'v2', 'HorizontalPodAutoscaler', 'horizontalpodautoscalers', ['hpa']),
  R('batch', 'v1', 'CronJob', 'cronjobs', ['cj']),
  R('batch', 'v1', 'Job', 'jobs', []),
  R('certificates.k8s.io', 'v1', 'CertificateSigningRequest', 'certificatesigningrequests', ['csr'], false),
  R('coordination.k8s.io', 'v1', 'Lease', 'leases', []),
  R('discovery.k8s.io', 'v1', 'EndpointSlice', 'endpointslices', []),
  R('events.k8s.io', 'v1', 'Event', 'events', ['ev'], true, { hidden: true, alias: 'events' }),
  R('flowcontrol.apiserver.k8s.io', 'v1', 'FlowSchema', 'flowschemas', [], false),
  R('flowcontrol.apiserver.k8s.io', 'v1', 'PriorityLevelConfiguration', 'prioritylevelconfigurations', [], false),
  R('networking.k8s.io', 'v1', 'IngressClass', 'ingressclasses', [], false),
  R('networking.k8s.io', 'v1', 'Ingress', 'ingresses', ['ing']),
  R('networking.k8s.io', 'v1', 'NetworkPolicy', 'networkpolicies', ['netpol']),
  R('node.k8s.io', 'v1', 'RuntimeClass', 'runtimeclasses', [], false),
  R('policy', 'v1', 'PodDisruptionBudget', 'poddisruptionbudgets', ['pdb']),
  R('rbac.authorization.k8s.io', 'v1', 'ClusterRoleBinding', 'clusterrolebindings', [], false),
  R('rbac.authorization.k8s.io', 'v1', 'ClusterRole', 'clusterroles', [], false),
  R('rbac.authorization.k8s.io', 'v1', 'RoleBinding', 'rolebindings', []),
  R('rbac.authorization.k8s.io', 'v1', 'Role', 'roles', []),
  R('scheduling.k8s.io', 'v1', 'PriorityClass', 'priorityclasses', ['pc'], false),
  R('storage.k8s.io', 'v1', 'CSIDriver', 'csidrivers', [], false),
  R('storage.k8s.io', 'v1', 'CSINode', 'csinodes', [], false),
  R('storage.k8s.io', 'v1', 'StorageClass', 'storageclasses', ['sc'], false),
  R('storage.k8s.io', 'v1', 'VolumeAttachment', 'volumeattachments', [], false),
];

export const resKey = (r) => (r.group ? `${r.plural}.${r.group}` : r.plural);

export class Registry {
  constructor() {
    this.list = BUILTIN.map((r) => ({ ...r }));
  }

  all({ includeHidden = false } = {}) {
    return this.list.filter((r) => includeHidden || !r.hidden);
  }

  add(r) {
    this.remove(r.group, r.plural);
    this.list.push({ singular: r.kind.toLowerCase(), short: [], apiVersion: `${r.group}/${r.version}`, ...r });
  }

  // rejestracja typu z obiektu CRD; zwraca true gdy coś się zmieniło
  syncCrd(crd) {
    const s = crd.spec || {};
    const storage = (s.versions || []).find((v) => v.storage) || (s.versions || [])[0];
    if (!storage || !s.names?.plural) return false;
    const existing = this.list.find((r) => r.group === s.group && r.plural === s.names.plural);
    const versions = (s.versions || []).filter((v) => v.served !== false).map((v) => v.name);
    if (existing && existing.version === storage.name && existing.kind === s.names.kind && (existing.versions || []).join() === versions.join()) return false;
    this.add({
      group: s.group, version: storage.name, versions,
      kind: s.names.kind, plural: s.names.plural, singular: s.names.singular || s.names.kind.toLowerCase(),
      short: s.names.shortNames || [], namespaced: s.scope !== 'Cluster', crd: true, categories: s.names.categories || [],
      columns: storage.additionalPrinterColumns || [],
    });
    return true;
  }

  remove(group, plural) {
    this.list = this.list.filter((x) => !(x.group === group && x.plural === plural));
  }

  byKind(apiVersion, kind) {
    const [g, v] = apiVersion.includes('/') ? apiVersion.split('/') : ['', apiVersion];
    return this.list.find((r) => r.kind === kind && r.group === g && (r.version === v || (r.versions || []).includes(v)))
      || null;
  }

  byKindAnyVersion(apiVersion, kind) {
    const g = apiVersion.includes('/') ? apiVersion.split('/')[0] : '';
    return this.list.find((r) => r.kind === kind && r.group === g) || null;
  }

  // nazwy jak w kubectl: po, pods, pod, deployments.apps, deploy.apps, deployment.v1.apps
  resolve(name) {
    if (!name) return null;
    const n = name.toLowerCase();
    const [first, ...rest] = n.split('.');
    let group = rest.join('.');
    let version = null;
    if (rest.length && /^v\d+(alpha\d+|beta\d+)?$/.test(rest[0])) { version = rest[0]; group = rest.slice(1).join('.'); }
    const cands = this.list.filter((r) => !r.alias && (r.plural === first || r.singular === first || r.short.includes(first) || r.kind.toLowerCase() === first));
    if (!cands.length) return null;
    if (rest.length) {
      const g = cands.find((r) => r.group === group && (!version || r.version === version));
      return g || null;
    }
    // preferencja: core, potem grupy wbudowane
    const prefer = ['', 'apps', 'batch', 'networking.k8s.io', 'rbac.authorization.k8s.io', 'storage.k8s.io', 'autoscaling'];
    cands.sort((a, b) => {
      const ia = prefer.indexOf(a.group), ib = prefer.indexOf(b.group);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return cands[0];
  }

  // nazwa do komunikatów błędów: deployments.apps, pods, certificates.cert-manager.io
  qualified(r) {
    return r.group ? `${r.plural}.${r.group}` : r.plural;
  }
}
