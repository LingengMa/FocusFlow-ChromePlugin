/**
 * Parsing and validation for the model's JSON decision protocol.
 * Pure module: no chrome.* or DOM access, so it can be tested with node:test.
 */

export const STATES = Object.freeze([
  'playing',
  'paused',
  'buffering',
  'quiz',
  'ended',
  'loading',
  'unknown'
]);

export const ACTION_TYPES = Object.freeze([
  'play',
  'pause',
  'seek',
  'click',
  'choose',
  'type',
  'submit',
  'next',
  'click_at',
  'type_at',
  'scroll_at',
  'ask_user',
  'wait'
]);

const ALIASES = Object.freeze({
  play_video: 'play',
  resume: 'play',
  resume_video: 'play',
  continue: 'play',
  play: 'play',
  pause_video: 'pause',
  pause: 'pause',
  seek_to: 'seek',
  seek: 'seek',
  click_element: 'click',
  tap: 'click',
  click: 'click',
  click_point: 'click_at',
  click_at: 'click_at',
  tap_at: 'click_at',
  type_at: 'type_at',
  fill_at: 'type_at',
  scroll: 'scroll_at',
  wheel: 'scroll_at',
  scroll_at: 'scroll_at',
  scroll_sidebar: 'scroll_at',
  swipe: 'scroll_at',
  select: 'choose',
  select_option: 'choose',
  select_answer: 'choose',
  answer: 'choose',
  answer_question: 'choose',
  choose: 'choose',
  fill: 'type',
  fill_input: 'type',
  type_text: 'type',
  input: 'type',
  type: 'type',
  submit_answer: 'submit',
  submit_quiz: 'submit',
  confirm: 'submit',
  submit: 'submit',
  next_video: 'next',
  next_lesson: 'next',
  advance: 'next',
  next: 'next',
  ask: 'ask_user',
  ask_human: 'ask_user',
  need_help: 'ask_user',
  ask_user: 'ask_user',
  sleep: 'wait',
  wait_for: 'wait',
  wait: 'wait'
});

const ELEMENT_ID_RE = /^(?:f\d+:)?e\d+$/;

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export function truncate(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'string' && value.trim().endsWith('%')
    ? Number.parseFloat(value) / 100
    : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function parseConfidence(value) {
  let n = typeof value === 'string' && value.trim().endsWith('%')
    ? Number.parseFloat(value) / 100
    : Number(value);
  if (!Number.isFinite(n)) return 0;
  // Tolerate models that answer "92" instead of "0.92".
  if (n > 1 && n <= 100) n /= 100;
  n = Math.min(1, Math.max(0, n));
  return Math.round(n * 1000) / 1000;
}

function normalizeTriBool(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', 'correct', '1'].includes(normalized)) return true;
    if (['false', 'no', 'wrong', 'incorrect', '0'].includes(normalized)) return false;
    if (/错误|答错|不正确|未通过|重试/.test(normalized)) return false;
    if (/正确|答对|通过/.test(normalized)) return true;
  }
  return null;
}

function normalizeState(value) {
  const state = String(value || '').trim().toLowerCase();
  if (STATES.includes(state)) return state;
  if (/play|watch|running/.test(state)) return 'playing';
  if (/pause|stop/.test(state)) return 'paused';
  if (/buffer|loading|wait/.test(state)) return 'buffering';
  if (/quiz|question|exam|test|答题|测验/.test(state)) return 'quiz';
  if (/end|finish|complete|结束/.test(state)) return 'ended';
  return 'unknown';
}

function normalizeElementId(value) {
  const id = String(value || '').trim();
  return ELEMENT_ID_RE.test(id) ? id : '';
}

