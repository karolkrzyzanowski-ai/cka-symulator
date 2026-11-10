// Kubelet + containerd: statyczne pody, cykl życia kontenerów, procesy, sondy, status węzła.
import { VFS } from '../shell/vfs.js';
import { Shell, IO, ExitSignal } from '../shell/interp.js';
import { lookupImage, pullErrorMessage, imageFiles, normalizeImage } from './images.js';
import { evaluateComponent, COMPONENTS, klog } from './component.js';
import { systemdTick } from './systemd.js';
import { containerCommands } from '../shell/commands/index.js';
import { parseAll } from '../lib/yaml.js';
import { clone, hex, parseQty, b64dec, shQuote, hexHash, hashStr, uuid } from '../lib/util.js';
import { defaultPodSpec, qosClass } from './admission.js';
import { httpProbe } from './net.js';

const BACKOFF = [0, 10, 20, 40, 80, 160, 300];
const CONTROL_PLANE = ['etcd', 'kube-apiserver', 'kube-controller-manager', 'kube-scheduler'];

function procs(c) { if (!c._procs) c._procs = new Map(); return c._procs; }

// =============================================================================== kontroler
export const kubeletController = {
  name: 'kubelet',
  run(c) {
    let changed = false;
    for (const h of Object.values(c.hosts)) {
      if (h.role === 'base') continue;
      if (systemdTick(c, h)) changed = true;
      const ku = h.unit('kubelet');
      const cd = h.unit('containerd');
      const kubeletOn = ku.state === 'active';
      const runtimeOn = cd.state === 'active';
      if (kubeletOn && runtimeOn) {
        if (syncStaticPods(c, h)) changed = true;
      }
      if (h.role === 'control-plane') if (updateControlPlane(c, h)) changed = true;
      if (kubeletOn && runtimeOn && c.apiAvailable()) {
        if (registerNode(c, h)) changed = true;
        if (syncApiPods(c, h)) changed = true;
      }
      if (runtimeOn) {
        for (const rt of Object.values(c.runtime)) {
          if (rt.node !== h.name) continue;
          if (progressPod(c, h, rt, kubeletOn)) changed = true;
        }
      }
      if (kubeletOn && runtimeOn && c.apiAvailable()) {
        if (writeStatuses(c, h)) changed = true;
        if (nodeHeartbeat(c, h)) changed = true;
      }
    }
    return changed;
  },
};

// =============================================================================== statyczne pody
function staticPath(h) {
  return h.unit('kubelet').cfg?.staticPodPath || '/etc/kubernetes/manifests';
}

function syncStaticPods(c, h) {
  let changed = false;
  const dir = staticPath(h);
  const desired = {};
  let files = [];
  try { files = h.fs.isDir(dir) ? h.fs.list(dir) : []; } catch { files = []; }
  h._badManifest = h._badManifest || {};
  for (const f of files) {
    if (f.startsWith('.')) continue;
    const path = `${dir}/${f}`;
    if (h.fs.isDir(path)) continue;
    const text = h.fs.tryRead(path) || '';
    const hash = String(hashStr(text));
    let pod = null;
    try {
      const docs = parseAll(text);
      pod = docs[0];
      if (!pod || pod.kind !== 'Pod' || !pod.metadata?.name || !pod.spec?.containers?.length) throw new Error(pod ? `invalid pod: ${!pod.metadata?.name ? 'name is required' : 'spec.containers: Required value'}` : 'empty manifest');
    } catch (e) {
      if (h._badManifest[path] !== hash) {
        h.log('kubelet', c.now(), `E0000 file.go:187] "Could not process manifest file" err="${String(e.message).replace(/"/g, '\\"')}" path="${path}"`);
        h._badManifest[path] = hash;
      }
      continue;
    }
    delete h._badManifest[path];
    const key = `static/${h.name}/${pod.metadata.namespace || 'default'}/${pod.metadata.name}`;
    desired[key] = { pod, hash, path };
  }
  for (const [key, d] of Object.entries(desired)) {
    const rt = c.runtime[key];
    if (rt && rt.hash === d.hash) continue;
    if (rt) { killPod(c, h, rt, 'manifest changed'); delete c.runtime[key]; }
    const pod = clone(d.pod);
    pod.metadata.namespace = pod.metadata.namespace || 'default';
    defaultPodSpec(pod.spec, { isPod: true });
    pod.spec.nodeName = h.name;
    c.runtime[key] = newRuntime(c, h, {
      key, uid: uuid(), ns: pod.metadata.namespace, name: `${pod.metadata.name}-${h.name}`, spec: pod.spec,
      meta: pod.metadata, static: true, hash: d.hash, path: d.path,
    });
    changed = true;
  }
  for (const [key, rt] of Object.entries(c.runtime)) {
    if (!rt.static || rt.node !== h.name) continue;
    if (!desired[key]) {
      killPod(c, h, rt, 'manifest removed');
      delete c.runtime[key];
      if (c.apiAvailable()) c.remove('pods', rt.ns, rt.name);
      changed = true;
    }
  }
  return changed;
}

// =============================================================================== control plane
function updateControlPlane(c, h) {
  const st = {};
  for (const comp of CONTROL_PLANE) {
    const rt = Object.values(c.runtime).find((r) => r.static && r.node === h.name && r.meta?.labels?.component === comp);
    const crt = rt?.main?.[0];
    const running = !!crt && crt.state === 'running' && rt.state !== 'terminating';
    const ready = running && c.now() >= (crt.startedAtMs || 0) + (crt.readyAfterMs ?? 0);
    st[comp] = { running, ready, rt };
  }
  const prev = JSON.stringify(c.comp || {});
  const etcdUp = st.etcd.ready;
  const apiUp = st['kube-apiserver'].ready && etcdUp && h.unit('containerd').state === 'active';
  c.comp = {
    etcd: etcdUp, apiserver: apiUp, scheduler: st['kube-scheduler'].ready && apiUp, kcm: st['kube-controller-manager'].ready && apiUp,
  };
  c.apiserverDown = !apiUp;
  return prev !== JSON.stringify(c.comp);
}

// przełączenie katalogu danych etcd (np. po etcdutl snapshot restore)
function switchEtcdDataDir(c, h, dir) {
  if (dir === c.etcd.dataDir) return;
  // zachowaj bieżące dane pod starym katalogiem
  c.etcd.stores[c.etcd.dataDir] = JSON.stringify(c.db);
  let data = c.etcd.stores[dir];
  if (!data) {
    const snap = h.fs.tryRead(`${dir}/member/snap/db`);
    if (snap) data = snap.replace(/^[^\n]*\n/, '');
  }
  c.etcd.dataDir = dir;
  if (data) {
    try { c.db = JSON.parse(data); } catch { c.db = {}; }
  } else {
    c.db = {};
    h.fs.mkdir(`${dir}/member/snap`, { p: true });
  }
  c.dirty = true;
  if (c.onEtcdSwitch) c.onEtcdSwitch(dir);
}

// =============================================================================== węzeł
export function nodeCidrBase(c, name) {
  return c.meta.podBlocks?.[name] || '10.244.0';
}

function registerNode(c, h) {
  const existing = c.peek('nodes', null, h.name);
  if (existing) return false;
  if (!h.fs.exists('/etc/kubernetes/kubelet.conf')) return false;
  const cp = h.role === 'control-plane';
  const labels = {
    'beta.kubernetes.io/arch': 'amd64', 'beta.kubernetes.io/os': 'linux', 'kubernetes.io/arch': 'amd64',
    'kubernetes.io/hostname': h.name, 'kubernetes.io/os': 'linux',
  };
  if (cp) { labels['node-role.kubernetes.io/control-plane'] = ''; labels['node.kubernetes.io/exclude-from-external-load-balancers'] = ''; }
  const idx = Object.keys(c.hosts).filter((n) => c.hosts[n].role !== 'base').indexOf(h.name);
  const node = {
    apiVersion: 'v1', kind: 'Node',
    metadata: {
      name: h.name, labels,
      annotations: {
        'kubeadm.alpha.kubernetes.io/cri-socket': 'unix:///var/run/containerd/containerd.sock', 'node.alpha.kubernetes.io/ttl': '0',
        'projectcalico.org/IPv4Address': `${h.ip}/24`, 'projectcalico.org/IPv4IPIPTunnelAddr': `${nodeCidrBase(c, h.name)}.64`,
        'volumes.kubernetes.io/controller-managed-attach-detach': 'true',
      },
    },
    spec: { podCIDR: `10.244.${idx}.0/24`, podCIDRs: [`10.244.${idx}.0/24`], ...(cp && h.cpTaint !== false ? { taints: [{ effect: 'NoSchedule', key: 'node-role.kubernetes.io/control-plane' }] } : {}) },
    status: {},
  };
  c.put(node);
  c.event({ ...node, metadata: { ...node.metadata, namespace: 'default', uid: node.metadata.uid } }, 'Normal', 'RegisteredNode', `Node ${h.name} event: Registered Node ${h.name} in Controller`, 'node-controller');
  h.log('kubelet', c.now(), klog('I', c.now(), 'kubelet_node_status.go:78', `"Successfully registered node" node="${h.name}"`));
  return true;
}

