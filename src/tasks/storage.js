// Domena: Storage (10%).
import { task, BUSYBOX, pod } from './registry.js';
import { jp, cont, podSpec, podReady, qeq, deq } from './ctx.js';

function mountClaim(p, claim, path) {
  const vols = Object.fromEntries((podSpec(p).volumes || []).map((v) => [v.name, v]));
  return (cont(p).volumeMounts || []).some((m) => m.mountPath === path && jp(vols[m.name], 'persistentVolumeClaim.claimName') === claim);
}

// =============================================================================== PV/PVC statyczne
task({
  id: 'pv-pvc-static', domain: 'storage', title: 'Statyczny PersistentVolume (hostPath) z nodeAffinity', host: 'cp', minutes: 8,
  namespaces: ['st-static'],
  setup(c) {
    const marker = `report-${c.token(5)}`;
    c.state.marker = marker;
    c.delete('pv', 'reports-pv', null, true);
    c.sh(c.cfg.w1, `mkdir -p /srv/cka/reports && echo ${marker} > /srv/cka/reports/index.html && chmod -R a+rX /srv/cka`);
  },
  check(c, g) {
    const ns = 'st-static', w1 = c.cfg.w1;
    const pv = c.get('pv', 'reports-pv');
    g.ok('PV reports-pv: 1Gi, ReadWriteOnce', qeq(jp(pv, 'spec.capacity.storage'), '1Gi') && deq(jp(pv, 'spec.accessModes'), ['ReadWriteOnce']));
    g.ok('PV: reclaimPolicy Retain, storageClassName manual', jp(pv, 'spec.persistentVolumeReclaimPolicy') === 'Retain' && jp(pv, 'spec.storageClassName') === 'manual');
    g.ok('PV: hostPath /srv/cka/reports', String(jp(pv, 'spec.hostPath.path', '')).replace(/\/$/, '') === '/srv/cka/reports');
    const terms = jp(pv, 'spec.nodeAffinity.required.nodeSelectorTerms', []) || [];
    g.ok(`PV: nodeAffinity na węzeł ${w1}`, terms.some((t) => (t.matchExpressions || []).some((e) => e.key === 'kubernetes.io/hostname' && e.operator === 'In' && deq(e.values, [w1]))));
    const pvc = c.get('pvc', 'reports-pvc', ns);
    g.ok('PVC reports-pvc: 500Mi, klasa manual', qeq(jp(pvc, 'spec.resources.requests.storage'), '500Mi') && jp(pvc, 'spec.storageClassName') === 'manual');
    g.ok('PVC Bound do reports-pv', jp(pvc, 'status.phase') === 'Bound' && jp(pvc, 'spec.volumeName') === 'reports-pv');
    const p = c.get('pod', 'reports-reader', ns);
    g.ok(`pod reports-reader Running na ${w1}`, p && podReady(p) && jp(p, 'spec.nodeName') === w1);
    g.ok('pod montuje reports-pvc w /usr/share/nginx/html', mountClaim(p, 'reports-pvc', '/usr/share/nginx/html'));
    const r = p ? c.exec(ns, 'reports-reader', 'cat /usr/share/nginx/html/index.html') : null;
    g.ok('w podzie widać dane z hosta', r && r.out.includes(c.state.marker || '?'));
  },
  cleanup(c) { c.delete('pv', 'reports-pv'); },
  text: `
Reports are stored on node <<w1>> in directory /srv/cka/reports.

1. Create a PersistentVolume reports-pv:
     capacity 1Gi, access mode ReadWriteOnce, reclaim policy Retain,
     storageClassName manual, hostPath /srv/cka/reports.
   Pods using it must be scheduled on <<w1>> (use node affinity on the PV).
2. Create a PersistentVolumeClaim reports-pvc in namespace st-static requesting
   500Mi with storageClassName manual. It must bind to reports-pv.
3. Create a Pod reports-reader (image nginx:1.28-alpine) in namespace st-static
   that mounts the claim at /usr/share/nginx/html.
`,
  solution: `
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: PersistentVolume
metadata:
  name: reports-pv
spec:
  capacity: {storage: 1Gi}
  accessModes: [ReadWriteOnce]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: manual
  hostPath:
    path: /srv/cka/reports
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values: [<<w1>>]
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: reports-pvc
  namespace: st-static
spec:
  storageClassName: manual
  accessModes: [ReadWriteOnce]
  resources:
    requests: {storage: 500Mi}
---
apiVersion: v1
kind: Pod
metadata:
  name: reports-reader
  namespace: st-static
spec:
  containers:
  - name: web
    image: nginx:1.28-alpine
    volumeMounts:
    - {name: data, mountPath: /usr/share/nginx/html}
  volumes:
  - name: data
    persistentVolumeClaim: {claimName: reports-pvc}
EOF
kubectl get pv,pvc -n st-static
`,
});

