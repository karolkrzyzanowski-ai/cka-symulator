// Kontrolery dodatków: CRD, CoreDNS, NGINX Gateway Fabric, ingress-nginx, cert-manager.
import { clone, deepEqual, b64enc } from '../lib/util.js';
import { parseCorefile, routeAttached, listenerAllows, referenceGranted } from './net.js';
import { makeCert, makeKey } from './pki.js';
import { podReady, ownerRef } from './controllers.js';
import { parseDuration } from '../lib/util.js';

// ------------------------------------------------------------------ CRD -> rejestr typów
const crdCtrl = {
  name: 'crd',
  run(c) {
    if (!c.apiAvailable()) return false;
    let changed = false;
    const seen = new Set();
    for (const crd of c.all('customresourcedefinitions')) {
      const s = crd.spec || {};
      const storage = (s.versions || []).find((v) => v.storage) || (s.versions || [])[0];
      if (!storage) continue;
      seen.add(`${s.group}/${s.names.plural}`);
      if (c.registry.syncCrd(crd)) changed = true;
      const conds = crd.status?.conditions || [];
      if (!conds.some((x) => x.type === 'Established' && x.status === 'True')) {
        crd.status = {
          acceptedNames: { ...s.names, singular: s.names.singular || s.names.kind.toLowerCase() },
          conditions: [
            { lastTransitionTime: c.iso(), message: 'no conflicts found', reason: 'NoConflicts', status: 'True', type: 'NamesAccepted' },
            { lastTransitionTime: c.iso(), message: 'the initial names have been accepted', reason: 'InitialNamesAccepted', status: 'True', type: 'Established' },
          ],
          storedVersions: [storage.name],
        };
        c.put(crd);
        changed = true;
      }
    }
    for (const r of [...c.registry.list]) {
      if (r.crd && !seen.has(`${r.group}/${r.plural}`)) { c.registry.remove(r.group, r.plural); delete c.db[`${r.plural}.${r.group}`]; changed = true; }
    }
    return changed;
  },
};

// ------------------------------------------------------------------ CoreDNS: przeładowanie Corefile
const corednsCtrl = {
  name: 'coredns',
  run(c) {
    const cm = c.peek('configmaps', 'kube-system', 'coredns');
    const text = cm?.data?.Corefile || '';
    const rv = cm?.metadata?.resourceVersion || '';
    c.meta.dns = c.meta.dns || {};
    const d = c.meta.dns;
    // pody CoreDNS uruchomione po zmianie -> od razu nowa konfiguracja; plugin reload ~30 s
    const pods = Object.values(c.runtime).filter((r) => r.ns === 'kube-system' && r.name.startsWith('coredns-') && r.main[0]?.state === 'running');
    const newest = Math.max(0, ...pods.map((r) => r.main[0].startedAtMs || 0));
    if (d.rv !== rv) {
      if (!d.changedAt || d.pendingRv !== rv) { d.changedAt = c.now(); d.pendingRv = rv; }
      if (c.now() - d.changedAt >= 30000 || newest > d.changedAt) {
        try {
          const blocks = parseCorefile(text);
          c.meta.corefileBlocks = blocks;
          d.error = null;
        } catch (e) {
          // błędny Corefile - reload odrzucony, zostaje stara konfiguracja
          d.error = e.message;
          for (const r of pods) r.main[0].logs.push([c.now(), `[ERROR] Restart failed: ${e.message}`]);
        }
        d.rv = rv;
        if (!d.error) for (const r of pods) { r.main[0].logs.push([c.now(), '[INFO] Reloading']); r.main[0].logs.push([c.now(), '[INFO] Reloading complete']); }
        return true;
      }
    }
    return false;
  },
};

// ------------------------------------------------------------------ NGINX Gateway Fabric
const NGF_CONTROLLER = 'gateway.nginx.org/nginx-gateway-controller';

function ngfUp(c) {
  return c.all('pods', 'nginx-gateway').some((p) => p.metadata.labels?.['app.kubernetes.io/name'] === 'nginx-gateway-fabric' && podReady(p));
}

