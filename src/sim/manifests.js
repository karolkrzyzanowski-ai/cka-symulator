// Manifesty dostępne pod "zewnętrznymi" URL-ami (kubectl apply -f https://...).
import { dump } from '../lib/yaml.js';
import { certManagerCrds } from './crds.js';

function certManager(version) {
  const v = `v${version}`;
  const labels = (name, comp) => ({ app: name, 'app.kubernetes.io/name': name, 'app.kubernetes.io/instance': 'cert-manager', 'app.kubernetes.io/component': comp, 'app.kubernetes.io/version': v });
  const out = [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'cert-manager' } }, ...certManagerCrds(version)];
  for (const [name, image, comp, ports] of [
    ['cert-manager-cainjector', 'cert-manager-cainjector', 'cainjector', []],
    ['cert-manager', 'cert-manager-controller', 'controller', [{ containerPort: 9402, name: 'http-metrics', protocol: 'TCP' }]],
    ['cert-manager-webhook', 'cert-manager-webhook', 'webhook', [{ containerPort: 10250, name: 'https', protocol: 'TCP' }]],
  ]) {
    const l = labels(name, comp);
    const sel = { 'app.kubernetes.io/name': name, 'app.kubernetes.io/instance': 'cert-manager', 'app.kubernetes.io/component': comp };
    out.push({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name, namespace: 'cert-manager', labels: l } });
    out.push({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: `${name}-role`, labels: l }, rules: [{ apiGroups: ['cert-manager.io'], resources: ['*'], verbs: ['*'] }, { apiGroups: [''], resources: ['secrets', 'events', 'configmaps'], verbs: ['*'] }] });
    out.push({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name: `${name}-role`, labels: l }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: `${name}-role` }, subjects: [{ kind: 'ServiceAccount', name, namespace: 'cert-manager' }] });
    if (comp !== 'cainjector') out.push({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: 'cert-manager', labels: l }, spec: { type: 'ClusterIP', ports: [{ name: comp === 'webhook' ? 'https' : 'tcp-prometheus-servicemonitor', port: comp === 'webhook' ? 443 : 9402, protocol: 'TCP', targetPort: comp === 'webhook' ? 'https' : 9402 }], selector: sel } });
    out.push({
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: 'cert-manager', labels: l },
      spec: { replicas: 1, selector: { matchLabels: sel }, template: { metadata: { labels: l }, spec: { serviceAccountName: name, enableServiceLinks: false, securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } }, containers: [{ name: `cert-manager-${comp}`, image: `quay.io/jetstack/${image}:${v}`, imagePullPolicy: 'IfNotPresent', args: ['--v=2'], ...(ports.length ? { ports } : {}), env: [{ name: 'POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } }] }], nodeSelector: { 'kubernetes.io/os': 'linux' } } } },
    });
  }
  return out.map((o) => dump(o)).join('---\n');
}

export function manifestFor(url) {
  let m;
  if ((m = url.match(/^https:\/\/github\.com\/cert-manager\/cert-manager\/releases\/download\/v(1\.\d+\.\d+)\/cert-manager\.yaml$/))) return certManager(m[1]);
  if ((m = url.match(/^https:\/\/github\.com\/cert-manager\/cert-manager\/releases\/download\/v(1\.\d+\.\d+)\/cert-manager\.crds\.yaml$/))) return certManagerCrds(m[1]).map((o) => dump(o)).join('---\n');
  if (/^https:\/\/raw\.githubusercontent\.com\/kubernetes\/website\/main\/content\/en\/examples\/application\/deployment\.yaml$/.test(url) || url === 'https://k8s.io/examples/application/deployment.yaml') {
    return dump({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'nginx-deployment' }, spec: { selector: { matchLabels: { app: 'nginx' } }, replicas: 2, template: { metadata: { labels: { app: 'nginx' } }, spec: { containers: [{ name: 'nginx', image: 'nginx:1.28-alpine', ports: [{ containerPort: 80 }] }] } } } });
  }
  if (url === 'https://k8s.io/examples/pods/simple-pod.yaml') return dump({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'nginx' }, spec: { containers: [{ name: 'nginx', image: 'nginx:1.28-alpine', ports: [{ containerPort: 80 }] }] } });
  return null;
}
