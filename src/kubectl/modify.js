// kubectl label/annotate/scale/autoscale/set/rollout/taint/cordon/uncordon/drain
import { fail, KErr, apiMsg, parseResourceArgs, resolveType, render, parseOutput, readManifestSources, clean } from './common.js';
import { kindPrefix } from './printers.js';
import { ApiError } from '../sim/cluster.js';
import { clone, deepEqual, parseDuration, labelsString, matchLabelSelector } from '../lib/util.js';
import { describeTemplateForHistory } from './history.js';

function* sleep(ms) { yield { type: 'sleep', ms }; }

// obiekty z argumentów lub -f
function targets(x, { allowSelector = true } = {}) {
  const f = x.f;
  const out = [];
  if (f.filename?.length) {
    for (const d of readManifestSources(x, f.filename, { recursive: f.recursive })) {
      const r = x.c.registry.byKindAnyVersion(d.obj.apiVersion, d.obj.kind);
      out.push({ r, o: x.c.get(r, d.obj.metadata.namespace || x.ns, d.obj.metadata.name, { user: x.user }) });
    }
    return out;
  }
  return { pos: x.pos, out };
}

function update(x, r, o, { subresource } = {}) {
  const dry = x.f['dry-run'] && x.f['dry-run'] !== 'none';
  const res = x.c.update(o, { user: x.user, subresource, dryRun: dry });
  if (!dry) x.c.reconcile();
  return res;
}

function printResult(x, r, o, msg) {
  if (x.f.output) x.io.out(render(x, [{ r, items: [o] }], parseOutput(x.f.output), { single: true, flags: x.f }));
  else x.io.line(`${kindPrefix(r)}/${o.metadata.name} ${msg}${x.f['dry-run'] && x.f['dry-run'] !== 'none' ? ' (dry run)' : ''}`);
}

// ------------------------------------------------------------------ label / annotate
function* labelOrAnnotate(x, field) {
  x.api();
  const f = x.f;
  const isLabel = field === 'labels';
  let objs = [];
  let changes;
  if (f.filename?.length) {
    objs = targets(x);
    changes = x.pos;
  } else {
    let pos = [...x.pos];
    if (!pos.length) fail(`error: one or more resources must be specified as <resource> <name> or <resource>/<name>`);
    // pierwszy argument: typ lub typ/nazwa; kolejne bez '=' i bez końcowego '-' to nazwy
    const resArgs = [];
    if (pos[0].includes('/')) { while (pos.length && pos[0].includes('/') && !pos[0].includes('=')) resArgs.push(pos.shift()); } else {
      resArgs.push(pos.shift());
      while (pos.length && !pos[0].includes('=') && !pos[0].endsWith('-')) resArgs.push(pos.shift());
    }
    changes = pos;
    const groups = parseResourceArgs(x.c, resArgs, { verb: isLabel ? 'label' : 'annotate' });
    for (const g of groups) {
      if (g.names.length) for (const n of g.names) objs.push({ r: g.r, o: x.c.get(g.r, x.ns, n, { user: x.user }) });
      else if (f.all || f.selector) for (const o of x.c.list(g.r, g.r.namespaced ? (x.allNs ? null : x.ns) : null, { labelSelector: f.selector, user: x.user })) objs.push({ r: g.r, o });
      else fail('error: resource(s) were provided, but no name was specified');
    }
  }
  if (f.list) {
    for (const { o } of objs) for (const [k, v] of Object.entries(o.metadata[field] || {})) x.io.line(`${k}=${v}`);
    return 0;
  }
  if (!changes.length) fail(`error: at least one ${isLabel ? 'label' : 'annotation'} update is required`);
  const set = {}, del = [];
  for (const ch of changes) {
    if (ch.endsWith('-') && !ch.includes('=')) { del.push(ch.slice(0, -1)); continue; }
    const i = ch.indexOf('=');
    if (i <= 0) fail(`error: invalid ${isLabel ? 'label' : 'annotation'} spec: ${ch}, ${isLabel ? 'label' : 'annotation'} must be of the form key=value or key-`);
    const k = ch.slice(0, i), v = ch.slice(i + 1);
    if (isLabel && !/^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(k)) fail(`error: invalid label spec: ${ch}`);
    if (isLabel && v && !/^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/.test(v)) fail(`error: invalid label value: "${ch}": a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyValue',  or 'my_value',  or '12345', regex used for validation is '(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?')`);
    set[k] = v;
  }
  let st = 0;
  for (const { r, o } of objs) {
    const cur = { ...(o.metadata[field] || {}) };
    for (const [k, v] of Object.entries(set)) {
      if (cur[k] !== undefined && cur[k] !== v && !f.overwrite) {
        x.io.eline(`error: '${k}' already has a value (${cur[k]}), and --overwrite is false`);
        st = 1;
        return st;
      }
    }
    const before = JSON.stringify(cur);
    Object.assign(cur, set);
    for (const k of del) delete cur[k];
    const changed = before !== JSON.stringify(cur);
    if (!changed) { x.io.line(`${kindPrefix(r)}/${o.metadata.name} not ${isLabel ? 'labeled' : 'annotated'}`); continue; }
    const n = clone(o);
    n.metadata[field] = cur;
    if (!Object.keys(cur).length) delete n.metadata[field];
    try { const res = update(x, r, n); printResult(x, r, res, isLabel ? 'labeled' : 'annotated'); } catch (e) { x.io.eline(apiMsg(e)); st = 1; }
  }
  return st;
}
function* cmdLabel(x) { return yield* labelOrAnnotate(x, 'labels'); }
function* cmdAnnotate(x) { return yield* labelOrAnnotate(x, 'annotations'); }

