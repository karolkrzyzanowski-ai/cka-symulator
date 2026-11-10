// Autoryzacja RBAC (jak w kube-apiserver --authorization-mode=Node,RBAC).

function ruleMatches(rule, a) {
  const verbs = rule.verbs || [];
  if (!verbs.includes('*') && !verbs.includes(a.verb)) return false;
  const groups = rule.apiGroups || [];
  if (!groups.includes('*') && !groups.includes(a.group)) return false;
  const res = a.subresource ? `${a.resource}/${a.subresource}` : a.resource;
  const resources = rule.resources || [];
  const ok = resources.includes('*') || resources.includes(res) || (a.subresource && resources.includes(`*/${a.subresource}`)) || (a.subresource && resources.includes(`${a.resource}/*`));
  if (!ok) return false;
  if ((rule.resourceNames || []).length) {
    if (!a.name || !rule.resourceNames.includes(a.name)) return false;
  }
  return true;
}

function subjectMatches(s, user, bindingNs) {
  if (s.kind === 'User') return s.name === user.name;
  if (s.kind === 'Group') return (user.groups || []).includes(s.name);
  if (s.kind === 'ServiceAccount') return user.name === `system:serviceaccount:${s.namespace || bindingNs}:${s.name}`;
  return false;
}

export function rulesFor(c, user, namespace) {
  const rules = [];
  const roleRules = (ref, ns) => {
    if (ref.kind === 'ClusterRole') {
      const cr = c.peek('clusterroles', null, ref.name);
      if (!cr) return [];
      let rs = cr.rules || [];
      // agregacja
      if (cr.aggregationRule) {
        for (const other of c.all('clusterroles')) {
          if ((cr.aggregationRule.clusterRoleSelectors || []).some((sel) => Object.entries(sel.matchLabels || {}).every(([k, v]) => other.metadata.labels?.[k] === v))) rs = rs.concat(other.rules || []);
        }
      }
      return rs;
    }
    const r = c.peek('roles', ns, ref.name);
    return r ? r.rules || [] : [];
  };
  for (const crb of c.all('clusterrolebindings')) {
    if ((crb.subjects || []).some((s) => subjectMatches(s, user, ''))) rules.push(...roleRules(crb.roleRef, null));
  }
  if (namespace) {
    for (const rb of c.all('rolebindings', namespace)) {
      if ((rb.subjects || []).some((s) => subjectMatches(s, user, namespace))) rules.push(...roleRules(rb.roleRef, namespace));
    }
  }
  return rules;
}

export function authorize(c, user, a) {
  if ((user.groups || []).includes('system:masters')) return true;
  // poświadczenia nieznane -> anonim nie ma uprawnień (poza discovery)
  const rules = rulesFor(c, { ...user, groups: [...(user.groups || []), 'system:authenticated'] }, a.namespace);
  return rules.some((r) => ruleMatches(r, a));
}

// ----------------------------------------------------------------- domyślne role klastra
const RO = ['get', 'list', 'watch'];
const RW = ['create', 'delete', 'deletecollection', 'get', 'list', 'patch', 'update', 'watch'];
const viewRules = [
  { apiGroups: [''], resources: ['configmaps', 'endpoints', 'persistentvolumeclaims', 'persistentvolumeclaims/status', 'pods', 'pods/log', 'pods/status', 'replicationcontrollers', 'replicationcontrollers/scale', 'replicationcontrollers/status', 'serviceaccounts', 'services', 'services/status'], verbs: RO },
  { apiGroups: [''], resources: ['bindings', 'events', 'limitranges', 'namespaces/status', 'pods/log', 'pods/status', 'replicationcontrollers/status', 'resourcequotas', 'resourcequotas/status'], verbs: RO },
  { apiGroups: [''], resources: ['namespaces'], verbs: RO },
  { apiGroups: ['discovery.k8s.io'], resources: ['endpointslices'], verbs: RO },
  { apiGroups: ['apps'], resources: ['controllerrevisions', 'daemonsets', 'daemonsets/status', 'deployments', 'deployments/scale', 'deployments/status', 'replicasets', 'replicasets/scale', 'replicasets/status', 'statefulsets', 'statefulsets/scale', 'statefulsets/status'], verbs: RO },
  { apiGroups: ['autoscaling'], resources: ['horizontalpodautoscalers', 'horizontalpodautoscalers/status'], verbs: RO },
  { apiGroups: ['batch'], resources: ['cronjobs', 'cronjobs/status', 'jobs', 'jobs/status'], verbs: RO },
  { apiGroups: ['policy'], resources: ['poddisruptionbudgets', 'poddisruptionbudgets/status'], verbs: RO },
  { apiGroups: ['networking.k8s.io'], resources: ['ingresses', 'ingresses/status', 'networkpolicies'], verbs: RO },
];
const editRules = [
  { apiGroups: [''], resources: ['pods/attach', 'pods/exec', 'pods/portforward', 'pods/proxy', 'secrets', 'services/proxy'], verbs: RO },
  { apiGroups: [''], resources: ['serviceaccounts'], verbs: ['impersonate'] },
  { apiGroups: [''], resources: ['pods', 'pods/attach', 'pods/exec', 'pods/portforward', 'pods/proxy'], verbs: ['create', 'delete', 'deletecollection', 'patch', 'update'] },
  { apiGroups: [''], resources: ['pods/eviction'], verbs: ['create'] },
  { apiGroups: [''], resources: ['configmaps', 'endpoints', 'persistentvolumeclaims', 'replicationcontrollers', 'replicationcontrollers/scale', 'secrets', 'serviceaccounts', 'services', 'services/proxy'], verbs: ['create', 'delete', 'deletecollection', 'patch', 'update'] },
  { apiGroups: ['apps'], resources: ['daemonsets', 'deployments', 'deployments/rollback', 'deployments/scale', 'replicasets', 'replicasets/scale', 'statefulsets', 'statefulsets/scale'], verbs: ['create', 'delete', 'deletecollection', 'patch', 'update'] },
  { apiGroups: ['autoscaling'], resources: ['horizontalpodautoscalers'], verbs: ['create', 'delete', 'deletecollection', 'patch', 'update'] },
  { apiGroups: ['batch'], resources: ['cronjobs', 'jobs'], verbs: ['create', 'delete', 'deletecollection', 'patch', 'update'] },
  { apiGroups: ['networking.k8s.io'], resources: ['ingresses', 'networkpolicies'], verbs: ['create', 'delete', 'deletecollection', 'patch', 'update'] },
  { apiGroups: ['discovery.k8s.io'], resources: ['endpointslices'], verbs: ['create', 'delete', 'deletecollection', 'patch', 'update'] },
  ...viewRules,
];
const adminRules = [
  { apiGroups: ['rbac.authorization.k8s.io'], resources: ['rolebindings', 'roles'], verbs: RW },
  { apiGroups: ['authorization.k8s.io'], resources: ['localsubjectaccessreviews'], verbs: ['create'] },
  ...editRules,
];

