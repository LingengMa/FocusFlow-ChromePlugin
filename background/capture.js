const MIN_CAPTURE_GAP_MS = 1100;
let lastCaptureAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function blobToDataUrl(blob) {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode(...buffer.subarray(i, i + chunk));
  }
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
}

async function decodeDataUrl(dataUrl) {
  const response = await fetch(dataUrl);
  if (!response.ok) throw new Error('无法读取截图数据。');
  return response.blob();
}

async function downscale(dataUrl, maxWidth, quality) {
  const blob = await decodeDataUrl(dataUrl);
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxWidth / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    if (scale >= 1) {
      return {
        dataUrl,
        width: bitmap.width,
        height: bitmap.height,
        bytes: blob.size
      };
    }

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('无法创建截图缩放画布。');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return {
      dataUrl: await blobToDataUrl(outBlob),
      width,
      height,
      bytes: outBlob.size
    };
  } finally {
    bitmap.close?.();
  }
}

async function captureRaw(tab, quality) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'jpeg',
        quality
      });
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        await sleep(350);
      }
    }
  }
  const message = String(lastError?.message || lastError || '未知错误');
  if (/active tab|visible|focused|window/i.test(message)) {
    throw new Error('无法截取画面：课程标签页必须处于当前窗口的前台。请让 Chrome 窗口保持可见后重试。');
  }
  throw new Error(`截屏失败：${message}`);
}

/**
 * Captures the visible area of a tab and downscales it for the vision model.
 * The caller is responsible for activating/focusing the tab first.
 */
export async function captureTab(tab, settings) {
  const now = Date.now();
  const wait = Math.max(0, MIN_CAPTURE_GAP_MS - (now - lastCaptureAt));
  if (wait > 0) await sleep(wait);
  lastCaptureAt = Date.now();

  const raw = await captureRaw(tab, settings.jpegQuality);
  try {
    return await downscale(raw, settings.maxImageWidth, settings.jpegQuality);
  } catch {
    return { dataUrl: raw, width: 0, height: 0, bytes: raw.length };
  }
}
