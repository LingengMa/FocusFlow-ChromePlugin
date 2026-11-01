import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, normalizeSettings } from '../shared/defaults.js';
import { normalizeDecision } from '../shared/ai-protocol.js';
import { buildActionPlan, summarizePlan } from '../shared/planner.js';

function makeSettings(overrides = {}) {
  // Legacy planner unit tests exercise DOM policies explicitly; the live
  // service worker forces clickMode=vision.
  return normalizeSettings({ ...DEFAULT_SETTINGS, clickMode: 'hybrid', ...overrides });
}

function makeSnapshot() {
  const entries = [
    ['f0:e1', { label: '播放', group: 'player', tag: 'button', localId: 'e1' }],
    ['f0:e2', { label: 'A. 2', group: 'quiz', tag: 'input', inputType: 'radio', localId: 'e2' }],
    ['f0:e3', { label: '提交', group: 'quiz', tag: 'button', localId: 'e3' }],
    ['f0:e4', { label: '下一节', group: 'page', tag: 'a', localId: 'e4' }],
    ['f0:e5', { label: '删除课程', group: 'page', tag: 'button', localId: 'e5' }],
    ['f0:e6', { label: '填写答案', group: 'quiz', tag: 'textarea', localId: 'e6' }],
    ['f0:e7', { label: '页面设置', group: 'page', tag: 'input', inputType: 'radio', localId: 'e7' }]
  ];
  const elementIndex = new Map(entries.map(([id, value]) => [id, { frameId: 0, ...value }]));
  return {
    video: { found: true, frameId: 0, currentTime: 30, duration: 600, paused: true, ended: false },
    quiz: {
      detected: true,
      frameId: 0,
      score: 0.9,
      choices: [{ elementId: 'f0:e2', label: 'A. 2' }],
      submitCandidates: [{ elementId: 'f0:e3', label: '提交' }]
    },
    elementIndex
  };
}

function makeDecision(actions, overrides = {}) {
  return normalizeDecision({
    state: 'quiz',
    confidence: 0.9,
    reason: 'test',
    actions,
    ...overrides
  }, { maxActions: 6 });
}

test('visual click on the play button respects auto-resume', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{
      type: 'click_at',
      bbox: [0.45, 0.45, 0.55, 0.55],
      x: 0.5,
      y: 0.5,
      target: '视频中央的播放按钮'
    }], { state: 'paused' }),
    snapshot: makeSnapshot(),
    settings: makeSettings({ autoResume: false })
  });
  assert.equal(plan.needsUser, true);
  assert.match(plan.message, /自动续播/);
});

test('visual click on next is blocked before the video ends', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{
      type: 'click_at',
      bbox: [0.88, 0.04, 0.96, 0.09],
      x: 0.92,
      y: 0.065,
      target: '页面顶部的下一节'
    }], { state: 'ended' }),
    snapshot: makeSnapshot(),
    settings: makeSettings()
  });
  assert.equal(plan.actions.length, 0);
  assert.match(plan.warnings.join(' '), /尚未播放完/);
});

test('visual click on a quiz option becomes a vision action', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{
      type: 'click_at',
      bbox: [0.2, 0.6, 0.8, 0.65],
      x: 0.5,
      y: 0.625,
      target: 'B. 2'
    }]),
    snapshot: makeSnapshot(),
    settings: makeSettings()
  });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, 'click_at');
  assert.equal(plan.actions[0].x, 0.5);
});

test('pure vision mode ignores elementId click actions', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'choose', elementId: 'f0:e2' }]),
    snapshot: makeSnapshot(),
    settings: makeSettings({ clickMode: 'vision' })
  });
  assert.equal(plan.actions.length, 0);
  assert.match(plan.warnings.join(' '), /纯视觉模式/);
});

test('visual coordinates are ignored in DOM-only mode', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{
      type: 'click_at',
      bbox: [0.2, 0.6, 0.8, 0.65],
      x: 0.5,
      y: 0.625,
      target: 'B. 2'
    }]),
    snapshot: makeSnapshot(),
    settings: makeSettings({ clickMode: 'dom' })
  });
  assert.equal(plan.actions.length, 0);
  assert.match(plan.warnings.join(' '), /DOM/);
});

test('visual fill-in answers are routed through type_at', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{
      type: 'type_at',
      bbox: [0.2, 0.4, 0.8, 0.45],
      x: 0.5,
      y: 0.425,
      target: '答案输入框',
      text: '42'
    }]),
    snapshot: makeSnapshot(),
    settings: makeSettings()
  });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, 'type_at');
  assert.equal(plan.actions[0].text, '42');
});

