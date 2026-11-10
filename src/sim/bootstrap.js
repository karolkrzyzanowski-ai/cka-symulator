// Tworzenie świeżego klastra kubeadm v1.37 (3 węzły) + host "base".
import { Cluster } from './cluster.js';
import { Host } from './hosts.js';
import { makeCert, makeKey } from './pki.js';
import { dump } from '../lib/yaml.js';
import { b64enc, clone, seedRandom } from '../lib/util.js';
import { defaultRbac } from './rbac.js';
import { kubeletController, buildContainerFs } from './kubelet.js';
import { schedulerController } from './scheduler.js';
import { KCM_CONTROLLERS } from './controllers.js';
import { ADDON_CONTROLLERS } from './addons.js';
import { startUnit, daemonReload, processReboots } from './systemd.js';
import { gatewayCrds } from './crds.js';

export const K8S = '1.37.1';
export const PKG = `${K8S}-1.1`;
export const ETCD_VER = '3.6.6-0';
export const COREDNS_VER = 'v1.12.4';
export const NODES = [
  { name: 'cka-cp1', ip: '192.168.177.10', role: 'control-plane', cpu: 2, mem: 4096, block: '10.244.95' },
  { name: 'cka-w1', ip: '192.168.177.11', role: 'worker', cpu: 2, mem: 3072, block: '10.244.209' },
  { name: 'cka-w2', ip: '192.168.177.12', role: 'worker', cpu: 2, mem: 3072, block: '10.244.172' },
];
const CP = NODES[0];
const USER = 'candidate';

export function attachControllers(c) {
  c.controllers = [{ name: 'reboot', run: processReboots }, kubeletController, schedulerController, ...KCM_CONTROLLERS, ...ADDON_CONTROLLERS];
  c.buildContainerFs = buildContainerFs;
  return c;
}

// ------------------------------------------------------------------ kubeconfig
export function kubeconfig({ user, cn, o = [], ca, t, server = `https://${CP.ip}:6443`, cluster = 'kubernetes' }) {
  const key = makeKey();
  const cert = makeCert({ cn, o, notBefore: t, days: 365, key });
  return dump({
    apiVersion: 'v1', kind: 'Config',
    clusters: [{ cluster: { 'certificate-authority-data': b64enc(ca), server }, name: cluster }],
    contexts: [{ context: { cluster, user }, name: `${user}@${cluster}` }],
    'current-context': `${user}@${cluster}`,
    preferences: {},
    users: [{ name: user, user: { 'client-certificate-data': b64enc(cert), 'client-key-data': b64enc(key) } }],
  }, { sort: false });
}

// ------------------------------------------------------------------ manifesty statyczne
function staticPod(name, image, command, volumes, extra = {}) {
  return {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { annotations: extra.annotations || {}, labels: { component: name, tier: 'control-plane' }, name, namespace: 'kube-system' },
    spec: {
      containers: [{
        command, image, imagePullPolicy: 'IfNotPresent',
        livenessProbe: { failureThreshold: 8, httpGet: { host: extra.probeHost || '127.0.0.1', path: extra.livePath || '/livez', port: extra.probePort, scheme: extra.scheme || 'HTTPS' }, initialDelaySeconds: 10, periodSeconds: 10, timeoutSeconds: 15 },
        name, resources: { requests: { cpu: extra.cpu || '100m', ...(extra.mem ? { memory: extra.mem } : {}) } },
        startupProbe: { failureThreshold: 24, httpGet: { host: extra.probeHost || '127.0.0.1', path: extra.livePath || '/livez', port: extra.probePort, scheme: extra.scheme || 'HTTPS' }, initialDelaySeconds: 10, periodSeconds: 10, timeoutSeconds: 15 },
        volumeMounts: volumes.map((v) => ({ mountPath: v.mount || v.path, name: v.name, ...(v.ro ? { readOnly: true } : {}) })),
      }],
      hostNetwork: true, priority: 2000001000, priorityClassName: 'system-node-critical',
      securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
      volumes: volumes.map((v) => ({ hostPath: { path: v.path, type: v.type || 'DirectoryOrCreate' }, name: v.name })),
    },
    status: {},
  };
}