// ------------------------------------------------------------------ scale
function* cmdScale(x) {
  x.api();
  const f = x.f;
  if (f.replicas === undefined) fail('error: required flag(s) "replicas" not set');
  const n = Number(f.replicas);
  if (!Number.isInteger(n) || n < 0) fail('error: The --replicas=COUNT flag is required, and COUNT must be greater than or equal to 0');
  const t = targets(x);
  let objs = Array.isArray(t) ? t : [];
  if (!Array.isArray(t)) {
    const groups = parseResourceArgs(x.c, t.pos, { verb: 'scale' });
    for (const g of groups) {
      if (g.names.length) for (const nm of g.names) objs.push({ r: g.r, o: x.c.get(g.r, x.ns, nm, { user: x.user }) });
      else if (f.all || f.selector) for (const o of x.c.list(g.r, x.ns, { labelSelector: f.selector, user: x.user })) objs.push({ r: g.r, o });
      else fail('error: resource(s) were provided, but no name was specified');
    }
  }
  for (const { r, o } of objs) {
    if (!['Deployment', 'ReplicaSet', 'StatefulSet', 'ReplicationController'].includes(r.kind) && !r.crd) fail(`error: no scaler has been implemented for {"${r.group}" "${r.kind}"}`);
    if (f['current-replicas'] !== undefined && Number(f['current-replicas']) !== (o.spec.replicas ?? 1)) fail(`error: Expected replicas to be ${f['current-replicas']}, was ${o.spec.replicas ?? 1}`);
    const nn = clone(o);
    nn.spec.replicas = n;
    const res = update(x, r, nn, { subresource: 'scale' });
    x.io.line(`${kindPrefix(r)}/${res.metadata.name} scaled`);
  }
  return 0;
}

