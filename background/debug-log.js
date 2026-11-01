/**
 * Local diagnostic ring buffer. It stores the model's raw analysis and the
 * action/execution context so accuracy problems can be diagnosed without
 * guessing. It never stores API keys or screenshots.
 */

const STORAGE_KEY = 'ff_logs';
const MAX_ENTRIES = 160;
const MAX_STRING = 8000;
let writeChain = Promise.resolve();

function truncateValue(value, depth = 0) {
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (value == null || typeof value !== 'object') return value;
  if (depth > 4) return '[depth]';
  if (Array.isArray(value)) {
    return value.slice(0, 80).map((item) => truncateValue(item, depth + 1));
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/api.?key|authorization|token|password/i.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = truncateValue(item, depth + 1);
  }
  return out;
}

async function loadLogs() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return Array.isArray(stored?.[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
  } catch {
    return [];
  }
}

export async function getDebugLogs() {
  return loadLogs();
}

export async function clearDebugLogs() {
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch {
    // best-effort
  }
}

export function appendDebugLog(entry) {
  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      const logs = await loadLogs();
      const item = truncateValue({
        at: new Date().toISOString(),
        ...entry
      });
      logs.push(item);
      const trimmed = logs.slice(-MAX_ENTRIES);
      try {
        await chrome.storage.local.set({ [STORAGE_KEY]: trimmed });
      } catch {
        // Logging must never abort a cycle.
      }
      return item;
    });
  return writeChain;
}
