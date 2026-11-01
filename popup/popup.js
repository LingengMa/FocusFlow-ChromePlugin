const $ = (id) => document.getElementById(id);

const STATUS_LABEL = {
  idle: '已停止',
  watching: '正在观看',
  analyzing: 'AI 分析中',
  acting: '执行操作',
  needs_user: '需要确认',
  completed: '已完成',
  error: '出错了'
};

const STATE_LABEL = {
  playing: '播放中',
  paused: '已暂停',
  buffering: '缓冲中',
  quiz: '答题中',
  ended: '已结束',
  loading: '加载中',
  unknown: '未知'
};

let latest = null;
let activeTab = null;
let pollTimer = null;
let busy = false;
let toastTimer = null;
let lastShotUrl = '';
let lastShotAt = 0;
let shotLoading = false;

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response) throw new Error('扩展后台没有响应，请重新加载扩展。');
  if (!response.ok) throw new Error(response.error || '操作失败。');
  return response;
}

async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) return tabs[0];
  } catch {
    // fall through
  }
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tabs[0] || null;
  } catch {
    return null;
  }
}

function formatNumber(value) {
  const n = Number(value) || 0;
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatClock(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '—';
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 4500);
}

function renderStatus(runtime) {
  const status = runtime?.status || 'idle';
  const running = Boolean(runtime?.running);
  const pill = $('statusPill');
  pill.dataset.status = status;
  $('statusText').textContent = running && runtime?.quizVerifyAt
    ? (runtime.probeReason === 'section' ? '切换后检查' : '答题复查中')
    : (STATUS_LABEL[status] || '已停止');
  const primary = $('primaryBtn');
  primary.classList.toggle('danger', running);
  primary.textContent = running
    ? '停止自动观看'
    : runtime?.status === 'completed'
      ? '重新开始'
      : runtime?.targetTabId
        ? '继续观看'
        : '开始观看当前标签页';
  primary.disabled = busy;
  $('analyzeBtn').disabled = busy || !running;

  $('cycleCount').textContent = formatNumber(runtime?.cycleCount || 0);
  $('tokenCount').textContent = formatNumber(runtime?.tokens?.total || 0);
}

function renderTarget(runtime) {
  const hasTarget = Boolean(runtime?.targetTabId);
  const title = hasTarget && runtime.targetTitle
    ? runtime.targetTitle
    : activeTab?.title || runtime?.targetTitle || '当前标签页';
  const url = hasTarget && runtime.targetUrl
    ? runtime.targetUrl
    : activeTab?.url || runtime?.targetUrl || '';
  const host = hostOf(url);
  $('targetTitle').textContent = title || '当前标签页';
  $('targetUrl').textContent = host || '打开课程页面后点击开始';
  $('siteMark').textContent = (host || 'F').charAt(0).toUpperCase();
  $('focusBtn').disabled = !runtime?.targetTabId && !activeTab?.id;
}

function renderScreenshot(shot) {
  const image = $('shotImage');
  const empty = $('shotEmpty');
  if (shot?.dataUrl) {
    if (shot.dataUrl !== lastShotUrl) {
      lastShotUrl = shot.dataUrl;
      image.src = shot.dataUrl;
    }
    image.classList.remove('hidden');
    empty.classList.add('hidden');
    const size = shot.width && shot.height ? `${shot.width}×${shot.height}` : '';
    $('shotTime').textContent = [formatClock(shot.at), size].filter(Boolean).join(' · ');
  } else {
    image.classList.add('hidden');
    empty.classList.remove('hidden');
    $('shotTime').textContent = '—';
  }
}

