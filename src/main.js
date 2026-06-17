const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell, dialog, Notification, session } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn, execFileSync } = require('child_process')
const mqtt = require('mqtt')
const { readConfig, saveConfig } = require('./config')
const { readPrefs, writePrefs } = require('./prefs')
const updater = require('./updater')
const frigateAuth = require('./frigate-auth')

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const gotInstanceLock = app.requestSingleInstanceLock()
if (!gotInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => openSetup())
  if (process.platform === 'darwin') app.on('activate', () => openSetup())
}

let win = null
let setupWin = null
let updateWin = null
let tray = null
let config = null
let prefs = null
let pendingUpdate = null
let appStarted = false
let frigatePin = null
let frigateToken = null
let cameraStreamMap = {}
let certProcSet = false
const knownCameras = new Set()

const DISMISS_OPTIONS = [
  { label: '3 seconds', value: 3 },
  { label: '5 seconds', value: 5 },
  { label: '8 seconds', value: 8 },
  { label: '15 seconds', value: 15 },
  { label: '30 seconds', value: 30 },
  { label: 'Until dismissed', value: 0 }
]

function httpToWs(url) {
  return url.replace(/^http/, 'ws')
}

function streamUrl(camera) {
  const streamName = cameraStreamMap[camera] || camera
  return `${httpToWs(config.frigateUrl)}/live/webrtc/api/ws?src=${encodeURIComponent(streamName)}`
}

function buildStreamMap(frigateConfig) {
  const cameras = (frigateConfig && frigateConfig.cameras) || {}
  for (const [name, cam] of Object.entries(cameras)) {
    const streams = cam && cam.live && cam.live.streams
    if (streams && typeof streams === 'object') {
      const first = Object.values(streams)[0]
      if (first) cameraStreamMap[name] = first
    }
  }
}

async function fetchFrigateConfig(token) {
  try {
    const frigateConfig = await frigateAuth.fetchConfig(config.frigateUrl, token || null)
    buildStreamMap(frigateConfig)
  } catch (err) {
    console.error('[peek] could not fetch Frigate config: ' + err.message)
  }
}

function snapshotUrl(camera) {
  return `${config.frigateUrl}/api/${encodeURIComponent(camera)}/latest.jpg`
}

