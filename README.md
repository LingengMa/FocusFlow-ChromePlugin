# FocusFlow · Chrome 网课助手

一个 Chrome Manifest V3 扩展：定时截取当前课程页，把截图和页面结构交给多模态模型判断，然后直接在**你正在使用的 Chrome** 里继续播放、作答或切换下一节。

它不启动新的无头浏览器，而是复用当前 Chrome 配置、Cookie 和登录状态，因此可以直接操作已经登录的网课平台。

> 默认模型名是需求中指定的 `deepseek-v4.1-flash`。实际可用名称、接口地址和是否支持图片输入以你的服务商为准；如果测试连接失败，请换成支持视觉的 OpenAI 兼容模型。

---

## 能做什么

| 场景 | 行为 |
| --- | --- |
| 视频暂停 / 被弹窗遮挡 | AI 判断后点击播放，或点击页面里的播放按钮 |
| 出现随堂练习 / 弹题 | 读取截图与页面文本，按视觉坐标选择选项/填写答案；提交后数秒自动复查，答错继续选，答对恢复常规间隔 |
| 视频结束 | 优先点“下一节 / 继续学习”；没有顶部按钮时，在右侧目录点击当前节下面第一个未完成的节（如 1.4 → 1.5），目录未加载完会自动下滑 |
| 当前节是 PPT / 文档 / 无视频 | 连续确认无视频后自动点击“下一节”，继续检查下一节 |
| 所有视频节完成 | 自动停止，状态标记为“已完成”并发送通知 |
| 页面卡住 / 缓冲 | 等待，不连续点击 |
| 题目看不清 / 点击失败 / 接口限流 | 自诊断后切换视觉/DOM 策略、放慢频率并重试，不要求人工确认 |
| 验证码 / 登录 / 权限 / 支付 | 无法替代人工，停止并发送 Chrome 通知 |

所有决策由模型输出严格 JSON，扩展只执行白名单动作（归一化坐标点击、文字输入、受限 DOM 动作），不执行模型生成的 JavaScript、CSS 选择器或任意 URL。

“自诊断/自动修复”只调整本地策略参数（点击模式、截屏间隔、重试节奏），不会修改扩展源码，也不会下载或执行远程代码；这符合 MV3 的 CSP 和安全边界。

## 工作原理