function renderDecision(runtime) {
  const decision = runtime?.lastDecision;
  const confidence = Number(decision?.confidence);
  const hasConfidence = Number.isFinite(confidence) && confidence > 0;
  $('confidence').textContent = hasConfidence
    ? `${Math.round(confidence * 100)}% 置信度`
    : '—';
  $('confBar').style.width = hasConfidence ? `${Math.max(2, Math.round(confidence * 100))}%` : '0%';

  const state = decision?.state || 'unknown';
  const chip = $('stateChip');
  chip.dataset.state = state;
  chip.textContent = STATE_LABEL[state] || '未知';

  let reason = decision?.reason || decision?.observation || '';
  if (!runtime?.running && runtime?.pausedReason) reason = runtime.pausedReason;
  if (!reason && runtime?.lastError) reason = runtime.lastError;
  if (!reason) reason = '启动后，AI 会在这里解释它看到了什么。';
  $('reason').textContent = reason;

  const quiz = decision?.quiz;
  const line = $('quizLine');
  if (quiz?.detected) {
    line.classList.remove('hidden');
    line.replaceChildren();
    const label = document.createElement('strong');
    label.textContent = '答题：';
    line.append(label, document.createTextNode(quiz.question || '已识别答题界面'));
    if (quiz.answerSummary) {
      line.append(document.createTextNode(` · 答案：${quiz.answerSummary}`));
    }
    if (quiz.correct === true) line.append(document.createTextNode(' · 已答对'));
    if (quiz.correct === false) line.append(document.createTextNode(' · 答错，继续重试'));
  } else {
    line.classList.add('hidden');
  }

  const healLine = $('selfHealLine');
  const heal = runtime?.lastSelfHeal;
  if (heal?.message) {
    healLine.classList.remove('hidden');
    healLine.textContent = `自诊断：${heal.message}`;
  } else {
    healLine.classList.add('hidden');
  }
}

function renderLog(runtime) {
  const list = $('logList');
  const history = Array.isArray(runtime?.history) ? runtime.history.slice(-4).reverse() : [];
  if (!history.length) {
    list.innerHTML = '<p class="muted">暂无记录</p>';
    return;
  }
  list.replaceChildren();
  for (const item of history) {
    const row = document.createElement('div');
    row.className = 'log-item';

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = formatClock(item.at);

    const text = document.createElement('span');
    text.className = 'log-text';
    const action = Array.isArray(item.actions) && item.actions.length
      ? item.actions.join(' → ')
      : '无动作';
    text.textContent = `${STATE_LABEL[item.state] || item.state || '未知'} · ${action}`;
    if (item.result) {
      const result = document.createElement('em');
      result.textContent = ` · ${String(item.result).slice(0, 46)}`;
      text.append(result);
    }
    row.append(time, text);
    list.append(row);
  }
}

function renderSettings(settings) {
  $('interval').textContent = `${settings?.intervalSeconds || 45}s`;
  const needsSetup = !settings?.hasApiKey;
  $('setupBanner').classList.toggle('hidden', !needsSetup);
}

function render(state) {
  latest = state;
  renderStatus(state.runtime);
  renderTarget(state.runtime);
  renderDecision(state.runtime);
  renderLog(state.runtime);
  renderSettings(state.settings);
}

async function refreshShot(info) {
  if (!info?.at) {
    lastShotAt = 0;
    renderScreenshot(null);
    return;
  }
  if (info.at === lastShotAt || shotLoading) return;
  shotLoading = true;
  try {
    const response = await send({ type: 'FF_GET_SHOT' });
    if (response.lastShot) {
      lastShotAt = response.lastShot.at || info.at;
      renderScreenshot(response.lastShot);
    }
  } finally {
    shotLoading = false;
  }
}

