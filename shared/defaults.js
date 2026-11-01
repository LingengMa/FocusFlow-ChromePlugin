/**
 * Settings and runtime defaults shared by the service worker and extension pages.
 * This module is deliberately free of chrome.* calls so it can be unit tested.
 */

export const STORAGE_KEYS = Object.freeze({
  settings: 'ff_settings',
  runtime: 'ff_runtime',
  lastShot: 'ff_last_shot',
  sessionLock: 'ff_cycle_lock'
});

export const DEFAULT_SETTINGS = Object.freeze({
  // OpenAI-compatible endpoint. DeepSeek's public API is OpenAI-compatible.
  apiBaseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-v4.1-flash',

  // Capture / cadence
  intervalSeconds: 45,
  maxImageWidth: 1280,
  jpegQuality: 78,
  requestTimeoutSeconds: 90,

  // Automation policy
  autoResume: true,
  autoAnswer: true,
  autoSubmit: true,
  autoNext: true,
  confidenceThreshold: 0.72,
  maxActions: 4,
  maxRuntimeMinutes: 240,
  quizVerifySeconds: 4,
  // hybrid = vision coordinates with DOM fallback; vision = coordinates only;
  // dom = legacy elementId actions.
  clickMode: 'vision',

  // Browser / UI behaviour
  focusTarget: true,
  hud: true,
  dryRun: false,
  autoStart: true,
  selfHeal: true,
  skipStandaloneQuiz: true,
  learnSite: true,

  // Optional http(s) hostname allow-list. Empty means any http(s) page.
  allowedHosts: [],
  extraPrompt: ''
});

export const RUNTIME_STATUS = Object.freeze({
  IDLE: 'idle',
  WATCHING: 'watching',
  ANALYZING: 'analyzing',
  ACTING: 'acting',
  NEEDS_USER: 'needs_user',
  COMPLETED: 'completed',
  ERROR: 'error'
});

export function defaultRuntime() {
  return {
    running: false,
    status: RUNTIME_STATUS.IDLE,
    targetTabId: null,
    targetWindowId: null,
    targetUrl: '',
    targetTitle: '',
    startedAt: null,
    lastCycleAt: null,
    lastCycleTrigger: '',
    lastCompletedAt: null,
    lastDecision: null,
    lastActionSummary: '',
    lastError: null,
    errorCount: 0,
    cycleCount: 0,
    tokens: { input: 0, output: 0, total: 0 },
    history: [],
    pausedReason: '',
    nextRunAt: null,
    quizVerifyArmed: false,
    quizRetryCount: 0,
    quizVerifyAt: null,
    probeReason: '',
    noVideoCount: 0,
    visionScrollCount: 0,
    siteMemory: null,
    autoStarted: false,
    selfHealRetryCount: 0,
    lastSelfHeal: null,
    version: 1
  };
}

const SETTING_LIMITS = Object.freeze({
  intervalSeconds: [30, 3600],
  maxImageWidth: [640, 2560],
  jpegQuality: [40, 95],
  requestTimeoutSeconds: [15, 300],
  confidenceThreshold: [0.3, 0.99],
  maxActions: [1, 8],
  maxRuntimeMinutes: [5, 1440],
  quizVerifySeconds: [2, 30]
});

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
}

function clampInt(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback));
}

function toBool(value, fallback = false) {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['false', '0', 'off', 'no', ''].includes(normalized)) return false;
    if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
  }
  return value == null ? fallback : Boolean(value);
}

export function normalizeBaseUrl(value) {
  let raw = String(value || '').trim();
  if (!raw) return DEFAULT_SETTINGS.apiBaseUrl;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return DEFAULT_SETTINGS.apiBaseUrl;
  }
}

/** Accepts an array or newline/comma separated text and returns bare host patterns. */
export function normalizeHostPatterns(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\n,]+/);
  const out = [];
  for (const entry of list) {
    let host = String(entry || '').trim().toLowerCase();
    if (!host || host.startsWith('#')) continue;
    host = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
    if (!host) continue;
    if (!/^(\*\.)?[a-z0-9.-]+$/.test(host)) continue;
    if (!out.includes(host)) out.push(host);
  }
  return out.slice(0, 100);
}