export function nodeConditionsFor(c, h) {
  const cni = cniReady(c, h);
  return { ready: cni.ok, reason: cni.ok ? 'KubeletReady' : 'KubeletNotReady', message: cni.ok ? 'kubelet is posting ready status' : 'container runtime network not ready: NetworkReady=false reason:NetworkPluginNotReady message:Network plugin returns error: cni plugin not initialized' };
}

export function cniReady(c, h) {
  let confs = [];
  try { confs = h.fs.list('/etc/cni/net.d').filter((f) => /\.(conflist|conf|json)$/.test(f)); } catch { confs = []; }
  if (!confs.length) return { ok: false };
  if (!c.meta.cniInstalled) return { ok: false };
  const calico = Object.values(c.runtime).find((r) => r.node === h.name && r.name.startsWith('calico-node-') && r.state !== 'gone');
  if (!calico) return { ok: !!h.cniWasReady };
  const ok = (calico.main || []).some((x) => x.state === 'running');
  if (ok) h.cniWasReady = true;
  return { ok: ok || !!h.cniWasReady };
}

function nodeHeartbeat(c, h) {
  const node = c.peek('nodes', null, h.name);
  if (!node) return false;
  c.heartbeats = c.heartbeats || {};
  const last = c.heartbeats[h.name] || 0;
  const cond = nodeConditionsFor(c, h);
  const readyNow = node.status?.conditions?.find((x) => x.type === 'Ready');
  const want = cond.ready ? 'True' : 'False';
  if (c.now() - last < 10000 && readyNow?.status === want && node.status?.nodeInfo?.kubeletVersion === `v${(h.unit('kubelet').runningVersion || '').split('-')[0]}`) {
    c.heartbeats[h.name] = c.heartbeats[h.name] || c.now();
    return false;
  }
  c.heartbeats[h.name] = c.now();
  const iso = c.iso();
  const prevT = (type) => node.status?.conditions?.find((x) => x.type === type)?.lastTransitionTime || iso;
  const mk = (type, status, reason, message) => ({ lastHeartbeatTime: iso, lastTransitionTime: readyNow && type === 'Ready' && readyNow.status !== status ? iso : prevT(type), message, reason, status, type });
  const kv = `v${(h.unit('kubelet').runningVersion || h.packages.kubelet || '1.37.1').split('-')[0]}`;
  const memKi = h.memMi * 1024;
  node.status = {
    addresses: [{ address: h.ip, type: 'InternalIP' }, { address: h.name, type: 'Hostname' }],
    allocatable: { cpu: String(h.cpu), 'ephemeral-storage': '27527697124', 'hugepages-1Gi': '0', 'hugepages-2Mi': '0', memory: `${memKi - 102400}Ki`, pods: '110' },
    capacity: { cpu: String(h.cpu), 'ephemeral-storage': '29868808Ki', 'hugepages-1Gi': '0', 'hugepages-2Mi': '0', memory: `${memKi}Ki`, pods: '110' },
    conditions: [
      mk('NetworkUnavailable', 'False', 'CalicoIsUp', 'Calico is running on this node'),
      mk('MemoryPressure', 'False', 'KubeletHasSufficientMemory', 'kubelet has sufficient memory available'),
      mk('DiskPressure', 'False', 'KubeletHasNoDiskPressure', 'kubelet has no disk pressure'),
      mk('PIDPressure', 'False', 'KubeletHasSufficientPID', 'kubelet has sufficient PID available'),
      mk('Ready', want, cond.reason, cond.message),
    ],
    daemonEndpoints: { kubeletEndpoint: { Port: 10250 } },
    nodeInfo: {
      architecture: 'amd64', bootID: hexHash(h.name + 'boot', 32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'),
      containerRuntimeVersion: `containerd://${h.packages.containerd || '2.4.2'}`, kernelVersion: '6.8.0-147-generic',
      kubeProxyVersion: '', kubeletVersion: kv, machineID: hexHash(h.name + 'machine', 32), operatingSystem: 'linux',
      osImage: 'Ubuntu 24.04.5 LTS', systemUUID: hexHash(h.name + 'uuid', 32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'),
    },
    runtimeHandlers: [{ features: { recursiveReadOnlyMounts: true, userNamespaces: true }, name: 'runc' }, { features: { recursiveReadOnlyMounts: true, userNamespaces: true }, name: '' }],
    features: { supplementalGroupsPolicy: true },
  };
  if (readyNow?.status !== want) {
    c.event({ ...node, metadata: { ...node.metadata, namespace: 'default' } }, 'Normal', want === 'True' ? 'NodeReady' : 'NodeNotReady', `Node ${h.name} status is now: ${want === 'True' ? 'NodeReady' : 'NodeNotReady'}`, 'kubelet');
  }
  return c.put(node);
}

// =============================================================================== pody z API
function syncApiPods(c, h) {
  let changed = false;
  const pods = c.all('pods').filter((p) => p.spec?.nodeName === h.name && !p.metadata.annotations?.['kubernetes.io/config.mirror']);
  const seen = new Set();
  for (const p of pods) {
    seen.add(p.metadata.uid);
    let rt = c.runtime[p.metadata.uid];
    if (!rt) {
      if (p.status?.phase === 'Succeeded' || p.status?.phase === 'Failed') continue;
      if (p.metadata.deletionTimestamp) { c.remove('pods', p.metadata.namespace, p.metadata.name); changed = true; continue; }
      rt = c.runtime[p.metadata.uid] = newRuntime(c, h, { key: p.metadata.uid, uid: p.metadata.uid, ns: p.metadata.namespace, name: p.metadata.name, spec: p.spec, meta: p.metadata });
      changed = true;
    }
    if (p.metadata.deletionTimestamp && rt.state !== 'terminating' && rt.state !== 'gone') {
      startTermination(c, h, rt, Date.parse(p.metadata.deletionTimestamp));
      changed = true;
    }
    // aktualizacja obrazu (jedyna dozwolona zmiana spec poda)
    (p.spec.containers || []).forEach((ct) => {
      const crt = rt.main.find((x) => x.name === ct.name);
      if (crt && crt.image !== ct.image && rt.state !== 'terminating') {
        crt.image = ct.image;
        if (crt.state === 'running') stopContainer(c, h, rt, crt, 'image changed', { restart: true });
        crt.pulled = false;
        rt.spec.containers.find((x) => x.name === ct.name).image = ct.image;
        changed = true;
      }
    });
    rt.meta = p.metadata;
  }
  // wpisy runtime bez poda w API -> zabij
  for (const [key, rt] of Object.entries(c.runtime)) {
    if (rt.static || rt.node !== h.name) continue;
    if (!seen.has(rt.uid)) {
      killPod(c, h, rt, 'pod deleted');
      delete c.runtime[key];
      changed = true;
    }
  }
  return changed;
}

function newRuntime(c, h, { key, uid, ns, name, spec, meta, static: isStatic = false, hash, path }) {
  const mk = (ct, init) => ({
    name: ct.name, init, sidecar: init && ct.restartPolicy === 'Always', image: ct.image, state: 'waiting', reason: 'ContainerCreating', message: '',
    restarts: 0, ready: false, started: false, logs: [], prevLogs: [], pulled: false, listen: [],
  });
  return {
    key, uid, ns, name, node: h.name, static: isStatic, hash, path, spec: clone(spec), meta: clone(meta || {}),
    created: c.now(), state: 'creating', sandbox: null, ip: null,
    init: (spec.initContainers || []).map((x) => mk(x, true)), main: (spec.containers || []).map((x) => mk(x, false)),
    emptyDirs: {}, lastMountEvent: 0, phase: 'Pending',
  };
}

function startTermination(c, h, rt, deadline) {
  rt.state = 'terminating';
  rt.termDeadline = deadline;
  for (const crt of [...rt.main, ...rt.init]) {
    if (crt.state !== 'running') continue;
    // serwery kończą się szybko na SIGTERM; sh -c "sleep" jako PID 1 ignoruje SIGTERM
    const fast = crt.kind && crt.kind !== 'shell';
    crt.stopAt = fast ? Math.min(deadline, c.now() + 400) : deadline;
    if (!rt.static && rt.meta?.uid) {
      c.event(podRef(rt), 'Normal', 'Killing', `Stopping container ${crt.name}`, 'kubelet');
    }
  }
}

function killPod(c, h, rt, why) {
  for (const crt of [...rt.main, ...rt.init]) {
    if (crt.state === 'running') {
      crt.state = 'terminated';
      crt.exitCode = 137;
      crt.reason = 'Error';
      crt.finishedAt = c.iso();
    }
    procs(c).delete(crt.id);
  }
  rt.state = 'gone';
  void why;
}

function podRef(rt) {
  return { apiVersion: 'v1', kind: 'Pod', metadata: { name: rt.name, namespace: rt.ns, uid: rt.meta?.uid || rt.uid } };
}

// =============================================================================== postęp poda
function progressPod(c, h, rt, kubeletOn) {
  let changed = false;
  const now = c.now();
  // procesy działają niezależnie od kubeleta (containerd-shim)
  for (const crt of [...rt.init, ...rt.main]) {
    if (crt.state === 'running') if (advanceContainer(c, h, rt, crt, now)) changed = true;
  }
  if (!kubeletOn) return changed;

  if (rt.state === 'terminating') {
    let all = true;
    for (const crt of [...rt.main, ...rt.init]) {
      if (crt.state === 'running') {
        if (now >= (crt.stopAt ?? rt.termDeadline)) { stopContainer(c, h, rt, crt, 'terminated', { exitCode: crt.kind === 'shell' ? 137 : 0 }); changed = true; } else all = false;
      }
    }
    if (all) {
      rt.state = 'gone';
      if (!rt.static) {
        delete c.runtime[rt.key];
        if (c.apiAvailable()) c.remove('pods', rt.ns, rt.name);
      }
      changed = true;
    }
    return changed;
  }
  if (rt.state === 'gone') return changed;

  // piaskownica (sieć)
  if (!rt.sandbox) {
    if (!rt.spec.hostNetwork && !cniReady(c, h).ok) {
      if (now - (rt.lastSandboxEvent || 0) > 30000 && !rt.static) {
        rt.lastSandboxEvent = now;
        c.event(podRef(rt), 'Warning', 'FailedCreatePodSandBox', `Failed to create pod sandbox: rpc error: code = Unknown desc = failed to setup network for sandbox "${hex(64)}": plugin type="calico" failed (add): stat /var/lib/calico/nodename: no such file or directory: check that the calico/node container is running and has mounted /var/lib/calico/`, 'kubelet');
      }
      return changed;
    }
    // tworzenie piaskownicy trwa chwilę (pause + CNI)
    if (!rt.sandboxAt) { rt.sandboxAt = now + (rt.static ? 300 : 900); return changed; }
    if (now < rt.sandboxAt) return changed;
    rt.sandbox = hex(64);
    rt.ip = rt.spec.hostNetwork ? h.ip : allocPodIP(c, h);
    rt.startTime = c.iso();
    rt.state = 'running';
    changed = true;
  }
  // wolumeny
  const vol = checkVolumes(c, rt);
  if (!vol.ok) {
    if (now - rt.lastMountEvent > 60000) {
      rt.lastMountEvent = now;
      c.event(podRef(rt), 'Warning', 'FailedMount', vol.message, 'kubelet');
      changed = true;
    }
    return changed;
  }
  // activeDeadlineSeconds
  if (rt.spec.activeDeadlineSeconds && rt.startTime && now > Date.parse(rt.startTime) + rt.spec.activeDeadlineSeconds * 1000 && rt.phase !== 'Failed') {
    for (const crt of [...rt.main, ...rt.init]) if (crt.state === 'running') stopContainer(c, h, rt, crt, 'deadline', { exitCode: 137 });
    rt.phase = 'Failed';
    rt.reason = 'DeadlineExceeded';
    rt.message = `Pod was active on the node longer than the specified deadline`;
    c.event(podRef(rt), 'Normal', 'DeadlineExceeded', 'Pod was active on the node longer than the specified deadline', 'kubelet');
    return true;
  }
  if (rt.phase === 'Failed' || rt.phase === 'Succeeded') return changed;

  // kontenery init (sekwencyjnie), sidecary startują i działają dalej
  let initOk = true;
  for (const crt of rt.init) {
    const spec = rt.spec.initContainers.find((x) => x.name === crt.name);
    if (crt.sidecar) {
      if (crt.state !== 'running' || !crt.started) {
        if (stepContainer(c, h, rt, crt, spec)) changed = true;
        if (!(crt.state === 'running' && crt.started)) { initOk = false; break; }
      } else if (crt.state === 'running') { if (probeContainer(c, h, rt, crt, spec)) changed = true; }
      continue;
    }
    if (crt.done) continue;
    if (stepContainer(c, h, rt, crt, spec)) changed = true;
    if (crt.state === 'terminated' && crt.exitCode === 0) { crt.done = true; changed = true; continue; }
    initOk = false;
    break;
  }
  // sidecary po starcie dalej podlegają restartom
  for (const crt of rt.init) {
    if (crt.sidecar && crt.started && crt.state !== 'running') {
      const spec = rt.spec.initContainers.find((x) => x.name === crt.name);
      if (stepContainer(c, h, rt, crt, spec)) changed = true;
    }
  }
  if (!initOk) return changed;
  rt.initDone = true;
  for (const crt of rt.main) {
    const spec = rt.spec.containers.find((x) => x.name === crt.name);
    if (stepContainer(c, h, rt, crt, spec)) changed = true;
    if (crt.state === 'running') if (probeContainer(c, h, rt, crt, spec)) changed = true;
  }
  // faza
  const rp = rt.spec.restartPolicy || 'Always';
  if (rp !== 'Always') {
    const allDone = rt.main.every((x) => x.state === 'terminated' && (rp === 'Never' || x.exitCode === 0) && !x.backoffUntil);
    if (allDone) {
      const ok = rt.main.every((x) => x.exitCode === 0);
      rt.phase = ok ? 'Succeeded' : 'Failed';
      for (const crt of rt.init) if (crt.sidecar && crt.state === 'running') stopContainer(c, h, rt, crt, 'pod completed', { exitCode: 0 });
      changed = true;
    }
  }
  return changed;
}

function allocPodIP(c, h) {
  c.alloc.podIPs[h.name] = c.alloc.podIPs[h.name] || [];
  const used = new Set(Object.values(c.runtime).filter((r) => r.node === h.name && r.ip).map((r) => r.ip));
  const base = nodeCidrBase(c, h.name);
  c.alloc.ipCursor = c.alloc.ipCursor || {};
  for (let i = 1; i <= 250; i++) {
    const n = ((c.alloc.ipCursor[h.name] || 0) + i) % 250;
    const ip = `${base}.${n + 2}`;
    if (!used.has(ip)) {
      c.alloc.ipCursor[h.name] = n;
      return ip;
    }
  }
  return `${base}.254`;
}

function checkVolumes(c, rt) {
  for (const v of rt.spec.volumes || []) {
    if (v.configMap && !v.configMap.optional && !c.peek('configmaps', rt.ns, v.configMap.name)) return { ok: false, message: `MountVolume.SetUp failed for volume "${v.name}" : configmap "${v.configMap.name}" not found` };
    if (v.secret && !v.secret.optional && !c.peek('secrets', rt.ns, v.secret.secretName)) return { ok: false, message: `MountVolume.SetUp failed for volume "${v.name}" : secret "${v.secret.secretName}" not found` };
    if (v.persistentVolumeClaim) {
      const pvc = c.peek('persistentvolumeclaims', rt.ns, v.persistentVolumeClaim.claimName);
      if (!pvc || pvc.status?.phase !== 'Bound') return { ok: false, message: `Unable to attach or mount volumes: unmounted volumes=[${v.name}], unattached volumes=[], failed to process volumes=[]: timed out waiting for the condition` };
    }
    if (v.hostPath && v.hostPath.type === 'Directory') {
      const h = c.hosts[rt.node];
      if (!h.fs.isDir(v.hostPath.path)) return { ok: false, message: `MountVolume.SetUp failed for volume "${v.name}" : hostPath type check failed: ${v.hostPath.path} is not a directory` };
    }
  }
  return { ok: true };
}

// =============================================================================== kontener: maszyna stanów
function stepContainer(c, h, rt, crt, spec) {
  const now = c.now();
  if (!spec) return false;
  if (crt.state === 'running') return false;
  if (crt.backoffUntil && now < crt.backoffUntil) {
    if (crt.reason !== 'CrashLoopBackOff' && crt.state !== 'waiting') {
      crt.state = 'waiting';
      crt.reason = 'CrashLoopBackOff';
      crt.message = `back-off ${Math.round((crt.backoffUntil - (crt.lastExitAt || now)) / 1000)}s restarting failed container=${crt.name} pod=${rt.name}_${rt.ns}(${rt.uid})`;
      return true;
    }
    return false;
  }
  if (crt.state === 'terminated') {
    const rp = crt.sidecar ? 'Always' : (crt.init ? (rt.spec.restartPolicy === 'Never' ? 'Never' : 'OnFailure') : rt.spec.restartPolicy || 'Always');
    const restart = rp === 'Always' || (rp === 'OnFailure' && crt.exitCode !== 0);
    if (!restart) {
      if (crt.init && crt.exitCode !== 0 && rt.spec.restartPolicy === 'Never') { rt.phase = 'Failed'; return true; }
      return false;
    }
    if (!crt.backoffScheduled) {
      const delay = BACKOFF[Math.min(crt.restarts, BACKOFF.length - 1)] * 1000;
      crt.backoffScheduled = true;
      crt.lastExitAt = now;
      if (delay > 0) {
        crt.backoffUntil = now + delay;
        crt.state = 'waiting';
        crt.reason = 'CrashLoopBackOff';
        crt.message = `back-off ${delay / 1000}s restarting failed container=${crt.name} pod=${rt.name}_${rt.ns}(${rt.uid})`;
        c.event(podRef(rt), 'Warning', 'BackOff', `Back-off restarting failed container ${crt.name} in pod ${rt.name}_${rt.ns}(${rt.uid})`, 'kubelet');
        return true;
      }
    }
  }
  if (crt.backoffUntil && now >= crt.backoffUntil) { crt.backoffUntil = null; }
  crt.backoffScheduled = false;
  // obraz
  if (!crt.pulled) {
    const res = lookupImage(spec.image);
    if (!res.ok) {
      if (crt.pullRetryAt && now < crt.pullRetryAt) {
        if (crt.reason === 'ErrImagePull' && now > (crt.pullFailedAt || 0) + 2000) { crt.reason = 'ImagePullBackOff'; crt.message = `Back-off pulling image "${spec.image}"`; c.event(podRef(rt), 'Normal', 'BackOff', `Back-off pulling image "${spec.image}"`, 'kubelet'); c.event(podRef(rt), 'Warning', 'Failed', 'Error: ImagePullBackOff', 'kubelet'); return true; }
        return false;
      }
      crt.pullFails = (crt.pullFails || 0) + 1;
      crt.pullFailedAt = now;
      crt.pullRetryAt = now + Math.min(300, 10 * 2 ** (crt.pullFails - 1)) * 1000;
      crt.state = 'waiting';
      crt.reason = res.reason === 'InvalidImageName' ? 'InvalidImageName' : 'ErrImagePull';
      crt.message = pullErrorMessage(spec.image, res);
      c.event(podRef(rt), 'Normal', 'Pulling', `Pulling image "${spec.image}"`, 'kubelet');
      c.event(podRef(rt), 'Warning', 'Failed', crt.message, 'kubelet');
      c.event(podRef(rt), 'Warning', 'Failed', `Error: ${crt.reason}`, 'kubelet');
      return true;
    }
    h.images = h.images || [];
    const cached = h.images.includes(res.n.full) && spec.imagePullPolicy !== 'Always';
    if (!crt.pullStartedAt) {
      crt.pullStartedAt = now;
      crt.pullDuration = cached ? 0 : 1200 + Math.floor((res.info.mem || 5) * 15);
      if (!cached) c.event(podRef(rt), 'Normal', 'Pulling', `Pulling image "${spec.image}"`, 'kubelet');
      crt.state = 'waiting';
      crt.reason = crt.restarts ? crt.reason : 'ContainerCreating';
    }
    if (now < crt.pullStartedAt + crt.pullDuration) return false;
    if (cached) c.event(podRef(rt), 'Normal', 'Pulled', `Container image "${spec.image}" already present on machine`, 'kubelet');
    else {
      const secs = (crt.pullDuration / 1000).toFixed(3);
      c.event(podRef(rt), 'Normal', 'Pulled', `Successfully pulled image "${spec.image}" in ${secs}s (${secs}s including waiting). Image size: ${(res.info.mem || 5) * 1700000 + 31337} bytes.`, 'kubelet');
      if (!h.images.includes(res.n.full)) h.images.push(res.n.full);
    }
    crt.pulled = true;
    crt.pullFails = 0;
    crt.pullStartedAt = null;
    crt.imageInfo = res;
  }
  // konfiguracja (env)
  const envRes = resolveEnv(c, rt, spec);
  if (envRes.error) {
    if (crt.reason !== 'CreateContainerConfigError' || now - (crt.cfgErrAt || 0) > 30000) {
      crt.state = 'waiting';
      crt.reason = 'CreateContainerConfigError';
      crt.message = envRes.error;
      crt.cfgErrAt = now;
      c.event(podRef(rt), 'Warning', 'Failed', `Error: ${envRes.error}`, 'kubelet');
      return true;
    }
    return false;
  }
  return startContainer(c, h, rt, crt, spec, envRes.env);
}

export function resolveEnv(c, rt, spec) {
  const env = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOSTNAME: rt.spec.hostNetwork ? rt.node : (rt.spec.hostname || rt.name.slice(0, 63)),
    HOME: '/root', KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT: '443', KUBERNETES_SERVICE_PORT_HTTPS: '443',
    KUBERNETES_PORT: 'tcp://10.96.0.1:443', KUBERNETES_PORT_443_TCP: 'tcp://10.96.0.1:443', KUBERNETES_PORT_443_TCP_PROTO: 'tcp',
    KUBERNETES_PORT_443_TCP_PORT: '443', KUBERNETES_PORT_443_TCP_ADDR: '10.96.0.1',
  };
  if (rt.spec.enableServiceLinks !== false && c.apiAvailable()) {
    for (const s of c.all('services', rt.ns)) {
      if (!s.spec?.clusterIP || s.spec.clusterIP === 'None' || !s.spec.ports?.length) continue;
      const n = s.metadata.name.toUpperCase().replace(/-/g, '_');
      const p = s.spec.ports[0];
      env[`${n}_SERVICE_HOST`] = s.spec.clusterIP;
      env[`${n}_SERVICE_PORT`] = String(p.port);
      env[`${n}_PORT`] = `tcp://${s.spec.clusterIP}:${p.port}`;
    }
  }
  for (const ef of spec.envFrom || []) {
    if (ef.configMapRef) {
      const cm = c.peek('configmaps', rt.ns, ef.configMapRef.name);
      if (!cm) { if (ef.configMapRef.optional) continue; return { error: `configmap "${ef.configMapRef.name}" not found` }; }
      for (const [k, v] of Object.entries(cm.data || {})) env[(ef.prefix || '') + k] = v;
    }
    if (ef.secretRef) {
      const s = c.peek('secrets', rt.ns, ef.secretRef.name);
      if (!s) { if (ef.secretRef.optional) continue; return { error: `secret "${ef.secretRef.name}" not found` }; }
      for (const [k, v] of Object.entries(s.data || {})) env[(ef.prefix || '') + k] = safeDec(v);
    }
  }
  for (const e of spec.env || []) {
    if (e.value !== undefined) { env[e.name] = String(e.value).replace(/\$\(([A-Za-z_]\w*)\)/g, (m, k) => (env[k] !== undefined ? env[k] : m)); continue; }
    const vf = e.valueFrom;
    if (!vf) { env[e.name] = ''; continue; }
    if (vf.configMapKeyRef) {
      const r = vf.configMapKeyRef;
      const cm = c.peek('configmaps', rt.ns, r.name);
      if (!cm) { if (r.optional) continue; return { error: `configmap "${r.name}" not found` }; }
      if (cm.data?.[r.key] === undefined) { if (r.optional) continue; return { error: `couldn't find key ${r.key} in ConfigMap ${rt.ns}/${r.name}` }; }
      env[e.name] = cm.data[r.key];
    } else if (vf.secretKeyRef) {
      const r = vf.secretKeyRef;
      const s = c.peek('secrets', rt.ns, r.name);
      if (!s) { if (r.optional) continue; return { error: `secret "${r.name}" not found` }; }
      if (s.data?.[r.key] === undefined) { if (r.optional) continue; return { error: `couldn't find key ${r.key} in Secret ${rt.ns}/${r.name}` }; }
      env[e.name] = safeDec(s.data[r.key]);
    } else if (vf.fieldRef) {
      const fp = vf.fieldRef.fieldPath;
      const map = { 'metadata.name': rt.name, 'metadata.namespace': rt.ns, 'status.podIP': rt.ip || '', 'spec.nodeName': rt.node, 'status.hostIP': c.hosts[rt.node]?.ip || '', 'spec.serviceAccountName': rt.spec.serviceAccountName || 'default', 'metadata.uid': rt.uid };
      const lm = fp.match(/^metadata\.(labels|annotations)\['(.+)'\]$/);
      env[e.name] = lm ? (rt.meta?.[lm[1]]?.[lm[2]] ?? '') : (map[fp] ?? '');
    } else if (vf.resourceFieldRef) {
      const r = vf.resourceFieldRef;
      const [kind, res] = r.resource.split('.');
      const v = spec.resources?.[kind]?.[res];
      env[e.name] = v ? String(res === 'cpu' ? Math.ceil(parseQty(v)) : Math.ceil(parseQty(v))) : (res === 'cpu' ? String(c.hosts[rt.node]?.cpu || 2) : String((c.hosts[rt.node]?.memMi || 4096) * 1048576));
    }
  }
  return { env };
}

const safeDec = (v) => { try { return b64dec(v); } catch { return ''; } };

// system plików kontenera
export function buildContainerFs(c, rt, crt, spec) {
  const h = c.hosts[rt.node];
  // warstwa zapisywalna kontenera - żyje do restartu kontenera
  let root;
  if (crt.rootfs) root = new VFS(crt.rootfs);
  else {
    root = new VFS();
    const res = crt.imageInfo || lookupImage(spec.image);
    const info = res.info || { kind: 'shell' };
    for (const [p, data] of Object.entries(imageFiles(info, res.n || normalizeImage(spec.image)))) root.put(p, data);
    for (const d of ['/tmp', '/var/log', '/root', '/home', '/etc', '/proc', '/dev', '/run']) root.mkdir(d, { p: true });
    if (crt.state === 'running') crt.rootfs = root.toJSON();
  }
  root.put('/etc/hostname', `${rt.spec.hostNetwork ? rt.node : rt.name}\n`);
  const fqdn = rt.spec.subdomain ? `${rt.spec.hostname || rt.name}.${rt.spec.subdomain}.${rt.ns}.svc.cluster.local\t${rt.spec.hostname || rt.name}` : rt.name;
  root.put('/etc/hosts', `# Kubernetes-managed hosts file.\n127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n${rt.ip}\t${fqdn}\n${(rt.spec.hostAliases || []).map((a) => `\n# Entries added by HostAliases.\n${a.ip}\t${(a.hostnames || []).join('\t')}`).join('')}`);
  const dnsHost = rt.spec.hostNetwork && rt.spec.dnsPolicy !== 'ClusterFirstWithHostNet';
  root.put('/etc/resolv.conf', dnsHost || rt.spec.dnsPolicy === 'Default' ? 'nameserver 192.168.177.1\nsearch .\n' : `search ${rt.ns}.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.96.0.10\noptions ndots:5\n`);
  const mounts = [];
  for (const vm of spec.volumeMounts || []) {
    const v = (rt.spec.volumes || []).find((x) => x.name === vm.name);
    if (!v) continue;
    let fs = null, sub = '/', ro = !!vm.readOnly;
    if (v.emptyDir) {
      if (!rt.emptyDirs[v.name]) rt.emptyDirs[v.name] = new VFS().toJSON();
      fs = new VFS(rt.emptyDirs[v.name]);
    } else if (v.configMap) {
      const cm = c.peek('configmaps', rt.ns, v.configMap.name);
      fs = projectKeys(cm?.data || {}, v.configMap.items, false);
      ro = true;
    } else if (v.secret) {
      const s = c.peek('secrets', rt.ns, v.secret.secretName);
      fs = projectKeys(s?.data || {}, v.secret.items, true);
      ro = true;
    } else if (v.projected) {
      fs = new VFS();
      fs.put('/token', `eyJhbGciOiJSUzI1NiIsImtpZCI6Ik${hex(24)}In0.${hex(120)}`);
      fs.put('/ca.crt', c.hosts[Object.keys(c.hosts).find((n) => c.hosts[n].role === 'control-plane')]?.fs.tryRead('/etc/kubernetes/pki/ca.crt') || '');
      fs.put('/namespace', rt.ns);
      ro = true;
    } else if (v.hostPath) {
      if (!h.fs.exists(v.hostPath.path) && (v.hostPath.type === 'DirectoryOrCreate' || !v.hostPath.type)) h.fs.mkdir(v.hostPath.path, { p: true });
      if (v.hostPath.type === 'FileOrCreate' && !h.fs.exists(v.hostPath.path)) h.fs.put(v.hostPath.path, '');
      fs = h.fs; sub = v.hostPath.path;
    } else if (v.persistentVolumeClaim) {
      const pvc = c.peek('persistentvolumeclaims', rt.ns, v.persistentVolumeClaim.claimName);
      const pv = pvc && c.peek('persistentvolumes', null, pvc.spec.volumeName);
      const path = pv?.spec?.hostPath?.path || pv?.spec?.local?.path;
      if (pv?.spec?.nfs) { c.nfs = c.nfs || {}; const k = `${pv.spec.nfs.server}:${pv.spec.nfs.path}`; c.nfs[k] = c.nfs[k] || new VFS().toJSON(); fs = new VFS(c.nfs[k]); } else if (path) {
        if (!h.fs.exists(path)) h.fs.mkdir(path, { p: true });
        fs = h.fs; sub = path;
      } else fs = new VFS();
      if (v.persistentVolumeClaim.readOnly) ro = true;
    } else if (v.nfs) {
      c.nfs = c.nfs || {};
      const k = `${v.nfs.server}:${v.nfs.path}`;
      c.nfs[k] = c.nfs[k] || new VFS().toJSON();
      fs = new VFS(c.nfs[k]);
    } else if (v.downwardAPI) {
      fs = new VFS();
      for (const it of v.downwardAPI.items || []) {
        const fp = it.fieldRef?.fieldPath || '';
        const val = fp === 'metadata.labels' ? Object.entries(rt.meta?.labels || {}).map(([k, x]) => `${k}="${x}"`).join('\n') : fp === 'metadata.name' ? rt.name : fp === 'metadata.namespace' ? rt.ns : '';
        fs.put('/' + it.path, val);
      }
      ro = true;
    } else fs = new VFS();
    if (vm.subPath) sub = (sub === '/' ? '' : sub) + '/' + vm.subPath;
    mounts.push({ path: vm.mountPath.replace(/\/+$/, '') || '/', fs, sub, ro });
  }
  root.mounts = mounts;
  return root;
}

function projectKeys(data, items, isSecret) {
  const fs = new VFS();
  const dec = (v) => (isSecret ? safeDec(v) : v);
  if (items?.length) {
    for (const it of items) if (data[it.key] !== undefined) fs.put('/' + it.path, dec(data[it.key]));
  } else {
    for (const [k, v] of Object.entries(data)) fs.put('/' + k, dec(v));
  }
  return fs;
}

// =============================================================================== start / stop
function startContainer(c, h, rt, crt, spec, env) {
  const now = c.now();
  const info = crt.imageInfo?.info || { kind: 'shell', bin: [] };
  crt.id = hex(64);
  crt.state = 'running';
  crt.reason = '';
  crt.message = '';
  crt.startedAt = c.iso();
  crt.startedAtMs = now;
  crt.ready = false;
  crt.started = false;
  crt.busy = false;
  crt.listen = [];
  crt.kind = info.kind;
  crt.exitAt = null;
  crt.readyAfterMs = 0;
  crt.probe = { liveFails: 0, readyOk: false, lastReady: 0, lastLive: 0, lastStart: 0, startFails: 0, startedOk: !spec.startupProbe };
  if (crt.restarts > 0 || crt.everStarted) crt.prevLogs = crt.logs;
  crt.logs = [];
  crt.partial = '';
  crt.everStarted = true;
  const imageID = `${crt.imageInfo?.n?.repo || 'docker.io/library/unknown'}@sha256:${hexHash(crt.imageInfo?.n?.full || spec.image, 64)}`;
  crt.imageID = imageID;
  if (!rt.static) {
    c.event(podRef(rt), 'Normal', 'Created', `Created container: ${crt.name}`, 'kubelet');
    c.event(podRef(rt), 'Normal', 'Started', `Started container ${crt.name}`, 'kubelet');
  }
  // OOM - limit pamięci poniżej zapotrzebowania obrazu
  const lim = parseQty(spec.resources?.limits?.memory);
  if (lim !== null && lim < (info.mem || 2) * 1048576) {
    crt.exitAt = now + 1500;
    crt.exitCode = 137;
    crt.exitReason = 'OOMKilled';
  }
  const argv = [...(spec.command || []), ...(spec.args || [])];
  crt.rootfs = null;
  const fs = buildContainerFs(c, rt, crt, spec);
  crt.fsMounts = true;
  // komponent control plane
  if (info.kind === 'component') {
    const compName = (spec.image.split('/').pop() || '').split(':')[0];
    const res = evaluateComponent(compName, { spec: rt.spec }, h, { now, etcdUp: c.comp?.etcd });
    if (res.startError) return startError(c, h, rt, crt, res.startError);
    for (const l of res.logs) appendLog(crt, now, l + '\n');
    if (!res.ok) { crt.exitAt = now + (res.crashAfterMs || 1500); crt.exitCode = res.exitCode ?? 1; crt.exitReason = 'Error'; } else crt.listen = [...(COMPONENT_PORTS[compName] || [])];
    crt.readyAfterMs = res.readyAfterMs || 0;
    if (compName === 'etcd' && res.ok && res.dataDir) switchEtcdDataDir(c, h, res.dataDir);
    if (compName === 'kube-apiserver' && res.ok) {
      const tf = (argv.find((a) => a.startsWith('--tls-cert-file=')) || '').split('=')[1];
      c.meta.servingCert = tf ? h.fs.tryRead(tf) : null;
    }
    crt.started = true;
    return true;
  }
  // instalator CNI (calico/cni install-cni) zapisuje konfigurację na hoście
  if (info.kind === 'oneshot' && /calico\/cni/.test(spec.image)) {
    if (!h.fs.exists('/etc/cni/net.d/10-calico.conflist')) {
      h.fs.mkdir('/etc/cni/net.d', { p: true });
      h.fs.put('/etc/cni/net.d/10-calico.conflist', (c.meta.calicoConflist || '{\n  "name": "k8s-pod-network",\n  "cniVersion": "0.3.1",\n  "plugins": [{"type": "calico"}, {"type": "portmap", "capabilities": {"portMappings": true}}]\n}\n').replace('__KUBERNETES_NODE_NAME__', h.name));
      h.fs.put('/etc/cni/net.d/calico-kubeconfig', 'apiVersion: v1\nkind: Config\nclusters:\n- name: local\n  cluster:\n    server: https://10.96.0.1:443\n', { mode: 0o600 });
    }
    appendLog(crt, now, `${new Date(now).toISOString().replace('T', ' ').slice(0, 23)} [INFO][1] cni-installer/<nil> <nil>: CNI plugin version: v3.32.3\n`);
  }
  // program
  const prog = resolveProgram(argv, info, env);
  if (prog.error) return startError(c, h, rt, crt, prog.error);
  if (prog.server) {
    crt.server = prog.server;
    crt.listen = serverPorts(prog.server, fs, info);
    for (const l of serverStartLogs(prog.server, now, c, rt)) appendLog(crt, now, l);
    if (prog.server === 'postgres' && !env.POSTGRES_PASSWORD && !env.POSTGRES_HOST_AUTH_METHOD) {
      appendLog(crt, now + 300, 'Error: Database is uninitialized and superuser password is not specified.\n       You must specify POSTGRES_PASSWORD to a non-empty value for the\n       superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".\n');
      crt.exitAt = now + 600; crt.exitCode = 1; crt.exitReason = 'Error';
      crt.listen = [];
    }
    if (prog.server === 'mysql' && !env.MYSQL_ROOT_PASSWORD && !env.MYSQL_ALLOW_EMPTY_PASSWORD && !env.MYSQL_RANDOM_ROOT_PASSWORD) {
      appendLog(crt, now + 300, `${new Date(now).toISOString()} [ERROR] [Entrypoint]: Database is uninitialized and password option is not specified\n    You need to specify one of the following as an environment variable:\n    - MYSQL_ROOT_PASSWORD\n    - MYSQL_ALLOW_EMPTY_PASSWORD\n    - MYSQL_RANDOM_ROOT_PASSWORD\n`);
      crt.exitAt = now + 600; crt.exitCode = 1; crt.exitReason = 'Error';
      crt.listen = [];
    }
    crt.started = !spec.startupProbe;
    crt.env = env;
    return true;
  }
  // proces powłoki
  spawnShell(c, rt, crt, prog.script, env, fs, info, spec, now);
  crt.started = !spec.startupProbe;
  crt.env = env;
  return true;
}

const COMPONENT_PORTS = { 'kube-apiserver': [6443], etcd: [2379, 2380, 2381], 'kube-controller-manager': [10257], 'kube-scheduler': [10259] };

function startError(c, h, rt, crt, msg) {
  const now = c.now();
  crt.state = 'terminated';
  crt.exitCode = 128;
  crt.reason = 'StartError';
  crt.message = msg;
  crt.finishedAt = c.iso();
  crt.lastExitAt = now;
  crt.last = { terminated: { exitCode: 128, reason: 'StartError', message: msg, startedAt: '1970-01-01T00:00:00Z', finishedAt: c.iso(), containerID: `containerd://${crt.id}` } };
  crt.restarts += crt.everStartedErr ? 1 : 0;
  crt.everStartedErr = true;
  if (!rt.static) c.event(podRef(rt), 'Warning', 'Failed', `Error: ${msg}`, 'kubelet');
  return true;
}

function resolveProgram(argv, info, env) {
  // domyślne polecenie obrazu
  if (!argv.length) {
    if (['nginx', 'httpd', 'podinfo', 'redis', 'postgres', 'mysql', 'coredns', 'ingress', 'gateway', 'daemon'].includes(info.kind)) return { server: info.kind };
    return { script: 'sh' };
  }
  const exe = argv[0].split('/').pop();
  if (info.kind === 'oneshot') return { script: 'sleep 2' };
  if (['sh', 'bash', 'ash', 'dash'].includes(exe)) {
    if (!info.bin.includes(exe)) return { error: `failed to create containerd task: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: exec: "${argv[0]}": executable file not found in $PATH: unknown` };
    const ci = argv.indexOf('-c');
    if (ci >= 0) return { script: argv[ci + 1] ?? '' };
    if (argv.length === 1) return { script: '' };
    return { script: `. ${argv[1]}` };
  }
  if (exe === 'nginx' && info.bin.includes('nginx')) return { server: 'nginx' };
  if (exe === 'httpd-foreground' || (exe === 'httpd' && info.kind === 'httpd')) return { server: 'httpd' };
  if (exe === 'redis-server') return { server: 'redis' };
  if (exe === 'podinfo' || exe === './podinfo') return { server: 'podinfo' };
  if (exe === 'docker-entrypoint.sh' || exe === '/docker-entrypoint.sh') return { server: info.kind === 'shell' ? 'daemon' : info.kind };
  if (!info.bin.includes(exe) && info.kind !== 'daemon' && info.kind !== 'coredns' && info.kind !== 'ingress' && info.kind !== 'gateway') {
    return { error: `failed to create containerd task: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: exec: "${argv[0]}": executable file not found in $PATH: unknown` };
  }
  if (['daemon', 'coredns', 'ingress', 'gateway'].includes(info.kind) && !info.bin.includes(exe)) return { server: info.kind };
  void env;
  return { script: argv.map(shQuote).join(' ') };
}

function serverPorts(kind, fs, info) {
  if (kind === 'nginx') {
    const ports = new Set();
    try {
      for (const f of fs.list('/etc/nginx/conf.d')) {
        const t = fs.tryRead(`/etc/nginx/conf.d/${f}`) || '';
        for (const m of t.matchAll(/listen\s+(\d+)/g)) ports.add(Number(m[1]));
      }
    } catch { /* */ }
    return ports.size ? [...ports] : [80];
  }
  return info.ports || [];
}

function nginxVer(rt) {
  const img = (rt?.spec?.containers || []).map((x) => x.image).find((i) => /nginx/.test(i)) || '';
  const m = img.match(/:(1\.(\d+))(\.\d+)?/);
  return m ? `${m[1]}${m[3] || ({ 27: '.5', 28: '.0', 29: '.3', 26: '.3', 25: '.5' }[m[2]] || '.0')}` : '1.29.3';
}

function serverStartLogs(kind, t, c, rt) {
  const ts = new Date(t).toISOString().replace('T', ' ').slice(0, 19).replace(/-/g, '/');
  if (kind === 'nginx') {
    return [
      '/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration\n',
      '/docker-entrypoint.sh: Looking for shell scripts in /docker-entrypoint.d/\n',
      '/docker-entrypoint.sh: Launching /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh\n',
      '/docker-entrypoint.sh: Configuration complete; ready for start up\n',
      `${ts} [notice] 1#1: nginx/${nginxVer(rt)}\n`,
      `${ts} [notice] 1#1: start worker processes\n`,
    ];
  }
  if (kind === 'httpd') return [`[${new Date(t).toUTCString()}] [mpm_event:notice] [pid 1:tid 1] AH00489: Apache/2.4.65 (Unix) configured -- resuming normal operations\n`];
  if (kind === 'redis') return ['1:M * Ready to accept connections tcp\n'];
  if (kind === 'podinfo') return [`{"level":"info","ts":"${new Date(t).toISOString()}","msg":"Starting podinfo","version":"6.17.0"}\n`, `{"level":"info","ts":"${new Date(t).toISOString()}","msg":"Starting HTTP Server.","addr":":9898"}\n`];
  if (kind === 'coredns') return ['.:53\n', '[INFO] plugin/reload: Running configuration SHA512 = 1b226df79860026c6a52e67daa10d7f0d57ec5b023288ec00c5e05f93523c894564e15b91770d3a07ae1cfbe861d15b37d4a0027e69c546ab112970993a3b03b\n', 'CoreDNS-1.12.4\n', 'linux/amd64, go1.24.6, 5d0f4b7\n'];
  if (kind === 'postgres' || kind === 'mysql') return [];
  void c; void rt;
  return [`I${new Date(t).toISOString().slice(5, 10).replace('-', '')} ${new Date(t).toISOString().slice(11, 23)}       1 main.go:42] Starting\n`];
}

function spawnShell(c, rt, crt, script, env, fs, info, spec, t0, { replayUntil = null } = {}) {
  const sh = new Shell({
    fs, user: 'root', cwd: spec.workingDir || '/', env, mode: 'container',
    commands: containerCommands(info.bin),
  });
  sh.ctx = { cluster: c, rt, crt, podIP: rt.ip, node: rt.node, inContainer: true };
  sh.onListen = (port) => { if (!crt.listen.includes(port)) crt.listen.push(port); };
  const proc = { sh, t: t0, wake: t0, done: false, code: 0, script };
  const io = new IO(null);
  io.sink = (s) => { if (!proc.silent) appendLog(crt, proc.t, s); };
  proc.io = io;
  proc.gen = sh.run(script, io);
  procs(c).set(crt.id, proc);
  if (replayUntil) {
    proc.silent = true;
    runProc(c, rt, crt, proc, replayUntil);
    proc.silent = false;
  }
  return proc;
}

function runProc(c, rt, crt, proc, now) {
  let spins = 0;
  let steps = 0;
  while (!proc.done && proc.wake <= now && !proc.spin) {
    let r;
    try {
      r = proc.gen.next(proc.resume);
    } catch (e) {
      proc.done = true;
      proc.code = e instanceof ExitSignal ? e.code : 1;
      if (!(e instanceof ExitSignal)) appendLog(crt, proc.t, `sh: ${e.message}\n`);
      break;
    }
    proc.resume = undefined;
    if (r.done) { proc.done = true; proc.code = r.value ?? 0; break; }
    const ef = r.value || {};
    if (ef.type === 'sleep') { proc.t = Math.max(proc.t, proc.wake) + ef.ms; proc.wake = proc.t; spins = 0; } else if (ef.type === 'busy') {
      if (++spins > 4) { proc.spin = true; crt.busy = true; break; }
    } else if (ef.type === 'input') proc.resume = null;
    else if (ef.type === 'edit') proc.resume = { saved: false };
    if (++steps > 20000) { proc.spin = true; crt.busy = true; break; }
  }
}

function advanceContainer(c, h, rt, crt, now) {
  if (crt.kind === 'component' || crt.server) {
    if (crt.exitAt && now >= crt.exitAt) { exitContainer(c, h, rt, crt, crt.exitCode, crt.exitReason); return true; }
    return false;
  }
  let proc = procs(c).get(crt.id);
  if (!proc) {
    // po wczytaniu stanu - odtwórz proces po cichu
    const spec = [...(rt.spec.containers || []), ...(rt.spec.initContainers || [])].find((x) => x.name === crt.name);
    if (!spec) return false;
    const argv = [...(spec.command || []), ...(spec.args || [])];
    const info = crt.imageInfo?.info || lookupImage(spec.image).info || { kind: 'shell', bin: [] };
    const prog = resolveProgram(argv, info, crt.env || {});
    if (!prog.script && prog.script !== '') return false;
    const scratch = buildContainerFs(c, rt, crt, spec);
    const shadow = new VFS(clone(scratch.root));
    shadow.mounts = scratch.mounts.map((m) => ({ ...m, fs: m.fs === c.hosts[rt.node].fs ? new VFS(clone(m.fs.root)) : new VFS(clone(m.fs.root)) }));
    proc = spawnShell(c, rt, crt, prog.script, crt.env || {}, shadow, info, spec, crt.startedAtMs || now, { replayUntil: now });
    proc.sh.fs = scratch;
    return false;
  }
  runProc(c, rt, crt, proc, now);
  if (crt.exitAt && now >= crt.exitAt) { procs(c).delete(crt.id); exitContainer(c, h, rt, crt, crt.exitCode, crt.exitReason); return true; }
  if (proc.done) {
    procs(c).delete(crt.id);
    exitContainer(c, h, rt, crt, proc.code, proc.code === 0 ? 'Completed' : 'Error');
    return true;
  }
  return false;
}

function exitContainer(c, h, rt, crt, code, reason) {
  if (crt.partial) { crt.logs.push([c.now(), crt.partial]); crt.partial = ''; }
  crt.state = 'terminated';
  crt.exitCode = code;
  crt.reason = reason || (code === 0 ? 'Completed' : 'Error');
  crt.finishedAt = c.iso();
  crt.ready = false;
  crt.listen = [];
  crt.exitAt = null;
  crt.last = { terminated: { containerID: `containerd://${crt.id}`, exitCode: code, finishedAt: crt.finishedAt, reason: crt.reason, startedAt: crt.startedAt } };
  const rp = crt.sidecar ? 'Always' : crt.init ? 'OnFailure' : rt.spec.restartPolicy || 'Always';
  if (rp === 'Always' || (rp === 'OnFailure' && code !== 0)) crt.restarts += 1;
  if (crt.reason === 'OOMKilled' && !rt.static) {
    c.event({ apiVersion: 'v1', kind: 'Node', metadata: { name: rt.node, namespace: 'default', uid: rt.node } }, 'Warning', 'OOMKilling', `Memory cgroup out of memory: Killed process (${crt.name})`, 'kernel-monitor');
  }
}

function stopContainer(c, h, rt, crt, why, { exitCode = 0, restart = false } = {}) {
  procs(c).delete(crt.id);
  crt.state = 'terminated';
  crt.exitCode = exitCode;
  crt.reason = exitCode === 0 ? 'Completed' : 'Error';
  crt.finishedAt = c.iso();
  crt.ready = false;
  crt.listen = [];
  crt.last = { terminated: { containerID: `containerd://${crt.id}`, exitCode, finishedAt: crt.finishedAt, reason: crt.reason, startedAt: crt.startedAt } };
  if (restart) { crt.restarts += 1; crt.backoffUntil = null; crt.backoffScheduled = true; }
  void why;
}

export function restartContainerById(c, id) {
  for (const rt of Object.values(c.runtime)) {
    for (const crt of [...rt.main, ...rt.init]) {
      if (crt.id && crt.id.startsWith(id) && crt.state === 'running') {
        stopContainer(c, c.hosts[rt.node], rt, crt, 'crictl stop', { exitCode: 0, restart: true });
        return crt;
      }
    }
  }
  return null;
}

export function appendLog(crt, t, s) {
  const text = (crt.partial || '') + s;
  const parts = text.split('\n');
  crt.partial = parts.pop();
  for (const l of parts) crt.logs.push([t, l]);
  if (crt.logs.length > 3000) crt.logs.splice(0, crt.logs.length - 3000);
}

// =============================================================================== sondy
function probeContainer(c, h, rt, crt, spec) {
  const now = c.now();
  let changed = false;
  const since = now - (crt.startedAtMs || now);
  // sonda startowa
  if (spec.startupProbe && !crt.probe.startedOk) {
    const p = spec.startupProbe;
    if (since >= (p.initialDelaySeconds || 0) * 1000 && now - crt.probe.lastStart >= (p.periodSeconds || 10) * 1000) {
      crt.probe.lastStart = now;
      if (runProbe(c, rt, crt, p).ok) { crt.probe.startedOk = true; crt.started = true; changed = true; } else {
        crt.probe.startFails = (crt.probe.startFails || 0) + 1;
        if (crt.probe.startFails >= (p.failureThreshold || 3)) { stopContainer(c, h, rt, crt, 'startup probe', { exitCode: 137 }); crt.restarts++; return true; }
      }
    }
    return changed;
  }
  if (!crt.started) { crt.started = true; changed = true; }
  // gotowość
  if (spec.readinessProbe) {
    const p = spec.readinessProbe;
    if (since >= (p.initialDelaySeconds || 0) * 1000 && now - (crt.probe.lastReady || 0) >= (p.periodSeconds || 10) * 1000) {
      crt.probe.lastReady = now;
      const r = runProbe(c, rt, crt, p);
      if (r.ok !== crt.ready) {
        crt.ready = r.ok;
        changed = true;
      }
      if (!r.ok && !rt.static) c.event(podRef(rt), 'Warning', 'Unhealthy', `Readiness probe failed: ${r.msg}`, 'kubelet');
    }
  } else if (!crt.ready && since >= (crt.readyAfterMs || 0)) {
    crt.ready = true;
    changed = true;
  }
  // żywotność
  if (spec.livenessProbe) {
    const p = spec.livenessProbe;
    if (since >= (p.initialDelaySeconds || 0) * 1000 && now - (crt.probe.lastLive || 0) >= (p.periodSeconds || 10) * 1000) {
      crt.probe.lastLive = now;
      const r = runProbe(c, rt, crt, p);
      if (r.ok) crt.probe.liveFails = 0;
      else {
        crt.probe.liveFails++;
        if (!rt.static) c.event(podRef(rt), 'Warning', 'Unhealthy', `Liveness probe failed: ${r.msg}`, 'kubelet');
        if (crt.probe.liveFails >= (p.failureThreshold || 3)) {
          if (!rt.static) c.event(podRef(rt), 'Normal', 'Killing', `Container ${crt.name} failed liveness probe, will be restarted`, 'kubelet');
          stopContainer(c, h, rt, crt, 'liveness', { exitCode: 137 });
          crt.restarts++;
          crt.backoffScheduled = false;
          changed = true;
        }
      }
    }
  }
  return changed;
}

function resolveNamedPort(rt, crt, port) {
  if (typeof port === 'number' || /^\d+$/.test(String(port))) return Number(port);
  for (const ct of rt.spec.containers || []) for (const p of ct.ports || []) if (p.name === port) return p.containerPort;
  return null;
}

function runProbe(c, rt, crt, p) {
  if (p.tcpSocket) {
    const port = resolveNamedPort(rt, crt, p.tcpSocket.port);
    const ok = allListening(rt).includes(port);
    return { ok, msg: `dial tcp ${rt.ip}:${port}: connect: connection refused` };
  }
  if (p.httpGet) {
    const port = resolveNamedPort(rt, crt, p.httpGet.port);
    if (!allListening(rt).includes(port)) return { ok: false, msg: `Get "http://${rt.ip}:${port}${p.httpGet.path || '/'}": dial tcp ${rt.ip}:${port}: connect: connection refused` };
    const r = httpProbe(c, rt, port, p.httpGet.path || '/');
    return { ok: r.status >= 200 && r.status < 400, msg: `HTTP probe failed with statuscode: ${r.status}` };
  }
  if (p.exec) {
    const sh = execShell(c, rt, crt.name);
    if (!sh.sh) return { ok: false, msg: sh.error };
    const io = new IO(null);
    const cmd = (p.exec.command || []).map(shQuote).join(' ');
    const g = sh.sh.run(cmd, io);
    let r = g.next();
    let n = 0;
    while (!r.done && n++ < 1000) r = g.next(r.value?.type === 'input' ? null : undefined);
    return { ok: r.done && r.value === 0, msg: `${io.o}${io.e}`.trim() || 'command failed' };
  }
  return { ok: true };
}

export function allListening(rt) {
  return [...rt.main, ...rt.init].filter((x) => x.state === 'running').flatMap((x) => x.listen || []);
}

// powłoka do kubectl exec / sond exec
export function execShell(c, rt, containerName) {
  const crt = [...rt.main, ...rt.init].find((x) => x.name === containerName) || rt.main[0];
  if (!crt || crt.state !== 'running') return { error: `container ${containerName || ''} not running` };
  const spec = [...(rt.spec.containers || []), ...(rt.spec.initContainers || [])].find((x) => x.name === crt.name);
  const info = crt.imageInfo?.info || lookupImage(spec.image).info || { kind: 'shell', bin: [] };
  const fs = buildContainerFs(c, rt, crt, spec);
  const sh = new Shell({ fs, user: 'root', cwd: spec.workingDir || '/', env: crt.env || {}, mode: 'container', commands: containerCommands(info.bin) });
  sh.ctx = { cluster: c, rt, crt, podIP: rt.ip, node: rt.node, inContainer: true };
  sh.onListen = () => {};
  return { sh, crt, info };
}

// =============================================================================== zapis statusów do API
function containerStatus(c, rt, crt) {
  const st = {
    containerID: crt.id ? `containerd://${crt.id}` : undefined,
    image: crt.imageInfo?.n?.full ? displayImage(crt.image, crt.imageInfo.n) : crt.image,
    imageID: crt.imageID || '',
    lastState: crt.last && crt.restarts > 0 ? crt.last : {},
    name: crt.name, ready: !!crt.ready, restartCount: crt.restarts, started: crt.state === 'running' && !!crt.started,
  };
  if (crt.state === 'running') st.state = { running: { startedAt: crt.startedAt } };
  else if (crt.state === 'terminated' && !(crt.backoffUntil && crt.reason === 'CrashLoopBackOff')) {
    st.state = { terminated: { containerID: st.containerID, exitCode: crt.exitCode, finishedAt: crt.finishedAt, reason: crt.reason, startedAt: crt.startedAt || crt.finishedAt, ...(crt.message ? { message: crt.message } : {}) } };
  } else st.state = { waiting: { reason: crt.reason || 'ContainerCreating', ...(crt.message ? { message: crt.message } : {}) } };
  if (!crt.id) delete st.containerID;
  if (!crt.imageID) st.imageID = '';
  return st;
}

function displayImage(orig, n) {
  if (orig.startsWith(n.repo.replace('docker.io/library/', '')) && !orig.includes('/')) return `docker.io/library/${orig.includes(':') ? orig : orig + ':latest'}`;
  return n.full;
}

export function podStatusFromRuntime(c, rt, prev = {}) {
  const now = c.iso();
  const status = { ...prev };
  const main = rt.main.map((x) => containerStatus(c, rt, x));
  const init = rt.init.map((x) => containerStatus(c, rt, x));
  const initDone = rt.initDone || !rt.init.length;
  const allReady = rt.main.length > 0 && rt.main.every((x) => x.ready) && rt.init.filter((x) => x.sidecar).every((x) => x.ready || x.started);
  let phase = rt.phase;
  if (phase !== 'Failed' && phase !== 'Succeeded') {
    phase = rt.main.some((x) => x.state === 'running' || (x.state !== 'waiting' && x.everStarted) || (x.everStarted && x.restarts > 0)) ? 'Running' : 'Pending';
  }
  const prevCond = (t) => (prev.conditions || []).find((x) => x.type === t);
  const cond = (type, s) => ({ lastProbeTime: null, lastTransitionTime: prevCond(type)?.status === s ? prevCond(type).lastTransitionTime : now, status: s, type });
  status.phase = phase;
  status.conditions = [
    cond('PodReadyToStartContainers', rt.sandbox ? 'True' : 'False'),
    cond('Initialized', initDone ? 'True' : 'False'),
    cond('Ready', allReady && phase === 'Running' ? 'True' : 'False'),
    cond('ContainersReady', allReady ? 'True' : 'False'),
    cond('PodScheduled', 'True'),
  ];
  if (!initDone) {
    const w = rt.init.findIndex((x) => !x.done && !(x.sidecar && x.started));
    status.conditions[1].reason = 'ContainersNotInitialized';
    status.conditions[1].message = `containers with incomplete status: [${rt.init.slice(w).filter((x) => !x.sidecar).map((x) => x.name).join(' ')}]`;
  }
  if (!allReady) {
    const nr = rt.main.filter((x) => !x.ready).map((x) => x.name);
    status.conditions[2].reason = phase === 'Succeeded' || phase === 'Failed' ? 'PodCompleted' : 'ContainersNotReady';
    status.conditions[3].reason = status.conditions[2].reason;
    status.conditions[2].message = `containers with unready status: [${nr.join(' ')}]`;
    status.conditions[3].message = status.conditions[2].message;
  }
  status.containerStatuses = main;
  if (init.length) status.initContainerStatuses = init; else delete status.initContainerStatuses;
  const h = c.hosts[rt.node];
  status.hostIP = h.ip;
  status.hostIPs = [{ ip: h.ip }];
  if (rt.ip) { status.podIP = rt.ip; status.podIPs = [{ ip: rt.ip }]; }
  status.startTime = rt.startTime || prev.startTime || now;
  status.qosClass = qosClass(rt.spec);
  if (rt.reason) { status.reason = rt.reason; status.message = rt.message; }
  return status;
}

function writeStatuses(c, h) {
  let changed = false;
  for (const rt of Object.values(c.runtime)) {
    if (rt.node !== h.name || rt.state === 'gone') continue;
    if (rt.static) {
      // pod lustrzany
      const name = rt.name;
      let mirror = c.peek('pods', rt.ns, name);
      if (!mirror || mirror.metadata.annotations?.['kubernetes.io/config.hash'] !== rt.hash) {
        if (mirror) c.remove('pods', rt.ns, name);
        const node = c.peek('nodes', null, h.name);
        const hashId = hexHash(rt.hash, 32);
        mirror = {
          apiVersion: 'v1', kind: 'Pod',
          metadata: {
            name, namespace: rt.ns, labels: rt.meta.labels || {},
            annotations: { ...(rt.meta.annotations || {}), 'kubernetes.io/config.hash': rt.hash, 'kubernetes.io/config.mirror': rt.hash, 'kubernetes.io/config.seen': c.iso(rt.created), 'kubernetes.io/config.source': 'file' },
            ownerReferences: node ? [{ apiVersion: 'v1', controller: true, kind: 'Node', name: h.name, uid: node.metadata.uid }] : undefined,
            uid: `${hashId.slice(0, 8)}-${hashId.slice(8, 12)}-${hashId.slice(12, 16)}-${hashId.slice(16, 20)}-${hashId.slice(20, 32)}`,
          },
          spec: clone(rt.spec),
          status: {},
        };
        if (!mirror.metadata.ownerReferences) delete mirror.metadata.ownerReferences;
        mirror.spec.priority = mirror.spec.priorityClassName === 'system-node-critical' ? 2000001000 : mirror.spec.priorityClassName === 'system-cluster-critical' ? 2000000000 : 0;
        mirror.spec.tolerations = mirror.spec.tolerations || [{ effect: 'NoExecute', operator: 'Exists' }];
        mirror.status = podStatusFromRuntime(c, rt, {});
        c.put(mirror);
        changed = true;
        continue;
      }
      const st = podStatusFromRuntime(c, rt, mirror.status || {});
      if (JSON.stringify(st) !== JSON.stringify(mirror.status)) { mirror.status = st; c.put(mirror); changed = true; }
      continue;
    }
    const pod = c.peek('pods', rt.ns, rt.name);
    if (!pod || pod.metadata.uid !== rt.uid) continue;
    const st = podStatusFromRuntime(c, rt, pod.status || {});
    if (JSON.stringify(st) !== JSON.stringify(pod.status)) {
      pod.status = st;
      c.put(pod);
      changed = true;
    }
  }
  return changed;
}

// =============================================================================== metryki (kubectl top)
export function podMetrics(c, rt) {
  const out = [];
  for (const crt of rt.main) {
    if (crt.state !== 'running') continue;
    const spec = rt.spec.containers.find((x) => x.name === crt.name) || {};
    const info = crt.imageInfo?.info || {};
    const lim = parseQty(spec.resources?.limits?.cpu);
    let cpu = info.cpu ?? 0.0005;
    if (crt.busy) cpu = lim ?? 1;
    if (crt.kind === 'shell' && !crt.busy) cpu = 0;
    const seed = hashStr(crt.id || crt.name) % 1000 / 1000;
    if (!crt.busy) cpu = Math.max(0, cpu + (cpu ? seed * 0.002 : 0));
    let mem = (info.mem || 1) * 1048576 * (0.85 + seed * 0.3);
    const memLim = parseQty(spec.resources?.limits?.memory);
    if (memLim) mem = Math.min(mem, memLim * 0.95);
    out.push({ name: crt.name, cpu, mem });
  }
  return out;
}

export { CONTROL_PLANE, COMPONENTS };
