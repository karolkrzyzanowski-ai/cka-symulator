// Ocena statycznych podów control plane (kube-apiserver, kcm, scheduler, etcd) na podstawie manifestu.

const COMMON = ['v', 'feature-gates', 'profiling', 'logging-format'];

export const COMPONENTS = {
  'kube-apiserver': {
    flags: ['advertise-address', 'allow-privileged', 'authorization-mode', 'client-ca-file', 'enable-admission-plugins', 'disable-admission-plugins', 'enable-bootstrap-token-auth', 'etcd-cafile', 'etcd-certfile', 'etcd-keyfile', 'etcd-servers', 'kubelet-client-certificate', 'kubelet-client-key', 'kubelet-preferred-address-types', 'proxy-client-cert-file', 'proxy-client-key-file', 'requestheader-allowed-names', 'requestheader-client-ca-file', 'requestheader-extra-headers-prefix', 'requestheader-group-headers', 'requestheader-username-headers', 'secure-port', 'service-account-issuer', 'service-account-key-file', 'service-account-signing-key-file', 'service-cluster-ip-range', 'tls-cert-file', 'tls-private-key-file', 'audit-log-path', 'audit-policy-file', 'audit-log-maxage', 'audit-log-maxbackup', 'audit-log-maxsize', 'encryption-provider-config', 'anonymous-auth', 'runtime-config', 'service-node-port-range', 'enable-aggregator-routing', 'token-auth-file', 'event-ttl', 'max-requests-inflight', 'bind-address', 'authorization-config', 'authentication-config', 'oidc-issuer-url', 'oidc-client-id', 'oidc-username-claim', 'oidc-groups-claim', 'tls-min-version', 'tls-cipher-suites', 'storage-backend', 'watch-cache', 'api-audiences', 'service-account-extend-token-expiration'],
    files: ['client-ca-file', 'etcd-cafile', 'etcd-certfile', 'etcd-keyfile', 'kubelet-client-certificate', 'kubelet-client-key', 'proxy-client-cert-file', 'proxy-client-key-file', 'requestheader-client-ca-file', 'service-account-key-file', 'service-account-signing-key-file', 'tls-cert-file', 'tls-private-key-file', 'audit-policy-file', 'encryption-provider-config', 'token-auth-file', 'authorization-config', 'authentication-config'],
    startMs: 12000,
  },
  'kube-controller-manager': {
    flags: ['allocate-node-cidrs', 'authentication-kubeconfig', 'authorization-kubeconfig', 'bind-address', 'client-ca-file', 'cluster-cidr', 'cluster-name', 'cluster-signing-cert-file', 'cluster-signing-key-file', 'controllers', 'kubeconfig', 'leader-elect', 'requestheader-client-ca-file', 'root-ca-file', 'service-account-private-key-file', 'service-cluster-ip-range', 'use-service-account-credentials', 'node-monitor-grace-period', 'node-monitor-period', 'terminated-pod-gc-threshold', 'cluster-signing-duration', 'concurrent-deployment-syncs', 'horizontal-pod-autoscaler-sync-period', 'node-cidr-mask-size', 'secure-port'],
    files: ['authentication-kubeconfig', 'authorization-kubeconfig', 'client-ca-file', 'cluster-signing-cert-file', 'cluster-signing-key-file', 'kubeconfig', 'requestheader-client-ca-file', 'root-ca-file', 'service-account-private-key-file'],
    startMs: 3000,
  },
  'kube-scheduler': {
    flags: ['authentication-kubeconfig', 'authorization-kubeconfig', 'bind-address', 'kubeconfig', 'leader-elect', 'config', 'secure-port'],
    files: ['authentication-kubeconfig', 'authorization-kubeconfig', 'kubeconfig', 'config'],
    startMs: 3000,
  },
  etcd: {
    flags: ['advertise-client-urls', 'cert-file', 'client-cert-auth', 'data-dir', 'experimental-initial-corrupt-check', 'experimental-watch-progress-notify-interval', 'feature-gates', 'initial-advertise-peer-urls', 'initial-cluster', 'key-file', 'listen-client-urls', 'listen-metrics-urls', 'listen-peer-urls', 'name', 'peer-cert-file', 'peer-client-cert-auth', 'peer-key-file', 'peer-trusted-ca-file', 'snapshot-count', 'trusted-ca-file', 'watch-progress-notify-interval', 'initial-cluster-state', 'initial-cluster-token', 'force-new-cluster', 'quota-backend-bytes', 'auto-compaction-retention'],
    files: ['cert-file', 'key-file', 'peer-cert-file', 'peer-key-file', 'peer-trusted-ca-file', 'trusted-ca-file'],
    startMs: 3000,
  },
};

