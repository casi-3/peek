const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, dialog, shell } = require('electron')
const path = require('path')
const mqtt = require('mqtt')
const { loadConfig } = require('./config')
const { readPrefs, writePrefs } = require('./prefs')

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let win = null
let tray = null
let config = null
let prefs = null
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
  return `${httpToWs(config.frigateUrl)}/live/webrtc/api/ws?src=${encodeURIComponent(camera)}`
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
    dismissSeconds: config.dismissSeconds != null ? config.dismissSeconds : 8
  }
}

function loadPrefs() {
  const base = defaultPrefs()
  const saved = readPrefs()
  prefs = {
    cameras: Object.assign({}, base.cameras, saved.cameras),
    sound: saved.sound != null ? saved.sound : base.sound,
    snapshot: saved.snapshot != null ? saved.snapshot : base.snapshot,
    dismissSeconds: saved.dismissSeconds != null ? saved.dismissSeconds : base.dismissSeconds
  }
  Object.keys(prefs.cameras).forEach(c => knownCameras.add(c))
}

function savePrefs() {
  writePrefs(prefs)
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
    { label: 'Open config folder', click: () => shell.openPath(app.getPath('userData')) },
    { label: 'Quit', role: 'quit' }
  ])

  if (tray) tray.setContextMenu(menu)
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty())
  if (process.platform === 'darwin') tray.setTitle('🔔')
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

app.whenReady().then(() => {
  try {
    config = loadConfig()
  } catch (err) {
    const target = path.join(app.getPath('userData'), 'config.json')
    dialog.showErrorBox(
      'Peek',
      `config.json not found.\n\nCreate it here:\n${target}\n\nUse config.example.json as a template.`
    )
    app.quit()
    return
  }
  loadPrefs()
  if (process.platform === 'darwin' && app.dock) app.dock.hide()
  createWindow()
  createTray()
  ipcMain.on('overlay-hide', () => {
    if (win && !win.isDestroyed()) win.hide()
  })
  startMqtt()
})

app.on('window-all-closed', () => {})
