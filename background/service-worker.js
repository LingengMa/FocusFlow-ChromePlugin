import {
  DEFAULT_SETTINGS,
  RUNTIME_STATUS,
  STORAGE_KEYS,
  isHostAllowed,
  isHttpUrl,
  normalizeSettings,
  sanitizeSettingsForUi
} from '../shared/defaults.js';
import { describeAction, truncate } from '../shared/ai-protocol.js';
import { buildActionPlan, summarizePlan } from '../shared/planner.js';
import { isQuizAnswerAction, nextQuizCadence } from '../shared/quiz-followup.js';
import {
  buildQuizFallback,
  normalizeChoiceLabel,
  quizSignature,
  selectedQuizLabels
} from '../shared/quiz-fallback.js';
import { hasNextAction, looksCourseComplete, shouldSynthesizeNext } from '../shared/course-state.js';
import { looksLikeCoursePage } from '../shared/course-detect.js';
import {
  getEffectiveSettings,
  recordActionResults,
  recordApiFailure,
  recordApiSuccess,
  recordNeedsUserRecovery,
  recordQuizRetryLimit
} from './self-heal.js';
import { ApiError, analyzeWithAI, testConnection } from './ai.js';
import { captureTab } from './capture.js';
import { executePlan } from './executor.js';
import { getSiteMemory, recordSiteActions } from './site-memory.js';
import { appendDebugLog } from './debug-log.js';
import { beginPointerSession, releasePointerSession } from './pointer.js';
import {
  appendHistory,
  clearLastShot,
  getLastShot,
  getLastShotInfo,
  getRuntime,
  refreshBadge,
  resetRuntime,
  setLastShot,
  updateRuntime
} from './state.js';
import {
  collectTabSnapshot,
  ensureContentScripts,
  focusTarget,
  getTabSummary,
  getTargetTab,
  sendHud,
  waitForTabComplete
} from './tabs.js';

const ALARM_NAME = 'ff_tick';
const QUIZ_VERIFY_ALARM = 'ff_quiz_verify';
const AUTO_SUPPRESS_KEY = 'ff_auto_suppress';
const MIN_ANALYSIS_GAP_MS = 6000;
const EVENT_DEBOUNCE_MS = 1600;
const HARD_BLOCK_RE = /登录|验证码|密码|扫码|人脸|授权|同意|支付|购买|删除|权限|证书|自动答题已关闭|自动提交已关闭|自动切换下一节已关闭|自动续播已关闭/;
const NAV_TARGET_RE = /下一[节集课篇个章讲]|下一个|继续学习|目录|章节|第?\s*\d+(?:\.\d+)+|next|continue/i;

let inFlight = false;
let rerunRequested = false;
let eventTimer = null;
let quizVerifyTimer = null;
let autoStartTimer = null;
let lastAnalysisAt = 0;
let lastStructureEventAt = 0;
let lastNotificationAt = 0;
let keepAlivePort = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return String(error?.message || error || '未知错误').slice(0, 500);
}

function safePageUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!/^https?:$/.test(url.protocol)) return String(value || '').split('?')[0];
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

function buildDiagnostics(snapshot, tab, runtime) {
  const frames = (snapshot.frames || []).map((frame) => ({
    frameId: frame.frameId,
    isTop: Boolean(frame.isTop),
    url: safePageUrl(frame.url),
    textSample: truncate(frame.pageText || '', frame.isTop ? 500 : 220),
    video: frame.video?.found
      ? {
          found: true,
          currentTime: frame.video.currentTime,
          duration: frame.video.duration,
          paused: frame.video.paused,
          ended: frame.video.ended
        }
      : { found: false },
    quiz: frame.quiz?.detected
      ? { detected: true, score: frame.quiz.score, question: frame.quiz.question }
      : { detected: false },
    controlsCount: frame.controlsCount || 0,
    error: frame.error || null
  }));

  const quiz = snapshot.quiz?.detected
    ? {
        detected: true,
        frameId: snapshot.quiz.frameId,
        tag: snapshot.quiz.tag || '',
        className: truncate(snapshot.quiz.className || '', 180),
        score: snapshot.quiz.score,
        question: truncate(snapshot.quiz.question || '', 700),
        text: truncate(snapshot.quiz.text || '', 1800),
        choices: (snapshot.quiz.choices || []).slice(0, 20).map((choice) => ({
          elementId: choice.elementId,
          label: truncate(choice.label || '', 160),
          checked: Boolean(choice.checked)
        })),
        submitCandidates: (snapshot.quiz.submitCandidates || []).slice(0, 8).map((item) => ({
          elementId: item.elementId,
          label: truncate(item.label || '', 100)
        }))
      }
    : { detected: false };

  const controls = (snapshot.controls || []).slice(0, 60).map((control) => ({
    elementId: control.elementId,
    tag: control.tag,
    className: truncate(control.className || '', 140),
    role: control.role || '',
    type: control.type || '',
    label: truncate(control.label || '', 120),
    group: control.group || '',
    disabled: Boolean(control.disabled),
    checked: Boolean(control.checked)
  }));

  const topFrame = (snapshot.frames || []).find((frame) => frame.isTop) || snapshot.frames?.[0];
  return {
    generatedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    note: '不包含截图、Cookie、API Key 或密码；分享前请自行检查文本中的个人信息。',
    session: {
      running: Boolean(runtime?.running),
      status: runtime?.status || 'idle',
      targetUrl: safePageUrl(runtime?.targetUrl || ''),
      targetTitle: truncate(runtime?.targetTitle || '', 160),
      lastActionSummary: truncate(runtime?.lastActionSummary || '', 300),
      noVideoCount: Number(runtime?.noVideoCount) || 0,
      quizVerifyArmed: Boolean(runtime?.quizVerifyArmed),
      quizRetryCount: Number(runtime?.quizRetryCount) || 0,
      probeReason: runtime?.probeReason || '',
      lastSelfHeal: runtime?.lastSelfHeal || null
    },
    tab: {
      id: tab.id,
      title: truncate(tab.title || '', 180),
      url: safePageUrl(tab.url || '')
    },
    viewport: snapshot.viewport || null,
    frames,
    video: snapshot.video?.found
      ? {
          found: true,
          frameId: snapshot.video.frameId,
          id: snapshot.video.id || '',
          className: truncate(snapshot.video.className || '', 160),
          srcHost: snapshot.video.srcHost || '',
          controls: Boolean(snapshot.video.controls),
          currentTime: snapshot.video.currentTime,
          duration: snapshot.video.duration,
          paused: snapshot.video.paused,
          ended: snapshot.video.ended,
          readyState: snapshot.video.readyState,
          buffering: snapshot.video.buffering,
          playbackRate: snapshot.video.playbackRate,
          area: snapshot.video.area,
          rect: snapshot.video.rect
        }
      : { found: false },
    quiz,
    controls,
    pageTextSample: truncate(topFrame?.pageText || '', 900),
    diagnostics: snapshot.diagnostics || {}
  };
}