test('allows play when auto-resume is enabled', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'play' }], { state: 'paused' }),
    snapshot: makeSnapshot(),
    settings: makeSettings()
  });
  assert.equal(plan.needsUser, false);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, 'play');
  assert.equal(plan.actions[0].frameId, 0);
});

test('stops for confirmation when auto-resume is disabled', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'play' }], { state: 'paused' }),
    snapshot: makeSnapshot(),
    settings: makeSettings({ autoResume: false })
  });
  assert.equal(plan.needsUser, true);
  assert.match(plan.message, /自动续播.*已关闭/);
});

test('maps a quiz choice to frame and local id', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'choose', elementId: 'f0:e2' }]),
    snapshot: makeSnapshot(),
    settings: makeSettings()
  });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].frameId, 0);
  assert.equal(plan.actions[0].localId, 'e2');
});

test('accepts a unique local id without the frame prefix', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'choose', elementId: 'e2' }]),
    snapshot: makeSnapshot(),
    settings: makeSettings()
  });
  assert.equal(plan.actions[0].elementId, 'e2');
  assert.equal(plan.actions[0].localId, 'e2');
});

test('does not choose controls outside the quiz', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'choose', elementId: 'f0:e7' }]),
    snapshot: makeSnapshot(),
    settings: makeSettings()
  });
  assert.equal(plan.actions.length, 0);
  assert.match(plan.warnings.join(' '), /不在答题界面内/);
});

test('quiz options that mention destructive words can still be selected', () => {
  const snapshot = makeSnapshot();
  snapshot.elementIndex.set('f0:e8', {
    frameId: 0,
    localId: 'e8',
    label: 'A. 删除文件',
    group: 'quiz',
    tag: 'input',
    type: 'radio'
  });
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'choose', elementId: 'f0:e8' }]),
    snapshot,
    settings: makeSettings()
  });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].localId, 'e8');
});

test('DOM click on a quiz option retains the quiz group for verification', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'click', elementId: 'f0:e2' }]),
    snapshot: makeSnapshot(),
    settings: makeSettings()
  });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].group, 'quiz');
});

test('low confidence turns an answer into a human confirmation', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'choose', elementId: 'f0:e2' }], { confidence: 0.4 }),
    snapshot: makeSnapshot(),
    settings: makeSettings()
  });
  assert.equal(plan.needsUser, true);
  assert.match(plan.message, /置信度/);
});

test('auto-submit off selects answers but stops before submitting', () => {
  const plan = buildActionPlan({
    decision: makeDecision([
      { type: 'choose', elementId: 'f0:e2' },
      { type: 'submit', elementId: 'f0:e3' }
    ]),
    snapshot: makeSnapshot(),
    settings: makeSettings({ autoSubmit: false })
  });
  assert.equal(plan.needsUser, false);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, 'choose');
  assert.match(plan.haltAfterMessage, /自动提交.*已关闭/);
  assert.match(summarizePlan(plan), /等待你提交/);
});

test('dangerous clicks are ignored', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'click', elementId: 'f0:e5' }], { state: 'playing' }),
    snapshot: makeSnapshot(),
    settings: makeSettings()
  });
  assert.equal(plan.actions.length, 0);
  assert.match(plan.warnings.join(' '), /安全策略/);
});

test('next is ignored while the video is still mid-way', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'next', elementId: 'f0:e4' }], { state: 'ended' }),
    snapshot: makeSnapshot(),
    settings: makeSettings()
  });
  assert.equal(plan.actions.length, 0);
  assert.match(plan.warnings.join(' '), /尚未播放完/);
});

test('next is ignored when video metadata has not loaded yet', () => {
  const snapshot = makeSnapshot();
  snapshot.video.duration = 0;
  snapshot.video.currentTime = 0;
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'next', elementId: 'f0:e4' }], { state: 'ended' }),
    snapshot,
    settings: makeSettings()
  });
  assert.equal(plan.actions.length, 0);
  assert.match(plan.warnings.join(' '), /尚未播放完/);
});

test('play is ignored after the video has ended', () => {
  const snapshot = makeSnapshot();
  snapshot.video.currentTime = 459.4;
  snapshot.video.duration = 459.4;
  snapshot.video.ended = true;
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'play' }], { state: 'ended' }),
    snapshot,
    settings: makeSettings()
  });
  assert.equal(plan.actions.length, 0);
  assert.match(plan.warnings.join(' '), /已经结束/);
});

