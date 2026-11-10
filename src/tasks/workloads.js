// Domena: Workloads & Scheduling (15%).
import { task, BUSYBOX, NGINX, NGINX_OLD, deployment } from './registry.js';
import { jp, cont, envVar, podReady, podSpec, readyReplicas, qeq, condition, deq } from './ctx.js';
import { b64dec } from '../lib/util.js';

// =============================================================================== rollout / rollback
task({
  id: 'rollout-rollback', domain: 'workloads', title: 'Rolling update i rollback Deploymentu', host: 'cp', minutes: 6,
  namespaces: ['ws-rollout'],
  setup(c) {
    const ns = 'ws-rollout';
    c.workdir(c.cfg.cp, '/opt/cka/rollout');
    c.apply(deployment('checkout', ns, NGINX_OLD, { replicas: 3, annotations: { 'kubernetes.io/change-cause': 'initial release nginx 1.27' } }));
    c.rollout('deployment/checkout', ns, 240);
    for (const [img, cause, wait] of [[NGINX, 'upgrade to nginx 1.28', true], ['nginx:1.299-alpine', 'upgrade to nginx 1.299', false]]) {
      c.k('annotate', 'deployment', 'checkout', '-n', ns, `kubernetes.io/change-cause=${cause}`, '--overwrite');
      c.k('set', 'image', 'deployment/checkout', `checkout=${img}`, '-n', ns);
      if (wait) c.rollout('deployment/checkout', ns, 240);
    }
  },
  check(c, g) {
    const ns = 'ws-rollout';
    const d = c.get('deployment', 'checkout', ns);
    g.ok(`obraz to ${NGINX} (rollback)`, jp(d, 'spec.template.spec.containers.0.image') === NGINX);
    g.ok('strategy RollingUpdate maxSurge=1 maxUnavailable=0', jp(d, 'spec.strategy.type') === 'RollingUpdate' && String(jp(d, 'spec.strategy.rollingUpdate.maxSurge')) === '1' && String(jp(d, 'spec.strategy.rollingUpdate.maxUnavailable')) === '0');
    g.ok('4 repliki, wszystkie zaktualizowane i dostępne', jp(d, 'spec.replicas') === 4 && readyReplicas(d) === 4 && jp(d, 'status.updatedReplicas') === 4 && jp(d, 'status.availableReplicas') === 4);
    const bad = c.list('replicasets', ns).filter((rs) => String(jp(rs, 'spec.template.spec.containers.0.image', '')).includes('1.299') && jp(rs, 'status.replicas', 0));
    g.ok('żaden pod nie używa zepsutego obrazu', !bad.length);
    const rev = (c.read(c.cfg.cp, '/opt/cka/rollout/revision.txt') || '').trim();
    g.ok('revision.txt = numer rewizji z obrazem nginx:1.27-alpine', rev === '1', `jest '${rev}'`);
  },
  text: `
Deployment checkout in namespace ws-rollout was updated several times and the
latest rollout is stuck.

1. Roll the deployment back to the revision that used image nginx:1.28-alpine.
2. Write the number of the revision that used image nginx:1.27-alpine to
   /opt/cka/rollout/revision.txt on <<cp>>.
3. Set the update strategy to RollingUpdate with maxSurge 1 and maxUnavailable 0.
4. Scale the deployment to 4 replicas. All replicas must be available.
`,
  solution: `
kubectl -n ws-rollout rollout history deployment checkout
kubectl -n ws-rollout rollout history deployment checkout --revision=1    # obraz 1.27
kubectl -n ws-rollout rollout undo deployment checkout --to-revision=2
echo 1 > /opt/cka/rollout/revision.txt

kubectl -n ws-rollout patch deployment checkout -p \\
 '{"spec":{"strategy":{"type":"RollingUpdate","rollingUpdate":{"maxSurge":1,"maxUnavailable":0}}}}'
kubectl -n ws-rollout scale deployment checkout --replicas=4
kubectl -n ws-rollout rollout status deployment checkout
`,
});