const gatewayCtrl = {
  name: 'gateway',
  run(c) {
    if (!c.apiAvailable() || !c.registry.resolve('gateways.gateway.networking.k8s.io')) return false;
    let changed = false;
    const up = ngfUp(c);
    const now = c.iso();
    for (const gc of c.all('gatewayclasses')) {
      if (gc.spec?.controllerName !== NGF_CONTROLLER) continue;
      const want = [{ lastTransitionTime: now, message: 'The GatewayClass is accepted', observedGeneration: gc.metadata.generation || 1, reason: 'Accepted', status: up ? 'True' : 'Unknown', type: 'Accepted' }, { lastTransitionTime: now, message: 'The Gateway API CRD versions are supported', observedGeneration: gc.metadata.generation || 1, reason: 'SupportedVersion', status: 'True', type: 'SupportedVersion' }];
      if (!sameConds(gc.status?.conditions, want)) { gc.status = { ...(gc.status || {}), conditions: want }; c.put(gc); changed = true; }
    }
    if (!up) return changed;
    for (const gw of c.all('gateways')) {
      const gc = c.peek('gatewayclasses', null, gw.spec?.gatewayClassName);
      if (!gc || gc.spec?.controllerName !== NGF_CONTROLLER) continue;
      const ns = gw.metadata.namespace;
      const name = `${gw.metadata.name}-${gw.spec.gatewayClassName}`;
      const ports = (gw.spec.listeners || []).map((l) => l.port).filter((p, i, a) => a.indexOf(p) === i);
      const labels = { 'app.kubernetes.io/instance': 'ngf', 'app.kubernetes.io/managed-by': 'ngf-nginx', 'app.kubernetes.io/name': name, 'gateway.networking.k8s.io/gateway-name': gw.metadata.name };
      if (!c.peek('deployments', ns, name)) {
        try {
          c.create({
            apiVersion: 'apps/v1', kind: 'Deployment',
            metadata: { name, namespace: ns, labels, ownerReferences: [ownerRef(gw)] },
            spec: { replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: { containers: [{ name: 'nginx', image: 'ghcr.io/nginx/nginx-gateway-fabric/nginx:2.8.0', ports: ports.map((p) => ({ containerPort: p, name: `port-${p}` })) }] } } },
          }, { user: null });
          changed = true;
        } catch { /* */ }
      }
      let svc = c.peek('services', ns, name);
      const wantPorts = ports.map((p) => ({ name: `port-${p}`, port: p, protocol: 'TCP', targetPort: p }));
      if (!svc) {
        try {
          c.create({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels, ownerReferences: [ownerRef(gw)] }, spec: { type: 'NodePort', externalTrafficPolicy: 'Cluster', selector: labels, ports: wantPorts } }, { user: null });
          changed = true;
        } catch { /* */ }
        svc = c.peek('services', ns, name);
      } else if (JSON.stringify(svc.spec.ports.map((p) => p.port)) !== JSON.stringify(ports)) {
        svc.spec.ports = wantPorts;
        try { c.update(svc, { user: null }); changed = true; } catch { /* */ }
      }
      const dep = c.peek('deployments', ns, name);
      const programmed = (dep?.status?.readyReplicas || 0) >= 1;
      const routes = c.all('httproutes').filter((r) => routeAttached(c, r, gw));
      const listeners = (gw.spec.listeners || []).map((l) => {
        const okProto = ['HTTP', 'HTTPS', 'TLS'].includes(l.protocol);
        return {
          attachedRoutes: routes.filter((r) => listenerAllows(c, l, gw, r) && (r.spec.parentRefs || []).some((ref) => ref.name === gw.metadata.name && (!ref.sectionName || ref.sectionName === l.name))).length,
          conditions: [
            { lastTransitionTime: now, message: okProto ? 'The Listener is accepted' : `Protocol "${l.protocol}" is not supported, use one of HTTP, HTTPS, TLS`, observedGeneration: gw.metadata.generation, reason: okProto ? 'Accepted' : 'UnsupportedProtocol', status: okProto ? 'True' : 'False', type: 'Accepted' },
            { lastTransitionTime: now, message: 'The Listener is programmed', observedGeneration: gw.metadata.generation, reason: 'Programmed', status: okProto && programmed ? 'True' : 'False', type: 'Programmed' },
            { lastTransitionTime: now, message: 'All references are resolved', observedGeneration: gw.metadata.generation, reason: 'ResolvedRefs', status: 'True', type: 'ResolvedRefs' },
            { lastTransitionTime: now, message: 'No conflicts', observedGeneration: gw.metadata.generation, reason: 'NoConflicts', status: 'False', type: 'Conflicted' },
          ],
          name: l.name,
          supportedKinds: [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute' }, { group: 'gateway.networking.k8s.io', kind: 'GRPCRoute' }],
        };
      });
      const node = Object.values(c.hosts).find((h) => h.role === 'worker');
      const st = {
        addresses: svc && programmed ? [{ type: 'IPAddress', value: svc.spec.clusterIP }] : undefined,
        conditions: [
          { lastTransitionTime: now, message: 'The Gateway is accepted', observedGeneration: gw.metadata.generation, reason: 'Accepted', status: 'True', type: 'Accepted' },
          { lastTransitionTime: now, message: programmed ? 'The Gateway is programmed' : 'The Gateway is not yet programmed', observedGeneration: gw.metadata.generation, reason: programmed ? 'Programmed' : 'Pending', status: programmed ? 'True' : 'False', type: 'Programmed' },
        ],
        listeners,
      };
      void node;
      if (!st.addresses) delete st.addresses;
      if (!sameStatus(gw.status, st)) { gw.status = st; c.put(gw); changed = true; }
    }
    // HTTPRoute
    for (const r of c.all('httproutes')) {
      const parents = [];
      for (const ref of r.spec.parentRefs || []) {
        const gw = c.peek('gateways', ref.namespace || r.metadata.namespace, ref.name);
        const gc = gw && c.peek('gatewayclasses', null, gw.spec.gatewayClassName);
        if (gc && gc.spec?.controllerName !== NGF_CONTROLLER) continue;
        let accepted = !!gw, reason = gw ? 'Accepted' : 'NoMatchingParent', msg = gw ? 'The Route is accepted' : `Gateway "${ref.namespace || r.metadata.namespace}/${ref.name}" not found`;
        if (gw) {
          const ls = (gw.spec.listeners || []).filter((l) => !ref.sectionName || l.name === ref.sectionName);
          if (!ls.length) { accepted = false; reason = 'NoMatchingParent'; msg = `Listener "${ref.sectionName}" not found`; } else if (!ls.some((l) => listenerAllows(c, l, gw, r))) { accepted = false; reason = 'NotAllowedByListeners'; msg = 'Route is not allowed by any listener'; } else {
            const hostOk = !(r.spec.hostnames || []).length || ls.some((l) => !l.hostname || r.spec.hostnames.some((h) => h === l.hostname || (l.hostname.startsWith('*.') && h.endsWith(l.hostname.slice(1)))));
            if (!hostOk) { accepted = false; reason = 'NoMatchingListenerHostname'; msg = 'Listener hostname does not match the Route hostnames'; }
          }
        }
        let resolved = true, rReason = 'ResolvedRefs', rMsg = 'All references are resolved';
        for (const rule of r.spec.rules || []) {
          for (const be of rule.backendRefs || []) {
            const bns = be.namespace || r.metadata.namespace;
            if ((be.kind || 'Service') !== 'Service') { resolved = false; rReason = 'InvalidKind'; rMsg = `spec.rules[0].backendRefs[0].kind: Unsupported value: "${be.kind}": supported values: "Service"`; continue; }
            if (bns !== r.metadata.namespace && !referenceGranted(c, r, bns, be.name)) { resolved = false; rReason = 'RefNotPermitted'; rMsg = `Backend ref to Service ${bns}/${be.name} not permitted by any ReferenceGrant`; continue; }
            const svc = c.peek('services', bns, be.name);
            if (!svc) { resolved = false; rReason = 'BackendNotFound'; rMsg = `spec.rules[0].backendRefs[0].name: Not found: "${be.name}"`; continue; }
            if (be.port === undefined) { resolved = false; rReason = 'UnsupportedValue'; rMsg = 'spec.rules[0].backendRefs[0].port: Required value: port cannot be empty'; continue; }
            if (!(svc.spec.ports || []).some((p) => p.port === be.port)) { resolved = false; rReason = 'BackendNotFound'; rMsg = `spec.rules[0].backendRefs[0].port: Not found: "${be.port}"`; }
          }
        }
        parents.push({
          conditions: [
            { lastTransitionTime: now, message: msg, observedGeneration: r.metadata.generation, reason, status: accepted ? 'True' : 'False', type: 'Accepted' },
            { lastTransitionTime: now, message: rMsg, observedGeneration: r.metadata.generation, reason: rReason, status: resolved ? 'True' : 'False', type: 'ResolvedRefs' },
          ],
          controllerName: NGF_CONTROLLER,
          parentRef: { group: 'gateway.networking.k8s.io', kind: 'Gateway', name: ref.name, namespace: ref.namespace || r.metadata.namespace, ...(ref.sectionName ? { sectionName: ref.sectionName } : {}) },
        });
      }
      const st = { parents };
      if (!sameStatus(r.status, st)) { r.status = st; c.put(r); changed = true; }
    }
    return changed;
  },
};

