import test from 'node:test';
import assert from 'node:assert/strict';

test('clickAtPoint uses CDP mouse events and inserts text', async () => {
  const calls = [];
  globalThis.chrome = {
    debugger: {
      attach: async () => { calls.push(['attach']); },
      detach: async () => { calls.push(['detach']); },
      sendCommand: async (target, method, params) => {
        calls.push(['command', method, params]);
      }
    },
    tabs: {
      sendMessage: async () => {
        throw new Error('content fallback should not run');
      }
    }
  };

  try {
    const { clickAtPoint } = await import('../background/pointer.js');
    const result = await clickAtPoint(7, 120, 240, { text: '42' });
    assert.equal(result.method, 'debugger');
    assert.equal(result.x, 120);
    assert.equal(result.y, 240);

    const methods = calls.filter((call) => call[0] === 'command').map((call) => call[1]);
    assert.deepEqual(methods, [
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.insertText'
    ]);
    assert.equal(calls[0][0], 'attach');
    assert.equal(calls[calls.length - 1][0], 'detach');
    const pressed = calls.find((call) => call[1] === 'Input.dispatchMouseEvent' && call[2].type === 'mousePressed');
    assert.equal(pressed[2].x, 120);
    assert.equal(pressed[2].y, 240);
    const insert = calls.find((call) => call[1] === 'Input.insertText');
    assert.equal(insert[2].text, '42');
  } finally {
    delete globalThis.chrome;
  }
});

test('scrollAtPoint sends a CDP mouse wheel', async () => {
  const calls = [];
  globalThis.chrome = {
    debugger: {
      attach: async () => { calls.push(['attach']); },
      detach: async () => { calls.push(['detach']); },
      sendCommand: async (target, method, params) => {
        calls.push(['command', method, params]);
      }
    },
    tabs: {
      sendMessage: async () => {
        throw new Error('content fallback should not run');
      }
    }
  };

  try {
    const { scrollAtPoint } = await import('../background/pointer.js');
    const result = await scrollAtPoint(9, 1100, 500, 620);
    assert.equal(result.method, 'debugger');
    assert.equal(result.x, 1100);
    assert.equal(result.y, 500);
    const wheel = calls.find((call) =>
      call[1] === 'Input.dispatchMouseEvent' && call[2].type === 'mouseWheel'
    );
    assert.equal(wheel[2].deltaY, 620);
  } finally {
    delete globalThis.chrome;
  }
});

test('clickAtPoint falls back to the content script when debugger attach fails', async () => {
  let message = null;
  globalThis.chrome = {
    debugger: {
      attach: async () => { throw new Error('Another debugger is already attached'); },
      detach: async () => {},
      sendCommand: async () => {}
    },
    tabs: {
      sendMessage: async (tabId, payload, options) => {
        message = { tabId, payload, options };
        return { ok: true, detail: 'content click ok' };
      }
    }
  };

  try {
    const { clickAtPoint } = await import('../background/pointer.js');
    const result = await clickAtPoint(8, 44, 55);
    assert.equal(result.method, 'content');
    assert.equal(message.tabId, 8);
    assert.equal(message.payload.type, 'FF_CLICK_POINT');
    assert.equal(message.payload.x, 44);
    assert.equal(message.payload.y, 55);
    assert.equal(message.options.frameId, 0);
  } finally {
    delete globalThis.chrome;
  }
});

test('clickAtPoint reports both failures', async () => {
  globalThis.chrome = {
    debugger: {
      attach: async () => { throw new Error('debugger unavailable'); },
      detach: async () => {},
      sendCommand: async () => {}
    },
    tabs: {
      sendMessage: async () => { throw new Error('content unavailable'); }
    }
  };

  try {
    const { clickAtPoint } = await import('../background/pointer.js');
    await assert.rejects(
      () => clickAtPoint(9, 10, 20),
      /坐标点击失败/
    );
  } finally {
    delete globalThis.chrome;
  }
});
