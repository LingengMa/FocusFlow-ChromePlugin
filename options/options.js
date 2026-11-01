import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  normalizeSettings
} from '../shared/defaults.js';

const $ = (id) => document.getElementById(id);

const TEXT_FIELDS = [
  'apiBaseUrl',
  'model',
  'apiKey',
  'requestTimeoutSeconds',
  'intervalSeconds',
  'maxRuntimeMinutes',
  'quizVerifySeconds',
  'maxActions',
  'maxImageWidth',
  'jpegQuality',
  'clickMode'
];

const TOGGLES = [
  'autoResume',
  'autoAnswer',
  'autoSubmit',
  'autoNext',
  'focusTarget',
  'hud',
  'dryRun',
  'autoStart',
  'selfHeal'
];

let dirty = false;
let toastTimer = null;
let runtimeTimer = null;

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response) throw new Error('扩展后台没有响应，请重新加载扩展。');
  if (!response.ok) throw new Error(response.error || '操作失败。');
  return response;
}

function showToast(message, bad = false) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.toggle('bad', bad);
  toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 5000);
}

function setSaveState(text, kind = '') {
  for (const id of ['saveState', 'saveStateBottom']) {
    const node = $(id);
    node.textContent = text;
    node.classList.toggle('dirty', kind === 'dirty');
    node.classList.toggle('saved', kind === 'saved');
  }
}

function markDirty() {
  dirty = true;
  setSaveState('有未保存修改', 'dirty');
  $('saveHint').textContent = '修改后记得保存';
}

function markSaved() {
  dirty = false;
  setSaveState('已保存', 'saved');
  $('saveHint').textContent = '设置已生效';
}

function setBadgeForKey() {
  const hasKey = Boolean($('apiKey').value.trim());
  const badge = $('apiBadge');
  badge.textContent = hasKey ? '已配置' : '未配置 Key';
  badge.classList.toggle('ok', hasKey);
  badge.classList.toggle('bad', !hasKey);
}

function updateConfidenceOut() {
  $('confidenceOut').textContent = `${$('confidenceThreshold').value}%`;
}

function fillForm(settings) {
  const normalized = normalizeSettings(settings);
  for (const key of TEXT_FIELDS) {
    const element = $(key);
    if (!element) continue;
    element.value = normalized[key] ?? '';
  }
  $('confidenceThreshold').value = Math.round(normalized.confidenceThreshold * 100);
  updateConfidenceOut();

  for (const key of TOGGLES) {
    const element = $(key);
    if (element) element.checked = Boolean(normalized[key]);
  }
  $('allowedHosts').value = (normalized.allowedHosts || []).join('\n');
  $('extraPrompt').value = normalized.extraPrompt || '';
  $('submitRow').classList.toggle('disabled', !normalized.autoAnswer);
  setBadgeForKey();
}

function readForm() {
  const raw = { ...DEFAULT_SETTINGS };
  for (const key of TEXT_FIELDS) {
    const element = $(key);
    if (!element) continue;
    raw[key] = element.value;
  }
  for (const key of TOGGLES) {
    const element = $(key);
    if (element) raw[key] = element.checked;
  }
  raw.confidenceThreshold = Number($('confidenceThreshold').value) / 100;
  raw.allowedHosts = $('allowedHosts').value;
  raw.extraPrompt = $('extraPrompt').value;
  return normalizeSettings(raw);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const settings = normalizeSettings(stored?.[STORAGE_KEYS.settings] || {});
  fillForm(settings);
  dirty = false;
  setSaveState('已载入');
  $('saveHint').textContent = '修改后记得保存';
  return settings;
}

