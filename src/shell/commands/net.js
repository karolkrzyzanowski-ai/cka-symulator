// Narzędzia sieciowe: curl, wget, nslookup, dig, ping, nc, ip, ss, httpd ...
import { dnsLookup, connect, httpRequest, podRtByIP, srcFromRt } from '../../sim/net.js';
import { allListening } from '../../sim/kubelet.js';
import { parseOpts } from './core.js';

// kontekst sieciowy powłoki: kontener (rt) albo host (węzeł / base)
export function netCtx(sh) {
  const x = sh.ctx || {};
  const c = x.cluster;
  if (x.rt) return { c, src: { rt: x.rt, fs: sh.fs }, ident: { ip: x.rt.ip }, myIP: x.rt.ip, hostNet: !!x.rt.spec.hostNetwork };
  const h = x.host;
  return { c, src: { host: h }, ident: { ip: h?.ip }, myIP: h?.ip, host: h };
}

const DEFAULT_TIMEOUT = 10; // s (rzeczywiste narzędzia czekają dłużej - tu skracamy)

function* waitTimeout(sec) { yield { type: 'sleep', ms: Math.max(0.2, sec) * 1000 }; }

function statusText(code) {
  return { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Not Allowed', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Temporarily Unavailable', 504: 'Gateway Timeout' }[code] || '';
}

