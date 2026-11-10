// Domena: Cluster Architecture, Installation & Configuration (25%).
import { task, NGINX, NGINX_OLD, configmap, deployment, TaskUnavailable } from './registry.js';
import { jp, condition, nodeReady, readyReplicas, safeJson, vcmp, goDuration, qeq, podReady } from './ctx.js';
import { hexHash } from '../lib/util.js';

const ETCD_FLAGS = '--endpoints=https://127.0.0.1:2379 --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key';

// =============================================================================== RBAC: ServiceAccount
task({
  id: 'rbac-sa', domain: 'cluster', title: 'RBAC: ServiceAccount, Role, RoleBinding', host: 'cp', minutes: 6,
  namespaces: ['rbac-team'],
  setup(c) { c.apply(deployment('web', 'rbac-team', NGINX)); },
  check(c, g) {
    const ns = 'rbac-team';
    g.ok('ServiceAccount ci-deployer istnieje', c.exists('serviceaccount', 'ci-deployer', ns));
    g.ok('Role deploy-manager istnieje', c.exists('role', 'deploy-manager', ns));
    const rb = c.get('rolebinding', 'ci-deployer-binding', ns);
    const bound = !!rb && jp(rb, 'roleRef.kind') === 'Role' && jp(rb, 'roleRef.name') === 'deploy-manager' && (rb.subjects || []).some((s) => s.kind === 'ServiceAccount' && s.name === 'ci-deployer' && (s.namespace || ns) === ns);
    g.ok('RoleBinding ci-deployer-binding wiąże Role deploy-manager z SA ci-deployer', bound);
    const who = `system:serviceaccount:${ns}:ci-deployer`;
    for (const [verb, res, nsp, want] of [
      ['create', 'deployments.apps', ns, true], ['update', 'deployments.apps', ns, true], ['patch', 'deployments.apps', ns, true], ['delete', 'deployments.apps', ns, true],
      ['watch', 'deployments.apps', ns, true], ['list', 'pods', ns, true], ['get', 'pods', ns, true],
      ['delete', 'pods', ns, false], ['get', 'secrets', ns, false], ['create', 'deployments.apps', 'default', false],
    ]) g.ok(`SA ${want ? 'MOŻE' : 'NIE może'}: ${verb} ${res} (ns ${nsp})`, c.can_i(verb, res, nsp, who) === want);
  },
  text: `
In namespace rbac-team:

1. Create a ServiceAccount named ci-deployer.
2. Create a Role named deploy-manager that allows the verbs
   get, list, watch, create, update, patch, delete on deployments (API group apps)
   and only get, list, watch on pods.
3. Bind the Role to the ServiceAccount with a RoleBinding named ci-deployer-binding.

The ServiceAccount must not be able to delete pods, read secrets,
or do anything outside of namespace rbac-team.
`,
  solution: `
kubectl -n rbac-team create serviceaccount ci-deployer

cat <<'EOF' | kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: deploy-manager
  namespace: rbac-team
rules:
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get","list","watch","create","update","patch","delete"]
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get","list","watch"]
EOF

kubectl -n rbac-team create rolebinding ci-deployer-binding \\
  --role=deploy-manager --serviceaccount=rbac-team:ci-deployer

# weryfikacja
kubectl auth can-i delete deployments -n rbac-team --as=system:serviceaccount:rbac-team:ci-deployer   # yes
kubectl auth can-i delete pods -n rbac-team --as=system:serviceaccount:rbac-team:ci-deployer          # no

# Skrót: 'kubectl create role' przyjmuje jeden zestaw verbów dla wszystkich --resource,
# dlatego dwie reguły najłatwiej zrobić YAML-em (albo create + kubectl edit).
`,
});

// =============================================================================== RBAC: użytkownik z CSR
task({
  id: 'rbac-user-csr', domain: 'cluster', title: 'Nowy użytkownik: certyfikat przez CSR API + kubeconfig', host: 'cp', minutes: 12,
  namespaces: ['audit'],
  setup(c) {
    c.delete('csr', 'jane');
    c.workdir(c.cfg.cp, '/opt/cka/jane');
    c.apply(deployment('ledger', 'audit', NGINX));
    c.apply(configmap('audit-settings', 'audit', { retention: '30d' }));
  },
  check(c, g) {
    const cp = c.cfg.cp;
    const csr = c.get('csr', 'jane');
    g.ok('CertificateSigningRequest jane istnieje', csr);
    g.ok('CSR używa signerName kubernetes.io/kube-apiserver-client', jp(csr, 'spec.signerName') === 'kubernetes.io/kube-apiserver-client');
    g.ok('CSR jest zatwierdzony i wydano certyfikat', condition(csr, 'Approved') === 'True' && jp(csr, 'status.certificate'));
    let r = c.ssh(cp, 'openssl x509 -in /opt/cka/jane/jane.crt -noout -subject');
    g.ok('/opt/cka/jane/jane.crt: certyfikat z CN=jane i O=auditors', r.ok && /CN\s*=\s*jane/.test(r.out) && /O\s*=\s*auditors/.test(r.out), r.text);
    const rb = c.get('rolebinding', 'auditors-view', 'audit');
    g.ok('RoleBinding auditors-view: ClusterRole view -> Group auditors', rb && jp(rb, 'roleRef.kind') === 'ClusterRole' && jp(rb, 'roleRef.name') === 'view' && (rb.subjects || []).some((s) => s.kind === 'Group' && s.name === 'auditors'));
    const kc = '/opt/cka/jane/jane.kubeconfig';
    r = c.ssh(cp, `grep -q client-certificate-data ${kc} && grep -q client-key-data ${kc}`);
    g.ok('kubeconfig ma osadzone (embedded) certyfikat i klucz', r.ok);
    r = c.ssh(cp, `kubectl --kubeconfig ${kc} config current-context`);
    g.ok('current-context = jane@cka', r.out.trim() === 'jane@cka', r.text);
    r = c.ssh(cp, `kubectl --kubeconfig ${kc} get pods -n audit`);
    g.ok('jane może listować pody w ns audit', r.ok, r.text);
    r = c.ssh(cp, `kubectl --kubeconfig ${kc} get secrets -n audit`);
    g.ok('jane NIE może czytać secrets', !r.ok && r.text.toLowerCase().includes('forbidden'), r.text);
    r = c.ssh(cp, `kubectl --kubeconfig ${kc} get pods -n default`);
    g.ok('jane NIE ma dostępu poza ns audit', !r.ok, r.text);
  },
  cleanup(c) { c.delete('csr', 'jane'); },
  text: `
Create credentials for a new user jane. Work in directory /opt/cka/jane on <<cp>>.

1. Generate a private key jane.key and a certificate signing request for
   CN=jane, O=auditors.
2. Submit it as a CertificateSigningRequest named jane
   (signer kubernetes.io/kube-apiserver-client, usage client auth, valid 24h),
   approve it and save the issued certificate as /opt/cka/jane/jane.crt.
3. Members of group auditors must have read-only access (ClusterRole view)
   in namespace audit only. Create a RoleBinding auditors-view.
4. Create kubeconfig /opt/cka/jane/jane.kubeconfig with embedded certificates
   (cluster CA, client certificate and key) and a context named jane@cka
   set as current context. The API server is https://<<cp_ip>>:6443.
`,
  solution: `
cd /opt/cka/jane
openssl genrsa -out jane.key 2048
openssl req -new -key jane.key -subj "/CN=jane/O=auditors" -out jane.csr

cat <<EOF | kubectl apply -f -
apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata:
  name: jane
spec:
  request: $(base64 -w0 jane.csr)
  signerName: kubernetes.io/kube-apiserver-client
  expirationSeconds: 86400
  usages: ["client auth"]
EOF
kubectl certificate approve jane
kubectl get csr jane -o jsonpath='{.status.certificate}' | base64 -d > jane.crt

kubectl -n audit create rolebinding auditors-view --clusterrole=view --group=auditors

K=/opt/cka/jane/jane.kubeconfig
kubectl config --kubeconfig=$K set-cluster cka --server=https://<<cp_ip>>:6443 \\
  --certificate-authority=/etc/kubernetes/pki/ca.crt --embed-certs=true
kubectl config --kubeconfig=$K set-credentials jane --client-key=jane.key \\
  --client-certificate=jane.crt --embed-certs=true
kubectl config --kubeconfig=$K set-context jane@cka --cluster=cka --user=jane
kubectl config --kubeconfig=$K use-context jane@cka
kubectl --kubeconfig=$K get pods -n audit
`,
});