function sameConds(a, b) {
  const s = (x) => JSON.stringify((x || []).map((y) => ({ ...y, lastTransitionTime: 0 })));
  return s(a) === s(b);
}
function sameStatus(a, b) {
  const s = (x) => JSON.stringify(x || {}, (k, v) => (k === 'lastTransitionTime' ? 0 : v));
  return s(a) === s(b);
}

// ------------------------------------------------------------------ ingress-nginx: adres w statusie
const ingressCtrl = {
  name: 'ingress',
  run(c) {
    if (!c.apiAvailable()) return false;
    let changed = false;
    const ctrlPods = c.all('pods', 'ingress-nginx').filter((p) => p.metadata.labels?.['app.kubernetes.io/component'] === 'controller' && podReady(p));
    if (!ctrlPods.length) return false;
    const classes = c.all('ingressclasses').filter((x) => x.spec?.controller === 'k8s.io/ingress-nginx').map((x) => x.metadata.name);
    for (const ing of c.all('ingresses')) {
      if (!classes.includes(ing.spec?.ingressClassName)) continue;
      const ip = c.hosts[ctrlPods[0].spec.nodeName]?.ip;
      const want = { loadBalancer: { ingress: [{ ip }] } };
      if (!deepEqual(ing.status, want)) {
        if (!ing._seenAt) { ing._seenAt = c.now(); continue; }
        ing.status = want;
        c.put(ing);
        c.event(ing, 'Normal', 'Sync', 'Scheduled for sync', 'nginx-ingress-controller');
        changed = true;
      }
    }
    return changed;
  },
};