// ------------------------------------------------------------------ autoscale
function* cmdAutoscale(x) {
  x.api();
  const f = x.f;
  let [t, n] = x.pos;
  if (t?.includes('/')) [t, n] = t.split('/');
  if (!t || !n) fail("error: You must provide one or more resources by argument or filename.");
  const r = resolveType(x.c, t);
  if (!['Deployment', 'ReplicaSet', 'StatefulSet', 'ReplicationController'].includes(r.kind)) fail(`error: cannot autoscale a ${r.kind}: cannot autoscale a ${r.kind}`);
  const o = x.c.get(r, x.ns, n, { user: x.user });
  if (f.max === undefined) fail('error: required flag(s) "max" not set');
  const max = Number(f.max), min = f.min !== undefined ? Number(f.min) : undefined;
  if (min !== undefined && min > max) fail(`error: --max=MAXPODS must be larger or equal to --min=MINPODS`);
  if (f['cpu-percent']) x.io.eline("Flag --cpu-percent has been deprecated, Use --cpu with percentage or resource quantity format (e.g., '70%' for utilization or '500m' for milliCPU).");
  const metrics = [];
  const cpu = f.cpu ?? (f['cpu-percent'] !== undefined ? `${f['cpu-percent']}%` : undefined);
  const metric = (name, v) => (String(v).endsWith('%') ? { resource: { name, target: { averageUtilization: Number(String(v).slice(0, -1)), type: 'Utilization' } }, type: 'Resource' } : { resource: { name, target: { averageValue: v, type: 'AverageValue' } }, type: 'Resource' });
  if (cpu !== undefined) metrics.push(metric('cpu', cpu));
  if (f.memory !== undefined) metrics.push(metric('memory', f.memory));
  const hpa = {
    apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler', metadata: { creationTimestamp: null, name: f.name || n },
    spec: { maxReplicas: max, ...(metrics.length ? { metrics } : {}), ...(min !== undefined ? { minReplicas: min } : {}), scaleTargetRef: { apiVersion: r.group ? `${r.group}/${r.version}` : r.version, kind: r.kind, name: o.metadata.name } },
    status: { currentMetrics: null, desiredReplicas: 0 },
  };
  const mode = f['dry-run'] && f['dry-run'] !== 'none';
  if (mode && f.output) { x.io.out(render(x, [{ r: x.c.res('hpa'), items: [hpa] }], parseOutput(f.output), { single: true })); return 0; }
  const send = clone(hpa);
  delete send.status;
  delete send.metadata.creationTimestamp;
  if (!send.spec.metrics) send.spec.metrics = [{ resource: { name: 'cpu', target: { averageUtilization: 80, type: 'Utilization' } }, type: 'Resource' }];
  send.metadata.namespace = x.ns;
  const res = x.c.create(send, { user: x.user, dryRun: mode });
  x.c.reconcile();
  if (f.output) x.io.out(render(x, [{ r: x.c.res('hpa'), items: [res] }], parseOutput(f.output), { single: true }));
  else x.io.line(`horizontalpodautoscaler.autoscaling/${res.metadata.name} autoscaled${mode ? ' (dry run)' : ''}`);
  return 0;
}

// ------------------------------------------------------------------ set
function podSpecOf(r, o) {
  if (r.kind === 'Pod') return o.spec;
  if (r.kind === 'CronJob') return o.spec.jobTemplate.spec.template.spec;
  return o.spec?.template?.spec;
}

