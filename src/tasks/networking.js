// Domena: Services & Networking (20%).
import { task, NGINX, configmap, deployment, echoApp, TaskUnavailable } from './registry.js';
import { jp, condition, cont, deq } from './ctx.js';

const WGET = 'wget -qO- -T 3 ';

function gatewayAvailable(c) {
  const gc = c.get('gatewayclass', 'nginx');
  if (!gc || condition(gc, 'Accepted') !== 'True') throw new TaskUnavailable("GatewayClass 'nginx' (NGINX Gateway Fabric) nie jest dostępna");
}
function ingressAvailable(c) { if (!c.exists('ingressclass', 'nginx')) throw new TaskUnavailable("IngressClass 'nginx' nie istnieje"); }

function gwNodePort(c, ns, gw) {
  for (const s of c.list('services', ns)) {
    if (s.metadata.name.startsWith(gw) && ['NodePort', 'LoadBalancer'].includes(jp(s, 'spec.type'))) {
      for (const p of jp(s, 'spec.ports', []) || []) if (p.port === 80 && p.nodePort) return p.nodePort;
    }
  }
  return null;
}

// =============================================================================== Service NodePort
task({
  id: 'svc-nodeport', domain: 'networking', title: 'Service ClusterIP i NodePort z nazwanym portem', host: 'cp', minutes: 6,
  namespaces: ['net-svc'],
  setup(c) { c.apply(deployment('frontend', 'net-svc', NGINX, { replicas: 2 })); },
  check(c, g) {
    const ns = 'net-svc';
    const d = c.get('deployment', 'frontend', ns);
    const ports = cont(d).ports || [];
    g.ok('kontener deklaruje port 80 o nazwie http', ports.some((p) => p.containerPort === 80 && p.name === 'http'));
    const s = c.get('service', 'frontend-np', ns);
    const p = (jp(s, 'spec.ports', []) || [{}])[0] || {};
    g.ok('frontend-np: typ NodePort', jp(s, 'spec.type') === 'NodePort');
    g.ok('frontend-np: port 8080 -> targetPort http (nazwany)', p.port === 8080 && p.targetPort === 'http');
    g.ok('frontend-np: nodePort 30080', p.nodePort === 30080);
    g.ok('frontend-np: 2 gotowe endpointy', c.endpoints_ready('frontend-np', ns) === 2);
    const [ok, st, body] = c.http_retry(`http://${c.cfg.ip(c.cfg.w1)}:30080/`, 'nginx', null, null, 3);
    g.ok(`http://${c.cfg.ip(c.cfg.w1)}:30080/ odpowiada stroną nginx`, ok, `HTTP ${st}: ${body.slice(0, 150)}`);
    const s2 = c.get('service', 'frontend-internal', ns);
    const p2 = (jp(s2, 'spec.ports', []) || [{}])[0] || {};
    g.ok('frontend-internal: ClusterIP, port 80', jp(s2, 'spec.type') === 'ClusterIP' && p2.port === 80);
    const ip = jp(s2, 'spec.clusterIP');
    const res = ip ? c.probe(ns, { app: 'client' }, [[`${WGET}http://${ip}/`, true]]) : [[false, null]];
    g.ok('frontend-internal osiągalny z wnętrza klastra', res[0][0]);
  },
  text: `
In namespace net-svc a deployment frontend (nginx) is running.

1. Update the deployment so its container declares port 80 with the name http.
2. Create a Service frontend-np of type NodePort: port 8080, targetPort = the
   named port http, nodePort 30080.
3. Create a Service frontend-internal of type ClusterIP on port 80 for the same pods.

The application must be reachable from outside on http://<<w1_ip>>:30080/
`,
  solution: `
kubectl -n net-svc patch deployment frontend --type=json -p \\
 '[{"op":"add","path":"/spec/template/spec/containers/0/ports","value":[{"name":"http","containerPort":80}]}]'

cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: frontend-np
  namespace: net-svc
spec:
  type: NodePort
  selector: {app: frontend}
  ports:
  - port: 8080
    targetPort: http
    nodePort: 30080
EOF
kubectl -n net-svc expose deployment frontend --name=frontend-internal --port=80 --target-port=80
curl -s http://<<w1_ip>>:30080/ | head -5
`,
});

