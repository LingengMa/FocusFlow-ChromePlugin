import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, normalizeSettings } from '../shared/defaults.js';
import { ApiError, analyzeWithAI, testConnection } from '../background/ai.js';

function settings(overrides = {}) {
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    apiBaseUrl: 'https://vision.example.test/v1',
    apiKey: 'test-secret',
    model: 'vision-model',
    ...overrides
  });
}

function snapshot() {
  return {
    url: 'https://course.example.test/lesson/1',
    title: '测试课程',
    video: {
      found: true,
      frameId: 0,
      currentTime: 12,
      duration: 300,
      paused: false,
      ended: false,
      buffering: false,
      readyState: 4,
      playbackRate: 1
    },
    quiz: { detected: false, frameId: 0, choices: [], submitCandidates: [] },
    controls: [],
    frames: [{ frameId: 0, isTop: true, pageText: '课程正文' }]
  };
}

function okResponse(content) {
  return new Response(JSON.stringify({
    id: 'req-1',
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' }
  });
}

test('sends an OpenAI-compatible image message and parses the decision', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return okResponse('{"observation":"视频在播放","state":"playing","confidence":0.9,"reason":"正常","actions":[]}');
  };

  try {
    const result = await analyzeWithAI({
      settings: settings(),
      snapshot: snapshot(),
      screenshotDataUrl: 'data:image/jpeg;base64,AAAA',
      runtime: { startedAt: Date.now(), cycleCount: 0, history: [] }
    });

    assert.equal(captured.url, 'https://vision.example.test/v1/chat/completions');
    assert.equal(captured.options.headers.Authorization, 'Bearer test-secret');
    assert.equal(captured.body.model, 'vision-model');
    assert.deepEqual(captured.body.response_format, { type: 'json_object' });
    const userContent = captured.body.messages[1].content;
    assert.equal(userContent[0].type, 'text');
    assert.equal(userContent[1].type, 'image_url');
    assert.equal(userContent[1].image_url.url, 'data:image/jpeg;base64,AAAA');
    assert.equal(result.decision.state, 'playing');
    assert.equal(result.usage.total, 120);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('returns a wait decision instead of throwing on malformed model JSON', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return okResponse('这不是 JSON，只是模型的思考过程。');
  };

  try {
    const result = await analyzeWithAI({
      settings: settings(),
      snapshot: snapshot(),
      screenshotDataUrl: 'data:image/jpeg;base64,AAAA',
      runtime: { startedAt: Date.now(), cycleCount: 0, history: [] }
    });
    assert.equal(calls, 2);
    assert.ok(result.parseError);
    assert.equal(result.decision.actions[0].type, 'wait');
    assert.match(result.decision.reason, /不是合法 JSON/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('retries without response_format when a gateway rejects it', async () => {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (bodies.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'response_format unsupported' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      });
    }
    return okResponse('{"state":"paused","confidence":0.8,"actions":[{"type":"play"}]}');
  };

  try {
    const result = await analyzeWithAI({
      settings: settings(),
      snapshot: snapshot(),
      screenshotDataUrl: 'data:image/jpeg;base64,AAAA',
      runtime: { startedAt: Date.now(), cycleCount: 0, history: [] }
    });
    assert.equal(bodies.length, 2);
    assert.equal('response_format' in bodies[0], true);
    assert.equal('response_format' in bodies[1], false);
    assert.equal(result.decision.actions[0].type, 'play');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('surfaces authentication failures without retrying', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'invalid key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    await assert.rejects(
      () => analyzeWithAI({
        settings: settings(),
        snapshot: snapshot(),
        screenshotDataUrl: 'data:image/jpeg;base64,AAAA',
        runtime: { startedAt: Date.now(), cycleCount: 0, history: [] }
      }),
      (error) => error instanceof ApiError && error.status === 401
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('testConnection sends the small vision probe', async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody;
  globalThis.fetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return okResponse('OK');
  };

  try {
    const result = await testConnection(settings());
    assert.equal(result.ok, true);
    assert.equal(capturedBody.model, 'vision-model');
    assert.equal(capturedBody.messages[1].content[1].type, 'image_url');
    assert.match(capturedBody.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