async function saveSettings({ silent = false } = {}) {
  const buttons = [$('saveTop'), $('saveBottom')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const settings = readForm();
    await send({ type: 'FF_UPDATE_SETTINGS', settings });
    await loadSettings();
    markSaved();
    if (!silent) showToast('设置已保存');
  } catch (error) {
    showToast(String(error?.message || error), true);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function testConnection() {
  const button = $('testBtn');
  const result = $('testResult');
  button.disabled = true;
  button.textContent = '测试中…';
  result.className = 'test-result';
  result.textContent = '正在请求模型…';
  try {
    const settings = readForm();
    const response = await send({ type: 'FF_TEST_API', settings });
    const info = response.result;
    result.className = 'test-result ok';
    result.textContent = `连接成功 · ${info.latencyMs}ms · ${info.model}`;
    showToast(`模型可用：${info.reply || 'OK'}`);
  } catch (error) {
    result.className = 'test-result bad';
    result.textContent = String(error?.message || error).slice(0, 220);
    showToast('连接失败，请检查 Base URL、模型名和 Key', true);
  } finally {
    button.disabled = false;
    button.textContent = '测试连接';
  }
}

async function refreshRuntime() {
  try {
    const response = await send({ type: 'FF_STATUS' });
    const runtime = response.runtime;
    const dot = document.querySelector('.status-line .live-dot');
    if (runtime.running) {
      dot?.classList.add('on');
      $('runtimeLine').textContent = `运行中 · ${runtime.targetTitle || '课程页面'} · ${Math.round((runtime.tokens?.total || 0) / 1000)}k tokens`;
    } else if (runtime.status === 'completed') {
      dot?.classList.remove('on');
      $('runtimeLine').textContent = `已完成 · ${runtime.pausedReason || '所有视频节已完成'}`;
    } else if (runtime.status === 'needs_user') {
      dot?.classList.remove('on');
      $('runtimeLine').textContent = `等待确认 · ${runtime.pausedReason || '请打开扩展查看'}`;
    } else if (runtime.status === 'error') {
      dot?.classList.remove('on');
      $('runtimeLine').textContent = `已暂停 · ${runtime.lastError || runtime.pausedReason || '请打开扩展查看'}`;
    } else {
      dot?.classList.remove('on');
      $('runtimeLine').textContent = '未运行 · 打开课程页后点击扩展图标启动';
    }
  } catch {
    $('runtimeLine').textContent = '扩展后台未就绪';
  }
}

function exportSettings() {
  try {
    const settings = readForm();
    const payload = { ...settings, apiKey: '' };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    anchor.href = url;
    anchor.download = `focusflow-settings-${stamp}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('已导出设置（不含 API Key）');
  } catch (error) {
    showToast(String(error?.message || error), true);
  }
}

async function importSettings(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON 必须是一个对象。');
    }
    const merged = normalizeSettings({ ...DEFAULT_SETTINGS, ...parsed });
    fillForm(merged);
    markDirty();
    showToast('已载入导入的设置，点击保存后生效');
  } catch (error) {
    showToast(`导入失败：${String(error?.message || error)}`, true);
  }
}

async function resetSettings() {
  if (!confirm('确定恢复默认设置吗？API Key 也会被清空。')) return;
  fillForm(DEFAULT_SETTINGS);
  markDirty();
  await saveSettings({ silent: true });
  showToast('已恢复默认设置');
}

function bind() {
  for (const key of [...TEXT_FIELDS, ...TOGGLES]) {
    const element = $(key);
    if (element) element.addEventListener('input', markDirty);
    if (element) element.addEventListener('change', markDirty);
  }
  $('allowedHosts').addEventListener('input', markDirty);
  $('extraPrompt').addEventListener('input', markDirty);
  $('confidenceThreshold').addEventListener('input', () => {
    updateConfidenceOut();
    markDirty();
  });
  $('autoAnswer').addEventListener('change', () => {
    $('submitRow').classList.toggle('disabled', !$('autoAnswer').checked);
  });
  $('apiKey').addEventListener('input', setBadgeForKey);

  $('toggleKey').addEventListener('click', () => {
    const input = $('apiKey');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    $('toggleKey').textContent = showing ? '显示' : '隐藏';
  });

  $('saveTop').addEventListener('click', () => saveSettings());
  $('saveBottom').addEventListener('click', () => saveSettings());
  $('testBtn').addEventListener('click', testConnection);
  $('exportBtn').addEventListener('click', exportSettings);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async () => {
    const file = $('importFile').files?.[0];
    if (file) await importSettings(file);
    $('importFile').value = '';
  });
  $('resetBtn').addEventListener('click', resetSettings);
  $('dismissWelcome').addEventListener('click', () => {
    $('welcome').classList.add('hidden');
    const url = new URL(location.href);
    url.searchParams.delete('welcome');
    history.replaceState(null, '', url);
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveSettings();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEYS.settings] && !dirty) {
      loadSettings();
    }
  });
}

async function init() {
  bind();
  $('aboutVersion').textContent = `v${chrome.runtime.getManifest().version}`;
  await loadSettings();
  if (new URL(location.href).searchParams.get('welcome') === '1') {
    $('welcome').classList.remove('hidden');
  }
  await refreshRuntime();
  runtimeTimer = setInterval(() => {
    if (!document.hidden) refreshRuntime();
  }, 5000);
}

window.addEventListener('unload', () => {
  if (runtimeTimer) clearInterval(runtimeTimer);
});

init().catch((error) => showToast(String(error?.message || error), true));