// =============================================================================== NetworkPolicy ingress
task({
  id: 'netpol-ingress', domain: 'networking', title: 'NetworkPolicy: ograniczenie ruchu przychodzącego', host: 'cp', minutes: 7,
  namespaces: ['net-pol', 'net-pol-other'],
  setup(c) {
    const objs = [];
    for (const app of ['db', 'backend', 'frontend']) objs.push(...echoApp(app, 'net-pol', `app=${app}`, { svcPort: 80 }));
    c.apply(objs);
  },
  check(c, g) {
    const ns = 'net-pol';
    const np = c.get('networkpolicy', 'db-ingress', ns);
    g.ok('NetworkPolicy db-ingress istnieje', np);
    g.ok('dotyczy tylko podów app=db', deq(jp(np, 'spec.podSelector.matchLabels'), { app: 'db' }));
    g.ok('policyTypes zawiera Ingress', np && (jp(np, 'spec.policyTypes', []) || ['Ingress']).includes('Ingress'));
    const rules = jp(np, 'spec.ingress', []) || [];
    g.ok('ruch dozwolony tylko na TCP 80', rules.length && rules.every((r) => (r.ports || []).length && r.ports.every((p) => String(p.port) === '80' && (p.protocol || 'TCP') === 'TCP')));
    const db = c.svc_ip('db', ns), be = c.svc_ip('backend', ns);
    const r1 = c.probe(ns, { app: 'backend' }, [[`${WGET}http://${db}/`, true]]);
    g.ok('backend -> db: DOZWOLONE', r1[0][0], r1[0][1] && r1[0][1].text);
    const r2 = c.probe(ns, { app: 'frontend' }, [[`${WGET}http://${db}/`, false], [`${WGET}http://${be}/`, true]]);
    g.ok('frontend -> db: ZABLOKOWANE', r2[0][0]);
    g.ok('frontend -> backend: nadal działa (polityka nie wpływa na inne pody)', r2[1][0]);
    const r3 = c.probe('net-pol-other', { app: 'backend' }, [[`${WGET}http://${db}/`, false]]);
    g.ok('pod app=backend z INNEGO namespace -> db: ZABLOKOWANE', r3[0][0]);
  },
  text: `
In namespace net-pol run three applications: db, backend and frontend
(pods labeled app=db, app=backend, app=frontend; each listens on TCP 80).

Create a NetworkPolicy named db-ingress in namespace net-pol so that:
  - pods with label app=db accept incoming traffic ONLY from pods with label
    app=backend in the same namespace, and only on TCP port 80
  - all other incoming traffic to db pods is denied
  - traffic to and from other pods is not affected
`,
  solution: `
cat <<'EOF' | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-ingress
  namespace: net-pol
spec:
  podSelector:
    matchLabels:
      app: db
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: backend
    ports:
    - protocol: TCP
      port: 80
EOF

# test:
kubectl -n net-pol run t --rm -it --image=busybox:1.36 --labels=app=backend -- wget -qO- -T2 db
kubectl -n net-pol run t --rm -it --image=busybox:1.36 --labels=app=frontend -- wget -qO- -T2 db   # timeout

# Pułapka: samo 'podSelector' w 'from' oznacza pody z TEGO SAMEGO namespace.
`,
});

