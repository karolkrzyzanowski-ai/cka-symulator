// kubectl apply / edit / patch / replace / kustomize / diff
import { fail, KErr, apiMsg, parseResourceArgs, readManifestSources, decodeDocs, render, parseOutput, clean, toYaml } from './common.js';
import { kindPrefix } from './printers.js';
import { ApiError } from '../sim/cluster.js';
import { clone, deepEqual, strategicMerge, mergePatch, jsonPatch, safeHash, b64enc, dirname, normPath } from '../lib/util.js';
import { parseAll, parseOne, dump } from '../lib/yaml.js';
import { LAST_APPLIED, lastApplied, dryRunMode, stripNulls } from './create.js';

function* sleep(ms) { yield { type: 'sleep', ms }; }
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------------ 3-way merge (apply)
function mergeKey(path) {
  const last = path[path.length - 1];
  if (['containers', 'initContainers', 'ephemeralContainers', 'volumes', 'env', 'imagePullSecrets'].includes(last)) return 'name';
  if (last === 'volumeMounts') return 'mountPath';
  if (last === 'ports') return path.includes('containers') || path.includes('initContainers') ? 'containerPort' : 'port';
  if (last === 'hostAliases') return 'ip';
  return null;
}
export function threeWay(live, last, desired, path = []) {
  if (isObj(desired) && isObj(live)) {
    const out = { ...live };
    for (const k of Object.keys(desired)) out[k] = threeWay(live[k], isObj(last) ? last[k] : undefined, desired[k], [...path, k]);
    if (isObj(last)) for (const k of Object.keys(last)) if (!(k in desired)) delete out[k];
    return out;
  }
  if (Array.isArray(desired) && Array.isArray(live)) {
    const key = mergeKey(path);
    if (!key) return clone(desired);
    const la = Array.isArray(last) ? last : [];
    const out = [];
    for (const d of desired) {
      const l = live.find((i) => i?.[key] === d?.[key]);
      const a = la.find((i) => i?.[key] === d?.[key]);
      out.push(l ? threeWay(l, a, d, path) : clone(d));
    }
    for (const l of live) if (!desired.some((d) => d?.[key] === l?.[key]) && !la.some((a) => a?.[key] === l?.[key])) out.push(l);
    return out;
  }
  if (desired === null) return undefined;
  return desired === undefined ? live : clone(desired);
}

function sanitizeDoc(o) {
  const d = clone(o);
  stripNulls(d);
  if (d.status && isObj(d.status) && !Object.keys(d.status).length) delete d.status;
  return d;
}

function nsFor(x, r, obj) {
  if (!r.namespaced) return null;
  const docNs = obj.metadata?.namespace;
  if (docNs && x.f.namespace && docNs !== x.f.namespace) fail(`error: the namespace from the provided object "${docNs}" does not match the namespace "${x.f.namespace}". You must pass '--namespace=${docNs}' to perform this operation.`);
  return docNs || x.ns;
}