function* cmdSet(x) {
  x.api();
  const sub = x.pos[0];
  const f = x.f;
  const rest = x.pos.slice(1);
  if (!['image', 'env', 'resources', 'serviceaccount', 'sa', 'selector', 'subject'].includes(sub)) {
    x.io.line('Configure application resources.\n\nAvailable Commands:\n  env              Update environment variables on a pod template\n  image            Update the image of a pod template\n  resources        Update resource requests/limits on objects with pod templates\n  selector         Set the selector on a resource\n  serviceaccount   Update the service account of a resource\n  subject          Update the user, group, or service account in a role binding or cluster role binding');
    return sub ? 1 : 0;
  }
  // rozdziel zasoby od par
  let resArgs = [], pairs = [];
  if (f.filename?.length) pairs = rest;
  else if (rest[0]?.includes('/')) { while (rest.length && rest[0].includes('/') && !rest[0].includes('=')) resArgs.push(rest.shift()); pairs = rest; } else {
    resArgs.push(rest.shift());
    if (sub === 'serviceaccount' || sub === 'sa') { resArgs.push(...rest.slice(0, -1)); pairs = rest.slice(-1); } else { while (rest.length && !rest[0].includes('=') && !rest[0].endsWith('-')) resArgs.push(rest.shift()); pairs = rest; }
  }
  let objs = [];
  if (f.filename?.length) objs = targets(x);
  else {
    for (const g of parseResourceArgs(x.c, resArgs.filter(Boolean), { verb: `set ${sub}` })) {
      if (g.names.length) for (const n of g.names) objs.push({ r: g.r, o: x.c.get(g.r, x.ns, n, { user: x.user }) });
      else if (f.all || f.selector) for (const o of x.c.list(g.r, x.ns, { labelSelector: f.selector, user: x.user })) objs.push({ r: g.r, o });
      else fail('error: resource(s) were provided, but no name was specified');
    }
  }
  if (!objs.length) fail('error: one or more resources must be specified as <resource> <name> or <resource>/<name>');
  const containerSel = f.containers2 || f.containers || '*';
  for (const { r, o } of objs) {
    const n = clone(o);
    const spec = podSpecOf(r, n);
    if (!spec && sub !== 'subject') fail(`error: ${kindPrefix(r)}/${o.metadata.name} - doesn't have a pod template`);
    const all = spec ? [...(spec.initContainers || []), ...(spec.containers || [])] : [];
    const pick = (sel) => (sel === '*' ? spec.containers : all.filter((ct) => ct.name === sel));
    let msg = '';
    if (sub === 'image') {
      if (!pairs.length) fail('error: at least one image update is required');
      for (const p of pairs) {
        const i = p.indexOf('=');
        const cn = p.slice(0, i), img = p.slice(i + 1);
        const cs = cn === '*' ? all : all.filter((ct) => ct.name === cn);
        if (!cs.length) fail(`error: unable to find container named "${cn}"`);
        for (const ct of cs) ct.image = img;
      }
      msg = 'image updated';
    } else if (sub === 'env') {
      const cs = pick(containerSel);
      if (f.list) {
        for (const ct of cs) {
          x.io.line(`# ${kindPrefix(r)}/${o.metadata.name}, container ${ct.name}`);
          for (const e of ct.env || []) x.io.line(e.value !== undefined ? `${e.name}=${e.value}` : `# ${e.name} from: ${JSON.stringify(e.valueFrom)}`);
        }
        continue;
      }
      for (const ct of cs) {
        ct.env = ct.env || [];
        for (const p of [...pairs, ...(f.env || [])]) {
          if (p.endsWith('-') && !p.includes('=')) { ct.env = ct.env.filter((e) => e.name !== p.slice(0, -1)); continue; }
          const i = p.indexOf('=');
          const k = p.slice(0, i), v = p.slice(i + 1);
          const ex = ct.env.find((e) => e.name === k);
          if (ex) { ex.value = v; delete ex.valueFrom; } else ct.env.push({ name: k, value: v });
        }
        if (f.from) {
          const [t, nm] = f.from.split('/');
          const fr = resolveType(x.c, t);
          const src = x.c.get(fr, x.ns, nm, { user: x.user });
          for (const k of Object.keys(src.data || {}).sort()) {
            const name = (f.prefix || '') + k.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
            const ref = fr.kind === 'Secret' ? { secretKeyRef: { key: k, name: nm } } : { configMapKeyRef: { key: k, name: nm } };
            const ex = ct.env.find((e) => e.name === name);
            if (ex) { delete ex.value; ex.valueFrom = ref; } else ct.env.push({ name, valueFrom: ref });
          }
        }
        if (!ct.env.length) delete ct.env;
      }
      msg = 'env updated';
    } else if (sub === 'resources') {
      const cs = pick(containerSel);
      if (!cs.length) fail(`error: unable to find container named ${containerSel}`);
      const parse = (s) => Object.fromEntries((s || '').split(',').filter(Boolean).map((kv) => kv.split('=')));
      for (const ct of cs) {
        ct.resources = ct.resources || {};
        if (f.limits) ct.resources.limits = { ...(ct.resources.limits || {}), ...parse(f.limits) };
        if (f.requests) ct.resources.requests = { ...(ct.resources.requests || {}), ...parse(f.requests) };
      }
      if (!f.limits && !f.requests) fail('error: you must specify an update to requests or limits (in the form of --requests/--limits)');
      msg = 'resource requirements updated';
    } else if (sub === 'serviceaccount' || sub === 'sa') {
      const sa = pairs[0];
      if (!sa) fail('error: serviceaccount is required');
      spec.serviceAccountName = sa;
      delete spec.serviceAccount;
      msg = 'serviceaccount updated';
    } else if (sub === 'subject') {
      if (!['RoleBinding', 'ClusterRoleBinding'].includes(r.kind)) fail(`error: --${r.kind} is not supported`);
      n.subjects = n.subjects || [];
      for (const s of f.serviceaccount || []) { const [ns, nm] = s.split(':'); n.subjects.push({ kind: 'ServiceAccount', name: nm, namespace: ns }); }
      for (const u of (f.user || '').split(',').filter(Boolean)) n.subjects.push({ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: u });
      for (const g of f.group || []) n.subjects.push({ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: g });
      msg = 'subjects updated';
    } else if (sub === 'selector') {
      const sel = Object.fromEntries(pairs[0].split(',').map((kv) => kv.split('=')));
      if (r.kind === 'Service') n.spec.selector = sel; else n.spec.selector = { matchLabels: sel };
      msg = 'selector updated';
    }
    if (deepEqual(clean(n), clean(o))) { x.io.line(`${kindPrefix(r)}/${o.metadata.name} ${msg.split(' ')[0]} ${'not changed'}`.replace(' not changed', '') + ' (no change)'); continue; }
    if (r.kind === 'Deployment' && f.record) n.metadata.annotations = { ...(n.metadata.annotations || {}), 'kubernetes.io/change-cause': `kubectl set ${sub} ${x.pos.slice(1).join(' ')}` };
    try { const res = update(x, r, n); printResult(x, r, res, msg); } catch (e) { if (e instanceof ApiError) throw new KErr(1, e.kubectlMessage()); throw e; }
  }
  return 0;
}