// =============================================================================== etcd backup
task({
  id: 'etcd-backup', domain: 'cluster', title: 'Kopia zapasowa etcd', host: 'cp', minutes: 6,
  namespaces: ['etcd-check'],
  setup(c) {
    const marker = `cka-marker-${c.token(6)}`;
    c.state.marker = marker;
    c.apply(configmap('etcd-marker', 'etcd-check', { value: marker }));
    const u = c.cfg.vm_user;
    c.sh(c.cfg.cp, `rm -rf /opt/cka/etcd && mkdir -p /opt/cka/etcd && chown ${u}:${u} /opt/cka/etcd`);
  },
  check(c, g) {
    const cp = c.cfg.cp, f = '/opt/cka/etcd/snapshot.db';
    let r = c.ssh(cp, `test -s ${f}`, true);
    g.ok(`${f} istnieje i nie jest pusty`, r.ok);
    r = c.ssh(cp, `etcdutl snapshot status ${f} -w json 2>/dev/null || ETCDCTL_API=3 etcdctl snapshot status ${f} -w json`, true);
    g.ok('snapshot jest poprawny (etcdutl snapshot status)', r.ok && r.out.toLowerCase().includes('revision'), r.text);
    r = c.ssh(cp, `grep -a -q ${c.state.marker || 'x'} ${f}`, true);
    g.ok('snapshot wykonano w trakcie zadania (zawiera aktualne dane klastra)', r.ok);
    const st = c.read(cp, '/opt/cka/etcd/status.txt');
    g.ok("status.txt zawiera wynik 'snapshot status' (HASH/REVISION)", st && /revision/i.test(st) && /hash/i.test(st));
  },
  text: `
On <<cp>>:

1. Create a snapshot of the etcd instance running at https://127.0.0.1:2379
   and save it to /opt/cka/etcd/snapshot.db.
   TLS files: CA /etc/kubernetes/pki/etcd/ca.crt,
              cert /etc/kubernetes/pki/etcd/server.crt,
              key /etc/kubernetes/pki/etcd/server.key
2. Verify the snapshot and write its status in table format to
   /opt/cka/etcd/status.txt.
`,
  solution: `
sudo ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \\
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \\
  --cert=/etc/kubernetes/pki/etcd/server.crt \\
  --key=/etc/kubernetes/pki/etcd/server.key \\
  snapshot save /opt/cka/etcd/snapshot.db

sudo etcdutl snapshot status /opt/cka/etcd/snapshot.db -w table | sudo tee /opt/cka/etcd/status.txt

# Ścieżki certyfikatów zawsze możesz odczytać z: sudo cat /etc/kubernetes/manifests/etcd.yaml
`,
});

