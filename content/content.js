/* FocusFlow content script: page observation + DOM actions + a tiny HUD. */
(() => {
  if (globalThis.__FF_CONTENT_LOADED__) return;
  globalThis.__FF_CONTENT_LOADED__ = true;

  const MAX_CONTROLS = 110;
  const MAX_PAGE_TEXT = 6500;
  const HUD_ID = 'ff-hud-host';

  const registry = new Map();
  const elementIds = new WeakMap();
  let nextElementId = 1;
  let hudEnabled = true;
  let hudHost = null;
  let hudShadow = null;
  let hudTimer = null;
  let lastEventAt = 0;
  let lastWaitingAt = 0;
  let lastQuizSignature = '';
  let mutationTimer = null;

  const QUIZ_SELECTOR = [
    '[role="dialog"]',
    'dialog',
    '[class*="quiz" i]',
    '[class*="exam" i]',
    '[class*="question" i]',
    '[class*="questionli" i]',
    '[class*="answer" i]',
    '[class*="timu" i]',
    '[class*="modal" i]',
    '[class*="popup" i]',
    '[class*="dialog" i]',
    '[id*="quiz" i]',
    '[id*="exam" i]',
    '[id*="question" i]'
  ].join(',');

  const OPTION_LIKE_SELECTOR = [
    '[class*="ans-item" i]',
    '[class*="answer-item" i]',
    '[class*="option-item" i]',
    '[class*="optionlist" i] > li',
    '[class*="choice-item" i]'
  ].join(',');

  function cleanText(value, max = 300) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, max);
  }

  function idFor(element) {
    if (!element) return '';
    let id = elementIds.get(element);
    if (!id) {
      id = `e${nextElementId}`;
      nextElementId += 1;
      elementIds.set(element, id);
      registry.set(id, new WeakRef(element));
    }
    return id;
  }

  function resolveElement(id) {
    if (!id) return null;
    const ref = registry.get(String(id));
    const element = ref?.deref?.();
    if (!element || !element.isConnected) {
      registry.delete(String(id));
      return null;
    }
    return element;
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    if (element.closest(`#${HUD_ID}`)) return false;
    const style = getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
    if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom < -4 || rect.right < -4) return false;
    if (rect.top > window.innerHeight + 4 || rect.left > window.innerWidth + 4) return false;
    return true;
  }

  function textOf(element, max = 160) {
    if (!element) return '';
    const tag = element.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      return cleanText(element.value || element.getAttribute('placeholder') || '', max);
    }
    return cleanText(element.innerText || element.textContent || '', max);
  }

  function labelFor(element) {
    if (!element) return '';
    const parts = [];
    const aria = element.getAttribute?.('aria-label');
    if (aria) parts.push(aria);
    const title = element.getAttribute?.('title');
    if (title) parts.push(title);
    if (element.labels) {
      for (const label of element.labels) {
        const text = cleanText(label.innerText || label.textContent || '', 120);
        if (text) parts.push(text);
      }
    }
    if (element.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(element.type)) {
      parts.push(element.value || '');
    }
    if (element.tagName === 'IMG') parts.push(element.alt || '');
    const placeholder = element.getAttribute?.('placeholder');
    if (placeholder) parts.push(placeholder);
    if (['BUTTON', 'A', 'LABEL', 'SUMMARY'].includes(element.tagName) || element.getAttribute?.('role')) {
      parts.push(textOf(element, 140));
    }
    if (!parts.filter(Boolean).length) parts.push(textOf(element, 140));
    return cleanText(parts.filter(Boolean).join(' · '), 180);
  }

  function inputType(element) {
    if (!(element instanceof HTMLInputElement)) return '';
    return String(element.type || '').toLowerCase();
  }

  function isChecked(element) {
    if (element instanceof HTMLInputElement) return element.checked;
    const aria = element.getAttribute?.('aria-checked');
    return aria === 'true' || element.classList?.contains('selected') || element.classList?.contains('active');
  }

  function isDisabled(element) {
    return Boolean(element.disabled) ||
      element.getAttribute?.('aria-disabled') === 'true' ||
      element.classList?.contains('disabled');
  }

  function videoContainerFor(video) {
    if (!video) return null;
    // Start at the parent: the <video> itself has class "vjs-tech", which
    // would otherwise match "vjs" and return the video instead of its player.
    let node = video.parentElement;
    for (let depth = 0; depth < 6 && node; depth += 1) {
      if (
        node.id === 'player' ||
        /player|video|vjs|jwplayer|prism|dplayer|xgplayer/i.test(String(node.className || ''))
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return video.parentElement;
  }

  function getVideos() {
    const result = [];
    for (const video of document.querySelectorAll('video')) {
      if (!video.isConnected) continue;
      const rect = video.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const visible = isVisible(video) || (rect.width > 200 && rect.height > 120);
      if (!visible && video.readyState === 0) continue;
      result.push({
        element: video,
        area,
        playing: !video.paused && !video.ended,
        ended: video.ended,
        rect
      });
    }
    result.sort((a, b) => {
      if (a.playing !== b.playing) return a.playing ? -1 : 1;
      return b.area - a.area;
    });
    return result;
  }

  function videoState(video) {
    if (!video) return { found: false };
    const rect = video.getBoundingClientRect();
    let srcHost = '';
    try {
      srcHost = new URL(video.currentSrc || video.src, location.href).hostname;
    } catch {
      srcHost = '';
    }
    return {
      found: true,
      id: video.id || '',
      className: String(video.className || '').slice(0, 160),
      srcHost,
      controls: Boolean(video.controls),
      currentTime: Number.isFinite(video.currentTime) ? Math.round(video.currentTime * 10) / 10 : 0,
      duration: Number.isFinite(video.duration) ? Math.round(video.duration * 10) / 10 : 0,
      paused: Boolean(video.paused),
      ended: Boolean(video.ended),
      readyState: Number(video.readyState) || 0,
      buffering: !video.paused && !video.ended && video.readyState < 3,
      playbackRate: Number(video.playbackRate) || 1,
      muted: Boolean(video.muted),
      volume: Number(video.volume) || 0,
      area: Math.round(Math.max(0, rect.width) * Math.max(0, rect.height)),
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }

  function quizWordSignal(text) {
    return /答题|题目|问题|单选题|多选题|判断题|填空题|随堂|测验|考试|第\s*\d+\s*题|quiz|question|exam|\btest\b/i.test(text) ||
      /[?？]/.test(text);
  }

  function submitCandidatesIn(container) {
    const nodes = container.querySelectorAll(
      'button, input[type="submit"], input[type="button"], [role="button"], a'
    );
    const out = [];
    for (const node of nodes) {
      if (!isVisible(node) || isDisabled(node)) continue;
      const label = labelFor(node);
      if (!/提交|交卷|确定|确认|submit|confirm/i.test(label)) continue;
      if (/取消|cancel|关闭|close/i.test(label)) continue;
      out.push({ id: idFor(node), label, element: node });
      if (out.length >= 5) break;
    }
    return out;
  }

  function findQuiz() {
    const candidates = [];
    const seen = new Set();
    let nodes;
    try {
      nodes = document.querySelectorAll(QUIZ_SELECTOR);
    } catch {
      nodes = [];
    }

    for (const node of nodes) {
      if (seen.has(node) || !isVisible(node)) continue;
      if (node === document.body || node === document.documentElement) continue;
      seen.add(node);
      const text = cleanText(node.innerText || node.textContent || '', 3200);
      if (text.length < 6 || text.length > 7000) continue;
      if (!quizWordSignal(text)) continue;

      const radioCount = node.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]').length;
      const textInputs = node.querySelectorAll(
        'textarea, input[type="text"], input[type="number"], input:not([type]), [contenteditable="true"]'
      ).length;
      const optionButtons = node.querySelectorAll('button, [role="button"]').length;
      const optionLike = node.querySelectorAll(OPTION_LIKE_SELECTOR).length;
      if (radioCount < 1 && textInputs < 1 && optionButtons < 2 && optionLike < 2) continue;
      const submits = submitCandidatesIn(node);
      let score = 0;
      if (radioCount >= 2) score += 4;
      if (textInputs > 0) score += 2;
      if (submits.length > 0) score += 2;
      score += 3;
      if (node.matches('dialog, [role="dialog"]')) score += 1;
      if (node.querySelector('h1, h2, h3, h4, legend')) score += 1;
      if (score < 5) continue;
      const loginLike = /登录|密码|验证码|扫码|sign\s*in|log\s*in|password/i.test(text);
      const strongQuiz = /答题|题目|单选题|多选题|判断题|填空题|随堂|测验|考试|第\s*\d+\s*题|quiz|exam|\btest\b/i.test(text);
      if (loginLike && !strongQuiz) continue;

      const heading = node.querySelector(
        'h1, h2, h3, h4, h5, legend, [class*="question" i], [class*="title" i], [class*="stem" i]'
      );
      const firstQuestionLine = text
        .split('\n')
        .map((line) => line.trim())
        .find((line) => /[?？]/.test(line) || /第\s*\d+\s*题|题目/.test(line));
      const question = cleanText(heading?.innerText || firstQuestionLine || text.slice(0, 300), 700);

      const choices = [];
      const choiceSeen = new Set();
      const inputs = node.querySelectorAll(
        'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'
      );
      for (const input of inputs) {
        if (choiceSeen.has(input) || !isVisible(input)) continue;
        choiceSeen.add(input);
        let label = '';
        const wrappingLabel = input.closest('label');
        if (wrappingLabel) label = textOf(wrappingLabel, 180);
        if (!label && input.labels) {
          for (const labelNode of input.labels) {
            label = cleanText(labelNode.innerText || labelNode.textContent || '', 180);
            if (label) break;
          }
        }
        if (!label) label = labelFor(input);
        choices.push({ id: idFor(input), label: label || '(未命名选项)', checked: isChecked(input) });
      }
      if (choices.length === 0) {
        for (const roleNode of node.querySelectorAll('[role="radio"], [role="checkbox"]')) {
          if (!isVisible(roleNode) || choiceSeen.has(roleNode)) continue;
          choiceSeen.add(roleNode);
          choices.push({ id: idFor(roleNode), label: labelFor(roleNode), checked: isChecked(roleNode) });
        }
      }
      if (choices.length === 0) {
        for (const optionNode of node.querySelectorAll(OPTION_LIKE_SELECTOR)) {
          if (!isVisible(optionNode) || choiceSeen.has(optionNode)) continue;
          const label = labelFor(optionNode);
          if (!label || label.length > 180) continue;
          choiceSeen.add(optionNode);
          choices.push({ id: idFor(optionNode), label, checked: isChecked(optionNode) });
          if (choices.length >= 20) break;
        }
      }

      candidates.push({
        element: node,
        tag: node.tagName.toLowerCase(),
        className: String(node.className || '').slice(0, 180),
        score,
        text,
        question,
        choices,
        submitCandidates: submits.map(({ id, label }) => ({ id, label })),
        hasTextInput: textInputs > 0,
        rect: node.getBoundingClientRect()
      });
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height);
    });
    const best = candidates[0];
    return {
      detected: true,
      tag: best.tag,
      className: best.className,
      score: Math.min(1, best.score / 11),
      question: best.question,
      text: best.text,
      choices: best.choices.slice(0, 24),
      submitCandidates: best.submitCandidates,
      hasTextInput: best.hasTextInput,
      element: best.element
    };
  }

  function controlGroup(element, quiz, video) {
    if (quiz?.element && quiz.element.contains(element)) return 'quiz';
    if (video && videoContainerFor(video)?.contains(element)) return 'player';
    return 'page';
  }

  function collectControls(quiz, video) {
    const selector = [
      'button',
      'a',
      'input:not([type="hidden"])',
      'textarea',
      'select',
      '[role="button"]',
      '[role="radio"]',
      '[role="checkbox"]',
      '[role="menuitem"]',
      '[role="tab"]',
      '[contenteditable="true"]',
      '[onclick]',
      '[class*="next" i]',
      '[class*="prev" i]',
      OPTION_LIKE_SELECTOR
    ].join(',');

    const out = [];
    const seen = new Set();
    const nodes = [];
    // Read quiz controls first so a long page cannot push the answer options
    // past the global control cap.
    for (const root of [quiz?.element, document].filter(Boolean)) {
      for (const element of root.querySelectorAll(selector)) {
        if (!seen.has(element)) {
          seen.add(element);
          nodes.push(element);
        }
      }
    }

    for (const element of nodes) {
      if (!isVisible(element)) continue;
      if (element === hudHost || element.closest(`#${HUD_ID}`)) continue;
      if (inputType(element) === 'password') continue;
      if (element.getAttribute('aria-hidden') === 'true') continue;

      const rect = element.getBoundingClientRect();
      const group = controlGroup(element, quiz, video);
      const label = labelFor(element);
      out.push({
        id: idFor(element),
        tag: element.tagName.toLowerCase(),
        className: String(element.className || '').slice(0, 140),
        role: element.getAttribute('role') || '',
        type: inputType(element) || element.getAttribute('type') || '',
        label,
        text: textOf(element, 140),
        checked: isChecked(element),
        disabled: isDisabled(element),
        group,
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
      if (out.length >= MAX_CONTROLS) break;
    }

    out.sort((a, b) => {
      const score = (control) => {
        let value = 0;
        if (control.group === 'quiz') value += 100;
        if (/下一|next|继续|提交|确定|播放|暂停|play|pause|submit|continue/i.test(control.label)) value += 30;
        if (control.group === 'player') value += 15;
        if (control.checked) value += 4;
        if (control.disabled) value -= 20;
        return value;
      };
      return score(b) - score(a);
    });
    return out.slice(0, MAX_CONTROLS);
  }

  function collectPageText() {
    try {
      const text = document.body?.innerText || document.documentElement?.innerText || '';
      return cleanText(text, MAX_PAGE_TEXT);
    } catch {
      return '';
    }
  }

  function buildSnapshot() {
    const videos = getVideos();
    const primary = videos[0]?.element || null;
    const quiz = findQuiz();
    const controls = collectControls(quiz, primary);
    const pageText = collectPageText();

    return {
      ok: true,
      url: location.href,
      title: document.title,
      isTop: window.top === window,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1
      },
      video: primary ? videoState(primary) : { found: false },
      videos: videos.slice(0, 3).map((item) => videoState(item.element)),
      quiz: quiz
        ? {
            detected: true,
            tag: quiz.tag,
            className: quiz.className,
            score: quiz.score,
            question: quiz.question,
            text: quiz.text,
            choices: quiz.choices,
            submitCandidates: quiz.submitCandidates,
            hasTextInput: quiz.hasTextInput
          }
        : { detected: false, score: 0, choices: [], submitCandidates: [] },
      controls,
      pageText,
      capturedAt: Date.now()
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function fireClick(element) {
    try {
      element.scrollIntoView({ block: 'center', inline: 'center' });
    } catch {
      // ignore
    }
    // Native controls only need click(); dispatching a full pointer sequence
    // can double-toggle players that listen to more than one event.
    const nativeClickable = ['BUTTON', 'A', 'INPUT', 'LABEL', 'SUMMARY'].includes(element.tagName) ||
      element.hasAttribute('onclick');
    if (nativeClickable) {
      // Keep "next lesson" links in the controlled tab instead of opening a
      // new tab that FocusFlow is not watching.
      const originalTarget = element.tagName === 'A' ? element.getAttribute('target') : null;
      if (originalTarget && originalTarget !== '_self') element.setAttribute('target', '_self');
      element.click();
      if (originalTarget) element.setAttribute('target', originalTarget);
      return;
    }

    const rect = element.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      screenX: rect.left + rect.width / 2,
      screenY: rect.top + rect.height / 2,
      button: 0
    };
    try {
      element.dispatchEvent(new PointerEvent('pointerdown', {
        ...base,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        buttons: 1
      }));
      element.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
      element.dispatchEvent(new PointerEvent('pointerup', {
        ...base,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        buttons: 0
      }));
      element.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    } catch {
      // PointerEvent may be unavailable in exotic frames.
    }
    element.click();
  }

  function findNextControl() {
    const nextPattern = /^(下一[节集课篇个章讲]|下一个(视频|课程|任务点)?|下节|next(\s+(video|lesson))?|继续(学习|观看|下节)?)/i;
    const candidates = [];
    const seen = new Set();

    const consider = (element) => {
      if (!element || seen.has(element) || !isVisible(element) || isDisabled(element)) return;
      const label = labelFor(element);
      if (!nextPattern.test(label) || label.length > 60) return;
      if (/上一|prev|back/i.test(label)) return;
      seen.add(element);
      const tag = element.tagName;
      const role = element.getAttribute?.('role') || '';
      const className = String(element.className || '');
      let score = 0;
      if (['A', 'BUTTON'].includes(tag)) score += 4;
      if (role === 'button') score += 3;
      if (element.hasAttribute?.('onclick')) score += 3;
      if (/next/i.test(className)) score += 2;
      try {
        if (getComputedStyle(element).cursor === 'pointer') score += 1;
      } catch {
        // ignore
      }
      const rect = element.getBoundingClientRect();
      candidates.push({ element, label, score, area: rect.width * rect.height });
    };

    for (const element of document.querySelectorAll(
      'a, button, [role="button"], [onclick], [class*="next" i], [class*="prev" i]'
    )) {
      consider(element);
    }

    // The platform often renders "下一节" as a text span inside a clickable div.
    // Walk text nodes so we do not depend on a specific tag or class.
    let fallbackByPoint = null;
    try {
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      let node;
      let visited = 0;
      while ((node = walker.nextNode()) && visited < 5000) {
        visited += 1;
        const value = String(node.nodeValue || '').trim();
        if (!nextPattern.test(value) || value.length > 30) continue;

        try {
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          if (rect.width > 1 && rect.height > 1) {
            const hit = document.elementFromPoint(
              rect.left + Math.min(3, rect.width / 2),
              rect.top + rect.height / 2
            );
            if (hit && hit !== document.body && hit !== document.documentElement && !isDisabled(hit)) {
              fallbackByPoint = hit;
            }
          }
        } catch {
          // Range hit-testing is best-effort.
        }

        const textParent = node.parentElement;
        consider(textParent);
        let element = textParent;
        for (let depth = 0; depth < 4 && element; depth += 1) {
          if (
            ['A', 'BUTTON'].includes(element.tagName) ||
            element.getAttribute?.('role') === 'button' ||
            element.hasAttribute?.('onclick') ||
            /next/i.test(String(element.className || ''))
          ) {
            break;
          }
          element = element.parentElement;
        }
        consider(element);
      }
    } catch {
      // TreeWalker is best-effort.
    }

    candidates.sort((a, b) => (b.score - a.score) || (a.area - b.area));
    return candidates[0]?.element || fallbackByPoint;
  }

  function findSubmitControl() {
    const quiz = findQuiz();
    if (quiz?.element) {
      const inside = submitCandidatesIn(quiz.element);
      if (inside.length) return inside[0].element;
    }
    const buttons = document.querySelectorAll('button, input[type="submit"], [role="button"], a');
    for (const element of buttons) {
      if (!isVisible(element) || isDisabled(element)) continue;
      const label = labelFor(element);
      if (
        /^(提交|交卷|确定|确认)(答案|试卷|作业)?$/i.test(label) ||
        /^(保存并提交|submit|confirm)$/i.test(label)
      ) {
        return element;
      }
    }
    return null;
  }

  function findPrimaryVideo() {
    return getVideos()[0]?.element || null;
  }

  async function executePlay() {
    const video = findPrimaryVideo();
    if (!video) throw new Error('当前页面没有可控制的视频。');

    const container = videoContainerFor(video) || video.parentElement;
    const findPlayButton = () => {
      const nodes = [];
      const seen = new Set();
      for (const root of [container, document].filter(Boolean)) {
        for (const element of root.querySelectorAll(
          'button, [role="button"], .vjs-big-play-button, .xgplayer-start, ' +
          '.prism-big-play-btn, [class*="play" i]'
        )) {
          if (!seen.has(element)) {
            seen.add(element);
            nodes.push(element);
          }
        }
      }
      const candidates = nodes.filter((element) => isVisible(element));
      return candidates.find((element) => /播放视频|播放|开始|play|start/i.test(labelFor(element))) ||
        container?.querySelector('.vjs-big-play-button, .xgplayer-start, .prism-big-play-btn') ||
        candidates[0] ||
        null;
    };

    let rejection = null;
    try {
      // A Video.js source may only load after the big-play button is clicked;
      // don't let play() block the whole action beyond a few seconds.
      await Promise.race([
        video.play(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('play-timeout')), 2600))
      ]);
    } catch (error) {
      rejection = error;
    }

    await sleep(360);
    if (rejection || (video.paused && !video.ended)) {
      const playButton = findPlayButton();
      if (playButton) fireClick(playButton);
      else fireClick(video);
      await sleep(600);
      await video.play().catch(() => {});
    }

    await sleep(260);
    if (video.paused && !video.ended) {
      throw new Error('浏览器阻止了播放。请手动点击一次播放按钮后重启 FocusFlow。');
    }
    return { ok: true, detail: '已继续播放', state: videoState(video) };
  }

  async function executePause() {
    const video = findPrimaryVideo();
    if (!video) throw new Error('当前页面没有可控制的视频。');
    video.pause();
    await sleep(150);
    return { ok: true, detail: '已暂停', state: videoState(video) };
  }

  async function executeSeek(action) {
    const video = findPrimaryVideo();
    if (!video) throw new Error('当前页面没有可控制的视频。');
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const seconds = Math.max(0, Math.min(duration || 86400, Number(action.seconds) || 0));
    video.currentTime = seconds;
    await sleep(300);
    return { ok: true, detail: `已跳转到 ${Math.round(seconds)}s`, state: videoState(video) };
  }

  async function resolveActionElement(action) {
    let element = resolveElement(action.localId);
    if (!element && action.elementId) element = resolveElement(action.elementId);
    if (!element) throw new Error('目标元素已失效，请在下一轮重新识别。');
    return element;
  }

  async function executeClick(action) {
    const element = await resolveActionElement(action);
    fireClick(element);
    await sleep(350);
    return {
      ok: true,
      detail: `已点击“${labelFor(element)}”`,
      state: videoState(findPrimaryVideo())
    };
  }

  async function executeChoose(action) {
    const element = await resolveActionElement(action);
    const input = element.matches('input[type="radio"], input[type="checkbox"]')
      ? element
      : element.querySelector('input[type="radio"], input[type="checkbox"]');
    if (input) {
      if (!input.checked) input.click();
      if (!input.checked) {
        input.checked = true;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else {
      fireClick(element);
    }
    await sleep(300);
    return {
      ok: true,
      detail: `已选择“${labelFor(element)}”`,
      state: videoState(findPrimaryVideo())
    };
  }

  async function executeType(action) {
    const element = await resolveActionElement(action);
    const editable = element.matches('input, textarea, [contenteditable="true"]');
    if (!editable) throw new Error('目标不是输入框。');
    const text = String(action.text || '').slice(0, 500);
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const proto = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(element, text);
      else element.value = text;
    } else {
      element.textContent = text;
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(250);
    return { ok: true, detail: '已填写答案' };
  }

  async function executeSubmit(action) {
    let element = action.localId ? resolveElement(action.localId) : null;
    if (!element) element = findSubmitControl();
    if (!element) throw new Error('没有找到提交按钮。');
    fireClick(element);
    await sleep(700);
    return {
      ok: true,
      detail: `已点击“${labelFor(element)}”`,
      state: videoState(findPrimaryVideo())
    };
  }

  async function executeNext(action) {
    let element = action.localId ? resolveElement(action.localId) : null;
    if (!element) element = findNextControl();
    if (!element) throw new Error('没有找到“下一节”控件。');
    fireClick(element);
    await sleep(600);
    return { ok: true, detail: `已点击“${labelFor(element)}”` };
  }

  function clickAtPoint(x, y, text = '') {
    let doc = document;
    let cx = Number(x) || 0;
    let cy = Number(y) || 0;
    let element = null;

    for (let depth = 0; depth < 4; depth += 1) {
      element = doc.elementFromPoint(cx, cy);
      if (!element) throw new Error('坐标位置没有可点击元素。');
      if (element.tagName === 'IFRAME') {
        const rect = element.getBoundingClientRect();
        let child = null;
        try {
          child = element.contentDocument;
        } catch {
          child = null;
        }
        if (!child) {
          throw new Error('坐标位于跨域 iframe，需要使用 debugger 精准点击。');
        }
        cx -= rect.left + element.clientLeft;
        cy -= rect.top + element.clientTop;
        doc = child;
        continue;
      }
      break;
    }

    if (!element) throw new Error('坐标位置没有可点击元素。');
    fireClick(element);

    if (text) {
      const active = doc.activeElement;
      const target = active && active !== doc.body ? active : element;
      const editable = target.matches?.('input, textarea, [contenteditable="true"]');
      if (!editable) throw new Error('点击后没有可输入框。');
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const view = target.ownerDocument?.defaultView;
        const proto = tag === 'TEXTAREA'
          ? view?.HTMLTextAreaElement?.prototype
          : view?.HTMLInputElement?.prototype;
        const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
        if (setter) setter.call(target, text);
        else target.value = text;
      } else {
        target.textContent = text;
      }
      const InputEventCtor = target.ownerDocument?.defaultView?.InputEvent || InputEvent;
      target.dispatchEvent(new InputEventCtor('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text
      }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }

    return {
      ok: true,
      detail: `已点击坐标 (${Math.round(Number(x) || 0)},${Math.round(Number(y) || 0)})`,
      tag: element.tagName.toLowerCase(),
      label: labelFor(element)
    };
  }

  async function executeAction(action) {
    if (!action || !action.type) throw new Error('空动作。');
    switch (action.type) {
      case 'play': return executePlay();
      case 'pause': return executePause();
      case 'seek': return executeSeek(action);
      case 'click': return executeClick(action);
      case 'choose': return executeChoose(action);
      case 'type': return executeType(action);
      case 'submit': return executeSubmit(action);
      case 'next': return executeNext(action);
      case 'wait': return { ok: true, detail: '等待中' };
      default: throw new Error(`不支持的动作：${action.type}`);
    }
  }

  function sendRuntimeMessage(message) {
    try {
      const result = chrome.runtime.sendMessage(message);
      if (result?.catch) result.catch(() => {});
    } catch {
      // Extension context invalidated (e.g. extension reloaded); ignore.
    }
  }

  function emitEvent(type, extra = {}) {
    const now = Date.now();
    if (now - lastEventAt < 1600 && type !== 'ended') return;
    lastEventAt = now;
    sendRuntimeMessage({
      type: 'FF_EVENT',
      event: {
        type,
        at: now,
        url: location.href,
        isTop: window.top === window,
        ...extra
      }
    });
  }

  function attachMediaEvents() {
    document.addEventListener('pause', (event) => {
      if (!(event.target instanceof HTMLVideoElement)) return;
      if (event.target.ended) return;
      emitEvent('pause', {
        currentTime: event.target.currentTime,
        duration: event.target.duration
      });
    }, true);

    document.addEventListener('ended', (event) => {
      if (!(event.target instanceof HTMLVideoElement)) return;
      lastEventAt = 0;
      emitEvent('ended', {
        currentTime: event.target.currentTime,
        duration: event.target.duration
      });
    }, true);

    document.addEventListener('waiting', (event) => {
      if (!(event.target instanceof HTMLVideoElement)) return;
      const now = Date.now();
      if (now - lastWaitingAt < 15000) return;
      lastWaitingAt = now;
      emitEvent('waiting', { currentTime: event.target.currentTime });
    }, true);

    document.addEventListener('stalled', (event) => {
      if (!(event.target instanceof HTMLVideoElement)) return;
      const now = Date.now();
      if (now - lastWaitingAt < 15000) return;
      lastWaitingAt = now;
      emitEvent('waiting', { currentTime: event.target.currentTime, stalled: true });
    }, true);

    // Many course platforms pause when the tab is hidden. Treat that as an
    // event so FocusFlow can pull the course tab back to the foreground.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) emitEvent('visibility', { hidden: true });
    });
  }

  function mightContainQuiz(node) {
    if (!(node instanceof Element)) return false;
    if (node.matches?.(QUIZ_SELECTOR)) return true;
    if (node.querySelector?.('input[type="radio"], input[type="checkbox"], dialog, [role="dialog"]')) return true;
    const text = cleanText(node.innerText || '', 240);
    return /提交|答题|题目|第\s*\d+\s*题|quiz|question/i.test(text);
  }

  function observeQuiz() {
    const observer = new MutationObserver((mutations) => {
      let interesting = false;
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;
        for (const node of mutation.addedNodes) {
          if (mightContainQuiz(node)) {
            interesting = true;
            break;
          }
        }
        if (interesting) break;
      }
      if (!interesting) return;
      if (mutationTimer) return;
      mutationTimer = setTimeout(() => {
        mutationTimer = null;
        const quiz = findQuiz();
        if (!quiz) {
          lastQuizSignature = '';
          return;
        }
        const signature = `${quiz.question}|${quiz.text.slice(0, 160)}`;
        if (signature === lastQuizSignature) return;
        lastQuizSignature = signature;
        emitEvent('quiz', { score: quiz.score, question: quiz.question.slice(0, 200) });
      }, 900);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function ensureHud() {
    if (hudHost?.isConnected) return;
    hudHost = document.createElement('div');
    hudHost.id = HUD_ID;
    hudHost.style.cssText = [
      'all:initial',
      'position:fixed!important',
      'left:16px!important',
      'bottom:16px!important',
      'z-index:2147483647!important',
      'pointer-events:none!important'
    ].join(';');
    hudShadow = hudHost.attachShadow({ mode: 'open' });
    hudShadow.innerHTML = `
      <style>
        :host { all: initial; }
        .card {
          display: flex;
          align-items: flex-start;
          gap: 9px;
          box-sizing: border-box;
          width: 252px;
          padding: 11px 12px;
          border-radius: 12px;
          border: 1px solid rgba(148, 163, 184, .25);
          background: rgba(15, 23, 42, .93);
          color: #e2e8f0;
          font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
          box-shadow: 0 12px 32px rgba(2, 6, 23, .35);
          backdrop-filter: blur(10px);
          pointer-events: none;
          transition: opacity .2s ease, transform .2s ease;
        }
        .card[data-kind="watching"] { border-color: rgba(16, 185, 129, .35); }
        .card[data-kind="needs_user"] { border-color: rgba(245, 158, 11, .65); }
        .card[data-kind="error"] { border-color: rgba(239, 68, 68, .65); }
        .dot {
          width: 7px; height: 7px; border-radius: 50%;
          margin-top: 5px; flex: 0 0 auto;
          background: #38bdf8;
          box-shadow: 0 0 0 3px rgba(56, 189, 248, .16);
        }
        .card[data-kind="watching"] .dot { background: #34d399; box-shadow: 0 0 0 3px rgba(52, 211, 153, .16); }
        .card[data-kind="needs_user"] .dot { background: #fbbf24; box-shadow: 0 0 0 3px rgba(251, 191, 36, .16); }
        .card[data-kind="error"] .dot { background: #f87171; box-shadow: 0 0 0 3px rgba(248, 113, 113, .16); }
        .body { min-width: 0; flex: 1 1 auto; }
        .topline { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .brand { font-size: 10px; font-weight: 700; letter-spacing: .08em; color: #94a3b8; text-transform: uppercase; }
        .text { margin-top: 2px; color: #f8fafc; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .detail { margin-top: 2px; color: #94a3b8; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
        .stop {
          pointer-events: auto; flex: 0 0 auto; width: 20px; height: 20px;
          margin: -2px -2px 0 0; border: 0; border-radius: 6px;
          background: transparent; color: #94a3b8; cursor: pointer; font-size: 15px; line-height: 20px;
        }
        .stop:hover { background: rgba(148, 163, 184, .16); color: #fff; }
        .card.hidden { opacity: 0; transform: translateY(6px); }
      </style>
      <div class="card" data-kind="idle" role="status" aria-live="polite">
        <span class="dot"></span>
        <div class="body">
          <div class="topline"><span class="brand">FocusFlow</span></div>
          <div class="text"></div>
          <div class="detail"></div>
        </div>
        <button class="stop" title="停止 FocusFlow" aria-label="停止 FocusFlow">×</button>
      </div>
    `;
    hudShadow.querySelector('.stop').addEventListener('click', () => {
      const text = hudShadow.querySelector('.text');
      if (text) text.textContent = '正在停止…';
      sendRuntimeMessage({ type: 'FF_STOP' });
    });
    document.documentElement.appendChild(hudHost);
  }

  function applyHud(payload) {
    if (!hudEnabled || !payload) return;
    if (payload.hidden) {
      if (hudHost) hudHost.style.display = 'none';
      return;
    }
    ensureHud();
    if (!hudHost?.isConnected) return;
    hudHost.style.display = 'block';
    const card = hudShadow.querySelector('.card');
    const text = hudShadow.querySelector('.text');
    const detail = hudShadow.querySelector('.detail');
    const stop = hudShadow.querySelector('.stop');
    if (!card || !text || !detail) return;

    card.dataset.kind = payload.kind || 'idle';
    text.textContent = payload.text || '';
    detail.textContent = payload.detail || '';
    detail.style.display = payload.detail ? '-webkit-box' : 'none';
    stop.style.display = payload.kind === 'idle' ? 'none' : 'block';
    card.classList.remove('hidden');

    if (hudTimer) clearTimeout(hudTimer);
    const hideAfter = payload.kind === 'watching' ? 5500 : payload.kind === 'acting' ? 7000 : 0;
    if (hideAfter) {
      hudTimer = setTimeout(() => {
        card.classList.add('hidden');
      }, hideAfter);
    }
  }

  // A long-lived port keeps the MV3 service worker alive during a slow vision
  // request. The content script only needs to hold the connection open.
  try {
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== 'ff-keepalive') return;
      port.onMessage.addListener(() => {});
      port.onDisconnect.addListener(() => {});
    });
  } catch {
    // ignore
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;
    try {
      switch (message.type) {
        case 'FF_PING':
          sendResponse({ ok: true, url: location.href, isTop: window.top === window });
          return false;
        case 'FF_SNAPSHOT':
          sendResponse({ ok: true, snapshot: buildSnapshot() });
          return false;
        case 'FF_EXECUTE_ACTION':
          executeAction(message.action)
            .then((result) => sendResponse({ ...result, ok: true }))
            .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
          return true;
        case 'FF_CLICK_POINT':
          sendResponse(clickAtPoint(message.x, message.y, message.text || ''));
          return false;
        case 'FF_HUD':
          applyHud(message.payload);
          sendResponse({ ok: true });
          return false;
        default:
          return false;
      }
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
      return false;
    }
  });

  try {
    chrome.storage.local.get('ff_settings').then((stored) => {
      const settings = stored?.ff_settings;
      if (settings && typeof settings.hud === 'boolean') hudEnabled = settings.hud;
      if (!hudEnabled && hudHost) hudHost.remove();
    }).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.ff_settings) return;
      const settings = changes.ff_settings.newValue;
      if (settings && typeof settings.hud === 'boolean') {
        hudEnabled = settings.hud;
        if (!hudEnabled && hudHost) hudHost.remove();
      }
    });
  } catch {
    // storage may be unavailable in unusual frames
  }

  attachMediaEvents();
  observeQuiz();
})();
