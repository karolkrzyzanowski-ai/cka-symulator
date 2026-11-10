// Opis szablonu poda dla `kubectl rollout history --revision=N`.
export function describeTemplateForHistory(tpl) {
  const L = ['Pod Template:'];
  const labels = Object.entries(tpl?.metadata?.labels || {});
  if (!labels.length) L.push('  Labels:\t<none>');
  labels.forEach(([k, v], i) => L.push(i === 0 ? `  Labels:\t${k}=${v}` : `\t${k}=${v}`));
  const ann = Object.entries(tpl?.metadata?.annotations || {});
  if (ann.length) ann.forEach(([k, v], i) => L.push(i === 0 ? `  Annotations:\t${k}: ${v}` : `\t${k}: ${v}`));
  if (tpl?.spec?.serviceAccountName) L.push(`  Service Account:\t${tpl.spec.serviceAccountName}`);
  L.push('  Containers:');
  for (const c of tpl?.spec?.containers || []) {
    L.push(`   ${c.name}:`);
    L.push(`    Image:\t${c.image}`);
    const p = (c.ports || [])[0];
    L.push(`    Port:\t${p ? `${p.containerPort}/${p.protocol || 'TCP'}` : '<none>'}`);
    L.push(`    Host Port:\t${p ? `${p.hostPort || 0}/${p.protocol || 'TCP'}` : '<none>'}`);
    if (c.command) { L.push('    Command:'); for (const a of c.command) L.push(`      ${a}`); }
    if (c.args) { L.push('    Args:'); for (const a of c.args) L.push(`      ${a}`); }
    for (const k of ['limits', 'requests']) {
      if (!c.resources?.[k]) continue;
      L.push(`    ${k[0].toUpperCase()}${k.slice(1)}:`);
      for (const [r, v] of Object.entries(c.resources[k])) L.push(`      ${r}:\t${v}`);
    }
    if (c.env?.length) { L.push('    Environment:'); for (const e of c.env) L.push(`      ${e.name}:\t${e.value ?? '<set from ref>'}`); } else L.push('    Environment:\t<none>');
    if (c.volumeMounts?.length) { L.push('    Mounts:'); for (const m of c.volumeMounts) L.push(`      ${m.mountPath} from ${m.name} (${m.readOnly ? 'ro' : 'rw'})`); } else L.push('    Mounts:\t<none>');
  }
  if (tpl?.spec?.volumes?.length) { L.push('  Volumes:'); for (const v of tpl.spec.volumes) L.push(`   ${v.name}:\t${Object.keys(v).filter((k) => k !== 'name')[0]}`); } else L.push('  Volumes:\t<none>');
  L.push(`  Node-Selectors:\t${Object.entries(tpl?.spec?.nodeSelector || {}).map(([k, v]) => `${k}=${v}`).join(',') || '<none>'}`);
  L.push(`  Tolerations:\t${(tpl?.spec?.tolerations || []).length ? tpl.spec.tolerations.map((t) => `${t.key || ''}${t.value ? '=' + t.value : ''}:${t.effect || ''}`).join(', ') : '<none>'}`);
  return L.join('\n') + '\n\n';
}