// =============================================================================== ConfigMap + Secret
task({
  id: 'config-secret', domain: 'workloads', title: 'ConfigMap i Secret: zmienne środowiskowe i wolumeny', host: 'cp', minutes: 8,
  namespaces: ['ws-config'],
  check(c, g) {
    const ns = 'ws-config';
    const cm = c.get('configmap', 'app-settings', ns);
    g.ok('ConfigMap app-settings: LOG_LEVEL=debug', jp(cm, 'data.LOG_LEVEL') === 'debug');
    const props = (cm?.data || {})['app.properties'] || '';
    g.ok('ConfigMap app-settings: klucz app.properties z obiema liniami', props.includes('server.port=8080') && props.includes('feature.cart=true'));
    const sec = c.get('secret', 'db-credentials', ns);
    const dec = (k) => { try { return b64dec(jp(sec, `data.${k}`, '') || ''); } catch { return ''; } };
    g.ok('Secret db-credentials: DB_USER=shop, DB_PASSWORD=S3cr3t-Pa55', sec && dec('DB_USER') === 'shop' && dec('DB_PASSWORD') === 'S3cr3t-Pa55');
    const p = c.get('pod', 'config-demo', ns);
    g.ok('pod config-demo jest Running', p && podReady(p));
    const ct = cont(p);
    const e1 = envVar(ct, 'LOG_LEVEL'), e2 = envVar(ct, 'DB_PASSWORD');
    g.ok('env LOG_LEVEL pochodzi z ConfigMap (configMapKeyRef)', jp(e1, 'valueFrom.configMapKeyRef.name') === 'app-settings' && jp(e1, 'valueFrom.configMapKeyRef.key') === 'LOG_LEVEL');
    g.ok('env DB_PASSWORD pochodzi z Secret (secretKeyRef)', jp(e2, 'valueFrom.secretKeyRef.name') === 'db-credentials' && jp(e2, 'valueFrom.secretKeyRef.key') === 'DB_PASSWORD');
    let r = c.exec(ns, 'config-demo', 'echo "$LOG_LEVEL|$DB_PASSWORD"');
    g.ok('w kontenerze: LOG_LEVEL=debug i DB_PASSWORD ustawione', r.out.trim() === 'debug|S3cr3t-Pa55', r.text);
    r = c.exec(ns, 'config-demo', 'cat /etc/app/app.properties');
    g.ok('plik /etc/app/app.properties zamontowany z ConfigMap', r.out.includes('feature.cart=true'), r.text);
    r = c.exec(ns, 'config-demo', 'cat /etc/db-secret/DB_USER');
    g.ok('Secret zamontowany w /etc/db-secret (plik DB_USER)', r.out.trim() === 'shop', r.text);
    const mounts = Object.fromEntries((ct.volumeMounts || []).map((m) => [m.mountPath, m]));
    g.ok('/etc/db-secret zamontowany readOnly', jp(mounts['/etc/db-secret'], 'readOnly') === true);
  },
  text: `
In namespace ws-config:

1. Create a ConfigMap app-settings with:
     key LOG_LEVEL with value debug
     key app.properties with this content (two lines):
        server.port=8080
        feature.cart=true
2. Create a generic Secret db-credentials with DB_USER=shop and DB_PASSWORD=S3cr3t-Pa55.
3. Create a Pod config-demo (image busybox:1.36, command: sleep 3600) where:
     - env var LOG_LEVEL is taken from ConfigMap key LOG_LEVEL
     - env var DB_PASSWORD is taken from Secret key DB_PASSWORD
     - ConfigMap key app.properties is available as file /etc/app/app.properties
     - the whole Secret is mounted read-only in /etc/db-secret
`,
  solution: `
printf 'server.port=8080\\nfeature.cart=true\\n' > app.properties
kubectl -n ws-config create configmap app-settings --from-literal=LOG_LEVEL=debug --from-file=app.properties
kubectl -n ws-config create secret generic db-credentials \\
  --from-literal=DB_USER=shop --from-literal=DB_PASSWORD='S3cr3t-Pa55'

cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: config-demo
  namespace: ws-config
spec:
  containers:
  - name: app
    image: busybox:1.36
    command: ["sleep", "3600"]
    env:
    - name: LOG_LEVEL
      valueFrom:
        configMapKeyRef: {name: app-settings, key: LOG_LEVEL}
    - name: DB_PASSWORD
      valueFrom:
        secretKeyRef: {name: db-credentials, key: DB_PASSWORD}
    volumeMounts:
    - {name: props, mountPath: /etc/app}
    - {name: creds, mountPath: /etc/db-secret, readOnly: true}
  volumes:
  - name: props
    configMap:
      name: app-settings
      items:
      - {key: app.properties, path: app.properties}
  - name: creds
    secret:
      secretName: db-credentials
EOF
`,
});

