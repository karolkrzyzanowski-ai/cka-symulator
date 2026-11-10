// Łączy twarde złamania wierszy w treści zadań (pisanej pod terminal 80 kolumn),
// aby tekst płynnie zawijał się na wąskim ekranie. Listy, wcięte bloki danych i pary klucz: wartość zostają.
const KV = /^[\w./-]+:(\s|$)/;
const LIST = /^(-|\*|\d+[.)])\s/;
const indent = (s) => s.match(/^ */)[0].length;

export function reflow(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const prev = out.length ? out[out.length - 1] : null;
    const t = line.trim();
    const pt = prev?.trim() ?? '';
    const join = prev !== null && pt && t
      && !/[.!?:]$/.test(pt)               // koniec zdania lub zapowiedź bloku
      && !LIST.test(t) && !KV.test(t) && !KV.test(pt)
      && (indent(line) < 4 || pt.endsWith(','))   // głęboko wcięte linie to zwykle dane / polecenia
      && /^[\w(<"'`/]/.test(t);
    if (join) out[out.length - 1] = `${prev.replace(/\s+$/, '')} ${t}`;
    else out.push(line);
  }
  return out.join('\n');
}