// =============================================================================== etcd restore
task({
  id: 'etcd-restore', domain: 'cluster', title: 'Odtworzenie klastra z kopii etcd', host: 'cp', minutes: 12,
  exam: false, conflicts: ['controlplane'], disruptive: true, namespaces: ['etcd-restore-lab'],
  setup(c) {
    const ns = 'etcd-restore-lab';
    c.apply([configmap('config-a', ns, { k: 'a' }), configmap('config-b', ns, { k: 'b' })]);
    c.sh(c.cfg.cp, `
rm -rf /opt/cka/etcd-restore /var/lib/etcd-restored
mkdir -p /opt/cka/etcd-restore
ETCDCTL_API=3 etcdctl ${ETCD_FLAGS} snapshot save /opt/cka/etcd-restore/backup.db >/dev/null
`);
    c.k('delete', 'configmap', 'config-a', 'config-b', '-n', ns);
    c.apply(configmap('created-after-backup', ns, { k: 'late' }));
  },
  check(c, g) {
    const cp = c.cfg.cp, ns = 'etcd-restore-lab';
    const man = c.read(cp, '/etc/kubernetes/manifests/etcd.yaml') || '';
    g.ok('etcd korzysta z katalogu danych /var/lib/etcd-restored (hostPath)', man.includes('/var/lib/etcd-restored'));
    const r = c.ssh(cp, 'test -d /var/lib/etcd-restored/member', true);
    g.ok('/var/lib/etcd-restored zawiera przywrócone dane', r.ok);
    const up = c.wait_until(() => c.api_ok(), 60);
    g.ok('API server odpowiada', up);
    g.ok('ConfigMapy config-a i config-b zostały odtworzone', c.exists('configmap', 'config-a', ns) && c.exists('configmap', 'config-b', ns));
    g.ok('ConfigMap created-after-backup nie istnieje (stan sprzed backupu)', up && !c.exists('configmap', 'created-after-backup', ns));
    const nodes = c.nodes();
    g.ok('wszystkie węzły Ready', Object.keys(nodes).length && Object.values(nodes).every(nodeReady));
  },
  text: `
A snapshot of etcd was saved to /opt/cka/etcd-restore/backup.db on <<cp>>.
Since then some objects in namespace etcd-restore-lab were deleted by mistake.

Restore the cluster state from this snapshot. Use /var/lib/etcd-restored as the
new etcd data directory. After the restore the cluster must be fully operational.
`,
  solution: `
sudo etcdutl snapshot restore /opt/cka/etcd-restore/backup.db --data-dir /var/lib/etcd-restored

# wskaż nowy katalog w statycznym podzie etcd (wolumen etcd-data -> hostPath.path)
sudo vim /etc/kubernetes/manifests/etcd.yaml
#   volumes:
#   - hostPath:
#       path: /var/lib/etcd-restored     # <- zmiana
#       type: DirectoryOrCreate
#     name: etcd-data
# (--data-dir=/var/lib/etcd w command zostaje - to ścieżka WEWNĄTRZ kontenera)

# kubelet sam zrestartuje etcd; po 1-2 minutach:
kubectl get cm -n etcd-restore-lab
# jeśli apiserver "wisi": sudo crictl ps -a | grep -E 'etcd|apiserver'; ewentualnie restart kubelet

# UWAGA: to zadanie nie trafia do egzaminu próbnego, bo restore cofa też Twoje
# rozwiązania innych zadań. Po ćwiczeniu najlepiej zresetuj klaster w aplikacji.
`,
  test: `
sudo etcdutl snapshot restore /opt/cka/etcd-restore/backup.db --data-dir /var/lib/etcd-restored
sudo sed -i 's#path: /var/lib/etcd$#path: /var/lib/etcd-restored#' /etc/kubernetes/manifests/etcd.yaml
sleep 90
kubectl get cm -n etcd-restore-lab
`,
});

// =============================================================================== kubeadm upgrade
task({
  id: 'kubeadm-upgrade', domain: 'cluster', title: 'Aktualizacja klastra kubeadm (control plane + worker)', host: 'cp', minutes: 15,
  conflicts: ['upgrade', 'controlplane', 'node-w1'], disruptive: true,
  available(c) {
    const cp = c.cfg.cp;
    const nodes = c.nodes();
    const cur = jp(nodes[cp], 'status.nodeInfo.kubeletVersion', '');
    if (!cur) throw new TaskUnavailable('nie mogę odczytać wersji kubeleta na control-plane');
    const curv = cur.replace(/^v/, '');
    const r = c.ssh(cp, "apt-get update -qq >/dev/null 2>&1; apt-cache madison kubeadm | awk '{print $3}'", true);
    const pkgs = r.out.split(/\s+/).filter(Boolean);
    const newer = pkgs.filter((p) => vcmp(p.split('-')[0], curv) > 0).sort(vcmp);
    if (!newer.length) throw new TaskUnavailable(`klaster ma już najnowszą wersję (${cur}). Zresetuj klaster, aby ćwiczyć upgrade.`);
    const pkg = newer[newer.length - 1];
    Object.assign(c.state, { pkg, target: pkg.split('-')[0], from: cur, repo_minor: curv.split('.').slice(0, 2).join('.'), w2_from: jp(nodes[c.cfg.w2], 'status.nodeInfo.kubeletVersion', ''), repo_note: '' });
  },
  check(c, g) {
    const t = c.state.target || '?';
    const { cp, w1, w2 } = c.cfg;
    const nodes = c.nodes();
    const kv = (n) => jp(nodes[n], 'status.nodeInfo.kubeletVersion');
    let r = c.ssh(cp, 'kubeadm version -o short');
    g.ok(`${cp}: kubeadm v${t}`, r.out.trim() === `v${t}`, r.text);
    const api = c.pods('kube-system', 'component=kube-apiserver');
    g.ok(`control plane (kube-apiserver) w wersji v${t}`, api.length && api.every((p) => String(jp(p, 'spec.containers.0.image', '')).endsWith(`:v${t}`)));
    g.ok(`${cp}: kubelet v${t}`, kv(cp) === `v${t}`, kv(cp));
    r = c.ssh(cp, 'kubectl version --client -o json');
    g.ok(`${cp}: kubectl v${t}`, jp(safeJson(r.out), 'clientVersion.gitVersion') === `v${t}`);
    g.ok(`${w1}: kubelet v${t}`, kv(w1) === `v${t}`, kv(w1));
    r = c.ssh(w1, 'kubeadm version -o short');
    g.ok(`${w1}: kubeadm v${t}`, r.out.trim() === `v${t}`, r.text);
    g.ok(`${w2}: bez zmian (${c.state.w2_from})`, kv(w2) === c.state.w2_from, kv(w2));
    for (const n of [cp, w1]) g.ok(`${n}: Ready i schedulable (uncordon)`, nodeReady(nodes[n]) && !jp(nodes[n], 'spec.unschedulable'));
  },
  text: `
The cluster runs Kubernetes <<from>>. Upgrade it to v<<target>>:

- Upgrade the control plane node <<cp>>: kubeadm, control plane components,
  kubelet and kubectl.
- Upgrade the worker node <<w1>>: kubeadm, node configuration, kubelet and kubectl.
- Drain each node before upgrading its kubelet and make it schedulable again afterwards.
- Do NOT upgrade <<w2>>.

Package version to use: <<pkg>>. <<repo_note>>
`,
  solution: `
### <<cp>>
sudo apt-mark unhold kubeadm
sudo apt-get update && sudo apt-get install -y kubeadm='<<pkg>>'
sudo apt-mark hold kubeadm
sudo kubeadm upgrade plan
sudo kubeadm upgrade apply v<<target>> -y

kubectl drain <<cp>> --ignore-daemonsets
sudo apt-mark unhold kubelet kubectl
sudo apt-get install -y kubelet='<<pkg>>' kubectl='<<pkg>>'
sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload && sudo systemctl restart kubelet
kubectl uncordon <<cp>>

### <<w1>>   (ssh <<w1>>)
ssh <<w1>>
sudo apt-mark unhold kubeadm
sudo apt-get update && sudo apt-get install -y kubeadm='<<pkg>>'
sudo apt-mark hold kubeadm
sudo kubeadm upgrade node
kubectl drain <<w1>> --ignore-daemonsets --delete-emptydir-data
sudo apt-mark unhold kubelet kubectl
sudo apt-get install -y kubelet='<<pkg>>' kubectl='<<pkg>>'
sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload && sudo systemctl restart kubelet
kubectl uncordon <<w1>>
exit

kubectl get nodes
`,
});

