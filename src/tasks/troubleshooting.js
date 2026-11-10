// Domena: Troubleshooting (30%). Wiele zadań losuje wariant awarii przy każdym starcie.
import { task, BUSYBOX, NGINX, configmap, container, deployment, echoApp, pod } from './registry.js';
import { jp, cont, envVar, podReady, readyReplicas, qty, qeq, deq } from './ctx.js';

const BK = '/var/lib/.cka-backup';
const WGET = 'wget -qO- -T 3 ';

function variant(c, options) {
  const v = c.state.force_variant || c.choice(options);
  c.state.variant = v;
  return v;
}
function componentDown(c, comp) {
  const pods = c.pods('kube-system', `component=${comp}`);
  return !pods.length || !pods.some(podReady);
}
function backupManifest(c, comp) { c.sh(c.cfg.cp, `mkdir -p ${BK} && cp -f /etc/kubernetes/manifests/${comp}.yaml ${BK}/${comp}.yaml`); }
function restoreManifest(c, comp) { c.ssh(c.cfg.cp, `test -f ${BK}/${comp}.yaml && cp -f ${BK}/${comp}.yaml /etc/kubernetes/manifests/${comp}.yaml`, true); }

// =============================================================================== kubelet
task({
  id: 'ts-kubelet', domain: 'troubleshooting', title: 'Węzeł NotReady: kubelet', host: 'w1', minutes: 8,
  conflicts: ['node-w1'], disruptive: true, variants: ['stopped', 'dropin', 'config', 'flag'],
  setup(c) {
    const w1 = c.cfg.w1;
    const v = variant(c, ['stopped', 'dropin', 'config', 'flag']);
    c.sh(w1, `mkdir -p ${BK} && cp -a /var/lib/kubelet/config.yaml ${BK}/kubelet-config.yaml && cp -a /var/lib/kubelet/kubeadm-flags.env ${BK}/kubeadm-flags.env`);
    const scripts = {
      stopped: 'systemctl disable --now kubelet',
      dropin: `
mkdir -p /etc/systemd/system/kubelet.service.d
cat > /etc/systemd/system/kubelet.service.d/20-local-override.conf <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/local/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS
EOF
systemctl daemon-reload
systemctl restart kubelet || true
`,
      config: `
sed -i 's#clientCAFile: /etc/kubernetes/pki/ca.crt#clientCAFile: /etc/kubernetes/pki/ca-bundle.crt#' /var/lib/kubelet/config.yaml
grep -q ca-bundle.crt /var/lib/kubelet/config.yaml
systemctl restart kubelet || true
`,
      flag: `
sed -i 's#^KUBELET_KUBEADM_ARGS="#KUBELET_KUBEADM_ARGS="--container-runtime-endpoint=unix:///run/containerd/containerd-v2.sock #' /var/lib/kubelet/kubeadm-flags.env
grep -q containerd-v2.sock /var/lib/kubelet/kubeadm-flags.env
systemctl restart kubelet || true
`,
    };
    c.sh(w1, scripts[v]);
    c.wait_until(() => !c.node_is_ready(w1), 150, 5);
  },
  check(c, g) {
    const w1 = c.cfg.w1;
    g.ok(`${w1} jest Ready`, c.wait_until(() => c.node_is_ready(w1), 40, 5));
    g.ok('kubelet działa (active)', c.ssh(w1, 'systemctl is-active kubelet').out.trim() === 'active');
    g.ok('kubelet uruchomi się po restarcie (enabled)', c.ssh(w1, 'systemctl is-enabled kubelet').out.trim() === 'enabled');
    let r = c.ssh(w1, 'systemctl show kubelet -p ExecStart --value');
    g.ok('kubelet uruchamiany z /usr/bin/kubelet', r.out.includes('/usr/bin/kubelet'), r.out.slice(0, 200));
    r = c.ssh(w1, "grep -c 'ca-bundle.crt' /var/lib/kubelet/config.yaml; grep -c 'containerd-v2.sock' /var/lib/kubelet/kubeadm-flags.env", true);
    g.ok('konfiguracja kubeleta bez błędnych wpisów', r.out.split(/\s+/).filter(Boolean).join(',') === '0,0', r.text);
  },
  cleanup(c) {
    c.ssh(c.cfg.w1, `
rm -f /etc/systemd/system/kubelet.service.d/20-local-override.conf
[ -f ${BK}/kubelet-config.yaml ] && cp -f ${BK}/kubelet-config.yaml /var/lib/kubelet/config.yaml
[ -f ${BK}/kubeadm-flags.env ] && cp -f ${BK}/kubeadm-flags.env /var/lib/kubelet/kubeadm-flags.env
systemctl daemon-reload; systemctl enable --now kubelet; systemctl restart kubelet
`, true);
  },
  text: `
Node <<w1>> is in state NotReady.

Find the cause and fix it so that the node becomes Ready. The fix must be
permanent - the node must also work after a reboot.
Do not remove the node from the cluster.
`,
  solution: `
kubectl get nodes ; kubectl describe node <<w1>> | grep -A5 Conditions
ssh <<w1>>
sudo systemctl status kubelet
sudo journalctl -u kubelet -n 50 --no-pager

# Wylosowany wariant awarii: <<variant>>
#  stopped -> sudo systemctl enable --now kubelet
#  dropin  -> 'systemctl cat kubelet' pokazuje drop-in z błędną ścieżką binarki:
#             sudo rm /etc/systemd/system/kubelet.service.d/20-local-override.conf
#             sudo systemctl daemon-reload && sudo systemctl restart kubelet
#  config  -> błędny clientCAFile w /var/lib/kubelet/config.yaml (ca-bundle.crt -> ca.crt)
#             sudo systemctl restart kubelet
#  flag    -> zła flaga --container-runtime-endpoint w /var/lib/kubelet/kubeadm-flags.env - usuń ją
#             sudo systemctl restart kubelet
`,
  tests: {
    stopped: 'sudo systemctl status kubelet\nsudo systemctl enable --now kubelet\nsleep 30',
    dropin: 'sudo systemctl cat kubelet\nsudo rm /etc/systemd/system/kubelet.service.d/20-local-override.conf\nsudo systemctl daemon-reload && sudo systemctl restart kubelet\nsleep 30',
    config: 'sudo journalctl -u kubelet -n 5 --no-pager\nsudo sed -i \'s#ca-bundle.crt#ca.crt#\' /var/lib/kubelet/config.yaml\nsudo systemctl restart kubelet\nsleep 30',
    flag: 'cat /var/lib/kubelet/kubeadm-flags.env\nsudo sed -i \'s#--container-runtime-endpoint=unix:///run/containerd/containerd-v2.sock ##\' /var/lib/kubelet/kubeadm-flags.env\nsudo systemctl restart kubelet\nsleep 30',
  },
});