// =============================================================================== HPA
task({
  id: 'hpa', domain: 'workloads', title: 'HorizontalPodAutoscaler (autoscaling/v2)', host: 'cp', minutes: 7,
  namespaces: ['ws-hpa'],
  setup(c) { c.apply(deployment('php-api', 'ws-hpa', NGINX, { replicas: 1 })); },
  check(c, g) {
    const ns = 'ws-hpa';
    const d = c.get('deployment', 'php-api', ns);
    const res = jp(d, 'spec.template.spec.containers.0.resources', {}) || {};
    g.ok('requests: cpu 100m, memory 64Mi', qeq(jp(res, 'requests.cpu'), '100m') && qeq(jp(res, 'requests.memory'), '64Mi'), res);
    g.ok('limits: cpu 200m', qeq(jp(res, 'limits.cpu'), '200m'), res);
    const h = c.get('horizontalpodautoscalers.v2.autoscaling', 'php-api', ns) || c.get('hpa', 'php-api', ns);
    g.ok('HPA php-api istnieje', h);
    g.ok('HPA celuje w Deployment php-api', jp(h, 'spec.scaleTargetRef.kind') === 'Deployment' && jp(h, 'spec.scaleTargetRef.name') === 'php-api');
    g.ok('minReplicas 2, maxReplicas 8', jp(h, 'spec.minReplicas') === 2 && jp(h, 'spec.maxReplicas') === 8);
    const mets = jp(h, 'spec.metrics', []) || [];
    g.ok('metryka: średnie zużycie CPU 50% (Utilization)', mets.some((m) => m.type === 'Resource' && jp(m, 'resource.name') === 'cpu' && jp(m, 'resource.target.type') === 'Utilization' && jp(m, 'resource.target.averageUtilization') === 50));
    g.ok('behavior.scaleDown.stabilizationWindowSeconds = 120', jp(h, 'spec.behavior.scaleDown.stabilizationWindowSeconds') === 120);
    g.ok('HPA odczytuje metryki (ScalingActive=True)', condition(h, 'ScalingActive') === 'True', 'metrics-server potrzebuje ~1 min po starcie podów; upewnij się że requests.cpu są ustawione');
    g.ok('deployment ma >= 2 gotowe repliki', readyReplicas(c.get('deployment', 'php-api', ns)) >= 2);
  },
  text: `
In namespace ws-hpa:

1. Configure deployment php-api so that its container requests cpu 100m and
   memory 64Mi and is limited to cpu 200m.
2. Create a HorizontalPodAutoscaler named php-api (autoscaling/v2) for this deployment:
     - min 2, max 8 replicas
     - target average CPU utilization 50%
     - scale-down stabilization window 120 seconds
`,
  solution: `
kubectl -n ws-hpa set resources deployment php-api --requests=cpu=100m,memory=64Mi --limits=cpu=200m

cat <<'EOF' | kubectl apply -f -
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: php-api
  namespace: ws-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: php-api
  minReplicas: 2
  maxReplicas: 8
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 50
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 120
EOF
kubectl -n ws-hpa get hpa -w
# (szkielet: kubectl autoscale deploy php-api --min=2 --max=8 --cpu=50% --dry-run=client -o yaml)
`,
  test: `
kubectl -n ws-hpa set resources deployment php-api --requests=cpu=100m,memory=64Mi --limits=cpu=200m
cat <<'EOF' | kubectl apply -f -
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: php-api
  namespace: ws-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: php-api
  minReplicas: 2
  maxReplicas: 8
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 50
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 120
EOF
sleep 90
kubectl -n ws-hpa get hpa
`,
});