```
┌──────────────────────────── Chrome 扩展 ────────────────────────────┐
│                                                                      │
│  popup / options ──设置、启动、停止────────────────┐                │
│                                                    ▼                │
│  service worker（编排器）                                        │
│    │ 1. 聚焦目标标签页                                            │
│    │ 2. chrome.tabs.captureVisibleTab 截屏                        │
│    │ 3. 向所有可访问 frame 收集页面快照                            │
│    │ 4. POST 截图 + 页面 JSON 到多模态模型                         │
│    │ 5. 解析 JSON → 权限校验 → 生成动作计划                        │
│    ├─ 视觉坐标动作 → chrome.debugger / CDP 真实鼠标事件             │
│    ▼                                                               │
│  content script（每个 frame 一份）                                 │
│    · 读取 video 状态、答题弹窗、可操作元素                         │
│    · 执行 play / pause / click / choose / type / submit / next     │
│    · 无 debugger 时回退 elementFromPoint 坐标点击                  │
│    · 左下角 HUD，可一键停止                                        │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 触发方式

- **自动启动**：打开/切回课程页、扩展重新加载、浏览器启动时，只要识别为课程页且有 API Key，就自动开始，无需点击扩展图标。
- **定时巡检**：默认每 45 秒一次（Chrome alarms 最小 30 秒）。
- **事件触发**：视频暂停、结束、缓冲，或 DOM 中出现疑似答题弹窗时，立即追加一轮分析。
- **短周期**：答题后 4 秒复查；PPT/无视频和切换下一节后 5 秒复查。
- **紧急手动触发**：popup 的“立即分析”和停止按钮仍保留作为兜底，但正常无人值守流程不依赖它们。

### 无人值守与自诊断

正常流程默认全自动：

- 自动启动、自动续播、自动答题、答错自动重选、自动下一节、PPT 自动跳过、课程结束自动停止。
- `selfHeal` 开启时，扩展会按域名记录执行结果并自动调整：
  - 视觉坐标连续失败 → 临时切到 DOM 点击；
  - DOM 点击连续失败 → 临时切到视觉坐标；
  - 模型接口 429/5xx → 自动放慢截屏频率并重试；
  - 答题连续失败 → 切换点击策略后继续；
  - AI 要求人工确认但属于可重试场景 → 切换策略自动重试；
  - 页面脚本失联 → 自动刷新页面一次并重试。
- 诊断结果保存在本地 `ff_self_heal`，popup 显示“自诊断：…”，诊断导出中也包含最近一次自诊断。
- 验证码、登录、权限、支付、删除等无法安全代替的操作仍会停止并通知，这是唯一保留的人工环节。

### 动作协议

模型必须返回类似：

```json
{
  "observation": "视频暂停，屏幕中央出现单选题",
  "state": "quiz",
  "courseComplete": false,
  "confidence": 0.91,
  "reason": "题目和三个选项均清晰可见",
  "quiz": { "detected": true, "question": "1+1=?", "answerSummary": "B. 2" },
  "actions": [
    { "type": "click_at", "bbox": [0.18, 0.62, 0.46, 0.68], "target": "B. 2" },
    { "type": "click_at", "bbox": [0.56, 0.86, 0.66, 0.91], "target": "提交答案" }
  ]
}
```

可用动作：`click_at`、`type_at`、`play`、`pause`、`click`、`choose`、`type`、`submit`、`next`、`wait`、`ask_user`。`seek` 会被策略层拒绝，避免触发“不可拖拽/观看 100%”平台的无效判定。

`click_at` 使用归一化 bbox（截图左上角 `0,0`，右下角 `1,1`），扩展取 bbox 中心映射到页面 viewport；`type_at` 先坐标点击输入框，再通过 CDP `Input.insertText` 输入文字。视觉目标会被危险文本策略检查（支付、删除、退课、退出、重播、上一节等）。

### 点击方式

设置页提供三种模式：

- **视觉坐标 + DOM 兜底（默认）**：播放、下一节、选项、提交优先用 `click_at`；目标难以框选时用 `elementId`。
- **仅视觉坐标**：适合不稳定的播放器/页面结构，所有点击依赖截图定位。
- **仅 DOM 元素**：旧模式，不申请坐标点击。

视觉坐标执行链路：

```
截图（captureVisibleTab）
  → 模型返回归一化 bbox
  → 取中心映射到 snapshot.viewport 的 CSS 像素
  → chrome.debugger attach（启动时一次，运行期间保持）
  → CDP Input.dispatchMouseEvent
  → 下一轮截图验证
  → 停止时 detach
