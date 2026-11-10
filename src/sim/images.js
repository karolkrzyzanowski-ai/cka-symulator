// Katalog obrazów kontenerów dostępnych w symulatorze.

const NGINX_PAGE = `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>The nginx web server is running in this container.</p>
</body>
</html>
`;

const NGINX_DEFAULT_CONF = `server {
    listen       80;
    listen  [::]:80;
    server_name  localhost;

    location / {
        root   /usr/share/nginx/html;
        index  index.html index.htm;
    }

    error_page   500 502 503 504  /50x.html;
    location = /50x.html {
        root   /usr/share/nginx/html;
    }
}
`;

const BUSYBOX_BIN = ['sh', 'ash', 'echo', 'cat', 'ls', 'sleep', 'wget', 'nslookup', 'env', 'printenv', 'date', 'hostname', 'tail', 'head', 'grep', 'sed', 'awk', 'wc', 'cut', 'sort', 'uniq', 'tr', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'ps', 'df', 'du', 'id', 'whoami', 'uname', 'true', 'false', 'test', 'ping', 'nc', 'ip', 'ifconfig', 'netstat', 'base64', 'md5sum', 'find', 'xargs', 'tee', 'vi', 'printf', 'seq', 'expr', 'basename', 'dirname', 'chmod', 'chown', 'ln', 'stat', 'httpd', 'top', 'free', 'mount', 'kill', 'yes', 'dd', 'od', 'traceroute', 'telnet'];
const DEBIAN_BIN = ['sh', 'bash', 'dash', 'echo', 'cat', 'ls', 'sleep', 'env', 'printenv', 'date', 'hostname', 'tail', 'head', 'grep', 'sed', 'awk', 'wc', 'cut', 'sort', 'uniq', 'tr', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'id', 'whoami', 'uname', 'true', 'false', 'test', 'base64', 'find', 'xargs', 'tee', 'printf', 'seq', 'expr', 'basename', 'dirname', 'chmod', 'chown', 'ln', 'stat', 'df', 'du', 'kill', 'dd', 'mount'];

// rodzaje: shell (domyślnie sh -> natychmiastowe zakończenie), nginx, httpd, podinfo, redis, daemon, postgres, mysql
const I = (o) => ({ mem: 4, cpu: 0, ports: [], bin: BUSYBOX_BIN, ...o });