test('allows next after the video has actually ended', () => {
  const snapshot = makeSnapshot();
  snapshot.video.currentTime = 459.4;
  snapshot.video.duration = 459.4;
  snapshot.video.ended = true;
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'next', elementId: 'f0:e4' }], { state: 'ended' }),
    snapshot,
    settings: makeSettings()
  });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, 'next');
});

test('next respects the auto-next switch', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'next', elementId: 'f0:e4' }], { state: 'ended' }),
    snapshot: makeSnapshot(),
    settings: makeSettings({ autoNext: false })
  });
  assert.equal(plan.needsUser, true);
  assert.match(plan.message, /自动切换下一节.*已关闭/);
});

test('clicking a "next" label also respects auto-next', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'click', elementId: 'f0:e4' }], { state: 'ended' }),
    snapshot: makeSnapshot(),
    settings: makeSettings({ autoNext: false })
  });
  assert.equal(plan.needsUser, true);
});

test('longer "next lesson" button labels still respect auto-next', () => {
  const snapshot = makeSnapshot();
  snapshot.elementIndex.get('f0:e4').label = '下一节：光影与层次';
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'click', elementId: 'f0:e4' }], { state: 'ended' }),
    snapshot,
    settings: makeSettings({ autoNext: false })
  });
  assert.equal(plan.needsUser, true);
});

test('answer actions are ignored when no quiz is detected', () => {
  const snapshot = makeSnapshot();
  snapshot.quiz = { detected: false, frameId: 0, choices: [], submitCandidates: [] };
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'choose', elementId: 'f0:e2' }], { state: 'playing' }),
    snapshot,
    settings: makeSettings()
  });
  assert.equal(plan.actions.length, 0);
  assert.match(plan.warnings.join(' '), /未检测到答题界面/);
});

test('fill-in answers are routed to the quiz textarea', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'type', elementId: 'f0:e6', text: '42' }]),
    snapshot: makeSnapshot(),
    settings: makeSettings()
  });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].localId, 'e6');
  assert.equal(plan.actions[0].text, '42');
});

test('visual numbered section clicks are treated as next and blocked before the end', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{
      type: 'click_at',
      bbox: [0.7, 0.45, 0.95, 0.52],
      target: '1.5 学术评审与学术不端'
    }], { state: 'playing' }),
    snapshot: makeSnapshot(),
    settings: makeSettings({ clickMode: 'vision' })
  });
  assert.equal(plan.actions.length, 0);
  assert.match(plan.warnings.join(' '), /尚未播放完/);
});

test('pure vision allows a coordinate scroll to reveal the directory', () => {
  const snapshot = makeSnapshot();
  snapshot.video.ended = true;
  snapshot.video.currentTime = snapshot.video.duration;
  const plan = buildActionPlan({
    decision: makeDecision([{
      type: 'scroll_at',
      bbox: [0.82, 0.35, 0.98, 0.75],
      target: '右侧目录',
      deltaY: 620
    }], { state: 'ended' }),
    snapshot,
    settings: makeSettings({ clickMode: 'vision' })
  });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, 'scroll_at');
  assert.equal(plan.actions[0].deltaY, 620);
});

test('standalone chapter quiz answers are skipped in video-only mode', () => {
  const snapshot = makeSnapshot();
  snapshot.video = { found: false, frameId: 0 };
  snapshot.quiz.detected = true;
  const plan = buildActionPlan({
    decision: makeDecision([{
      type: 'click_at',
      bbox: [0.1, 0.1, 0.2, 0.2],
      target: 'B. 2'
    }], { state: 'quiz' }),
    snapshot,
    settings: makeSettings({
      clickMode: 'vision',
      skipStandaloneQuiz: true
    })
  });
  assert.equal(plan.actions.length, 0);
  assert.match(plan.warnings.join(' '), /跳过/);
});

test('summarizePlan describes human confirmation', () => {
  const plan = buildActionPlan({
    decision: makeDecision([{ type: 'submit' }]),
    snapshot: makeSnapshot(),
    settings: makeSettings({ autoSubmit: false })
  });
  assert.equal(plan.needsUser, false);
  assert.equal(plan.actions.length, 0);
  assert.equal(summarizePlan(plan), plan.haltAfterMessage);
});
