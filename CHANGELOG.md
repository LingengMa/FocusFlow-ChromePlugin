# Changelog

All notable changes to FocusFlow are recorded here.

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
