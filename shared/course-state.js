/**
 * Course-level heuristics for PPT-only sections and end-of-course detection.
 */

const COMPLETE_RE = /(?:所有|全部)(?:视频|章节|任务点|课程).{0,12}(?:完成|学完)|(?:本)?课程(?:学习)?(?:已|已经|已全部|全部|完全)?(?:完成|学完)(?!\s*(?:条件|度|率|情况|\d+\s*个))|没有更多(?:章节|视频|内容)|已全部学习|全部任务点已完成/;

export function looksCourseComplete(snapshot) {
  const top = (snapshot?.frames || []).find((frame) => frame.isTop) || snapshot?.frames?.[0];
  const text = String(top?.pageText || '');
  return COMPLETE_RE.test(text);
}

export function looksLikeDocument(snapshot) {
  const top = (snapshot?.frames || []).find((frame) => frame.isTop) || snapshot?.frames?.[0];
  const text = String(top?.pageText || '');
  return /PPT|幻灯片|演示文稿|课件|文档|图文|阅读材料|章节内容/i.test(text);
}

export function hasNextAction(plan) {
  return Boolean(plan?.actions?.some((action) => {
    if (action.type === 'next') return true;
    if (action.type === 'click_at') {
      return /下一[节集课篇个章讲]|next|继续学习|目录|章节|^\d+(?:\.\d+)+\s+\S|第\s*\d+(?:\.\d+)+/i.test(action.target || '');
    }
    if (action.type === 'click') {
      return /下一[节集课篇个章讲]|next|继续学习|目录|章节|^\d+(?:\.\d+)+\s+\S/i.test(action.elementLabel || '');
    }
    return false;
  }));
}

/**
 * A PPT/document section has no <video>. Wait two observations (to avoid
 * switching while a video frame is still loading), then synthesize "next".
 */
export function shouldSynthesizeNext({ snapshot, decision, plan, runtime, settings }) {
  if (!settings?.autoNext || settings?.dryRun) return false;
  if (snapshot?.video?.found) return false;
  if (snapshot?.quiz?.detected || decision?.quiz?.detected || decision?.state === 'quiz') {
    return false;
  }
  if (decision?.state === 'playing') return false;
  if (plan?.needsUser || plan?.haltAfterMessage) return false;
  if (plan?.actions?.length) return false;
  const count = (Number(runtime?.noVideoCount) || 0) + 1;
  // PPT/document pages can advance after two observations. For a generic page
  // without video, wait a little longer in case a video iframe is still loading.
  return count >= (looksLikeDocument(snapshot) ? 2 : 3);
}