export function defaultRbac() {
  const cr = (name, rules, labels = {}) => ({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name, labels: { 'kubernetes.io/bootstrapping': 'rbac-defaults', ...labels }, annotations: { 'rbac.authorization.kubernetes.io/autoupdate': 'true' } }, rules });
  const crb = (name, role, subjects) => ({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name, labels: { 'kubernetes.io/bootstrapping': 'rbac-defaults' }, annotations: { 'rbac.authorization.kubernetes.io/autoupdate': 'true' } }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: role }, subjects });
  const G = (name) => ({ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name });
  const U = (name) => ({ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name });
  return [
    cr('cluster-admin', [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }, { nonResourceURLs: ['*'], verbs: ['*'] }]),
    cr('admin', adminRules, { 'rbac.authorization.k8s.io/aggregate-to-admin': 'true' }),
    cr('edit', editRules, { 'rbac.authorization.k8s.io/aggregate-to-edit': 'true' }),
    cr('view', viewRules, { 'rbac.authorization.k8s.io/aggregate-to-view': 'true' }),
    cr('system:basic-user', [{ apiGroups: ['authorization.k8s.io'], resources: ['selfsubjectaccessreviews', 'selfsubjectrulesreviews'], verbs: ['create'] }, { apiGroups: ['authentication.k8s.io'], resources: ['selfsubjectreviews'], verbs: ['create'] }]),
    cr('system:discovery', [{ nonResourceURLs: ['/api', '/api/*', '/apis', '/apis/*', '/healthz', '/livez', '/openapi', '/openapi/*', '/readyz', '/version', '/version/'], verbs: ['get'] }]),
    cr('system:node', [{ apiGroups: [''], resources: ['nodes', 'pods', 'services', 'endpoints', 'configmaps', 'secrets'], verbs: RO }]),
    cr('system:kube-scheduler', [{ apiGroups: ['*'], resources: ['*'], verbs: RO }]),
    cr('system:kube-controller-manager', [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }]),
    cr('system:certificates.k8s.io:certificatesigningrequests:nodeclient', [{ apiGroups: ['certificates.k8s.io'], resources: ['certificatesigningrequests/nodeclient'], verbs: ['create'] }]),
    crb('cluster-admin', 'cluster-admin', [G('system:masters')]),
    crb('kubeadm:cluster-admins', 'cluster-admin', [G('kubeadm:cluster-admins')]),
    crb('system:basic-user', 'system:basic-user', [G('system:authenticated')]),
    crb('system:discovery', 'system:discovery', [G('system:authenticated')]),
    crb('system:kube-scheduler', 'system:kube-scheduler', [U('system:kube-scheduler')]),
    crb('system:kube-controller-manager', 'system:kube-controller-manager', [U('system:kube-controller-manager')]),
    crb('system:node', 'system:node', [G('system:nodes')]),
  ];
}

// lista uprawnień dla `kubectl auth can-i --list`
export function listRules(c, user, ns) {
  if ((user.groups || []).includes('system:masters')) return [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }];
  return rulesFor(c, { ...user, groups: [...(user.groups || []), 'system:authenticated'] }, ns);
}
