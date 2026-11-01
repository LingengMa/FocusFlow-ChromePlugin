import { ProtocolError, parseModelResponse, truncate } from '../shared/ai-protocol.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';

// 64x64 PNG, used by the "test connection" button to verify vision input.
const TEST_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAlUlEQVR4nO3aoRGEUAAD0WUHj6M4CqQ4HBV8KkCdgL3h2ZjMxGYaY1AmcRIncRIncRIncfNdsOwHL3Nu6x8uIHESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3HTd3x9mMRJnMRJnE8X+NUFGKMJe3D10GkAAAAASUVORK5CYII=';

export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status || 0;
    this.code = options.code || '';
    this.retryable = Boolean(options.retryable);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chatEndpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

function extractMessageContent(payload) {
  const message = payload?.choices?.[0]?.message;
  let content = message?.content;
  if (Array.isArray(content)) {
    content = content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('');
  }
  if (!content && typeof message?.reasoning_content === 'string') {
    content = message.reasoning_content;
  }
  return String(content || '').trim();
}

function normalizeUsage(usage) {
  return {
    input: Number(usage?.prompt_tokens) || 0,
    output: Number(usage?.completion_tokens) || 0,
    total: Number(usage?.total_tokens) ||
      (Number(usage?.prompt_tokens) || 0) + (Number(usage?.completion_tokens) || 0)
  };
}

function friendlyHttpError(status, detail) {
  if (status === 401) return 'API Key 无效或已过期（401）。请到设置中检查 Key。';
  if (status === 403) return 'API 拒绝访问（403）。请检查 Key 权限、模型名或账户余额。';
  if (status === 404) return '接口地址或模型不存在（404）。请检查 Base URL 和模型名。';
  if (status === 429) return 'API 请求过于频繁或额度不足（429）。稍后会自动重试。';
  if (status >= 500) return `模型服务暂时不可用（${status}）。稍后会自动重试。`;
  return `模型请求失败（${status}）：${truncate(detail, 300)}`;
}

async function parseErrorResponse(response) {
  const text = await response.text().catch(() => '');
  let detail = text;
  try {
    const json = JSON.parse(text);
    detail = json?.error?.message || json?.message || text;
  } catch {
    // keep raw text
  }
  return truncate(detail, 500);
}

async function rawChatRequest({ settings, messages, maxTokens = 1000, temperature = 0.1, jsonMode = true }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.requestTimeoutSeconds * 1000);
  const started = Date.now();
  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

  const body = {
    model: settings.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  try {
    const response = await fetch(chatEndpoint(settings.apiBaseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const detail = await parseErrorResponse(response);
      throw new ApiError(friendlyHttpError(response.status, detail), {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500
      });
    }

    const payload = await response.json();
    const content = extractMessageContent(payload);
    if (!content) {
      throw new ApiError('模型返回了空内容。', { retryable: true });
    }
    return {
      content,
      payload,
      usage: normalizeUsage(payload.usage),
      latencyMs: Date.now() - started,
      requestId: response.headers.get('x-request-id') || payload.id || ''
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new ApiError(`模型请求超过 ${settings.requestTimeoutSeconds} 秒未返回。`, {
        retryable: true
      });
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError(`网络请求失败：${truncate(error?.message || error, 300)}`, {
      retryable: true
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestWithRetry(options) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await rawChatRequest(options);
    } catch (error) {
      lastError = error;
      if (!(error instanceof ApiError) || !error.retryable || attempt === 2) break;
      await sleep(1200 * (attempt + 1));
    }
  }
  throw lastError;
}

async function requestWithJsonFallback(options) {
  try {
    return await requestWithRetry({ ...options, jsonMode: true });
  } catch (error) {
    // Some OpenAI-compatible gateways reject response_format with 400.
    if (error instanceof ApiError && error.status === 400) {
      return requestWithRetry({ ...options, jsonMode: false });
    }
    throw error;
  }
}

function buildUserMessage({ snapshot, runtime, settings, screenshotDataUrl, siteMemory }) {
  const text = buildUserPrompt({ snapshot, runtime, settings, siteMemory });
  return [
    { type: 'text', text },
    {
      type: 'image_url',
      image_url: {
        url: screenshotDataUrl,
        detail: 'high'
      }
    }
  ];
}

export async function analyzeWithAI({ settings, snapshot, screenshotDataUrl, runtime, siteMemory }) {
  const messages = [
    { role: 'system', content: buildSystemPrompt(settings) },
    {
      role: 'user',
      content: buildUserMessage({ snapshot, runtime, settings, screenshotDataUrl, siteMemory })
    }
  ];

  let response = await requestWithJsonFallback({ settings, messages, maxTokens: 1100 });
  let usage = response.usage;
  let repaired = false;
  let decision;

  try {
    decision = parseModelResponse(response.content, { maxActions: settings.maxActions });
  } catch (error) {
    if (!(error instanceof ProtocolError) || repaired) {
      error.rawContent = response?.content || '';
      error.requestId = response?.requestId || '';
      throw error;
    }
    repaired = true;
    const repairMessages = [
      ...messages,
      { role: 'assistant', content: truncate(response.content, 4000) },
      {
        role: 'user',
        content: '上一条输出不是合法 JSON。请严格按系统提示的 JSON 结构重新输出；只输出 JSON，不要 Markdown 或解释。'
      }
    ];
    const repair = await requestWithJsonFallback({
      settings,
      messages: repairMessages,
      maxTokens: 900,
      temperature: 0
    });
    usage = {
      input: usage.input + repair.usage.input,
      output: usage.output + repair.usage.output,
      total: usage.total + repair.usage.total
    };
    response = { ...repair, latencyMs: response.latencyMs + repair.latencyMs };
    try {
      decision = parseModelResponse(repair.content, { maxActions: settings.maxActions });
    } catch (repairError) {
      repairError.rawContent = repair.content || '';
      repairError.requestId = repair.requestId || '';
      throw repairError;
    }
  }

  return {
    decision,
    content: response.content,
    usage,
    latencyMs: response.latencyMs,
    model: settings.model,
    requestId: response.requestId,
    repaired
  };
}

export async function testConnection(settings) {
  const messages = [
    {
      role: 'system',
      content: '你是接口连通性测试。只回复 OK。'
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张图是什么颜色？只回复 OK。' },
        { type: 'image_url', image_url: { url: TEST_IMAGE, detail: 'low' } }
      ]
    }
  ];
  const response = await requestWithRetry({
    settings,
    messages,
    maxTokens: 16,
    temperature: 0,
    jsonMode: false
  });
  return {
    ok: true,
    model: settings.model,
    endpoint: chatEndpoint(settings.apiBaseUrl),
    latencyMs: response.latencyMs,
    reply: truncate(response.content, 120),
    usage: response.usage
  };
}