// =============================================================================== affinity + taints
function affReset(c) {
  const w2 = c.cfg.w2;
  c.kubectl('taint', 'node', w2, 'workload-');
  c.kubectl('label', 'node', w2, 'tier-');
}
task({
  id: 'affinity-taints', domain: 'workloads', title: 'Node affinity, taints i tolerations', host: 'cp', minutes: 7,
  conflicts: ['node-w2', 'taint-w2'], namespaces: ['ws-sched'], setup: affReset, cleanup: affReset,
  check(c, g) {
    const ns = 'ws-sched', w2 = c.cfg.w2;
    const n = c.get('node', w2);
    g.ok(`${w2} ma label tier=gpu`, jp(n, 'metadata.labels.tier') === 'gpu');
    g.ok(`${w2} ma taint workload=gpu:NoSchedule`, (jp(n, 'spec.taints', []) || []).some((t) => t.key === 'workload' && t.value === 'gpu' && t.effect === 'NoSchedule'));
    const others = Object.entries(c.nodes()).filter(([name, x]) => name !== w2 && jp(x, 'metadata.labels.tier') === 'gpu');
    g.ok('żaden inny węzeł nie ma labela tier=gpu', !others.length);
    const d = c.get('deployment', 'trainer', ns);
    const terms = jp(d, 'spec.template.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms', []) || [];
    g.ok('required nodeAffinity: tier In [gpu]', terms.some((t) => (t.matchExpressions || []).some((e) => e.key === 'tier' && e.operator === 'In' && (e.values || []).includes('gpu'))));
    const tols = jp(d, 'spec.template.spec.tolerations', []) || [];
    g.ok('toleration dla workload=gpu:NoSchedule', tols.some((t) => t.key === 'workload' && (t.effect === 'NoSchedule' || !t.effect) && (t.operator === 'Exists' || t.value === 'gpu')));
    const pods = c.ready_pods(ns, 'app=trainer');
    g.ok('3 gotowe repliki', readyReplicas(d) === 3 && pods.length === 3);
    g.ok(`wszystkie pody działają na ${w2}`, pods.length && pods.every((p) => jp(p, 'spec.nodeName') === w2));
  },
  text: `
Node <<w2>> will be dedicated to GPU workloads.

1. Label node <<w2>> with tier=gpu.
2. Taint node <<w2>> with workload=gpu and effect NoSchedule.
3. In namespace ws-sched create a Deployment trainer with 3 replicas
   (image nginx:1.28-alpine, label app=trainer). Its pods:
     - must be scheduled ONLY on nodes labeled tier=gpu (required node affinity)
     - must tolerate the taint from step 2
`,
  solution: `
kubectl label node <<w2>> tier=gpu
kubectl taint node <<w2>> workload=gpu:NoSchedule

kubectl -n ws-sched create deployment trainer --image=nginx:1.28-alpine --replicas=3 --dry-run=client -o yaml > trainer.yaml
# dopisz w spec.template.spec:
#      affinity:
#        nodeAffinity:
#          requiredDuringSchedulingIgnoredDuringExecution:
#            nodeSelectorTerms:
#            - matchExpressions:
#              - key: tier
#                operator: In
#                values: ["gpu"]
#      tolerations:
#      - key: workload
#        operator: Equal
#        value: gpu
#        effect: NoSchedule
kubectl apply -f trainer.yaml
kubectl -n ws-sched get pods -o wide
`,
  test: `
kubectl label node <<w2>> tier=gpu
kubectl taint node <<w2>> workload=gpu:NoSchedule
cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: trainer
  namespace: ws-sched
  labels: {app: trainer}
spec:
  replicas: 3
  selector:
    matchLabels: {app: trainer}
  template:
    metadata:
      labels: {app: trainer}
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: tier
                operator: In
                values: ["gpu"]
      tolerations:
      - key: workload
        operator: Equal
        value: gpu
        effect: NoSchedule
      containers:
      - name: nginx
        image: nginx:1.28-alpine
EOF
kubectl -n ws-sched rollout status deploy trainer
kubectl -n ws-sched get pods -o wide
`,
});