export function controlPlaneManifests(version = K8S) {
  const img = (n) => `registry.k8s.io/${n}:v${version}`;
  const etcd = staticPod('etcd', `registry.k8s.io/etcd:${ETCD_VER}`, [
    'etcd', `--advertise-client-urls=https://${CP.ip}:2379`, '--cert-file=/etc/kubernetes/pki/etcd/server.crt', '--client-cert-auth=true',
    '--data-dir=/var/lib/etcd', '--feature-gates=InitialCorruptCheck=true', `--initial-advertise-peer-urls=https://${CP.ip}:2380`,
    `--initial-cluster=cka-cp1=https://${CP.ip}:2380`, '--key-file=/etc/kubernetes/pki/etcd/server.key', `--listen-client-urls=https://127.0.0.1:2379,https://${CP.ip}:2379`,
    '--listen-metrics-urls=http://127.0.0.1:2381', `--listen-peer-urls=https://${CP.ip}:2380`, '--name=cka-cp1', '--peer-cert-file=/etc/kubernetes/pki/etcd/peer.crt',
    '--peer-client-cert-auth=true', '--peer-key-file=/etc/kubernetes/pki/etcd/peer.key', '--peer-trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt',
    '--snapshot-count=10000', '--trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt', '--watch-progress-notify-interval=5s',
  ], [{ name: 'etcd-certs', path: '/etc/kubernetes/pki/etcd' }, { name: 'etcd-data', path: '/var/lib/etcd' }], { probePort: 2381, livePath: '/livez', scheme: 'HTTP', mem: '100Mi', annotations: { 'kubeadm.kubernetes.io/etcd.advertise-client-urls': `https://${CP.ip}:2379` } });
  etcd.spec.containers[0].livenessProbe.httpGet.path = '/livez';
  const apiserver = staticPod('kube-apiserver', img('kube-apiserver'), [
    'kube-apiserver', `--advertise-address=${CP.ip}`, '--allow-privileged=true', '--authorization-mode=Node,RBAC', '--client-ca-file=/etc/kubernetes/pki/ca.crt',
    '--enable-admission-plugins=NodeRestriction', '--enable-bootstrap-token-auth=true', '--etcd-cafile=/etc/kubernetes/pki/etcd/ca.crt',
    '--etcd-certfile=/etc/kubernetes/pki/apiserver-etcd-client.crt', '--etcd-keyfile=/etc/kubernetes/pki/apiserver-etcd-client.key', '--etcd-servers=https://127.0.0.1:2379',
    '--kubelet-client-certificate=/etc/kubernetes/pki/apiserver-kubelet-client.crt', '--kubelet-client-key=/etc/kubernetes/pki/apiserver-kubelet-client.key',
    '--kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname', '--proxy-client-cert-file=/etc/kubernetes/pki/front-proxy-client.crt',
    '--proxy-client-key-file=/etc/kubernetes/pki/front-proxy-client.key', '--requestheader-allowed-names=front-proxy-client',
    '--requestheader-client-ca-file=/etc/kubernetes/pki/front-proxy-ca.crt', '--requestheader-extra-headers-prefix=X-Remote-Extra-',
    '--requestheader-group-headers=X-Remote-Group', '--requestheader-username-headers=X-Remote-User', '--secure-port=6443',
    '--service-account-issuer=https://kubernetes.default.svc.cluster.local', '--service-account-key-file=/etc/kubernetes/pki/sa.pub',
    '--service-account-signing-key-file=/etc/kubernetes/pki/sa.key', '--service-cluster-ip-range=10.96.0.0/12',
    '--tls-cert-file=/etc/kubernetes/pki/apiserver.crt', '--tls-private-key-file=/etc/kubernetes/pki/apiserver.key',
  ], [
    { name: 'ca-certs', path: '/etc/ssl/certs', ro: true }, { name: 'etc-ca-certificates', path: '/etc/ca-certificates', ro: true },
    { name: 'k8s-certs', path: '/etc/kubernetes/pki', ro: true }, { name: 'usr-local-share-ca-certificates', path: '/usr/local/share/ca-certificates', ro: true },
    { name: 'usr-share-ca-certificates', path: '/usr/share/ca-certificates', ro: true },
  ], { probePort: 6443, probeHost: CP.ip, cpu: '250m', annotations: { 'kubeadm.kubernetes.io/kube-apiserver.advertise-address.endpoint': `${CP.ip}:6443` } });
  apiserver.spec.containers[0].readinessProbe = { failureThreshold: 3, httpGet: { host: CP.ip, path: '/readyz', port: 6443, scheme: 'HTTPS' }, periodSeconds: 1, timeoutSeconds: 15 };
  const kcm = staticPod('kube-controller-manager', img('kube-controller-manager'), [
    'kube-controller-manager', '--allocate-node-cidrs=true', '--authentication-kubeconfig=/etc/kubernetes/controller-manager.conf',
    '--authorization-kubeconfig=/etc/kubernetes/controller-manager.conf', '--bind-address=127.0.0.1', '--client-ca-file=/etc/kubernetes/pki/ca.crt',
    '--cluster-cidr=10.244.0.0/16', '--cluster-name=kubernetes', '--cluster-signing-cert-file=/etc/kubernetes/pki/ca.crt',
    '--cluster-signing-key-file=/etc/kubernetes/pki/ca.key', '--controllers=*,bootstrapsigner,tokencleaner', '--kubeconfig=/etc/kubernetes/controller-manager.conf',
    '--leader-elect=true', '--requestheader-client-ca-file=/etc/kubernetes/pki/front-proxy-ca.crt', '--root-ca-file=/etc/kubernetes/pki/ca.crt',
    '--service-account-private-key-file=/etc/kubernetes/pki/sa.key', '--service-cluster-ip-range=10.96.0.0/12', '--use-service-account-credentials=true',
  ], [
    { name: 'ca-certs', path: '/etc/ssl/certs', ro: true }, { name: 'etc-ca-certificates', path: '/etc/ca-certificates', ro: true },
    { name: 'flexvolume-dir', path: '/usr/libexec/kubernetes/kubelet-plugins/volume/exec' }, { name: 'k8s-certs', path: '/etc/kubernetes/pki', ro: true },
    { name: 'kubeconfig', path: '/etc/kubernetes/controller-manager.conf', type: 'FileOrCreate', ro: true },
    { name: 'usr-local-share-ca-certificates', path: '/usr/local/share/ca-certificates', ro: true }, { name: 'usr-share-ca-certificates', path: '/usr/share/ca-certificates', ro: true },
  ], { probePort: 10257, livePath: '/healthz', cpu: '200m' });
  const sched = staticPod('kube-scheduler', img('kube-scheduler'), [
    'kube-scheduler', '--authentication-kubeconfig=/etc/kubernetes/scheduler.conf', '--authorization-kubeconfig=/etc/kubernetes/scheduler.conf',
    '--bind-address=127.0.0.1', '--kubeconfig=/etc/kubernetes/scheduler.conf', '--leader-elect=true',
  ], [{ name: 'kubeconfig', path: '/etc/kubernetes/scheduler.conf', type: 'FileOrCreate', ro: true }], { probePort: 10259, livePath: '/livez' });
  for (const p of [kcm, sched]) delete p.metadata.annotations;
  for (const p of [kcm, sched, apiserver, etcd]) if (p.metadata.annotations && !Object.keys(p.metadata.annotations).length) delete p.metadata.annotations;
  return { 'etcd.yaml': etcd, 'kube-apiserver.yaml': apiserver, 'kube-controller-manager.yaml': kcm, 'kube-scheduler.yaml': sched };
}

// ------------------------------------------------------------------ pliki węzła
const CONTAINERD_CONFIG = `version = 3
root = '/var/lib/containerd'
state = '/run/containerd'
temp = ''
disabled_plugins = []
required_plugins = []
oom_score = 0
imports = []

[grpc]
  address = '/run/containerd/containerd.sock'
  tcp_address = ''
  uid = 0
  gid = 0
  max_recv_message_size = 16777216
  max_send_message_size = 16777216

[ttrpc]
  address = ''
  uid = 0
  gid = 0

[debug]
  address = ''
  uid = 0
  gid = 0
  level = ''
  format = ''

[metrics]
  address = ''
  grpc_histogram = false

[plugins]
  [plugins.'io.containerd.cri.v1.images']
    snapshotter = 'overlayfs'
    disable_snapshot_annotations = true
    discard_unpacked_layers = false
    max_concurrent_downloads = 3
    image_pull_progress_timeout = '5m0s'
    image_pull_with_sync_fs = false
    stats_collect_period = 10

    [plugins.'io.containerd.cri.v1.images'.pinned_images]
      sandbox = 'registry.k8s.io/pause:3.10.1'

    [plugins.'io.containerd.cri.v1.images'.registry]
      config_path = '/etc/containerd/certs.d'

  [plugins.'io.containerd.cri.v1.runtime']
    enable_selinux = false
    selinux_category_range = 1024
    max_container_log_line_size = 16384
    disable_apparmor = false
    restrict_oom_score_adj = false
    disable_proc_mount = false
    unset_seccomp_profile = ''
    tolerate_missing_hugetlb_controller = true
    disable_hugetlb_controller = true
    device_ownership_from_security_context = false
    ignore_image_defined_volumes = false
    netns_mounts_under_state_dir = false
    enable_unprivileged_ports = true
    enable_unprivileged_icmp = true
    enable_cdi = true
    cdi_spec_dirs = ['/etc/cdi', '/var/run/cdi']
    drain_exec_sync_io_timeout = '0s'
    ignore_deprecation_warnings = []

    [plugins.'io.containerd.cri.v1.runtime'.containerd]
      default_runtime_name = 'runc'
      ignore_blockio_not_enabled_errors = false
      ignore_rdt_not_enabled_errors = false

      [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes]
        [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runc]
          runtime_type = 'io.containerd.runc.v2'
          runtime_path = ''
          pod_annotations = []
          container_annotations = []
          privileged_without_host_devices = false
          privileged_without_host_devices_all_devices_allowed = false
          base_runtime_spec = ''
          cni_conf_dir = ''
          cni_max_conf_num = 0
          snapshotter = ''
          sandboxer = 'podsandbox'
          io_type = ''

          [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runc.options]
            BinaryName = ''
            CriuImagePath = ''
            CriuWorkPath = ''
            IoGid = 0
            IoUid = 0
            NoNewKeyring = false
            Root = ''
            ShimCgroup = ''
            SystemdCgroup = true

    [plugins.'io.containerd.cri.v1.runtime'.cni]
      bin_dir = ''
      bin_dirs = ['/opt/cni/bin']
      conf_dir = '/etc/cni/net.d'
      max_conf_num = 1
      setup_serially = false
      conf_template = ''
      ip_pref = ''
      use_internal_loopback = false
`;