function normalizeBbox(raw, warnings) {
  let values;
  if (Array.isArray(raw.bbox) && raw.bbox.length >= 4) {
    values = raw.bbox.slice(0, 4);
  } else if (Array.isArray(raw.point) && raw.point.length >= 2) {
    values = [raw.point[0], raw.point[1], raw.point[0], raw.point[1]];
  } else {
    values = [raw.x, raw.y, raw.x, raw.y];
  }

  const numbers = values.map(Number);
  if (numbers.some((value) => !Number.isFinite(value))) {
    warnings.push('click_at 缺少有效坐标，已忽略。');
    return null;
  }

  // Models sometimes answer 42,55 instead of 0.42,0.55. Treat a coordinate
  // system where every component is >1 and <=100 as percentages.
  const normalized = numbers.every((value) => value >= 0 && value <= 1)
    ? numbers
    : numbers.every((value) => value >= 0 && value <= 100) && numbers.some((value) => value > 1)
      ? numbers.map((value) => value / 100)
      : null;
  if (!normalized || normalized.some((value) => value < 0 || value > 1)) {
    warnings.push('click_at 坐标必须是 0–1 的归一化值，已忽略。');
    return null;
  }

  let [x1, y1, x2, y2] = normalized;
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  if (x2 - x1 < 0.002) {
    x1 = Math.max(0, x1 - 0.004);
    x2 = Math.min(1, x2 + 0.004);
  }
  if (y2 - y1 < 0.002) {
    y1 = Math.max(0, y1 - 0.004);
    y2 = Math.min(1, y2 + 0.004);
  }

  return {
    bbox: [
      Math.round(x1 * 10000) / 10000,
      Math.round(y1 * 10000) / 10000,
      Math.round(x2 * 10000) / 10000,
      Math.round(y2 * 10000) / 10000
    ],
    x: Math.round(((x1 + x2) / 2) * 10000) / 10000,
    y: Math.round(((y1 + y2) / 2) * 10000) / 10000
  };
}

function balancedObjects(text) {
  const out = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, index + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return out;
}

function sanitizeJson(candidate) {
  return String(candidate || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
}

function objectFromText(text) {
  const input = String(text || '').trim();
  if (!input) throw new ProtocolError('模型返回为空。');

  const cleaned = sanitizeJson(input);
  const candidates = [cleaned, ...balancedObjects(cleaned).reverse()];
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(cleaned.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(sanitizeJson(candidate));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  throw new ProtocolError('模型返回不是合法 JSON。');
}

function unwrapDecision(value) {
  let parsed = value;
  if (typeof parsed === 'string') parsed = objectFromText(parsed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProtocolError('模型返回的对象格式不正确。');
  }
  if (parsed.decision && typeof parsed.decision === 'object' && !Array.isArray(parsed.decision)) {
    parsed = parsed.decision;
  }
  if (parsed.action && !parsed.actions) {
    parsed = { ...parsed, actions: [parsed.action] };
  }
  return parsed;
}

function normalizeAction(raw, index, warnings) {
  if (typeof raw === 'string') raw = { type: raw };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`动作 ${index + 1} 不是对象，已忽略。`);
    return null;
  }

  const typeKey = String(raw.type || raw.action || raw.name || '').trim().toLowerCase();
  const type = ALIASES[typeKey];
  if (!type) {
    warnings.push(`未知动作 "${typeKey || '?'}"，已忽略。`);
    return null;
  }

  switch (type) {
    case 'play':
    case 'pause':
      return { type };
    case 'seek': {
      const seconds = clampNumber(raw.seconds ?? raw.time ?? raw.position, 0, 86400, NaN);
      if (!Number.isFinite(seconds)) {
        warnings.push('seek 缺少有效秒数，已忽略。');
        return null;
      }
      return { type, seconds: Math.round(seconds * 10) / 10 };
    }
    case 'click':
    case 'choose': {
      const elementId = normalizeElementId(raw.elementId ?? raw.element ?? raw.target);
      if (!elementId) {
        warnings.push(`${type} 缺少有效 elementId，已忽略。`);
        return null;
      }
      return { type, elementId };
    }
    case 'type': {
      const elementId = normalizeElementId(raw.elementId ?? raw.element ?? raw.target);
      const text = truncate(raw.text ?? raw.value ?? raw.answer, 500);
      if (!elementId || !text) {
        warnings.push('type 缺少 elementId 或文本，已忽略。');
        return null;
      }
      return { type, elementId, text };
    }
    case 'submit':
    case 'next': {
      const elementId = normalizeElementId(raw.elementId ?? raw.element ?? raw.target);
      return elementId ? { type, elementId } : { type };
    }
    case 'click_at': {
      const bbox = normalizeBbox(raw, warnings);
      const target = truncate(raw.target ?? raw.label ?? raw.description ?? raw.name, 100);
      if (!bbox) return null;
      if (!target) {
        warnings.push('click_at 缺少 target 描述，已忽略。');
        return null;
      }
      return { type, ...bbox, target };
    }
    case 'type_at': {
      const bbox = normalizeBbox(raw, warnings);
      const target = truncate(raw.target ?? raw.label ?? raw.description ?? raw.name, 100);
      const text = truncate(raw.text ?? raw.value ?? raw.answer, 500);
      if (!bbox) return null;
      if (!target || !text) {
        warnings.push('type_at 缺少 target 或文本，已忽略。');
        return null;
      }
      return { type, ...bbox, target, text };
    }
    case 'scroll_at': {
      const bbox = normalizeBbox(raw, warnings);
      const target = truncate(raw.target ?? raw.label ?? raw.description ?? raw.name, 100);
      const deltaY = clampNumber(raw.deltaY ?? raw.dy ?? raw.scrollY, -2000, 2000, 600);
      if (!bbox) return null;
      if (!target) {
        warnings.push('scroll_at 缺少 target 描述，已忽略。');
        return null;
      }
      return { type, ...bbox, target, deltaY: Math.round(deltaY) };
    }
    case 'ask_user': {
      const message = truncate(raw.message ?? raw.text ?? raw.reason, 300) ||
        '需要你确认后继续。';
      return { type, message };
    }
    case 'wait': {
      const seconds = clampNumber(raw.seconds ?? raw.time, 1, 30, 10);
      return { type, seconds: Math.round(seconds * 10) / 10 };
    }
    default:
      return null;
  }
}