// =============================================================================== ResourceQuota + LimitRange
const QUOTA = { 'requests.cpu': '500m', 'requests.memory': '512Mi', 'limits.cpu': '1', 'limits.memory': '1Gi', pods: '4' };
task({
  id: 'quota-limits', domain: 'workloads', title: 'ResourceQuota i LimitRange', host: 'cp', minutes: 7,
  namespaces: ['ws-quota'],
  setup(c) {
    const ns = 'ws-quota';
    c.apply({ apiVersion: 'v1', kind: 'ResourceQuota', metadata: { name: 'compute-quota', namespace: ns }, spec: { hard: QUOTA } });
    c.apply(deployment('reporting', ns, NGINX, { replicas: 3 }));
  },
  check(c, g) {
    const ns = 'ws-quota';
    const q = c.get('resourcequota', 'compute-quota', ns);
    const hard = jp(q, 'spec.hard', {}) || {};
    g.ok('ResourceQuota compute-quota bez zmian', deq(Object.keys(hard).sort(), Object.keys(QUOTA).sort()) && Object.entries(QUOTA).every(([k, v]) => qeq(hard[k], v)), hard);
    const lr = c.get('limitrange', 'container-defaults', ns);
    const item = (jp(lr, 'spec.limits', []) || []).find((i) => i.type === 'Container') || null;
    g.ok('LimitRange container-defaults (type Container) istnieje', item);
    g.ok('defaultRequest: cpu 100m, memory 64Mi', qeq(jp(item, 'defaultRequest.cpu'), '100m') && qeq(jp(item, 'defaultRequest.memory'), '64Mi'), item);
    g.ok('default (limit): cpu 200m, memory 128Mi', qeq(jp(item, 'default.cpu'), '200m') && qeq(jp(item, 'default.memory'), '128Mi'), item);
    g.ok('max: cpu 300m', qeq(jp(item, 'max.cpu'), '300m'), item);
    g.ok('deployment reporting: 3 gotowe repliki', readyReplicas(c.get('deployment', 'reporting', ns)) === 3);
  },
  text: `
Pods of deployment reporting in namespace ws-quota are not being created.
Do NOT modify the ResourceQuota compute-quota.

1. Create a LimitRange named container-defaults in namespace ws-quota that for
   every container sets:
     default request:  cpu 100m, memory 64Mi
     default limit:    cpu 200m, memory 128Mi
     maximum:          cpu 300m
2. Make sure deployment reporting runs 3 ready replicas.
`,
  solution: `
kubectl -n ws-quota describe resourcequota compute-quota
kubectl -n ws-quota get events --sort-by=.lastTimestamp | tail     # "must specify limits.cpu..."

cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: LimitRange
metadata:
  name: container-defaults
  namespace: ws-quota
spec:
  limits:
  - type: Container
    defaultRequest: {cpu: 100m, memory: 64Mi}
    default:        {cpu: 200m, memory: 128Mi}
    max:            {cpu: 300m}
EOF
# ReplicaSet ponawia tworzenie podów z opóźnieniem - przyspiesz:
kubectl -n ws-quota rollout restart deployment reporting
kubectl -n ws-quota get pods
`,
  test: `
kubectl -n ws-quota describe resourcequota compute-quota
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: LimitRange
metadata:
  name: container-defaults
  namespace: ws-quota
spec:
  limits:
  - type: Container
    defaultRequest: {cpu: 100m, memory: 64Mi}
    default:        {cpu: 200m, memory: 128Mi}
    max:            {cpu: 300m}
EOF
kubectl -n ws-quota rollout restart deployment reporting
kubectl -n ws-quota rollout status deployment reporting --timeout=120s
kubectl -n ws-quota get pods
`,
});

// =============================================================================== sidecar
task({
  id: 'sidecar-logs', domain: 'workloads', title: 'Natywny kontener sidecar do strumieniowania logów', host: 'cp', minutes: 7,
  namespaces: ['ws-sidecar'],
  check(c, g) {
    const ns = 'ws-sidecar';
    const p = c.get('pod', 'log-app', ns);
    g.ok('pod log-app istnieje', p);
    const app = cont(p, 'app');
    const sc = cont(p, 'log-shipper', true);
    g.ok('kontener app (busybox:1.36)', app && app.image === BUSYBOX);
    g.ok('log-shipper to natywny sidecar (initContainer z restartPolicy: Always)', sc && sc.restartPolicy === 'Always');
    const vols = Object.fromEntries((podSpec(p).volumes || []).map((v) => [v.name, v]));
    const shared = Object.entries(vols).filter(([, v]) => 'emptyDir' in v).map(([n]) => n);
    const mountsOk = shared.some((n) => (app.volumeMounts || []).some((m) => m.name === n && m.mountPath === '/var/log/app') && (sc.volumeMounts || []).some((m) => m.name === n && m.mountPath === '/var/log/app'));
    g.ok('wspólny wolumen emptyDir zamontowany w /var/log/app w obu kontenerach', mountsOk);
    g.ok('pod Running i Ready', p && podReady(p));
    const r = c.logs('log-app', ns, 'log-shipper', 20);
    g.ok("'kubectl logs log-app -c log-shipper' pokazuje logi aplikacji (tick)", r.out.includes('tick'), r.text.slice(0, 200));
  },
  text: `
In namespace ws-sidecar create a Pod named log-app:

  - container app (image busybox:1.36) runs:
      sh -c 'i=0; while true; do echo "$(date) tick $i" >> /var/log/app/app.log; i=$((i+1)); sleep 2; done'
  - a native sidecar container log-shipper (image busybox:1.36) runs:
      tail -n+1 -F /var/log/app/app.log
    It must be defined as a sidecar (an init container that keeps running
    alongside the main container).
  - both containers share an emptyDir volume mounted at /var/log/app

The application log must be visible with: kubectl logs log-app -c log-shipper
`,
  solution: `
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: log-app
  namespace: ws-sidecar
spec:
  initContainers:
  - name: log-shipper
    image: busybox:1.36
    restartPolicy: Always            # <- to robi z init containera natywny sidecar
    command: ["sh", "-c", "tail -n+1 -F /var/log/app/app.log"]
    volumeMounts:
    - {name: logs, mountPath: /var/log/app}
  containers:
  - name: app
    image: busybox:1.36
    command: ["sh", "-c", "i=0; while true; do echo \\"$(date) tick $i\\" >> /var/log/app/app.log; i=$((i+1)); sleep 2; done"]
    volumeMounts:
    - {name: logs, mountPath: /var/log/app}
  volumes:
  - name: logs
    emptyDir: {}
EOF
kubectl -n ws-sidecar logs log-app -c log-shipper
`,
});