const KUBEADM_DROPIN = `# kubeadm drop-in for the kubelet unit
[Service]
Environment="KUBELET_KUBECONFIG_ARGS=--bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf --kubeconfig=/etc/kubernetes/kubelet.conf"
Environment="KUBELET_CONFIG_ARGS=--config=/var/lib/kubelet/config.yaml"
# flags written by "kubeadm init" / "kubeadm join"
EnvironmentFile=-/var/lib/kubelet/kubeadm-flags.env
# optional user overrides (KUBELET_EXTRA_ARGS)
EnvironmentFile=-/etc/default/kubelet
ExecStart=
ExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS
`;

const KUBELET_SERVICE = `[Unit]
Description=kubelet: The Kubernetes Node Agent
Documentation=https://kubernetes.io/docs/
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=/usr/bin/kubelet
Restart=always
StartLimitInterval=0
RestartSec=10

[Install]
WantedBy=multi-user.target
`;

const CONTAINERD_SERVICE = `[Unit]
Description=containerd container runtime
Documentation=https://containerd.io
After=network.target dbus.service

[Service]
ExecStartPre=-/sbin/modprobe overlay
ExecStart=/usr/local/bin/containerd

Type=notify
Delegate=yes
KillMode=process
Restart=always
RestartSec=5

LimitNPROC=infinity
LimitCORE=infinity

TasksMax=infinity
OOMScoreAdjust=-999

[Install]
WantedBy=multi-user.target
`;

export function kubeletConfigYaml() {
  return `apiVersion: kubelet.config.k8s.io/v1beta1
authentication:
  anonymous:
    enabled: false
  webhook:
    cacheTTL: 0s
    enabled: true
  x509:
    clientCAFile: /etc/kubernetes/pki/ca.crt
authorization:
  mode: Webhook
  webhook:
    cacheAuthorizedTTL: 0s
    cacheUnauthorizedTTL: 0s
cgroupDriver: systemd
clusterDNS:
- 10.96.0.10
clusterDomain: cluster.local
containerRuntimeEndpoint: unix:///var/run/containerd/containerd.sock
cpuManagerReconcilePeriod: 0s
crashLoopBackOff: {}
evictionPressureTransitionPeriod: 0s
fileCheckFrequency: 0s
healthzBindAddress: 127.0.0.1
healthzPort: 10248
httpCheckFrequency: 0s
imageMaximumGCAge: 0s
imageMinimumGCAge: 0s
kind: KubeletConfiguration
logging:
  flushFrequency: 0
  options:
    json:
      infoBufferSize: "0"
    text:
      infoBufferSize: "0"
  verbosity: 0
memorySwap: {}
nodeStatusReportFrequency: 0s
nodeStatusUpdateFrequency: 0s
resolvConf: /run/systemd/resolve/resolv.conf
rotateCertificates: true
runtimeRequestTimeout: 0s
shutdownGracePeriod: 0s
shutdownGracePeriodCriticalPods: 0s
staticPodPath: /etc/kubernetes/manifests
streamingConnectionIdleTimeout: 0s
syncFrequency: 0s
volumeStatsAggPeriod: 0s
`;
}

const CALICO_CONFLIST = `{
  "name": "k8s-pod-network",
  "cniVersion": "0.3.1",
  "plugins": [
    {
      "type": "calico",
      "log_level": "info",
      "log_file_path": "/var/log/calico/cni/cni.log",
      "datastore_type": "kubernetes",
      "nodename": "__KUBERNETES_NODE_NAME__",
      "mtu": 0,
      "ipam": {
          "type": "calico-ipam"
      },
      "policy": {
          "type": "k8s"
      },
      "kubernetes": {
          "kubeconfig": "/etc/cni/net.d/calico-kubeconfig"
      }
    },
    {
      "type": "portmap",
      "snat": true,
      "capabilities": {"portMappings": true}
    },
    {
      "type": "bandwidth",
      "capabilities": {"bandwidth": true}
    }
  ]
}
`;

export const BASHRC = `# ~/.bashrc
case $- in
    *i*) ;;
      *) return;;
esac
HISTSIZE=1000
HISTFILESIZE=2000
PS1='\\u@\\h:\\w\\$ '
# >>> cka-lab >>>
source <(kubectl completion bash)
alias k=kubectl
complete -o default -F __start_kubectl k
export EDITOR=vim
# <<< cka-lab <<<
`;