// =============================================================================== dołączenie węzła
task({
  id: 'node-join', domain: 'cluster', title: 'Dołączenie workera do klastra (kubeadm join)', host: 'cp', minutes: 8,
  conflicts: ['node-w2'], disruptive: true,
  setup(c) {
    const w2 = c.cfg.w2;
    c.kubectl('drain', w2, '--ignore-daemonsets', '--delete-emptydir-data', '--force', '--timeout=120s');
    c.kubectl('delete', 'node', w2, '--wait=true', '--timeout=60s');
    c.sh(w2, `
kubeadm reset -f >/dev/null 2>&1 || true
rm -rf /etc/cni/net.d/*
iptables -F && iptables -t nat -F && iptables -t mangle -F && iptables -X || true
systemctl restart containerd
`);
  },
  check(c, g) {
    const w2 = c.cfg.w2;
    const n = c.get('node', w2);
    g.ok(`węzeł ${w2} jest w klastrze`, n);
    g.ok(`${w2} jest Ready`, n && nodeReady(n));
    g.ok(`${w2} jest workerem (bez roli control-plane)`, n && !('node-role.kubernetes.io/control-plane' in (jp(n, 'metadata.labels', {}) || {})));
    const r = c.ssh(w2, 'systemctl is-active kubelet && systemctl is-enabled kubelet');
    g.ok(`kubelet na ${w2} działa i jest enabled`, r.ok, r.text);
    const cal = c.pods('kube-system', 'k8s-app=calico-node').filter((p) => jp(p, 'spec.nodeName') === w2);
    g.ok(`calico-node działa na ${w2}`, cal.length && cal.every((p) => jp(p, 'status.phase') === 'Running'));
  },
  cleanup(c) {
    const w2 = c.cfg.w2;
    if (c.get('node', w2) === null) {
      const join = c.sh(c.cfg.cp, 'kubeadm token create --print-join-command').trim();
      c.sh(w2, `${join} --node-name ${w2}`);
    }
  },
  text: `
Node <<w2>> was removed from the cluster and reset with "kubeadm reset".

Join <<w2>> to the cluster again as a worker node. The node must be Ready.
All required packages are still installed on <<w2>>.
`,
  solution: `
# na <<cp>>: wygeneruj polecenie join (token ważny 24h)
sudo kubeadm token create --print-join-command

# na <<w2>>
ssh <<w2>>
sudo kubeadm join <<cp_ip>>:6443 --token <TOKEN> --discovery-token-ca-cert-hash sha256:<HASH>
exit

kubectl get nodes -w
`,
  test: `
JOIN=$(sudo kubeadm token create --print-join-command)
ssh <<w2>> "sudo $JOIN"
sleep 60
kubectl get nodes
`,
});

// =============================================================================== Helm
task({
  id: 'helm-install', domain: 'cluster', title: 'Helm: repozytorium, instalacja z wartościami', host: 'cp', minutes: 6,
  namespaces: ['helm-apps'],
  setup(c) { c.ssh(c.cfg.cp, 'helm repo remove podinfo >/dev/null 2>&1 || true'); },
  check(c, g) {
    const cp = c.cfg.cp, ns = 'helm-apps', ver = c.cfg.placeholders().podinfo_version;
    let r = c.ssh(cp, 'helm repo list -o json');
    const repos = safeJson(r.out) || [];
    g.ok("repo 'podinfo' dodane (https://stefanprodan.github.io/podinfo)", repos.some((x) => x.name === 'podinfo' && String(x.url || '').includes('stefanprodan.github.io/podinfo')));
    r = c.ssh(cp, `helm list -n ${ns} -o json`);
    const rel = (safeJson(r.out) || []).find((x) => x.name === 'web');
    g.ok("release 'web' w ns helm-apps ma status deployed", rel && rel.status === 'deployed', r.text);
    g.ok(`chart podinfo w wersji ${ver}`, rel && rel.chart === `podinfo-${ver}`, rel && rel.chart);
    const vals = safeJson(c.ssh(cp, `helm get values web -n ${ns} -o json`).out) || {};
    g.ok('values: replicaCount=2', String(vals.replicaCount) === '2', vals);
    g.ok('values: ui.message="Hello CKA"', jp(vals, 'ui.message') === 'Hello CKA', vals);
    g.ok('values: service.type=NodePort, service.nodePort=30090', jp(vals, 'service.type') === 'NodePort' && String(jp(vals, 'service.nodePort')) === '30090', vals);
    const deps = c.list('deployments', ns);
    g.ok('aplikacja ma 2 gotowe repliki', deps.length && readyReplicas(deps[0]) === 2);
    const [ok, st, body] = c.http_retry(`http://${c.cfg.ip(c.cfg.w1)}:30090/`, 'Hello CKA', null, null, 3);
    g.ok(`http://${c.cfg.ip(c.cfg.w1)}:30090/ zwraca 'Hello CKA'`, ok, `HTTP ${st}: ${body.slice(0, 200)}`);
  },
  text: `
Using Helm on <<cp>>:

1. Add the chart repository https://stefanprodan.github.io/podinfo with the name podinfo.
2. Install chart podinfo/podinfo in version <<podinfo_version>> as release web
   in the existing namespace helm-apps with these values:
     replicaCount: 2
     ui.message: "Hello CKA"
     service.type: NodePort
     service.nodePort: 30090
3. The application must respond on http://<<w1_ip>>:30090/
`,
  solution: `
helm repo add podinfo https://stefanprodan.github.io/podinfo
helm repo update
helm search repo podinfo --versions | head
helm install web podinfo/podinfo --version <<podinfo_version>> -n helm-apps \\
  --set replicaCount=2 --set ui.message="Hello CKA" \\
  --set service.type=NodePort --set service.nodePort=30090
helm list -n helm-apps
curl -s http://<<w1_ip>>:30090/ | grep message

# (dostępne wartości chartu: helm show values podinfo/podinfo --version <<podinfo_version>>)
`,
  test: `
helm repo add podinfo https://stefanprodan.github.io/podinfo
helm repo update
helm install web podinfo/podinfo --version <<podinfo_version>> -n helm-apps --set replicaCount=2 --set ui.message="Hello CKA" --set service.type=NodePort --set service.nodePort=30090
kubectl -n helm-apps rollout status deploy/web-podinfo --timeout=120s
curl -s http://<<w1_ip>>:30090/ | grep message
`,
});