// =============================================================================== StorageClass domyślna
const DEFAULT_ANN = 'storageclass.kubernetes.io/is-default-class';
function scReset(c) {
  c.delete('storageclass', 'local-fast');
  c.kubectl('patch', 'storageclass', 'local-path', '-p', JSON.stringify({ metadata: { annotations: { [DEFAULT_ANN]: 'true' } } }));
}

task({
  id: 'storageclass-default', domain: 'storage', title: 'StorageClass jako domyślna + dynamiczny PVC', host: 'cp', minutes: 7,
  conflicts: ['default-sc'], namespaces: ['st-dyn'], setup: scReset, cleanup: scReset,
  check(c, g) {
    const ns = 'st-dyn';
    const sc = c.get('storageclass', 'local-fast');
    g.ok('StorageClass local-fast: provisioner rancher.io/local-path', jp(sc, 'provisioner') === 'rancher.io/local-path');
    g.ok('reclaimPolicy Delete, volumeBindingMode WaitForFirstConsumer', sc && jp(sc, 'reclaimPolicy', 'Delete') === 'Delete' && jp(sc, 'volumeBindingMode') === 'WaitForFirstConsumer');
    const defaults = c.list('storageclass').filter((s) => (jp(s, 'metadata.annotations', {}) || {})[DEFAULT_ANN] === 'true').map((s) => s.metadata.name);
    g.ok('local-fast jest JEDYNĄ domyślną StorageClass', deq(defaults, ['local-fast']), `domyślne: ${defaults.join(', ')}`);
    const pvc = c.get('pvc', 'data', ns);
    g.ok('PVC data: 2Gi, ReadWriteOnce', qeq(jp(pvc, 'spec.resources.requests.storage'), '2Gi') && deq(jp(pvc, 'spec.accessModes'), ['ReadWriteOnce']));
    g.ok('PVC data dostał klasę local-fast (domyślna) i jest Bound', jp(pvc, 'spec.storageClassName') === 'local-fast' && jp(pvc, 'status.phase') === 'Bound');
    const p = c.get('pod', 'writer', ns);
    g.ok('pod writer montuje PVC data w /data i działa', p && podReady(p) && mountClaim(p, 'data', '/data'));
    const r = p ? c.exec(ns, 'writer', 'cat /data/ok.txt') : null;
    g.ok("plik /data/ok.txt zawiera 'ok'", r && r.out.trim() === 'ok');
  },
  text: `
1. Create a StorageClass named local-fast:
     provisioner rancher.io/local-path, reclaimPolicy Delete,
     volumeBindingMode WaitForFirstConsumer.
2. Make local-fast the ONLY default StorageClass of the cluster.
3. In namespace st-dyn create a PVC named data (2Gi, ReadWriteOnce) WITHOUT
   specifying storageClassName.
4. Create a Pod writer (image busybox:1.36) in st-dyn that mounts the PVC at /data
   and runs: sh -c 'echo ok > /data/ok.txt && sleep 3600'
`,
  solution: `
cat <<'EOF' | kubectl apply -f -
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-fast
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: rancher.io/local-path
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
EOF
kubectl patch storageclass local-path -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'
kubectl get sc

cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: data, namespace: st-dyn}
spec:
  accessModes: [ReadWriteOnce]
  resources: {requests: {storage: 2Gi}}
---
apiVersion: v1
kind: Pod
metadata: {name: writer, namespace: st-dyn}
spec:
  containers:
  - name: writer
    image: busybox:1.36
    command: ["sh", "-c", "echo ok > /data/ok.txt && sleep 3600"]
    volumeMounts: [{name: data, mountPath: /data}]
  volumes:
  - name: data
    persistentVolumeClaim: {claimName: data}
EOF
`,
});

