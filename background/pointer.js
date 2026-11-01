/**
 * Trusted viewport-coordinate input through the Chrome DevTools Protocol.
 * Falls back to content-script elementFromPoint clicks when DevTools is already
 * attached or the debugger permission is unavailable.
 */

const attachedTabs = new Set();
const persistentTabs = new Set();
const unavailableTabs = new Set();

try {
  chrome.debugger?.onDetach?.addListener((source) => {
    if (Number.isInteger(source?.tabId)) {
      attachedTabs.delete(source.tabId);
      persistentTabs.delete(source.tabId);
      unavailableTabs.add(source.tabId);
    }
  });
} catch {
  // debugger permission may be unavailable in a mock/older runtime
}

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

async function attach(tabId) {
  if (attachedTabs.has(tabId)) return false;
  if (unavailableTabs.has(tabId)) throw new Error('本轮 debugger 不可用，使用 content 坐标点击');
  if (!chrome.debugger?.attach) throw new Error('debugger 权限不可用');
  await chrome.debugger.attach({ tabId }, '1.3');
  attachedTabs.add(tabId);
  return true;
}

/**
 * Attach once for a session containing several vision clicks. Keeping the
 * debugger attached while the screenshot is captured also keeps Chrome's
 * debugger infobar from resizing the viewport between capture and click.
 */
export async function beginPointerSession(tabId, options = {}) {
  // A previous detach may have marked this tab unavailable asynchronously.
  unavailableTabs.delete(tabId);
  try {
    const owned = await attach(tabId);
    if (options.persistent) persistentTabs.add(tabId);
    // Let the browser finish any infobar/layout change before the screenshot.
    if (owned) await sleep(180);
  } catch {
    // Do not attempt to attach again mid-cycle: that would add Chrome's
    // debugger infobar after the screenshot and shift the page layout.
    unavailableTabs.add(tabId);
  }
}

/** Detach after a plan, unless the tab is in a persistent session. */
export async function endPointerSession(tabId) {
  if (persistentTabs.has(tabId)) return;
  if (attachedTabs.has(tabId)) await detach(tabId, true);
}

/** Force-detach at the end of a run (including persistent sessions). */
export async function releasePointerSession(tabId) {
  persistentTabs.delete(tabId);
  unavailableTabs.delete(tabId);
  if (attachedTabs.has(tabId)) await detach(tabId, true);
}

async function detach(tabId, owned) {
  if (!owned) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // The tab may have navigated or DevTools may have detached already.
  } finally {
    attachedTabs.delete(tabId);
  }
}

async function dispatchClick(tabId, x, y) {
  await chrome.debugger.sendCommand(
    { tabId },
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }
  );
  await chrome.debugger.sendCommand(
    { tabId },
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }
  );
  await chrome.debugger.sendCommand(
    { tabId },
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }
  );
}

async function contentClick(tabId, x, y, text) {
  const response = await withTimeout(
    chrome.tabs.sendMessage(
      tabId,
      { type: 'FF_CLICK_POINT', x, y, text: text || '' },
      { frameId: 0 }
    ),
    5000,
    '页面坐标点击'
  );
  if (!response?.ok) {
    throw new Error(response?.error || '页面没有响应坐标点击');
  }
  return response;
}

/**
 * Clicks a CSS-pixel point in the target tab's top-level viewport.
 * @returns {{method: 'debugger'|'content', detail: string, x: number, y: number}}
 */
export async function clickAtPoint(tabId, x, y, options = {}) {
  const text = String(options.text || '').slice(0, 500);
  const px = Math.round(Number(x) || 0);
  const py = Math.round(Number(y) || 0);
  let owned = false;
  let debuggerError = null;

  try {
    owned = await attach(tabId);
    await dispatchClick(tabId, px, py);
    if (text) {
      await sleep(80);
      await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text });
    }
    return {
      method: 'debugger',
      detail: text ? `已点击 (${px},${py}) 并输入文字` : `已点击 (${px},${py})`,
      x: px,
      y: py
    };
  } catch (error) {
    debuggerError = error;
  } finally {
    await detach(tabId, owned);
  }

  try {
    const response = await contentClick(tabId, px, py, text);
    return {
      method: 'content',
      detail: response.detail || `已点击 (${px},${py})`,
      x: px,
      y: py
    };
  } catch (contentError) {
    const debuggerMessage = String(debuggerError?.message || debuggerError || '');
    throw new Error(
      `坐标点击失败：${String(contentError?.message || contentError)}` +
      (debuggerMessage ? `（debugger: ${debuggerMessage}）` : '')
    );
  }
}
