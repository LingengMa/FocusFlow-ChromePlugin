/** Lightweight heuristic used only for unattended auto-start. */

export function looksLikeCoursePage(snapshot, options = {}) {
  if (options.trustedHost && (snapshot?.video?.found || snapshot?.quiz?.detected)) {
    return true;
  }

  const top = (snapshot?.frames || []).find((frame) => frame.isTop) || snapshot?.frames?.[0];
  const text = String(top?.pageText || '');
  const markers = [
    /课程/.test(text),
    /章节|章节目录/.test(text),
    /任务点/.test(text),
    /学习|教学/.test(text),
    /测验|考试|答题/.test(text),
    /课件|PPT|幻灯片|文档/.test(text),
    /目录/.test(text)
  ].filter(Boolean).length;

  const navigation = /下一节|上一节|章节详情/i.test(text);
  return markers >= 2 && navigation;
}