// =============================================================================== DaemonSet
task({
  id: 'daemonset', domain: 'workloads', title: 'DaemonSet na wszystkich węzłach (z control plane)', host: 'cp', minutes: 6,
  conflicts: ['taint-w2'], namespaces: ['ws-ds'],
  check(c, g) {
    const ns = 'ws-ds';
    const ds = c.get('daemonset', 'node-exporter-lite', ns);
    const nNodes = Object.keys(c.nodes()).length;
    g.ok('DaemonSet node-exporter-lite istnieje', ds);
    g.ok('label app=node-exporter-lite na podach', jp(ds, 'spec.template.metadata.labels.app') === 'node-exporter-lite');
    const tols = jp(ds, 'spec.template.spec.tolerations', []) || [];
    g.ok('toleruje taint control-plane', tols.some((t) => t.key === 'node-role.kubernetes.io/control-plane' || (t.operator === 'Exists' && !t.key)));
    g.ok(`pody działają na wszystkich ${nNodes} węzłach`, jp(ds, 'status.desiredNumberScheduled') === nNodes && jp(ds, 'status.numberReady') === nNodes, `desired=${jp(ds, 'status.desiredNumberScheduled')} ready=${jp(ds, 'status.numberReady')}`);
    const ct = cont(ds);
    g.ok('requests: cpu 10m, memory 16Mi', qeq(jp(ct, 'resources.requests.cpu'), '10m') && qeq(jp(ct, 'resources.requests.memory'), '16Mi'));
    const vols = Object.fromEntries((podSpec(ds).volumes || []).map((v) => [v.name, v]));
    g.ok('hostPath /var/log zamontowany read-only w /host/var/log', (ct.volumeMounts || []).some((m) => jp(vols[m.name], 'hostPath.path') === '/var/log' && m.mountPath === '/host/var/log' && m.readOnly === true));
  },
  text: `
In namespace ws-ds create a DaemonSet named node-exporter-lite:
  - image busybox:1.36, command: sleep infinity
  - pod label app=node-exporter-lite
  - resource requests: cpu 10m, memory 16Mi
  - the host directory /var/log mounted read-only at /host/var/log
  - a pod must run on EVERY node of the cluster, including the control plane
`,
  solution: `
# szkielet: kubectl -n ws-ds create deployment node-exporter-lite --image=busybox:1.36 --dry-run=client -o yaml > ds.yaml
# zmień kind na DaemonSet, usuń replicas/strategy/status, dodaj tolerations i wolumen:
cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter-lite
  namespace: ws-ds
spec:
  selector:
    matchLabels: {app: node-exporter-lite}
  template:
    metadata:
      labels: {app: node-exporter-lite}
    spec:
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      containers:
      - name: agent
        image: busybox:1.36
        command: ["sleep", "infinity"]
        resources:
          requests: {cpu: 10m, memory: 16Mi}
        volumeMounts:
        - {name: varlog, mountPath: /host/var/log, readOnly: true}
      volumes:
      - name: varlog
        hostPath: {path: /var/log}
EOF
kubectl -n ws-ds get ds,pods -o wide
`,
});