```

视觉模式启动时会先附加 debugger，让浏览器的调试提示条/页面 viewport 在截图前稳定下来；否则截图和点击之间发生 reflow，坐标会偏。DevTools 已经打开时附加会失败，此时回退到 content script 的 `elementFromPoint` 坐标点击（同源 iframe 可用）。

### 答题后自动复查

选择题答错后通常需要重新选择，所以答题动作完成后会进入一个临时的短周期：

1. 提交/选择答案后，默认 **4 秒**后再截屏一次（设置页可调 2–30 秒）。
2. 模型检查页面反馈：
   - `quiz.correct=false` 或页面提示“回答错误/再试一次” → 继续选另一个选项并提交；
   - `quiz.correct=true` 或答题框消失 → 回到常规截屏间隔；
   - 没有明确反馈 → 继续短周期复查。
3. 连续复查 6 次仍未通过时停止自动提交，发通知让你手动检查，避免无限循环和持续消耗 API。

短周期使用内存定时器，并额外设置一个 30 秒 alarm 兜底；即使 MV3 worker 休眠，也会恢复复查。

### PPT / 无视频节与课程完成

- 当前节没有 `<video>`（例如 PPT、文档、图文阅读）时，会先做一次 5 秒短周期确认，避免把仍在加载的视频误判为无视频。
- PPT/文档页连续两次确认仍无视频，会自动点击“下一节”；普通无视频页面会多等一次（避免视频 iframe 还在加载）。成功切换后 5 秒再检查下一节，直到遇到视频、答题或课程结束。
- 右侧目录只渲染当前屏幕的一部分时，扩展会滚动目录自身（不是整个网页）逐段扫描，找到当前节和后面的第一个未完成节；已完成的节会被跳过。
- 如果页面明确显示“所有视频节/任务点已完成”“没有更多章节”“课程已学完”等，模型设置 `courseComplete=true`，扩展自动停止并标记为 **已完成**。
- 只有顶部按钮和滚动后的目录都找不到下一节时，才按“所有视频节已完成”停止，而不是反复报错。
- 自动停止后 HUD/通知显示“课程已完成”，不再按常规间隔继续调用模型。

安全约束：

- DOM 动作的 `elementId` 必须来自当前页面快照；模型编造的 ID 会被拒绝。
- 视觉动作必须同时给出归一化 bbox 和 target 描述；target 含支付、删除、退课、退出、重播、上一节等危险词时会被拦截。
- 密码框、支付、删除、退课、下载、分享、退出登录等控件会被拦截。
- 答题/提交必须有可见答题界面，且置信度达到阈值；否则停止并通知。
- 页面文字被明确标记为“不可信数据”，模型不得把网页里的文字当作指令（防提示注入）。
- 扩展不会读取或发送 `input[type=password]` 的值。

## 为什么用 Chrome 扩展，而不是 Playwright

- **直接复用当前登录态**：不需要复制 Chrome profile、导出 Cookie 或重新登录，适合学校/企业 SSO。
- **和用户看到的是同一个浏览器**：截图、点击、播放状态都来自真实页面，不会出现无头浏览器与真实页面不一致。
- **代价**：只能操作页面/标签页，不能控制操作系统级窗口；`captureVisibleTab` 要求目标标签页处于前台，因此会周期性把课程页切回前台。
- **视觉坐标 + CDP**：截图坐标由模型给出，`chrome.debugger` 发送真实鼠标事件，因此可以跨 iframe、操作 Video.js/Canvas 播放器；这需要 `debugger` 权限，Chrome 会显示调试提示。

如果平台使用极严格的防作弊检测，扩展无法绕过；这属于预期边界。

## 针对“任务点 / 100% 观看”平台的适配

参考页面是典型的超星/学习通类课程页：显示“任务点”“观看时长 ≥ 总时长的 100%”，并明确提示 **不可倍速、不可拖拽、观看时不可离开或最小化**。这类页面最容易因为扩展抢焦点而暂停计时，因此当前版本做了以下处理：

- **不主动拖拽、不改变倍速**；`next` 和“下一节”点击只有在视频真正结束/接近末尾时才允许。
- **温和聚焦**：只有目标标签页不活跃或窗口未聚焦时才切换，避免每轮都触发一次 focus 事件。
- **自动关闭弹窗**：点击启动后约 1 秒关闭扩展 popup，让焦点回到课程页；运行中建议用页面左下角 HUD 的 `×` 停止。
- **可见性事件**：标签页被切走或最小化时，content script 会发出 `visibility` 事件，扩展立即把课程页切回前台并重新观察。
- **左下角 HUD**：避开页面右下角的“AI 助教”入口；截图时会临时隐藏 HUD，避免遮挡题目。

仍建议：启动后不要主动切换标签页、不要最小化 Chrome、不要把扩展 popup 长时间停留在前台。平台若弹出“已离开页面/视频已暂停”，AI 会尝试点击“继续学习/继续播放”；如果平台使用更严格的防作弊检测，扩展可能无法绕过，这属于预期边界。

### 超星页面实测结构

根据实际诊断数据，当前课程页的结构是：

- 顶层 frame：`mooc1.chaoxing.com/mycourse/studentstudy`，包含“下一节 / 上一节”和右侧目录；
- 视频 frame：`mooc1.chaoxing.com/ananas/modules/video/index.html`，播放器是 Video.js，`<video id="video_html5_api" class="vjs-tech">`；
- 初始状态 `duration=0, readyState=0`，说明视频元数据还没加载，播放按钮是 `button`，文案“播放视频”；
- 结束时 `currentTime=duration=459.4, ended=true`，视频 frame 内出现“重播 / 播放速度 / 静音 / 设置”；
- “下一节”在顶层 frame，且可能不是 `button`/`a[href]`，所以扩展增加了文本节点扫描和 `[class*=next]` 捕获。

针对这个结构，当前版本会：优先点击 Video.js 大播放按钮；在 `duration=0` 时禁止 `next`；只在 `ended` 或最后 1 秒允许下一节；在视频 frame 找不到“下一节”时自动回退到顶层 frame 的文本扫描。

## 安装

1. 打开 Chrome，访问 `chrome://extensions/`。
2. 右上角开启 **开发者模式**。
3. 点击 **加载已解压的扩展程序**。
4. 选择本项目目录：`chrome-plugin`。
5. 首次安装会自动打开设置页。也可以点击扩展图标 → “设置”。
6. 因为启用了视觉坐标点击，Chrome 会显示 `debugger` 权限提示；更新扩展后如果被禁用，重新加载并在提示中接受权限即可。