function* applyOne(x, doc, source) {
  const c = x.c;
  const obj = doc;
  if (!obj.apiVersion || !obj.kind) fail(`error: error validating "${source}": error validating data: [${!obj.apiVersion ? 'apiVersion not set' : ''}${!obj.apiVersion && !obj.kind ? ', ' : ''}${!obj.kind ? 'kind not set' : ''}]; if you choose to ignore these errors, turn validation off with --validate=false`);
  const r = c.registry.byKind(obj.apiVersion, obj.kind);
  if (!r) fail(`error: resource mapping not found for name: "${obj.metadata?.name}" namespace: "${obj.metadata?.namespace || ''}" from "${source}": no matches for kind "${obj.kind}" in version "${obj.apiVersion}"\nensure CRDs are installed first`);
  if (!obj.metadata?.name) fail(`error: error when retrieving current configuration of:\nResource: "${r.plural}", GroupVersionKind: "${r.group ? r.group + '/' : ''}${r.version}, Kind=${r.kind}"\nfrom server for: "${source}": resource name may not be empty`);
  const ns = nsFor(x, r, obj);
  const mode = dryRunMode(x.f);
  const desired = sanitizeDoc(obj);
  if (r.namespaced) desired.metadata.namespace = ns;
  const annotated = clone(desired);
  annotated.metadata.annotations = { ...(annotated.metadata.annotations || {}), [LAST_APPLIED]: lastApplied(obj.metadata?.namespace || !r.namespaced ? obj : { ...obj, metadata: { ...obj.metadata } }) };
  const live = c.peek(r, ns, obj.metadata.name);
  const out = x.f.output ? parseOutput(x.f.output) : null;
  const report = (o, verb) => {
    if (out) x.io.out(render(x, [{ r, items: [o] }], out, { single: true, flags: x.f }));
    else x.io.line(`${kindPrefix(r)}/${obj.metadata.name} ${verb}${mode === 'client' ? ' (dry run)' : mode === 'server' ? ' (server dry run)' : ''}`);
  };
  if (x.f['server-side']) {
    // uproszczone server-side apply
    if (!live) { const res = c.create(desired, { user: x.user, ns, dryRun: !!mode }); report(res, 'serverside-applied'); return; }
    const merged = threeWay(clone(live), null, desired);
    const res = c.update(merged, { user: x.user, dryRun: !!mode });
    report(res, 'serverside-applied');
    return;
  }
  if (!live) {
    if (mode === 'client') { report(annotated, 'created'); return; }
    c.authz(x.user, 'get', r, ns, obj.metadata.name);
    let res;
    try { res = c.create(annotated, { user: x.user, ns, dryRun: mode === 'server' }); } catch (e) {
      if (e instanceof ApiError) {
        if (e.reason === 'Invalid') throw new KErr(1, e.kubectlMessage());
        throw new KErr(1, `Error from server (${e.reason}): error when creating "${source}": ${e.message}`);
      }
      throw e;
    }
    for (const w of res.__warnings || []) x.io.eline(`Warning: ${w}`);
    report(res, 'created');
    return;
  }
  const lastStr = live.metadata.annotations?.[LAST_APPLIED];
  let last = null;
  if (lastStr) { try { last = JSON.parse(lastStr); } catch { last = null; } } else if (mode !== 'client') {
    x.io.eline(`Warning: resource ${r.plural}${r.group ? '.' + r.group : ''}/${obj.metadata.name} is missing the ${LAST_APPLIED} annotation which is required by kubectl apply. kubectl apply should only be used on resources created declaratively by either kubectl create --save-config or kubectl apply. The missing annotation will be patched automatically.`);
  }
  const merged = threeWay(clone(live), last ? sanitizeDoc(last) : null, annotated);
  if (deepEqual(clean(merged), clean(live))) { report(live, 'unchanged'); return; }
  if (mode === 'client') { report(merged, 'configured'); return; }
  let res;
  try { res = c.update(merged, { user: x.user, dryRun: mode === 'server' }); } catch (e) {
    if (e instanceof ApiError) {
      if (e.reason === 'Invalid') throw new KErr(1, e.kubectlMessage());
      throw new KErr(1, `Error from server (${e.reason}): error when applying patch:\n${JSON.stringify(clean(obj)).slice(0, 300)}\n\nResource: "${r.group ? r.group + '/' : ''}${r.version}, Resource=${r.plural}", GroupVersionKind: "${r.group ? r.group + '/' : ''}${r.version}, Kind=${r.kind}"\nName: "${obj.metadata.name}", Namespace: "${ns || ''}"\nfor: "${source}": error when patching "${source}": ${e.message}`);
    }
    throw e;
  }
  const changedOnlyAnnotation = deepEqual({ ...clean(merged), metadata: { ...clean(merged).metadata, annotations: undefined } }, { ...clean(live), metadata: { ...clean(live).metadata, annotations: undefined } });
  report(res, changedOnlyAnnotation && lastStr ? 'configured' : 'configured');
}

function* cmdApply(x) {
  const f = x.f;
  const sub = x.pos[0];
  if (sub === 'view-last-applied' || sub === 'edit-last-applied' || sub === 'set-last-applied') {
    x.api();
    const groups = parseResourceArgs(x.c, x.pos.slice(1));
    for (const g of groups) for (const n of g.names) {
      const o = x.c.get(g.r, x.ns, n, { user: x.user });
      const a = o.metadata.annotations?.[LAST_APPLIED];
      if (!a) fail(`error: no last-applied-configuration annotation found on resource: ${n}`);
      x.io.out(f.output === 'json' ? JSON.stringify(JSON.parse(a), null, 2) + '\n' : dump(JSON.parse(a)));
    }
    return 0;
  }
  if (!f.filename?.length && !f.kustomize) fail("error: must specify one of -f and -k\n\nSee 'kubectl apply -h' for help and examples");
  if (dryRunMode(f) !== 'client') x.api(); else { try { x.api(); } catch { /* offline */ } }
  const docs = f.kustomize ? (yield* kustomizeDocs(x, f.kustomize)) : readManifestSources(x, f.filename, { recursive: f.recursive });
  if (!docs.length) fail('error: no objects passed to apply');
  // CRD najpierw (jak przy instalacji operatorów)
  const ordered = [...docs.filter((d) => d.obj.kind === 'CustomResourceDefinition' || d.obj.kind === 'Namespace'), ...docs.filter((d) => d.obj.kind !== 'CustomResourceDefinition' && d.obj.kind !== 'Namespace')];
  let st = 0;
  for (const d of ordered) {
    try { yield* applyOne(x, d.obj, d.source); } catch (e) {
      if (e instanceof KErr) { x.io.eline(e.message); st = 1; continue; }
      if (e instanceof ApiError) { x.io.eline(e.kubectlMessage()); st = 1; continue; }
      throw e;
    }
    if (d.obj.kind === 'CustomResourceDefinition') x.c.reconcile();
  }
  x.c.reconcile();
  return st;
}

// ------------------------------------------------------------------ edit
const EDIT_HEADER = `# Please edit the object below. Lines beginning with a '#' will be ignored,
# and an empty file will abort the edit. If an error occurs while saving this file will be
# reopened with the relevant failures.
#
`;

function editable(o) {
  const c = clean(o);
  return c;
}