// =============================================================================== containerd
task({
  id: 'ts-containerd', domain: 'troubleshooting', title: 'Węzeł NotReady: container runtime', host: 'w2', minutes: 8,
  conflicts: ['node-w2'], disruptive: true, variants: ['stopped', 'config', 'socket'],
  setup(c) {
    const w2 = c.cfg.w2;
    const v = variant(c, ['stopped', 'config', 'socket']);
    c.sh(w2, `mkdir -p ${BK} && cp -a /etc/containerd/config.toml ${BK}/containerd-config.toml`);
    const scripts = {
      stopped: 'systemctl disable --now containerd',
      config: `echo '[plugins."io.containerd.cri.v1.runtime"' >> /etc/containerd/config.toml\nsystemctl restart containerd || true`,
      socket: `sed -i "s#/run/containerd/containerd.sock#/run/containerd/containerd-main.sock#" /etc/containerd/config.toml\ngrep -q containerd-main.sock /etc/containerd/config.toml\nsystemctl restart containerd; systemctl restart kubelet`,
    };
    c.sh(w2, scripts[v]);
    c.wait_until(() => !c.node_is_ready(w2), 150, 5);
  },
  check(c, g) {
    const w2 = c.cfg.w2;
    g.ok(`${w2} jest Ready`, c.wait_until(() => c.node_is_ready(w2), 40, 5));
    g.ok('containerd działa i jest enabled', c.ssh(w2, 'systemctl is-active containerd && systemctl is-enabled containerd').ok);
    g.ok('konfiguracja containerd jest poprawna', c.ssh(w2, 'containerd config dump >/dev/null', true).ok);
    g.ok('CRI odpowiada na unix:///run/containerd/containerd.sock', c.ssh(w2, 'crictl --runtime-endpoint unix:///run/containerd/containerd.sock info >/dev/null', true).ok);
    const cal = c.pods('kube-system', 'k8s-app=calico-node').filter((p) => jp(p, 'spec.nodeName') === w2);
    g.ok(`pody systemowe na ${w2} działają (calico-node Ready)`, cal.length && cal.every(podReady));
  },
  cleanup(c) {
    c.ssh(c.cfg.w2, `
[ -f ${BK}/containerd-config.toml ] && cp -f ${BK}/containerd-config.toml /etc/containerd/config.toml
systemctl enable --now containerd; systemctl restart containerd; systemctl restart kubelet
`, true);
  },
  text: `
Node <<w2>> is NotReady and pods are not running on it.

Investigate the container runtime on <<w2>> and fix the problem.
The fix must survive a reboot. The runtime must listen on its default socket
unix:///run/containerd/containerd.sock.
`,
  solution: `
ssh <<w2>>
sudo systemctl status containerd kubelet
sudo journalctl -u containerd -n 30 --no-pager
sudo journalctl -u kubelet -n 30 --no-pager | grep -i runtime

# Wylosowany wariant: <<variant>>
#  stopped -> sudo systemctl enable --now containerd
#  config  -> błędny TOML na końcu /etc/containerd/config.toml - usuń ostatnią linię
#             (sudo containerd config dump pokaże błąd), potem restart containerd
#  socket  -> w sekcji [grpc] zmieniono address na containerd-main.sock - przywróć
#             /run/containerd/containerd.sock, restart containerd i kubelet
`,
  tests: {
    stopped: 'sudo systemctl enable --now containerd\nsleep 40',
    config: "sudo containerd config dump >/dev/null\nsudo sed -i '$d' /etc/containerd/config.toml\nsudo systemctl restart containerd\nsleep 40",
    socket: 'sudo sed -i "s#containerd-main.sock#containerd.sock#" /etc/containerd/config.toml\nsudo systemctl restart containerd\nsudo systemctl restart kubelet\nsleep 40',
  },
});