// ------------------------------------------------------------------ rollout
function ownedRS(c, d) {
  return c.all('replicasets', d.metadata.namespace).filter((r) => (r.metadata.ownerReferences || []).some((o) => o.uid === d.metadata.uid));
}
function revisions(c, r, o) {
  if (r.kind === 'Deployment') return ownedRS(c, o).map((rs) => ({ rev: Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] || 0), cause: rs.metadata.annotations?.['kubernetes.io/change-cause'], tpl: rs.spec.template, obj: rs })).sort((a, b) => a.rev - b.rev);
  return c.all('controllerrevisions', o.metadata.namespace).filter((cr) => (cr.metadata.ownerReferences || []).some((y) => y.uid === o.metadata.uid)).map((cr) => ({ rev: cr.revision, cause: cr.metadata.annotations?.['kubernetes.io/change-cause'], tpl: cr.data?.spec?.template, obj: cr })).sort((a, b) => a.rev - b.rev);
}

function rolloutStatusText(c, r, o) {
  const s = o.status || {};
  if (r.kind === 'Deployment') {
    const want = o.spec.replicas ?? 1;
    if ((o.metadata.generation || 0) > (s.observedGeneration || 0)) return { msg: 'Waiting for deployment spec update to be observed...', done: false };
    const prog = (s.conditions || []).find((y) => y.type === 'Progressing');
    if (prog?.reason === 'ProgressDeadlineExceeded') return { error: `error: deployment "${o.metadata.name}" exceeded its progress deadline` };
    if ((s.updatedReplicas || 0) < want) return { msg: `Waiting for deployment "${o.metadata.name}" rollout to finish: ${s.updatedReplicas || 0} out of ${want} new replicas have been updated...`, done: false };
    if ((s.replicas || 0) > (s.updatedReplicas || 0)) return { msg: `Waiting for deployment "${o.metadata.name}" rollout to finish: ${(s.replicas || 0) - (s.updatedReplicas || 0)} old replicas are pending termination...`, done: false };
    if ((s.availableReplicas || 0) < (s.updatedReplicas || 0)) return { msg: `Waiting for deployment "${o.metadata.name}" rollout to finish: ${s.availableReplicas || 0} of ${s.updatedReplicas || 0} updated replicas are available...`, done: false };
    return { msg: `deployment "${o.metadata.name}" successfully rolled out`, done: true };
  }
  if (r.kind === 'DaemonSet') {
    const want = s.desiredNumberScheduled || 0;
    if ((s.updatedNumberScheduled || 0) < want) return { msg: `Waiting for daemon set "${o.metadata.name}" rollout to finish: ${s.updatedNumberScheduled || 0} out of ${want} new pods have been updated...`, done: false };
    if ((s.numberAvailable || 0) < want) return { msg: `Waiting for daemon set "${o.metadata.name}" rollout to finish: ${s.numberAvailable || 0} of ${want} updated pods are available...`, done: false };
    return { msg: `daemon set "${o.metadata.name}" successfully rolled out`, done: true };
  }
  if (r.kind === 'StatefulSet') {
    const want = o.spec.replicas ?? 1;
    if ((s.readyReplicas || 0) < want) return { msg: `Waiting for ${want - (s.readyReplicas || 0)} pods to be ready...`, done: false };
    if (s.updateRevision && s.currentRevision !== s.updateRevision) return { msg: `waiting for statefulset rolling update to complete ${s.updatedReplicas || 0} pods at revision ${s.updateRevision}...`, done: false };
    return { msg: `statefulset rolling update complete ${want} pods at revision ${s.currentRevision || o.metadata.name}...`, done: true };
  }
  fail(`error: no status viewer has been implemented for ${r.kind}`);
  return null;
}