## 配置模型

在设置页填写：

- **Base URL**：OpenAI 兼容地址，例如 `https://api.deepseek.com/v1`。扩展会自动追加 `/chat/completions`；也可以直接填完整的 `.../chat/completions`。
- **模型名称**：默认 `deepseek-v4.1-flash`，按服务商实际名称修改。
- **API Key**：只保存在本机 `chrome.storage.local`，请求由浏览器直接发往你填写的接口。
- **测试连接**：会发送一张 64×64 测试图和一句短提示，确认接口与视觉输入都可用。

如果服务商不支持 `response_format: json_object`，扩展会在收到 400 时自动去掉该参数重试。

## 使用

1. 在 Chrome 中登录课程平台，打开视频页面。
2. 点击 FocusFlow 图标，确认目标标签页是课程页，点击 **开始观看当前标签页**。
3. 保持 Chrome 窗口可见。扩展会在每轮截屏前把目标标签页切到前台（可在设置中关闭，但 `captureVisibleTab` 要求标签页可见）。
4. 左下角 HUD 显示 AI 正在做什么；点 `×` 或按 `Alt+Shift+S` 可随时停止。
5. 如果 AI 需要你确认，会停止自动操作并弹出 Chrome 通知。

> **首次建议开启“演示模式”**：仍然截屏、请求 AI、记录决策，但不会点击页面。确认决策合理后再关闭。

## 验收清单

加载扩展后，按顺序检查：

1. 设置页“测试连接”返回成功；失败时确认接口是 OpenAI 兼容且支持 `image_url`。
2. 打开演示课，点击扩展图标，目标卡片显示课程标题。
3. 启动后 1–3 秒内截图出现，HUD 显示“AI 正在看屏幕…”。
4. 播放到 5 秒出现答题框，AI 选择答案并提交，视频继续。
5. 视频结束出现“下一节”，AI 自动切换。
6. 按 `Alt+Shift+S` 或 HUD 的 `×` 能立即停止。
7. 在设置里关闭“自动提交”，确认 AI 只选答案，然后通知你手动提交。
8. 开启“演示模式”，确认只记录决策、不点击页面。

## 如何提供课程页信息

最省事的方式是用扩展内置的“页面诊断”：

1. 打开课程页，停在需要分析的状态（初始暂停、弹题出现、视频结束）。
2. 点击扩展图标，在 popup 里点击 **复制页面诊断**。
3. 直接粘贴到对话里；如果剪贴板不可用，会自动下载 `focusflow-diagnostics.json`，把文件发来即可。

诊断内容包括：课程页 URL（去掉 query）、iframe 列表、`<video>` 的 id/class/尺寸/进度、答题容器与选项、可操作元素标签。**不包含截图、Cookie、API Key、密码或 input 的值**。文本样本可能包含姓名/学号，分享前请自行删改。

