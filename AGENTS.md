# Agent instructions

## UI testing and screenshots

There is a known Codex Desktop bug in version `26.707.8479.0` on this Windows
workspace. The in-app Browser screenshot path can terminate and restart the
entire Codex Desktop application.

- Do not call the in-app Browser `tab.screenshot()` function in this project.
- Do not use the Browser image-emission path as part of screenshot testing.
- Browser DOM inspection and normal interaction may be used, but stop if the
  browser session reports routing or ownership errors.
- For visual regression and UI iteration, use a separate headless Chromium
  process and save PNG files directly to the filesystem. Inspect those files
  separately instead of sending screenshot bytes through the in-app Browser.
- Before using the in-app Browser screenshot path again, confirm that Codex
  Desktop has been updated and explicitly retest the known issue with the user.

Observed failure signature on 2026-07-14:

- The app restarted twice immediately after a Browser screenshot call.
- No PNG was written before the restart and no Windows or Crashpad dump was
  produced.
- Codex logs contained `No ChatGPT browser route is available for browser
  session` and mapped the active task to a temporary `client-new-thread` route.

This is a Codex Desktop/browser-session issue, not evidence of a crash in the
OpenFront Party application.
