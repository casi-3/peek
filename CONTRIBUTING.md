# Contributing

Thanks for your interest in improving Peek! Issues, ideas and pull requests are welcome.

## Getting started

```bash
git clone https://github.com/casi-3/peek
cd peek
npm install
cp config.example.json config.json   # then edit it, or use the in-app setup window
npm start
```

On first launch a setup window lets you enter your Frigate host and MQTT broker —
no file editing required.

## Building

```bash
npm run dist        # current platform
npm run dist:mac    # macOS .dmg + .zip
npm run dist:win    # Windows installer + portable
```

## Guidelines

- The app is plain Electron + vanilla JS, no framework — keep it lightweight.
- Match the existing style and keep changes focused.
- Never commit `config.json` or any personal data; it is gitignored.
- For larger changes, open an issue or a discussion first so we can align.

## Reporting bugs

Open an issue with your OS, Frigate version, and steps to reproduce. Logs from the
terminal (when run with `npm start`) help a lot.
