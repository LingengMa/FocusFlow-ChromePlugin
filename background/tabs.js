import { truncate } from '../shared/ai-protocol.js';

const MESSAGE_TIMEOUT_MS = 3000;
const MAX_CONTROLS = 90;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function isSupportedFrameUrl(url) {
  if (!url) return true;
  return /^(https?|about):/i.test(url);
}

function normalizeFrameId(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export async function getTargetTab(runtime) {
  if (!Number.isInteger(runtime?.targetTabId)) return null;
  try {
    const tab = await chrome.tabs.get(runtime.targetTabId);
    return tab || null;
  } catch {
    return null;
  }
}

export async function waitForTabComplete(tabId, timeoutMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return tab;
    } catch {
      return null;
    }
    await sleep(250);
  }
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

export async function focusTarget(tab, settings) {
  if (!settings.focusTarget) return;
  let changed = false;
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (win?.state === 'minimized') {
      await chrome.windows.update(tab.windowId, { state: 'normal', focused: true });
      changed = true;
    } else if (win?.focused === false) {
      await chrome.windows.update(tab.windowId, { focused: true });
      changed = true;
    }
  } catch {
    // The window may have been closed; the caller will handle a missing tab.
  }
  try {
    const current = await chrome.tabs.get(tab.id);
    if (!current?.active) {
      await chrome.tabs.update(tab.id, { active: true });
      changed = true;
    }
  } catch {
    return;
  }
  // Avoid gratuitous focus events on every cycle: anti-cheat players often
  // pause on blur/visibilitychange, so only wait when something changed.
  if (changed) await sleep(220);
}

export async function pingFrame(tabId, frameId = 0) {
  try {
    const response = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: 'FF_PING' }, { frameId }),
      900,
      '连接页面'
    );
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

export async function ensureContentScripts(tabId) {
  const topReady = await pingFrame(tabId, 0);
  // Manifest content scripts cover new navigations; this covers tabs (and
  // cross-origin subframes) that were already open when the extension was
  // installed/reloaded. The content script guards against duplicate injection.
  if (!topReady) {
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: ['content/content.css']
    }).catch(() => {});
  }
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/content.js']
  }).catch(() => {});
  await sleep(180);
  return pingFrame(tabId, 0);
}

async function getFrames(tab) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    if (Array.isArray(frames) && frames.length) {
      return frames
        .filter((frame) => isSupportedFrameUrl(frame.url))
        .sort((a, b) => (a.parentFrameId === -1 ? -1 : b.parentFrameId === -1 ? 1 : a.frameId - b.frameId));
    }
  } catch {
    // webNavigation can fail for a tab that is navigating.
  }
  return [{ frameId: 0, parentFrameId: -1, url: tab.url, errorOccurred: false }];
}

async function requestFrameSnapshot(tabId, frameId) {
  const response = await withTimeout(
    chrome.tabs.sendMessage(tabId, { type: 'FF_SNAPSHOT' }, { frameId }),
    MESSAGE_TIMEOUT_MS,
    '读取页面状态'
  );
  if (!response?.ok || !response.snapshot) {
    throw new Error(response?.error || '页面脚本没有返回快照。');
  }
  return response.snapshot;
}

function controlPriority(control) {
  let score = 0;
  if (control.group === 'quiz') score += 100;
  if (/下一|next|继续|提交|确定|播放|暂停|play|pause|submit|continue/i.test(control.label || control.text || '')) {
    score += 40;
  }
  if (control.group === 'player') score += 25;
  if (control.checked) score += 8;
  if (control.disabled) score -= 15;
  return score;
}

/**
 * Collects snapshots from every accessible frame, assigns globally unique
 * element ids (`f<frameId>:e<n>`), and merges the useful parts for the model.
 */