// =============================================================================== Reclaim + ponowne użycie PV
task({
  id: 'pv-reclaim-reuse', domain: 'storage', title: 'Reclaim policy Retain i ponowne podpięcie PV', host: 'cp', minutes: 9,
  namespaces: ['st-reclaim'],
  setup(c) {
    const ns = 'st-reclaim';
    for (const pv of c.list('pv')) if (jp(pv, 'spec.claimRef.namespace') === ns) c.delete('pv', pv.metadata.name);
    const marker = `orders-${c.token(5)}`;
    c.state.marker = marker;
    const writer = pod('orders-writer', ns, BUSYBOX, { command: `echo ${marker} > /data/marker.txt && sleep 3600`, volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'orders-data' } }] });
    writer.spec.containers[0].volumeMounts = [{ name: 'data', mountPath: '/data' }];
    c.apply([
      { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'orders-data', namespace: ns }, spec: { storageClassName: 'local-path', accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } },
      writer,
    ]);
    c.wait('pod/orders-writer', '-n', ns, '--for=condition=Ready', { timeout: 180 });
    c.state.pv = jp(c.get('pvc', 'orders-data', ns), 'spec.volumeName');
  },
  check(c, g) {
    const ns = 'st-reclaim', pvn = c.state.pv;
    const pv = pvn ? c.get('pv', pvn) : null;
    g.ok(`oryginalny PV (${pvn}) nadal istnieje`, pv);
    g.ok('PV ma reclaimPolicy Retain', jp(pv, 'spec.persistentVolumeReclaimPolicy') === 'Retain');
    g.ok('stary PVC orders-data i pod orders-writer usunięte', !c.exists('pvc', 'orders-data', ns) && !c.exists('pod', 'orders-writer', ns));
    const pvc = c.get('pvc', 'orders-data-restored', ns);
    g.ok('PVC orders-data-restored jest Bound do oryginalnego PV', jp(pvc, 'status.phase') === 'Bound' && jp(pvc, 'spec.volumeName') === pvn);
    const p = c.get('pod', 'orders-reader', ns);
    g.ok('pod orders-reader działa i montuje orders-data-restored w /data', p && podReady(p) && mountClaim(p, 'orders-data-restored', '/data'));
    const r = p ? c.exec(ns, 'orders-reader', 'cat /data/marker.txt') : null;
    g.ok('dane zachowane: /data/marker.txt zawiera oryginalny znacznik', r && r.out.trim() === c.state.marker);
  },
  cleanup(c) { if (c.state.pv) c.kubectl('patch', 'pv', c.state.pv, '-p', '{"spec":{"persistentVolumeReclaimPolicy":"Delete"}}'); },
  text: `
In namespace st-reclaim pod orders-writer stores important data on PVC orders-data
(dynamically provisioned). The data must survive deletion of the claim.

1. Change the reclaim policy of the PersistentVolume bound to orders-data to Retain.
2. Delete pod orders-writer and PVC orders-data.
3. Make the PV available again and bind it to a NEW PVC named orders-data-restored
   (namespace st-reclaim, 1Gi, ReadWriteOnce, storageClassName local-path).
   It must bind to exactly this PV.
4. Create pod orders-reader (image busybox:1.36, command sleep 3600) that mounts
   orders-data-restored at /data. File /data/marker.txt must still contain the
   original data.
`,
  solution: `
PV=$(kubectl -n st-reclaim get pvc orders-data -o jsonpath='{.spec.volumeName}')
kubectl patch pv $PV -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
kubectl -n st-reclaim delete pod orders-writer
kubectl -n st-reclaim delete pvc orders-data
kubectl get pv $PV                              # STATUS: Released
kubectl patch pv $PV --type=json -p '[{"op":"remove","path":"/spec/claimRef"}]'    # -> Available

cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: orders-data-restored, namespace: st-reclaim}
spec:
  storageClassName: local-path
  volumeName: $PV                    # wiązanie z konkretnym PV
  accessModes: [ReadWriteOnce]
  resources: {requests: {storage: 1Gi}}
---
apiVersion: v1
kind: Pod
metadata: {name: orders-reader, namespace: st-reclaim}
spec:
  containers:
  - name: reader
    image: busybox:1.36
    command: ["sleep", "3600"]
    volumeMounts: [{name: data, mountPath: /data}]
  volumes:
  - name: data
    persistentVolumeClaim: {claimName: orders-data-restored}
EOF
kubectl -n st-reclaim exec orders-reader -- cat /data/marker.txt
`,
});