// =============================================================================== NetworkPolicy egress
task({
  id: 'netpol-egress', domain: 'networking', title: 'NetworkPolicy: default-deny egress z wyjątkami', host: 'cp', minutes: 9,
  namespaces: ['net-egress', 'net-api', 'net-misc'],
  setup(c) {
    c.apply(echoApp('api', 'net-api', 'api-ok', { svcPort: 80 }));
    c.apply(echoApp('other', 'net-misc', 'other-ok', { svcPort: 80 }));
  },
  check(c, g) {
    const ns = 'net-egress';
    const np = c.get('networkpolicy', 'restrict-egress', ns);
    g.ok('NetworkPolicy restrict-egress istnieje', np);
    g.ok('obejmuje wszystkie pody w namespace (pusty podSelector)', np && !Object.keys(jp(np, 'spec.podSelector.matchLabels', {}) || {}).length && !(jp(np, 'spec.podSelector.matchExpressions', []) || []).length);
    g.ok('policyTypes zawiera Egress', (jp(np, 'spec.policyTypes', []) || []).includes('Egress'));
    const apiIp = c.svc_ip('api', 'net-api'), otherIp = c.svc_ip('other', 'net-misc');
    const res = c.probe(ns, { app: 'client' }, [
      ['nslookup api.net-api.svc.cluster.local.', true],
      [`${WGET}http://api.net-api.svc.cluster.local/`, true],
      [`${WGET}http://${otherIp}/`, false],
      [`${WGET}http://${apiIp}/`, true],
    ]);
    g.ok('DNS działa (UDP/TCP 53 do kube-dns)', res[0][0], res[0][1] && res[0][1].text);
    g.ok('ruch do api.net-api na porcie 80: DOZWOLONY', res[1][0], res[1][1] && res[1][1].text);
    g.ok('ruch do innych namespace (net-misc): ZABLOKOWANY', res[2][0]);
    g.ok('ruch do api po adresie ClusterIP: DOZWOLONY', res[3][0]);
    const rules = jp(np, 'spec.egress', []) || [];
    g.ok('reguła DNS ogranicza się do portu 53', rules.some((r) => (r.ports || []).some((p) => String(p.port) === '53')));
  },
  text: `
Create a NetworkPolicy named restrict-egress in namespace net-egress that applies
to ALL pods in that namespace and denies all outgoing traffic except:

  - DNS: UDP and TCP port 53 to the CoreDNS pods (label k8s-app=kube-dns)
    in namespace kube-system
  - TCP port 80 to pods with label app=api in namespace net-api

Use the label kubernetes.io/metadata.name to select namespaces.
`,
  solution: `
cat <<'EOF' | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: restrict-egress
  namespace: net-egress
spec:
  podSelector: {}
  policyTypes:
  - Egress
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - {protocol: UDP, port: 53}
    - {protocol: TCP, port: 53}
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: net-api
      podSelector:
        matchLabels:
          app: api
    ports:
    - {protocol: TCP, port: 80}
EOF

# Pułapka: namespaceSelector i podSelector w JEDNYM elemencie listy 'to' = AND.
# Dwa osobne elementy (dwa myślniki) = OR - to byłby błąd.
`,
});

// =============================================================================== Gateway API: HTTPRoute
const routeBackends = (rule) => new Set((rule.backendRefs || []).map((b) => `${b.name}:${b.port}`));