async function refresh() {
  try {
    const state = await send({ type: 'FF_STATUS' });
    render(state);
    await refreshShot(state.lastShotInfo);
  } catch (error) {
    showToast(String(error?.message || error));
  }
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to execCommand
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copyDiagnostics() {
  const button = $('diagBtn');
  const runtime = latest?.runtime;
  const tabId = runtime?.running
    ? runtime.targetTabId
    : (activeTab?.id || runtime?.targetTabId);
  if (!tabId) {
    showToast('找不到课程标签页，请先打开课程页。');
    return;
  }

  button.disabled = true;
  button.textContent = '收集中…';
  try {
    const response = await send({ type: 'FF_DIAGNOSTICS', tabId });
    const text = JSON.stringify(response.diagnostics, null, 2);
    const copied = await copyText(text);
    if (!copied) {
      downloadText(text, 'focusflow-diagnostics.json');
      showToast('剪贴板不可用，已下载诊断 JSON');
    } else {
      showToast('诊断信息已复制，请直接粘贴给开发者');
    }
  } catch (error) {
    showToast(String(error?.message || error));
  } finally {
    button.disabled = false;
    button.textContent = '复制页面诊断';
  }
}

async function startOrStop() {
  if (busy) return;
  busy = true;
  let started = false;
  renderStatus(latest?.runtime);
  try {
    const runtime = latest?.runtime;
    if (runtime?.running) {
      await send({ type: 'FF_STOP' });
      showToast('已停止自动观看');
    } else {
      let tabId = runtime?.targetTabId || activeTab?.id;
      if (tabId) {
        try {
          await chrome.tabs.get(tabId);
        } catch {
          tabId = activeTab?.id;
        }
      }
      if (!tabId) throw new Error('找不到可用的课程标签页。');
      const response = await send({ type: 'FF_START', tabId });
      latest = { ...(latest || {}), runtime: response.runtime };
      started = true;
      showToast('已启动，弹窗即将关闭以保持视频焦点');
    }
    await refresh();
  } catch (error) {
    showToast(String(error?.message || error));
  } finally {
    busy = false;
    renderStatus(latest?.runtime);
    if (started) {
      setTimeout(() => window.close(), 320);
    }
  }
}

async function analyzeNow() {
  if (busy) return;
  busy = true;
  renderStatus(latest?.runtime);
  try {
    await send({ type: 'FF_ANALYZE_NOW' });
    showToast('已请求立即分析');
    setTimeout(refresh, 600);
  } catch (error) {
    showToast(String(error?.message || error));
  } finally {
    busy = false;
    renderStatus(latest?.runtime);
  }
}

async function focusTarget() {
  try {
    if (latest?.runtime?.targetTabId) {
      await send({ type: 'FF_OPEN_TARGET' });
    } else if (activeTab?.id) {
      await chrome.tabs.update(activeTab.id, { active: true });
      if (activeTab.windowId) await chrome.windows.update(activeTab.windowId, { focused: true });
    }
    window.close();
  } catch (error) {
    showToast(String(error?.message || error));
  }
}

function openOptions() {
  chrome.runtime.openOptionsPage();
}

function openLightbox() {
  if (!lastShotUrl) return;
  $('lightboxImage').src = lastShotUrl;
  $('lightbox').classList.remove('hidden');
}

function bind() {
  $('primaryBtn').addEventListener('click', startOrStop);
  $('analyzeBtn').addEventListener('click', analyzeNow);
  $('diagBtn').addEventListener('click', copyDiagnostics);
  $('focusBtn').addEventListener('click', focusTarget);
  $('setupBtn').addEventListener('click', openOptions);
  $('optionsBtn').addEventListener('click', openOptions);
  $('shotImage').addEventListener('click', openLightbox);
  $('lightboxClose').addEventListener('click', () => $('lightbox').classList.add('hidden'));
  $('lightbox').addEventListener('click', (event) => {
    if (event.target === $('lightbox')) $('lightbox').classList.add('hidden');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') $('lightbox').classList.add('hidden');
  });
}

async function init() {
  bind();
  activeTab = await getActiveTab();
  await refresh();
  pollTimer = setInterval(() => {
    if (!document.hidden) refresh();
  }, 1200);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

window.addEventListener('unload', () => {
  if (pollTimer) clearInterval(pollTimer);
});

init();
