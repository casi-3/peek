# Peek

A lightweight desktop overlay that pops a live camera feed in the corner of your
screen the moment [Frigate](https://frigate.video) detects an object — like the
camera notifications on a TV, but for your computer. Works on macOS and Windows.

The card shows the live stream (WebRTC, sub-second latency, with automatic MSE
fallback), the detected object, the score, and — when available — the recognized
face, license plate, and entered zones.

## How it works

```
Frigate ──(MQTT frigate/events)──► main process ──IPC──► overlay window
   │                                                          │
   └──(WebRTC/MSE via /live/.../api/ws)───────────────────────┘
```

The app connects to your existing MQTT broker and Frigate instance. No server-side
change is required.

## Requirements

- [Node.js](https://nodejs.org) 18+
- A running Frigate instance with MQTT enabled

## Setup

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
| `streamSuffix` | Appended to the camera name for the live stream, e.g. `_sub` to use the lighter substream (faster to start). Empty = main stream |
| `cameras` | Map of camera name to display name. Leave `{}` to show all cameras |
| `labels` | Only notify for these labels, e.g. `["person", "car"]`. Empty = all |
| `minScore` | Ignore detections below this score (0–1) |
| `corner` | `top-right`, `top-left`, `bottom-right`, `bottom-left` |
| `margin` | Distance from the screen edge, in pixels |
| `width`, `height` | Overlay size in pixels |
| `dismissSeconds` | Seconds to keep the card after the event ends |

## Run

```bash
npm start
```

## Credits

Live streaming uses the [go2rtc](https://github.com/AlexxIT/go2rtc) `video-rtc`
web component (MIT), vendored in `src/renderer/vendor`.

## License

MIT