// =============================================================================== PriorityClass
task({
  id: 'priorityclass', domain: 'workloads', title: 'PriorityClass dla krytycznej aplikacji', host: 'cp', minutes: 4,
  namespaces: ['ws-prio'],
  setup(c) { c.delete('priorityclass', 'business-critical'); c.apply(deployment('billing', 'ws-prio', NGINX, { replicas: 2 })); },
  check(c, g) {
    const ns = 'ws-prio';
    const pc = c.get('priorityclass', 'business-critical');
    g.ok('PriorityClass business-critical: value 1000000', jp(pc, 'value') === 1000000);
    g.ok('globalDefault: false', pc && !pc.globalDefault);
    g.ok('preemptionPolicy: PreemptLowerPriority', pc && jp(pc, 'preemptionPolicy', 'PreemptLowerPriority') === 'PreemptLowerPriority');
    const d = c.get('deployment', 'billing', ns);
    g.ok('deployment billing używa priorityClassName business-critical', jp(d, 'spec.template.spec.priorityClassName') === 'business-critical');
    const pods = c.ready_pods(ns, 'app=billing');
    g.ok('2 gotowe pody z priorytetem 1000000', pods.length === 2 && pods.every((p) => jp(p, 'spec.priority') === 1000000));
  },
  cleanup(c) { c.delete('priorityclass', 'business-critical'); },
  text: `
1. Create a PriorityClass named business-critical with value 1000000 that is
   not the global default and preempts lower-priority pods.
2. Update the existing deployment billing in namespace ws-prio so that its pods
   use this PriorityClass. Both replicas must be running.
`,
  solution: `
kubectl create priorityclass business-critical --value=1000000 \\
  --global-default=false --preemption-policy=PreemptLowerPriority --description="billing"
kubectl -n ws-prio patch deployment billing -p '{"spec":{"template":{"spec":{"priorityClassName":"business-critical"}}}}'
kubectl -n ws-prio rollout status deployment billing
kubectl -n ws-prio get pods -o custom-columns=NAME:.metadata.name,PRIO:.spec.priority
`,
});

// =============================================================================== probes
const portIs80 = (port, ct) => String(port) === '80' || (ct.ports || []).some((p) => p.name === port && p.containerPort === 80);
task({
  id: 'probes', domain: 'workloads', title: 'Readiness i liveness probes', host: 'cp', minutes: 5,
  namespaces: ['ws-probes'],
  setup(c) { c.apply(deployment('catalog', 'ws-probes', NGINX, { replicas: 2, ports: [80] })); },
  check(c, g) {
    const ns = 'ws-probes';
    const d = c.get('deployment', 'catalog', ns);
    const ct = cont(d);
    const rp = ct.readinessProbe || {}, lp = ct.livenessProbe || {};
    g.ok('readinessProbe: httpGet / na porcie 80', jp(rp, 'httpGet.path') === '/' && portIs80(jp(rp, 'httpGet.port'), ct));
    g.ok('readinessProbe: initialDelaySeconds 3, periodSeconds 5', rp.initialDelaySeconds === 3 && rp.periodSeconds === 5);
    g.ok('livenessProbe: tcpSocket port 80', portIs80(jp(lp, 'tcpSocket.port'), ct));
    g.ok('livenessProbe: periodSeconds 10, failureThreshold 3', Object.keys(lp).length && lp.periodSeconds === 10 && (lp.failureThreshold ?? 3) === 3);
    g.ok('rollout zakończony: 2 zaktualizowane i gotowe repliki', readyReplicas(d) === 2 && jp(d, 'status.updatedReplicas') === 2);
  },
  text: `
Make deployment catalog in namespace ws-probes self-healing:

1. Add a readiness probe: HTTP GET on path / port 80,
   initialDelaySeconds 3, periodSeconds 5.
2. Add a liveness probe: TCP socket on port 80, periodSeconds 10, failureThreshold 3.

All replicas must be ready after the change.
`,
  solution: `
kubectl -n ws-probes edit deployment catalog
# w kontenerze:
#        readinessProbe:
#          httpGet: {path: /, port: 80}
#          initialDelaySeconds: 3
#          periodSeconds: 5
#        livenessProbe:
#          tcpSocket: {port: 80}
#          periodSeconds: 10
#          failureThreshold: 3
kubectl -n ws-probes rollout status deployment catalog
`,
  test: `
kubectl -n ws-probes patch deployment catalog -p '{"spec":{"template":{"spec":{"containers":[{"name":"catalog","readinessProbe":{"httpGet":{"path":"/","port":80},"initialDelaySeconds":3,"periodSeconds":5},"livenessProbe":{"tcpSocket":{"port":80},"periodSeconds":10,"failureThreshold":3}}]}}}}'
kubectl -n ws-probes rollout status deployment catalog
`,
});