function buildNodeFs(c, h, pki, t) {
  const fs = h.fs;
  const isCp = h.role === 'control-plane';
  for (const d of ['/tmp', '/var/tmp']) { fs.mkdir(d, { p: true }); fs.chmod(d, 0o1777); }
  fs.mkdir('/root', { p: true, mode: 0o700 });
  fs.mkdir(`/home/${USER}`, { p: true, owner: USER, mode: 0o750 });
  fs.mkdir('/opt/cka', { p: true, owner: USER });
  fs.put('/etc/hostname', `${h.name}\n`);
  fs.put('/etc/hosts', `127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n${NODES.map((n) => `${n.ip} ${n.name}`).join('\n')}\n`);
  fs.put('/etc/os-release', 'PRETTY_NAME="Ubuntu 24.04.5 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nVERSION="24.04.5 LTS (Noble Numbat)"\nVERSION_CODENAME=noble\nID=ubuntu\nID_LIKE=debian\n');
  fs.put('/etc/resolv.conf', 'nameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n');
  fs.put('/run/systemd/resolve/resolv.conf', 'nameserver 192.168.177.1\nsearch .\n');
  fs.put(`/home/${USER}/.bashrc`, BASHRC, { owner: USER });
  fs.put(`/home/${USER}/.profile`, '# ~/.profile\nif [ -n "$BASH_VERSION" ] && [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi\n', { owner: USER });
  fs.put('/root/.bashrc', BASHRC);
  fs.put(`/home/${USER}/.vimrc`, 'set expandtab\nset tabstop=2\nset shiftwidth=2\n', { owner: USER });
  // binaria
  for (const b of ['/usr/bin/kubeadm', '/usr/bin/kubelet', '/usr/bin/kubectl', '/usr/bin/crictl', '/usr/local/bin/containerd', '/usr/local/bin/containerd-shim-runc-v2', '/usr/local/bin/ctr', '/usr/local/sbin/runc', '/usr/local/bin/helm', '/usr/local/bin/yq']) fs.put(b, '\x7fELF', { mode: 0o755 });
  if (isCp) for (const b of ['/usr/local/bin/etcdctl', '/usr/local/bin/etcdutl']) fs.put(b, '\x7fELF', { mode: 0o755 });
  for (const b of ['bandwidth', 'bridge', 'calico', 'calico-ipam', 'dhcp', 'firewall', 'host-device', 'host-local', 'ipvlan', 'loopback', 'macvlan', 'portmap', 'ptp', 'sbr', 'static', 'tap', 'tuning', 'vlan', 'vrf']) fs.put(`/opt/cni/bin/${b}`, '\x7fELF', { mode: 0o755 });
  // systemd
  fs.put('/usr/lib/systemd/system/kubelet.service', KUBELET_SERVICE);
  fs.put('/usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf', KUBEADM_DROPIN);
  fs.put('/usr/local/lib/systemd/system/containerd.service', CONTAINERD_SERVICE);
  fs.mkdir('/etc/systemd/system', { p: true });
  fs.put('/etc/containerd/config.toml', CONTAINERD_CONFIG);
  fs.put('/etc/containerd/certs.d/docker.io/hosts.toml', 'server = "https://registry-1.docker.io"\n\n[host."https://mirror.gcr.io"]\n  capabilities = ["pull", "resolve"]\n');
  fs.put('/etc/crictl.yaml', 'runtime-endpoint: unix:///run/containerd/containerd.sock\nimage-endpoint: unix:///run/containerd/containerd.sock\ntimeout: 10\n');
  fs.put('/etc/modules-load.d/k8s.conf', 'overlay\nbr_netfilter\n');
  fs.put('/etc/sysctl.d/k8s.conf', 'net.bridge.bridge-nf-call-iptables  = 1\nnet.bridge.bridge-nf-call-ip6tables = 1\nnet.ipv4.ip_forward                 = 1\n');
  fs.put('/etc/apt/sources.list.d/kubernetes.list', 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.37/deb/ /\n');
  fs.put('/etc/apt/keyrings/kubernetes-apt-keyring.gpg', 'gpg-keyring');
  fs.put('/etc/fstab', 'LABEL=cloudimg-rootfs\t/\t ext4\tdiscard,commit=30,errors=remount-ro\t0 1\nLABEL=UEFI\t/boot/efi\tvfat\tumask=0077\t0 1\n');
  // kubelet
  fs.put('/var/lib/kubelet/config.yaml', kubeletConfigYaml());
  fs.put('/var/lib/kubelet/kubeadm-flags.env', `KUBELET_KUBEADM_ARGS="--node-ip=${h.ip}"\n`);
  fs.mkdir('/var/lib/kubelet/pki', { p: true });
  fs.put('/var/lib/kubelet/pki/kubelet-client-current.pem', makeCert({ cn: `system:node:${h.name}`, o: ['system:nodes'], notBefore: t, days: 365 }) + makeKey());
  fs.put('/var/lib/kubelet/pki/kubelet.crt', makeCert({ cn: `${h.name}@${Math.floor(t / 1000)}`, issuer: `${h.name}-ca@${Math.floor(t / 1000)}`, notBefore: t, days: 365 }));
  fs.put('/var/lib/kubelet/pki/kubelet.key', makeKey());
  fs.mkdir('/etc/kubernetes/manifests', { p: true });
  fs.put('/etc/kubernetes/pki/ca.crt', pki.ca.crt);
  fs.put('/etc/kubernetes/kubelet.conf', kubeconfig({ user: `system:node:${h.name}`, cn: `system:node:${h.name}`, o: ['system:nodes'], ca: pki.ca.crt, t }), { mode: 0o600 });
  // CNI
  fs.put('/etc/cni/net.d/10-calico.conflist', CALICO_CONFLIST.replace('__KUBERNETES_NODE_NAME__', h.name));
  fs.put('/etc/cni/net.d/calico-kubeconfig', 'apiVersion: v1\nkind: Config\nclusters:\n- name: local\n  cluster:\n    server: https://10.96.0.1:443\n', { mode: 0o600 });
  fs.mkdir('/var/lib/calico', { p: true });
  fs.put('/var/lib/calico/nodename', h.name);
  fs.mkdir('/var/log/pods', { p: true });
  fs.mkdir('/var/log/containers', { p: true });
  fs.mkdir('/run/containerd', { p: true });
  if (isCp) {
    for (const [name, v] of Object.entries(pki.files)) fs.put(`/etc/kubernetes/pki/${name}`, v, { mode: name.endsWith('.key') ? 0o600 : 0o644 });
    for (const [name, txt] of Object.entries(pki.kubeconfigs)) fs.put(`/etc/kubernetes/${name}`, txt, { mode: 0o600 });
    for (const [file, m] of Object.entries(controlPlaneManifests())) fs.put(`/etc/kubernetes/manifests/${file}`, dump(m, { sort: true }), { mode: 0o600 });
    fs.mkdir('/var/lib/etcd/member/snap', { p: true });
    fs.mkdir('/var/lib/etcd/member/wal', { p: true });
    fs.put('/root/.kube/config', pki.kubeconfigs['admin.conf'], { mode: 0o600 });
  }
  fs.put(`/home/${USER}/.kube/config`, pki.kubeconfigs['admin.conf'], { mode: 0o600, owner: USER });
  fs.chown(`/home/${USER}`, USER);
  // pakiety
  h.packages = { kubeadm: PKG, kubelet: PKG, kubectl: PKG, 'cri-tools': '1.37.0-1.1', containerd: '2.4.2', runc: '1.5.2', helm: '4.3.1', yq: '4.54.1' };
  h.holds = ['kubeadm', 'kubelet', 'kubectl'];
  h.apt = { updated: false, minor: '1.37' };
  h.images = [
    'registry.k8s.io/pause:3.10.1', 'registry.k8s.io/kube-proxy:v1.37.1', 'docker.io/calico/node:v3.32.3', 'docker.io/calico/cni:v3.32.3',
    'docker.io/library/nginx:1.27-alpine', 'docker.io/library/nginx:1.28-alpine', 'docker.io/library/busybox:1.36',
    ...(isCp ? [`registry.k8s.io/etcd:${ETCD_VER}`, 'registry.k8s.io/kube-apiserver:v1.37.1', 'registry.k8s.io/kube-controller-manager:v1.37.1', 'registry.k8s.io/kube-scheduler:v1.37.1', `registry.k8s.io/coredns/coredns:${COREDNS_VER}`] : []),
  ];
}

function buildBaseFs(h) {
  const fs = h.fs;
  for (const d of ['/tmp']) { fs.mkdir(d, { p: true }); fs.chmod(d, 0o1777); }
  fs.mkdir('/root', { p: true, mode: 0o700 });
  fs.mkdir(`/home/${USER}`, { p: true, owner: USER });
  fs.put('/etc/hostname', 'base\n');
  fs.put('/etc/hosts', `127.0.0.1 localhost\n${NODES.map((n) => `${n.ip} ${n.name}`).join('\n')}\n`);
  fs.put(`/home/${USER}/.bashrc`, '# ~/.bashrc\nPS1=\'\\u@\\h:\\w\\$ \'\n', { owner: USER });
  fs.mkdir(`/home/${USER}/.ssh`, { p: true, owner: USER, mode: 0o700 });
  fs.put(`/home/${USER}/.ssh/config`, 'Host *\n  StrictHostKeyChecking no\n', { owner: USER });
  fs.put('/etc/os-release', 'PRETTY_NAME="Ubuntu 24.04.5 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\n');
}

// ------------------------------------------------------------------ obiekty API
const meta = (name, ns, labels, annotations) => ({ name, ...(ns ? { namespace: ns } : {}), ...(labels ? { labels } : {}), ...(annotations ? { annotations } : {}) });
const CRIT_TOL = [{ key: 'CriticalAddonsOnly', operator: 'Exists' }, { effect: 'NoSchedule', key: 'node-role.kubernetes.io/control-plane' }];

function deploy(name, ns, labels, containers, extra = {}) {
  return { apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta(name, ns, labels, extra.annotations), spec: { replicas: extra.replicas ?? 1, selector: { matchLabels: extra.selector || labels }, strategy: extra.strategy, template: { metadata: { labels: extra.podLabels || labels }, spec: { containers, ...(extra.spec || {}) } } } };
}

function systemObjects(pki) {
  const out = [];
  const add = (o) => out.push(o);
  for (const ns of ['default', 'kube-system', 'kube-public', 'kube-node-lease', 'local-path-storage', 'nginx-gateway', 'ingress-nginx']) {
    const labels = ns === 'ingress-nginx' ? { 'app.kubernetes.io/instance': 'ingress-nginx', 'app.kubernetes.io/name': 'ingress-nginx' } : undefined;
    add({ apiVersion: 'v1', kind: 'Namespace', metadata: meta(ns, null, labels) });
  }
  for (const o of defaultRbac()) add(o);
  add({ apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: meta('system-cluster-critical'), value: 2000000000, description: 'Critical cluster add-ons that may be rescheduled to another node.', preemptionPolicy: 'PreemptLowerPriority' });
  add({ apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: meta('system-node-critical'), value: 2000001000, description: 'Critical node-level pods that must stay on their node.', preemptionPolicy: 'PreemptLowerPriority' });
  // usługa kubernetes
  add({ apiVersion: 'v1', kind: 'Service', metadata: meta('kubernetes', 'default', { component: 'apiserver', provider: 'kubernetes' }), spec: { clusterIP: '10.96.0.1', ports: [{ name: 'https', port: 443, protocol: 'TCP', targetPort: 6443 }], type: 'ClusterIP' } });
  add({ apiVersion: 'discovery.k8s.io/v1', kind: 'EndpointSlice', metadata: meta('kubernetes', 'default', { 'endpointslice.kubernetes.io/skip-mirror': 'true', 'kubernetes.io/service-name': 'kubernetes' }), addressType: 'IPv4', endpoints: [{ addresses: [CP.ip], conditions: { ready: true } }], ports: [{ name: 'https', port: 6443, protocol: 'TCP' }] });
  add({ apiVersion: 'v1', kind: 'Endpoints', metadata: meta('kubernetes', 'default', { 'endpointslice.kubernetes.io/skip-mirror': 'true' }), subsets: [{ addresses: [{ ip: CP.ip }], ports: [{ name: 'https', port: 6443, protocol: 'TCP' }] }] });
  // kubeadm
  add({ apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('kubeadm-config', 'kube-system'), data: { ClusterConfiguration: `apiServer: {}\napiVersion: kubeadm.k8s.io/v1beta4\ncaCertificateValidityPeriod: 87600h0m0s\ncertificateValidityPeriod: 8760h0m0s\ncertificatesDir: /etc/kubernetes/pki\nclusterName: kubernetes\ncontrollerManager: {}\ndns: {}\nencryptionAlgorithm: RSA-2048\netcd:\n  local:\n    dataDir: /var/lib/etcd\nimageRepository: registry.k8s.io\nkind: ClusterConfiguration\nkubernetesVersion: v${K8S}\nnetworking:\n  dnsDomain: cluster.local\n  podSubnet: 10.244.0.0/16\n  serviceSubnet: 10.96.0.0/12\nproxy: {}\nscheduler: {}\n` } });
  add({ apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('kubelet-config', 'kube-system'), data: { kubelet: kubeletConfigYaml() } });
  add({ apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('cluster-info', 'kube-public'), data: { kubeconfig: `apiVersion: v1\nclusters:\n- cluster:\n    certificate-authority-data: ${b64enc(pki.ca.crt)}\n    server: https://${CP.ip}:6443\n  name: ""\ncontexts: null\ncurrent-context: ""\nkind: Config\npreferences: {}\nusers: null\n` } });
  // CoreDNS
  add({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta('coredns', 'kube-system') });
  add({ apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('coredns', 'kube-system'), data: { Corefile: COREFILE } });
  add(deploy('coredns', 'kube-system', { 'k8s-app': 'kube-dns' }, [{
    name: 'coredns', image: `registry.k8s.io/coredns/coredns:${COREDNS_VER}`, args: ['-conf', '/etc/coredns/Corefile'],
    ports: [{ containerPort: 53, name: 'dns', protocol: 'UDP' }, { containerPort: 53, name: 'dns-tcp', protocol: 'TCP' }, { containerPort: 9153, name: 'metrics', protocol: 'TCP' }, { containerPort: 8080, name: 'liveness-probe', protocol: 'TCP' }, { containerPort: 8181, name: 'readiness-probe', protocol: 'TCP' }],
    resources: { limits: { memory: '170Mi' }, requests: { cpu: '100m', memory: '70Mi' } },
    readinessProbe: { httpGet: { path: '/ready', port: 'readiness-probe', scheme: 'HTTP' }, periodSeconds: 10 },
    livenessProbe: { failureThreshold: 5, httpGet: { path: '/health', port: 'liveness-probe', scheme: 'HTTP' }, initialDelaySeconds: 60, periodSeconds: 10, successThreshold: 1, timeoutSeconds: 5 },
    volumeMounts: [{ mountPath: '/etc/coredns', name: 'config-volume', readOnly: true }],
  }], { replicas: 2, strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: 1 } }, spec: { priorityClassName: 'system-cluster-critical', serviceAccountName: 'coredns', tolerations: CRIT_TOL, nodeSelector: { 'kubernetes.io/os': 'linux' }, dnsPolicy: 'Default', volumes: [{ configMap: { items: [{ key: 'Corefile', path: 'Corefile' }], name: 'coredns' }, name: 'config-volume' }], affinity: { podAntiAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [{ podAffinityTerm: { labelSelector: { matchExpressions: [{ key: 'k8s-app', operator: 'In', values: ['kube-dns'] }] }, topologyKey: 'kubernetes.io/hostname' }, weight: 100 }] } } } }));
  add({ apiVersion: 'v1', kind: 'Service', metadata: meta('kube-dns', 'kube-system', { 'k8s-app': 'kube-dns', 'kubernetes.io/cluster-service': 'true', 'kubernetes.io/name': 'CoreDNS' }, { 'prometheus.io/port': '9153', 'prometheus.io/scrape': 'true' }), spec: { clusterIP: '10.96.0.10', ports: [{ name: 'dns', port: 53, protocol: 'UDP', targetPort: 53 }, { name: 'dns-tcp', port: 53, protocol: 'TCP', targetPort: 53 }, { name: 'metrics', port: 9153, protocol: 'TCP', targetPort: 9153 }], selector: { 'k8s-app': 'kube-dns' } } });
  // kube-proxy
  add({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta('kube-proxy', 'kube-system') });
  add({ apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('kube-proxy', 'kube-system', { app: 'kube-proxy' }), data: { 'config.conf': 'apiVersion: kubeproxy.config.k8s.io/v1alpha1\nbindAddress: 0.0.0.0\nclusterCIDR: 10.244.0.0/16\nkind: KubeProxyConfiguration\nmode: ""\n' } });
  add({ apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: meta('kube-proxy', 'kube-system', { 'k8s-app': 'kube-proxy' }), spec: { selector: { matchLabels: { 'k8s-app': 'kube-proxy' } }, template: { metadata: { labels: { 'k8s-app': 'kube-proxy' } }, spec: { containers: [{ name: 'kube-proxy', image: `registry.k8s.io/kube-proxy:v${K8S}`, command: ['/usr/local/bin/kube-proxy', '--config=/var/lib/kube-proxy/config.conf', '--hostname-override=$(NODE_NAME)'], env: [{ name: 'NODE_NAME', valueFrom: { fieldRef: { apiVersion: 'v1', fieldPath: 'spec.nodeName' } } }], securityContext: { privileged: true }, volumeMounts: [{ mountPath: '/var/lib/kube-proxy', name: 'kube-proxy' }] }], hostNetwork: true, nodeSelector: { 'kubernetes.io/os': 'linux' }, priorityClassName: 'system-node-critical', serviceAccountName: 'kube-proxy', tolerations: [{ operator: 'Exists' }], volumes: [{ configMap: { name: 'kube-proxy' }, name: 'kube-proxy' }] } } } });
  // Calico
  add({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta('calico-node', 'kube-system') });
  add({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta('calico-kube-controllers', 'kube-system') });
  add({ apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('calico-config', 'kube-system'), data: { calico_backend: 'bird', cni_network_config: '{ "name": "k8s-pod-network", "cniVersion": "0.3.1" }', typha_service_name: 'none', veth_mtu: '0' } });
  add({ apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: meta('calico-node', 'kube-system', { 'k8s-app': 'calico-node' }), spec: { selector: { matchLabels: { 'k8s-app': 'calico-node' } }, template: { metadata: { labels: { 'k8s-app': 'calico-node' } }, spec: { containers: [{ name: 'calico-node', image: 'docker.io/calico/node:v3.32.3', env: [{ name: 'DATASTORE_TYPE', value: 'kubernetes' }, { name: 'CALICO_IPV4POOL_CIDR', value: '10.244.0.0/16' }, { name: 'CALICO_IPV4POOL_IPIP', value: 'Always' }, { name: 'FELIX_DEFAULTENDPOINTTOHOSTACTION', value: 'ACCEPT' }], resources: { requests: { cpu: '250m' } }, securityContext: { privileged: true } }], hostNetwork: true, initContainers: [{ name: 'install-cni', image: 'docker.io/calico/cni:v3.32.3', command: ['/opt/cni/bin/install'] }], nodeSelector: { 'kubernetes.io/os': 'linux' }, priorityClassName: 'system-node-critical', serviceAccountName: 'calico-node', terminationGracePeriodSeconds: 0, tolerations: [{ effect: 'NoSchedule', operator: 'Exists' }, { key: 'CriticalAddonsOnly', operator: 'Exists' }, { effect: 'NoExecute', operator: 'Exists' }] } } } });
  add(deploy('calico-kube-controllers', 'kube-system', { 'k8s-app': 'calico-kube-controllers' }, [{ name: 'calico-kube-controllers', image: 'docker.io/calico/kube-controllers:v3.32.3', env: [{ name: 'ENABLED_CONTROLLERS', value: 'node,loadbalancer' }, { name: 'DATASTORE_TYPE', value: 'kubernetes' }] }], { strategy: { type: 'Recreate' }, spec: { nodeSelector: { 'kubernetes.io/os': 'linux' }, priorityClassName: 'system-cluster-critical', serviceAccountName: 'calico-kube-controllers', tolerations: [{ key: 'CriticalAddonsOnly', operator: 'Exists' }, { effect: 'NoSchedule', key: 'node-role.kubernetes.io/master' }, { effect: 'NoSchedule', key: 'node-role.kubernetes.io/control-plane' }] } }));
  // metrics-server
  add({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta('metrics-server', 'kube-system', { 'k8s-app': 'metrics-server' }) });
  add(deploy('metrics-server', 'kube-system', { 'k8s-app': 'metrics-server' }, [{ name: 'metrics-server', image: 'registry.k8s.io/metrics-server/metrics-server:v0.9.1', args: ['--cert-dir=/tmp', '--secure-port=10250', '--kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname', '--kubelet-use-node-status-port', '--metric-resolution=15s', '--kubelet-insecure-tls'], ports: [{ containerPort: 10250, name: 'https', protocol: 'TCP' }], resources: { requests: { cpu: '100m', memory: '200Mi' } } }], { strategy: { rollingUpdate: { maxUnavailable: 0 } }, spec: { nodeSelector: { 'kubernetes.io/os': 'linux' }, priorityClassName: 'system-cluster-critical', serviceAccountName: 'metrics-server' } }));
  add({ apiVersion: 'v1', kind: 'Service', metadata: meta('metrics-server', 'kube-system', { 'k8s-app': 'metrics-server' }), spec: { ports: [{ name: 'https', port: 443, protocol: 'TCP', targetPort: 'https' }], selector: { 'k8s-app': 'metrics-server' } } });
  // local-path-provisioner
  add({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta('local-path-provisioner-service-account', 'local-path-storage') });
  add({ apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('local-path-config', 'local-path-storage'), data: { 'config.json': '{\n        "nodePathMap":[\n        {\n                "node":"DEFAULT_PATH_FOR_NON_LISTED_NODES",\n                "paths":["/opt/local-path-provisioner"]\n        }\n        ]\n}' } });
  add(deploy('local-path-provisioner', 'local-path-storage', { app: 'local-path-provisioner' }, [{ name: 'local-path-provisioner', image: 'docker.io/rancher/local-path-provisioner:v0.0.37', command: ['local-path-provisioner', '--debug', 'start', '--config', '/etc/config/config.json'], env: [{ name: 'POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } }] }], { spec: { serviceAccountName: 'local-path-provisioner-service-account' } }));
  add({ apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: meta('local-path', null, null, { 'storageclass.kubernetes.io/is-default-class': 'true' }), provisioner: 'rancher.io/local-path', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer' });
  // Gateway API + NGINX Gateway Fabric
  for (const crd of gatewayCrds()) add(crd);
  add({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta('ngf-nginx-gateway-fabric', 'nginx-gateway', { 'app.kubernetes.io/instance': 'ngf', 'app.kubernetes.io/name': 'nginx-gateway-fabric' }) });
  const ngfLabels = { 'app.kubernetes.io/instance': 'ngf', 'app.kubernetes.io/name': 'nginx-gateway-fabric' };
  add(deploy('ngf-nginx-gateway-fabric', 'nginx-gateway', ngfLabels, [{ name: 'nginx-gateway', image: 'ghcr.io/nginx/nginx-gateway-fabric:2.8.0', args: ['controller', '--gateway-ctlr-name=gateway.nginx.org/nginx-gateway-controller', '--gatewayclass=nginx', '--config=ngf-config', '--service=ngf-nginx-gateway-fabric', '--agent-tls-secret=agent-tls'], ports: [{ containerPort: 8443, name: 'agent-grpc' }, { containerPort: 9113, name: 'metrics' }] }], { annotations: { 'meta.helm.sh/release-name': 'ngf', 'meta.helm.sh/release-namespace': 'nginx-gateway' }, spec: { serviceAccountName: 'ngf-nginx-gateway-fabric' } }));
  add({ apiVersion: 'v1', kind: 'Service', metadata: meta('ngf-nginx-gateway-fabric', 'nginx-gateway', ngfLabels), spec: { ports: [{ name: 'agent-grpc', port: 443, protocol: 'TCP', targetPort: 8443 }], selector: ngfLabels } });
  add({ apiVersion: 'gateway.networking.k8s.io/v1', kind: 'GatewayClass', metadata: meta('nginx', null, ngfLabels, { 'meta.helm.sh/release-name': 'ngf', 'meta.helm.sh/release-namespace': 'nginx-gateway' }), spec: { controllerName: 'gateway.nginx.org/nginx-gateway-controller', parametersRef: { group: 'gateway.nginx.org', kind: 'NginxProxy', name: 'ngf-proxy-config', namespace: 'nginx-gateway' } } });
  add({ apiVersion: 'v1', kind: 'Secret', type: 'helm.sh/release.v1', metadata: meta('sh.helm.release.v1.ngf.v1', 'nginx-gateway', { name: 'ngf', owner: 'helm', status: 'deployed', version: '1' }), data: { release: b64enc(JSON.stringify({ name: 'ngf', namespace: 'nginx-gateway', version: 1, chart: 'nginx-gateway-fabric', chartVersion: '2.8.0', appVersion: '2.8.0', status: 'deployed', values: { nginx: { service: { type: 'NodePort', externalTrafficPolicy: 'Cluster' } } }, updated: 0 })) } });
  // ingress-nginx
  const ingLabels = { 'app.kubernetes.io/component': 'controller', 'app.kubernetes.io/instance': 'ingress-nginx', 'app.kubernetes.io/name': 'ingress-nginx' };
  add({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta('ingress-nginx', 'ingress-nginx', ingLabels) });
  add({ apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('ingress-nginx-controller', 'ingress-nginx', ingLabels), data: {} });
  add(deploy('ingress-nginx-controller', 'ingress-nginx', ingLabels, [{ name: 'controller', image: 'registry.k8s.io/ingress-nginx/controller:v1.15.1', args: ['/nginx-ingress-controller', '--election-id=ingress-nginx-leader', '--controller-class=k8s.io/ingress-nginx', '--ingress-class=nginx', '--configmap=$(POD_NAMESPACE)/ingress-nginx-controller', '--validating-webhook=:8443', '--validating-webhook-certificate=/usr/local/certificates/cert', '--validating-webhook-key=/usr/local/certificates/key'], env: [{ name: 'POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } }], ports: [{ containerPort: 80, name: 'http', protocol: 'TCP' }, { containerPort: 443, name: 'https', protocol: 'TCP' }, { containerPort: 8443, name: 'webhook', protocol: 'TCP' }], resources: { requests: { cpu: '100m', memory: '90Mi' } } }], { spec: { nodeSelector: { 'kubernetes.io/os': 'linux' }, serviceAccountName: 'ingress-nginx' } }));
  add({ apiVersion: 'v1', kind: 'Service', metadata: meta('ingress-nginx-controller', 'ingress-nginx', ingLabels), spec: { type: 'NodePort', ports: [{ appProtocol: 'http', name: 'http', port: 80, protocol: 'TCP', targetPort: 'http', nodePort: 31080 }, { appProtocol: 'https', name: 'https', port: 443, protocol: 'TCP', targetPort: 'https', nodePort: 31443 }], selector: ingLabels } });
  add({ apiVersion: 'v1', kind: 'Service', metadata: meta('ingress-nginx-controller-admission', 'ingress-nginx', ingLabels), spec: { ports: [{ appProtocol: 'https', name: 'https-webhook', port: 443, targetPort: 'webhook' }], selector: ingLabels } });
  add({ apiVersion: 'networking.k8s.io/v1', kind: 'IngressClass', metadata: meta('nginx', null, ingLabels), spec: { controller: 'k8s.io/ingress-nginx' } });
  return out;
}

export const COREFILE = `.:53 {
    errors
    health {
       lameduck 5s
    }
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
       pods insecure
       fallthrough in-addr.arpa ip6.arpa
       ttl 30
    }
    prometheus :9153
    forward . /etc/resolv.conf {
       max_concurrent 1000
    }
    cache 30 {
       disable success cluster.local
       disable denial cluster.local
    }
    loop
    reload
    loadbalance
}
`;

// ------------------------------------------------------------------ PKI
function buildPki(t) {
  const mkCa = (cn) => { const key = makeKey(); return { key, crt: makeCert({ cn, issuer: cn, notBefore: t, days: 3650, ca: true, key }) }; };
  const ca = mkCa('kubernetes');
  const etcdCa = mkCa('etcd-ca');
  const fpCa = mkCa('front-proxy-ca');
  const files = {
    'ca.crt': ca.crt, 'ca.key': ca.key, 'front-proxy-ca.crt': fpCa.crt, 'front-proxy-ca.key': fpCa.key,
    'etcd/ca.crt': etcdCa.crt, 'etcd/ca.key': etcdCa.key, 'sa.key': makeKey(), 'sa.pub': '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsimulated\n-----END PUBLIC KEY-----\n',
  };
  const leaf = (path, cn, issuer, o = [], san = []) => { const key = makeKey(); files[`${path}.key`] = key; files[`${path}.crt`] = makeCert({ cn, o, issuer, notBefore: t, days: 365, san, key }); };
  leaf('apiserver', 'kube-apiserver', 'kubernetes', [], ['cka-cp1', 'kubernetes', 'kubernetes.default', 'kubernetes.default.svc', 'kubernetes.default.svc.cluster.local', '10.96.0.1', CP.ip]);
  leaf('apiserver-kubelet-client', 'kube-apiserver-kubelet-client', 'kubernetes', ['kubeadm:cluster-admins']);
  leaf('apiserver-etcd-client', 'kube-apiserver-etcd-client', 'etcd-ca');
  leaf('front-proxy-client', 'front-proxy-client', 'front-proxy-ca');
  leaf('etcd/server', 'cka-cp1', 'etcd-ca', [], ['cka-cp1', 'localhost', CP.ip, '127.0.0.1']);
  leaf('etcd/peer', 'cka-cp1', 'etcd-ca', [], ['cka-cp1', 'localhost', CP.ip, '127.0.0.1']);
  leaf('etcd/healthcheck-client', 'kube-etcd-healthcheck-client', 'etcd-ca');
  const kubeconfigs = {
    'admin.conf': kubeconfig({ user: 'kubernetes-admin', cn: 'kubernetes-admin', o: ['kubeadm:cluster-admins'], ca: ca.crt, t }),
    'super-admin.conf': kubeconfig({ user: 'kubernetes-super-admin', cn: 'kubernetes-super-admin', o: ['system:masters'], ca: ca.crt, t }),
    'controller-manager.conf': kubeconfig({ user: 'system:kube-controller-manager', cn: 'system:kube-controller-manager', ca: ca.crt, t }),
    'scheduler.conf': kubeconfig({ user: 'system:kube-scheduler', cn: 'system:kube-scheduler', ca: ca.crt, t }),
  };
  return { ca, files, kubeconfigs };
}

// ------------------------------------------------------------------ złożenie
export function createCluster({ seed = 12345, settleSeconds = 240 } = {}) {
  seedRandom(seed);
  const c = attachControllers(new Cluster());
  const t0 = Date.UTC(2026, 0, 1, 8, 0, 0);
  c.clock = t0;
  c.meta.podBlocks = Object.fromEntries(NODES.map((n) => [n.name, n.block]));
  c.meta.calicoConflist = CALICO_CONFLIST;
  c.meta.cpIp = CP.ip;
  c.meta.version = `v${K8S}`;
  const pki = buildPki(t0 - 3600000);
  const base = new Host('base', '192.168.177.1', 'base');
  buildBaseFs(base);
  c.hosts.base = base;
  for (const n of NODES) {
    const h = new Host(n.name, n.ip, n.role);
    h.cpu = n.cpu;
    h.memMi = n.mem;
    h.bootTime = t0;
    buildNodeFs(c, h, pki, t0 - 3600000);
    c.hosts[n.name] = h;
    for (const u of ['containerd', 'kubelet']) h.unit(u).enabled = true;
    daemonReload(h);
  }
  // usługi
  for (const n of NODES) {
    const h = c.hosts[n.name];
    startUnit(c, h, 'containerd');
    startUnit(c, h, 'kubelet');
  }
  // obiekty API zapisujemy bezpośrednio (etcd z danymi po kubeadm init)
  for (const o of systemObjects(pki)) {
    o.metadata.creationTimestamp = c.iso(t0);
    c.put(o);
  }
  // alokacje
  c.alloc.svcIPs.add('10.96.0.1');
  c.alloc.svcIPs.add('10.96.0.10');
  for (const s of c.all('services')) {
    if (!s.spec.clusterIP) {
      s.spec.clusterIP = `10.${96 + (s.metadata.name.length % 8)}.${(s.metadata.name.charCodeAt(0) * 7) % 250}.${(s.metadata.name.length * 31) % 250 + 2}`;
    }
    s.spec.clusterIPs = [s.spec.clusterIP];
    s.spec.ipFamilies = ['IPv4']; s.spec.ipFamilyPolicy = 'SingleStack'; s.spec.internalTrafficPolicy = 'Cluster'; s.spec.sessionAffinity = 'None';
    s.spec.type = s.spec.type || 'ClusterIP';
    if (s.spec.type === 'NodePort') s.spec.externalTrafficPolicy = 'Cluster';
    for (const p of s.spec.ports) { p.protocol = p.protocol || 'TCP'; if (p.nodePort) c.alloc.nodePorts.add(p.nodePort); }
    s.status = { loadBalancer: {} };
    c.alloc.svcIPs.add(s.spec.clusterIP);
    c.put(s);
  }
  // wartości domyślne obiektów (przez admission w trybie update bez walidacji)
  for (const r of ['deployments', 'daemonsets']) {
    for (const o of c.all(r)) {
      const copy = clone(o);
      try { const res = c.update(copy, { user: null }); void res; } catch { c.apiserverDown = false; try { c.update(copy, { user: null }); } catch { /* */ } }
    }
  }
  c.apiserverDown = true;
  // pierwsze minuty życia klastra
  c.advance(settleSeconds * 1000, 1000);
  c.meta.createdAt = t0;
  return c;
}

export { CP, USER, buildPki };