export const IMAGES = {
  'docker.io/library/nginx': I({ kind: 'nginx', tags: /^(latest|stable|mainline|alpine|alpine-slim|perl|bookworm|1\.(2[0-9])(\.\d+)?(-alpine|-perl|-bookworm|-alpine-slim)?)$/, mem: 12, cpu: 0.001, ports: [80], bin: [...DEBIAN_BIN, 'curl', 'wget', 'nginx'], user: 'root' }),
  'docker.io/library/busybox': I({ kind: 'shell', tags: /^(latest|stable|musl|glibc|uclibc|1\.3[0-7](\.\d+)?(-musl|-glibc|-uclibc)?)$/, mem: 1 }),
  'docker.io/library/alpine': I({ kind: 'shell', tags: /^(latest|edge|3(\.\d+){0,2})$/, mem: 1, bin: [...BUSYBOX_BIN, 'apk'] }),
  'docker.io/library/ubuntu': I({ kind: 'shell', tags: /^(latest|rolling|noble|jammy|focal|2[0-6]\.04)$/, mem: 2, bin: [...DEBIAN_BIN, 'apt', 'apt-get'] }),
  'docker.io/library/debian': I({ kind: 'shell', tags: /^(latest|stable|bookworm|trixie|bullseye|bookworm-slim|1[1-3](-slim)?)$/, mem: 2, bin: [...DEBIAN_BIN, 'apt', 'apt-get'] }),
  'docker.io/library/httpd': I({ kind: 'httpd', tags: /^(latest|alpine|2(\.4(\.\d+)?)?(-alpine)?)$/, mem: 20, cpu: 0.001, ports: [80], bin: [...DEBIAN_BIN, 'httpd'] }),
  'docker.io/library/redis': I({ kind: 'redis', tags: /^(latest|alpine|[6-8](\.\d+){0,2}(-alpine)?)$/, mem: 8, cpu: 0.002, ports: [6379], bin: [...DEBIAN_BIN, 'redis-server', 'redis-cli'] }),
  'docker.io/library/postgres': I({ kind: 'postgres', tags: /^(latest|alpine|1[3-8](\.\d+)?(-alpine)?)$/, mem: 30, cpu: 0.002, ports: [5432], bin: [...DEBIAN_BIN, 'postgres', 'psql'] }),
  'docker.io/library/mysql': I({ kind: 'mysql', tags: /^(latest|8(\.\d+){0,2}|9(\.\d+){0,2})$/, mem: 350, cpu: 0.005, ports: [3306], bin: [...DEBIAN_BIN, 'mysqld', 'mysql'] }),
  'docker.io/library/python': I({ kind: 'shell', tags: /^(latest|3(\.\d+){0,2}(-slim|-alpine)?)$/, mem: 10, bin: [...DEBIAN_BIN, 'python', 'python3'] }),
  'docker.io/curlimages/curl': I({ kind: 'shell', tags: /^(latest|8(\.\d+){0,2})$/, mem: 2, bin: [...BUSYBOX_BIN, 'curl'] }),
  'docker.io/nicolaka/netshoot': I({ kind: 'shell', tags: /^(latest|v0\.\d+)$/, mem: 4, bin: [...BUSYBOX_BIN, 'curl', 'dig', 'nslookup', 'bash'] }),
  'registry.k8s.io/e2e-test-images/agnhost': I({ kind: 'shell', tags: /^2\.\d+$/, mem: 4, bin: [...BUSYBOX_BIN, 'curl'] }),
  'ghcr.io/stefanprodan/podinfo': I({ kind: 'podinfo', tags: /^(latest|6\.\d+\.\d+)$/, mem: 20, cpu: 0.001, ports: [9898, 9797, 9999], bin: [...BUSYBOX_BIN, 'curl', 'podinfo', 'podcli'] }),
  'registry.k8s.io/pause': I({ kind: 'daemon', tags: /^3\.\d+$/, mem: 1 }),
  // komponenty klastra (statyczne pody i dodatki)
  'registry.k8s.io/kube-apiserver': I({ kind: 'component', tags: /^v1\.3[5-8]\.\d+$/, mem: 250, cpu: 0.04 }),
  'registry.k8s.io/kube-controller-manager': I({ kind: 'component', tags: /^v1\.3[5-8]\.\d+$/, mem: 50, cpu: 0.015 }),
  'registry.k8s.io/kube-scheduler': I({ kind: 'component', tags: /^v1\.3[5-8]\.\d+$/, mem: 25, cpu: 0.004 }),
  'registry.k8s.io/kube-proxy': I({ kind: 'daemon', tags: /^v1\.3[5-8]\.\d+$/, mem: 18, cpu: 0.001 }),
  'registry.k8s.io/etcd': I({ kind: 'component', tags: /^3\.[5-7]\.\d+-0$/, mem: 60, cpu: 0.02 }),
  'registry.k8s.io/coredns/coredns': I({ kind: 'coredns', tags: /^v1\.1[1-3]\.\d+$/, mem: 15, cpu: 0.003, ports: [53, 9153, 8080, 8181] }),
  'registry.k8s.io/metrics-server/metrics-server': I({ kind: 'daemon', tags: /^v0\.\d+\.\d+$/, mem: 20, cpu: 0.004, ports: [10250] }),
  'docker.io/calico/node': I({ kind: 'daemon', tags: /^v3\.\d+\.\d+$/, mem: 120, cpu: 0.025 }),
  'docker.io/calico/cni': I({ kind: 'oneshot', tags: /^v3\.\d+\.\d+$/, mem: 2 }),
  'docker.io/calico/kube-controllers': I({ kind: 'daemon', tags: /^v3\.\d+\.\d+$/, mem: 15, cpu: 0.002 }),
  'docker.io/rancher/local-path-provisioner': I({ kind: 'daemon', tags: /^v0\.0\.\d+$/, mem: 8, cpu: 0.001 }),
  'ghcr.io/nginx/nginx-gateway-fabric': I({ kind: 'daemon', tags: /^(2\.\d+\.\d+|edge)$/, mem: 25, cpu: 0.002 }),
  'ghcr.io/nginx/nginx-gateway-fabric/nginx': I({ kind: 'gateway', tags: /^(2\.\d+\.\d+|edge)$/, mem: 10, cpu: 0.001, ports: [80, 443] }),
  'registry.k8s.io/ingress-nginx/controller': I({ kind: 'ingress', tags: /^v1\.1[0-9]\.\d+$/, mem: 80, cpu: 0.003, ports: [80, 443, 8443, 10254] }),
  'quay.io/jetstack/cert-manager-controller': I({ kind: 'daemon', tags: /^v1\.\d+\.\d+$/, mem: 30, cpu: 0.002 }),
  'quay.io/jetstack/cert-manager-cainjector': I({ kind: 'daemon', tags: /^v1\.\d+\.\d+$/, mem: 25, cpu: 0.001 }),
  'quay.io/jetstack/cert-manager-webhook': I({ kind: 'daemon', tags: /^v1\.\d+\.\d+$/, mem: 15, cpu: 0.001, ports: [10250] }),
};