// =============================================================================== kube-scheduler
const SCHED_F = '/etc/kubernetes/manifests/kube-scheduler.yaml';
task({
  id: 'ts-scheduler', domain: 'troubleshooting', title: 'Pody wiszą w Pending: komponent control plane', host: 'cp', minutes: 7,
  conflicts: ['controlplane'], disruptive: true, namespaces: ['ts-sched'], variants: ['kubeconfig', 'image', 'command'],
  setup(c) {
    const v = variant(c, ['kubeconfig', 'image', 'command']);
    backupManifest(c, 'kube-scheduler');
    const f = SCHED_F;
    const scripts = {
      kubeconfig: `sed -i 's#--kubeconfig=/etc/kubernetes/scheduler.conf#--kubeconfig=/etc/kubernetes/scheduler-cka.conf#' ${f}`,
      image: `sed -i -E 's#(image: .*kube-scheduler):v[0-9.]+#\\1:v1.0.0-cka#' ${f}`,
      command: `sed -i -E 's#^(\\s+)- kube-scheduler$#\\1- kube-schedular#' ${f}`,
    };
    c.sh(c.cfg.cp, `${scripts[v]}\n! cmp -s ${f} ${BK}/kube-scheduler.yaml`);
    c.wait_until(() => componentDown(c, 'kube-scheduler'), 150, 5);
    c.apply(deployment('orders', 'ts-sched', NGINX, { replicas: 3 }));
  },
  check(c, g) {
    const pods = c.pods('kube-system', 'component=kube-scheduler');
    g.ok('kube-scheduler działa (Running, Ready)', pods.length && pods.every(podReady));
    const d = c.get('deployment', 'orders', 'ts-sched');
    g.ok('deployment orders: 3 gotowe repliki', readyReplicas(d) === 3);
    g.ok('deployment orders nie był modyfikowany', jp(d, 'metadata.generation') === 1 && !jp(d, 'spec.template.spec.nodeName'));
  },
  cleanup(c) { restoreManifest(c, 'kube-scheduler'); },
  text: `
Newly created pods in namespace ts-sched stay in state Pending forever.

Find the failing cluster component and fix it. Do not modify deployment orders
and do not assign pods to nodes manually.
`,
  solution: `
kubectl -n ts-sched describe pod | grep -A3 Events       # brak zdarzeń 'Scheduled'
kubectl -n kube-system get pods | grep scheduler
sudo crictl ps -a | grep scheduler ; sudo crictl logs <ID>
sudo vim /etc/kubernetes/manifests/kube-scheduler.yaml
# Wariant: <<variant>>
#  kubeconfig -> --kubeconfig=/etc/kubernetes/scheduler.conf (był scheduler-cka.conf)
#  image      -> tag obrazu musi być zgodny z wersją klastra (np. jak w kube-apiserver.yaml)
#  command    -> pierwszy element command: kube-scheduler (literówka)
# kubelet sam podniesie poprawiony statyczny pod (~20-40 s).
`,
  tests: {
    kubeconfig: `sudo sed -i 's#scheduler-cka.conf#scheduler.conf#' ${SCHED_F}\nsleep 60\nkubectl -n ts-sched get pods`,
    image: `sudo sed -i 's#kube-scheduler:v1.0.0-cka#kube-scheduler:v1.37.1#' ${SCHED_F}\nsleep 60\nkubectl -n ts-sched get pods`,
    command: `sudo sed -i 's#- kube-schedular#- kube-scheduler#' ${SCHED_F}\nsleep 60\nkubectl -n ts-sched get pods`,
  },
});

// =============================================================================== kube-controller-manager
const KCM_F = '/etc/kubernetes/manifests/kube-controller-manager.yaml';
task({
  id: 'ts-controller-manager', domain: 'troubleshooting', title: 'Deployment nie tworzy podów', host: 'cp', minutes: 7,
  conflicts: ['controlplane'], disruptive: true, namespaces: ['ts-kcm'], variants: ['kubeconfig', 'image', 'command'],
  setup(c) {
    const v = variant(c, ['kubeconfig', 'image', 'command']);
    backupManifest(c, 'kube-controller-manager');
    const f = KCM_F;
    const scripts = {
      kubeconfig: `sed -i 's#--kubeconfig=/etc/kubernetes/controller-manager.conf#--kubeconfig=/etc/kubernetes/controller-mgr.conf#' ${f}`,
      image: `sed -i -E 's#(image: .*kube-controller-manager):v[0-9.]+#\\1:v1.0.0-cka#' ${f}`,
      command: `sed -i -E 's#^(\\s+)- kube-controller-manager$#\\1- kube-controller-manger#' ${f}`,
    };
    c.sh(c.cfg.cp, `${scripts[v]}\n! cmp -s ${f} ${BK}/kube-controller-manager.yaml`);
    c.wait_until(() => componentDown(c, 'kube-controller-manager'), 150, 5);
    c.apply(deployment('payments', 'ts-kcm', NGINX, { replicas: 2 }));
  },
  check(c, g) {
    const pods = c.pods('kube-system', 'component=kube-controller-manager');
    g.ok('kube-controller-manager działa (Running, Ready)', pods.length && pods.every(podReady));
    const d = c.get('deployment', 'payments', 'ts-kcm');
    g.ok('deployment payments: 2 gotowe repliki', readyReplicas(d) === 2);
    g.ok('deployment payments nie był modyfikowany', jp(d, 'metadata.generation') === 1);
  },
  cleanup(c) { restoreManifest(c, 'kube-controller-manager'); },
  text: `
Deployment payments in namespace ts-kcm was created but no ReplicaSet and no pods
appear for it.

Find the failing cluster component and fix it. Do not modify the deployment.
`,
  solution: `
kubectl -n ts-kcm get deploy,rs,pods          # brak ReplicaSet => problem z controller-managerem
kubectl -n kube-system get pods | grep controller-manager
sudo crictl ps -a | grep controller ; sudo crictl logs <ID>
sudo vim /etc/kubernetes/manifests/kube-controller-manager.yaml
# Wariant: <<variant>>
#  kubeconfig -> --kubeconfig=/etc/kubernetes/controller-manager.conf
#  image      -> poprawny tag obrazu (taki jak wersja klastra)
#  command    -> pierwszy element command: kube-controller-manager
`,
  tests: {
    kubeconfig: `sudo sed -i 's#controller-mgr.conf#controller-manager.conf#' ${KCM_F}\nsleep 60\nkubectl -n ts-kcm get pods`,
    image: `sudo sed -i 's#kube-controller-manager:v1.0.0-cka#kube-controller-manager:v1.37.1#' ${KCM_F}\nsleep 60\nkubectl -n ts-kcm get pods`,
    command: `sudo sed -i 's#- kube-controller-manger#- kube-controller-manager#' ${KCM_F}\nsleep 60\nkubectl -n ts-kcm get pods`,
  },
});