function* cmdRollout(x) {
  x.api();
  const sub = x.pos[0];
  const f = x.f;
  if (!['status', 'history', 'undo', 'restart', 'pause', 'resume'].includes(sub)) {
    x.io.line('Manage the rollout of one or many resources.\n\nAvailable Commands:\n  history       View rollout history\n  pause         Mark the provided resource as paused\n  restart       Restart a resource\n  resume        Resume a paused resource\n  status        Show the status of the rollout\n  undo          Undo a previous rollout');
    return sub ? 1 : 0;
  }
  const groups = parseResourceArgs(x.c, x.pos.slice(1), { verb: `rollout ${sub}` });
  if (!groups.length) fail(`error: required resource not specified`);
  const objs = [];
  for (const g of groups) {
    if (!['Deployment', 'DaemonSet', 'StatefulSet'].includes(g.r.kind)) fail(`error: no ${sub === 'history' ? 'history viewer' : sub === 'status' ? 'status viewer' : sub === 'undo' ? 'rollbacker' : 'restarter'} has been implemented for "${g.r.kind}"`);
    if (g.names.length) for (const n of g.names) objs.push({ r: g.r, o: x.c.get(g.r, x.ns, n, { user: x.user }) });
    else for (const o of x.c.list(g.r, x.ns, { labelSelector: f.selector, user: x.user })) objs.push({ r: g.r, o });
  }
  for (const { r, o } of objs) {
    const name = `${kindPrefix(r)}/${o.metadata.name}`;
    if (sub === 'status') {
      const timeout = f.timeout ? parseDuration(f.timeout) * 1000 : Infinity;
      const t0 = x.c.now();
      let last = '';
      while (true) {
        const cur = x.c.peek(r, x.ns, o.metadata.name);
        if (!cur) fail(`Error from server (NotFound): ${r.plural}.${r.group} "${o.metadata.name}" not found`);
        const st = rolloutStatusText(x.c, r, cur);
        if (st.error) fail(st.error);
        if (st.msg !== last) { x.io.line(st.msg); last = st.msg; }
        if (st.done || f.watch === false) break;
        if (x.c.now() - t0 > timeout) fail('error: timed out waiting for the condition');
        yield* sleep(1000);
      }
      continue;
    }
    if (sub === 'history') {
      const revs = revisions(x.c, r, o);
      if (f.revision) {
        const rv = revs.find((y) => y.rev === Number(f.revision));
        if (!rv) fail(`error: unable to find the specified revision`);
        x.io.line(`${name} with revision #${rv.rev}`);
        x.io.out(describeTemplateForHistory(rv.tpl));
        continue;
      }
      x.io.line(`${name} `);
      x.io.line('REVISION  CHANGE-CAUSE');
      for (const rv of revs) x.io.line(`${String(rv.rev).padEnd(10)}${rv.cause || '<none>'}`);
      x.io.line('');
      continue;
    }
    if (sub === 'undo') {
      const revs = revisions(x.c, r, o);
      const curRev = r.kind === 'Deployment' ? Number(o.metadata.annotations?.['deployment.kubernetes.io/revision'] || 0) : revs[revs.length - 1]?.rev;
      let target;
      if (f['to-revision'] && Number(f['to-revision']) !== 0) {
        target = revs.find((y) => y.rev === Number(f['to-revision']));
        if (!target) fail(`error: unable to find specified revision ${f['to-revision']} in history`);
      } else {
        const older = revs.filter((y) => y.rev < curRev);
        target = older[older.length - 1];
        if (!target) fail(`error: no rollout history found for ${r.kind.toLowerCase()} "${o.metadata.name}"`);
      }
      if (target.rev === curRev) { x.io.line(`${name} skipped rollback (current template already matches revision ${target.rev})`); continue; }
      const n = clone(o);
      const tpl = clone(target.tpl);
      if (tpl.metadata?.labels) delete tpl.metadata.labels['pod-template-hash'];
      n.spec.template = tpl;
      if (target.cause) n.metadata.annotations = { ...(n.metadata.annotations || {}), 'kubernetes.io/change-cause': target.cause };
      else if (n.metadata.annotations) delete n.metadata.annotations['kubernetes.io/change-cause'];
      update(x, r, n);
      x.io.line(`${name} rolled back`);
      continue;
    }
    if (sub === 'restart') {
      if (o.spec.paused) fail(`error: ${name} can't restart paused deployment (run rollout resume first)`);
      const n = clone(o);
      n.spec.template.metadata = n.spec.template.metadata || {};
      n.spec.template.metadata.annotations = { ...(n.spec.template.metadata.annotations || {}), 'kubectl.kubernetes.io/restartedAt': new Date(x.c.now()).toISOString().replace(/\.\d+Z$/, 'Z') };
      update(x, r, n);
      x.io.line(`${name} restarted`);
      continue;
    }
    if (sub === 'pause' || sub === 'resume') {
      if (r.kind !== 'Deployment') fail(`error: ${name} pausing is not supported`);
      const want = sub === 'pause';
      if (!!o.spec.paused === want) { x.io.line(`${name} already ${want ? 'paused' : 'resumed'}`); continue; }
      const n = clone(o);
      if (want) n.spec.paused = true; else delete n.spec.paused;
      update(x, r, n);
      x.io.line(`${name} ${want ? 'paused' : 'resumed'}`);
    }
  }
  return 0;
}