function* cmdEdit(x) {
  x.api();
  const f = x.f;
  let objs = [];
  if (f.filename?.length) {
    for (const d of readManifestSources(x, f.filename)) {
      const r = x.c.registry.byKindAnyVersion(d.obj.apiVersion, d.obj.kind);
      objs.push({ r, o: x.c.get(r, d.obj.metadata.namespace || x.ns, d.obj.metadata.name, { user: x.user }) });
    }
  } else {
    if (!x.pos.length) fail("error: You must provide one or more resources by argument or filename.");
    const groups = parseResourceArgs(x.c, x.pos, { verb: 'edit' });
    for (const g of groups) {
      if (g.names.length) for (const n of g.names) objs.push({ r: g.r, o: x.c.get(g.r, x.ns, n, { user: x.user }) });
      else for (const o of x.c.list(g.r, g.r.namespaced ? x.ns : null, { labelSelector: f.selector, user: x.user })) objs.push({ r: g.r, o });
    }
  }
  if (!objs.length) { x.io.eline(`error: no objects found to edit`); return 1; }
  const json = f.output === 'json';
  const serialize = (list) => (list.length === 1 ? (json ? JSON.stringify(editable(list[0].o), null, 4) + '\n' : dump(editable(list[0].o))) : (json ? JSON.stringify({ apiVersion: 'v1', items: list.map((y) => editable(y.o)), kind: 'List', metadata: {} }, null, 4) : dump({ apiVersion: 'v1', items: list.map((y) => editable(y.o)), kind: 'List', metadata: {} })));
  const original = serialize(objs);
  let content = EDIT_HEADER + original;
  const tmpName = `/tmp/kubectl-edit-${String(Math.floor(1e9 + (x.c.now() % 1e9)))}.yaml`;
  let errorsShown = null;
  let lastEdited = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = yield { type: 'edit', path: tmpName, name: tmpName, content, readonly: false, kubectlEdit: true };
    const edited = res?.saved ? res.content : content;
    const body = edited.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    if (!body.trim()) { x.io.eline('Edit cancelled, no changes made.'); return 0; }
    if (errorsShown && (edited === content || !res?.saved)) {
      // ponowne zapisanie bez poprawek - kończymy z błędem
      try { x.sh.fs.write(tmpName, lastEdited || body, { user: x.sh.user }); } catch { /* */ }
      x.io.eline(errorsShown.summary);
      x.io.eline(`A copy of your changes has been stored to "${tmpName}"`);
      x.io.eline('error: Edit cancelled, no valid changes were saved.');
      return 1;
    }
    if (!res?.saved || body.trim() === original.trim()) { x.io.eline('Edit cancelled, no changes made.'); return 0; }
    lastEdited = body;
    let docs;
    try { docs = json ? [JSON.parse(body)] : parseAll(body).filter(Boolean); } catch (e) {
      errorsShown = { summary: `error: ${e.message}` };
      content = EDIT_HEADER + `# ${e.message}\n#\n` + body;
      continue;
    }
    const newObjs = docs.length === 1 && docs[0].kind === 'List' ? docs[0].items : docs;
    const failures = [];
    let ok = 0;
    for (const n of newObjs) {
      const orig = objs.find((y) => y.o.metadata.name === n?.metadata?.name && y.o.kind === n?.kind);
      if (!orig) { failures.push({ msg: `the name of the object cannot be changed`, kind: n?.kind, name: n?.metadata?.name }); continue; }
      if (deepEqual(clean(n), editable(orig.o))) continue;
      try {
        const upd = clone(n);
        upd.metadata.resourceVersion = orig.o.metadata.resourceVersion;
        x.c.update(upd, { user: x.user });
        x.io.line(`${kindPrefix(orig.r)}/${orig.o.metadata.name} edited`);
        ok++;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        failures.push({ msg: e.message, kind: orig.o.kind, name: orig.o.metadata.name, r: orig.r, e });
      }
    }
    x.c.reconcile();
    if (!failures.length) { if (!ok) x.io.eline('Edit cancelled, no changes made.'); return 0; }
    const fl = failures[0];
    const qn = fl.r ? (fl.r.group ? `${fl.r.plural}.${fl.r.group}` : fl.r.plural) : 'object';
    const detail = fl.e?.reason === 'Invalid' ? fl.msg.split('; ').map((m) => `# * ${m}`).join('\n') : `# ${fl.msg}`;
    errorsShown = { summary: fl.e?.reason === 'Invalid' ? `error: ${qn} "${fl.name}" is invalid` : `error: ${fl.e ? fl.e.kubectlMessage() : fl.msg}` };
    content = EDIT_HEADER + `# ${qn} "${fl.name}" was not valid:\n${detail}\n#\n` + body.replace(/^\n+/, '');
  }
  return 1;
}