// normalizacja jak w containerd: nginx -> docker.io/library/nginx:latest
export function normalizeImage(ref) {
  if (!ref) return null;
  let r = ref.trim();
  let digest = null;
  if (r.includes('@')) { [r, digest] = r.split('@'); }
  let tag = 'latest';
  const lastSlash = r.lastIndexOf('/');
  const colon = r.lastIndexOf(':');
  if (colon > lastSlash) { tag = r.slice(colon + 1); r = r.slice(0, colon); }
  const parts = r.split('/');
  if (parts.length === 1) r = `docker.io/library/${r}`;
  else if (!parts[0].includes('.') && !parts[0].includes(':') && parts[0] !== 'localhost') r = `docker.io/${r}`;
  return { repo: r, tag, digest, full: `${r}:${tag}` };
}

export function lookupImage(ref) {
  const n = normalizeImage(ref);
  if (!n) return { ok: false, reason: 'InvalidImageName', n };
  if (!/^[a-z0-9._/:-]+$/.test(n.repo) || !/^[\w][\w.-]{0,127}$/.test(n.tag)) return { ok: false, reason: 'InvalidImageName', n };
  const info = IMAGES[n.repo];
  if (!info) return { ok: false, reason: 'notfound-repo', n };
  if (!info.tags.test(n.tag)) return { ok: false, reason: 'notfound-tag', n };
  return { ok: true, n, info };
}

export function pullErrorMessage(ref, res) {
  const n = res.n || normalizeImage(ref);
  if (res.reason === 'InvalidImageName') return `Failed to apply default image tag "${ref}": couldn't parse image name "${ref}": invalid reference format`;
  if (res.reason === 'notfound-repo') {
    return `Failed to pull image "${ref}": failed to pull and unpack image "${n.full}": failed to resolve reference "${n.full}": pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed`;
  }
  return `Failed to pull image "${ref}": rpc error: code = NotFound desc = failed to pull and unpack image "${n.full}": failed to resolve reference "${n.full}": ${n.full}: not found`;
}

export function imageFiles(info, n) {
  const files = {
    '/etc/os-release': info.kind === 'nginx' && !n.tag.includes('alpine') ? 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n' : 'NAME="BusyBox"\nID=busybox\n',
    '/etc/passwd': 'root:x:0:0:root:/root:/bin/sh\nnobody:x:65534:65534:nobody:/home:/bin/false\n',
  };
  if (info.kind === 'nginx') {
    files['/usr/share/nginx/html/index.html'] = NGINX_PAGE;
    files['/usr/share/nginx/html/50x.html'] = '<!DOCTYPE html>\n<html><head><title>Error</title></head><body><h1>An error occurred.</h1></body></html>\n';
    files['/etc/nginx/conf.d/default.conf'] = NGINX_DEFAULT_CONF;
    files['/etc/nginx/nginx.conf'] = 'user  nginx;\nworker_processes  auto;\nerror_log  /var/log/nginx/error.log notice;\npid        /run/nginx.pid;\nevents {\n    worker_connections  1024;\n}\nhttp {\n    include       /etc/nginx/mime.types;\n    default_type  application/octet-stream;\n    sendfile        on;\n    keepalive_timeout  65;\n    include /etc/nginx/conf.d/*.conf;\n}\n';
  }
  if (info.kind === 'httpd') files['/usr/local/apache2/htdocs/index.html'] = '<html><body><h1>It works!</h1></body></html>\n';
  return files;
}

export { NGINX_PAGE };
