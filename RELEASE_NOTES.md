## What's new in v0.7.1

Reliability and quality-of-life fixes.

- The overlay stays on its chosen monitor after a reboot, even when Windows renumbers the display.
- Peek retries loading the Frigate config with a backoff until it succeeds, so starting at login before the network is up no longer leaves camera discovery guessing.
- The overlay window rebuilds itself if its renderer crashes or fails to load, instead of silently swallowing pop-ups until a restart.
- Right-click a pop-up or live view to open the tray menu at the pointer. A pop-up's dismiss countdown waits while the menu is open.
- On Windows with several virtual desktops, the overlay is brought back to the front before each pop-up or live view, so it no longer opens hidden behind another window.

Thanks to @louispires for all of these.