// =============================================================================== kube-apiserver
const API_F = '/etc/kubernetes/manifests/kube-apiserver.yaml';
task({
  id: 'ts-apiserver', domain: 'troubleshooting', title: 'kubectl nie łączy się z API serverem', host: 'cp', minutes: 10,
  exam: false, conflicts: ['controlplane'], disruptive: true, variants: ['etcd-port', 'cafile', 'flag'],
  setup(c) {
    const v = variant(c, ['etcd-port', 'cafile', 'flag']);
    backupManifest(c, 'kube-apiserver');
    const f = API_F;
    const scripts = {
      'etcd-port': `sed -i 's#--etcd-servers=https://127.0.0.1:2379#--etcd-servers=https://127.0.0.1:2380#' ${f}`,
      cafile: `sed -i 's#--client-ca-file=/etc/kubernetes/pki/ca.crt#--client-ca-file=/etc/kubernetes/pki/client-ca.crt#' ${f}`,
      flag: `sed -i 's#--authorization-mode=#--authorisation-mode=#' ${f}`,
    };
    c.sh(c.cfg.cp, `${scripts[v]}\n! cmp -s ${f} ${BK}/kube-apiserver.yaml`);
    c.wait_until(() => !c.api_ok(), 150, 5);
  },
  check(c, g) {
    const up = c.wait_until(() => c.api_ok(), 60, 5);
    g.ok('API server odpowiada (/readyz)', up);
    const man = c.read(c.cfg.cp, API_F) || '';
    g.ok('--etcd-servers wskazuje na port klienta 2379', man.includes('--etcd-servers=https://127.0.0.1:2379'));
    g.ok('--client-ca-file=/etc/kubernetes/pki/ca.crt', man.includes('--client-ca-file=/etc/kubernetes/pki/ca.crt'));
    g.ok('poprawna flaga --authorization-mode', man.includes('--authorization-mode='));
    const pods = up ? c.pods('kube-system', 'component=kube-apiserver') : [];
    g.ok('pod kube-apiserver Running', pods.length && pods.every(podReady));
  },
  cleanup(c) { restoreManifest(c, 'kube-apiserver'); },
  text: `
After a configuration change kubectl can no longer talk to the cluster:
"The connection to the server <<cp_ip>>:6443 was refused".

Fix the kube-apiserver on <<cp>>.
`,
  solution: `
sudo crictl ps -a | grep -E 'apiserver|etcd'
sudo crictl logs $(sudo crictl ps -a --name kube-apiserver -q | head -1)
sudo journalctl -u kubelet --since "5 min ago" | grep -i apiserver
sudo vim /etc/kubernetes/manifests/kube-apiserver.yaml
# Wariant: <<variant>>
#  etcd-port -> --etcd-servers=https://127.0.0.1:2379 (2380 to port peer)
#  cafile    -> --client-ca-file=/etc/kubernetes/pki/ca.crt
#  flag      -> literówka: --authorization-mode (nie authorisation)
#
# To zadanie nie trafia do egzaminu próbnego (przy zepsutym API nie da się ocenić reszty).
`,
  tests: {
    'etcd-port': `sudo crictl logs $(sudo crictl ps -a --name kube-apiserver -q | head -1) | tail -3\nsudo sed -i 's#127.0.0.1:2380#127.0.0.1:2379#' ${API_F}\nsleep 90\nkubectl get nodes`,
    cafile: `sudo sed -i 's#pki/client-ca.crt#pki/ca.crt#' ${API_F}\nsleep 90\nkubectl get nodes`,
    flag: `sudo sed -i 's#--authorisation-mode=#--authorization-mode=#' ${API_F}\nsleep 90\nkubectl get nodes`,
  },
});

// =============================================================================== CrashLoopBackOff / OOM
task({
  id: 'ts-crashloop', domain: 'troubleshooting', title: 'CrashLoopBackOff i OOMKilled', host: 'cp', minutes: 8,
  namespaces: ['ts-app'],
  setup(c) {
    const ns = 'ts-app';
    c.apply(configmap('orders-config', ns, { ORDERS_DB_HOST: 'postgres.ts-app.svc', ORDERS_DB_PORT: '5432' }));
    const api = deployment('orders-api', ns, BUSYBOX, { containers: [container('api', BUSYBOX, { command: '[ -n "$DB_HOST" ] || { echo "FATAL: environment variable DB_HOST is not set"; exit 1; }; echo "connected to $DB_HOST"; sleep 3600', env: [{ name: 'DB_HOST', valueFrom: { configMapKeyRef: { name: 'orders-config', key: 'DB_HOST', optional: true } } }] })] });
    const worker = deployment('orders-worker', ns, NGINX, { containers: [container('worker', NGINX, { resources: { requests: { memory: '4Mi' }, limits: { memory: '4Mi' } } })] });
    c.apply([api, worker]);
  },
  check(c, g) {
    const ns = 'ts-app';
    const cm = c.get('configmap', 'orders-config', ns);
    g.ok('ConfigMap orders-config bez zmian', deq((cm || {}).data, { ORDERS_DB_HOST: 'postgres.ts-app.svc', ORDERS_DB_PORT: '5432' }));
    const d = c.get('deployment', 'orders-api', ns);
    const e = envVar(cont(d), 'DB_HOST');
    g.ok('orders-api: DB_HOST pobierany z ConfigMap (klucz ORDERS_DB_HOST)', jp(e, 'valueFrom.configMapKeyRef.key') === 'ORDERS_DB_HOST' || (cont(d).envFrom || []).some((x) => jp(x, 'configMapRef.name') === 'orders-config'));
    g.ok('orders-api: gotowa replika', readyReplicas(d) >= 1);
    g.ok('orders-api: obraz bez zmian', cont(d).image === BUSYBOX);
    const r = c.logs('deployment/orders-api', ns);
    g.ok("logi orders-api: 'connected to postgres.ts-app.svc'", r.out.includes('connected to postgres.ts-app.svc'), r.text.slice(0, 200));
    const w = c.get('deployment', 'orders-worker', ns);
    const lim = qty(jp(cont(w), 'resources.limits.memory'));
    g.ok('orders-worker: limit pamięci >= 64Mi', lim !== null && lim >= 64 * 2 ** 20, jp(cont(w), 'resources'));
    g.ok('orders-worker: obraz bez zmian i gotowa replika', cont(w).image === NGINX && readyReplicas(w) >= 1);
  },
  text: `
Two deployments in namespace ts-app are failing: orders-api and orders-worker.

Make both deployments run with at least one ready replica.
  - Do not modify ConfigMap orders-config and do not change any images.
  - The memory limit of orders-worker must be at least 64Mi.
`,
  solution: `
kubectl -n ts-app get pods
kubectl -n ts-app logs deploy/orders-api                 # FATAL: DB_HOST is not set
kubectl -n ts-app get cm orders-config -o yaml           # klucz to ORDERS_DB_HOST, nie DB_HOST
kubectl -n ts-app edit deploy orders-api                 # configMapKeyRef.key: ORDERS_DB_HOST

kubectl -n ts-app describe pod -l app=orders-worker | grep -i -A3 'last state'   # OOMKilled
kubectl -n ts-app set resources deploy orders-worker --limits=memory=128Mi --requests=memory=64Mi
`,
  test: `
kubectl -n ts-app get pods
kubectl -n ts-app logs deploy/orders-api
kubectl -n ts-app patch deploy orders-api --type=json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/env/0/valueFrom/configMapKeyRef/key","value":"ORDERS_DB_HOST"}]'
kubectl -n ts-app set resources deploy orders-worker --limits=memory=128Mi --requests=memory=64Mi
kubectl -n ts-app rollout status deploy orders-api
kubectl -n ts-app rollout status deploy orders-worker
`,
});