// =============================================================================== CronJob
task({
  id: 'cronjob', domain: 'workloads', title: 'CronJob i ręczne uruchomienie Joba', host: 'cp', minutes: 6,
  namespaces: ['ws-batch'],
  check(c, g) {
    const ns = 'ws-batch';
    const cj = c.get('cronjob', 'db-cleanup', ns);
    g.ok('CronJob db-cleanup istnieje', cj);
    g.ok('schedule "*/15 * * * *"', jp(cj, 'spec.schedule') === '*/15 * * * *');
    g.ok('concurrencyPolicy Forbid', jp(cj, 'spec.concurrencyPolicy') === 'Forbid');
    g.ok('successfulJobsHistoryLimit 2, failedJobsHistoryLimit 1', jp(cj, 'spec.successfulJobsHistoryLimit') === 2 && jp(cj, 'spec.failedJobsHistoryLimit') === 1);
    g.ok('job: activeDeadlineSeconds 60, backoffLimit 2', jp(cj, 'spec.jobTemplate.spec.activeDeadlineSeconds') === 60 && jp(cj, 'spec.jobTemplate.spec.backoffLimit') === 2);
    g.ok('restartPolicy Never', podSpec(cj).restartPolicy === 'Never');
    const ct = cont(cj);
    const cmd = [...(ct.command || []), ...(ct.args || [])].join(' ');
    g.ok("kontener busybox:1.36 wypisuje 'cleanup done'", ct.image === BUSYBOX && cmd.includes('cleanup done'));
    const j = c.get('job', 'db-cleanup-manual', ns);
    g.ok('Job db-cleanup-manual utworzony z CronJoba', j && (jp(j, 'metadata.ownerReferences', []) || []).some((o) => o.kind === 'CronJob' && o.name === 'db-cleanup'));
    g.ok('Job db-cleanup-manual zakończony sukcesem', (jp(j, 'status.succeeded', 0) || 0) >= 1);
    g.ok("logi joba zawierają 'cleanup done'", c.logs('job/db-cleanup-manual', ns).out.includes('cleanup done'));
  },
  text: `
In namespace ws-batch:

1. Create a CronJob named db-cleanup that:
     - runs every 15 minutes
     - uses image busybox:1.36 and runs: sh -c 'echo cleanup done'
     - never runs two jobs at the same time
     - keeps 2 successful and 1 failed job in history
     - each job is terminated after 60 seconds and retried at most 2 times
     - pods never restart failed containers
2. Trigger it manually now by creating a Job named db-cleanup-manual from the CronJob.
`,
  solution: `
kubectl -n ws-batch create cronjob db-cleanup --image=busybox:1.36 --schedule="*/15 * * * *" \\
  --dry-run=client -o yaml -- sh -c 'echo cleanup done' > cj.yaml
vim cj.yaml
# spec:
#   concurrencyPolicy: Forbid
#   successfulJobsHistoryLimit: 2
#   failedJobsHistoryLimit: 1
#   jobTemplate:
#     spec:
#       activeDeadlineSeconds: 60
#       backoffLimit: 2
#       template:
#         spec:
#           restartPolicy: Never
kubectl apply -f cj.yaml
kubectl -n ws-batch create job db-cleanup-manual --from=cronjob/db-cleanup
kubectl -n ws-batch logs job/db-cleanup-manual
`,
  test: `
kubectl -n ws-batch create cronjob db-cleanup --image=busybox:1.36 --schedule="*/15 * * * *" --dry-run=client -o yaml -- sh -c 'echo cleanup done' > cj.yaml
yq -i '.spec.successfulJobsHistoryLimit = 2' cj.yaml
yq -i '.spec.failedJobsHistoryLimit = 1' cj.yaml
yq -i '.spec.concurrencyPolicy = "Forbid"' cj.yaml
yq -i '.spec.jobTemplate.spec.activeDeadlineSeconds = 60' cj.yaml
yq -i '.spec.jobTemplate.spec.backoffLimit = 2' cj.yaml
yq -i '.spec.jobTemplate.spec.template.spec.restartPolicy = "Never"' cj.yaml
kubectl apply -f cj.yaml
kubectl -n ws-batch create job db-cleanup-manual --from=cronjob/db-cleanup
kubectl -n ws-batch wait --for=condition=Complete job/db-cleanup-manual --timeout=60s
kubectl -n ws-batch logs job/db-cleanup-manual
`,
});
