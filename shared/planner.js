/**
 * Turns an AI decision plus a page snapshot into a concrete, permission-checked
 * action plan. Pure module: no chrome.* calls, fully unit-testable.
 */

import { actionPermission, describeAction, truncate } from './ai-protocol.js';

export const DANGEROUS_TEXT_RE = /(删除|退课|退学|注销|支付|付款|购买|下单|充值|退出|返回课程|返回首页|上一节|上一章|上一课|重播|倍速|播放速度|举报|卸载|格式化|清空全部|个人信息授权|同意并授权|下载|分享|跳过|\b(delete|remove|unenroll|drop\s+course|purchase|pay|buy|checkout|log\s*out|sign\s*out|report|uninstall|erase|download|share|skip|back\s+to\s+course|previous|prev|replay|speed)\b)/i;

const NEXT_TEXT_RE = /^(下一[节集课篇个章讲]|下一个(视频|课程|任务点)?|下节|next(\s+(video|lesson))?|continue)/i;
const SUBMIT_TEXT_RE = /^(?:(?:提交|交卷|确定|确认)(?:答案|试卷|作业)?|保存并提交|submit|confirm)/i;
const PLAY_TEXT_RE = /^(播放|继续播放|恢复播放|play|resume)/i;
const QUIZ_TARGET_RE = /(选项|答案|作答|第\s*\d+\s*题|正确|错误|radio|checkbox|option\s*[a-d]|\b[a-d]\s*[.、])/i;

function videoNearEnd(snapshot) {
  const video = snapshot?.video;
  if (!video?.found) return true;
  if (video.ended) return true;
  const duration = Number(video.duration);
  const current = Number(video.currentTime);
  // Duration 0 means metadata has not loaded yet. Do not treat that as "ended";
  // otherwise a first-frame decision could skip a task point.
  if (!(duration > 0) || !Number.isFinite(current)) return false;
  // Keep the last second for platforms that only mark a task point complete
  // when the video reaches its true end.
  return current >= duration - 1;
}

function resolveElement(snapshot, elementId) {
  if (!elementId || !snapshot?.elementIndex) return null;
  const index = snapshot.elementIndex;
  const direct = index.get(elementId);
  if (direct) return direct;
  // Tolerate a model that dropped the frame prefix when the local id is unique.
  if (/^e\d+$/.test(elementId)) {
    const matches = [];
    for (const entry of index.values()) {
      if (entry.localId === elementId) matches.push(entry);
    }
    if (matches.length === 1) return matches[0];
  }
  return null;
}

function elementLabel(entry) {
  return truncate(entry?.label || entry?.text || entry?.ariaLabel || '', 160);
}

function dangerousElement(entry, options = {}) {
  if (!entry) return false;
  if (entry.type === 'password') return true;
  if (entry.tag === 'input' && String(entry.inputType || '').toLowerCase() === 'password') return true;
  if (entry.disabled) return true;
  if (options.ignoreText) return false;
  return DANGEROUS_TEXT_RE.test(elementLabel(entry));
}

function frameForElement(entry, fallback) {
  return Number.isInteger(entry?.frameId) ? entry.frameId : fallback;
}

function needsHuman(message, details = {}) {
  return {
    actions: [],
    halted: true,
    needsUser: true,
    message,
    blocked: details.blocked || [],
    warnings: details.warnings || []
  };
}

function policyMessage(reason, decision) {
  if (/自动答题已关闭/.test(reason)) {
    return '检测到答题界面，但“自动答题”已关闭。请手动作答，或到设置中开启后继续。';
  }
  if (/自动提交已关闭/.test(reason)) {
    const answer = decision.quiz?.answerSummary ? `AI 的建议：${decision.quiz.answerSummary}。` : '';
    return `${answer}答案已选择，但“自动提交”已关闭，请核对后手动提交。`;
  }
  if (/自动切换/.test(reason)) {
    return '视频可能已结束，但“自动切换下一节”已关闭。请手动切换或到设置中开启。';
  }
  if (/自动续播/.test(reason)) {
    return '视频处于暂停状态，但“自动续播”已关闭。';
  }
  return `${reason}，需要你确认后继续。`;
}

/**
 * @param {object} params
 * @param {object} params.decision normalized decision
 * @param {object} params.snapshot merged snapshot with elementIndex Map
 * @param {object} params.settings normalized settings
 */