// =============================================================================== Pending pods
task({
  id: 'ts-pending', domain: 'troubleshooting', title: 'Trzy przyczyny podów w stanie Pending', host: 'cp', minutes: 9,
  namespaces: ['ts-pending'],
  setup(c) {
    const ns = 'ts-pending';
    c.kubectl('label', 'node', '--all', 'disktype-');
    c.apply([
      deployment('analytics', ns, NGINX, { extraSpec: { nodeSelector: { disktype: 'ssd' } } }),
      deployment('indexer', ns, NGINX, { containers: [container('indexer', NGINX, { resources: { requests: { cpu: '64' } } })] }),
      { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'cache', namespace: ns }, spec: { storageClassName: 'fast-ssd', accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } },
      deployment('cache', ns, NGINX, { containers: [container('cache', NGINX, { mounts: [{ name: 'd', mountPath: '/data' }] })], volumes: [{ name: 'd', persistentVolumeClaim: { claimName: 'cache' } }] }),
    ]);
  },
  check(c, g) {
    const ns = 'ts-pending', w1 = c.cfg.w1;
    g.ok(`węzeł ${w1} ma label disktype=ssd`, jp(c.get('node', w1), 'metadata.labels.disktype') === 'ssd');
    const a = c.get('deployment', 'analytics', ns);
    g.ok('analytics: nie modyfikowany (generation 1)', jp(a, 'metadata.generation') === 1);
    const pods = c.ready_pods(ns, 'app=analytics');
    g.ok(`analytics: działa na ${w1}`, pods.length && pods.every((p) => jp(p, 'spec.nodeName') === w1));
    const i = c.get('deployment', 'indexer', ns);
    g.ok('indexer: requests.cpu = 100m', qeq(jp(cont(i), 'resources.requests.cpu'), '100m'));
    g.ok('indexer: gotowa replika', readyReplicas(i) >= 1);
    const pvc = c.get('pvc', 'cache', ns);
    g.ok('PVC cache: klasa local-path, 1Gi, Bound', jp(pvc, 'spec.storageClassName') === 'local-path' && qeq(jp(pvc, 'spec.resources.requests.storage'), '1Gi') && jp(pvc, 'status.phase') === 'Bound');
    g.ok('cache: gotowa replika', readyReplicas(c.get('deployment', 'cache', ns)) >= 1);
  },
  cleanup(c) { c.kubectl('label', 'node', '--all', 'disktype-'); },
  text: `
Pods of three deployments in namespace ts-pending are stuck in Pending:
analytics, indexer and cache. Fix them as follows:

  - analytics: do NOT modify the deployment. Make it schedulable by labeling
    node <<w1>> appropriately.
  - indexer:   lower its CPU request to 100m.
  - cache:     its PVC references a StorageClass that does not exist. Recreate
    PVC cache (same name and size) using StorageClass local-path.

All three deployments must have a ready replica.
`,
  solution: `
kubectl -n ts-pending get pods
kubectl -n ts-pending describe pod -l app=analytics | tail   # didn't match node selector
kubectl -n ts-pending get deploy analytics -o jsonpath='{.spec.template.spec.nodeSelector}'
kubectl label node <<w1>> disktype=ssd

kubectl -n ts-pending set resources deploy indexer --requests=cpu=100m   # Insufficient cpu

kubectl -n ts-pending describe pvc cache                    # storageclass "fast-ssd" not found
kubectl -n ts-pending get pvc cache -o yaml > pvc.yaml      # zmień storageClassName: local-path, usuń status/uid itd.
kubectl -n ts-pending delete pvc cache --wait=false         # PVC jest używany - usuń też pod
kubectl -n ts-pending delete pod -l app=cache
kubectl apply -f pvc.yaml
`,
  test: `
kubectl -n ts-pending get pods
kubectl label node <<w1>> disktype=ssd
kubectl -n ts-pending set resources deploy indexer --requests=cpu=100m
cat <<'EOF' > pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: cache
  namespace: ts-pending
spec:
  storageClassName: local-path
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
EOF
kubectl -n ts-pending delete pvc cache --wait=false
kubectl -n ts-pending delete pod -l app=cache
sleep 5
kubectl apply -f pvc.yaml
sleep 30
kubectl -n ts-pending get pods,pvc
`,
});