// ------------------------------------------------------------------ patch
function* cmdPatch(x) {
  x.api();
  const f = x.f;
  let patchText = f.patch;
  if (f['patch-file']) { try { patchText = x.sh.fs.read(x.sh.abs(f['patch-file']), x.sh.user); } catch { fail(`error: unable to read patch file: open ${f['patch-file']}: no such file or directory`); } }
  if (patchText === undefined) fail('error: must specify --patch or --patch-file containing the contents of the patch');
  let patch;
  try { patch = parseOne(patchText); } catch (e) { fail(`error: unable to parse "${patchText}": ${e.message.replace('error converting YAML to JSON: ', '')}`); }
  const type = f.type || 'strategic';
  if (!['strategic', 'merge', 'json'].includes(type)) fail(`error: --type must be one of [json merge strategic], not "${type}"`);
  let objs = [];
  if (f.filename?.length) {
    for (const d of readManifestSources(x, f.filename)) {
      const r = x.c.registry.byKindAnyVersion(d.obj.apiVersion, d.obj.kind);
      objs.push({ r, o: x.c.get(r, d.obj.metadata.namespace || x.ns, d.obj.metadata.name, { user: x.user }) });
    }
  } else {
    const groups = parseResourceArgs(x.c, x.pos, { verb: 'patch' });
    if (!groups.length) fail('error: resource(s) were provided, but no name was specified');
    for (const g of groups) {
      if (!g.names.length) fail('error: resource(s) were provided, but no name was specified');
      for (const n of g.names) objs.push({ r: g.r, o: x.c.get(g.r, x.ns, n, { user: x.user }) });
    }
  }
  for (const { r, o } of objs) {
    if (type === 'strategic' && r.crd) fail(`error: application/strategic-merge-patch+json is not supported by ${r.group}/${r.version}, Kind=${r.kind}: the body of the request was in an unknown format - accepted media types include: application/json-patch+json, application/merge-patch+json, application/apply-patch+yaml`);
    let n;
    try {
      if (type === 'json') n = jsonPatch(o, patch);
      else if (type === 'merge') n = mergePatch(o, patch);
      else n = strategicMerge(o, patch);
    } catch (e) {
      fail(`Error from server (UnprocessableEntity): ${e.message}`);
    }
    if (f.subresource === 'status') {
      if (deepEqual(n, o)) { x.io.line(`${kindPrefix(r)}/${o.metadata.name} patched (no change)`); continue; }
      x.c.put(n);
      x.io.line(`${kindPrefix(r)}/${o.metadata.name} patched`);
      continue;
    }
    if (deepEqual(clean(n), clean(o))) { x.io.line(`${kindPrefix(r)}/${o.metadata.name} patched (no change)`); continue; }
    const mode = dryRunMode(f);
    try {
      const res = x.c.update(n, { user: x.user, dryRun: !!mode, subresource: f.subresource });
      if (f.output) x.io.out(render(x, [{ r, items: [res] }], parseOutput(f.output), { single: true }));
      else x.io.line(`${kindPrefix(r)}/${o.metadata.name} patched${mode ? ' (dry run)' : ''}`);
    } catch (e) {
      if (e instanceof ApiError) throw new KErr(1, e.kubectlMessage());
      throw e;
    }
  }
  x.c.reconcile();
  return 0;
}

// ------------------------------------------------------------------ replace
function* cmdReplace(x) {
  x.api();
  const f = x.f;
  if (!f.filename?.length) fail("error: must specify --filename to replace\n\nSee 'kubectl replace -h' for help and examples");
  const docs = readManifestSources(x, f.filename, { recursive: f.recursive });
  let st = 0;
  for (const d of docs) {
    const obj = sanitizeDoc(d.obj);
    const r = x.c.registry.byKind(obj.apiVersion, obj.kind);
    if (!r) { x.io.eline(`error: resource mapping not found for name: "${obj.metadata?.name}" from "${d.source}": no matches for kind "${obj.kind}" in version "${obj.apiVersion}"`); st = 1; continue; }
    const ns = r.namespaced ? obj.metadata.namespace || x.ns : null;
    if (r.namespaced) obj.metadata.namespace = ns;
    try {
      if (f.force) {
        const live = x.c.peek(r, ns, obj.metadata.name);
        if (live) {
          x.c.delete(r, ns, obj.metadata.name, { user: x.user, gracePeriod: f['grace-period'] !== undefined ? Number(f['grace-period']) : undefined });
          x.io.line(`${kindPrefix(r)} "${obj.metadata.name}" deleted${r.namespaced ? ` from ${ns} namespace` : ''}`);
          const t0 = x.c.now();
          while (x.c.peek(r, ns, obj.metadata.name) && x.c.now() - t0 < 3600e3) yield* sleep(500);
        }
        delete obj.metadata.resourceVersion;
        delete obj.metadata.uid;
        delete obj.metadata.creationTimestamp;
        if (obj.kind === 'Pod') delete obj.status;
        x.c.create(obj, { user: x.user, ns });
        x.io.line(`${kindPrefix(r)}/${obj.metadata.name} replaced`);
      } else {
        const live = x.c.peek(r, ns, obj.metadata.name);
        if (!live) throw new ApiError(404, 'NotFound', `error when replacing "${d.source}": ${r.group ? `${r.plural}.${r.group}` : r.plural} "${obj.metadata.name}" not found`);
        x.c.update(obj, { user: x.user });
        x.io.line(`${kindPrefix(r)}/${obj.metadata.name} replaced`);
      }
    } catch (e) {
      if (e instanceof ApiError) { x.io.eline(e.reason === 'Invalid' ? e.kubectlMessage() : `Error from server (${e.reason}): ${e.message.startsWith('error when') ? e.message : `error when replacing "${d.source}": ${e.message}`}`); st = 1; continue; }
      throw e;
    }
  }
  x.c.reconcile();
  return st;
}