export function normalizeSettings(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const merged = { ...DEFAULT_SETTINGS, ...source };

  return {
    ...merged,
    apiBaseUrl: normalizeBaseUrl(merged.apiBaseUrl),
    apiKey: String(merged.apiKey || '').trim(),
    model: String(merged.model || DEFAULT_SETTINGS.model).trim().slice(0, 120) ||
      DEFAULT_SETTINGS.model,
    intervalSeconds: clampInt(
      merged.intervalSeconds,
      ...SETTING_LIMITS.intervalSeconds,
      DEFAULT_SETTINGS.intervalSeconds
    ),
    maxImageWidth: clampInt(
      merged.maxImageWidth,
      ...SETTING_LIMITS.maxImageWidth,
      DEFAULT_SETTINGS.maxImageWidth
    ),
    jpegQuality: clampInt(
      merged.jpegQuality,
      ...SETTING_LIMITS.jpegQuality,
      DEFAULT_SETTINGS.jpegQuality
    ),
    requestTimeoutSeconds: clampInt(
      merged.requestTimeoutSeconds,
      ...SETTING_LIMITS.requestTimeoutSeconds,
      DEFAULT_SETTINGS.requestTimeoutSeconds
    ),
    confidenceThreshold: clampNumber(
      merged.confidenceThreshold,
      ...SETTING_LIMITS.confidenceThreshold,
      DEFAULT_SETTINGS.confidenceThreshold
    ),
    maxActions: clampInt(
      merged.maxActions,
      ...SETTING_LIMITS.maxActions,
      DEFAULT_SETTINGS.maxActions
    ),
    maxRuntimeMinutes: clampInt(
      merged.maxRuntimeMinutes,
      ...SETTING_LIMITS.maxRuntimeMinutes,
      DEFAULT_SETTINGS.maxRuntimeMinutes
    ),
    quizVerifySeconds: clampInt(
      merged.quizVerifySeconds,
      ...SETTING_LIMITS.quizVerifySeconds,
      DEFAULT_SETTINGS.quizVerifySeconds
    ),
    autoResume: toBool(merged.autoResume),
    autoAnswer: toBool(merged.autoAnswer),
    autoSubmit: toBool(merged.autoSubmit),
    autoNext: toBool(merged.autoNext),
    clickMode: ['hybrid', 'vision', 'dom'].includes(merged.clickMode)
      ? merged.clickMode
      : DEFAULT_SETTINGS.clickMode,
    focusTarget: toBool(merged.focusTarget),
    hud: toBool(merged.hud),
    dryRun: toBool(merged.dryRun),
    autoStart: toBool(merged.autoStart),
    selfHeal: toBool(merged.selfHeal),
    skipStandaloneQuiz: toBool(merged.skipStandaloneQuiz),
    learnSite: toBool(merged.learnSite),
    allowedHosts: normalizeHostPatterns(merged.allowedHosts),
    extraPrompt: String(merged.extraPrompt || '').trim().slice(0, 2000)
  };
}

export function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function hostMatches(hostname, pattern) {
  const host = String(hostname || '').toLowerCase();
  const rule = String(pattern || '').toLowerCase();
  if (!rule) return false;
  if (rule.startsWith('*.')) {
    const suffix = rule.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === rule || host.endsWith(`.${rule}`);
}

export function isHostAllowed(url, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return true;
  try {
    const hostname = new URL(String(url)).hostname;
    return patterns.some((pattern) => hostMatches(hostname, pattern));
  } catch {
    return false;
  }
}

export function sanitizeSettingsForUi(settings) {
  const { apiKey, ...rest } = normalizeSettings(settings);
  return { ...rest, hasApiKey: Boolean(apiKey), apiKeyLength: apiKey.length };
}