// =============================================================================== Service bez endpointów
task({
  id: 'ts-service', domain: 'troubleshooting', title: 'Service bez działających backendów', host: 'cp', minutes: 6,
  namespaces: ['ts-svc'],
  setup(c) {
    const ns = 'ts-svc';
    const lab = { app: 'inventory', tier: 'backend' }, canary = { app: 'inventory', tier: 'canary' };
    c.apply([
      deployment('inventory', ns, NGINX, { replicas: 2, labels: lab, ports: [{ containerPort: 80, name: 'http' }] }),
      deployment('inventory-canary', ns, NGINX, { replicas: 1, labels: canary }),
      { apiVersion: 'v1', kind: 'Service', metadata: { name: 'inventory', namespace: ns }, spec: { selector: { app: 'inventry', tier: 'backend' }, ports: [{ port: 80, targetPort: 8080 }] } },
    ]);
  },
  check(c, g) {
    const ns = 'ts-svc';
    const d = c.get('deployment', 'inventory', ns);
    g.ok('deployment inventory nie był modyfikowany', jp(d, 'metadata.generation') === 1);
    const s = c.get('service', 'inventory', ns);
    const sel = jp(s, 'spec.selector', {}) || {};
    g.ok('Service wybiera tylko pody app=inventory, tier=backend', deq(sel, { app: 'inventory', tier: 'backend' }), sel);
    g.ok('Service nadal na porcie 80', ((jp(s, 'spec.ports', []) || [{}])[0] || {}).port === 80);
    const podIps = new Set(c.ready_pods(ns, 'app=inventory,tier=backend').map((p) => jp(p, 'status.podIP')));
    const eps = new Set();
    for (const es of c.list('endpointslices', ns, 'kubernetes.io/service-name=inventory')) for (const ep of es.endpoints || []) if (ep.conditions?.ready !== false) for (const a of ep.addresses || []) eps.add(a);
    g.ok('endpointy = dokładnie 2 pody tier=backend (bez canary)', eps.size === 2 && [...eps].every((x) => podIps.has(x)) && podIps.size === 2, `endpointy: ${[...eps].sort().join(', ')}`);
    const ip = jp(s, 'spec.clusterIP');
    const res = c.probe(ns, { app: 'debug' }, [[`${WGET}http://${ip}/`, true]]);
    g.ok('http://inventory.ts-svc:80 zwraca stronę nginx', res[0][0] && res[0][1].out.includes('nginx'), res[0][1] && res[0][1].text);
  },
  text: `
Requests to http://inventory.ts-svc (port 80) fail.

Fix the Service inventory in namespace ts-svc so that it sends traffic to the
pods of deployment inventory (tier backend) only - not to inventory-canary.
Do not modify any deployment.
`,
  solution: `
kubectl -n ts-svc get svc inventory -o wide
kubectl -n ts-svc get endpointslices -l kubernetes.io/service-name=inventory    # brak adresów
kubectl -n ts-svc get pods --show-labels
kubectl -n ts-svc get deploy inventory -o jsonpath='{.spec.template.spec.containers[0].ports}'
kubectl -n ts-svc edit svc inventory
#  selector: app: inventory (literówka 'inventry'), tier: backend
#  targetPort: 80 (albo nazwa 'http'), nie 8080
kubectl -n ts-svc run t --rm -it --image=busybox:1.36 -- wget -qO- inventory
`,
  test: `
kubectl -n ts-svc get svc inventory -o wide
kubectl -n ts-svc get pods --show-labels
kubectl -n ts-svc patch svc inventory -p '{"spec":{"selector":{"app":"inventory","tier":"backend"},"ports":[{"port":80,"targetPort":80}]}}'
kubectl -n ts-svc run t --rm -i --restart=Never --image=busybox:1.36 -- wget -qO- inventory
`,
});

// =============================================================================== logi kontenerów
task({
  id: 'ts-logs', domain: 'troubleshooting', title: 'Analiza logów kontenerów', host: 'cp', minutes: 5,
  namespaces: ['ts-logs'],
  setup(c) {
    const ns = 'ts-logs';
    const names = ['worker-a', 'worker-b', 'worker-c', 'worker-d'];
    const bad = c.choice(names);
    const decoy = c.choice(names.filter((n) => n !== bad));
    const ta = c.token(4), tb = c.token(4);
    Object.assign(c.state, { bad, tok_main: ta, tok_auth: tb });
    const loop = 'i=0; while true; do echo "INFO processed batch $i"; i=$((i+1)); sleep 4; done';
    const objs = [];
    for (const n of names) {
      let pre = '';
      if (n === bad) pre = 'echo "ERROR code=E4711 payment declined for order 1182"; ';
      else if (n === decoy) pre = 'echo "WARN code=E4710 slow response from payment gateway"; ';
      objs.push(pod(n, ns, BUSYBOX, { labels: { app: 'worker' }, command: pre + loop }));
    }
    objs.push(pod('api-gateway', ns, BUSYBOX, { containers: [
      container('gateway', BUSYBOX, { command: `echo "gateway started token=${ta}"; while true; do echo "GET /health 200"; sleep 5; done` }),
      container('auth-proxy', BUSYBOX, { command: `echo "auth-proxy started token=${tb}"; while true; do echo "token validated"; sleep 5; done` }),
    ] }));
    c.apply(objs);
    c.workdir(c.cfg.cp, '/opt/cka/logs');
    c.wait('--for=condition=Ready', 'pod', '--all', '-n', ns, { timeout: 180 });
  },
  check(c, g) {
    const cp = c.cfg.cp;
    const got = (c.read(cp, '/opt/cka/logs/error-pod.txt') || '').trim();
    g.ok('error-pod.txt zawiera nazwę poda z błędem E4711', got === c.state.bad, `jest '${got}'`);
    const log = c.read(cp, '/opt/cka/logs/auth-proxy.log') || '';
    g.ok('auth-proxy.log zawiera logi kontenera auth-proxy', log.includes(c.state.tok_auth || '?'));
    g.ok('auth-proxy.log NIE zawiera logów kontenera gateway', log && !log.includes(c.state.tok_main || '?'));
  },
  text: `
In namespace ts-logs:

1. One of the pods labeled app=worker logged an error with code E4711.
   Write the name of this pod to /opt/cka/logs/error-pod.txt on <<cp>>.
2. Pod api-gateway runs two containers. Save the complete logs of container
   auth-proxy only to /opt/cka/logs/auth-proxy.log on <<cp>>.
`,
  solution: `
for p in $(kubectl -n ts-logs get pods -l app=worker -o name); do
  kubectl -n ts-logs logs $p | grep -q 'code=E4711' && echo \${p#pod/}
done > /opt/cka/logs/error-pod.txt
# albo: kubectl -n ts-logs logs -l app=worker --prefix --tail=-1 | grep E4711

kubectl -n ts-logs logs api-gateway -c auth-proxy > /opt/cka/logs/auth-proxy.log
`,
});

