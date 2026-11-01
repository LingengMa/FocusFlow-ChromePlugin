import { STORAGE_KEYS, defaultRuntime } from '../shared/defaults.js';

const BADGE = Object.freeze({
  idle: { text: '', color: '#64748b', title: 'FocusFlow 已停止' },
  watching: { text: 'ON', color: '#0f9f7f', title: 'FocusFlow 正在观看' },
  analyzing: { text: 'AI', color: '#2563eb', title: 'FocusFlow 正在分析屏幕' },
  acting: { text: '▶', color: '#7c3aed', title: 'FocusFlow 正在执行操作' },
  needs_user: { text: '!', color: '#d97706', title: 'FocusFlow 需要你确认' },
  completed: { text: '✓', color: '#0f9f7f', title: 'FocusFlow 已完成' },
  error: { text: '!', color: '#dc2626', title: 'FocusFlow 出错，请查看扩展' }
});

let writeChain = Promise.resolve();

function colorArray(hex) {
  const value = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) return [100, 116, 139, 255];
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
    255
  ];
}

async function applyBadge(runtime) {
  const state = BADGE[runtime?.status] || BADGE.idle;
  const running = Boolean(runtime?.running);
  const attention = runtime?.status === 'needs_user' || runtime?.status === 'error';
  const show = running || attention || runtime?.status === 'completed';
  try {
    await chrome.action.setBadgeText({ text: show ? state.text : '' });
    await chrome.action.setBadgeBackgroundColor({ color: colorArray(state.color) });
    await chrome.action.setTitle({
      title: show ? state.title : 'FocusFlow 网课助手'
    });
  } catch {
    // Badge failures must never break a cycle.
  }
}

export async function getRuntime() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.runtime);
  const runtime = stored?.[STORAGE_KEYS.runtime];
  return { ...defaultRuntime(), ...(runtime && typeof runtime === 'object' ? runtime : {}) };
}

/**
 * Serializes read-modify-write updates so concurrent event handlers cannot
 * clobber each other. Returns the updated runtime.
 */
export function updateRuntime(patch) {
  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      const current = await getRuntime();
      const next = { ...current, ...(patch || {}) };
      if (patch && Array.isArray(patch.history)) next.history = patch.history.slice(-12);
      await chrome.storage.local.set({ [STORAGE_KEYS.runtime]: next });
      await applyBadge(next);
      return next;
    });
  return writeChain;
}

export async function resetRuntime(patch = {}) {
  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      const next = { ...defaultRuntime(), ...patch };
      await chrome.storage.local.set({ [STORAGE_KEYS.runtime]: next });
      await applyBadge(next);
      return next;
    });
  return writeChain;
}

export async function refreshBadge() {
  const runtime = await getRuntime();
  await applyBadge(runtime);
}

export async function setLastShot(shot) {
  try {
    await chrome.storage.session.set({
      [STORAGE_KEYS.lastShot]: {
        dataUrl: shot.dataUrl,
        at: shot.at || Date.now(),
        trigger: shot.trigger || '',
        width: shot.width || 0,
        height: shot.height || 0
      }
    });
  } catch {
    // A large screenshot may exceed session quota; the cycle still works.
  }
}

export async function getLastShot() {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEYS.lastShot);
    return stored?.[STORAGE_KEYS.lastShot] || null;
  } catch {
    return null;
  }
}

export async function getLastShotInfo() {
  const shot = await getLastShot();
  if (!shot) return null;
  return {
    at: shot.at || 0,
    width: shot.width || 0,
    height: shot.height || 0,
    bytes: shot.dataUrl ? Math.round(shot.dataUrl.length * 0.75) : 0,
    trigger: shot.trigger || ''
  };
}

export async function clearLastShot() {
  try {
    await chrome.storage.session.remove(STORAGE_KEYS.lastShot);
  } catch {
    // ignore
  }
}

export function appendHistory(runtime, entry) {
  const history = Array.isArray(runtime?.history) ? runtime.history : [];
  return [...history, entry].slice(-12);
}