// ------------------------------------------------------------------ diff
function* cmdDiff(x) {
  x.api();
  const docs = x.f.kustomize ? (yield* kustomizeDocs(x, x.f.kustomize)) : readManifestSources(x, x.f.filename || [], { recursive: x.f.recursive });
  let diffs = 0;
  for (const d of docs) {
    const r = x.c.registry.byKindAnyVersion(d.obj.apiVersion, d.obj.kind);
    const ns = r.namespaced ? d.obj.metadata.namespace || x.ns : null;
    const live = x.c.peek(r, ns, d.obj.metadata.name);
    const last = live?.metadata?.annotations?.[LAST_APPLIED] ? JSON.parse(live.metadata.annotations[LAST_APPLIED]) : null;
    const merged = live ? threeWay(clone(live), last, sanitizeDoc(d.obj)) : sanitizeDoc(d.obj);
    const a = live ? dump(stripMeta(clean(live))).split('\n') : [];
    const b = dump(stripMeta(clean(merged))).split('\n');
    if (a.join('\n') === b.join('\n')) continue;
    diffs++;
    const id = `${r.group ? r.group + '.' : ''}${r.version}.${r.kind}.${ns ? ns + '.' : ''}${d.obj.metadata.name}`;
    x.io.line(`diff -u -N /tmp/LIVE-2781036948/${id} /tmp/MERGED-1439202214/${id}`);
    x.io.line(`--- /tmp/LIVE-2781036948/${id}\t2026-01-01 08:00:00.000000000 +0000`);
    x.io.line(`+++ /tmp/MERGED-1439202214/${id}\t2026-01-01 08:00:00.000000000 +0000`);
    x.io.out(unifiedDiff(a, b));
  }
  return diffs ? 1 : 0;
}
function stripMeta(o) {
  const c = clone(o);
  if (c.metadata) { delete c.metadata.resourceVersion; delete c.metadata.managedFields; if (c.metadata.annotations) delete c.metadata.annotations[LAST_APPLIED]; if (c.metadata.annotations && !Object.keys(c.metadata.annotations).length) delete c.metadata.annotations; }
  delete c.status;
  return c;
}
export function unifiedDiff(a, b) {
  // prosty LCS
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a[i]]); i++; } else { ops.push(['+', b[j]]); j++; }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  // hunki z kontekstem 3
  const out = [];
  const changed = ops.map((o, k) => (o[0] !== ' ' ? k : -1)).filter((k) => k >= 0);
  if (!changed.length) return '';
  let start = Math.max(0, changed[0] - 3), end = Math.min(ops.length, changed[0] + 4);
  const hunks = [];
  for (const k of changed.slice(1)) {
    if (k - 3 <= end) end = Math.min(ops.length, k + 4);
    else { hunks.push([start, end]); start = Math.max(0, k - 3); end = Math.min(ops.length, k + 4); }
  }
  hunks.push([start, end]);
  for (const [s, e] of hunks) {
    let la = 1, lb = 1;
    for (let k = 0; k < s; k++) { if (ops[k][0] !== '+') la++; if (ops[k][0] !== '-') lb++; }
    const seg = ops.slice(s, e);
    out.push(`@@ -${la},${seg.filter((o) => o[0] !== '+').length} +${lb},${seg.filter((o) => o[0] !== '-').length} @@`);
    for (const o of seg) out.push(o[0] + o[1]);
  }
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ kustomize
const LEGACY_ORDER = ['Namespace', 'ResourceQuota', 'StorageClass', 'CustomResourceDefinition', 'ServiceAccount', 'PodSecurityPolicy', 'Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding', 'ConfigMap', 'Secret', 'Endpoints', 'Service', 'LimitRange', 'PriorityClass', 'PersistentVolume', 'PersistentVolumeClaim', 'Deployment', 'StatefulSet', 'CronJob', 'PodDisruptionBudget'];
const LAST_ORDER = ['MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration'];

function findKustomization(fs, dir) {
  for (const n of ['kustomization.yaml', 'kustomization.yml', 'Kustomization']) if (fs.exists(`${dir}/${n}`)) return `${dir}/${n}`;
  return null;
}