task({
  id: 'gateway-httproute', domain: 'networking', title: 'Gateway API: Gateway i HTTPRoute z routingiem po ścieżce', host: 'cp', minutes: 9,
  requires: ['gateway'], namespaces: ['net-gw'], available: gatewayAvailable,
  setup(c) {
    const ns = 'net-gw';
    const objs = [...echoApp('web', ns, 'backend=web', { svcPort: 80 }), ...echoApp('api', ns, 'backend=api')];
    objs.push({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'api', namespace: ns }, spec: { selector: { app: 'api' }, ports: [{ port: 8080, targetPort: 80 }] } });
    c.apply(objs);
  },
  check(c, g) {
    const ns = 'net-gw';
    const gw = c.get('gateway', 'shop-gateway', ns);
    g.ok('Gateway shop-gateway istnieje (gatewayClassName nginx)', jp(gw, 'spec.gatewayClassName') === 'nginx');
    const ls = jp(gw, 'spec.listeners', []) || [];
    g.ok('listener http: port 80, HTTP, hostname shop.cka.local', ls.some((x) => x.name === 'http' && x.port === 80 && x.protocol === 'HTTP' && x.hostname === 'shop.cka.local'));
    g.ok('Gateway Programmed=True', condition(gw, 'Programmed') === 'True');
    const rt = c.get('httproute', 'shop-route', ns);
    g.ok('HTTPRoute shop-route podpięty do shop-gateway', (jp(rt, 'spec.parentRefs', []) || []).some((p) => p.name === 'shop-gateway'));
    const rules = jp(rt, 'spec.rules', []) || [];
    const has = (path, svc, port) => rules.some((r) => (r.matches || []).some((m) => jp(m, 'path.value') === path && jp(m, 'path.type', 'PathPrefix') === 'PathPrefix') && routeBackends(r).size === 1 && routeBackends(r).has(`${svc}:${port}`));
    g.ok('reguła PathPrefix /api -> api:8080', has('/api', 'api', 8080));
    g.ok('reguła PathPrefix / -> web:80', has('/', 'web', 80));
    const parents = jp(rt, 'status.parents', []) || [];
    g.ok('HTTPRoute zaakceptowany (Accepted, ResolvedRefs)', parents.some((p) => (p.conditions || []).some((x) => x.type === 'Accepted' && x.status === 'True') && (p.conditions || []).some((x) => x.type === 'ResolvedRefs' && x.status === 'True')));
    const port = gwNodePort(c, ns, 'shop-gateway');
    const base = port ? `http://${c.cfg.ip(c.cfg.w1)}:${port}` : null;
    const ok1 = base && c.http_retry(`${base}/api/orders`, 'backend=api', 'shop.cka.local')[0];
    const ok2 = base && c.http_retry(`${base}/`, 'backend=web', 'shop.cka.local')[0];
    g.ok('ruch: shop.cka.local/api/... trafia do api', ok1, `NodePort Gateway: ${port}`);
    g.ok('ruch: shop.cka.local/ trafia do web', ok2);
  },
  text: `
NGINX Gateway Fabric is installed and provides the GatewayClass nginx.
In namespace net-gw there are Services web (port 80) and api (port 8080).

1. Create a Gateway named shop-gateway in namespace net-gw using GatewayClass nginx
   with one listener named http: protocol HTTP, port 80, hostname shop.cka.local.
2. Create an HTTPRoute named shop-route attached to this Gateway that routes:
     - requests with path prefix /api  -> Service api, port 8080
     - all other requests (prefix /)   -> Service web, port 80

Test: the data plane Service created for the Gateway is exposed as a NodePort.
`,
  solution: `
cat <<'EOF' | kubectl apply -f -
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: shop-gateway
  namespace: net-gw
spec:
  gatewayClassName: nginx
  listeners:
  - name: http
    protocol: HTTP
    port: 80
    hostname: shop.cka.local
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shop-route
  namespace: net-gw
spec:
  parentRefs:
  - name: shop-gateway
  hostnames: ["shop.cka.local"]
  rules:
  - matches:
    - path: {type: PathPrefix, value: /api}
    backendRefs:
    - {name: api, port: 8080}
  - matches:
    - path: {type: PathPrefix, value: /}
    backendRefs:
    - {name: web, port: 80}
EOF
kubectl -n net-gw get gateway,httproute
kubectl -n net-gw get svc                       # serwis shop-gateway-nginx: NodePort
NP=$(kubectl -n net-gw get svc shop-gateway-nginx -o jsonpath='{.spec.ports[0].nodePort}')
curl -H 'Host: shop.cka.local' http://<<w1_ip>>:$NP/api/x
`,
});