// --------------------------------------------------------------------- curl
function* curl(args, io, sh) {
  const o = { headers: {}, method: null, out: null, silent: false, showErr: false, verbose: false, head: false, include: false, write: null, timeout: null, connTimeout: null, fail: false, follow: false, resolve: [], data: null };
  const urls = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    if (a === '-H' || a === '--header') { const [k, ...v] = next().split(':'); o.headers[k.trim()] = v.join(':').trim(); } else if (a === '-X' || a === '--request') o.method = next();
    else if (a.startsWith('-X') && a.length > 2) o.method = a.slice(2);
    else if (a === '-o' || a === '--output') o.out = next();
    else if (a === '-O' || a === '--remote-name') o.out = '__remote__';
    else if (a === '-w' || a === '--write-out') o.write = next();
    else if (a === '-m' || a === '--max-time') o.timeout = Number(next());
    else if (a === '--connect-timeout') o.connTimeout = Number(next());
    else if (a === '-d' || a === '--data' || a === '--data-raw' || a === '--data-binary') { o.data = next(); o.method = o.method || 'POST'; } else if (a === '--resolve') o.resolve.push(next());
    else if (a === '-u' || a === '--user' || a === '-A' || a === '--user-agent' || a === '--cacert' || a === '--cert' || a === '--key' || a === '-e') next();
    else if (a === '--head') o.head = true;
    else if (a === '--include') o.include = true;
    else if (a === '--silent') o.silent = true;
    else if (a === '--show-error') o.showErr = true;
    else if (a === '--fail') o.fail = true;
    else if (a === '--location') o.follow = true;
    else if (a === '--verbose') o.verbose = true;
    else if (a === '--insecure' || a === '--http1.1' || a === '--no-progress-meter') { /* */ } else if (/^-[a-zA-Z]+$/.test(a)) {
      for (const ch of a.slice(1)) {
        if (ch === 's') o.silent = true; else if (ch === 'S') o.showErr = true; else if (ch === 'v') o.verbose = true; else if (ch === 'I') o.head = true; else if (ch === 'i') o.include = true; else if (ch === 'f') o.fail = true; else if (ch === 'L') o.follow = true; else if (ch === 'k') { /* */ } else if (ch === 'o') o.out = next(); else if (ch === 'm') o.timeout = Number(next()); else if (ch === 'w') o.write = next(); else if (ch === 'H') { const [k, ...v] = next().split(':'); o.headers[k.trim()] = v.join(':').trim(); }
      }
    } else if (a.startsWith('--')) { io.eline(`curl: option ${a}: is unknown\ncurl: try 'curl --help' or 'curl --manual' for more information`); return 2; } else urls.push(a);
  }
  if (!urls.length) { io.eline("curl: try 'curl --help' or 'curl --manual' for more information"); return 2; }
  const { c, src } = netCtx(sh);
  const errOut = (code, msg) => { if (!o.silent || o.showErr) io.eline(`curl: (${code}) ${msg}`); return code; };
  let st = 0;
  for (let url of urls) {
    if (!/^[a-z]+:\/\//.test(url)) url = 'http://' + url;
    const m = url.match(/^(https?):\/\/([^/:?#]+)(?::(\d+))?/);
    if (!m) { st = errOut(3, 'URL rejected: Malformed input to a URL function'); continue; }
    const host = m[2];
    const port = Number(m[3] || (m[1] === 'https' ? 443 : 80));
    let reqUrl = url;
    const hdrs = { ...o.headers };
    for (const r of o.resolve) {
      const [rh, rp, rip] = r.split(':');
      if (rh === host && Number(rp) === port) { reqUrl = url.replace(`//${host}`, `//${rip}`); hdrs.Host = hdrs.Host || host + (m[3] ? `:${port}` : ''); }
    }
    if (o.verbose) io.eline(`* Host ${host}:${port} was resolved.`);
    let res;
    for (let hop = 0; hop < 5; hop++) {
      res = httpRequest(c, src, reqUrl, { method: o.head ? 'HEAD' : (o.method || 'GET'), headers: hdrs });
      if (!res.error && o.follow && [301, 302, 307, 308].includes(res.status) && res.headers?.location) {
        reqUrl = new URL(res.headers.location, reqUrl).toString();
        continue;
      }
      break;
    }
    const tmo = o.connTimeout ?? o.timeout;
    if (res.error === 'resolve') { st = errOut(6, `Could not resolve host: ${host}`); continue; }
    if (res.error === 'dnstimeout') { yield* waitTimeout(Math.min(tmo ?? DEFAULT_TIMEOUT, 10)); st = errOut(6, `Could not resolve host: ${host}`); continue; }
    if (res.error === 'refused') { st = errOut(7, `Failed to connect to ${host} port ${port} after 1 ms: Couldn't connect to server`); continue; }
    if (res.error === 'unreachable') { yield* waitTimeout(Math.min(tmo ?? 3, 3)); st = errOut(7, `Failed to connect to ${host} port ${port} after 3071 ms: No route to host`); continue; }
    if (res.error === 'timeout') {
      const t = tmo ?? DEFAULT_TIMEOUT;
      yield* waitTimeout(t);
      st = errOut(28, o.connTimeout != null || o.timeout == null ? `Failed to connect to ${host} port ${port} after ${Math.round(t * 1000)} ms: Timeout was reached` : `Connection timed out after ${Math.round(t * 1000) + 1} milliseconds`);
      continue;
    }
    if (res.error) { st = errOut(7, `Failed to connect to ${host} port ${port}: ${res.error}`); continue; }
    if (o.verbose) {
      io.eline(`*   Trying ${res.ip}:${port}...\n* Connected to ${host} (${res.ip}) port ${port}\n> ${o.head ? 'HEAD' : o.method || 'GET'} ${new URL(reqUrl).pathname}${new URL(reqUrl).search} HTTP/1.1\n> Host: ${hdrs.Host || host}\n> User-Agent: curl/8.17.0\n> Accept: */*\n>`);
      io.eline(`< HTTP/1.1 ${res.status} ${statusText(res.status)}`);
      for (const [k, v] of Object.entries(res.headers || {})) io.eline(`< ${k}: ${v}`);
      io.eline('<');
    }
    const headBlock = `HTTP/1.1 ${res.status} ${statusText(res.status)}\r\n${Object.entries({ server: res.server || 'nginx', 'content-type': 'text/html', 'content-length': String((res.body || '').length), ...(res.headers || {}) }).map(([k, v]) => `${k[0].toUpperCase()}${k.slice(1)}: ${v}`).join('\r\n')}\r\n\r\n`;
    if (o.fail && res.status >= 400) { st = errOut(22, `The requested URL returned error: ${res.status}`); continue; }
    let body = o.head ? headBlock : (o.include ? headBlock : '') + (res.body || '');
    if (o.out) {
      const name = o.out === '__remote__' ? (new URL(reqUrl).pathname.split('/').pop() || 'index.html') : o.out;
      if (name === '/dev/null') body = '';
      else {
        try { sh.fs.write(sh.abs(name), body, { user: sh.user }); } catch (e) { st = errOut(23, `Failure writing output to destination, passed ${body.length} returned 0`); continue; }
        body = '';
      }
    }
    io.out(body);
    if (o.write) io.out(o.write.replace(/%\{http_code\}/g, String(res.status)).replace(/%\{remote_ip\}/g, res.ip).replace(/\\n/g, '\n').replace(/%\{size_download\}/g, String((res.body || '').length)));
  }
  return st;
}

// --------------------------------------------------------------------- wget (busybox / GNU)
function* wget(args, io, sh) {
  const { opts, rest } = parseOpts(args, { short: 'qSO', withArg: 'OTt', long: { spider: 'bool', timeout: 'arg', header: 'arg', 'output-document': 'arg', quiet: 'bool', 'no-check-certificate': 'bool' } });
  const out = opts.O ?? opts['output-document'];
  const quiet = opts.q || opts.quiet;
  const url0 = rest[0];
  if (!url0) { io.eline('BusyBox v1.37.0 (2025-01-17 18:12:01 UTC) multi-call binary.\n\nUsage: wget [-cqS] [--spider] [-O FILE] [-o LOGFILE] [--header STR]\n\t[--post-data STR | --post-file FILE] [-Y on/off]\n\t[-P DIR] [-U AGENT] [-T SEC] URL...'); return 1; }
  const url = /^[a-z]+:\/\//.test(url0) ? url0 : 'http://' + url0;
  const m = url.match(/^(https?):\/\/([^/:?#]+)(?::(\d+))?/);
  const host = m[2];
  const { c, src } = netCtx(sh);
  const headers = {};
  if (opts.header) { const [k, ...v] = String(opts.header).split(':'); headers[k.trim()] = v.join(':').trim(); }
  const res = httpRequest(c, src, url, { headers });
  const timeout = Number(opts.T ?? opts.timeout ?? DEFAULT_TIMEOUT);
  if (res.error === 'resolve' || res.error === 'dnstimeout') {
    if (res.error === 'dnstimeout') yield* waitTimeout(Math.min(timeout, 10));
    io.eline(`wget: bad address '${host}'`);
    return 1;
  }
  if (!quiet) io.eline(`Connecting to ${host}${m[3] ? ':' + m[3] : ''} (${res.ip || host}:${res.port || m[3] || 80})`);
  if (res.error === 'refused') { io.eline(`wget: can't connect to remote host (${res.ip}): Connection refused`); return 1; }
  if (res.error === 'unreachable') { yield* waitTimeout(3); io.eline(`wget: can't connect to remote host (${res.ip}): Host is unreachable`); return 1; }
  if (res.error === 'timeout') { yield* waitTimeout(timeout); io.eline('wget: download timed out'); return 1; }
  if (res.error) { io.eline(`wget: ${res.error}`); return 1; }
  if (opts.S) io.eline(`  HTTP/1.1 ${res.status} ${statusText(res.status)}\n  Server: ${res.server || 'nginx'}\n  Content-Type: text/html\n  Content-Length: ${(res.body || '').length}\n  Connection: close`);
  if (res.status >= 400) { io.eline(`wget: server returned error: HTTP/1.1 ${res.status} ${statusText(res.status)}`); return 1; }
  if (opts.spider) { if (!quiet) io.eline('remote file exists'); return 0; }
  const body = res.body || '';
  if (out === '-' ) {
    if (!quiet) io.eline('writing to stdout');
    io.out(body);
    if (!quiet) io.eline(`-                    100% |********************************|   ${body.length}  0:00:00 ETA\nwritten to stdout`);
    return 0;
  }
  const name = out || (new URL(url).pathname.split('/').pop() || 'index.html');
  try { sh.fs.write(sh.abs(name), body, { user: sh.user }); } catch (e) { io.eline(`wget: can't open '${name}': ${e.reason || 'Permission denied'}`); return 1; }
  if (!quiet) io.eline(`saving to '${name}'\n${name.padEnd(20)} 100% |********************************|   ${body.length}  0:00:00 ETA\n'${name}' saved`);
  return 0;
}

// --------------------------------------------------------------------- DNS
function* nslookup(args, io, sh) {
  const rest = args.filter((a) => !a.startsWith('-'));
  const name = rest[0];
  if (!name) { io.eline('Usage: nslookup [-type=QUERY_TYPE] [-debug] HOST [DNS_SERVER]'); return 1; }
  const { c, src } = netCtx(sh);
  const inPod = !!src.rt && !(src.rt.spec.hostNetwork && src.rt.spec.dnsPolicy !== 'ClusterFirstWithHostNet');
  const r = dnsLookup(c, src, name);
  const server = inPod ? '10.96.0.10' : '127.0.0.53';
  if (!r.ok && r.error === 'timeout') {
    yield* waitTimeout(inPod ? 15 : 5);
    io.line(';; connection timed out; no servers could be reached\n');
    return 1;
  }
  const busy = !!src.rt;
  io.line(`Server:\t\t${server}`);
  io.line(`Address:\t${server}${busy ? ':53' : '#53'}`);
  io.line('');
  if (!r.ok) {
    if (busy) {
      io.line(`** server can't find ${r.fqdn || name}: ${r.error}`);
      io.line('');
      if (inPod) io.line(`** server can't find ${r.fqdn || name}: ${r.error}\n`);
    } else io.line(`** server can't find ${name}: ${r.error}\n`);
    return 1;
  }
  if (!busy && !r.fromHosts) io.line('Non-authoritative answer:');
  if (r.cname) io.line(`${r.fqdn}\tcanonical name = ${r.cname}`);
  for (const ip of r.ips) { io.line(`Name:\t${r.cname || r.fqdn}`); io.line(`Address: ${ip}`); }
  io.line('');
  return 0;
}

function* dig(args, io, sh) {
  const short = args.includes('+short');
  const rest = args.filter((a) => !a.startsWith('+') && !a.startsWith('@') && !a.startsWith('-') && !/^(A|AAAA|SRV|CNAME|TXT)$/i.test(a));
  const name = rest[0] || '.';
  const { c, src } = netCtx(sh);
  const r = dnsLookup(c, src, name.endsWith('.') || name.split('.').length > 2 ? name : name);
  if (!r.ok && r.error === 'timeout') { yield* waitTimeout(15); io.line(';; communications error to 10.96.0.10#53: timed out\n;; no servers could be reached'); return 9; }
  if (short) { if (r.ok) { if (r.cname) io.line(r.cname + '.'); for (const ip of r.ips) io.line(ip); } return 0; }
  io.line(`\n; <<>> DiG 9.20.11 <<>> ${args.join(' ')}\n;; global options: +cmd\n;; Got answer:\n;; ->>HEADER<<- opcode: QUERY, status: ${r.ok ? 'NOERROR' : r.error}, id: 4242\n;; flags: qr aa rd; QUERY: 1, ANSWER: ${r.ok ? r.ips.length : 0}, AUTHORITY: 0, ADDITIONAL: 1\n\n;; QUESTION SECTION:\n;${name}.\t\t\tIN\tA\n`);
  if (r.ok) { io.line(';; ANSWER SECTION:'); for (const ip of r.ips) io.line(`${r.fqdn}.\t30\tIN\tA\t${ip}`); io.line(''); }
  io.line(`;; SERVER: ${r.server}#53(${r.server}) (UDP)\n;; MSG SIZE  rcvd: 106\n`);
  return 0;
}

function* hostCmd(args, io, sh) {
  const name = args.filter((a) => !a.startsWith('-'))[0];
  const { c, src } = netCtx(sh);
  const r = dnsLookup(c, src, name);
  if (!r.ok) { io.line(`Host ${name} not found: 3(NXDOMAIN)`); return 1; }
  for (const ip of r.ips) io.line(`${r.fqdn} has address ${ip}`);
  return 0;
}

// --------------------------------------------------------------------- ping
function* ping(args, io, sh) {
  const { opts, rest } = parseOpts(args, { short: 'q', withArg: 'cWwi' });
  const target = rest[0];
  if (!target) { io.eline('ping: usage error: Destination address required'); return 1; }
  const { c, src } = netCtx(sh);
  const r = dnsLookup(c, src, target);
  if (!r.ok) { io.eline(`ping: bad address '${target}'`); return 1; }
  const ip = r.ips[0];
  const count = Number(opts.c || 4);
  const isSvc = c.all('services').some((s) => s.spec.clusterIP === ip);
  const rt = podRtByIP(c, ip);
  const node = Object.values(c.hosts).find((h) => h.ip === ip);
  const reach = !isSvc && ((rt && rt.state === 'running') || node || /^(142|140|147|93|34|54|8)\./.test(ip));
  io.line(`PING ${target} (${ip}): 56 data bytes`);
  let ok = 0;
  for (let i = 0; i < count; i++) {
    yield { type: 'sleep', ms: 1000 };
    if (reach) { io.line(`64 bytes from ${ip}: seq=${i} ttl=${rt ? 62 : 64} time=${(0.3 + (i % 3) * 0.11).toFixed(3)} ms`); ok++; }
  }
  io.line(`\n--- ${target} ping statistics ---\n${count} packets transmitted, ${ok} packets received, ${Math.round(100 - (ok / count) * 100)}% packet loss`);
  if (ok) io.line('round-trip min/avg/max = 0.301/0.412/0.523 ms');
  return ok ? 0 : 1;
}

// --------------------------------------------------------------------- nc / telnet
function* nc(args, io, sh) {
  const { opts, rest } = parseOpts(args, { short: 'zvlnuk', withArg: 'wpe' });
  if (opts.l) {
    const port = Number(opts.p || rest[rest.length - 1]);
    if (!port) { io.eline('nc: missing port with option -l'); return 1; }
    sh.onListen?.(port);
    while (true) yield { type: 'sleep', ms: 3600e3 };
  }
  const [hostName, portS] = rest;
  const port = Number(portS);
  const { c, src, ident } = netCtx(sh);
  const r = dnsLookup(c, src, hostName || '');
  if (!r.ok) { io.eline(`nc: bad address '${hostName}'`); return 1; }
  const conn = connect(c, src.rt ? srcFromRt(c, src.rt) : ident, r.ips[0], port, opts.u ? 'UDP' : 'TCP');
  const w = Number(opts.w || DEFAULT_TIMEOUT);
  if (conn.ok) {
    if (opts.v || opts.z) io.eline(src.rt ? `${hostName} (${r.ips[0]}:${port}) open` : `Connection to ${hostName} (${r.ips[0]}) ${port} port [tcp/*] succeeded!`);
    return 0;
  }
  if (conn.error === 'timeout') { yield* waitTimeout(w); if (opts.v) io.eline(src.rt ? 'nc: timed out' : `nc: connect to ${hostName} (${r.ips[0]}) port ${port} (tcp) timed out: Operation now in progress`); return 1; }
  if (opts.v || !opts.z) io.eline(src.rt ? `nc: ${hostName} (${r.ips[0]}:${port}): Connection refused` : `nc: connect to ${hostName} (${r.ips[0]}) port ${port} (tcp) failed: Connection refused`);
  return 1;
}

// --------------------------------------------------------------------- ip / ss
function* ipCmd(args, io, sh) {
  const sub = args[0] || '';
  const { myIP, src } = netCtx(sh);
  if (/^(a|addr|address)$/.test(sub) || sub === '-4') {
    io.line('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000\n    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n    inet 127.0.0.1/8 scope host lo');
    if (src.rt && !src.rt.spec.hostNetwork) io.line(`2: eth0@if12: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1450 qdisc noqueue state UP\n    link/ether 6a:1f:2c:7e:01:9b brd ff:ff:ff:ff:ff:ff\n    inet ${myIP}/32 scope global eth0`);
    else io.line(`2: enp1s0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP group default qlen 1000\n    link/ether 52:54:00:4a:${(myIP || '0.0.0.0').split('.')[3].padStart(2, '0')}:11 brd ff:ff:ff:ff:ff:ff\n    inet ${myIP}/24 metric 100 brd 192.168.177.255 scope global dynamic enp1s0`);
    return 0;
  }
  if (/^(r|route)$/.test(sub)) {
    if (src.rt && !src.rt.spec.hostNetwork) io.line('default via 169.254.1.1 dev eth0\n169.254.1.1 dev eth0 scope link');
    else io.line(`default via 192.168.177.1 dev enp1s0 proto dhcp src ${myIP} metric 100\n192.168.177.0/24 dev enp1s0 proto kernel scope link src ${myIP} metric 100`);
    return 0;
  }
  if (/^(l|link)$/.test(sub)) { io.line('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536\n2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1450'); return 0; }
  io.eline('Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }\nwhere  OBJECT := { address | link | route | neigh }');
  return 1;
}

function* ss(args, io, sh) {
  const x = sh.ctx || {};
  const c = x.cluster;
  let ports = [];
  if (x.rt) ports = allListening(x.rt).map((p) => [p, 'process']);
  else if (x.host && c) {
    const h = x.host;
    if (h.unit?.('kubelet')?.state === 'active') ports.push([10250, 'kubelet'], [10248, 'kubelet']);
    if (h.unit?.('containerd')?.state === 'active') ports.push([45127, 'containerd']);
    ports.push([22, 'sshd']);
    for (const rt of Object.values(c.runtime)) if (rt.node === h.name && rt.spec.hostNetwork) for (const p of allListening(rt)) ports.push([p, rt.name.replace(`-${h.name}`, '')]);
  }
  ports.sort((a, b) => a[0] - b[0]);
  io.line('State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess');
  for (const [p, n] of ports) io.line(`LISTEN 0      4096   ${(p === 10248 ? '127.0.0.1' : '*')}:${p}`.padEnd(38) + `*:*    users:(("${n}",pid=${1000 + p % 900},fd=3))`);
  return 0;
}

function* netstat(args, io, sh) { return yield* ss(args, io, sh); }

// --------------------------------------------------------------------- serwery
function* httpd(args, io, sh) {
  const { opts } = parseOpts(args, { short: 'fv', withArg: 'phc' });
  const port = Number(String(opts.p || '80').split(':').pop());
  sh.onListen?.(port);
  if (!opts.f) return 0; // demonizuje się, kontener i tak trwa przez sh
  while (true) yield { type: 'sleep', ms: 3600e3 };
}

function* python(args, io, sh) {
  const i = args.indexOf('-m');
  if (i >= 0 && args[i + 1] === 'http.server') {
    const port = Number(args[i + 2] || 8000);
    sh.onListen?.(port);
    io.line(`Serving HTTP on 0.0.0.0 port ${port} (http://0.0.0.0:${port}/) ...`);
    while (true) yield { type: 'sleep', ms: 3600e3 };
  }
  if (args[0] === '-c') { const m = String(args[1]).match(/print\((['"])(.*)\1\)/); if (m) io.line(m[2]); return 0; }
  if (args[0] === '--version' || args[0] === '-V') { io.line('Python 3.13.9'); return 0; }
  io.eline('Python 3.13.9 (simulated) - tryb interaktywny niedostępny');
  return 1;
}

export const NET = {
  curl, wget, nslookup, dig, host: hostCmd, ping, nc, ncat: nc, netcat: nc, telnet: (a, io, sh) => nc(['-v', ...a], io, sh), ip: ipCmd, ss, netstat, httpd, python, python3: python,
  *ifconfig(args, io, sh) { const { myIP } = netCtx(sh); io.line(`eth0      Link encap:Ethernet\n          inet addr:${myIP}  Mask:255.255.255.255\n          UP BROADCAST RUNNING MULTICAST  MTU:1450  Metric:1\n`); return 0; },
  *traceroute(args, io, sh) { io.line(`traceroute to ${args[0]}, 30 hops max, 46 byte packets`); yield { type: 'sleep', ms: 1000 }; io.line(' 1  *  *  *'); return 1; },
};