export function buildActionPlan({ decision, snapshot, settings }) {
  const warnings = [...(decision.warnings || [])];
  const blocked = [];
  const actions = [];
  let haltAfterMessage = '';
  const videoFrame = Number.isInteger(snapshot?.video?.frameId) ? snapshot.video.frameId : 0;
  const quizFrame = Number.isInteger(snapshot?.quiz?.frameId) ? snapshot.quiz.frameId : videoFrame;
  const quizDetected = Boolean(snapshot?.quiz?.detected);
  const standaloneQuiz = Boolean(settings.skipStandaloneQuiz && !snapshot?.video?.found && quizDetected);
  const threshold = Number(settings.confidenceThreshold) || 0.72;

  if (decision.state === 'quiz' && !quizDetected) {
    warnings.push('模型判断为答题状态，但页面结构未检测到答题容器；将按普通页面处理。');
  }

  for (const action of decision.actions || []) {
    if (
      settings.clickMode === 'vision' &&
      ['click', 'choose', 'type', 'submit', 'next', 'play', 'pause'].includes(action.type)
    ) {
      warnings.push('纯视觉模式下已忽略依赖 elementId 的点击动作。');
      continue;
    }
    const permissionError = actionPermission(action, settings);
    if (permissionError) {
      // With auto-submit off we still want to select/fill the answer, then stop
      // before submitting instead of throwing the whole plan away.
      if (action.type === 'submit' && settings.autoAnswer && !settings.autoSubmit) {
        haltAfterMessage = policyMessage(permissionError, decision);
        continue;
      }
      blocked.push(permissionError);
      return needsHuman(policyMessage(permissionError, decision), { blocked, warnings });
    }

    if ((action.type === 'choose' || action.type === 'type' || action.type === 'submit') && !quizDetected) {
      warnings.push(`${describeAction(action)} 被忽略：页面未检测到答题界面。`);
      continue;
    }

    if (action.type === 'choose' || action.type === 'type' || action.type === 'submit') {
      if (decision.confidence < threshold) {
        return needsHuman(
          `AI 对答案的置信度只有 ${Math.round(decision.confidence * 100)}%，低于阈值 ${Math.round(threshold * 100)}%。请手动确认。`,
          { blocked, warnings }
        );
      }
    }

    if (action.type === 'next' && decision.confidence < Math.max(0.5, threshold - 0.2)) {
      return needsHuman(
        `AI 对“下一节”的判断置信度较低（${Math.round(decision.confidence * 100)}%），请手动确认。`,
        { blocked, warnings }
      );
    }

    switch (action.type) {
      case 'play':
      case 'pause': {
        if (!snapshot?.video?.found) {
          warnings.push(`${describeAction(action)} 被忽略：当前画面没有可用视频。`);
          continue;
        }
        if (action.type === 'play' && snapshot.video.ended) {
          warnings.push('视频已经结束，play 已忽略，避免重新播放。');
          continue;
        }
        actions.push({ ...action, frameId: videoFrame });
        break;
      }
      case 'seek': {
        // Platforms with "100% watch / no seeking" task points treat any drag
        // as a violation, so seek is intentionally disabled at the policy layer.
        warnings.push('当前任务点不允许拖拽进度，seek 已忽略。');
        continue;
      }
      case 'click': {
        const entry = resolveElement(snapshot, action.elementId);
        if (!entry) {
          warnings.push(`找不到元素 ${action.elementId}，点击已忽略。`);
          continue;
        }
        // Answer options may legitimately contain words like “删除” (for
        // example, a quiz about safe operations); selecting them is harmless.
        if (dangerousElement(entry, { ignoreText: entry.group === 'quiz' })) {
          warnings.push(`元素“${elementLabel(entry)}”被安全策略禁止点击。`);
          continue;
        }
        if (decision.confidence < 0.5) {
          return needsHuman(
            `AI 想点击“${elementLabel(entry)}”，但置信度只有 ${Math.round(decision.confidence * 100)}%。请确认。`,
            { blocked, warnings }
          );
        }
        const label = elementLabel(entry);
        if (PLAY_TEXT_RE.test(label) && !settings.autoResume) {
          return needsHuman(policyMessage('自动续播已关闭', decision), { blocked, warnings });
        }
        if (NEXT_TEXT_RE.test(label) && !settings.autoNext) {
          return needsHuman(policyMessage('自动切换下一节已关闭', decision), { blocked, warnings });
        }
        if (NEXT_TEXT_RE.test(label) && !videoNearEnd(snapshot)) {
          warnings.push('视频尚未播放完，点击“下一节”已被忽略。');
          continue;
        }
        if (SUBMIT_TEXT_RE.test(label) && (entry.group === 'quiz' || quizDetected)) {
          if (!settings.autoAnswer) {
            return needsHuman(policyMessage('自动答题已关闭', decision), { blocked, warnings });
          }
          if (!settings.autoSubmit) {
            haltAfterMessage = policyMessage('自动提交已关闭', decision);
            continue;
          }
        }
        if (entry.group === 'quiz' && !settings.autoAnswer) {
          return needsHuman(policyMessage('自动答题已关闭', decision), { blocked, warnings });
        }
        actions.push({
          ...action,
          frameId: frameForElement(entry, quizFrame),
          localId: entry.localId,
          elementLabel: label,
          group: entry.group || ''
        });
        break;
      }
      case 'choose': {
        const entry = resolveElement(snapshot, action.elementId);
        if (!entry) {
          warnings.push(`找不到选项 ${action.elementId}，选择已忽略。`);
          continue;
        }
        if (dangerousElement(entry, { ignoreText: true })) {
          warnings.push(`选项“${elementLabel(entry)}”被安全策略禁止点击。`);
          continue;
        }
        if (entry.group !== 'quiz') {
          warnings.push('选项不在答题界面内，选择已忽略。');
          continue;
        }
        actions.push({
          ...action,
          frameId: frameForElement(entry, quizFrame),
          localId: entry.localId,
          elementLabel: elementLabel(entry)
        });
        break;
      }
      case 'type': {
        const entry = resolveElement(snapshot, action.elementId);
        if (!entry) {
          warnings.push(`找不到输入框 ${action.elementId}，填写已忽略。`);
          continue;
        }
        if (entry.group !== 'quiz' || dangerousElement(entry, { ignoreText: true })) {
          warnings.push('输入目标不是答题输入框，填写已忽略。');
          continue;
        }
        actions.push({
          ...action,
          frameId: frameForElement(entry, quizFrame),
          localId: entry.localId
        });
        break;
      }
      case 'submit': {
        const entry = action.elementId ? resolveElement(snapshot, action.elementId) : null;
        if (action.elementId && !entry) {
          warnings.push(`找不到提交按钮 ${action.elementId}，已改用页面内启发式查找。`);
        }
        if (entry && dangerousElement(entry)) {
          warnings.push(`提交按钮“${elementLabel(entry)}”被安全策略禁止点击。`);
          continue;
        }
        actions.push({
          ...action,
          frameId: entry ? frameForElement(entry, quizFrame) : quizFrame,
          localId: entry?.localId || '',
          elementLabel: entry ? elementLabel(entry) : ''
        });
        break;
      }
      case 'next': {
        if (!videoNearEnd(snapshot)) {
          warnings.push('视频尚未播放完，next 已忽略，避免跳过未完成的任务点。');
          continue;
        }
        const entry = action.elementId ? resolveElement(snapshot, action.elementId) : null;
        if (action.elementId && !entry) {
          warnings.push(`找不到“下一节”元素 ${action.elementId}，已改用页面内启发式查找。`);
        }
        if (entry && dangerousElement(entry)) {
          warnings.push(`“${elementLabel(entry)}”被安全策略禁止点击。`);
          continue;
        }
        actions.push({
          ...action,
          frameId: entry ? frameForElement(entry, quizFrame) : quizFrame,
          localId: entry?.localId || '',
          elementLabel: entry ? elementLabel(entry) : ''
        });
        break;
      }
      case 'click_at': {
        if (settings.clickMode === 'dom') {
          warnings.push('当前为 DOM 点击模式，视觉坐标点击已忽略。');
          continue;
        }
        const target = action.target;
        if (DANGEROUS_TEXT_RE.test(target)) {
          warnings.push(`视觉目标“${target}”被安全策略禁止点击。`);
          continue;
        }
        const isPlay = /播放|play|resume/i.test(target);
        const isNext = /下一[节集课篇个章讲]|下一个|next|继续学习|目录|章节|^\d+(?:\.\d+)+\s+\S|第\s*\d+(?:\.\d+)+/i.test(target);
        const isSubmit = /提交|交卷|确定|确认|submit|confirm/i.test(target);
        const isAnswer = QUIZ_TARGET_RE.test(target);
        const quizDetected = Boolean(snapshot?.quiz?.detected);

        if (standaloneQuiz && (isSubmit || isAnswer)) {
          warnings.push('当前是独立章节测验，按“仅播放视频节”策略跳过，不执行答题。');
          continue;
        }

        if (isPlay && !settings.autoResume) {
          return needsHuman(policyMessage('自动续播已关闭', decision), { blocked, warnings });
        }
        if (isPlay && snapshot.video?.ended) {
          warnings.push('视频已经结束，视觉播放点击已忽略。');
          continue;
        }
        if (isNext && !settings.autoNext) {
          return needsHuman(policyMessage('自动切换下一节已关闭', decision), { blocked, warnings });
        }
        if (isNext && !videoNearEnd(snapshot)) {
          warnings.push('视频尚未播放完，视觉“下一节”点击已忽略。');
          continue;
        }
        if (quizDetected && /关闭|取消|跳过/.test(target)) {
          warnings.push('答题界面存在时不允许通过视觉点击关闭答题。');
          continue;
        }
        if (isSubmit && !quizDetected && /提交答案|交卷|试卷|submit|保存并提交/i.test(target)) {
          warnings.push('未检测到答题界面，视觉“提交答案”点击已忽略。');
          continue;
        }
        if (isSubmit && quizDetected) {
          if (!settings.autoAnswer) {
            return needsHuman(policyMessage('自动答题已关闭', decision), { blocked, warnings });
          }
          if (decision.confidence < threshold) {
            return needsHuman(
              `AI 对“提交”的置信度只有 ${Math.round(decision.confidence * 100)}%，低于阈值。请手动确认。`,
              { blocked, warnings }
            );
          }
          if (!settings.autoSubmit) {
            haltAfterMessage = policyMessage('自动提交已关闭', decision);
            continue;
          }
        } else if (isAnswer || (quizDetected && !isPlay && !isNext)) {
          if (!settings.autoAnswer) {
            return needsHuman(policyMessage('自动答题已关闭', decision), { blocked, warnings });
          }
          if (!quizDetected) {
            warnings.push('未检测到答题界面，视觉答案点击已忽略。');
            continue;
          }
          if (decision.confidence < threshold) {
            return needsHuman(
              `AI 对答案的置信度只有 ${Math.round(decision.confidence * 100)}%，低于阈值。请手动确认。`,
              { blocked, warnings }
            );
          }
        } else if (decision.confidence < 0.5) {
          return needsHuman(
            `AI 对视觉点击“${target}”的置信度只有 ${Math.round(decision.confidence * 100)}%。请确认。`,
            { blocked, warnings }
          );
        }

        actions.push({ ...action });
        break;
      }
      case 'type_at': {
        if (settings.clickMode === 'dom') {
          warnings.push('当前为 DOM 点击模式，视觉坐标输入已忽略。');
          continue;
        }
        if (standaloneQuiz) {
          warnings.push('当前是独立章节测验，跳过输入答案。');
          continue;
        }
        if (DANGEROUS_TEXT_RE.test(action.target)) {
          warnings.push(`视觉输入目标“${action.target}”被安全策略禁止。`);
          continue;
        }
        if (!snapshot?.quiz?.detected) {
          warnings.push('未检测到答题界面，视觉输入已忽略。');
          continue;
        }
        if (!settings.autoAnswer) {
          return needsHuman(policyMessage('自动答题已关闭', decision), { blocked, warnings });
        }
        if (decision.confidence < threshold) {
          return needsHuman(
            `AI 对答案的置信度只有 ${Math.round(decision.confidence * 100)}%，低于阈值。请手动确认。`,
            { blocked, warnings }
          );
        }
        actions.push({ ...action });
        break;
      }
      case 'scroll_at': {
        if (snapshot?.video?.found && !videoNearEnd(snapshot)) {
          warnings.push('视频尚未播放完，目录滚动已忽略。');
          continue;
        }
        if (!settings.autoNext) {
          return needsHuman(policyMessage('自动切换下一节已关闭', decision), { blocked, warnings });
        }
        if (decision.confidence < 0.4) {
          return needsHuman(
            `AI 对滚动“${action.target}”的置信度只有 ${Math.round(decision.confidence * 100)}%。请确认。`,
            { blocked, warnings }
          );
        }
        actions.push({ ...action });
        break;
      }
      case 'ask_user':
        return needsHuman(action.message || 'AI 请求你确认后继续。', { blocked, warnings });
      case 'wait':
        actions.push({ ...action });
        break;
      default:
        warnings.push(`未知动作 ${action.type}，已忽略。`);
    }
  }

  return {
    actions: actions.slice(0, settings.maxActions),
    halted: Boolean(haltAfterMessage),
    needsUser: false,
    haltAfterMessage,
    message: '',
    blocked,
    warnings
  };
}

export function summarizePlan(plan) {
  if (!plan) return '';
  if (plan.needsUser) return plan.message || '需要人工确认';
  const summary = plan.actions.length
    ? plan.actions.map((action) => describeAction(action)).join(' → ')
    : '保持观看';
  if (plan.haltAfterMessage) {
    return plan.actions.length ? `${summary} → 等待你提交` : plan.haltAfterMessage;
  }
  return summary;
}