function startKeepAlive(tabId) {
  if (keepAlivePort) return;
  try {
    keepAlivePort = chrome.tabs.connect(tabId, { name: 'ff-keepalive', frameId: 0 });
    keepAlivePort.onDisconnect.addListener(() => {
      keepAlivePort = null;
    });
  } catch {
    keepAlivePort = null;
  }
}

function stopKeepAlive() {
  try {
    keepAlivePort?.disconnect();
  } catch {
    // already gone
  }
  keepAlivePort = null;
}

async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return normalizeSettings(stored?.[STORAGE_KEYS.settings] || {});
}

async function ensureSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  if (!stored?.[STORAGE_KEYS.settings]) {
    const defaults = normalizeSettings(DEFAULT_SETTINGS);
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: defaults });
    return defaults;
  }
  return normalizeSettings(stored[STORAGE_KEYS.settings]);
}

function clearQuizVerifyTimer() {
  if (quizVerifyTimer) {
    clearTimeout(quizVerifyTimer);
    quizVerifyTimer = null;
  }
}

function clearQuizVerifyAlarm() {
  try {
    void chrome.alarms.clear(QUIZ_VERIFY_ALARM).catch(() => {});
  } catch {
    // ignore
  }
}

async function setAutoSuppress(tabId, url, minutes) {
  if (!Number.isInteger(tabId) || !url) return;
  try {
    await chrome.storage.local.set({
      [AUTO_SUPPRESS_KEY]: {
        tabId,
        url,
        until: Date.now() + Math.max(1, Number(minutes) || 10) * 60 * 1000
      }
    });
  } catch {
    // best-effort
  }
}

async function clearAutoSuppress(tabId) {
  try {
    const stored = await chrome.storage.local.get(AUTO_SUPPRESS_KEY);
    const current = stored?.[AUTO_SUPPRESS_KEY];
    if (!current || !Number.isInteger(tabId) || current.tabId === tabId) {
      await chrome.storage.local.remove(AUTO_SUPPRESS_KEY);
    }
  } catch {
    // best-effort
  }
}

async function isAutoSuppressed(tabId, url) {
  try {
    const stored = await chrome.storage.local.get(AUTO_SUPPRESS_KEY);
    const current = stored?.[AUTO_SUPPRESS_KEY];
    return Boolean(
      current &&
      current.tabId === tabId &&
      current.url === url &&
      Number(current.until) > Date.now()
    );
  } catch {
    return false;
  }
}

function canRunWithoutKey(settings) {
  return Boolean(settings.apiKey) ||
    /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(settings.apiBaseUrl);
}

async function autoStartTab(tabId) {
  try {
    const runtime = await getRuntime();
    if (runtime.running) return;
    const settings = await getSettings();
    if (!settings.autoStart || !canRunWithoutKey(settings)) return;

    const tab = await chrome.tabs.get(tabId);
    if (!tab.active || !isHttpUrl(tab.url || '')) return;
    if (!isHostAllowed(tab.url, settings.allowedHosts)) return;
    if (await isAutoSuppressed(tab.id, tab.url)) return;

    const hostTrusted = Array.isArray(settings.allowedHosts) && settings.allowedHosts.length > 0;
    const hint = `${tab.title || ''} ${tab.url || ''}`;
    if (!hostTrusted && !/课程|章节|学习|课堂|学堂|网课|mooc|course|study|lesson|learn|class/i.test(hint)) {
      return;
    }

    await ensureContentScripts(tab.id);
    const snapshot = await collectTabSnapshot(tab);
    if (!looksLikeCoursePage(snapshot, { trustedHost })) return;

    await clearAutoSuppress(tab.id);
    await startAutomation(tab.id, { auto: true });
  } catch (error) {
    try {
      const tab = await chrome.tabs.get(tabId);
      await setAutoSuppress(tabId, tab.url || '', 2);
    } catch {
      // ignore
    }
  }
}

function scheduleAutoStart(tabId, delay = 2200) {
  if (autoStartTimer) clearTimeout(autoStartTimer);
  autoStartTimer = setTimeout(() => {
    autoStartTimer = null;
    void autoStartTab(tabId);
  }, Math.max(500, delay));
}

async function scheduleNext(seconds) {
  clearQuizVerifyTimer();
  clearQuizVerifyAlarm();
  const delay = Math.max(30, Math.min(3600, Number(seconds) || 45)) * 1000;
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { when: Date.now() + delay });
  await updateRuntime({ nextRunAt: Date.now() + delay, quizVerifyAt: null, probeReason: '' });
}

async function scheduleQuizVerify(seconds, reason = 'quiz') {
  clearQuizVerifyTimer();
  await chrome.alarms.clear(QUIZ_VERIFY_ALARM).catch(() => {});
  const delay = Math.max(1500, Math.min(30000, (Number(seconds) || 4) * 1000));
  // Chrome alarms cannot fire below 30s; create the fallback before clearing
  // the main alarm, so a suspended worker still wakes for verification.
  try {
    await chrome.alarms.create(QUIZ_VERIFY_ALARM, {
      when: Date.now() + Math.max(30000, delay)
    });
  } catch {
    // The in-memory timer is still the primary path.
  }
  quizVerifyTimer = setTimeout(() => {
    quizVerifyTimer = null;
    clearQuizVerifyAlarm();
    void runCycle('quiz-verify');
  }, delay);
  await chrome.alarms.clear(ALARM_NAME).catch(() => {});
  await updateRuntime({
    nextRunAt: Date.now() + delay,
    quizVerifyAt: Date.now() + delay,
    probeReason: reason
  });
}

async function clearTimers() {
  if (eventTimer) {
    clearTimeout(eventTimer);
    eventTimer = null;
  }
  clearQuizVerifyTimer();
  clearQuizVerifyAlarm();
  await chrome.alarms.clear(ALARM_NAME);
}