function buildKustomization(x, dir, depth = 0) {
  const fs = x.sh.fs;
  if (depth > 10) fail('error: kustomization cycle detected');
  const kf = findKustomization(fs, dir);
  if (!kf) fail(`error: unable to find one of 'kustomization.yaml', 'kustomization.yml' or 'Kustomization' in directory '${dir}'`);
  let k;
  try { k = parseOne(fs.read(kf, x.sh.user)) || {}; } catch (e) { fail(`error: invalid Kustomization: ${e.message}`); }
  const known = ['apiVersion', 'kind', 'resources', 'bases', 'namespace', 'namePrefix', 'nameSuffix', 'commonLabels', 'labels', 'commonAnnotations', 'images', 'replicas', 'patches', 'patchesStrategicMerge', 'patchesJson6902', 'configMapGenerator', 'secretGenerator', 'generatorOptions', 'components', 'crds', 'buildMetadata', 'sortOptions', 'openapi', 'helmCharts', 'transformers', 'generators', 'vars', 'replacements', 'metadata'];
  for (const key of Object.keys(k)) if (!known.includes(key)) fail(`error: invalid Kustomization: json: unknown field "${key}"`);
  let res = [];
  const load = (rel) => {
    const p = normPath(`${dir}/${rel}`);
    if (!fs.exists(p)) fail(`error: accumulating resources: accumulation err='accumulating resources from '${rel}': open ${p}: no such file or directory': must build at directory: not a valid directory: evalsymlink failure on '${p}' : lstat ${p}: no such file or directory`);
    if (fs.isDir(p)) return buildKustomization(x, p, depth + 1);
    return decodeDocs(fs.read(p, x.sh.user), p).map((d) => d.obj);
  };
  for (const rel of [...(k.resources || []), ...(k.bases || []), ...(k.crds || [])]) res.push(...load(rel));
  // generatory
  const genOpts = k.generatorOptions || {};
  const renames = {};
  const gen = (g, kind) => {
    const data = {};
    for (const l of g.literals || []) { const i = l.indexOf('='); data[l.slice(0, i)] = l.slice(i + 1); }
    for (const f of g.files || []) {
      let key = null, path = f;
      if (f.includes('=')) [key, path] = [f.slice(0, f.indexOf('=')), f.slice(f.indexOf('=') + 1)];
      const p = normPath(`${dir}/${path}`);
      try { data[key || path.split('/').pop()] = fs.read(p, x.sh.user); } catch { fail(`error: accumulating resources: evalsymlink failure on '${p}' : lstat ${p}: no such file or directory`); }
    }
    for (const e of [...(g.envs || []), ...(g.env ? [g.env] : [])]) {
      const t = fs.read(normPath(`${dir}/${e}`), x.sh.user);
      for (const line of t.split('\n')) { const s = line.trim(); if (!s || s.startsWith('#')) continue; const i = s.indexOf('='); data[s.slice(0, i)] = s.slice(i + 1); }
    }
    const o = { apiVersion: 'v1', kind, metadata: { name: g.name, ...(g.namespace ? { namespace: g.namespace } : {}) } };
    if (kind === 'Secret') { o.type = g.type || 'Opaque'; o.data = Object.fromEntries(Object.entries(data).map(([a, b]) => [a, b64enc(b)])); } else o.data = data;
    const opts = { ...genOpts, ...(g.options || {}) };
    if (opts.labels) o.metadata.labels = { ...opts.labels };
    if (opts.annotations) o.metadata.annotations = { ...opts.annotations };
    if (g.behavior === 'merge' || g.behavior === 'replace') {
      const ex = res.find((y) => y.kind === kind && (y.metadata.__origName || y.metadata.name).startsWith(g.name));
      if (ex) {
        ex.data = g.behavior === 'merge' ? { ...(ex.data || {}), ...o.data } : o.data;
        if (!ex.metadata.__noHash) { const base = ex.metadata.__origName || g.name; ex.metadata.name = `${base}-${safeHash(JSON.stringify(ex.data), 10)}`; renames[`${kind}/${base}`] = ex.metadata.name; }
        return;
      }
    }
    if (!opts.disableNameSuffixHash) { o.metadata.__origName = g.name; o.metadata.name = `${g.name}-${safeHash(JSON.stringify({ kind, data: o.data }), 10)}`; renames[`${kind}/${g.name}`] = o.metadata.name; } else o.metadata.__noHash = true;
    res.push(o);
  };
  for (const g of k.configMapGenerator || []) gen(g, 'ConfigMap');
  for (const g of k.secretGenerator || []) gen(g, 'Secret');
  // łatki
  const matches = (o, t) => (!t || ((!t.kind || t.kind === o.kind) && (!t.name || new RegExp(`^${t.name}$`).test(o.metadata.name)) && (!t.namespace || t.namespace === o.metadata.namespace) && (!t.group || (o.apiVersion.includes('/') ? o.apiVersion.split('/')[0] : '') === t.group) && (!t.labelSelector || t.labelSelector.split(',').every((kv) => { const [a, b] = kv.split('='); return o.metadata.labels?.[a] === b; }))));
  const applyPatch = (content, target, file) => {
    let p;
    try { p = parseAll(content).filter(Boolean); } catch (e) { fail(`error: trouble configuring builtin PatchTransformer with config: ${e.message}`); }
    if (p.length === 1 && Array.isArray(p[0])) {
      if (!target) fail(`error: trouble configuring builtin PatchTransformer with config: \`\npath: ${file}\n\`: must specify a target for patch ${file}`);
      res = res.map((o) => (matches(o, target) ? jsonPatchSafe(o, p[0]) : o));
      return;
    }
    for (const pd of p) {
      const t = target || { kind: pd.kind, name: pd.metadata?.name };
      let hit = false;
      res = res.map((o) => {
        if (!matches(o, t)) return o;
        hit = true;
        const pp = clone(pd);
        if (target) { delete pp.metadata?.name; }
        return strategicMerge(o, pp);
      });
      if (!hit && !target) fail(`error: no resource matches strategic merge patch "${pd.kind}.${pd.apiVersion?.split('/')[1] || 'v1'}.${pd.apiVersion?.includes('/') ? pd.apiVersion.split('/')[0] : '[noGrp]'}/${pd.metadata?.name}.[noNs]": no matches for Id ${pd.kind}.${pd.apiVersion}/${pd.metadata?.name}.[noNs]; failed to find unique target for patch ${pd.kind}.${pd.apiVersion}/${pd.metadata?.name}.[noNs]`);
    }
  };
  for (const pt of k.patches || []) {
    const content = pt.patch ?? fs.read(normPath(`${dir}/${pt.path}`), x.sh.user);
    applyPatch(content, pt.target || null, pt.path || 'inline');
  }
  for (const pf of k.patchesStrategicMerge || []) applyPatch(typeof pf === 'string' && !pf.includes('\n') ? fs.read(normPath(`${dir}/${pf}`), x.sh.user) : pf, null, pf);
  for (const pj of k.patchesJson6902 || []) applyPatch(pj.patch ?? fs.read(normPath(`${dir}/${pj.path}`), x.sh.user), pj.target, pj.path);
  // obrazy
  for (const im of k.images || []) {
    const each = (spec) => { for (const ct of [...(spec?.containers || []), ...(spec?.initContainers || [])]) {
      const [nameNoTag] = ct.image.split('@')[0].split(/:(?=[^/]+$)/);
      if (nameNoTag !== im.name && ct.image !== im.name) continue;
      const base = im.newName || nameNoTag;
      ct.image = im.digest ? `${base}@${im.digest}` : im.newTag ? `${base}:${im.newTag}` : im.newName ? `${base}${ct.image.slice(nameNoTag.length)}` : ct.image;
    } };
    for (const o of res) { each(o.spec?.template?.spec); each(o.spec?.jobTemplate?.spec?.template?.spec); if (o.kind === 'Pod') each(o.spec); }
  }
  for (const rp of k.replicas || []) for (const o of res) if (o.metadata.name === rp.name && o.spec && 'replicas' in (o.spec || {}) || (o.metadata.name === rp.name && ['Deployment', 'StatefulSet', 'ReplicaSet'].includes(o.kind))) o.spec.replicas = rp.count;
  // etykiety
  const addLabels = (labels, { selectors = true, templates = true } = {}) => {
    for (const o of res) {
      o.metadata.labels = { ...(o.metadata.labels || {}), ...labels };
      if (templates && o.spec?.template) { o.spec.template.metadata = o.spec.template.metadata || {}; o.spec.template.metadata.labels = { ...(o.spec.template.metadata.labels || {}), ...labels }; }
      if (selectors) {
        if (o.kind === 'Service' && o.spec) o.spec.selector = { ...(o.spec.selector || {}), ...labels };
        else if (o.spec?.selector && ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job'].includes(o.kind)) o.spec.selector.matchLabels = { ...(o.spec.selector.matchLabels || {}), ...labels };
        else if (['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'].includes(o.kind) && o.spec) o.spec.selector = { matchLabels: { ...labels } };
        if (o.kind === 'NetworkPolicy' && o.spec?.podSelector) o.spec.podSelector.matchLabels = { ...(o.spec.podSelector.matchLabels || {}), ...labels };
      }
    }
  };
  if (k.commonLabels) addLabels(k.commonLabels);
  for (const l of k.labels || []) addLabels(l.pairs || {}, { selectors: !!l.includeSelectors, templates: !!l.includeTemplates || !!l.includeSelectors });
  if (k.commonAnnotations) for (const o of res) { o.metadata.annotations = { ...(o.metadata.annotations || {}), ...k.commonAnnotations }; if (o.spec?.template) { o.spec.template.metadata = o.spec.template.metadata || {}; o.spec.template.metadata.annotations = { ...(o.spec.template.metadata.annotations || {}), ...k.commonAnnotations }; } }
  // prefiks / sufiks
  if (k.namePrefix || k.nameSuffix) {
    for (const o of res) {
      if (['Namespace', 'CustomResourceDefinition'].includes(o.kind)) continue;
      const old = o.metadata.__origName ? o.metadata.name : o.metadata.name;
      const base = o.metadata.__origName || o.metadata.name;
      const hashPart = o.metadata.__origName ? o.metadata.name.slice(base.length) : '';
      o.metadata.name = `${k.namePrefix || ''}${base}${k.nameSuffix || ''}${hashPart}`;
      if (o.metadata.__origName) o.metadata.__origName = `${k.namePrefix || ''}${base}${k.nameSuffix || ''}`;
      renames[`${o.kind}/${base}`] = o.metadata.name;
      void old;
    }
  }
  if (k.namespace) for (const o of res) {
    const r = x.c?.registry.byKindAnyVersion(o.apiVersion, o.kind);
    if (r && !r.namespaced) { if (o.kind === 'ClusterRoleBinding' || o.kind === 'RoleBinding') for (const s of o.subjects || []) if (s.kind === 'ServiceAccount' && s.namespace) s.namespace = k.namespace; continue; }
    if (o.kind === 'Namespace') continue;
    o.metadata.namespace = k.namespace;
    if (o.kind === 'RoleBinding') for (const s of o.subjects || []) if (s.kind === 'ServiceAccount') s.namespace = k.namespace;
  }
  // aktualizacja odwołań
  updateRefs(res, renames);
  return res;
}

function jsonPatchSafe(o, ops) {
  try { return jsonPatch(o, ops); } catch (e) { fail(`error: ${e.message}`); }
  return o;
}

function updateRefs(res, renames) {
  const rn = (kind, name) => renames[`${kind}/${name}`] || name;
  const podSpec = (s) => {
    if (!s) return;
    for (const v of s.volumes || []) {
      if (v.configMap) v.configMap.name = rn('ConfigMap', v.configMap.name);
      if (v.secret) v.secret.secretName = rn('Secret', v.secret.secretName);
      if (v.persistentVolumeClaim) v.persistentVolumeClaim.claimName = rn('PersistentVolumeClaim', v.persistentVolumeClaim.claimName);
      for (const src of v.projected?.sources || []) { if (src.configMap) src.configMap.name = rn('ConfigMap', src.configMap.name); if (src.secret) src.secret.name = rn('Secret', src.secret.name); }
    }
    for (const ct of [...(s.containers || []), ...(s.initContainers || [])]) {
      for (const e of ct.env || []) {
        if (e.valueFrom?.configMapKeyRef) e.valueFrom.configMapKeyRef.name = rn('ConfigMap', e.valueFrom.configMapKeyRef.name);
        if (e.valueFrom?.secretKeyRef) e.valueFrom.secretKeyRef.name = rn('Secret', e.valueFrom.secretKeyRef.name);
      }
      for (const ef of ct.envFrom || []) { if (ef.configMapRef) ef.configMapRef.name = rn('ConfigMap', ef.configMapRef.name); if (ef.secretRef) ef.secretRef.name = rn('Secret', ef.secretRef.name); }
    }
    if (s.serviceAccountName) s.serviceAccountName = rn('ServiceAccount', s.serviceAccountName);
    for (const ips of s.imagePullSecrets || []) ips.name = rn('Secret', ips.name);
  };
  for (const o of res) {
    if (o.kind === 'Pod') podSpec(o.spec);
    podSpec(o.spec?.template?.spec);
    podSpec(o.spec?.jobTemplate?.spec?.template?.spec);
    if (o.roleRef) o.roleRef.name = rn(o.roleRef.kind, o.roleRef.name);
    for (const s of o.subjects || []) if (s.kind === 'ServiceAccount') s.name = rn('ServiceAccount', s.name);
    if (o.kind === 'HorizontalPodAutoscaler' && o.spec?.scaleTargetRef) o.spec.scaleTargetRef.name = rn(o.spec.scaleTargetRef.kind, o.spec.scaleTargetRef.name);
    if (o.kind === 'Ingress') for (const r of o.spec?.rules || []) for (const p of r.http?.paths || []) if (p.backend?.service) p.backend.service.name = rn('Service', p.backend.service.name);
    if (o.kind === 'StatefulSet' && o.spec?.serviceName) o.spec.serviceName = rn('Service', o.spec.serviceName);
    for (const rr of o.spec?.rules || []) for (const b of rr.backendRefs || []) b.name = rn('Service', b.name);
  }
}

function sortKustomize(res) {
  const rank = (k) => { const i = LEGACY_ORDER.indexOf(k); if (i >= 0) return i; const j = LAST_ORDER.indexOf(k); return j >= 0 ? 1000 + j : 500; };
  return [...res].sort((a, b) => rank(a.kind) - rank(b.kind) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.metadata.namespace || '').localeCompare(b.metadata.namespace || '') || a.metadata.name.localeCompare(b.metadata.name));
}

const stripInternal = (o) => { const c = clone(o); delete c.metadata.__origName; delete c.metadata.__noHash; return c; };

export function* kustomizeDocs(x, dirArg) {
  const dir = x.sh.abs(dirArg || '.');
  if (!x.sh.fs.exists(dir)) fail(`error: must build at directory: not a valid directory: evalsymlink failure on '${dir}' : lstat ${dir}: no such file or directory`);
  return sortKustomize(buildKustomization(x, dir)).map((o) => ({ obj: stripInternal(o), source: dir }));
}

function* cmdKustomize(x) {
  const docs = yield* kustomizeDocs(x, x.pos[0] || '.');
  x.io.out(docs.map((d) => dump(d.obj)).join('---\n'));
  return 0;
}

export const APPLY_CMDS = { apply: cmdApply, edit: cmdEdit, patch: cmdPatch, replace: cmdReplace, diff: cmdDiff, kustomize: cmdKustomize, __kustomizeDocs: kustomizeDocs };
void dirname; void toYaml; void apiMsg;