const ADMISSION = ['AlwaysAdmit', 'AlwaysDeny', 'AlwaysPullImages', 'CertificateApproval', 'CertificateSigning', 'CertificateSubjectRestriction', 'ClusterTrustBundleAttest', 'DefaultIngressClass', 'DefaultStorageClass', 'DefaultTolerationSeconds', 'DenyServiceExternalIPs', 'EventRateLimit', 'ExtendedResourceToleration', 'ImagePolicyWebhook', 'LimitPodHardAntiAffinityTopology', 'LimitRanger', 'MutatingAdmissionPolicy', 'MutatingAdmissionWebhook', 'NamespaceAutoProvision', 'NamespaceExists', 'NamespaceLifecycle', 'NodeRestriction', 'OwnerReferencesPermissionEnforcement', 'PersistentVolumeClaimResize', 'PodNodeSelector', 'PodSecurity', 'PodTolerationRestriction', 'Priority', 'ResourceQuota', 'RuntimeClass', 'ServiceAccount', 'StorageObjectInUseProtection', 'TaintNodesByCondition', 'ValidatingAdmissionPolicy', 'ValidatingAdmissionWebhook'];

function klog(level, t, file, msg) {
  const d = new Date(t);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${level}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}000       1 ${file}] ${msg}`;
}

// Zwraca {ok, image?, exitCode, logs:[...], crashAfterMs, readyAfterMs, dataDir?}
export function evaluateComponent(name, pod, host, ctx) {
  const comp = COMPONENTS[name];
  const ct = pod?.spec?.containers?.[0];
  const t = ctx.now;
  if (!comp || !ct) return { ok: true, logs: [] };
  const argv = [...(ct.command || []), ...(ct.args || [])];
  const logs = [];
  const fail = (msg, delay = 1500, code = 1) => ({ ok: false, exitCode: code, logs: [...logs, msg], crashAfterMs: delay });
  if (!argv.length) return { startError: `failed to create containerd task: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: exec: no command specified`, logs: [] };
  if (argv[0] !== name && argv[0] !== `/usr/local/bin/${name}`) {
    return { startError: `failed to create containerd task: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: exec: "${argv[0]}": executable file not found in $PATH: unknown`, logs: [] };
  }
  const flags = {};
  for (const a of argv.slice(1)) {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/s);
    if (!m) {
      if (name === 'etcd' || a.startsWith('-')) return fail(`Error: unknown shorthand flag: '${a.replace(/^-+/, '')[0]}' in ${a}`, 800);
      continue;
    }
    if (!comp.flags.includes(m[1]) && !COMMON.includes(m[1])) {
      if (name === 'etcd') return fail(`{"level":"fatal","ts":"${new Date(t).toISOString()}","caller":"etcdmain/etcd.go:204","msg":"discovery failed","error":"flag provided but not defined: -${m[1]}"}`, 800);
      return fail(`Error: unknown flag: --${m[1]}`, 800);
    }
    flags[m[1]] = m[2] ?? 'true';
  }
  // pliki wskazane flagami muszą istnieć (montowane z hosta przez hostPath)
  for (const f of comp.files) {
    if (flags[f] === undefined) continue;
    if (!host.fs.exists(flags[f])) {
      if (name === 'kube-apiserver') {
        const what = f === 'client-ca-file' ? 'unable to load client CA provider' : f.startsWith('etcd') ? 'failed to create etcd client' : f === 'tls-cert-file' || f === 'tls-private-key-file' ? 'failed to load serving cert/key' : `invalid --${f}`;
        return fail(`E0101 00:00:00.000000       1 run.go:72] "command failed" err="${what}: open ${flags[f]}: no such file or directory"`, 1000);
      }
      if (name === 'etcd') return fail(`{"level":"fatal","ts":"${new Date(t).toISOString()}","caller":"etcdmain/etcd.go:204","msg":"discovery failed","error":"open ${flags[f]}: no such file or directory"}`, 800);
      return fail(klog('E', t, 'run.go:72', `"command failed" err="stat ${flags[f]}: no such file or directory"`), 1000);
    }
  }
  if (name === 'kube-apiserver') {
    logs.push(klog('I', t, 'options.go:249', 'external host was not specified, using ' + (flags['advertise-address'] || '')));
    logs.push(klog('I', t + 30, 'server.go:146', `Version: ${(ct.image || '').split(':').pop()}`));
    const modes = (flags['authorization-mode'] || 'AlwaysAllow').split(',');
    const bad = modes.find((x) => !['AlwaysAllow', 'AlwaysDeny', 'ABAC', 'Webhook', 'RBAC', 'Node'].includes(x));
    if (bad) return fail(`Error: [authorization-mode "${bad}" is not a valid mode, authorization-mode ${flags['authorization-mode']} is not supported]`, 800);
    for (const p of (flags['enable-admission-plugins'] || '').split(',').filter(Boolean)) {
      if (!ADMISSION.includes(p)) return fail(`Error: enable-admission-plugins plugin "${p}" is unknown`, 800);
    }
    const es = flags['etcd-servers'] || '';
    const okEtcd = es.split(',').some((u) => /^https:\/\/(127\.0\.0\.1|localhost|192\.168\.\d+\.\d+):2379$/.test(u));
    if (!okEtcd || !ctx.etcdUp) {
      const addr = es.split(',')[0]?.replace(/^https?:\/\//, '') || '127.0.0.1:2379';
      logs.push(klog('W', t + 1000, 'logging.go:55', `[core] [Channel #1 SubChannel #2]grpc: addrConn.createTransport failed to connect to {Addr: "${addr}", ServerName: "${addr}", BalancerAttributes: {"<%!p(pickfirst.managedByPickfirstKeyType={})>": "<%!p(bool=true)>" }}. Err: connection error: desc = "transport: Error while dialing: dial tcp ${addr}: connect: connection refused"`));
      return fail(klog('F', t + 20000, 'instance.go:233', 'Error creating leases: error creating storage factory: context deadline exceeded'), 20000);
    }
    logs.push(klog('I', t + 4000, 'secure_serving.go:213', 'Serving securely on [::]:6443'));
    logs.push(klog('I', t + 9000, 'controller.go:615', 'quota admission added evaluator for: leases.coordination.k8s.io'));
    return { ok: true, logs, readyAfterMs: comp.startMs };
  }
  if (name === 'etcd') {
    logs.push(`{"level":"info","ts":"${new Date(t).toISOString()}","caller":"etcdmain/etcd.go:73","msg":"Running: ","args":${JSON.stringify(argv)}}`);
    logs.push(`{"level":"info","ts":"${new Date(t + 400).toISOString()}","caller":"embed/etcd.go:140","msg":"configuring peer listeners","listen-peer-urls":["${flags['listen-peer-urls'] || ''}"]}`);
    logs.push(`{"level":"info","ts":"${new Date(t + 900).toISOString()}","caller":"embed/serve.go:250","msg":"serving client traffic securely","traffic":"grpc+http","address":"127.0.0.1:2379"}`);
    // katalog danych: hostPath wolumenu montowanego w --data-dir
    const dd = flags['data-dir'] || '/var/lib/etcd';
    let hostDir = null;
    const mnt = (ct.volumeMounts || []).find((m) => dd === m.mountPath || dd.startsWith(m.mountPath + '/'));
    if (mnt) {
      const vol = (pod.spec.volumes || []).find((v) => v.name === mnt.name);
      if (vol?.hostPath?.path) hostDir = vol.hostPath.path + dd.slice(mnt.mountPath.length);
    }
    return { ok: true, logs, readyAfterMs: comp.startMs, dataDir: hostDir || dd };
  }
  if (name === 'kube-scheduler') {
    logs.push(klog('I', t, 'serving.go:386', 'Generated self-signed cert in-memory'));
    logs.push(klog('I', t + 600, 'server.go:167', `"Starting Kubernetes Scheduler" version="${(ct.image || '').split(':').pop()}"`));
    logs.push(klog('I', t + 900, 'leaderelection.go:257', 'attempting to acquire leader lease kube-system/kube-scheduler...'));
    logs.push(klog('I', t + 1200, 'leaderelection.go:271', 'successfully acquired lease kube-system/kube-scheduler'));
    return { ok: true, logs, readyAfterMs: comp.startMs };
  }
  logs.push(klog('I', t, 'serving.go:386', 'Generated self-signed cert in-memory'));
  logs.push(klog('I', t + 700, 'controllermanager.go:203', `"Starting" version="${(ct.image || '').split(':').pop()}"`));
  logs.push(klog('I', t + 1300, 'leaderelection.go:271', 'successfully acquired lease kube-system/kube-controller-manager'));
  return { ok: true, logs, readyAfterMs: comp.startMs };
}

export { klog };
