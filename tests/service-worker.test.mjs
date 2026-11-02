import test from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeChromeStub({ quiz = false, ended = false, noVideo = false } = {}) {
  const local = new Map();
  const session = new Map();
  const actionLog = [];
  const debuggerCalls = [];
  const listeners = {
    message: [],
    alarm: [],
    installed: [],
    startup: [],
    tabRemoved: [],
    tabUpdated: [],
    command: [],
    notificationClicked: []
  };

  const tab = {
    id: 1,
    windowId: 1,
    title: '测试课程',
    url: 'https://course.example.test/lesson/1',
    status: 'complete',
    discarded: false
  };

  const snapshot = {
    ok: true,
    url: tab.url,
    title: tab.title,
    isTop: true,
    viewport: { width: 1280, height: 720, dpr: 1 },
    video: {
      found: !noVideo,
      currentTime: ended ? 300 : 12,
      duration: 300,
      paused: quiz || ended,
      ended,
      readyState: 4,
      playbackRate: 1,
      area: 800000,
      rect: { x: 0, y: 0, width: 1000, height: 560 }
    },
    videos: [],
    quiz: quiz
      ? {
          detected: true,
          score: 0.95,
          question: '1 + 1 等于多少？',
          text: '1 + 1 等于多少？ A. 1 B. 2',
          choices: [{ id: 'e1', label: 'B. 2', checked: false }],
          submitCandidates: [{ id: 'e2', label: '提交答案' }]
        }
      : { detected: false, score: 0, choices: [], submitCandidates: [] },
    controls: quiz
      ? [
          {
            id: 'e1',
            tag: 'input',
            type: 'radio',
            label: 'B. 2',
            group: 'quiz',
            checked: false,
            disabled: false,
            rect: { x: 20, y: 20, width: 16, height: 16 }
          },
          {
            id: 'e2',
            tag: 'button',
            type: 'submit',
            label: '提交答案',
            group: 'quiz',
            checked: false,
            disabled: false,
            rect: { x: 40, y: 80, width: 80, height: 30 }
          }
        ]
      : [
          {
            id: 'e9',
            tag: 'button',
            type: 'button',
            label: '页面设置',
            group: 'page',
            checked: false,
            disabled: false,
            rect: { x: 900, y: 20, width: 80, height: 30 }
          }
        ],
    pageText: quiz ? '随堂练习：1 + 1 等于多少？' : '课程视频正在播放。'
  };

  const storageArea = (map) => ({
    async get(keys) {
      if (keys == null) return Object.fromEntries(map);
      if (typeof keys === 'string') return { [keys]: map.get(keys) };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.filter((key) => map.has(key)).map((key) => [key, map.get(key)]));
      }
      return Object.fromEntries(Object.keys(keys).map((key) => [key, map.has(key) ? map.get(key) : keys[key]]));
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) map.set(key, value);
      return undefined;
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) map.delete(key);
    }
  });

  const port = {
    name: 'ff-keepalive',
    onDisconnect: { addListener() {} },
    onMessage: { addListener() {} },
    disconnect() {}
  };

  const chrome = {
    storage: {
      local: storageArea(local),
      session: storageArea(session),
      onChanged: { addListener() {} }
    },
    runtime: {
      onMessage: { addListener(fn) { listeners.message.push(fn); } },
      onInstalled: { addListener(fn) { listeners.installed.push(fn); } },
      onStartup: { addListener(fn) { listeners.startup.push(fn); } },
      getURL: (path) => `chrome-extension://test/${path}`,
      getManifest: () => ({ version: '0.4.1' }),
      openOptionsPage: async () => {},
      sendMessage: async () => ({ ok: true })
    },
    tabs: {
      query: async () => [tab],
      get: async (id) => {
        if (id !== tab.id) throw new Error('No tab with id');
        return { ...tab };
      },
      update: async (id, patch) => Object.assign(tab, patch),
      captureVisibleTab: async () => 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==',
      sendMessage: async (tabId, message) => {
        if (message?.type === 'FF_PING') return { ok: true, url: tab.url, isTop: true };
        if (message?.type === 'FF_SNAPSHOT') return { ok: true, snapshot };
        if (message?.type === 'FF_HUD') return { ok: true };
        if (message?.type === 'FF_EXECUTE_ACTION') {
          actionLog.push(message.action);
          return { ok: true, detail: '测试动作成功', state: snapshot.video };
        }
        return { ok: false, error: `unexpected message ${message?.type}` };
      },
      connect: () => port,
      onRemoved: { addListener(fn) { listeners.tabRemoved.push(fn); } },
      onUpdated: { addListener(fn) { listeners.tabUpdated.push(fn); } },
      onActivated: { addListener() {} }
    },
    debugger: {
      attach: async () => { debuggerCalls.push(['attach']); },
      detach: async () => { debuggerCalls.push(['detach']); },
      sendCommand: async (target, method, params) => {
        debuggerCalls.push(['command', method, params]);
      }
    },
    webNavigation: {
      getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url: tab.url }]
    },
    scripting: {
      insertCSS: async () => {},
      executeScript: async () => []
    },
    windows: {
      get: async () => ({ id: 1, focused: true, state: 'normal' }),
      update: async () => ({})
    },
    alarms: {
      create: async () => {},
      clear: async () => true,
      onAlarm: { addListener(fn) { listeners.alarm.push(fn); } }
    },
    notifications: {
      create: async () => 'n1',
      onClicked: { addListener(fn) { listeners.notificationClicked.push(fn); } }
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {}
    },
    commands: {
      onCommand: { addListener(fn) { listeners.command.push(fn); } }
    }
  };

  return { chrome, local, session, listeners, tab, snapshot, actionLog, debuggerCalls };
}