// =============================================================================== Gateway API: canary
task({
  id: 'gateway-canary', domain: 'networking', title: 'Gateway API: canary (wagi) i routing po nagłówku', host: 'cp', minutes: 8,
  requires: ['gateway'], namespaces: ['net-canary'], available: gatewayAvailable,
  setup(c) {
    const ns = 'net-canary';
    const objs = [...echoApp('app-v1', ns, 'version=v1', { svcPort: 80 }), ...echoApp('app-v2', ns, 'version=v2', { svcPort: 80 })];
    objs.push({ apiVersion: 'gateway.networking.k8s.io/v1', kind: 'Gateway', metadata: { name: 'canary-gw', namespace: ns }, spec: { gatewayClassName: 'nginx', listeners: [{ name: 'http', protocol: 'HTTP', port: 80, hostname: 'canary.cka.local' }] } });
    c.apply(objs);
  },
  check(c, g) {
    const ns = 'net-canary';
    const rt = c.get('httproute', 'app-split', ns);
    g.ok('HTTPRoute app-split podpięty do canary-gw', (jp(rt, 'spec.parentRefs', []) || []).some((p) => p.name === 'canary-gw'));
    const rules = jp(rt, 'spec.rules', []) || [];
    const hdr = rules.filter((r) => (r.matches || []).some((m) => (m.headers || []).some((h) => String(h.name || '').toLowerCase() === 'x-canary' && h.value === 'always')));
    g.ok('reguła z nagłówkiem X-Canary: always kieruje tylko do app-v2', hdr.length && hdr.every((r) => { const n = new Set((r.backendRefs || []).map((b) => b.name)); return n.size === 1 && n.has('app-v2'); }));
    const split = rules.filter((r) => !hdr.includes(r) && (r.backendRefs || []).length === 2);
    let okW = false;
    for (const r of split) {
      const w = Object.fromEntries(r.backendRefs.map((b) => [b.name, b.weight ?? 1]));
      if (Object.keys(w).length === 2 && 'app-v1' in w && 'app-v2' in w && w['app-v2'] > 0 && w['app-v1'] * 20 === w['app-v2'] * 80) okW = true;
    }
    g.ok('podział wag 80% app-v1 / 20% app-v2', okW);
    const parents = jp(rt, 'status.parents', []) || [];
    g.ok('HTTPRoute zaakceptowany przez Gateway', parents.some((p) => (p.conditions || []).some((x) => x.type === 'Accepted' && x.status === 'True')));
    const port = gwNodePort(c, ns, 'canary-gw');
    let v1 = 0, v2 = 0, hv2 = 0;
    if (port) {
      const url = `http://${c.cfg.ip(c.cfg.w1)}:${port}/`;
      c.http_retry(url, 'version=', 'canary.cka.local');
      for (let i = 0; i < 40; i++) { const body = c.http(url, 'canary.cka.local')[1]; v1 += body.includes('version=v1'); v2 += body.includes('version=v2'); }
      for (let i = 0; i < 8; i++) hv2 += c.http(url, 'canary.cka.local', { 'X-Canary': 'always' })[1].includes('version=v2');
    }
    g.ok('ruch rozkłada się na obie wersje (v1 > v2 > 0)', v1 > v2 && v2 > 0, `v1=${v1} v2=${v2} z 40, NodePort=${port}`);
    g.ok('z nagłówkiem X-Canary: always zawsze v2', hv2 === 8, `${hv2}/8`);
  },
  text: `
In namespace net-canary there is a Gateway canary-gw (listener http, port 80,
hostname canary.cka.local) and two Services app-v1 and app-v2 (port 80).

Create an HTTPRoute named app-split attached to canary-gw so that:
  - requests with header X-Canary: always are ALWAYS sent to app-v2
  - all other requests are split: 80% to app-v1 and 20% to app-v2
`,
  solution: `
cat <<'EOF' | kubectl apply -f -
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: app-split
  namespace: net-canary
spec:
  parentRefs:
  - name: canary-gw
  hostnames: ["canary.cka.local"]
  rules:
  - matches:
    - headers:
      - name: X-Canary
        value: always
    backendRefs:
    - {name: app-v2, port: 80}
  - backendRefs:
    - {name: app-v1, port: 80, weight: 80}
    - {name: app-v2, port: 80, weight: 20}
EOF
NP=$(kubectl -n net-canary get svc -o jsonpath='{.items[?(@.spec.type=="NodePort")].spec.ports[0].nodePort}')
for i in $(seq 10); do curl -s -H 'Host: canary.cka.local' http://<<w1_ip>>:$NP/; done
`,
});

