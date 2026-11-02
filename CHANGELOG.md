# Changelog

All notable changes to FocusFlow are recorded here.

## [0.4.1] - 2026-11-02

### Fixed

- High-frequency polling: generic DOM mutations no longer trigger analysis.
  Structure events are limited to navigation, quiz, dialog and real catalog
  changes, with a 20-second cooldown; catalog changes are also debounced in the
  content script.
- Prevented a 5-second section-probe loop when clicking next does not change the
  page URL/title: after two stuck attempts the extension stops for confirmation.
- Prevented endless 2-second scroll probes after three coordinate scrolls.

## [0.4.0] - 2026-11-02

### Added

- Page-structure-first hybrid mode: click buttons/links/options through DOM
  `elementId` actions, with screenshot coordinates as the fallback.
- MutationObserver structure monitoring: SPA navigation, active chapter changes,
  new buttons/modals and quiz popups trigger an immediate analysis.
- Higher-resolution screenshots (minimum 1920px width) so small sidebar rows
  remain legible.

### Fixed

- Basic page button clicks work again: DOM actions are accepted by default and
  the model receives the current control list.
- Migrated the legacy vision-only setting and self-heal mode back to hybrid so
  existing installs are not forced into coordinate-only clicking.
- Native `next`/sidebar navigation is preferred again, with vision wheel
  scrolling kept as a fallback.

## [0.3.1] - 2026-11-02

### Added

- Local diagnostic log (`ff_logs`) recording every AI raw response, normalized
  decision, action plan, screenshot metadata, catalog state, execution result,
  errors and self-heal actions.
- Options-page log viewer with refresh, export and clear actions.
- Catalog guard: vision clicks on numbered sections are rejected when they do
  not match the next unfinished section, preventing accidental skip-ahead.

### Changed

- The prompt now receives current/next/completed section numbers as state
  context, while targets remain screenshot coordinates.

## [0.3.0] - 2026-11-02

### Added

- Pure-vision operating mode: every target is chosen from the screenshot and
  dispatched as a CDP coordinate click or mouse wheel. DOM `elementId` actions
  are no longer used.
- `scroll_at`: vision-coordinate mouse wheel, used to scroll the right-hand
  chapter directory and discover lazily rendered sections.
- Per-host visual learning memory (`ff_site_memory`): successful click/scroll
  targets and coordinates are reused as hints in later prompts.
- "Video sections only" mode: standalone chapter quizzes/exams are skipped
  instead of answered; PPT/document sections are skipped to the next video.
- Settings toggles for skipping standalone quizzes and learning site actions.

### Changed

- The click-mode setting is now fixed to pure vision; legacy DOM/hybrid values
  are ignored at runtime.
- At video end, the agent scrolls the directory before trusting a model's
  `courseComplete` judgment.

## [0.2.6] - 2026-11-02

### Fixed

- At the end of a video, an AI `courseComplete=true` no longer stops the
  session immediately. The extension first attempts the next section (including
  scrolling the directory); it stops as completed only if no next section is
  found.

## [0.2.5] - 2026-11-02

### Added

- Chapter-directory scrolling: the sidebar's own scroll container is walked
  from top to bottom (with short waits for lazy rendering) until the current
  section and the first subsequent incomplete section are found.
- Completed sections are skipped when choosing the next lesson.

### Fixed

- A directory that only renders the visible rows no longer causes a false
  “course complete”. If the next incomplete section is below the fold, it is
  discovered by scrolling the sidebar and then clicked.

## [0.2.4] - 2026-11-02

### Fixed

- At video end, an AI `ask_user` response no longer prevents the sidebar
  fallback. Unless the message is a hard blocker (login/captcha/settings), the
  extension attempts the next numbered section automatically.

## [0.2.3] - 2026-11-02

### Fixed

- Improved current-section detection for chapter directories: match
  `chapterId`/`sectionId` URL parameters first, accept a unique active/select
  class, and only then fall back to the highlighted row. This avoids treating
  every directory row with the same class as the current section.

## [0.2.2] - 2026-11-02

### Fixed

- A completed video with no top “下一节” button is no longer treated as the
  end of the course. The extension now finds the highlighted section in the
  right-hand chapter directory and clicks the next numbered section (e.g.
  1.4 → 1.5), including a DOM fallback when the model does not click it.
- The sidebar fallback never runs while an active quiz is visible.

## [0.2.1] - 2026-11-02

### Fixed

- Self-heal now reloads the page at most once for a content-script failure,
  preventing an infinite reload loop.
- Self-heal persistence failures no longer abort a running automation cycle.

## [0.2.0] - 2026-11-02

### Added

- Visual-coordinate clicking from screenshots, with `chrome.debugger`/CDP
  trusted mouse events, plus a content-script `elementFromPoint` fallback.
- Selectable click strategies: hybrid, vision-only, DOM-only.
- Adaptive quiz verification: after answering, re-check after a short interval;
  wrong answers continue with another attempt, correct/disappeared quizzes return
  to the normal capture interval.
- PPT/document and other no-video sections advance automatically to the next
  section, with short probes to avoid skipping a video that is still loading.
- Course-completion detection (`courseComplete` + page text + missing next
  section) with a `completed` state, notification, and automatic stop.
- Unattended auto-start on course pages (enabled by default), including
  navigation, tab activation, extension reload, and browser startup.
- Per-host self-diagnosis and strategy adaptation:
  - switches vision ↔ DOM after repeated click failures;
  - backs off capture frequency after HTTP 429/5xx;
  - retries quiz/needs-user cases with an alternate strategy;
  - reloads the page once when the content script is unavailable;
  - surfaces the latest diagnosis in the popup and diagnostics.
- Local `dev`/`release` git flow, release script, and this changelog.

### Changed

- Default cadence remains 45 seconds; quiz verification defaults to 4 seconds.
- Course completion no longer requires a manual “continue” click.
- Settings include auto-start and self-repair toggles.

### Fixed

- Video.js play-button lookup no longer searches inside the `<video>` element.
- Unknown video duration no longer counts as “ended”.
- Persistent debugger attachment keeps the viewport stable between screenshot
  and coordinate click.
- Stale debugger-unavailable state is cleared at the start of each session.

## [0.1.0] - 2026-10-25

- Initial local MV3 prototype: timed screenshots, multimodal decision JSON,
  play/next/quiz actions, alarms, HUD, and options page.
