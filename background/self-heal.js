/**
 * Local self-diagnosis and strategy adaptation, keyed by course hostname.
 *
 * The plugin never edits its own source code. Instead it observes execution
 * outcomes and persists per-host strategy overrides (coordinate/DOM mode,
 * temporary backoff) that future cycles use automatically.
 */

const STORAGE_KEY = 'ff_self_heal';
const MODE_TTL_MS = 30 * 60 * 1000;
const MAX_PROFILES = 40;
let writeChain = Promise.resolve();

function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return '';
  }
}

async function loadProfiles() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const value = stored?.[STORAGE_KEY];
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function saveProfiles(profiles) {
  const entries = Object.entries(profiles)
    .sort((a, b) => (Number(b[1]?.updatedAt) || 0) - (Number(a[1]?.updatedAt) || 0))
    .slice(0, MAX_PROFILES);
  return chrome.storage.local.set({ [STORAGE_KEY]: Object.fromEntries(entries) });
}

function queueUpdate(url, updater) {
  const host = hostOf(url);
  if (!host) return Promise.resolve(null);
  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      const profiles = await loadProfiles();
      const current = profiles[host] || {};
      const next = {
        host,
        clickMode: '',
        modeUntil: 0,
        visionFailures: 0,
        domFailures: 0,
        apiFailures: 0,
        intervalMultiplier: 1,
        backoffUntil: 0,
        lastDiagnosis: '',
        lastQuizHealAt: 0,
        lastNeedsHealAt: 0,
        ...current
      };
      const diagnosis = updater(next) || null;
      next.updatedAt = Date.now();
      profiles[host] = next;
      try {
        await saveProfiles(profiles);
      } catch {
        // Diagnosis still applies in-memory for this call; persistence is best-effort.
      }
      return diagnosis;
    });
  return writeChain;
}

function alternateMode(mode) {
  if (mode === 'vision') return 'dom';
  if (mode === 'dom') return 'vision';
  return 'vision';
}

export async function getSelfHealProfile(url) {
  const host = hostOf(url);
  if (!host) return null;
  const profiles = await loadProfiles();
  return profiles[host] ? { ...profiles[host] } : null;
}

/** Applies a temporary per-host strategy without mutating the user settings. */
export async function getEffectiveSettings(settings, url) {
  if (!settings?.selfHeal) return settings;
  const profile = await getSelfHealProfile(url);
  if (!profile) return settings;
  const now = Date.now();
  const next = { ...settings };
  if (profile.clickMode && Number(profile.modeUntil) > now) {
    next.clickMode = profile.clickMode;
  }
  if (Number(profile.backoffUntil) > now && Number(profile.intervalMultiplier) > 1) {
    next.intervalSeconds = Math.min(
      3600,
      Math.max(30, Math.round(next.intervalSeconds * Number(profile.intervalMultiplier)))
    );
  }
  return next;
}

export function recordActionResults(url, results) {
  if (!Array.isArray(results) || results.length === 0) return Promise.resolve(null);
  return queueUpdate(url, (profile) => {
    let diagnosis = null;
    for (const result of results) {
      if (!result) continue;
      const isVision = result.type === 'click_at' || result.type === 'type_at';
      const isDom = ['click', 'choose', 'type', 'submit', 'next'].includes(result.type);
      if (!isVision && !isDom) continue;

      if (isVision) {
        if (result.ok) {
          profile.visionFailures = 0;
        } else {
          profile.visionFailures = (Number(profile.visionFailures) || 0) + 1;
          if (profile.visionFailures >= 2 && profile.clickMode !== 'dom') {
            profile.clickMode = 'dom';
            profile.modeUntil = Date.now() + MODE_TTL_MS;
            profile.visionFailures = 0;
            profile.lastDiagnosis = '视觉坐标连续失败，自动切换为 DOM 点击';
            diagnosis = {
              host: profile.host,
              action: 'switch-click-mode',
              mode: 'dom',
              message: profile.lastDiagnosis
            };
          }
        }
      } else if (result.ok) {
        profile.domFailures = 0;
      } else {
        profile.domFailures = (Number(profile.domFailures) || 0) + 1;
        if (profile.domFailures >= 2 && profile.clickMode !== 'vision') {
          profile.clickMode = 'vision';
          profile.modeUntil = Date.now() + MODE_TTL_MS;
          profile.domFailures = 0;
          profile.lastDiagnosis = 'DOM 点击连续失败，自动切换为视觉坐标';
          diagnosis = {
            host: profile.host,
            action: 'switch-click-mode',
            mode: 'vision',
            message: profile.lastDiagnosis
          };
        }
      }
    }
    return diagnosis;
  });
}

export function recordApiFailure(url, status) {
  if (![429, 500, 502, 503, 504].includes(Number(status))) {
    return Promise.resolve(null);
  }
  return queueUpdate(url, (profile) => {
    profile.apiFailures = (Number(profile.apiFailures) || 0) + 1;
    profile.intervalMultiplier = Math.min(4, 1 + profile.apiFailures * 0.5);
    profile.backoffUntil = Date.now() + 5 * 60 * 1000;
    profile.lastDiagnosis = `模型接口 ${status}，自动放慢截屏频率`;
    return {
      host: profile.host,
      action: 'backoff',
      message: profile.lastDiagnosis
    };
  });
}

export function recordApiSuccess(url) {
  return queueUpdate(url, (profile) => {
    if (profile.apiFailures || profile.intervalMultiplier > 1) {
      profile.apiFailures = 0;
      profile.intervalMultiplier = 1;
      profile.backoffUntil = 0;
      return null;
    }
    return null;
  });
}

/** Returns a diagnosis when a quiz retry limit should trigger a strategy change. */
export function recordQuizRetryLimit(url) {
  return queueUpdate(url, (profile) => {
    const now = Date.now();
    if (now - Number(profile.lastQuizHealAt) < 10 * 60 * 1000) return null;
    profile.lastQuizHealAt = now;
    const mode = alternateMode(profile.clickMode || 'hybrid');
    profile.clickMode = mode;
    profile.modeUntil = now + MODE_TTL_MS;
    profile.lastDiagnosis = `答题连续未通过，自动切换为 ${mode} 模式重试`;
    return {
      host: profile.host,
      action: 'quiz-retry-mode',
      mode,
      message: profile.lastDiagnosis
    };
  });
}

/** Returns a diagnosis when a human-confirmation request can be retried automatically. */
export function recordNeedsUserRecovery(url) {
  return queueUpdate(url, (profile) => {
    const now = Date.now();
    if (now - Number(profile.lastNeedsHealAt) < 10 * 60 * 1000) return null;
    profile.lastNeedsHealAt = now;
    const mode = alternateMode(profile.clickMode || 'hybrid');
    profile.clickMode = mode;
    profile.modeUntil = now + MODE_TTL_MS;
    profile.lastDiagnosis = `AI 请求人工确认，自动切换为 ${mode} 模式重试`;
    return {
      host: profile.host,
      action: 'needs-user-mode',
      mode,
      message: profile.lastDiagnosis
    };
  });
}