// =============================================================================== Kustomize
const BASE_DEPLOY = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: shop
  labels:
    app: shop
spec:
  replicas: 1
  selector:
    matchLabels:
      app: shop
  template:
    metadata:
      labels:
        app: shop
    spec:
      containers:
      - name: shop
        image: ${NGINX_OLD}
        ports:
        - containerPort: 80
`;
const BASE_SVC = `apiVersion: v1
kind: Service
metadata:
  name: shop
  labels:
    app: shop
spec:
  selector:
    app: shop
  ports:
  - port: 80
    targetPort: 80
`;
const BASE_KUST = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- deployment.yaml
- service.yaml
`;

task({
  id: 'kustomize-overlay', domain: 'cluster', title: 'Kustomize: overlay dla produkcji', host: 'cp', minutes: 8,
  namespaces: ['shop-prod'],
  setup(c) {
    const cp = c.cfg.cp, u = c.cfg.vm_user, base = '/opt/cka/kustomize/base';
    c.sh(cp, 'rm -rf /opt/cka/kustomize');
    for (const [name, body] of [['deployment.yaml', BASE_DEPLOY], ['service.yaml', BASE_SVC], ['kustomization.yaml', BASE_KUST]]) c.put(cp, `${base}/${name}`, body, '0644', `${u}:${u}`);
    c.sh(cp, `chown -R ${u}:${u} /opt/cka/kustomize`);
    c.state.base_sha = hexHash(BASE_DEPLOY + BASE_SVC + BASE_KUST, 64);
  },
  check(c, g) {
    const cp = c.cfg.cp, ns = 'shop-prod', ov = '/opt/cka/kustomize/overlays/prod';
    let r = c.ssh(cp, `ls ${ov}/kustomization.yaml ${ov}/kustomization.yml ${ov}/Kustomization 2>/dev/null | head -1`);
    g.ok(`${ov}/kustomization.yaml istnieje`, r.out.trim());
    r = c.ssh(cp, `kubectl kustomize ${ov}`);
    g.ok('overlay renderuje się poprawnie (kubectl kustomize)', r.ok && r.out.includes('prod-shop'), r.text.slice(-300));
    const base = ['deployment.yaml', 'service.yaml', 'kustomization.yaml'].map((n) => c.read(cp, `/opt/cka/kustomize/base/${n}`) || '').join('');
    g.ok('base nie został zmodyfikowany', hexHash(base, 64) === c.state.base_sha);
    const d = c.get('deployment', 'prod-shop', ns);
    g.ok('Deployment prod-shop istnieje w ns shop-prod', d);
    g.ok('prod-shop: 3 repliki (wszystkie gotowe)', d && jp(d, 'spec.replicas') === 3 && readyReplicas(d) === 3);
    g.ok(`prod-shop: obraz ${NGINX}`, jp(d, 'spec.template.spec.containers.0.image') === NGINX);
    const s = c.get('service', 'prod-shop', ns);
    g.ok('Service prod-shop istnieje w ns shop-prod', s);
    g.ok('label env=prod na Deployment i Service', jp(d, 'metadata.labels.env') === 'prod' && jp(s, 'metadata.labels.env') === 'prod');
    g.ok('Service prod-shop ma gotowe endpointy', c.endpoints_ready('prod-shop', ns) >= 1);
  },
  text: `
A Kustomize base exists in /opt/cka/kustomize/base on <<cp>>. Do not modify the base.

Create an overlay in /opt/cka/kustomize/overlays/prod that:
  - uses the base
  - places all resources in namespace shop-prod (already exists)
  - adds the name prefix prod-
  - adds the label env: prod to all resources
  - runs 3 replicas of deployment shop
  - uses image nginx:1.28-alpine instead of nginx:1.27-alpine

Apply the overlay to the cluster.
`,
  solution: `
mkdir -p /opt/cka/kustomize/overlays/prod
cat > /opt/cka/kustomize/overlays/prod/kustomization.yaml <<'EOF'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- ../../base
namespace: shop-prod
namePrefix: prod-
labels:
- pairs:
    env: prod
replicas:
- name: shop
  count: 3
images:
- name: nginx
  newTag: 1.28-alpine
EOF
kubectl kustomize /opt/cka/kustomize/overlays/prod     # podgląd
kubectl apply -k /opt/cka/kustomize/overlays/prod

# (zamiast 'labels' działa też przestarzałe 'commonLabels' - ono zmienia także selektory)
`,
});

// =============================================================================== CRD
const CRDS = `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: databases.ops.cka.io
spec:
  group: ops.cka.io
  scope: Namespaced
  names:
    plural: databases
    singular: database
    kind: Database
    shortNames: [cdb]
  versions:
  - name: v1alpha1
    served: true
    storage: true
    additionalPrinterColumns:
    - name: Engine
      type: string
      jsonPath: .spec.engine
    - name: Storage
      type: integer
      jsonPath: .spec.storageGB
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            required: [engine, storageGB]
            properties:
              engine:
                type: string
                description: Database engine to deploy.
                enum: [postgres, mysql, mariadb]
              version:
                type: string
                description: Engine version.
              storageGB:
                type: integer
                minimum: 1
                description: Size of the data volume in GB.
              replicas:
                type: integer
                minimum: 1
                default: 1
                description: Number of database instances.
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: backuppolicies.storage.cka.io
spec:
  group: storage.cka.io
  scope: Cluster
  names:
    plural: backuppolicies
    singular: backuppolicy
    kind: BackupPolicy
  versions:
  - name: v1
    served: true
    storage: true
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            properties:
              schedule:
                type: string
              retentionDays:
                type: integer
`;