// =============================================================================== StatefulSet + volumeClaimTemplates
task({
  id: 'statefulset-storage', domain: 'storage', title: 'StatefulSet z volumeClaimTemplates i headless Service', host: 'cp', minutes: 7,
  namespaces: ['st-sts'],
  check(c, g) {
    const ns = 'st-sts';
    const s = c.get('service', 'kv', ns);
    g.ok('headless Service kv (clusterIP: None)', jp(s, 'spec.clusterIP') === 'None');
    const st = c.get('statefulset', 'kv', ns);
    g.ok('StatefulSet kv: serviceName kv, 2 repliki', jp(st, 'spec.serviceName') === 'kv' && jp(st, 'spec.replicas') === 2);
    g.ok('podManagementPolicy Parallel', jp(st, 'spec.podManagementPolicy') === 'Parallel');
    const vct = (jp(st, 'spec.volumeClaimTemplates', []) || [{}])[0] || {};
    g.ok('volumeClaimTemplate data: 256Mi, local-path, RWO', jp(vct, 'metadata.name') === 'data' && qeq(jp(vct, 'spec.resources.requests.storage'), '256Mi') && jp(vct, 'spec.storageClassName') === 'local-path' && deq(jp(vct, 'spec.accessModes'), ['ReadWriteOnce']));
    g.ok('wolumen data zamontowany w /usr/share/nginx/html', (cont(st).volumeMounts || []).some((m) => m.name === 'data' && m.mountPath === '/usr/share/nginx/html'));
    g.ok('2 gotowe repliki', jp(st, 'status.readyReplicas') === 2);
    g.ok('PVC data-kv-0 i data-kv-1 są Bound', [0, 1].every((i) => jp(c.get('pvc', `data-kv-${i}`, ns), 'status.phase') === 'Bound'));
    const ip0 = jp(c.get('pod', 'kv-0', ns), 'status.podIP');
    const res = c.probe(ns, { app: 'client' }, [['nslookup kv-0.kv.st-sts.svc.cluster.local.', true]]);
    g.ok('DNS: kv-0.kv.st-sts.svc.cluster.local -> IP poda kv-0', res[0][0] && ip0 && res[0][1].out.includes(ip0), res[0][1] && res[0][1].text);
  },
  text: `
In namespace st-sts:

1. Create a headless Service named kv (port 80) selecting pods with label app=kv.
2. Create a StatefulSet named kv using this Service:
     - 2 replicas, pods started in parallel
     - image nginx:1.28-alpine, label app=kv
     - each replica gets its own volume from a volumeClaimTemplate named data:
       256Mi, ReadWriteOnce, storageClassName local-path,
       mounted at /usr/share/nginx/html
`,
  solution: `
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Service
metadata: {name: kv, namespace: st-sts}
spec:
  clusterIP: None
  selector: {app: kv}
  ports: [{port: 80}]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: {name: kv, namespace: st-sts}
spec:
  serviceName: kv
  replicas: 2
  podManagementPolicy: Parallel
  selector:
    matchLabels: {app: kv}
  template:
    metadata:
      labels: {app: kv}
    spec:
      containers:
      - name: nginx
        image: nginx:1.28-alpine
        volumeMounts: [{name: data, mountPath: /usr/share/nginx/html}]
  volumeClaimTemplates:
  - metadata: {name: data}
    spec:
      storageClassName: local-path
      accessModes: [ReadWriteOnce]
      resources: {requests: {storage: 256Mi}}
EOF
kubectl -n st-sts get sts,pods,pvc
`,
});