async function notify(title, message) {
  const now = Date.now();
  if (now - lastNotificationAt < 4000) return;
  lastNotificationAt = now;
  try {
    await chrome.notifications.create(`ff-${now}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message: String(message || '').slice(0, 220),
      priority: 2
    });
  } catch {
    // Notifications are best-effort.
  }
}

async function stopAutomation({ status = RUNTIME_STATUS.IDLE, reason = '', notifyUser = false } = {}) {
  await clearTimers();
  stopKeepAlive();
  const runtime = await updateRuntime({
    running: false,
    status,
    nextRunAt: null,
    quizVerifyAt: null,
    probeReason: '',
    pausedReason: reason || '',
    lastError: status === RUNTIME_STATUS.ERROR ? reason || '运行出错' : ''
  });

  if (Number.isInteger(runtime.targetTabId)) {
    await releasePointerSession(runtime.targetTabId);
    const suppressMinutes = status === RUNTIME_STATUS.COMPLETED
      ? 120
      : status === RUNTIME_STATUS.NEEDS_USER
        ? 20
        : 15;
    await setAutoSuppress(runtime.targetTabId, runtime.targetUrl, suppressMinutes);
    const kind = status === RUNTIME_STATUS.NEEDS_USER
      ? 'needs_user'
      : status === RUNTIME_STATUS.ERROR
        ? 'error'
        : 'idle';
    await sendHud(runtime.targetTabId, {
      kind,
      text: status === RUNTIME_STATUS.NEEDS_USER
        ? '需要你确认'
        : status === RUNTIME_STATUS.COMPLETED
          ? '课程已完成'
          : status === RUNTIME_STATUS.ERROR
            ? '已暂停：出现错误'
            : '已停止',
      detail: reason
    });
  }

  if (notifyUser) {
    const title = status === RUNTIME_STATUS.NEEDS_USER
      ? 'FocusFlow 需要你确认'
      : status === RUNTIME_STATUS.COMPLETED
        ? 'FocusFlow 已完成'
        : 'FocusFlow 已暂停';
    await notify(title, reason || '自动观看已停止');
  }
  await appendDebugLog({
    stage: 'stop',
    status,
    reason,
    targetTabId: runtime.targetTabId || null,
    targetUrl: runtime.targetUrl || '',
    lastDecision: runtime.lastDecision || null,
    lastSelfHeal: runtime.lastSelfHeal || null
  });
  return runtime;
}

async function startAutomation(tabId, options = {}) {
  let settings = await getSettings();
  let tab = await chrome.tabs.get(tabId);
  if (tab.status === 'loading') {
    tab = (await waitForTabComplete(tab.id, 7000)) || tab;
  }
  const url = tab.url || tab.pendingUrl || '';
  if (!isHttpUrl(url)) {
    throw new Error('请先打开课程网页（http/https），chrome:// 页面和扩展商店不能操作。');
  }
  settings = await getEffectiveSettings(settings, url);
  if (!isHostAllowed(url, settings.allowedHosts)) {
    throw new Error(`当前网站 ${new URL(url).hostname} 不在允许列表中。请到设置中调整访问范围。`);
  }

  let connected = await ensureContentScripts(tab.id);
  if (!connected) {
    await sleep(500);
    connected = await ensureContentScripts(tab.id);
  }
  if (!connected) {
    throw new Error('无法连接页面脚本。请刷新课程页面后重试。');
  }

  await clearTimers();
  await clearAutoSuppress(tab.id);
  await clearLastShot();
  const runtime = await resetRuntime({
    running: true,
    status: RUNTIME_STATUS.WATCHING,
    targetTabId: tab.id,
    targetWindowId: tab.windowId,
    targetUrl: url,
    targetTitle: tab.title || '',
    startedAt: Date.now(),
    autoStarted: Boolean(options.auto),
    nextRunAt: Date.now() + 90000
  });

  try {
    await chrome.alarms.create(ALARM_NAME, { when: Date.now() + 90000 });
  } catch {
    // The in-cycle watchdog still provides a recovery path.
  }
  if (settings.clickMode !== 'dom') {
    // Keep the debugger attached while capturing, so Chrome's debugger infobar
    // cannot resize the page between screenshot and coordinate click.
    await beginPointerSession(tab.id, { persistent: true });
  }
  await sendHud(tab.id, { kind: 'analyzing', text: 'FocusFlow 已启动', detail: '准备截屏分析…' });
  rerunRequested = false;
  // Give the extension popup a moment to close so the course page regains
  // focus before the first screenshot (anti-cheat players pause on blur).
  setTimeout(() => {
    void runCycle('start', { force: true });
  }, 550);
  return runtime;
}

function addTokens(left, right) {
  const a = left || {};
  const b = right || {};
  return {
    input: (Number(a.input) || 0) + (Number(b.input) || 0),
    output: (Number(a.output) || 0) + (Number(b.output) || 0),
    total: (Number(a.total) || 0) + (Number(b.total) || 0)
  };
}

function proactiveStopMessage({ snapshot, decision, settings, plan }) {
  const video = snapshot.video;
  const nearEnd = !video?.found ||
    Boolean(video.ended) ||
    (Number(video.duration) > 0 && Number(video.currentTime) >= Number(video.duration) - 1);

  if (snapshot.quiz?.detected && !settings.autoAnswer) {
    return '检测到答题界面，但“自动答题”已关闭。请手动作答，或到设置中开启后继续。';
  }
  if (decision.state === 'ended' && nearEnd && !settings.autoNext) {
    return '视频已结束，但“自动切换下一节”已关闭。请手动切换或到设置中开启。';
  }
  if (
    snapshot.video?.found &&
    snapshot.video.paused &&
    !snapshot.video.ended &&
    !snapshot.quiz?.detected &&
    !settings.autoResume
  ) {
    return '视频处于暂停状态，但“自动续播”已关闭。请手动继续或到设置中开启。';
  }
  if (decision.state === 'quiz' && plan.actions.length === 0 && !plan.needsUser) {
    return '检测到答题界面，但 AI 没有给出可执行答案。请手动检查题目，避免误答。';
  }
  return '';
}

async function trySelfHealNeedsUser({ message, url, tabId, settings }) {
  if (!settings.selfHeal) return false;
  if (HARD_BLOCK_RE.test(message || '')) return false;

  const runtime = await getRuntime();
  if ((Number(runtime.selfHealRetryCount) || 0) >= 2) return false;
  const heal = await recordNeedsUserRecovery(url);
  if (!heal) return false;

  await updateRuntime({
    lastSelfHeal: heal,
    selfHealRetryCount: (Number(runtime.selfHealRetryCount) || 0) + 1,
    lastActionSummary: heal.message
  });
  await sendHud(tabId, {
    kind: 'watching',
    text: '自诊断：切换策略重试',
    detail: heal.message
  });
  await scheduleQuizVerify(5, 'quiz');
  return true;
}

async function finishNeedsUser(message, settings, execution = null) {
  const runtime = await getRuntime();
  const history = appendHistory(runtime, {
    at: Date.now(),
    state: runtime.lastDecision?.state || 'unknown',
    actions: execution?.actions || [],
    result: execution?.summary ? `${message} 已执行：${execution.summary}` : message,
    ok: false,
    videoTime: runtime.lastDecision?.videoTime ?? null
  });
  await updateRuntime({
    history,
    lastActionSummary: message,
    cycleCount: (Number(runtime.cycleCount) || 0) + 1
  });
  await stopAutomation({
    status: RUNTIME_STATUS.NEEDS_USER,
    reason: message,
    notifyUser: true
  });
}

async function handleCycleError(error, settings, cycleId = '') {
  const message = errorMessage(error);
  if (settings?.debugLog) {
    await appendDebugLog({
      stage: 'error',
      cycleId,
      message,
      stack: String(error?.stack || '').slice(0, 3000),
      rawContent: error?.rawContent || '',
      status: error?.status || null
    });
  }
  const runtime = await getRuntime();
  if (settings?.selfHeal &&
      /无法连接页面脚本/.test(message) &&
      Number.isInteger(runtime.targetTabId) &&
      (Number(runtime.errorCount) || 0) < 1) {
    try {
      await chrome.tabs.reload(runtime.targetTabId);
      await updateRuntime({
        errorCount: 1,
        lastSelfHeal: {
          action: 'reload-tab',
          message: '页面脚本失联，已自动刷新并重试'
        },
        lastActionSummary: '自诊断：刷新页面后重试'
      });
      await scheduleQuizVerify(5, 'section');
      return;
    } catch {
      // fall through to fatal handling
    }
  }

  const fatal = (error instanceof ApiError && [401, 403].includes(error.status)) ||
    /无法连接页面脚本|不是网页|不允许扩展操作|标签页.*关闭|不在允许列表/.test(message);

  const history = appendHistory(runtime, {
    at: Date.now(),
    state: 'error',
    actions: [],
    result: message,
    ok: false,
    videoTime: null
  });

  if (fatal) {
    await updateRuntime({ lastError: message, history, status: RUNTIME_STATUS.ERROR });
    await stopAutomation({
      status: RUNTIME_STATUS.ERROR,
      reason: message,
      notifyUser: true
    });
    return;
  }

  if (error instanceof ApiError && [429, 500, 502, 503, 504].includes(error.status)) {
    const heal = await recordApiFailure(runtime.targetUrl, error.status);
    if (heal) {
      await updateRuntime({ lastSelfHeal: heal });
      settings = await getEffectiveSettings(settings, runtime.targetUrl);
    }
  }

  const errorCount = (Number(runtime.errorCount) || 0) + 1;
  if (Number.isInteger(runtime.targetTabId)) {
    await sendHud(runtime.targetTabId, {
      kind: 'error',
      text: '本轮分析失败',
      detail: message
    });
  }

  if (errorCount >= 3) {
    await updateRuntime({ lastError: message, errorCount, history });
    await stopAutomation({
      status: RUNTIME_STATUS.ERROR,
      reason: `连续失败 ${errorCount} 次：${message}`,
      notifyUser: true
    });
    return;
  }

  await updateRuntime({
    status: RUNTIME_STATUS.ERROR,
    lastError: message,
    errorCount,
    history,
    lastCompletedAt: Date.now()
  });
  await scheduleNext(Math.max(60, Number(settings?.intervalSeconds) || 45));
}

async function runCycle(trigger, options = {}) {
  clearQuizVerifyTimer();
  clearQuizVerifyAlarm();
  if (inFlight) {
    rerunRequested = true;
    return;
  }

  const before = await getRuntime();
  if (!before.running) return;
  if (!options.force && Date.now() - lastAnalysisAt < MIN_ANALYSIS_GAP_MS) {
    rerunRequested = true;
    return;
  }

  const sessionStartedAt = before.startedAt;
  const cycleId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  inFlight = true;
  lastAnalysisAt = Date.now();
  // Watchdog: if the MV3 worker is suspended in the middle of a cycle, this
  // alarm wakes it so the session can resume instead of being stuck forever.
  try {
    await chrome.alarms.create(ALARM_NAME, { when: Date.now() + 120000 });
  } catch {
    // Recovery is best-effort; the normal next-run alarm may still exist.
  }
  let settings;

  const cycleStillValid = async (tabId) => {
    const current = await getRuntime();
    return Boolean(
      current.running &&
      current.startedAt === sessionStartedAt &&
      current.targetTabId === tabId
    );
  };

  try {
    settings = await getSettings();
    let runtime = await getRuntime();
    if (!runtime.running) return;

    const startedAt = Number(runtime.startedAt) || Date.now();
    if (Date.now() - startedAt > settings.maxRuntimeMinutes * 60_000) {
      await stopAutomation({
        status: RUNTIME_STATUS.IDLE,
        reason: `已达到单次运行上限（${settings.maxRuntimeMinutes} 分钟），已自动停止。`,
        notifyUser: true
      });
      return;
    }

    let tab = await getTargetTab(runtime);
    if (!tab) {
      await stopAutomation({ status: RUNTIME_STATUS.IDLE, reason: '课程标签页已关闭。' });
      return;
    }
    if (tab.discarded) {
      try {
        await chrome.tabs.update(tab.id, { active: true });
        tab = (await waitForTabComplete(tab.id, 7000)) || await chrome.tabs.get(tab.id);
        await ensureContentScripts(tab.id);
      } catch {
        await stopAutomation({
          status: RUNTIME_STATUS.IDLE,
          reason: '课程标签页已被浏览器休眠，且恢复失败。请重新打开课程页。',
          notifyUser: true
        });
        return;
      }
    }
    const url = tab.url || tab.pendingUrl || '';
    settings = await getEffectiveSettings(settings, url);
    if (!isHttpUrl(url)) {
      await stopAutomation({
        status: RUNTIME_STATUS.ERROR,
        reason: '课程标签页已不是普通网页，自动观看已停止。',
        notifyUser: true
      });
      return;
    }
    if (!isHostAllowed(url, settings.allowedHosts)) {
      await stopAutomation({
        status: RUNTIME_STATUS.ERROR,
        reason: `${new URL(url).hostname} 不在允许列表中，已停止。`,
        notifyUser: true
      });
      return;
    }

    startKeepAlive(tab.id);
    await focusTarget(tab, settings);
    if (settings.clickMode !== 'dom') {
      // If the MV3 worker was suspended since the last cycle, the debugger may
      // have detached. Reattach before this cycle's screenshot so the viewport
      // is identical for screenshot and coordinate click.
      await beginPointerSession(tab.id, { persistent: true });
      if (!(await cycleStillValid(tab.id))) return;
    }
    const liveTab = await chrome.tabs.get(tab.id).catch(() => tab);
    await updateRuntime({
      status: RUNTIME_STATUS.ANALYZING,
      lastCycleAt: Date.now(),
      lastCycleTrigger: trigger,
      lastError: '',
      nextRunAt: null,
      targetUrl: liveTab.url || url,
      targetTitle: liveTab.title || tab.title || ''
    });
    await sendHud(tab.id, {
      kind: 'analyzing',
      text: 'AI 正在看屏幕…',
      detail: trigger === 'start' ? '首轮分析' : '定时巡检'
    });

    const snapshot = await collectTabSnapshot(liveTab);
    // Keep the extension's own HUD out of the screenshot so it cannot hide a
    // quiz option or confuse the vision model.
    await sendHud(tab.id, { hidden: true });
    await sleep(90);
    const shot = await captureTab(liveTab, settings);
    if (!(await cycleStillValid(tab.id))) {
      await sendHud(tab.id, { kind: 'idle', text: '已停止' });
      return;
    }
    await sendHud(tab.id, {
      kind: 'analyzing',
      text: 'AI 正在看屏幕…',
      detail: trigger === 'start' ? '首轮分析' : '定时巡检'
    });
    await setLastShot({ ...shot, at: Date.now(), trigger });

    runtime = await getRuntime();
    const siteMemory = settings.learnSite ? await getSiteMemory(url) : null;
    const ai = await analyzeWithAI({
      settings,
      snapshot,
      screenshotDataUrl: shot.dataUrl,
      runtime,
      siteMemory
    });
    // The user may have pressed Stop (or started a new session) during the request.
    if (!(await cycleStillValid(tab.id))) return;
    await recordApiSuccess(url);
    const decision = ai.decision;
    const plan = buildActionPlan({ decision, snapshot, settings });
    const noVideoCount = snapshot.video?.found
      ? 0
      : (Number(runtime.noVideoCount) || 0) + 1;
    const courseComplete = Boolean(decision.courseComplete || looksCourseComplete(snapshot));
    const quizContext = Boolean(
      snapshot.quiz?.detected || decision.quiz?.detected || decision.state === 'quiz'
    );
    const videoEnded = Boolean(snapshot.video?.found) && (
      Boolean(snapshot.video.ended) ||
      (Number(snapshot.video.duration) > 0 &&
        Number(snapshot.video.currentTime) >= Number(snapshot.video.duration) - 1)
    );
    const noVideo = !snapshot.video?.found;
    const standaloneQuiz = Boolean(settings.skipStandaloneQuiz && noVideo && quizContext);
    const videoTab = snapshot.sectionTabs?.video;
    const videoTabEntry = videoTab?.elementId
      ? snapshot.elementIndex?.get(videoTab.elementId)
      : null;
    const videoTabAction = Boolean(
      videoTab && !videoTab.active && (videoTabEntry || videoTab.bbox)
    );
    if (videoTabAction) {
      plan.actions = [videoTabEntry
        ? {
            type: 'click',
            elementId: videoTab.elementId,
            frameId: videoTabEntry.frameId,
            localId: videoTabEntry.localId,
            elementLabel: videoTab.label || '视频'
          }
        : {
            type: 'click_at',
            bbox: videoTab.bbox,
            x: (videoTab.bbox[0] + videoTab.bbox[2]) / 2,
            y: (videoTab.bbox[1] + videoTab.bbox[3]) / 2,
            target: videoTab.label || '视频标签'
          }];
      plan.needsUser = false;
      plan.message = '';
      plan.haltAfterMessage = '';
      plan.warnings.push('检测到“学习目标/视频/章节测验”标签页，先切换到视频标签。');
    }
    const currentQuizSignature = quizSignature(snapshot);
    const sameQuiz = runtime.quizSignature === currentQuizSignature;
    const quizAttempts = sameQuiz && Array.isArray(runtime.quizAttemptedOptions)
      ? runtime.quizAttemptedOptions
      : [];
    const quizRound = sameQuiz ? Number(runtime.quizOptionRound) || 0 : 0;
    let quizFallback = null;
    let plannedQuizLabels = selectedQuizLabels(plan, snapshot);

    // Never stop at an answer confirmation. If the model did not produce an
    // option (or repeats an already-tried one), choose the next untried option
    // from the page structure and submit it.
    if (settings.autoAnswer && settings.autoSubmit && quizContext && !standaloneQuiz && !videoTabAction) {
      const attempted = new Set(quizAttempts.map(normalizeChoiceLabel));
      const repeatsOnly = plannedQuizLabels.length > 0 &&
        plannedQuizLabels.every((label) => attempted.has(normalizeChoiceLabel(label)));
      const hasAnswer = plan.actions.some((action) =>
        isQuizAnswerAction(action, snapshot, decision)
      );
      const submitWithoutSelection = plannedQuizLabels.length === 0 &&
        plan.actions.some((action) => action.type === 'submit');
      if (!hasAnswer || repeatsOnly || submitWithoutSelection) {
        const fallback = buildQuizFallback({
          snapshot,
          runtime: {
            ...runtime,
            quizSignature: currentQuizSignature,
            quizAttemptedOptions: quizAttempts,
            quizOptionRound: quizRound
          }
        });
        if (fallback?.actions) {
          plan.actions = fallback.actions;
          plan.needsUser = false;
          plan.message = '';
          plan.haltAfterMessage = '';
          plan.warnings.push(fallback.reason);
          quizFallback = fallback;
          plannedQuizLabels = selectedQuizLabels(plan, snapshot);
        }
      }
    }

    if (
      settings.autoSubmit &&
      quizContext &&
      !standaloneQuiz &&
      !plan.actions.some((action) => action.type === 'submit') &&
      plannedQuizLabels.length > 0
    ) {
      const submit = (snapshot.quiz?.submitCandidates || []).find((item) => item.elementId);
      const submitEntry = submit ? snapshot.elementIndex?.get(submit.elementId) : null;
      plan.actions.push({
        type: 'submit',
        elementId: submit?.elementId || '',
        frameId: submitEntry?.frameId ?? snapshot.quiz?.frameId ?? 0,
        localId: submitEntry?.localId || ''
      });
      plan.warnings.push('已选择答案，自动提交。');
    }

    const visionScrollCount = Number(runtime.visionScrollCount) || 0;
    const noVideoReady = standaloneQuiz || noVideoCount >= 2;
    const wantsNext = videoEnded || (noVideo && noVideoReady);

    // “Only play video sections”: a standalone chapter quiz is not answered.
    // Keep only navigation/scroll actions, then look for a video section.
    if (standaloneQuiz && !videoTabAction) {
      const before = plan.actions.length;
      plan.actions = plan.actions.filter((action) =>
        action.type === 'scroll_at' ||
        action.type === 'next' ||
        action.type === 'wait' ||
        (action.type === 'click_at' && NAV_TARGET_RE.test(action.target || '')) ||
        (action.type === 'click' && NAV_TARGET_RE.test(action.elementLabel || ''))
      );
      if (plan.actions.length !== before) {
        plan.warnings.push('当前是独立章节测验，按“仅播放视频节”跳过，不执行答题。');
      }
    }

    const deferCompletionForNext = courseComplete &&
      settings.autoNext &&
      wantsNext;
    const shouldSynthesizeEndedNext = (!courseComplete || deferCompletionForNext) &&
      settings.autoNext &&
      wantsNext &&
      plan.actions.length === 0 &&
      !plan.haltAfterMessage &&
      !HARD_BLOCK_RE.test(plan.message || '');
    let synthesizedNext = false;
    if (shouldSynthesizeNext({ snapshot, decision, plan, runtime, settings }) ||
        shouldSynthesizeEndedNext) {
      if (plan.needsUser) {
        plan.needsUser = false;
        plan.message = '';
      }
      plan.actions.push({
        type: 'next',
        frameId: 0,
        localId: '',
        elementLabel: wantsNext ? '下一节（视觉/结构兜底）' : '下一节',
        synthetic: true
      });
      plan.warnings.push('页面结构兜底：尝试点击下一节（含侧边栏目录）。');
      synthesizedNext = true;
    }
    if (visionScrollCount >= 3 && plan.actions.some((action) => action.type === 'scroll_at')) {
      plan.actions = plan.actions.filter((action) => action.type !== 'scroll_at');
      plan.warnings.push('已滚动目录多次，停止继续滚动。');
    }

    const summary = summarizePlan(plan);
    const lastDecision = {
      ...decision,
      at: Date.now(),
      model: ai.model,
      latencyMs: ai.latencyMs,
      usage: ai.usage,
      planSummary: summary,
      warnings: [...(plan.warnings || [])],
      courseComplete,
      noVideoCount,
      videoTime: Number.isFinite(snapshot.video?.currentTime) ? snapshot.video.currentTime : null,
      screenshot: { width: shot.width, height: shot.height, bytes: shot.bytes }
    };

    if (settings.debugLog) {
      const topFrame = (snapshot.frames || []).find((frame) => frame.isTop) || snapshot.frames?.[0];
      await appendDebugLog({
        stage: 'analysis',
        cycleId,
        trigger,
        url,
        title: snapshot.title,
        viewport: snapshot.viewport,
        screenshot: { width: shot.width, height: shot.height, bytes: shot.bytes },
        video: snapshot.video,
        quiz: {
          detected: Boolean(snapshot.quiz?.detected),
          score: snapshot.quiz?.score,
          question: snapshot.quiz?.question,
          text: String(snapshot.quiz?.text || '').slice(0, 3000)
        },
        catalog: snapshot.catalog || null,
        controls: (snapshot.controls || []).slice(0, 80).map((control) => ({
          elementId: control.elementId,
          tag: control.tag,
          label: control.label,
          group: control.group,
          disabled: control.disabled
        })),
        pageText: String(topFrame?.pageText || '').slice(0, 3000),
        ai: {
          model: ai.model,
          latencyMs: ai.latencyMs,
          usage: ai.usage,
          requestId: ai.requestId,
          finishReason: ai.finishReason || '',
          repaired: Boolean(ai.repaired),
          parseError: ai.parseError || '',
          rawContent: String(ai.content || '')
        },
        decision,
        plan: {
          summary,
          actions: plan.actions,
          warnings: plan.warnings,
          needsUser: plan.needsUser,
          haltAfterMessage: plan.haltAfterMessage
        },
        state: {
          noVideoCount,
          visionScrollCount,
          courseComplete,
          standaloneQuiz,
          wantsNext,
          quizAttempts,
          plannedQuizLabels,
          quizFallback: quizFallback
            ? { selectedLabel: quizFallback.selectedLabel, round: quizFallback.round }
            : null
        },
        settings: {
          model: settings.model,
          clickMode: settings.clickMode,
          confidenceThreshold: settings.confidenceThreshold,
          autoAnswer: settings.autoAnswer,
          autoSubmit: settings.autoSubmit,
          autoNext: settings.autoNext,
          autoResume: settings.autoResume,
          skipStandaloneQuiz: settings.skipStandaloneQuiz
        }
      });
    }

    runtime = await updateRuntime({
      status: plan.needsUser ? RUNTIME_STATUS.NEEDS_USER : RUNTIME_STATUS.ACTING,
      lastDecision,
      lastActionSummary: plan.needsUser ? plan.message : summary,
      noVideoCount,
      tokens: addTokens(runtime.tokens, ai.usage)
    });

    await sendHud(tab.id, {
      kind: plan.needsUser ? 'needs_user' : 'acting',
      text: plan.needsUser ? '需要你的确认' : settings.dryRun ? `[演示] ${summary}` : summary,
      detail: decision.reason
    });

    if (courseComplete && !deferCompletionForNext && !videoTabAction) {
      if (!(await cycleStillValid(tab.id))) return;
      await updateRuntime({
        lastActionSummary: '所有视频节已完成',
        lastCompletedAt: Date.now()
      });
      await stopAutomation({
        status: RUNTIME_STATUS.COMPLETED,
        reason: '所有视频节已完成，FocusFlow 已自动停止。',
        notifyUser: true
      });
      return;
    }

    if (plan.needsUser) {
      if (!(await cycleStillValid(tab.id))) return;
      if (await trySelfHealNeedsUser({
        message: plan.message,
        url,
        tabId: tab.id,
        settings
      })) return;
      await finishNeedsUser(plan.message, settings);
      return;
    }

    if (plan.haltAfterMessage && plan.actions.length === 0) {
      if (!(await cycleStillValid(tab.id))) return;
      await finishNeedsUser(plan.haltAfterMessage, settings);
      return;
    }

    if (!plan.haltAfterMessage) {
      const proactive = proactiveStopMessage({ snapshot, decision, settings, plan });
      if (proactive) {
        if (!(await cycleStillValid(tab.id))) return;
        if (await trySelfHealNeedsUser({
          message: proactive,
          url,
          tabId: tab.id,
          settings
        })) return;
        await finishNeedsUser(proactive, settings);
        return;
      }
    }

    if (!(await cycleStillValid(tab.id))) return;
    if (plan.actions.length) await focusTarget(tab, settings);
    const execution = await executePlan({
      plan,
      snapshot,
      settings,
      tabId: tab.id
    });
    if (!(await cycleStillValid(tab.id))) return;

    if (!settings.dryRun) {
      const selfHeal = await recordActionResults(url, execution.results);
      if (selfHeal) {
        await updateRuntime({ lastSelfHeal: selfHeal });
        await sendHud(tab.id, {
          kind: 'watching',
          text: '自诊断：已调整策略',
          detail: selfHeal.message
        });
      }
    }

    if (plan.haltAfterMessage) {
      await updateRuntime({ lastActionSummary: execution.summary });
      await finishNeedsUser(plan.haltAfterMessage, settings, {
        actions: plan.actions.map((action) => describeAction(action)),
        summary: execution.summary
      });
      return;
    }

    const nextAction = hasNextAction(plan);
    const scrollAction = plan.actions.some((action) => action.type === 'scroll_at');
    const cadence = standaloneQuiz
      ? { mode: 'normal', armed: false, count: 0, answered: false }
      : nextQuizCadence({ snapshot, decision, plan, runtime, settings });
    if (cadence.answered && snapshot.quiz?.detected && settings.autoAnswer && !settings.autoSubmit) {
      const message = '答案已选择，但“自动提交”已关闭。请核对答案并手动提交，然后重新启动。';
      await updateRuntime({ lastActionSummary: execution.summary });
      await finishNeedsUser(message, settings, {
        actions: plan.actions.map((action) => describeAction(action)),
        summary: execution.summary
      });
      return;
    }

    const tabAfter = await getTabSummary(tab.id);
    runtime = await getRuntime();
    if (settings.learnSite && execution.ok && !settings.dryRun) {
      const learned = await recordSiteActions(url, plan.actions, {
        title: tabAfter?.title || runtime.targetTitle,
        url: tabAfter?.url || runtime.targetUrl,
        observation: decision.observation
      });
      if (learned) await updateRuntime({ siteMemory: learned });
    }
    if (settings.debugLog) {
      await appendDebugLog({
        stage: 'result',
        cycleId,
        ok: execution.ok,
        summary: execution.summary,
        actions: plan.actions,
        results: execution.results,
        tab: tabAfter,
        visionScrollCount,
        nextAction,
        scrollAction,
        quizAttempts: runtime.quizAttemptedOptions || [],
        quizFallback: quizFallback
          ? { selectedLabel: quizFallback.selectedLabel, round: quizFallback.round }
          : null,
        selfHeal: runtime.lastSelfHeal || null
      });
    }
    const historyEntry = {
      at: Date.now(),
      state: decision.state,
      actions: plan.actions.map((action) => describeAction(action)),
      result: execution.summary,
      ok: execution.ok,
      videoTime: Number.isFinite(snapshot.video?.currentTime) ? snapshot.video.currentTime : null
    };
    const history = appendHistory(runtime, historyEntry);

    if (!execution.ok && execution.needsUser) {
      await updateRuntime({
        history,
        lastActionSummary: execution.message,
        cycleCount: (Number(runtime.cycleCount) || 0) + 1
      });
      await stopAutomation({
        status: RUNTIME_STATUS.NEEDS_USER,
        reason: execution.message,
        notifyUser: true
      });
      return;
    }

    if (!execution.ok) {
      if (synthesizedNext && /没有找到.*下一节|没有找到“下一节”/i.test(execution.message || '')) {
        await updateRuntime({
          lastError: execution.message,
          lastActionSummary: '没有更多视频节'
        });
        await stopAutomation({
          status: RUNTIME_STATUS.COMPLETED,
          reason: '页面结构与侧边栏目录都没有找到下一节，按全部视频节完成停止。',
          notifyUser: true
        });
        return;
      }
      throw new Error(execution.message || '页面操作失败。');
    }

    const navigationChanged = Boolean(nextAction) &&
      (tabAfter?.url !== runtime.targetUrl || tabAfter?.title !== runtime.targetTitle);
    const nextStuck = Boolean(nextAction) && !navigationChanged;
    const sectionProbeCount = nextStuck
      ? (Number(runtime.sectionProbeCount) || 0) + 1
      : 0;

    await updateRuntime({
      status: RUNTIME_STATUS.WATCHING,
      cycleCount: (Number(runtime.cycleCount) || 0) + 1,
      lastCompletedAt: Date.now(),
      lastActionSummary: execution.summary,
      lastError: '',
      errorCount: 0,
      targetUrl: tabAfter?.url || runtime.targetUrl,
      targetTitle: tabAfter?.title || runtime.targetTitle,
      quizVerifyArmed: cadence.armed,
      quizRetryCount: cadence.count,
      quizVerifyAt: null,
      quizSignature: quizContext ? currentQuizSignature : '',
      quizAttemptedOptions: quizContext
        ? [...new Set([...quizAttempts, ...plannedQuizLabels])].slice(-40)
        : [],
      quizOptionRound: quizContext ? (quizFallback?.round ?? quizRound) : 0,
      noVideoCount: nextAction || snapshot.video?.found ? 0 : noVideoCount,
      visionScrollCount: scrollAction
        ? visionScrollCount + 1
        : nextAction || (snapshot.video?.found && !videoEnded)
          ? 0
          : visionScrollCount,
      sectionProbeCount,
      selfHealRetryCount: 0,
      history
    });

    if (cadence.mode === 'verify') {
      await sendHud(tab.id, {
        kind: 'watching',
        text: '答题已提交，等待结果…',
        detail: `${settings.quizVerifySeconds} 秒后自动复查`
      });
      await scheduleQuizVerify(settings.quizVerifySeconds);
      return;
    }

    if (cadence.mode === 'stop') {
      if (settings.selfHeal) {
        const heal = await recordQuizRetryLimit(url);
        if (heal) {
          await updateRuntime({
            lastSelfHeal: heal,
            quizVerifyArmed: false,
            quizRetryCount: 0
          });
          await sendHud(tab.id, {
            kind: 'watching',
            text: '自诊断：切换策略重试答题',
            detail: heal.message
          });
          await scheduleQuizVerify(5, 'quiz');
          return;
        }
      }
      await stopAutomation({
        status: RUNTIME_STATUS.NEEDS_USER,
        reason: cadence.reason || '答题多次复查仍未通过，请手动检查。',
        notifyUser: true
      });
      return;
    }

    if (ai.parseError && cadence.mode === 'normal' && !quizContext) {
      await sendHud(tab.id, {
        kind: 'watching',
        text: '模型输出异常，已安排自动重试',
        detail: '解析失败，不会要求人工确认'
      });
      await scheduleQuizVerify(20, 'section');
      return;
    }

    if (nextStuck && sectionProbeCount >= 2) {
      await stopAutomation({
        status: RUNTIME_STATUS.NEEDS_USER,
        reason: '已连续点击下一节，但页面 URL/标题没有变化；为避免 3–5 秒高频巡检，已停止并等待确认。',
        notifyUser: true
      });
      return;
    }

    const sectionProbe = !settings.dryRun &&
      settings.autoNext &&
      (!quizContext || standaloneQuiz) &&
      (videoTabAction || nextAction || scrollAction || (!snapshot.video?.found && noVideoCount >= 1));
    if (sectionProbe) {
      await sendHud(tab.id, {
        kind: 'watching',
        text: videoTabAction
          ? '已切换到视频标签，准备播放…'
          : scrollAction
            ? '已滚动目录，继续查找下一节…'
            : nextAction
              ? '已切换，检查下一节…'
              : '当前节不是视频，跳过…',
        detail: videoTabAction || scrollAction ? '2 秒后复查' : '短周期复查'
      });
      await scheduleQuizVerify(videoTabAction || scrollAction ? 2 : 5, 'section');
      return;
    }

    await sendHud(tab.id, {
      kind: 'watching',
      text: settings.dryRun ? `[演示] ${summary}` : summary,
      detail: decision.reason
    });
    await scheduleNext(settings.intervalSeconds);
  } catch (error) {
    const current = await getRuntime();
    if (!current.running || current.startedAt !== sessionStartedAt) return;
    await handleCycleError(error, settings, cycleId);
  } finally {
    inFlight = false;
    // Keep the MV3 worker alive for the short in-memory quiz verification
    // timer; the 30s alarm is only a fallback.
    if (!quizVerifyTimer) stopKeepAlive();
    if (rerunRequested) {
      rerunRequested = false;
      const runtime = await getRuntime();
      if (runtime.running) {
        eventTimer = setTimeout(() => {
          eventTimer = null;
          void runCycle('queued');
        }, 1800);
        // Keep a wake-up path if the service worker is suspended while waiting.
        await chrome.alarms.create(ALARM_NAME, { when: Date.now() + 90000 });
      }
    }
  }
}

function queueContentEvent(type, extraDelay = 0) {
  const delays = {
    ended: 900,
    quiz: 1100,
    visibility: 700,
    dialog: 1400,
    pause: 2400,
    waiting: 6500,
    dom_change: 2600
  };
  const base = Math.max(delays[type] || 1800, Number(extraDelay) || 0);
  const waitForGap = Math.max(0, MIN_ANALYSIS_GAP_MS - (Date.now() - lastAnalysisAt));
  const delay = Math.max(base, waitForGap);
  if (eventTimer) clearTimeout(eventTimer);
  eventTimer = setTimeout(() => {
    eventTimer = null;
    void runCycle(`event:${type}`);
  }, delay);
}

async function handleContentEvent(message, sender) {
  const event = message?.event;
  if (!event || !sender.tab?.id) return;
  const runtime = await getRuntime();
  if (!runtime.running || runtime.targetTabId !== sender.tab.id) return;
  if (!['ended', 'quiz', 'dialog', 'pause', 'waiting', 'visibility', 'dom_change'].includes(event.type)) return;
  if (event.type === 'dom_change') {
    const now = Date.now();
    // Structure events are useful, but a video player mutates its DOM
    // constantly. Never let generic mutations turn the 120s poll into a 3s one.
    if (now - lastStructureEventAt < 20000) return;
    lastStructureEventAt = now;
    queueContentEvent('dom_change', event.kind === 'navigation' ? 800 : 1800);
    return;
  }
  queueContentEvent(event.type);
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case 'FF_START': {
      const existing = await getRuntime();
      if (existing.running) throw new Error('FocusFlow 已在运行。请先停止，再重新选择课程页。');
      const tabId = Number.isInteger(message.tabId)
        ? message.tabId
        : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      if (!tabId) throw new Error('找不到当前标签页。');
      const runtime = await startAutomation(tabId);
      return { ok: true, runtime };
    }
    case 'FF_STOP': {
      const runtime = await getRuntime();
      if (sender.tab?.id && runtime.targetTabId !== sender.tab.id) {
        throw new Error('只能停止当前目标课程。');
      }
      await stopAutomation({ status: RUNTIME_STATUS.IDLE, reason: '用户手动停止。' });
      return { ok: true };
    }
    case 'FF_DIAGNOSTICS': {
      const runtime = await getRuntime();
      let tabId = Number.isInteger(message.tabId) ? message.tabId : runtime.targetTabId;
      if (!Number.isInteger(tabId)) {
        tabId = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      }
      if (!Number.isInteger(tabId)) throw new Error('找不到要诊断的标签页。');
      const tab = await chrome.tabs.get(tabId);
      if (!isHttpUrl(tab.url || '')) {
        throw new Error('只能诊断普通 http/https 课程页。');
      }
      await ensureContentScripts(tab.id);
      const snapshot = await collectTabSnapshot(tab);
      return { ok: true, diagnostics: buildDiagnostics(snapshot, tab, runtime) };
    }
    case 'FF_STATUS': {
      let runtime = await getRuntime();
      if (
        runtime.running &&
        [RUNTIME_STATUS.ANALYZING, RUNTIME_STATUS.ACTING].includes(runtime.status) &&
        !inFlight &&
        runtime.lastCycleAt &&
        Date.now() - runtime.lastCycleAt > 180000
      ) {
        runtime = { ...runtime, status: RUNTIME_STATUS.WATCHING, lastError: '上一轮分析被浏览器中断，等待下一轮。' };
      }
      const settings = await getSettings();
      return {
        ok: true,
        runtime,
        settings: sanitizeSettingsForUi(settings),
        lastShotInfo: await getLastShotInfo()
      };
    }
    case 'FF_GET_SHOT': {
      return { ok: true, lastShot: await getLastShot() };
    }
    case 'FF_ANALYZE_NOW': {
      const runtime = await getRuntime();
      if (!runtime.running) throw new Error('请先启动再立即分析。');
      if (inFlight) {
        rerunRequested = true;
        return { ok: true, queued: true };
      }
      void runCycle('manual', { force: true });
      return { ok: true };
    }
    case 'FF_UPDATE_SETTINGS': {
      const current = await getSettings();
      const incoming = message.settings && typeof message.settings === 'object' ? message.settings : {};
      const next = normalizeSettings({ ...current, ...incoming });
      await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
      const runtime = await getRuntime();
      if (runtime.running) await scheduleNext(next.intervalSeconds);
      return { ok: true, settings: sanitizeSettingsForUi(next) };
    }
    case 'FF_TEST_API': {
      const current = await getSettings();
      const incoming = message.settings && typeof message.settings === 'object' ? message.settings : {};
      const testSettings = normalizeSettings({ ...current, ...incoming });
      const result = await testConnection(testSettings);
      return { ok: true, result };
    }
    case 'FF_OPEN_TARGET': {
      const runtime = await getRuntime();
      const tab = await getTargetTab(runtime);
      if (!tab) throw new Error('目标标签页已关闭。');
      await focusTarget(tab, { focusTarget: true });
      return { ok: true };
    }
    case 'FF_OPEN_OPTIONS': {
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    }
    default:
      throw new Error(`未知消息：${message?.type || '?'}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'FF_EVENT') {
    void handleContentEvent(message, sender).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  void handleMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === QUIZ_VERIFY_ALARM) {
    clearQuizVerifyTimer();
    void runCycle('quiz-verify').catch(() => {});
    return;
  }
  if (alarm.name !== ALARM_NAME) return;
  void runCycle('timer').catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const runtime = await getRuntime();
    if (runtime.running && runtime.targetTabId === tabId) {
      await stopAutomation({ status: RUNTIME_STATUS.IDLE, reason: '课程标签页已关闭。' });
    }
  })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    scheduleAutoStart(tabId, 1800);
  }
  if (!changeInfo.url && !changeInfo.title) return;
  void (async () => {
    const runtime = await getRuntime();
    if (runtime.targetTabId !== tabId) return;
    await updateRuntime({
      targetUrl: changeInfo.url || runtime.targetUrl,
      targetTitle: changeInfo.title || runtime.targetTitle
    });
  })();
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  scheduleAutoStart(tabId, 1200);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-automation') return;
  void (async () => {
    try {
      const runtime = await getRuntime();
      if (runtime.running) {
        await stopAutomation({ status: RUNTIME_STATUS.IDLE, reason: '快捷键停止。' });
      } else {
        const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        if (tab?.id) await startAutomation(tab.id);
      }
    } catch (error) {
      await notify('FocusFlow 无法启动', errorMessage(error));
    }
  })();
});