task({
  id: 'crd-custom-resource', domain: 'cluster', title: 'CRD: odkrywanie i tworzenie custom resources', host: 'cp', minutes: 6,
  namespaces: ['crd-lab'],
  setup(c) {
    c.kubectl('delete', 'crd', 'databases.ops.cka.io', 'backuppolicies.storage.cka.io', '--ignore-not-found', '--wait=true');
    c.k('apply', '-f', '-', { input: CRDS });
    c.wait('--for=condition=Established', 'crd/databases.ops.cka.io', 'crd/backuppolicies.storage.cka.io', { timeout: 60 });
    c.workdir(c.cfg.cp, '/opt/cka/crd');
  },
  check(c, g) {
    const cp = c.cfg.cp;
    const txt = c.read(cp, '/opt/cka/crd/crds.txt') || '';
    const names = new Set(txt.split('\n').map((l) => l.trim().split('/').pop()).filter(Boolean));
    g.ok('crds.txt zawiera dokładnie CRD z grup *.cka.io', names.size === 2 && names.has('databases.ops.cka.io') && names.has('backuppolicies.storage.cka.io'), `jest: ${[...names].sort().join(', ')}`);
    const ex = (c.read(cp, '/opt/cka/crd/engine.txt') || '').toLowerCase();
    g.ok('engine.txt zawiera dokumentację pola spec.engine (kubectl explain)', ex.includes('engine') && ex.includes('database engine to deploy'));
    const db = c.get('database.ops.cka.io', 'orders-db', 'crd-lab');
    g.ok('Database orders-db istnieje w ns crd-lab', db);
    g.ok('spec.engine = postgres', jp(db, 'spec.engine') === 'postgres');
    g.ok('spec.version = "16" (string)', jp(db, 'spec.version') === '16');
    g.ok('spec.storageGB = 20', jp(db, 'spec.storageGB') === 20);
    g.ok('spec.replicas = 2', jp(db, 'spec.replicas') === 2);
  },
  cleanup(c) { c.kubectl('delete', 'crd', 'databases.ops.cka.io', 'backuppolicies.storage.cka.io', '--ignore-not-found', '--wait=false'); },
  text: `
Some CustomResourceDefinitions were installed in the cluster.

1. Write the names of all CRDs whose API group ends with .cka.io to
   /opt/cka/crd/crds.txt on <<cp>> (one name per line).
2. Write the documentation of field spec.engine of kind Database, as printed by
   kubectl explain, to /opt/cka/crd/engine.txt.
3. Create a Database named orders-db in namespace crd-lab with
   engine postgres, version "16", storageGB 20 and replicas 2.
`,
  solution: `
kubectl get crd | grep cka.io
kubectl get crd -o name | grep '\\.cka\\.io$' | cut -d/ -f2 > /opt/cka/crd/crds.txt

kubectl api-resources | grep -i database
kubectl explain database.spec.engine > /opt/cka/crd/engine.txt

cat <<'EOF' | kubectl apply -f -
apiVersion: ops.cka.io/v1alpha1
kind: Database
metadata:
  name: orders-db
  namespace: crd-lab
spec:
  engine: postgres
  version: "16"
  storageGB: 20
  replicas: 2
EOF
kubectl get databases -n crd-lab
`,
});

// =============================================================================== operator: cert-manager
task({
  id: 'operator-cert-manager', domain: 'cluster', title: 'Operator: instalacja cert-manager i jego CRD', host: 'cp', minutes: 10,
  namespaces: ['tls-lab'],
  check(c, g) {
    const ns = 'tls-lab';
    for (const d of ['cert-manager', 'cert-manager-webhook', 'cert-manager-cainjector']) g.ok(`deployment ${d} gotowy (ns cert-manager)`, readyReplicas(c.get('deployment', d, 'cert-manager')) >= 1);
    const ci = c.get('clusterissuer', 'selfsigned-issuer');
    g.ok('ClusterIssuer selfsigned-issuer (selfSigned) istnieje', ci && 'selfSigned' in (ci.spec || {}));
    g.ok('ClusterIssuer jest Ready', condition(ci, 'Ready') === 'True');
    const crt = c.get('certificate.cert-manager.io', 'web-cert', ns);
    g.ok('Certificate web-cert istnieje w ns tls-lab', crt);
    g.ok('secretName = web-tls', jp(crt, 'spec.secretName') === 'web-tls');
    g.ok('dnsNames zawiera web.cka.local', (jp(crt, 'spec.dnsNames', []) || []).includes('web.cka.local'));
    g.ok('duration = 2160h', goDuration(jp(crt, 'spec.duration')) === 2160 * 3600, jp(crt, 'spec.duration'));
    g.ok('issuerRef -> ClusterIssuer selfsigned-issuer', jp(crt, 'spec.issuerRef.kind') === 'ClusterIssuer' && jp(crt, 'spec.issuerRef.name') === 'selfsigned-issuer');
    g.ok('Certificate jest Ready', condition(crt, 'Ready') === 'True');
    const s = c.get('secret', 'web-tls', ns);
    g.ok('Secret web-tls typu kubernetes.io/tls', jp(s, 'type') === 'kubernetes.io/tls');
  },
  cleanup(c) { if (c.exists('crd', 'clusterissuers.cert-manager.io')) c.delete('clusterissuer', 'selfsigned-issuer'); },
  text: `
1. Install the cert-manager operator v<<cert_manager_version>> using the official manifest:
   https://github.com/cert-manager/cert-manager/releases/download/v<<cert_manager_version>>/cert-manager.yaml
   Wait until all its deployments are available.
2. Create a ClusterIssuer named selfsigned-issuer of type selfSigned.
3. In namespace tls-lab create a Certificate named web-cert:
     secretName: web-tls
     dnsNames: web.cka.local
     duration: 2160h
     issuer: ClusterIssuer selfsigned-issuer
   The certificate must become Ready.
`,
  solution: `
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v<<cert_manager_version>>/cert-manager.yaml
kubectl -n cert-manager rollout status deploy/cert-manager-webhook
kubectl get crd | grep cert-manager
kubectl explain certificate.spec | less

cat <<'EOF' | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: web-cert
  namespace: tls-lab
spec:
  secretName: web-tls
  dnsNames:
  - web.cka.local
  duration: 2160h
  issuerRef:
    kind: ClusterIssuer
    name: selfsigned-issuer
EOF
kubectl get certificate -n tls-lab
`,
  test: `
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v<<cert_manager_version>>/cert-manager.yaml
kubectl -n cert-manager rollout status deploy/cert-manager-webhook
kubectl explain certificate.spec | head -5
cat <<'EOF' | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: web-cert
  namespace: tls-lab
spec:
  secretName: web-tls
  dnsNames:
  - web.cka.local
  duration: 2160h
  issuerRef:
    kind: ClusterIssuer
    name: selfsigned-issuer
EOF
sleep 20
kubectl get certificate -n tls-lab
`,
});

// =============================================================================== przygotowanie węzła
const SYSCTLS = ['net.ipv4.ip_forward', 'net.bridge.bridge-nf-call-iptables', 'net.bridge.bridge-nf-call-ip6tables'];