let messageListener = null;

test('service worker runs one complete cycle against a mocked Chrome', async () => {
  const stub = makeChromeStub();
  globalThis.chrome = stub.chrome;

  const originalFetch = globalThis.fetch;
  const apiBodies = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('data:')) return originalFetch(url, options);
    apiBodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      id: 'mock-request',
      choices: [{
        message: {
          role: 'assistant',
          content: '{"observation":"视频正在播放","state":"playing","confidence":0.94,"reason":"没有异常","actions":[]}'
        }
      }],
      usage: { prompt_tokens: 80, completion_tokens: 12, total_tokens: 92 }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'mock-request' }
    });
  };

  try {
    await import('../background/service-worker.js');
    await sleep(80);

    const listener = stub.listeners.message[0];
    messageListener = listener;
    assert.equal(typeof listener, 'function');

    const startResponse = await new Promise((resolve) => {
      const keepAlive = listener({ type: 'FF_START', tabId: 1 }, {}, resolve);
      assert.equal(keepAlive, true);
    });
    assert.equal(startResponse.ok, true);
    assert.equal(startResponse.runtime.running, true);

    let runtime;
    for (let i = 0; i < 60; i += 1) {
      await sleep(50);
      runtime = stub.local.get('ff_runtime');
      if (runtime && runtime.cycleCount >= 1) break;
    }

    assert.ok(runtime, 'runtime should be stored');
    assert.equal(runtime.running, true);
    assert.equal(runtime.status, 'watching');
    assert.equal(runtime.cycleCount, 1);
    assert.equal(runtime.lastDecision.state, 'playing');
    assert.equal(runtime.tokens.total, 92);
    assert.equal(apiBodies.length, 1);
    assert.equal(apiBodies[0].messages[1].content[1].type, 'image_url');

    const stopResponse = await new Promise((resolve) => {
      listener({ type: 'FF_STOP' }, {}, resolve);
    });
    assert.equal(stopResponse.ok, true);
    const stopped = stub.local.get('ff_runtime');
    assert.equal(stopped.running, false);
    assert.equal(stopped.status, 'idle');
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.chrome;
  }
});

test('diagnostics export contains page structure but no secrets or screenshots', async () => {
  const stub = makeChromeStub({ quiz: true });
  globalThis.chrome = stub.chrome;
  try {
    assert.equal(typeof messageListener, 'function');
    const response = await new Promise((resolve) => {
      messageListener({ type: 'FF_DIAGNOSTICS', tabId: 1 }, {}, resolve);
    });
    assert.equal(response.ok, true);
    const diag = response.diagnostics;
    assert.equal(diag.tab.id, 1);
    assert.equal(diag.video.found, true);
    assert.equal(diag.quiz.detected, true);
    assert.equal(diag.frames.length, 1);
    assert.ok(Array.isArray(diag.controls));
    const serialized = JSON.stringify(diag);
    assert.equal(serialized.includes('data:image'), false);
    assert.equal(serialized.includes('apiKey'), false);
    assert.equal(serialized.includes('test-secret'), false);
  } finally {
    delete globalThis.chrome;
  }
});