// =============================================================================== kubectl top
task({
  id: 'ts-top', domain: 'troubleshooting', title: 'Monitorowanie zużycia zasobów (metrics-server)', host: 'cp', minutes: 3,
  namespaces: ['ts-metrics'],
  setup(c) {
    const ns = 'ts-metrics';
    const names = ['calc-1', 'calc-2', 'calc-3'];
    const busy = c.choice(names);
    c.state.busy = busy;
    c.apply(names.map((n) => pod(n, ns, BUSYBOX, { labels: { app: 'calc' }, containers: [container('calc', BUSYBOX, { command: n === busy ? 'while :; do :; done' : 'sleep 3600', resources: { requests: { cpu: '10m', memory: '8Mi' }, limits: { cpu: '300m', memory: '32Mi' } } })] })));
    c.workdir(c.cfg.cp, '/opt/cka/metrics');
  },
  check(c, g) {
    const got = (c.read(c.cfg.cp, '/opt/cka/metrics/top-pod.txt') || '').trim();
    g.ok('top-pod.txt = pod app=calc z największym zużyciem CPU', got === c.state.busy, `jest '${got}'`);
  },
  text: `
Among the pods with label app=calc in namespace ts-metrics, find the one that
currently consumes the most CPU. Write its name (only the name) to
/opt/cka/metrics/top-pod.txt on <<cp>>.
`,
  solution: `
kubectl -n ts-metrics top pod -l app=calc --sort-by=cpu
kubectl -n ts-metrics top pod -l app=calc --sort-by=cpu --no-headers | head -1 | awk '{print $1}' > /opt/cka/metrics/top-pod.txt
# (metryki pojawiają się ok. 1 min po starcie podów)
`,
  test: `
sleep 60
kubectl -n ts-metrics top pod -l app=calc --sort-by=cpu
kubectl -n ts-metrics top pod -l app=calc --sort-by=cpu --no-headers | head -1 | awk '{print $1}' > /opt/cka/metrics/top-pod.txt
`,
});

// =============================================================================== init container + brak Service
task({
  id: 'ts-init-dns', domain: 'troubleshooting', title: 'Pody utknęły w Init', host: 'cp', minutes: 5,
  namespaces: ['ts-init'],
  setup(c) {
    const ns = 'ts-init';
    const objs = echoApp('shop-db', ns, 'db-ok');
    const web = deployment('web-shop', ns, NGINX, { replicas: 2 });
    web.spec.template.spec.initContainers = [container('wait-for-db', BUSYBOX, { command: 'until nslookup shop-db.ts-init.svc.cluster.local; do echo waiting for shop-db; sleep 2; done' })];
    objs.push(web);
    c.apply(objs);
  },
  check(c, g) {
    const ns = 'ts-init';
    const s = c.get('service', 'shop-db', ns);
    g.ok('Service shop-db istnieje i wybiera pody app=shop-db', deq(jp(s, 'spec.selector'), { app: 'shop-db' }));
    g.ok('Service shop-db: port 80 z gotowym endpointem', ((jp(s, 'spec.ports', []) || [{}])[0] || {}).port === 80 && c.endpoints_ready('shop-db', ns) >= 1);
    const d = c.get('deployment', 'web-shop', ns);
    g.ok('deployment web-shop nie był modyfikowany', jp(d, 'metadata.generation') === 1);
    g.ok('web-shop: 2 gotowe repliki', readyReplicas(d) === 2);
  },
  text: `
Pods of deployment web-shop in namespace ts-init never leave the Init state.

Find the cause and fix it WITHOUT modifying deployment web-shop.
Hint: the database is deployment shop-db (listening on TCP 80).
`,
  solution: `
kubectl -n ts-init get pods                                   # Init:0/1
kubectl -n ts-init logs deploy/web-shop -c wait-for-db        # waiting for shop-db / NXDOMAIN
kubectl -n ts-init get svc                                    # brak Service shop-db
kubectl -n ts-init expose deployment shop-db --port=80 --target-port=80
kubectl -n ts-init get pods -w
`,
  test: `
kubectl -n ts-init get pods
kubectl -n ts-init logs deploy/web-shop -c wait-for-db | tail -2
kubectl -n ts-init expose deployment shop-db --port=80 --target-port=80
sleep 30
kubectl -n ts-init get pods
`,
});

