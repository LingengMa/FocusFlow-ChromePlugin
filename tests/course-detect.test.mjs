import test from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeCoursePage } from '../shared/course-detect.js';

function page(text, video = false) {
  return {
    video: { found: video },
    quiz: { detected: false },
    frames: [{ isTop: true, pageText: text }]
  };
}

test('auto-start recognizes course pages with video or course navigation', () => {
  assert.equal(looksLikeCoursePage(page('随便一个页面')), false);
  assert.equal(looksLikeCoursePage(page('课程 章节 任务点 下一节')), true);
  assert.equal(looksLikeCoursePage(page('一篇新闻', true)), false);
  assert.equal(looksLikeCoursePage(page('一篇新闻', true), { trustedHost: true }), true);
  assert.equal(looksLikeCoursePage(page('目录 讨论 笔记 学习进度 30%')), false);
  assert.equal(looksLikeCoursePage(page('章节详情 目录 学习进度 下一节')), true);
});

test('auto-start ignores ordinary pages that only mention learning once', () => {
  assert.equal(looksLikeCoursePage(page('学习是一件好事')), false);
  assert.equal(looksLikeCoursePage(page('欢迎来到我们的产品文档')), false);
});