// ------------------------------------------------------------------ taint
function* cmdTaint(x) {
  x.api();
  const f = x.f;
  const pos = [...x.pos];
  let t = pos.shift();
  if (!t) fail("error: at least one taint update is required");
  let nodes = [];
  if (t.includes('/')) { const [tt, nn] = t.split('/'); t = tt; nodes.push(nn); }
  if (!/^(node|nodes|no)$/.test(t)) fail(`error: invalid resource type ${t}, only node types are supported`);
  while (pos.length && !/[=:]/.test(pos[0]) && !pos[0].endsWith('-')) nodes.push(pos.shift());
  if (f.all || f.selector) nodes = x.c.list('nodes', null, { labelSelector: f.selector, user: x.user }).map((n) => n.metadata.name);
  if (!pos.length) fail('error: at least one taint update is required');
  const add = [], rm = [];
  for (const s of pos) {
    if (s.endsWith('-')) {
      const b = s.slice(0, -1);
      const [kv, effect] = b.split(':');
      rm.push({ key: kv.split('=')[0], effect });
      continue;
    }
    const m = s.match(/^([^=:]+)(?:=([^:]*))?:(.+)$/);
    if (!m) fail(`error: invalid taint spec: ${s}, unknown taint spec`);
    if (!['NoSchedule', 'PreferNoSchedule', 'NoExecute'].includes(m[3])) fail(`error: invalid taint spec: ${s}, invalid taint effect: ${m[3]}, unsupported taint effect`);
    add.push({ key: m[1], ...(m[2] ? { value: m[2] } : {}), effect: m[3] });
  }
  for (const nn of nodes) {
    const n = x.c.get('nodes', null, nn, { user: x.user });
    let taints = [...(n.spec.taints || [])];
    for (const a of add) {
      const ex = taints.find((y) => y.key === a.key && y.effect === a.effect);
      if (ex && !f.overwrite) fail(`error: node ${nn} already has ${a.key} taint(s) with same effect(s) and --overwrite is false`);
      taints = taints.filter((y) => !(y.key === a.key && y.effect === a.effect));
      taints.push(a);
    }
    for (const r of rm) {
      const before = taints.length;
      taints = taints.filter((y) => !(y.key === r.key && (!r.effect || y.effect === r.effect)));
      if (before === taints.length) fail(`error: taint "${r.key}${r.effect ? ':' + r.effect : ''}" not found`);
    }
    const nn2 = clone(n);
    nn2.spec.taints = taints;
    if (!taints.length) delete nn2.spec.taints;
    update(x, x.c.res('nodes'), nn2);
    x.io.line(`node/${nn} ${rm.length && !add.length ? 'untainted' : 'tainted'}`);
  }
  return 0;
}