// =============================================================================== DNS klastra
task({
  id: 'ts-dns', domain: 'troubleshooting', title: 'Pody nie rozwiązują nazw (DNS klastra)', host: 'cp', minutes: 7,
  conflicts: ['coredns'], disruptive: true, namespaces: ['ts-dns'], variants: ['scaled', 'zone', 'selector'],
  setup(c) {
    const ns = 'kube-system';
    Object.assign(c.state, { replicas: jp(c.get('deployment', 'coredns', ns), 'spec.replicas', 2), corefile: jp(c.get('configmap', 'coredns', ns), 'data.Corefile', ''), selector: jp(c.get('service', 'kube-dns', ns), 'spec.selector', { 'k8s-app': 'kube-dns' }) });
    const v = variant(c, ['scaled', 'zone', 'selector']);
    if (v === 'scaled') c.k('-n', ns, 'scale', 'deployment', 'coredns', '--replicas=0');
    else if (v === 'zone') {
      c.apply(configmap('coredns', ns, { Corefile: c.state.corefile.replace('kubernetes cluster.local', 'kubernetes cluster.lokal') }));
      c.k('-n', ns, 'rollout', 'restart', 'deployment/coredns');
      c.rollout('deployment/coredns', ns, 120);
    } else c.k('-n', ns, 'patch', 'service', 'kube-dns', '-p', '{"spec":{"selector":{"k8s-app":"kube-dnz"}}}');
  },
  check(c, g) {
    const res = c.probe('ts-dns', { app: 'client' }, [['nslookup kubernetes.default.svc.cluster.local.', true], ['nslookup kube-dns.kube-system.svc.cluster.local.', true]]);
    g.ok('pody rozwiązują kubernetes.default.svc.cluster.local', res[0][0] && res[0][1].out.includes(c.cfg.kubernetes_svc_ip), res[0][1] && res[0][1].text);
    g.ok('pody rozwiązują kube-dns.kube-system.svc.cluster.local', res[1][0]);
    const d = c.get('deployment', 'coredns', 'kube-system');
    const want = c.state.replicas ?? 2;
    g.ok(`CoreDNS: ${want} gotowe repliki`, jp(d, 'spec.replicas') === want && readyReplicas(d) === want);
    g.ok('Service kube-dns wybiera pody CoreDNS', deq(jp(c.get('service', 'kube-dns', 'kube-system'), 'spec.selector'), c.state.selector));
    g.ok('Corefile obsługuje strefę cluster.local', String(jp(c.get('configmap', 'coredns', 'kube-system'), 'data.Corefile', '')).includes('kubernetes cluster.local'));
  },
  cleanup(c) {
    const ns = 'kube-system';
    if (c.state.corefile) c.apply(configmap('coredns', ns, { Corefile: c.state.corefile }));
    if (c.state.selector) c.kubectl('-n', ns, 'patch', 'service', 'kube-dns', '--type=merge', '-p', JSON.stringify({ spec: { selector: c.state.selector } }));
    c.kubectl('-n', ns, 'scale', 'deployment', 'coredns', `--replicas=${c.state.replicas ?? 2}`);
    c.kubectl('-n', ns, 'rollout', 'restart', 'deployment/coredns');
  },
  text: `
Applications report that service names like kubernetes.default.svc.cluster.local
cannot be resolved from pods anymore.

Investigate and fix cluster DNS. CoreDNS must run with its original number of
replicas (<<replicas>>).
`,
  solution: `
kubectl run t --rm -it --image=busybox:1.36 -- nslookup kubernetes.default
kubectl -n kube-system get deploy coredns ; kubectl -n kube-system get pods -l k8s-app=kube-dns
kubectl -n kube-system get endpointslices -l kubernetes.io/service-name=kube-dns
kubectl -n kube-system get svc kube-dns -o yaml | grep -A2 selector
kubectl -n kube-system get cm coredns -o yaml
# Wariant: <<variant>>
#  scaled   -> kubectl -n kube-system scale deploy coredns --replicas=<<replicas>>
#  zone     -> w Corefile 'kubernetes cluster.lokal' -> 'kubernetes cluster.local'; restart coredns
#  selector -> selector Service kube-dns: k8s-app: kube-dns (był kube-dnz)
`,
  tests: {
    scaled: 'kubectl -n kube-system scale deploy coredns --replicas=<<replicas>>\nkubectl -n kube-system rollout status deploy coredns',
    zone: "kubectl -n kube-system get cm coredns -o yaml > cm.yaml\nsed -i 's/cluster.lokal/cluster.local/' cm.yaml\nkubectl apply -f cm.yaml\nkubectl -n kube-system rollout restart deploy coredns\nkubectl -n kube-system rollout status deploy coredns",
    selector: 'kubectl -n kube-system patch svc kube-dns -p \'{"spec":{"selector":{"k8s-app":"kube-dns"}}}\'\nsleep 10',
  },
});

// =============================================================================== kubeconfig
task({
  id: 'ts-kubeconfig', domain: 'troubleshooting', title: 'Zepsuty kubeconfig użytkownika', host: 'w1', minutes: 4,
  conflicts: ['kubeconfig-w1'], variants: ['port', 'context', 'user'],
  setup(c) {
    const w1 = c.cfg.w1, u = c.cfg.vm_user;
    const v = variant(c, ['port', 'context', 'user']);
    c.sh(w1, `mkdir -p ${BK} && cp -f /home/${u}/.kube/config ${BK}/kubeconfig-${u}`);
    const f = `/home/${u}/.kube/config`;
    const scripts = {
      port: `sed -i 's#:6443#:6643#' ${f}`,
      context: `sed -i 's/^current-context: .*/current-context: admin@cka-prod/' ${f}`,
      user: `sed -i -E 's/^(\\s+user:) kubernetes-admin$/\\1 kubernetes-admin2/' ${f}`,
    };
    c.sh(w1, `${scripts[v]}\n! cmp -s ${f} ${BK}/kubeconfig-${u}`);
  },
  check(c, g) {
    const w1 = c.cfg.w1;
    let r = c.ssh(w1, 'kubectl get nodes');
    g.ok(`na ${w1} 'kubectl get nodes' działa dla użytkownika ${c.cfg.vm_user}`, r.ok, r.text.slice(0, 300));
    r = c.ssh(w1, "kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'");
    g.ok(`serwer API: https://${c.cfg.ip(c.cfg.cp)}:6443`, r.out.trim().endsWith(':6443'), r.text);
  },
  cleanup(c) { c.ssh(c.cfg.w1, `cp -f ${BK}/kubeconfig-${c.cfg.vm_user} /home/${c.cfg.vm_user}/.kube/config`, true); },
  text: `
On <<w1>> the command "kubectl get nodes" fails for user <<vm_user>>.

Fix the kubeconfig file ~/.kube/config of this user. Do not replace it with a
different file; repair the existing configuration.
`,
  solution: `
ssh <<w1>>
kubectl get nodes          # przeczytaj dokładnie komunikat błędu
kubectl config view
kubectl config get-contexts
# Wariant: <<variant>>
#  port    -> server: https://<<cp_ip>>:6443 (był 6643)
#  context -> kubectl config use-context kubernetes-admin@kubernetes
#  user    -> w kontekście user: kubernetes-admin (był kubernetes-admin2)
#             kubectl config set-context kubernetes-admin@kubernetes --user=kubernetes-admin
`,
  tests: {
    port: "kubectl get nodes\nsed -i 's#:6643#:6443#' ~/.kube/config\nkubectl get nodes",
    context: 'kubectl get nodes\nkubectl config get-contexts\nkubectl config use-context kubernetes-admin@kubernetes\nkubectl get nodes',
    user: 'kubectl get nodes\nkubectl config set-context kubernetes-admin@kubernetes --user=kubernetes-admin\nkubectl get nodes',
  },
});
