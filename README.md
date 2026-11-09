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
  <a href="https://github.com/casi-3/peek/releases"><img src="https://img.shields.io/badge/release-v0.6.0-3ddc84" alt="Release" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-555" alt="Platforms" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
</p>

<p align="center">
  <img src="docs/demo.gif" width="720" alt="Peek overlay demo" />
</p>

## Features

- Live WebRTC feed (sub-second latency) the instant Frigate detects something
- Also pops up for Frigate audio detections (crying, yelling, and the like), not just tracked objects
- Shows the detected object, score, recognized face, license plate, and entered zones
- Optional instant snapshot so there is no black frame while the live feed connects
- Menu bar app: pick which cameras notify, toggle sound, set the dismiss delay
- Pause pop-ups for 30 minutes, 1, 3 or 6 hours, or the rest of the day
- Global keyboard shortcut (default `Ctrl+Alt+Z`) opens a live view of one camera or a grid of several, on demand
- Frameless, always-on-top, translucent card that slides in and out
- Cross-platform: macOS and Windows
- Connects to your existing MQTT broker and Frigate, no server-side change
- Optional HTTPS, including a reverse proxy on port 443; certificates are verified against the system trust store, with an opt-in for self-signed certificates
- Optional update checks, off by default, with a notification and an installer

## How it works

```
Frigate ──(MQTT frigate/events + frigate/<camera>/audio/<type>)──► main process ──IPC──► overlay window
   │                                                                                        │
   └──(WebRTC via /live/webrtc/api/ws)──────────────────────────────────────────────────────┘
```

Audio detections publish separately from tracked-object events, on a per camera
`frigate/<camera>/audio/<type>` topic with an `ON` and `OFF` payload, so Peek listens
on both. Newly seen audio labels appear in the **Audio labels** tray menu, where you
can enable or disable individual ones to match your Frigate `audio.listen` config, the
same way individual cameras can be toggled.

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
| `frigateUrl` | Base URL of Frigate, e.g. `http://host:5000`, `https://host:8971` for the authenticated port, or `https://host:443` behind a reverse proxy |
| `frigateUser` | Frigate username for the authenticated port (optional) |
| `frigatePassword` | Frigate password for the authenticated port (optional) |
| `frigateAllowSelfSigned` | Accept a certificate your system does not trust (optional, HTTPS only) |
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

### HTTPS and authenticated Frigate

Tick **Connect over HTTPS** in the setup window when Frigate is served over
TLS, for example behind a reverse proxy on port 443, or on Frigate's own
authenticated port (usually 8971). HTTPS is independent of login: a reverse
proxy that terminates TLS in front of an otherwise open Frigate needs the
checkbox but no username.

If your Frigate itself requires login, also add your Frigate username and
password. Peek then logs in and loads snapshots and the live stream over
HTTPS. Leave the username and password empty for an open port 5000 or an
unauthenticated reverse proxy.

Peek verifies HTTPS certificates against your system trust store, so a
certificate from a certificate authority such as Let's Encrypt works with no
extra setup and renews freely. If your Frigate uses a self-signed
certificate, tick **Allow self-signed certificate**; Peek then accepts that
certificate for your Frigate host.

### Zone filter

To pop up only for objects in certain Frigate zones, such as a driveway, pick
them under **Only pop up in zones** in the tray menu, or in **Settings…** under
**Notifications**. Peek lists the zones from your Frigate config.

- With no zone picked, Peek pops up anywhere, as before.
- With zones picked, an object pops up the moment it enters one of them, even if
  Frigate first saw it somewhere else.
- Zone names match regardless of case, and a name shared by several cameras
  counts for all of them.
- Audio detections have no zone, so they stop popping up while a zone filter is
  set.

### Pausing pop-ups

Pick a time under **Pause pop-ups** at the top of the tray menu: 30 minutes,
1 hour, 3 hours, 6 hours or **Rest of today** (until midnight). A card on
screen slides away, and the menu shows when pop-ups come back.

- Pick **Resume pop-ups** to end the pause early, or pick another time to
  replace it.
- The pause covers object and audio detections. The live view shortcut still
  works.
- The pause survives a restart of Peek.

### Live view shortcut

Press `Ctrl+Alt+Z` (`Cmd+Option+Z` on macOS) from any app to open a live view
without waiting for a detection. Press it again, or click the close button, to
hide it. The shortcut is also on the tray menu as **Show live view**.

- Pick the cameras under **Live view cameras** in the tray menu, or in
  **Settings…** under **Live view**. One camera opens a single feed; several
  open a grid sized to fit your screen.
- Change or clear the shortcut in **Settings…**: click the shortcut box and
  press the new keys. Peek warns you if another app already holds them.
- A new detection replaces the live view with the usual notification card.
- Clicking a tile opens that camera in Frigate, unless **Click notification to**
  is set to **Do nothing**.

The shortcut is global, so while Peek runs it takes that key combination away
from every other app. On keyboard layouts where `Ctrl+Alt` acts as `AltGr`,
`Ctrl+Alt+Z` may type a character (for example `ż` on Polish layouts); pick
another combination if so.

### Updates

Peek can check GitHub for new releases and update from inside the app. This is
off by default, so Peek makes no outside connection unless you enable it in the
setup window or the menu bar. When on, it shows a notification and an installer,
and you can skip a version.

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

## Troubleshooting

### macOS: "Peek is damaged and can't be opened"

Builds before 0.3.1 had a broken signature seal that macOS reports as "damaged"
on Apple Silicon once the download is quarantined. Update to 0.3.1 or later. For
a copy already downloaded, clear the quarantine flag after moving the app to
Applications:

```bash
xattr -dr com.apple.quarantine /Applications/Peek.app
```

### macOS: the menu bar icon is hidden behind the notch

On Macs with a notch, macOS can place the menu bar icon behind it once the bar
is full, leaving Settings out of reach. Launch Peek again from Spotlight or the
Applications folder to reopen Settings, or enable "Keep an icon in the Dock" in
Settings for a permanent entry point.

## Credits

Live streaming uses the [go2rtc](https://github.com/AlexxIT/go2rtc) `video-rtc`
web component (MIT), vendored in `src/renderer/vendor`.

## License

MIT