如果还想提供截图，建议三张：暂停初始页、弹题出现时、视频结束/下一节按钮出现时。保留右侧章节目录，方便判断任务点结构。

### 手动方式（扩展无法运行时）

在课程页按 F12 → Console，输入：

```js
(() => {
  const v = document.querySelector('video');
  return {
    url: location.href,
    title: document.title,
    iframes: [...document.querySelectorAll('iframe')].map((f) => f.src),
    video: v ? {
      id: v.id, className: String(v.className), duration: v.duration,
      currentTime: v.currentTime, paused: v.paused, ended: v.ended,
      readyState: v.readyState, rect: v.getBoundingClientRect().toJSON()
    } : null,
    dialogs: [...document.querySelectorAll('dialog,[role="dialog"],[class*="modal"],[class*="popup"],[class*="quiz"],[class*="question"],[class*="timu"]')]
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .slice(0, 10)
      .map((e) => ({ tag: e.tagName, id: e.id, className: String(e.className), text: e.innerText.slice(0, 600) }))
  };
})()
```

如果视频在跨域 iframe 中，顶部 Console 读不到内部 DOM：在 DevTools Console 左上角的执行上下文下拉框里切换到对应 frame，再运行一次；或者直接用扩展的“复制页面诊断”，它会遍历所有可访问 frame。

答题弹窗还可以右键 → 检查 → 右键该节点 → Copy → Copy outerHTML，单独发来。

> 不要提供 Cookie、`Authorization`、API Key、密码、完整身份证/学号。遇到 URL 里的 `token=`、`session=` 等参数，请先删掉再发。

## 本地演示课

仓库自带一个可交互的模拟课程页，用来验证截屏、答题、下一节：

```powershell
# 在项目根目录启动静态服务器
python -m http.server 8000

# 打开
# http://127.0.0.1:8000/demo/mock-course.html
```

页面行为：

- 视频播放到第 5 秒暂停并弹出单选题；
- 答对后自动继续；
- 视频结束后显示“下一节”；
- 支持载入本地 MP4，方便离线测试。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存设置、运行状态、最近一次决策；API Key 仅在本机 |
| `tabs` | 读取目标标签页、切换前台、截图 |
| `scripting` | 对安装扩展前已打开的页面补注入 content script |
| `alarms` | 定时巡检；Chrome 后台 service worker 可能休眠，alarm 负责唤醒 |
| `webNavigation` | 枚举跨域 iframe，读取视频/答题所在的子 frame |
| `notifications` | 需要人工确认或连续失败时提醒 |
| `debugger` | 视觉坐标点击：通过 Chrome DevTools Protocol 发送真实鼠标事件，可跨 iframe；仅作用于当前课程标签页，运行结束时断开 |
| `<all_urls>` | 在课程页读取 DOM、执行动作、调用 `captureVisibleTab`；向任意 OpenAI 兼容接口发请求。扩展自身仍只接受 http/https 课程页 |

视觉模式下 `debugger` 会在启动时附加到当前课程标签页并保持到停止，避免 Chrome 调试提示条在截图和点击之间改变页面 viewport。它不会读取浏览器历史、书签、密码或下载内容。Chrome 在附加期间会显示调试提示；如果 DevTools 已经打开，扩展会自动回退到 content script 坐标点击。

## 已知限制

