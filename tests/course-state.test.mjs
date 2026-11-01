import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasNextAction,
  looksCourseComplete,
  shouldSynthesizeNext
} from '../shared/course-state.js';

function snapshot(text = '') {
  return {
    video: { found: false },
    quiz: { detected: false },
    frames: [{ isTop: true, pageText: text }]
  };
}

test('detects a completed course message without matching ordinary progress text', () => {
  assert.equal(looksCourseComplete(snapshot('恭喜你，本课程已全部完成！')), true);
  assert.equal(looksCourseComplete(snapshot('恭喜你完成本节，继续下一节')), false);
  assert.equal(looksCourseComplete(snapshot('所有视频节已完成，没有更多章节')), true);
  assert.equal(looksCourseComplete(snapshot('完成条件：观看时长需达到 100%；已完成 2 个任务点')), false);
  assert.equal(looksCourseComplete(snapshot('本课程完成条件：观看时长需达到 100%')), false);
  assert.equal(looksCourseComplete(snapshot('本课程已完成 2 个任务点')), false);
  assert.equal(looksCourseComplete(snapshot('第 1 节 · 论文写作与发表')), false);
});

test('synthesizes next after two PPT observations, or three generic ones', () => {
  const base = {
    snapshot: snapshot('PPT 阅读材料'),
    decision: { state: 'paused', quiz: { detected: false } },
    plan: { actions: [], needsUser: false, haltAfterMessage: '' },
    settings: { autoNext: true, dryRun: false }
  };
  assert.equal(shouldSynthesizeNext({ ...base, runtime: { noVideoCount: 0 } }), false);
  assert.equal(shouldSynthesizeNext({ ...base, runtime: { noVideoCount: 1 } }), true);

  const generic = { ...base, snapshot: snapshot('第 1 节 · 课程介绍') };
  assert.equal(shouldSynthesizeNext({ ...generic, runtime: { noVideoCount: 1 } }), false);
  assert.equal(shouldSynthesizeNext({ ...generic, runtime: { noVideoCount: 2 } }), true);
});

test('does not synthesize next when a video or quiz is present', () => {
  const base = {
    decision: { state: 'paused' },
    plan: { actions: [], needsUser: false, haltAfterMessage: '' },
    runtime: { noVideoCount: 5 },
    settings: { autoNext: true, dryRun: false }
  };
  const withVideo = { ...snapshot(), video: { found: true } };
  assert.equal(shouldSynthesizeNext({ ...base, snapshot: withVideo }), false);
  const withQuiz = { ...snapshot(), quiz: { detected: true } };
  assert.equal(shouldSynthesizeNext({ ...base, snapshot: withQuiz }), false);
});

test('recognizes next actions across DOM and vision forms', () => {
  assert.equal(hasNextAction({ actions: [{ type: 'next' }] }), true);
  assert.equal(hasNextAction({ actions: [{ type: 'click_at', target: '下一节' }] }), true);
  assert.equal(hasNextAction({ actions: [{ type: 'click', elementLabel: '下一节' }] }), true);
  assert.equal(hasNextAction({ actions: [{ type: 'click_at', target: '播放按钮' }] }), false);
});