chrome.notifications.onClicked.addListener(() => {
  void (async () => {
    const runtime = await getRuntime();
    const tab = await getTargetTab(runtime);
    if (tab) await focusTarget(tab, { focusTarget: true });
  })();
});

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    const settings = await ensureSettings();
    await refreshBadge();
    if (details.reason === 'install') {
      await chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html?welcome=1') });
    } else {
      const runtime = await getRuntime();
      if (runtime.running) {
        await stopAutomation({
          status: RUNTIME_STATUS.IDLE,
          reason: '扩展已更新，请刷新课程页后重新启动。'
        });
      }
      // Touch settings once so old installs receive newly introduced defaults.
      await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await chrome.alarms.clear(ALARM_NAME);
    const runtime = await getRuntime();
    if (runtime.running) {
      if (Number.isInteger(runtime.targetTabId)) {
        await releasePointerSession(runtime.targetTabId);
      }
      await updateRuntime({
        running: false,
        status: RUNTIME_STATUS.IDLE,
        nextRunAt: null,
        pausedReason: '浏览器已重启，自动观看未自动恢复。'
      });
    }
    await ensureSettings();
    await refreshBadge();
    const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (tab?.id) scheduleAutoStart(tab.id, 2500);
  })();
});

// Cold-start initialization (also covers a service worker restarted after idle).
void (async () => {
  await ensureSettings();
  await refreshBadge();
  const runtime = await getRuntime();
  if (runtime.running && !runtime.nextRunAt) {
    await chrome.alarms.create(ALARM_NAME, { when: Date.now() + 30000 });
  }
  if (runtime.running && Date.now() - (Number(runtime.lastCycleAt) || 0) > 10000) {
    setTimeout(() => {
      void runCycle('resume', { force: true });
    }, 900);
  } else if (!runtime.running) {
    const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (tab?.id) scheduleAutoStart(tab.id, 3000);
  }
})();
