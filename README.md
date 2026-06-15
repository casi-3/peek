<p align="center">
  <img src="build/icon.png" width="120" alt="Peek" />
</p>

<h1 align="center">Peek</h1>

<p align="center">
  A lightweight desktop overlay that pops a live camera feed in the corner of your
  screen the moment <a href="https://frigate.video">Frigate</a> detects an object —
  like the camera notifications on a TV, but for your computer.
</p>

<p align="center">
  <a href="https://github.com/casi-3/peek/releases"><img src="https://img.shields.io/badge/release-v0.3.0-3ddc84" alt="Release" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-555" alt="Platforms" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
</p>

<p align="center">
  <img src="docs/demo.gif" width="720" alt="Peek overlay demo" />
</p>

## Features

- Live WebRTC feed (sub-second latency) the instant Frigate detects something
- Shows the detected object, score, recognized face, license plate, and entered zones
- Optional instant snapshot so there is no black frame while the live feed connects
- Menu bar app: pick which cameras notify, toggle sound, set the dismiss delay
- Frameless, always-on-top, translucent card that slides in and out
- Cross-platform: macOS and Windows
- Connects to your existing MQTT broker and Frigate — no server-side change

## How it works

```
Frigate ──(MQTT frigate/events)──► main process ──IPC──► overlay window
   │                                                          │
   └──(WebRTC via /live/webrtc/api/ws)────────────────────────┘
```

## Requirements

- [Node.js](https://nodejs.org) 18+ (to run from source)
- A running Frigate instance with MQTT enabled

## Setup

On first launch a setup window opens automatically and asks for your Frigate
host and MQTT broker details — no file editing required. The settings are saved
to the app's user data folder and can be changed anytime from the menu bar
(**Settings…**).

To configure from source or by hand instead:

```bash
npm install
cp config.example.json config.json
```

Edit `config.json`:

| Key | Description |
| --- | --- |
| `mqtt` | MQTT connection string, e.g. `mqtt://user:pass@host:1883` |
| `frigateUrl` | Base URL of Frigate, e.g. `http://host:5000` |
| `topicPrefix` | Frigate MQTT topic prefix (default `frigate`) |
| `cameras` | Map of camera name to display name. Leave `{}` to show all cameras |
| `labels` | Only notify for these labels, e.g. `["person", "car"]`. Empty = all |
| `minScore` | Ignore detections below this score (0–1) |
| `corner` | `top-right`, `top-left`, `bottom-right`, `bottom-left` |
| `margin` | Distance from the screen edge, in pixels |
| `width`, `height` | Overlay size in pixels |
| `dismissSeconds` | Seconds to keep the card after the event ends |

When packaged, `config.json` is read from the app's user data folder (use the
**Open config folder** menu item to locate it).

## Run

```bash
npm start
```

## Build

```bash
npm run dist        # current platform
npm run dist:mac    # macOS .dmg + .zip
npm run dist:win    # Windows installer + portable
```

Tagging a release (`git tag v0.1.0 && git push --tags`) builds macOS and Windows
on CI and attaches the binaries to a GitHub Release.

## Credits

Live streaming uses the [go2rtc](https://github.com/AlexxIT/go2rtc) `video-rtc`
web component (MIT), vendored in `src/renderer/vendor`.

## License

MIT