- **必须保持 Chrome 窗口可见**：`chrome.tabs.captureVisibleTab` 截取当前窗口的活动标签页。扩展会在每轮把目标页切回前台，这会抢焦点。
- **跨域 iframe**：视觉坐标 + CDP 可以点到跨域 iframe；如果 debugger 回退到 content script，则只能处理同源 iframe。Chrome 内部页面、扩展商店、沙箱 iframe 不可操作。
- **DRM / Canvas 播放器**：截图可能黑屏；视觉坐标需要能看见目标。CDP 点击本身可操作 Canvas，但黑屏时模型无法定位。
- **`isTrusted` 校验**：视觉模式使用 CDP，点击是真实事件；只有 debugger 回退到 content script 时才可能被播放器拒绝。
- **答题准确率**：模型可能看错题目或选项。默认置信度阈值 72%；开启自诊断后，低置信/连续答错会切换策略自动重试，仍无法通过时才停止并通知。
- **费用**：每次分析都会发送一张压缩截图和页面文本，按服务商计费。可在设置中降低截图宽度/质量、拉长间隔；接口 429/5xx 时自诊断会自动放慢频率。
- **页面结构变化**：视觉坐标不依赖 class/role，可直接框选；答题文字仍会读取页面文本，若平台使用特殊 Shadow DOM，视觉模型仍可读截图，但字太小/太密时准确率会下降。
- **坐标漂移**：从截图到点击有几秒延迟；页面滚动、弹窗动画或布局变化可能让坐标偏掉。点击失败会被自诊断记录，连续失败后自动切换 DOM 模式。
- **自动答题合规性**：请只在你被允许自动化的课程中使用。很多平台禁止代刷、代答，违规可能导致成绩或账号风险。本项目不提供反检测、绕过监考或破解 DRM 的能力。

## 开发与测试

项目无第三方运行时依赖，纯原生 JS，加载已解压目录即可。

```powershell
# 单元测试（纯函数：配置、协议解析、权限规划、提示词）
node tests/all.mjs

# 结构检查：manifest、资源引用、相对 import
node tools/check.mjs
```

主要文件：

```
manifest.json
background/
  service-worker.js   编排、消息、alarm、错误处理
  ai.js               多模态请求、重试、JSON 修复
  prompt.js           系统提示词与页面上下文
  capture.js          截屏与等比缩放
  tabs.js             frame 聚合、viewport、全局 elementId、消息路由
  pointer.js          CDP 坐标点击/文字输入 + content 回退
  executor.js         顺序执行动作、视觉坐标映射
  self-heal.js        按域名记录执行结果、切换策略、接口退避
  state.js            runtime 持久化与 badge
content/content.js    页面快照、答题检测、DOM 动作、HUD
shared/
  defaults.js         设置默认值/归一化/域名白名单
  ai-protocol.js      JSON 解析、动作校验
  planner.js          权限与安全策略、动作计划
  quiz-followup.js    答题后短周期/重试节奏
  course-state.js     无视频、下一节、课程完成判断
  course-detect.js    自动启动的课程页识别
popup/                快捷控制面板
options/              模型与策略设置
demo/                 可交互模拟课程
tests/                node:test 单元测试
```

### 自诊断与调试

- 正常无人值守不需要导出诊断；扩展会按域名自动记录失败并调整策略。
- popup 会显示最近一次自诊断；`chrome.storage.local` 的 `ff_self_heal` 保存按域名的策略覆盖和退避状态。
- 每次决策保存在 `ff_runtime`，最近截图在 session 的 `ff_last_shot`。诊断导出已不包含截图/Cookie/API Key。
- 如果提示“无法连接页面脚本”，自诊断会自动刷新一次；仍失败时检查扩展是否被禁用。
- 如果首次播放被浏览器自动播放策略拦截，这是 Chrome 的限制；扩展会在可见页面上尝试点击播放，但个别平台仍要求一次真实用户手势。
- 如果 401/403，检查 Key、模型权限和账户余额；这类错误不会自动重试。

### 版本与本地发布

- 当前版本见 `manifest.json` / `package.json`，更新记录见 [CHANGELOG.md](CHANGELOG.md)。
- 本地仓库使用 `dev` 和 `release` 两个分支，不连接远端。
- 发布流程见 [RELEASE.md](RELEASE.md)，执行 `tools/release.ps1` 完成合并和本地 tag。

## Roadmap

- 点击后自动截图对比，坐标偏移时自动重试一次。
- 两阶段视觉定位：先粗定位区域，再裁剪放大确认精确 bbox。
- Shadow DOM / Canvas 答题适配器。
- 按课程配置选择器模板（下一节、提交、选项）。
- 本地 Whisper/字幕理解，补充纯视觉无法听到的讲课内容。
- 多标签页课程队列。
