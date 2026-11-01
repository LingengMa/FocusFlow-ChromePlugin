/**
 * Lightweight per-host visual memory. It learns successful coordinate actions
 * (where the play button / directory scroll was) and reuses them as hints in
 * future prompts. It never rewrites code or executes learned content.
 */

const STORAGE_KEY = 'ff_site_memory';
const MAX_HOSTS = 40;
const MAX_ACTIONS = 12;
let writeChain = Promise.resolve();

function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return '';
  }
}

async function load() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const value = stored?.[STORAGE_KEY];
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function save(memory) {
  const entries = Object.entries(memory)
    .sort((a, b) => (Number(b[1]?.updatedAt) || 0) - (Number(a[1]?.updatedAt) || 0))
    .slice(0, MAX_HOSTS);
  return chrome.storage.local.set({ [STORAGE_KEY]: Object.fromEntries(entries) });
}

export async function getSiteMemory(url) {
  const host = hostOf(url);
  if (!host) return null;
  const memory = await load();
  return memory[host] || null;
}

export function recordSiteActions(url, actions, page = {}) {
  const host = hostOf(url);
  if (!host || !Array.isArray(actions) || actions.length === 0) {
    return Promise.resolve(null);
  }
  const learned = actions
    .filter((action) => action.type === 'click_at' || action.type === 'scroll_at' || action.type === 'type_at')
    .map((action) => ({
      type: action.type,
      target: String(action.target || '').slice(0, 100),
      x: Math.round((Number(action.x) || 0) * 10000) / 10000,
      y: Math.round((Number(action.y) || 0) * 10000) / 10000,
      deltaY: action.type === 'scroll_at' ? Number(action.deltaY) || 0 : 0,
      at: Date.now()
    }))
    .filter((action) => action.target);
  if (!learned.length) return Promise.resolve(null);

  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      const memory = await load();
      const current = memory[host] || {
        host,
        actions: [],
        pageTitle: '',
        pageUrl: '',
        lastObservation: '',
        updatedAt: 0
      };
      const merged = [...(current.actions || [])];
      for (const action of learned) {
        const index = merged.findIndex((item) => item.target === action.target && item.type === action.type);
        if (index >= 0) merged.splice(index, 1);
        merged.push(action);
      }
      memory[host] = {
        host,
        pageTitle: String(page.title || current.pageTitle || '').slice(0, 160),
        pageUrl: String(page.url || current.pageUrl || '').slice(0, 500),
        lastObservation: String(page.observation || current.lastObservation || '').slice(0, 300),
        actions: merged.slice(-MAX_ACTIONS),
        updatedAt: Date.now()
      };
      try {
        await save(memory);
      } catch {
        // Learning is best-effort; never block a running cycle.
      }
      return memory[host];
    });
  return writeChain;
}
