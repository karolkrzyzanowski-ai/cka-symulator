// Harmonogram cron (5 pól) - walidacja i wyznaczanie kolejnych uruchomień.

const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const MACROS = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };
const NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseField(f, [lo, hi]) {
  const set = new Set();
  for (const part of f.split(',')) {
    const m = part.match(/^(\*|\?|[\w]+(?:-[\w]+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    let a = lo, b = hi;
    if (m[1] !== '*' && m[1] !== '?') {
      const [x, y] = m[1].split('-');
      const num = (s) => (NAMES[s.toLowerCase()] !== undefined ? NAMES[s.toLowerCase()] : Number(s));
      a = num(x);
      b = y !== undefined ? num(y) : (m[2] ? hi : a);
      if (Number.isNaN(a) || Number.isNaN(b) || a < lo || b > hi || a > b) return null;
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (!step) return null;
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return set;
}

export function parseCron(expr) {
  const e = MACROS[String(expr).trim()] || String(expr).trim();
  const parts = e.replace(/^CRON_TZ=\S+\s+|^TZ=\S+\s+/, '').split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((p, i) => parseField(p, RANGES[i]));
  if (sets.some((s) => !s)) return null;
  if (sets[4].has(7)) sets[4].add(0);
  return { sets, domStar: parts[2] === '*', dowStar: parts[4] === '*' };
}

export const cronValid = (e) => parseCron(e) !== null;

// następne uruchomienie po czasie t (ms, UTC)
export function nextRun(expr, t) {
  const c = parseCron(expr);
  if (!c) return null;
  const d = new Date(Math.floor(t / 60000) * 60000 + 60000);
  for (let i = 0; i < 60 * 24 * 400; i++) {
    const [mi, h, dom, mon, dow] = c.sets;
    const domOk = dom.has(d.getUTCDate()), dowOk = dow.has(d.getUTCDay());
    const dayOk = c.domStar || c.dowStar ? domOk && dowOk : domOk || dowOk;
    if (mi.has(d.getUTCMinutes()) && h.has(d.getUTCHours()) && mon.has(d.getUTCMonth() + 1) && dayOk) return d.getTime();
    d.setTime(d.getTime() + 60000);
  }
  return null;
}