task({
  id: 'node-prereqs', domain: 'cluster', title: 'Przygotowanie węzła: moduły jądra i sysctl', host: 'w1', minutes: 4,
  setup(c) { c.sh(c.cfg.w1, 'rm -f /etc/modules-load.d/k8s.conf /etc/sysctl.d/k8s.conf'); },
  check(c, g) {
    const w1 = c.cfg.w1;
    const mods = c.read(w1, '/etc/modules-load.d/k8s.conf') || '';
    const lines = new Set(mods.split('\n').map((l) => l.trim()));
    g.ok('/etc/modules-load.d/k8s.conf ładuje overlay i br_netfilter', lines.has('overlay') && lines.has('br_netfilter'), mods);
    const sc = c.read(w1, '/etc/sysctl.d/k8s.conf') || '';
    const vals = {};
    for (const ln of sc.split('\n')) if (ln.includes('=') && !ln.trim().startsWith('#')) { const i = ln.indexOf('='); vals[ln.slice(0, i).trim()] = ln.slice(i + 1).trim(); }
    for (const s of SYSCTLS) g.ok(`/etc/sysctl.d/k8s.conf: ${s} = 1`, vals[s] === '1');
    const r = c.ssh(w1, `sysctl -n ${SYSCTLS.join(' ')}`);
    g.ok('parametry aktywne w działającym systemie', r.ok && r.out.split(/\s+/).filter(Boolean).join(',') === '1,1,1', r.text);
    g.ok('moduł br_netfilter załadowany', c.ssh(w1, 'lsmod | grep -qw br_netfilter').ok);
  },
  cleanup(c) {
    c.sh(c.cfg.w1, `
printf 'overlay\\nbr_netfilter\\n' > /etc/modules-load.d/k8s.conf
printf 'net.bridge.bridge-nf-call-iptables  = 1\\nnet.bridge.bridge-nf-call-ip6tables = 1\\nnet.ipv4.ip_forward                 = 1\\n' > /etc/sysctl.d/k8s.conf
sysctl --system >/dev/null
`);
  },
  text: `
On <<w1>> the persistent kernel configuration required by Kubernetes was lost.

1. Make sure the kernel modules overlay and br_netfilter are loaded on boot,
   configured in /etc/modules-load.d/k8s.conf.
2. Make sure these kernel parameters are set to 1 and persisted in
   /etc/sysctl.d/k8s.conf:
     net.ipv4.ip_forward
     net.bridge.bridge-nf-call-iptables
     net.bridge.bridge-nf-call-ip6tables
3. Apply everything without rebooting the node.
`,
  solution: `
ssh <<w1>>
cat <<EOF | sudo tee /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF
sudo modprobe overlay && sudo modprobe br_netfilter

cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.ipv4.ip_forward = 1
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
EOF
sudo sysctl --system
sysctl net.ipv4.ip_forward net.bridge.bridge-nf-call-iptables
# (gotowiec: dokumentacja kubernetes.io -> "Container Runtimes" -> "Install and configure prerequisites")
`,
});

// =============================================================================== static pod
task({
  id: 'static-pod', domain: 'cluster', title: 'Statyczny pod na workerze', host: 'w1', minutes: 5,
  conflicts: ['node-w1'],
  setup(c) { c.sh(c.cfg.w1, 'rm -f /etc/kubernetes/manifests/static-web.yaml /etc/kubernetes/manifests/static-web.yml'); },
  check(c, g) {
    const w1 = c.cfg.w1;
    const name = `static-web-${w1}`;
    const p = c.get('pod', name, 'default');
    g.ok(`pod ${name} istnieje w ns default`, p);
    g.ok('to jest statyczny pod (mirror pod zarządzany przez kubelet)', p && 'kubernetes.io/config.mirror' in (jp(p, 'metadata.annotations', {}) || {}));
    g.ok(`działa na ${w1}`, jp(p, 'spec.nodeName') === w1);
    g.ok(`obraz ${NGINX}`, jp(p, 'spec.containers.0.image') === NGINX);
    g.ok('label app=static-web', jp(p, 'metadata.labels.app') === 'static-web');
    g.ok('requests cpu 50m, memory 32Mi', qeq(jp(p, 'spec.containers.0.resources.requests.cpu'), '50m') && qeq(jp(p, 'spec.containers.0.resources.requests.memory'), '32Mi'));
    g.ok('pod jest Running i Ready', p && podReady(p));
  },
  cleanup(c) { c.ssh(c.cfg.w1, 'rm -f /etc/kubernetes/manifests/static-web.yaml /etc/kubernetes/manifests/static-web.yml', true); },
  text: `
On <<w1>> create a static Pod named static-web (namespace default) that is
managed directly by the kubelet of <<w1>>:
  - image nginx:1.28-alpine, container port 80
  - label app=static-web
  - resource requests: cpu 50m, memory 32Mi
`,
  solution: `
ssh <<w1>>
grep staticPodPath /var/lib/kubelet/config.yaml        # zwykle /etc/kubernetes/manifests
kubectl run static-web --image=nginx:1.28-alpine --port=80 --labels=app=static-web \\
  --dry-run=client -o yaml > static-web.yaml
vim static-web.yaml      # dodaj resources.requests: cpu: 50m, memory: 32Mi
sudo cp static-web.yaml /etc/kubernetes/manifests/
exit
kubectl get pod static-web-<<w1>> -o wide
`,
  test: `
grep staticPodPath /var/lib/kubelet/config.yaml
kubectl run static-web --image=nginx:1.28-alpine --port=80 --labels=app=static-web --dry-run=client -o yaml > static-web.yaml
sed -i 's/    resources: {}/    resources:\\n      requests:\\n        cpu: 50m\\n        memory: 32Mi/' static-web.yaml
cat static-web.yaml
sudo cp static-web.yaml /etc/kubernetes/manifests/
sleep 20
kubectl get pod static-web-<<w1>> -o wide
`,
});

// =============================================================================== odnowienie certyfikatu
const fp = (c, path) => c.ssh(c.cfg.cp, `openssl x509 -in ${path} -noout -fingerprint -sha256`, true).out.trim();