// =============================================================================== Ingress
task({
  id: 'ingress-basic', domain: 'networking', title: 'Ingress z routingiem po ścieżce', host: 'cp', minutes: 5,
  requires: ['ingress'], namespaces: ['net-ing'], available: ingressAvailable,
  setup(c) { c.apply([...echoApp('cart', 'net-ing', 'service=cart', { svcPort: 80 }), ...echoApp('catalog', 'net-ing', 'service=catalog', { svcPort: 80 })]); },
  check(c, g) {
    const ns = 'net-ing';
    const ing = c.get('ingress', 'store', ns);
    g.ok('Ingress store z ingressClassName nginx', jp(ing, 'spec.ingressClassName') === 'nginx');
    const rules = (jp(ing, 'spec.rules', []) || []).filter((r) => r.host === 'store.cka.local');
    const paths = rules.flatMap((r) => jp(r, 'http.paths', []) || []);
    const has = (path, svc) => paths.some((p) => p.path === path && p.pathType === 'Prefix' && jp(p, 'backend.service.name') === svc && jp(p, 'backend.service.port.number') === 80);
    g.ok('host store.cka.local: /cart (Prefix) -> cart:80', has('/cart', 'cart'));
    g.ok('host store.cka.local: /catalog (Prefix) -> catalog:80', has('/catalog', 'catalog'));
    const base = `http://${c.cfg.ip(c.cfg.w1)}:31080`;
    g.ok('ruch: store.cka.local/cart -> cart', c.http_retry(`${base}/cart`, 'service=cart', 'store.cka.local')[0]);
    g.ok('ruch: store.cka.local/catalog/items -> catalog', c.http_retry(`${base}/catalog/items`, 'service=catalog', 'store.cka.local')[0]);
  },
  text: `
In namespace net-ing there are Services cart and catalog (both port 80).

Create an Ingress named store using IngressClass nginx for host store.cka.local:
  - path /cart     (type Prefix) -> service cart, port 80
  - path /catalog  (type Prefix) -> service catalog, port 80

The ingress controller is exposed on NodePort 31080 (http).
`,
  solution: `
kubectl -n net-ing create ingress store --class=nginx \\
  --rule="store.cka.local/cart*=cart:80" --rule="store.cka.local/catalog*=catalog:80"
kubectl -n net-ing get ingress store -o yaml       # pathType: Prefix dzięki '*'
curl -H 'Host: store.cka.local' http://<<w1_ip>>:31080/cart
`,
});

// =============================================================================== CoreDNS: hosts
task({
  id: 'coredns-hosts', domain: 'networking', title: 'CoreDNS: własne rekordy dla starej infrastruktury', host: 'cp', minutes: 7,
  conflicts: ['coredns'], namespaces: ['net-dns'],
  setup(c) {
    const cur = jp(c.get('configmap', 'coredns', 'kube-system'), 'data.Corefile', '');
    if (!cur.includes('corp.internal')) c.state.orig_corefile = cur;
  },
  check(c, g) {
    const net = c.cfg.net_prefix;
    const res = c.probe('net-dns', { app: 'dns-client' }, [
      ['nslookup legacy-db.corp.internal.', true],
      ['nslookup legacy-mq.corp.internal.', true],
      ['nslookup kubernetes.default.svc.cluster.local.', true],
    ]);
    g.ok(`legacy-db.corp.internal -> ${net}.50`, res[0][0] && res[0][1].out.includes(`${net}.50`), res[0][1] && res[0][1].text);
    g.ok(`legacy-mq.corp.internal -> ${net}.51`, res[1][0] && res[1][1].out.includes(`${net}.51`), res[1][1] && res[1][1].text);
    g.ok('nazwy klastra nadal działają (kubernetes.default)', res[2][0] && res[2][1].out.includes(c.cfg.kubernetes_svc_ip), res[2][1] && res[2][1].text);
    const d = c.get('deployment', 'coredns', 'kube-system');
    g.ok('wszystkie repliki CoreDNS gotowe', d && jp(d, 'status.readyReplicas') === jp(d, 'spec.replicas'));
  },
  cleanup(c) {
    const orig = c.state.orig_corefile;
    if (orig) { c.apply(configmap('coredns', 'kube-system', { Corefile: orig })); c.kubectl('-n', 'kube-system', 'rollout', 'restart', 'deployment/coredns'); }
  },
  text: `
Pods must be able to resolve two legacy hosts that are not in any DNS server:
    legacy-db.corp.internal -> <<net>>.50
    legacy-mq.corp.internal -> <<net>>.51

Configure the cluster DNS (CoreDNS) accordingly. All existing cluster DNS names
must keep working.
`,
  solution: `
kubectl -n kube-system edit configmap coredns
# w bloku .:53 { ... } PRZED 'forward' dodaj:
#        hosts {
#           <<net>>.50 legacy-db.corp.internal
#           <<net>>.51 legacy-mq.corp.internal
#           fallthrough
#        }
# 'fallthrough' jest kluczowe - bez niego inne zapytania dostaną NXDOMAIN.
# Alternatywa: osobny blok serwera:  corp.internal:53 { hosts { ... } }
kubectl -n kube-system rollout restart deployment coredns     # albo poczekaj na plugin reload (~30s)
kubectl run t --rm -it --image=busybox:1.36 -- nslookup legacy-db.corp.internal
`,
  test: `
kubectl -n kube-system get cm coredns -o yaml > cm.yaml
sed -i 's#        forward . /etc/resolv.conf {#        hosts {\\n           <<net>>.50 legacy-db.corp.internal\\n           <<net>>.51 legacy-mq.corp.internal\\n           fallthrough\\n        }\\n        forward . /etc/resolv.conf {#' cm.yaml
kubectl apply -f cm.yaml
kubectl -n kube-system rollout restart deployment coredns
kubectl -n kube-system rollout status deployment coredns
kubectl run t --rm -i --restart=Never --image=busybox:1.36 -- nslookup legacy-db.corp.internal
`,
});