test('service worker clicks DOM next when a video ends without an AI action', async () => {
  const stub = makeChromeStub({ ended: true });
  globalThis.chrome = stub.chrome;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('data:')) return originalFetch(url, options);
    return new Response(JSON.stringify({
      id: 'mock-ended',
      choices: [{
        message: {
          role: 'assistant',
          content: '{"observation":"视频已结束","state":"ended","courseComplete":false,"confidence":0.9,"reason":"无下一节信息","actions":[]}'
        }
      }],
      usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const startResponse = await new Promise((resolve) => {
      messageListener({ type: 'FF_START', tabId: 1 }, {}, resolve);
    });
    assert.equal(startResponse.ok, true);

    let runtime;
    for (let i = 0; i < 60; i += 1) {
      await sleep(50);
      runtime = stub.local.get('ff_runtime');
      if (runtime && runtime.cycleCount >= 1) break;
    }

    assert.ok(runtime);
    assert.equal(runtime.status, 'watching');
    assert.equal(stub.actionLog.length, 1);
    assert.equal(stub.actionLog[0].type, 'next');

    await new Promise((resolve) => {
      messageListener({ type: 'FF_STOP' }, {}, resolve);
    });
    assert.equal(stub.local.get('ff_runtime').running, false);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.chrome;
  }
});

test('service worker clicks DOM next before asking for help at video end', async () => {
  const stub = makeChromeStub({ ended: true });
  globalThis.chrome = stub.chrome;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('data:')) return originalFetch(url, options);
    return new Response(JSON.stringify({
      id: 'mock-ended-ask',
      choices: [{
        message: {
          role: 'assistant',
          content: '{"observation":"视频结束，顶部没有下一节按钮","state":"ended","courseComplete":false,"confidence":0.7,"reason":"需要在目录里找下一节","actions":[{"type":"ask_user","message":"没有找到下一节按钮"}]}'
        }
      }],
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const startResponse = await new Promise((resolve) => {
      messageListener({ type: 'FF_START', tabId: 1 }, {}, resolve);
    });
    assert.equal(startResponse.ok, true);

    let runtime;
    for (let i = 0; i < 60; i += 1) {
      await sleep(50);
      runtime = stub.local.get('ff_runtime');
      if (runtime && runtime.cycleCount >= 1) break;
    }

    assert.ok(runtime);
    assert.equal(runtime.status, 'watching');
    assert.equal(stub.actionLog.length, 1);
    assert.equal(stub.actionLog[0].type, 'next');

    await new Promise((resolve) => {
      messageListener({ type: 'FF_STOP' }, {}, resolve);
    });
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.chrome;
  }
});

test('service worker clicks DOM next before trusting courseComplete at video end', async () => {
  const stub = makeChromeStub({ ended: true });
  globalThis.chrome = stub.chrome;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('data:')) return originalFetch(url, options);
    return new Response(JSON.stringify({
      id: 'mock-ended-complete',
      choices: [{
        message: {
          role: 'assistant',
          content: '{"observation":"视频已结束，看起来没有下一节","state":"ended","courseComplete":true,"confidence":0.9,"reason":"可能已完成","actions":[]}'
        }
      }],
      usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const startResponse = await new Promise((resolve) => {
      messageListener({ type: 'FF_START', tabId: 1 }, {}, resolve);
    });
    assert.equal(startResponse.ok, true);

    let runtime;
    for (let i = 0; i < 60; i += 1) {
      await sleep(50);
      runtime = stub.local.get('ff_runtime');
      if (runtime && runtime.cycleCount >= 1) break;
    }

    assert.ok(runtime);
    assert.equal(runtime.running, true);
    assert.equal(runtime.status, 'watching');
    assert.equal(stub.actionLog.length, 1);
    assert.equal(stub.actionLog[0].type, 'next');

    await new Promise((resolve) => {
      messageListener({ type: 'FF_STOP' }, {}, resolve);
    });
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.chrome;
  }
});

test('service worker stops with completed status when the course is finished', async () => {
  const stub = makeChromeStub();
  globalThis.chrome = stub.chrome;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('data:')) return originalFetch(url, options);
    return new Response(JSON.stringify({
      id: 'mock-complete',
      choices: [{
        message: {
          role: 'assistant',
          content: JSON.stringify({
            observation: '页面显示所有视频节已完成',
            state: 'ended',
            courseComplete: true,
            confidence: 0.98,
            reason: '没有更多章节',
            actions: []
          })
        }
      }],
      usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const startResponse = await new Promise((resolve) => {
      messageListener({ type: 'FF_START', tabId: 1 }, {}, resolve);
    });
    assert.equal(startResponse.ok, true);

    let runtime;
    for (let i = 0; i < 60; i += 1) {
      await sleep(50);
      runtime = stub.local.get('ff_runtime');
      if (runtime && runtime.status === 'completed' && runtime.running === false) break;
    }

    assert.ok(runtime);
    assert.equal(runtime.running, false);
    assert.equal(runtime.status, 'completed');
    assert.match(runtime.pausedReason, /所有视频节已完成/);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.chrome;
  }
});

test('service worker maps a visual bbox to a CDP click', async () => {
  const stub = makeChromeStub({ quiz: true });
  globalThis.chrome = stub.chrome;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('data:')) return originalFetch(url, options);
    return new Response(JSON.stringify({
      id: 'mock-vision',
      choices: [{
        message: {
          role: 'assistant',
          content: JSON.stringify({
            observation: '视频暂停在播放按钮上',
            state: 'paused',
            confidence: 0.94,
            reason: '截图中央有大播放按钮',
            actions: [{
              type: 'click_at',
              bbox: [0.42, 0.42, 0.58, 0.58],
              target: '视频中央的播放按钮'
            }]
          })
        }
      }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const startResponse = await new Promise((resolve) => {
      messageListener({ type: 'FF_START', tabId: 1 }, {}, resolve);
    });
    assert.equal(startResponse.ok, true);

    let runtime;
    for (let i = 0; i < 60; i += 1) {
      await sleep(50);
      runtime = stub.local.get('ff_runtime');
      if (runtime && runtime.cycleCount >= 1) break;
    }

    assert.ok(runtime);
    assert.equal(runtime.status, 'watching');
    assert.equal(runtime.cycleCount, 1);
    assert.equal(stub.actionLog.length, 0);
    const pressed = stub.debuggerCalls.find(
      (call) => call[1] === 'Input.dispatchMouseEvent' && call[2]?.type === 'mousePressed'
    );
    assert.ok(pressed, 'expected a mousePressed CDP command');
    assert.equal(pressed[2].x, 640);
    assert.equal(pressed[2].y, 360);

    await new Promise((resolve) => {
      messageListener({ type: 'FF_STOP' }, {}, resolve);
    });
    assert.equal(stub.local.get('ff_runtime').running, false);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.chrome;
  }
});

test('service worker skips an entire standalone chapter quiz', async () => {
  const stub = makeChromeStub({ quiz: true, noVideo: true });
  globalThis.chrome = stub.chrome;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('data:')) return originalFetch(url, options);
    return new Response(JSON.stringify({
      id: 'mock-standalone-quiz',
      choices: [{
        message: {
          role: 'assistant',
          content: '{"observation":"整节是章节测验","state":"quiz","courseComplete":false,"confidence":0.95,"reason":"应跳过测验","quiz":{"detected":true,"answerSummary":"B"},"actions":[{"type":"click_at","bbox":[0.2,0.3,0.3,0.4],"target":"B. 2"}]}'
        }
      }],
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const startResponse = await new Promise((resolve) => {
      messageListener({ type: 'FF_START', tabId: 1 }, {}, resolve);
    });
    assert.equal(startResponse.ok, true);

    let runtime;
    for (let i = 0; i < 60; i += 1) {
      await sleep(50);
      runtime = stub.local.get('ff_runtime');
      if (runtime && runtime.cycleCount >= 1) break;
    }

    assert.ok(runtime);
    assert.equal(runtime.status, 'watching');
    const pressed = stub.debuggerCalls.filter((call) =>
      call[0] === 'command' && call[1] === 'Input.dispatchMouseEvent' && call[2]?.type === 'mousePressed'
    );
    assert.equal(pressed.length, 0);
    assert.equal(stub.actionLog.length, 1);
    assert.equal(stub.actionLog[0].type, 'next');

    await new Promise((resolve) => {
      messageListener({ type: 'FF_STOP' }, {}, resolve);
    });
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.chrome;
  }
});

test('service worker clicks a normal page button through DOM structure', async () => {
  const stub = makeChromeStub();
  globalThis.chrome = stub.chrome;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('data:')) return originalFetch(url, options);
    return new Response(JSON.stringify({
      id: 'mock-dom-click',
      choices: [{
        message: {
          role: 'assistant',
          content: '{"observation":"页面设置按钮可见","state":"playing","confidence":0.95,"reason":"直接点击 DOM 按钮","actions":[{"type":"click","elementId":"f0:e9"}]}'
        }
      }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const startResponse = await new Promise((resolve) => {
      messageListener({ type: 'FF_START', tabId: 1 }, {}, resolve);
    });
    assert.equal(startResponse.ok, true);

    let runtime;
    for (let i = 0; i < 60; i += 1) {
      await sleep(50);
      runtime = stub.local.get('ff_runtime');
      if (runtime && runtime.cycleCount >= 1) break;
    }

    assert.ok(runtime);
    assert.equal(runtime.status, 'watching');
    assert.equal(stub.actionLog.length, 1);
    assert.equal(stub.actionLog[0].type, 'click');
    assert.equal(stub.actionLog[0].localId, 'e9');

    await new Promise((resolve) => {
      messageListener({ type: 'FF_STOP' }, {}, resolve);
    });
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.chrome;
  }
});

test('service worker dispatches in-video quiz actions with vision coordinates', async () => {
  const stub = makeChromeStub({ quiz: true });
  globalThis.chrome = stub.chrome;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('data:')) return originalFetch(url, options);
    return new Response(JSON.stringify({
      id: 'mock-quiz',
      choices: [{
        message: {
          role: 'assistant',
          content: JSON.stringify({
            observation: '出现单选题',
            state: 'quiz',
            confidence: 0.95,
            reason: '题目和选项清晰',
            quiz: { detected: true, question: '1 + 1 等于多少？', answerSummary: 'B. 2' },
            actions: [
              { type: 'click_at', bbox: [0.15, 0.15, 0.25, 0.22], target: 'B. 2' },
              { type: 'click_at', bbox: [0.30, 0.40, 0.50, 0.48], target: '提交答案' }
            ]
          })
        }
      }],
      usage: { prompt_tokens: 60, completion_tokens: 18, total_tokens: 78 }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    assert.equal(typeof messageListener, 'function');
    const startResponse = await new Promise((resolve) => {
      messageListener({ type: 'FF_START', tabId: 1 }, {}, resolve);
    });
    assert.equal(startResponse.ok, true);

    let runtime;
    for (let i = 0; i < 60; i += 1) {
      await sleep(50);
      runtime = stub.local.get('ff_runtime');
      if (runtime && runtime.cycleCount >= 1) break;
    }

    assert.ok(runtime);
    assert.equal(runtime.status, 'watching');
    assert.equal(runtime.cycleCount, 1);
    assert.equal(runtime.lastDecision.state, 'quiz');
    assert.equal(runtime.lastDecision.quiz.detected, true);
    assert.equal(runtime.lastDecision.planSummary.includes('点击'), true);
    const clicks = stub.debuggerCalls.filter((call) =>
      call[0] === 'command' && call[1] === 'Input.dispatchMouseEvent' && call[2]?.type === 'mousePressed'
    );
    assert.equal(clicks.length, 2);

    await new Promise((resolve) => {
      messageListener({ type: 'FF_STOP' }, {}, resolve);
    });
    assert.equal(stub.local.get('ff_runtime').running, false);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.chrome;
  }
});