/**
 * Normalizes the model output into the extension's internal decision shape.
 * Unknown actions are dropped with a warning rather than failing the whole cycle.
 */
export function normalizeDecision(raw, options = {}) {
  const maxActions = Math.max(1, Math.min(8, Number(options.maxActions) || 4));
  const parsed = unwrapDecision(raw);
  const warnings = [];

  const rawActions = Array.isArray(parsed.actions)
    ? parsed.actions
    : parsed.actions == null
      ? []
      : [parsed.actions];
  const actions = [];
  for (let i = 0; i < rawActions.length; i += 1) {
    const action = normalizeAction(rawActions[i], i, warnings);
    if (action) actions.push(action);
  }
  if (actions.length > maxActions) {
    warnings.push(`动作数量超过上限 ${maxActions}，多余的已丢弃。`);
    actions.length = maxActions;
  }

  const rawQuiz = parsed.quiz && typeof parsed.quiz === 'object' ? parsed.quiz : {};
  const quiz = {
    detected: Boolean(rawQuiz.detected),
    correct: normalizeTriBool(rawQuiz.correct ?? rawQuiz.isCorrect ?? rawQuiz.result),
    question: truncate(rawQuiz.question ?? rawQuiz.text, 500),
    answerSummary: truncate(rawQuiz.answerSummary ?? rawQuiz.answer, 300),
    feedback: truncate(rawQuiz.feedback ?? rawQuiz.message, 300)
  };

  return {
    observation: truncate(parsed.observation ?? parsed.summary, 300),
    state: normalizeState(parsed.state),
    confidence: parseConfidence(parsed.confidence),
    reason: truncate(parsed.reason ?? parsed.why, 600),
    courseComplete: normalizeTriBool(
      parsed.courseComplete ?? parsed.course_complete ?? parsed.allVideosComplete
    ) === true,
    quiz,
    actions,
    warnings
  };
}

export function parseModelResponse(text, options = {}) {
  return normalizeDecision(text, options);
}

export function actionPermission(action, settings) {
  if (action.type === 'play' || action.type === 'seek') {
    return settings.autoResume ? null : '自动续播已关闭';
  }
  if (action.type === 'choose' || action.type === 'type') {
    return settings.autoAnswer ? null : '自动答题已关闭';
  }
  if (action.type === 'submit') {
    if (!settings.autoAnswer) return '自动答题已关闭';
    if (!settings.autoSubmit) return '自动提交已关闭';
  }
  if (action.type === 'next' && !settings.autoNext) return '自动切换下一节已关闭';
  if (action.type === 'scroll_at' && !settings.autoNext) return '自动切换下一节已关闭';
  return null;
}

export function describeAction(action) {
  switch (action.type) {
    case 'play': return '继续播放';
    case 'pause': return '暂停播放';
    case 'seek': return `跳转到 ${action.seconds}s`;
    case 'click': return '点击页面控件';
    case 'choose': return '选择答案';
    case 'type': return '填写答案';
    case 'submit': return '提交答案';
    case 'next': return '切换下一节';
    case 'click_at': return `点击“${action.target || '视觉目标'}”`;
    case 'type_at': return `在“${action.target || '视觉输入框'}”填写`;
    case 'scroll_at': return `滚动“${action.target || '视觉区域'}” ${action.deltaY || 0}px`;
    case 'ask_user': return '请求人工确认';
    case 'wait': return `等待 ${action.seconds}s`;
    default: return action.type;
  }
}