// ------------------------------------------------------------------ cordon / uncordon / drain
function nodeArgs(x) {
  let names = x.pos.map((p) => p.replace(/^(node|nodes|no)\//, ''));
  if (x.f.selector) names = x.c.list('nodes', null, { labelSelector: x.f.selector, user: x.user }).map((n) => n.metadata.name);
  if (!names.length) fail('error: USAGE: cordon NODE [flags]');
  return names;
}
function setUnschedulable(x, name, val) {
  const n = x.c.get('nodes', null, name, { user: x.user });
  if (!!n.spec.unschedulable === val) return false;
  const nn = clone(n);
  if (val) nn.spec.unschedulable = true; else delete nn.spec.unschedulable;
  update(x, x.c.res('nodes'), nn);
  return true;
}
function* cmdCordon(x) { x.api(); for (const n of nodeArgs(x)) x.io.line(`node/${n} ${setUnschedulable(x, n, true) ? 'cordoned' : 'already cordoned'}`); return 0; }
function* cmdUncordon(x) { x.api(); for (const n of nodeArgs(x)) x.io.line(`node/${n} ${setUnschedulable(x, n, false) ? 'uncordoned' : 'already uncordoned'}`); return 0; }

function* cmdDrain(x) {
  x.api();
  const f = x.f;
  const names = nodeArgs(x);
  for (const name of names) {
    x.io.line(`node/${name} ${setUnschedulable(x, name, true) ? 'cordoned' : 'already cordoned'}`);
    const pods = x.c.all('pods').filter((p) => p.spec.nodeName === name && !['Succeeded', 'Failed'].includes(p.status?.phase));
    const ds = [], local = [], bare = [], toEvict = [];
    for (const p of pods) {
      if (p.metadata.annotations?.['kubernetes.io/config.mirror']) continue;
      const ctrl = (p.metadata.ownerReferences || []).find((o) => o.controller);
      if (ctrl?.kind === 'DaemonSet') { ds.push(p); continue; }
      if (!ctrl) bare.push(p);
      if ((p.spec.volumes || []).some((v) => v.emptyDir)) local.push(p);
      toEvict.push(p);
    }
    const errs = [];
    if (ds.length && !f['ignore-daemonsets']) errs.push(`cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore): ${ds.map((p) => `${p.metadata.namespace}/${p.metadata.name}`).join(', ')}`);
    if (bare.length && !f.force) errs.push(`cannot delete Pods that declare no controller (use --force to override): ${bare.map((p) => `${p.metadata.namespace}/${p.metadata.name}`).join(', ')}`);
    if (local.length && !f['delete-emptydir-data']) errs.push(`cannot delete Pods with local storage (use --delete-emptydir-data to override): ${local.map((p) => `${p.metadata.namespace}/${p.metadata.name}`).join(', ')}`);
    if (errs.length) {
      x.io.eline(`error: unable to drain node "${name}" due to error: [${errs.join(', ')}], continuing command...\nThere are pending nodes to be drained:\n ${name}`);
      for (const e of errs) x.io.eline(`error: ${e}`);
      return 1;
    }
    if (ds.length) x.io.eline(`Warning: ignoring DaemonSet-managed Pods: ${ds.map((p) => `${p.metadata.namespace}/${p.metadata.name}`).join(', ')}`);
    if (bare.length) x.io.eline(`Warning: deleting Pods that declare no controller: ${bare.map((p) => `${p.metadata.namespace}/${p.metadata.name}`).join(', ')}`);
    for (const p of toEvict) {
      x.io.line(`evicting pod ${p.metadata.namespace}/${p.metadata.name}`);
      x.c.doDelete(x.c.res('pods'), x.c.peek('pods', p.metadata.namespace, p.metadata.name), { gracePeriod: f['grace-period'] !== undefined && Number(f['grace-period']) >= 0 ? Number(f['grace-period']) : undefined });
    }
    x.c.reconcile();
    const deadline = x.c.now() + (f.timeout ? parseDuration(f.timeout) * 1000 : 3600e3);
    const pending = new Set(toEvict.map((p) => `${p.metadata.namespace}/${p.metadata.name}/${p.metadata.uid}`));
    while (pending.size && x.c.now() < deadline) {
      for (const k of [...pending]) {
        const [ns, n, uid] = k.split('/');
        const cur = x.c.peek('pods', ns, n);
        if (!cur || cur.metadata.uid !== uid) { x.io.line(`pod/${n} evicted`); pending.delete(k); }
      }
      if (pending.size) yield* sleep(500);
    }
    if (pending.size) { x.io.eline(`error: unable to drain node "${name}" due to error: global timeout reached`); return 1; }
    x.io.line(`node/${name} drained`);
  }
  return 0;
}

export const MODIFY_CMDS = { label: cmdLabel, annotate: cmdAnnotate, scale: cmdScale, autoscale: cmdAutoscale, set: cmdSet, rollout: cmdRollout, taint: cmdTaint, cordon: cmdCordon, uncordon: cmdUncordon, drain: cmdDrain };
void labelsString; void matchLabelSelector;
