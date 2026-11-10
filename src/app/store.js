// Trwały zapis: stan aplikacji i migawka klastra w localStorage (WebView Androida).
const K_APP = 'cka.app.v1';
const K_CLUSTER = 'cka.cluster.v1';

function get(k) { try { return localStorage.getItem(k); } catch { return null; } }
function set(k, v) {
  try { localStorage.setItem(k, v); return true; } catch { return false; }
}

export const DEFAULT_APP = () => ({
  v: 1,
  settings: { fontSize: 13, timeScale: 1, wrap: false },
  progress: {},          // id -> {best, attempts, last}
  active: null,          // {id, state, startedAt, result}
  exam: null,            // {ids, states, visited, flags, results, startedAt, endsAt, current, finished, score}
  history: [],
  welcomed: false,
});

export function loadApp() {
  const raw = get(K_APP);
  if (!raw) return DEFAULT_APP();
  try {
    const a = JSON.parse(raw);
    const d = DEFAULT_APP();
    return { ...d, ...a, settings: { ...d.settings, ...(a.settings || {}) } };
  } catch { return DEFAULT_APP(); }
}

export function saveApp(app) { return set(K_APP, JSON.stringify(app)); }
export function loadCluster() { return get(K_CLUSTER); }
export function saveCluster(json) { return set(K_CLUSTER, json); }
export function clearCluster() { try { localStorage.removeItem(K_CLUSTER); } catch { /* */ } }