function prettyName(camera) {
  if (config.cameras && config.cameras[camera]) return config.cameras[camera]
  return camera.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function overlaySize() {
  return { width: config.width || 380, height: config.height || 300 }
}

function positionWindow() {
  const area = screen.getPrimaryDisplay().workArea
  const { width, height } = overlaySize()
  const margin = config.margin != null ? config.margin : 24
  const corner = config.corner || 'top-right'
  let x = area.x + area.width - width - margin
  let y = area.y + margin
  if (corner.includes('left')) x = area.x + margin
  if (corner.includes('bottom')) y = area.y + area.height - height - margin
  win.setBounds({ x, y, width, height })
}

function createWindow() {
  const { width, height } = overlaySize()
  win = new BrowserWindow({
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  positionWindow()
}

function defaultPrefs() {
  const cameras = {}
  Object.keys(config.cameras || {}).forEach(c => {
    cameras[c] = true
  })
  return {
    cameras,
    sound: false,
    snapshot: true,
    dismissSeconds: config.dismissSeconds != null ? config.dismissSeconds : 8,
    autoUpdate: false,
    showDock: false,
    skipVersion: '',
    lastNotify: { version: '', at: 0 }
  }
}

function loadPrefs() {
  const base = defaultPrefs()
  const saved = readPrefs()
  prefs = {
    cameras: Object.assign({}, base.cameras, saved.cameras),
    sound: saved.sound != null ? saved.sound : base.sound,
    snapshot: saved.snapshot != null ? saved.snapshot : base.snapshot,
    dismissSeconds: saved.dismissSeconds != null ? saved.dismissSeconds : base.dismissSeconds,
    autoUpdate: saved.autoUpdate != null ? saved.autoUpdate : base.autoUpdate,
    showDock: saved.showDock != null ? saved.showDock : base.showDock,
    skipVersion: saved.skipVersion != null ? saved.skipVersion : base.skipVersion,
    lastNotify: saved.lastNotify != null ? saved.lastNotify : base.lastNotify
  }
  Object.keys(prefs.cameras).forEach(c => knownCameras.add(c))
}

function savePrefs() {
  writePrefs(prefs)
}

function applyRuntimePrefs(opts) {
  if (!opts) return
  if (typeof opts.sound === 'boolean') prefs.sound = opts.sound
  if (typeof opts.snapshot === 'boolean') prefs.snapshot = opts.snapshot
  if (opts.dismissSeconds != null) prefs.dismissSeconds = opts.dismissSeconds
  if (opts.cameras && typeof opts.cameras === 'object') {
    for (const [name, on] of Object.entries(opts.cameras)) {
      prefs.cameras[name] = !!on
    }
  }
}

function cameraEnabled(camera) {
  return prefs.cameras[camera] !== false
}

function learnCamera(camera) {
  if (knownCameras.has(camera)) return
  knownCameras.add(camera)
  if (prefs.cameras[camera] == null) prefs.cameras[camera] = true
  buildMenu()
}

function buildMenu() {
  const cameraItems = [...knownCameras].sort().map(camera => ({
    label: prettyName(camera),
    type: 'checkbox',
    checked: cameraEnabled(camera),
    click: (item) => {
      prefs.cameras[camera] = item.checked
      savePrefs()
    }
  }))
  if (cameraItems.length === 0) {
    cameraItems.push({ label: 'Waiting for events…', enabled: false })
  }

  const dismissItems = DISMISS_OPTIONS.map(opt => ({
    label: opt.label,
    type: 'radio',
    checked: prefs.dismissSeconds === opt.value,
    click: () => {
      prefs.dismissSeconds = opt.value
      savePrefs()
    }
  }))

  const menu = Menu.buildFromTemplate([
    { label: 'Cameras', submenu: cameraItems },
    {
      label: 'Sound',
      type: 'checkbox',
      checked: prefs.sound,
      click: (item) => {
        prefs.sound = item.checked
        savePrefs()
      }
    },
    {
      label: 'Instant snapshot',
      type: 'checkbox',
      checked: prefs.snapshot,
      click: (item) => {
        prefs.snapshot = item.checked
        savePrefs()
      }
    },
    { label: 'Dismiss after', submenu: dismissItems },
    { type: 'separator' },
    { label: 'Check for updates…', click: () => checkForUpdates(true) },
    {
      label: 'Check on launch',
      type: 'checkbox',
      checked: prefs.autoUpdate,
      click: (item) => {
        prefs.autoUpdate = item.checked
        savePrefs()
      }
    },
    { label: 'Settings…', click: () => openSetup() },
    { label: 'Open config folder', click: () => shell.openPath(app.getPath('userData')) },
    { label: 'Quit', role: 'quit' }
  ])

  if (tray) tray.setContextMenu(menu)
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Peek')
  buildMenu()
}

function handleEvent(data) {
  const after = data.after || data.before
  if (!after || !after.label) return

  learnCamera(after.camera)
  if (!cameraEnabled(after.camera)) return

  const labels = config.labels || []
  if (labels.length && !labels.includes(after.label)) return

  const score = Math.max(after.score || 0, after.top_score || 0)
  const minScore = config.minScore != null ? config.minScore : 0.6
  if (data.type === 'new' && score < minScore) return

  const subLabel = Array.isArray(after.sub_label) ? after.sub_label[0] : after.sub_label
  const event = {
    id: after.id,
    type: data.type,
    name: prettyName(after.camera),
    label: after.label,
    score,
    subLabel: subLabel || null,
    plate: after.recognized_license_plate || null,
    zones: after.entered_zones || [],
    streamUrl: streamUrl(after.camera),
    poster: prefs.snapshot ? snapshotUrl(after.camera) : null,
    sound: prefs.sound,
    dismiss: prefs.dismissSeconds
  }

  if (!win || win.isDestroyed()) return
  if (data.type === 'new') {
    positionWindow()
    win.showInactive()
  }
  win.webContents.send('frigate-event', event)
}

function startMqtt() {
  const prefix = config.topicPrefix || 'frigate'
  const client = mqtt.connect(config.mqtt, { reconnectPeriod: 3000 })
  client.on('connect', () => client.subscribe(`${prefix}/events`))
  client.on('message', (topic, payload) => {
    let data
    try {
      data = JSON.parse(payload.toString())
    } catch (err) {
      return
    }
    handleEvent(data)
  })
}

function applyCertPin() {
  if (certProcSet) return
  certProcSet = true
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (frigatePin && request.hostname === frigatePin.host) {
      const sha = frigateAuth.pemToDerSha256(request.certificate && request.certificate.data)
      if (sha && sha === frigatePin.certSha256) {
        callback(0)
        return
      }
    }
    callback(-3)
  })
}

async function initFrigateAuth() {
  if (!config || !config.frigateUser || !frigateAuth.isHttps(config.frigateUrl)) return
  try {
    const { token, certSha256 } = await frigateAuth.login(config.frigateUrl, config.frigateUser, config.frigatePassword)
    frigateToken = token
    frigatePin = { host: new URL(config.frigateUrl).hostname, certSha256 }
    applyCertPin()
    await session.defaultSession.cookies.set({
      url: config.frigateUrl,
      name: 'frigate_token',
      value: token,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction'
    })
  } catch (err) {
    console.error('[frigate-auth] ' + err.message)
  }
}

function startApp() {
  appStarted = true
  loadPrefs()
  createWindow()
  createTray()
  initFrigateAuth().then(() => fetchFrigateConfig(frigateToken))
  startMqtt()
}

function openSetup() {
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.focus()
    return
  }
  setupWin = new BrowserWindow({
    width: 460,
    height: appStarted ? 940 : 748,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    title: 'Peek Setup',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'setup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  setupWin.loadFile(path.join(__dirname, 'setup', 'setup.html'))
  setupWin.once('ready-to-show', () => setupWin.show())
  setupWin.on('closed', () => {
    const wasStarted = appStarted
    setupWin = null
    if (!wasStarted) app.quit()
  })
}

function testMqtt(cfg) {
  return new Promise((resolve) => {
    let done = false
    let client = null
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { if (client) client.end(true) } catch (err) {}
      resolve(result)
    }
    const timer = setTimeout(
      () => finish({ ok: false, error: 'Timed out. Check the host, port and credentials.' }),
      7000
    )
    try {
      client = mqtt.connect(cfg.mqtt, { reconnectPeriod: 0, connectTimeout: 6000 })
    } catch (err) {
      finish({ ok: false, error: 'Invalid MQTT address.' })
      return
    }
    client.on('connect', () => finish({ ok: true }))
    client.on('error', (err) => finish({ ok: false, error: (err && err.message) || 'Connection failed.' }))
  })
}

async function testConnection(cfg) {
  const mqttRes = await testMqtt(cfg)
  if (!mqttRes.ok) return mqttRes
  if (cfg.frigateUser && frigateAuth.isHttps(cfg.frigateUrl)) {
    try {
      await frigateAuth.login(cfg.frigateUrl, cfg.frigateUser, cfg.frigatePassword)
      return { ok: true, detail: 'MQTT broker and Frigate login OK.' }
    } catch (err) {
      return { ok: false, error: 'MQTT OK, but Frigate: ' + err.message }
    }
  }
  return mqttRes
}

function openUpdateWindow() {
  if (updateWin && !updateWin.isDestroyed()) {
    updateWin.focus()
    return
  }
  updateWin = new BrowserWindow({
    width: 520,
    height: 560,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    title: 'Update Peek',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'update-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  updateWin.loadFile(path.join(__dirname, 'update', 'update.html'))
  updateWin.once('ready-to-show', () => updateWin.show())
  updateWin.on('closed', () => { updateWin = null })
}

const NOTIFY_THROTTLE_MS = 24 * 60 * 60 * 1000

async function checkForUpdates(manual) {
  let latest
  try {
    latest = await updater.getLatest()
  } catch (err) {
    if (manual) {
      dialog.showMessageBox({ type: 'error', title: 'Peek', message: 'Could not check for updates.', detail: err.message })
    }
    return
  }
  const current = app.getVersion()
  if (!updater.isNewer(latest.version, current)) {
    if (manual) {
      dialog.showMessageBox({ type: 'info', title: 'Peek', message: 'You are up to date.', detail: 'Peek ' + current + ' is the latest version.' })
    }
    return
  }
  const asset = updater.pickAsset(latest.assets, process.platform)
  pendingUpdate = {
    current,
    version: latest.version,
    notes: latest.notes,
    platform: process.platform,
    asset: asset
  }
  if (manual) {
    openUpdateWindow()
    return
  }
  const now = Date.now()
  if (!updater.shouldNotify(prefs, latest.version, now, NOTIFY_THROTTLE_MS)) {
    return
  }
  prefs.lastNotify = { version: latest.version, at: now }
  savePrefs()
  notifyUpdate(latest.version)
}

function notifyUpdate(version) {
  if (!Notification.isSupported()) {
    openUpdateWindow()
    return
  }
  const note = new Notification({
    title: 'Update available',
    body: 'Peek ' + version + ' is ready. Click to see what’s new.'
  })
  note.on('click', () => openUpdateWindow())
  note.show()
}

function runInstaller(file, mode) {
  if (process.platform === 'win32') {
    const child = spawn(file, mode === 'silent' ? ['/S'] : [], { detached: true, stdio: 'ignore' })
    child.unref()
    setTimeout(() => app.quit(), 800)
  } else {
    shell.openPath(file)
  }
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function installMacUpdate(zipPath) {
  const appBundle = path.resolve(app.getPath('exe'), '..', '..', '..')
  if (!/\.app$/.test(appBundle)) {
    return { error: 'Could not locate the app bundle.' }
  }
  const parent = path.dirname(appBundle)
  try {
    fs.accessSync(parent, fs.constants.W_OK)
  } catch (err) {
    shell.showItemInFolder(zipPath)
    return { error: 'Cannot update in place here. The download was revealed in Finder so you can replace Peek manually.' }
  }
  const work = path.join(app.getPath('temp'), 'peek-update-' + process.pid)
  let newApp
  try {
    fs.rmSync(work, { recursive: true, force: true })
    fs.mkdirSync(work, { recursive: true })
    execFileSync('ditto', ['-x', '-k', zipPath, work])
    newApp = path.join(work, path.basename(appBundle))
    if (!fs.existsSync(newApp)) {
      return { error: 'Update package did not contain the app.' }
    }
    execFileSync('xattr', ['-cr', newApp])
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', newApp])
  } catch (err) {
    return { error: 'Could not prepare the update: ' + err.message }
  }
  const script = [
    '#!/bin/bash',
    'PID=' + process.pid,
    'APP=' + shellQuote(appBundle),
    'NEW=' + shellQuote(newApp),
    'STAGE="$APP.update"',
    'BACKUP="$APP.old"',
    'while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done',
    'rm -rf "$STAGE" "$BACKUP"',
    'if ! ditto "$NEW" "$STAGE"; then exit 1; fi',
    'mv "$APP" "$BACKUP"',
    'if ! mv "$STAGE" "$APP"; then mv "$BACKUP" "$APP"; exit 1; fi',
    'xattr -cr "$APP" || true',
    'rm -rf "$BACKUP" ' + shellQuote(work),
    'open "$APP"',
    ''
  ].join('\n')
  const scriptPath = path.join(app.getPath('temp'), 'peek-update-' + process.pid + '.sh')
  try {
    fs.writeFileSync(scriptPath, script, { mode: 0o755 })
  } catch (err) {
    return { error: 'Could not stage the update: ' + err.message }
  }
  const child = spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' })
  child.unref()
  setTimeout(() => app.quit(), 400)
  return { ok: true }
}

async function installUpdate(mode) {
  if (!pendingUpdate || !pendingUpdate.asset) {
    return { error: 'No matching download for this platform.' }
  }
  const dest = path.join(app.getPath('temp'), pendingUpdate.asset.name)
  try {
    await updater.download(pendingUpdate.asset.url, dest, (p) => {
      if (updateWin && !updateWin.isDestroyed()) updateWin.webContents.send('update-progress', p)
    })
  } catch (err) {
    return { error: 'Download failed: ' + err.message }
  }
  if (process.platform === 'darwin' && app.isPackaged && /\.zip$/i.test(dest)) {
    return installMacUpdate(dest)
  }
  runInstaller(dest, mode)
  return { ok: true }
}

app.whenReady().then(() => {
  if (!gotInstanceLock) return
  if (process.platform === 'darwin' && app.dock && !readPrefs().showDock) app.dock.hide()

  ipcMain.on('overlay-hide', () => {
    if (win && !win.isDestroyed()) win.hide()
  })
  ipcMain.handle('setup-load', () => readConfig())
  ipcMain.handle('setup-test', (e, cfg) => testConnection(cfg))
  ipcMain.handle('setup-load-prefs', () => {
    const p = prefs || readPrefs()
    const cameras = appStarted
      ? [...knownCameras].sort().map(name => ({ name, label: prettyName(name), enabled: cameraEnabled(name) }))
      : []
    return {
      autoUpdate: !!(p && p.autoUpdate),
      showDock: !!(p && p.showDock),
      platform: process.platform,
      started: appStarted,
      sound: !!(p && p.sound),
      snapshot: !!(p && p.snapshot),
      dismissSeconds: p && p.dismissSeconds != null ? p.dismissSeconds : 8,
      cameras
    }
  })
  ipcMain.handle('setup-save', (e, cfg, opts) => {
    saveConfig(cfg)
    const wantUpdates = !!(opts && opts.autoUpdate)
    const wantDock = !!(opts && opts.showDock)
    if (!appStarted) {
      config = cfg
      startApp()
      prefs.autoUpdate = wantUpdates
      prefs.showDock = wantDock
      savePrefs()
      if (process.platform === 'darwin' && app.dock) {
        if (wantDock) app.dock.show()
        else app.dock.hide()
      }
      if (setupWin && !setupWin.isDestroyed()) setupWin.close()
      if (wantUpdates) setTimeout(() => checkForUpdates(false), 4000)
    } else {
      const needsReconnect = !config ||
        config.frigateUrl !== cfg.frigateUrl ||
        config.mqtt !== cfg.mqtt ||
        config.frigateUser !== cfg.frigateUser ||
        config.frigatePassword !== cfg.frigatePassword
      const wasUpdates = !!prefs.autoUpdate
      prefs.autoUpdate = wantUpdates
      prefs.showDock = wantDock
      applyRuntimePrefs(opts)
      savePrefs()
      if (needsReconnect) {
        app.relaunch()
        app.exit(0)
        return { ok: true }
      }
      config = cfg
      if (process.platform === 'darwin' && app.dock) {
        if (wantDock) app.dock.show()
        else app.dock.hide()
      }
      buildMenu()
      if (setupWin && !setupWin.isDestroyed()) setupWin.close()
      if (wantUpdates && !wasUpdates) setTimeout(() => checkForUpdates(false), 1000)
    }
    return { ok: true }
  })
  ipcMain.on('setup-cancel', () => {
    if (setupWin && !setupWin.isDestroyed()) setupWin.close()
  })

  ipcMain.handle('update-data', () => pendingUpdate)
  ipcMain.handle('update-install', (e, mode) => installUpdate(mode))
  ipcMain.on('update-later', () => {
    if (updateWin && !updateWin.isDestroyed()) updateWin.close()
  })
  ipcMain.on('update-skip', () => {
    if (pendingUpdate && pendingUpdate.version) {
      prefs.skipVersion = pendingUpdate.version
      savePrefs()
    }
    if (updateWin && !updateWin.isDestroyed()) updateWin.close()
  })

  config = readConfig()
  if (config) {
    startApp()
    if (prefs.autoUpdate) setTimeout(() => checkForUpdates(false), 4000)
  } else {
    openSetup()
  }
})

app.on('window-all-closed', () => {})
