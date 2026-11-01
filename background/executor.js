import { describeAction, truncate } from '../shared/ai-protocol.js';
import { clickAtPoint, scrollAtPoint } from './pointer.js';
import { executeActionInFrame } from './tabs.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNavigationError(error) {
  const message = String(error?.message || error || '');
  return /port closed|receiving end|message channel|frame was removed|no tab with id|navigation/i.test(message);
}

function settleDelay(action) {
  if (action.type === 'next') return 1100;
  if (action.type === 'submit') return 1200;
  if (action.type === 'play') return 550;
  if (action.type === 'click_at' || action.type === 'type_at') return 600;
  if (action.type === 'scroll_at') return 500;
  if (action.type === 'choose' || action.type === 'type' || action.type === 'click') return 420;
  return 250;
}

async function executeOne({ action, snapshot, settings, tabId }) {
  if (action.type === 'wait') {
    await sleep(Math.min(30, Math.max(1, Number(action.seconds) || 10)) * 1000);
    return { ok: true, type: action.type, detail: `等待 ${action.seconds}s` };
  }

  if (action.type === 'click_at' || action.type === 'type_at' || action.type === 'scroll_at') {
    const width = Number(snapshot?.viewport?.width);
    const height = Number(snapshot?.viewport?.height);
    if (!(width > 0) || !(height > 0)) {
      throw new Error('缺少页面 viewport，无法把视觉坐标映射到操作位置。');
    }
    const x = Math.min(width - 1, Math.max(0, Math.round(action.x * width)));
    const y = Math.min(height - 1, Math.max(0, Math.round(action.y * height)));
    const result = action.type === 'scroll_at'
      ? await scrollAtPoint(tabId, x, y, action.deltaY)
      : await clickAtPoint(tabId, x, y, {
          text: action.type === 'type_at' ? action.text : ''
        });
    await sleep(settleDelay(action));
    return {
      ok: true,
      type: action.type,
      detail: `${result.detail}（${result.method}）`,
      method: result.method,
      x,
      y
    };
  }

  const frames = [action.frameId];
  // "submit" / "next" may omit an element id. If the quiz lives in an iframe
  // but the submit/next control lives in the top page, try the other frames.
  if (!action.localId && (action.type === 'submit' || action.type === 'next')) {
    const extra = [0, snapshot?.video?.frameId, ...(snapshot?.frames || []).map((frame) => frame.frameId)];
    for (const frameId of extra) {
      if (Number.isInteger(frameId) && !frames.includes(frameId)) frames.push(frameId);
      if (frames.length >= 4) break;
    }
  }

  let lastError;
  for (const frameId of frames) {
    const localAction = { ...action, frameId, localId: action.localId || '' };
    try {
      const response = await executeActionInFrame(tabId, frameId, localAction);
      await sleep(settleDelay(action));
      return {
        ok: true,
        type: action.type,
        detail: truncate(response?.detail || describeAction(action), 200),
        state: response?.state || null
      };
    } catch (error) {
      lastError = error;
      // A click that navigates can close the message port before the content
      // script answers. Treat that as a probable success and verify next cycle.
      if (isNavigationError(error) && ['next', 'submit', 'click'].includes(action.type)) {
        await sleep(900);
        return {
          ok: true,
          type: action.type,
          detail: '页面可能已跳转，下一轮将复核',
          maybeNavigated: true
        };
      }
    }
  }
  throw lastError || new Error('页面操作失败。');
}

export async function executePlan({ plan, snapshot, settings, tabId }) {
  if (!plan) {
    return { ok: true, results: [], summary: '无计划' };
  }
  if (plan.needsUser) {
    return {
      ok: false,
      needsUser: true,
      message: plan.message,
      results: [],
      summary: plan.message
    };
  }
  if (plan.actions.length === 0) {
    return { ok: true, results: [], summary: '保持观看' };
  }

  if (settings.dryRun) {
    const results = plan.actions.map((action) => ({
      ok: true,
      type: action.type,
      dryRun: true,
      detail: `[演示模式] ${describeAction(action)}`
    }));
    return {
      ok: true,
      results,
      summary: results.map((result) => result.detail).join(' → ')
    };
  }

  const results = [];
  for (const action of plan.actions) {
    try {
      const result = await executeOne({ action, snapshot, settings, tabId });
      results.push(result);
    } catch (error) {
      const failed = {
        ok: false,
        type: action.type,
        detail: truncate(error?.message || error, 300)
      };
      results.push(failed);
      const summary = results
        .map((item, index) => {
          const label = describeAction(plan.actions[index] || action);
          return `${label}: ${item.ok ? '成功' : '失败'}`;
        })
        .join('；');
      return {
        ok: false,
        results,
        message: `执行“${describeAction(action)}”失败：${failed.detail}`,
        summary
      };
    }
  }

  return {
    ok: true,
    results,
    summary: results.map((result) => result.detail).join(' → ')
  };
}