export async function collectTabSnapshot(tab) {
  let frames = await getFrames(tab);
  let results = await Promise.all(
    frames.map(async (frame) => {
      const frameId = normalizeFrameId(frame.frameId);
      try {
        const snapshot = await requestFrameSnapshot(tab.id, frameId);
        return { frame, frameId, snapshot, error: null };
      } catch (error) {
        return { frame, frameId, snapshot: null, error: String(error?.message || error) };
      }
    })
  );

  let readable = results.filter((item) => item.snapshot);
  if (readable.length === 0) {
    await ensureContentScripts(tab.id);
    frames = await getFrames(tab);
    results = await Promise.all(
      frames.map(async (frame) => {
        const frameId = normalizeFrameId(frame.frameId);
        try {
          const snapshot = await requestFrameSnapshot(tab.id, frameId);
          return { frame, frameId, snapshot, error: null };
        } catch (error) {
          return { frame, frameId, snapshot: null, error: String(error?.message || error) };
        }
      })
    );
    readable = results.filter((item) => item.snapshot);
  }

  if (readable.length === 0) {
    throw new Error('无法连接页面脚本。请刷新课程页面后重试；chrome:// 页面和 Chrome 应用商店不允许扩展操作。');
  }

  const elementIndex = new Map();
  const controls = [];
  const mergedFrames = [];
  let primaryVideo = null;
  let primaryQuiz = null;
  let topViewport = null;

  for (const { frame, frameId, snapshot, error } of results) {
    if (!snapshot) {
      mergedFrames.push({
        frameId,
        url: frame.url || '',
        isTop: frame.parentFrameId === -1,
        pageText: '',
        error
      });
      continue;
    }

    const isTop = Boolean(snapshot.isTop) || frame.parentFrameId === -1;
    if (isTop && snapshot.viewport && !topViewport) {
      topViewport = snapshot.viewport;
    }
    const frameControls = [];

    for (const control of Array.isArray(snapshot.controls) ? snapshot.controls : []) {
      if (!control || !control.id) continue;
      const localId = String(control.id);
      const elementId = `f${frameId}:${localId}`;
      const entry = {
        ...control,
        elementId,
        frameId,
        localId,
        label: truncate(control.label || control.text || '', 180),
        text: truncate(control.text || '', 180)
      };
      elementIndex.set(elementId, entry);
      frameControls.push(entry);
      controls.push(entry);
    }

    let frameQuiz = null;
    if (snapshot.quiz?.detected) {
      const choices = (snapshot.quiz.choices || [])
        .map((choice) => {
          const localId = choice.id || choice.elementId;
          if (!localId) return null;
          const elementId = `f${frameId}:${localId}`;
          const entry = elementIndex.get(elementId);
          return {
            elementId,
            label: truncate(choice.label || entry?.label || '', 180),
            checked: Boolean(choice.checked)
          };
        })
        .filter(Boolean);

      const submitCandidates = (snapshot.quiz.submitCandidates || [])
        .map((candidate) => {
          const localId = candidate.id || candidate.elementId;
          if (!localId) return null;
          return {
            elementId: `f${frameId}:${localId}`,
            label: truncate(candidate.label || '', 120)
          };
        })
        .filter(Boolean);

      frameQuiz = {
        detected: true,
        frameId,
        tag: truncate(snapshot.quiz.tag || '', 40),
        className: truncate(snapshot.quiz.className || '', 180),
        score: Number(snapshot.quiz.score) || 0.5,
        question: truncate(snapshot.quiz.question || '', 700),
        text: truncate(snapshot.quiz.text || '', 2200),
        choices,
        submitCandidates
      };
      if (!primaryQuiz || frameQuiz.score > primaryQuiz.score) primaryQuiz = frameQuiz;
    }

    if (snapshot.video?.found) {
      const area = Number(snapshot.video.area) || 0;
      const candidate = {
        ...snapshot.video,
        frameId,
        area
      };
      if (!primaryVideo || area > primaryVideo.area) primaryVideo = candidate;
    }

    mergedFrames.push({
      frameId,
      url: snapshot.url || frame.url || '',
      isTop,
      title: truncate(snapshot.title || '', 160),
      pageText: truncate(snapshot.pageText || '', isTop ? 6500 : 1800),
      video: snapshot.video?.found
        ? {
            found: true,
            currentTime: snapshot.video.currentTime,
            duration: snapshot.video.duration,
            paused: snapshot.video.paused,
            ended: snapshot.video.ended
          }
        : { found: false },
      quiz: frameQuiz
        ? { detected: true, score: frameQuiz.score, question: frameQuiz.question }
        : { detected: false },
      controlsCount: frameControls.length,
      error
    });
  }

  if (primaryQuiz) {
    for (const choice of primaryQuiz.choices) {
      const entry = elementIndex.get(choice.elementId);
      if (entry && entry.group !== 'quiz') entry.group = 'quiz';
    }
  }

  const topFrame = mergedFrames.find((frame) => frame.isTop) || mergedFrames[0] || {};
  const sortedControls = [...controls]
    .sort((a, b) => controlPriority(b) - controlPriority(a))
    .slice(0, MAX_CONTROLS);

  return {
    tabId: tab.id,
    capturedAt: Date.now(),
    url: tab.url || topFrame.url || '',
    title: tab.title || topFrame.title || '',
    viewport: topViewport || { width: 1280, height: 720, dpr: 1 },
    frames: mergedFrames,
    video: primaryVideo || { found: false, frameId: 0 },
    quiz: primaryQuiz || { detected: false, frameId: 0, score: 0, choices: [], submitCandidates: [] },
    controls: sortedControls,
    elementIndex,
    diagnostics: {
      framesTotal: results.length,
      framesReadable: readable.length,
      errors: results.filter((item) => item.error).map((item) => ({ frameId: item.frameId, error: item.error }))
    }
  };
}

export async function sendHud(tabId, payload) {
  try {
    await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: 'FF_HUD', payload }, { frameId: 0 }),
      900,
      '更新页面浮层'
    );
  } catch {
    // HUD is best-effort.
  }
}

export async function executeActionInFrame(tabId, frameId, action) {
  const response = await withTimeout(
    chrome.tabs.sendMessage(
      tabId,
      { type: 'FF_EXECUTE_ACTION', action },
      { frameId: normalizeFrameId(frameId) }
    ),
    6000,
    '执行页面操作'
  );
  if (!response?.ok) {
    throw new Error(response?.error || '页面操作失败。');
  }
  return response;
}

export async function getTabSummary(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return { title: tab.title || '', url: tab.url || '', windowId: tab.windowId };
  } catch {
    return null;
  }
}