task({
  id: 'cert-renew', domain: 'cluster', title: 'kubeadm: wygaśnięcie i odnowienie certyfikatu', host: 'cp', minutes: 7,
  conflicts: ['controlplane'],
  setup(c) {
    c.workdir(c.cfg.cp, '/opt/cka/certs');
    c.state.apiserver_fp = fp(c, '/etc/kubernetes/pki/apiserver.crt');
    c.state.kubelet_client_fp = fp(c, '/etc/kubernetes/pki/apiserver-kubelet-client.crt');
    c.state.admin_sha = c.ssh(c.cfg.cp, "sha256sum /etc/kubernetes/admin.conf | cut -d' ' -f1", true).out.trim();
  },
  check(c, g) {
    const cp = c.cfg.cp;
    const txt = c.read(cp, '/opt/cka/certs/expiration.txt') || '';
    g.ok("expiration.txt zawiera wynik 'kubeadm certs check-expiration'", /apiserver/.test(txt) && /EXPIRES/i.test(txt));
    const nw = fp(c, '/etc/kubernetes/pki/apiserver.crt');
    g.ok('certyfikat apiserver.crt został odnowiony', nw && nw !== c.state.apiserver_fp);
    g.ok('inne certyfikaty NIE zostały odnowione (apiserver-kubelet-client)', fp(c, '/etc/kubernetes/pki/apiserver-kubelet-client.crt') === c.state.kubelet_client_fp);
    const admin = c.ssh(cp, "sha256sum /etc/kubernetes/admin.conf | cut -d' ' -f1", true).out.trim();
    g.ok("admin.conf bez zmian (nie użyto 'renew all')", admin === c.state.admin_sha);
    const r = c.ssh(cp, 'echo | openssl s_client -connect 127.0.0.1:6443 2>/dev/null | openssl x509 -noout -fingerprint -sha256');
    g.ok('działający kube-apiserver serwuje NOWY certyfikat (został zrestartowany)', nw && r.out.trim() === nw, r.text);
    g.ok('API działa', c.api_ok());
  },
  text: `
On <<cp>>:

1. Using kubeadm, check the expiration of all certificates managed by kubeadm
   and save the complete output to /opt/cka/certs/expiration.txt.
2. Renew ONLY the certificate the kube-apiserver uses to serve HTTPS
   (no other certificates or kubeconfig files may be renewed).
3. Make sure the running kube-apiserver uses the renewed certificate.
`,
  solution: `
sudo kubeadm certs check-expiration | sudo tee /opt/cka/certs/expiration.txt
sudo kubeadm certs renew apiserver

# restart statycznego poda apiservera (kubelet podniesie go z nowym certyfikatem):
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/ ; sleep 20
sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/
# lub:  sudo crictl stop $(sudo crictl ps --name kube-apiserver -q)

echo | openssl s_client -connect 127.0.0.1:6443 2>/dev/null | openssl x509 -noout -dates
`,
  test: `
sudo kubeadm certs check-expiration | sudo tee /opt/cka/certs/expiration.txt
sudo kubeadm certs renew apiserver
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/ ; sleep 20
sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/
sleep 40
echo | openssl s_client -connect 127.0.0.1:6443 2>/dev/null | openssl x509 -noout -dates
`,
});

// =============================================================================== CRI / CNI
const normSock = (s) => String(s || '').trim().replace(/^"|"$/g, '').replace('unix://', '').replace('/var/run/', '/run/');

task({
  id: 'cri-cni-inspect', domain: 'cluster', title: 'Interfejsy CRI/CNI: inspekcja węzła', host: 'w1', minutes: 6,
  setup(c) { c.workdir(c.cfg.w1, '/opt/cka/cri'); },
  check(c, g) {
    const w1 = c.cfg.w1;
    const got = c.read(w1, '/opt/cka/cri/runtime-endpoint.txt') || '';
    const conf = c.ssh(w1, 'cat /var/lib/kubelet/config.yaml /var/lib/kubelet/kubeadm-flags.env 2>/dev/null', true).out;
    const m = conf.match(/(?:containerRuntimeEndpoint:\s*|--container-runtime-endpoint=)(\S+)/);
    const expected = m ? m[1] : 'unix:///run/containerd/containerd.sock';
    g.ok('runtime-endpoint.txt = endpoint CRI kubeleta', got.trim().startsWith('unix://') && normSock(got) === normSock(expected), `oczekiwano ${expected}, jest '${got.trim()}'`);
    const want = (c.read(w1, '/opt/cka/cri/kube-proxy-id.txt') || '').trim();
    const r = c.ssh(w1, 'crictl ps --name kube-proxy -o json', true);
    const ids = ((safeJson(r.out) || {}).containers || []).map((x) => x.id || '');
    g.ok('kube-proxy-id.txt = ID działającego kontenera kube-proxy', want.length >= 12 && ids.some((i) => i.startsWith(want)), `jest '${want}'`);
    const cni = c.ssh(w1, "ls /etc/cni/net.d | grep -E '\\.(conflist|conf|json)$' | sort | head -1", true).out.trim();
    const gotCni = (c.read(w1, '/opt/cka/cri/cni-config.txt') || '').trim();
    g.ok('cni-config.txt = nazwa pliku konfiguracji CNI', cni && gotCni === cni, `oczekiwano '${cni}', jest '${gotCni}'`);
    const rv = jp(c.get('node', w1), 'status.nodeInfo.containerRuntimeVersion', '');
    const gotRv = (c.read(w1, '/opt/cka/cri/runtime-version.txt') || '').trim();
    g.ok('runtime-version.txt = containerRuntimeVersion węzła', rv && gotRv.includes(rv), `oczekiwano '${rv}'`);
  },
  text: `
On <<w1>> collect information about the node's extension interfaces.
Write each answer to a separate file in /opt/cka/cri/:

1. runtime-endpoint.txt - the container runtime (CRI) endpoint used by the kubelet,
   in the form unix:///...
2. kube-proxy-id.txt   - the container ID of the running kube-proxy container on this
   node, found with crictl
3. cni-config.txt      - the file name (without path) of the CNI configuration used
   by the container runtime on this node
4. runtime-version.txt - the container runtime name and version as reported by the
   node object (e.g. containerd://x.y.z)
`,
  solution: `
ssh <<w1>>
sudo grep -i containerRuntimeEndpoint /var/lib/kubelet/config.yaml
cat /var/lib/kubelet/kubeadm-flags.env                  # starsze wersje: flaga --container-runtime-endpoint
echo unix:///var/run/containerd/containerd.sock > /opt/cka/cri/runtime-endpoint.txt

sudo crictl ps --name kube-proxy -q > /opt/cka/cri/kube-proxy-id.txt

ls /etc/cni/net.d/                                      # runtime bierze pierwszy plik alfabetycznie
echo 10-calico.conflist > /opt/cka/cri/cni-config.txt

kubectl get node <<w1>> -o jsonpath='{.status.nodeInfo.containerRuntimeVersion}' > /opt/cka/cri/runtime-version.txt
`,
});