// ------------------------------------------------------------------ cert-manager
function cmUp(c) {
  return c.all('pods', 'cert-manager').some((p) => p.metadata.name.startsWith('cert-manager-') && !p.metadata.name.includes('cainjector') && !p.metadata.name.includes('webhook') && podReady(p))
    && c.all('pods', 'cert-manager').some((p) => p.metadata.name.includes('webhook') && podReady(p));
}

const certManagerCtrl = {
  name: 'cert-manager',
  run(c) {
    if (!c.apiAvailable() || !c.registry.resolve('certificates.cert-manager.io') || !cmUp(c)) return false;
    let changed = false;
    const now = c.iso();
    const issuerReady = (kind, ns, name) => {
      const i = kind === 'ClusterIssuer' ? c.peek('clusterissuers', null, name) : c.peek('issuers', ns, name);
      return i && i.status?.conditions?.some((x) => x.type === 'Ready' && x.status === 'True') ? i : null;
    };
    for (const res of ['clusterissuers', 'issuers']) {
      for (const i of c.all(res)) {
        const spec = i.spec || {};
        const ok = !!(spec.selfSigned || spec.ca || spec.acme || spec.vault);
        let caOk = true;
        if (spec.ca) caOk = !!c.peek('secrets', res === 'clusterissuers' ? 'cert-manager' : i.metadata.namespace, spec.ca.secretName);
        const want = [{ lastTransitionTime: now, message: !ok ? 'No issuer type configured' : !caOk ? `Error getting keypair for CA issuer: secret "${spec.ca.secretName}" not found` : spec.selfSigned ? '' : 'Signing CA verified', observedGeneration: i.metadata.generation || 1, reason: ok && caOk ? 'IsReady' : 'ErrInitIssuer', status: ok && caOk ? 'True' : 'False', type: 'Ready' }];
        if (!sameConds(i.status?.conditions, want)) { i.status = { conditions: want }; c.put(i); changed = true; }
      }
    }
    for (const crt of c.all('certificates')) {
      const ns = crt.metadata.namespace;
      const ref = crt.spec.issuerRef || {};
      const issuer = issuerReady(ref.kind || 'Issuer', ns, ref.name);
      const secretName = crt.spec.secretName;
      const durSec = parseDuration(crt.spec.duration || '2160h') || 7776000;
      let st;
      if (!issuer) {
        st = { conditions: [{ lastTransitionTime: now, message: `Issuing certificate as Secret does not exist`, observedGeneration: crt.metadata.generation || 1, reason: 'DoesNotExist', status: 'False', type: 'Ready' }] };
        if (!c.eventsFor(crt).some((e) => e.reason === 'IssuerNotReady')) c.event(crt, 'Warning', 'IssuerNotReady', `Referenced "${ref.kind || 'Issuer'}" not found: ${(ref.kind || 'issuer').toLowerCase()}.cert-manager.io "${ref.name}" not found`, 'cert-manager-certificates-issuing');
      } else {
        let sec = c.peek('secrets', ns, secretName);
        const hash = JSON.stringify([crt.spec.dnsNames, crt.spec.commonName, crt.spec.duration, ref]);
        if (!sec || sec.metadata.annotations?.['cert-manager.io/certificate-name'] !== crt.metadata.name || sec.metadata.annotations?.['cka/hash'] !== hash) {
          const key = makeKey();
          const cert = makeCert({ cn: crt.spec.commonName || crt.spec.dnsNames?.[0] || crt.metadata.name, issuer: ref.name, notBefore: c.now(), seconds: durSec, san: crt.spec.dnsNames || [], key });
          sec = {
            apiVersion: 'v1', kind: 'Secret', type: 'kubernetes.io/tls',
            metadata: { name: secretName, namespace: ns, annotations: { 'cert-manager.io/alt-names': (crt.spec.dnsNames || []).join(','), 'cert-manager.io/certificate-name': crt.metadata.name, 'cert-manager.io/common-name': crt.spec.commonName || '', 'cert-manager.io/issuer-group': 'cert-manager.io', 'cert-manager.io/issuer-kind': ref.kind || 'Issuer', 'cert-manager.io/issuer-name': ref.name, 'cka/hash': hash }, labels: { 'controller.cert-manager.io/fao': 'true' } },
            data: { 'ca.crt': b64enc(cert), 'tls.crt': b64enc(cert), 'tls.key': b64enc(key) },
          };
          const ex = c.peek('secrets', ns, secretName);
          if (ex) sec.metadata.uid = ex.metadata.uid;
          c.put(sec);
          c.event(crt, 'Normal', 'Issuing', 'Issuing certificate as Secret does not exist', 'cert-manager-certificates-trigger');
          c.event(crt, 'Normal', 'Issuing', 'The certificate has been successfully issued', 'cert-manager-certificates-issuing');
          changed = true;
          crt._issuedAt = c.now();
        }
        const nb = crt.status?.notBefore || now;
        st = {
          conditions: [{ lastTransitionTime: crt.status?.conditions?.[0]?.status === 'True' ? crt.status.conditions[0].lastTransitionTime : now, message: 'Certificate is up to date and has not expired', observedGeneration: crt.metadata.generation || 1, reason: 'Ready', status: 'True', type: 'Ready' }],
          notAfter: new Date(Date.parse(nb) + durSec * 1000).toISOString().replace('.000Z', 'Z'),
          notBefore: nb,
          renewalTime: new Date(Date.parse(nb) + (durSec * 2000) / 3).toISOString().replace('.000Z', 'Z'),
          revision: 1,
        };
      }
      if (!sameStatus(crt.status, st)) { crt.status = st; c.put(crt); changed = true; }
    }
    return changed;
  },
};

// ------------------------------------------------------------------ Calico: gotowość CNI
const calicoCtrl = {
  name: 'calico',
  run(c) {
    const was = c.meta.cniInstalled;
    c.meta.cniInstalled = !!c.peek('daemonsets', 'kube-system', 'calico-node');
    return was !== c.meta.cniInstalled;
  },
};

export const ADDON_CONTROLLERS = [crdCtrl, corednsCtrl, gatewayCtrl, ingressCtrl, certManagerCtrl, calicoCtrl];
export { clone };