// =============================================================================== EndpointSlice ręcznie
task({
  id: 'endpointslice-manual', domain: 'networking', title: 'Service bez selektora + ręczny EndpointSlice', host: 'cp', minutes: 7,
  namespaces: ['net-ext', 'legacy-host'],
  setup(c) {
    c.apply(echoApp('legacy', 'legacy-host', 'legacy=ok', { hostNetworkPort: 8088, node: c.cfg.w1 }));
    c.rollout('deployment/legacy', 'legacy-host', 180);
    for (const es of c.list('endpointslices', 'net-ext')) c.delete('endpointslice', es.metadata.name, 'net-ext');
  },
  check(c, g) {
    const ns = 'net-ext', ip = c.cfg.ip(c.cfg.w1);
    const s = c.get('service', 'legacy-api', ns);
    g.ok('Service legacy-api istnieje', s);
    g.ok('Service nie ma selektora', s && !Object.keys(jp(s, 'spec.selector', {}) || {}).length);
    const sp = (jp(s, 'spec.ports', []) || [{}])[0] || {};
    g.ok('Service: port 80', sp.port === 80);
    const es = c.get('endpointslice', 'legacy-api-1', ns);
    g.ok('EndpointSlice legacy-api-1 powiązany z Service (label kubernetes.io/service-name)', (jp(es, 'metadata.labels', {}) || {})['kubernetes.io/service-name'] === 'legacy-api');
    g.ok('EndpointSlice: addressType IPv4', jp(es, 'addressType') === 'IPv4');
    g.ok(`EndpointSlice: adres ${ip}`, (jp(es, 'endpoints', []) || []).some((e) => (e.addresses || []).includes(ip)));
    g.ok('EndpointSlice: port 8088 (nazwa zgodna z portem Service)', (jp(es, 'ports', []) || []).some((p) => p.port === 8088 && (p.name || '') === (sp.name || '')));
    const res = c.probe(ns, { app: 'client' }, [[`${WGET}http://legacy-api.net-ext.svc.cluster.local/`, true]]);
    g.ok("http://legacy-api.net-ext.svc.cluster.local odpowiada 'legacy=ok'", res[0][0] && res[0][1].out.includes('legacy=ok'), res[0][1] && res[0][1].text);
  },
  text: `
A legacy application runs outside of the pod network on <<w1_ip>>, TCP port 8088.

1. Create a Service named legacy-api in namespace net-ext WITHOUT a selector,
   listening on port 80.
2. Create an EndpointSlice named legacy-api-1 for this Service that points to
   <<w1_ip>> on port 8088.

Pods must reach the application via http://legacy-api.net-ext.svc.cluster.local
`,
  solution: `
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: legacy-api
  namespace: net-ext
spec:
  ports:
  - name: http
    port: 80
    targetPort: 8088
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: legacy-api-1
  namespace: net-ext
  labels:
    kubernetes.io/service-name: legacy-api     # <- wiąże slice z Service
addressType: IPv4
ports:
- name: http            # musi być taka sama jak nazwa portu w Service
  port: 8088
  protocol: TCP
endpoints:
- addresses: ["<<w1_ip>>"]
EOF
kubectl -n net-ext run t --rm -it --image=busybox:1.36 -- wget -qO- legacy-api
`,
});
