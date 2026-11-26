const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell, dialog, Notification, session, globalShortcut } = require('electron')
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
let placementMode = false
let dynamicAspect = null
let scaleSaveTimer = null
let frigatePin = null
let frigateToken = null
let tokenRefreshTimer = null
let mqttClient = null
let frigateAvailable = true
let reauthInFlight = false
let lastReauthAttempt = 0
let cameraStreamMap = {}
let cameraDetectMap = {}
let certProcSet = false
let liveView = null
let registeredHotkey = null
let resumeTimer = null
let overlayRecreateTimer = null
let overlayRecreates = 0
const knownCameras = new Set()
const knownAudioLabels = new Set()
const activeAudio = new Set()
const stationaryEvents = new Set()
const zoneEvents = new Set()
const knownZones = new Map()
const knownObjectLabels = new Set()
const AUDIO_NON_LABELS = new Set(['all', 'dBFS', 'rms', 'transcription', 'set', 'state'])
const REAUTH_MIN_INTERVAL_MS = 10000
const REAUTH_RETRY_DELAY_MS = 5000
const REAUTH_MAX_RETRIES = 3
const OVERLAY_RECREATE_DELAY_MS = 2000
const OVERLAY_MAX_RECREATES = 5
const DEFAULT_LIVE_HOTKEY = 'CommandOrControl+Alt+Z'
const MIN_SIZE_SCALE = 0.5
const MAX_SIZE_SCALE = 3

const DISMISS_OPTIONS = [
  { label: '3 seconds', value: 3 },
  { label: '5 seconds', value: 5 },
  { label: '8 seconds', value: 8 },
  { label: '15 seconds', value: 15 },
  { label: '30 seconds', value: 30 },
  { label: 'Until dismissed', value: 0 }
]

const PAUSE_OPTIONS = [
  { label: '30 minutes', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '3 hours', minutes: 180 },
  { label: '6 hours', minutes: 360 },
  { label: 'Rest of today', minutes: null }
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
    const detect = cam && cam.detect
    if (detect && detect.width && detect.height) {
      cameraDetectMap[name] = { width: detect.width, height: detect.height }
    }
    if (cam && cam.zones && typeof cam.zones === 'object') {
      Object.keys(cam.zones).forEach(zone => learnZone(zone, name))
    }
    const track = cam && cam.objects && cam.objects.track
    if (Array.isArray(track)) track.forEach(learnObjectLabel)
  }
}

function normalizeBox(box, camera) {
  if (!Array.isArray(box) || box.length < 4) return null
  const dims = cameraDetectMap[camera]
  if (!dims) return null
  return [box[0] / dims.width, box[1] / dims.height, box[2] / dims.width, box[3] / dims.height]
}

async function fetchFrigateConfig(token) {
  try {
    const frigateConfig = await frigateAuth.fetchConfig(config.frigateUrl, token || null, !!config.frigateAllowSelfSigned)
    buildStreamMap(frigateConfig)
    const cameras = (frigateConfig && frigateConfig.cameras) || {}
    Object.keys(cameras).forEach(name => learnCamera(name))
  } catch (err) {
    console.error('[peek] could not fetch Frigate config: ' + err.message)
  }
}

function snapshotUrl(camera) {
  return `${config.frigateUrl}/api/${encodeURIComponent(camera)}/latest.jpg`
}

function clickUrlForEvent(camera, eventId) {
  const action = prefs.clickAction || 'event'
  if (action === 'disabled') return null
  if (action === 'live') return `${config.frigateUrl}/#${camera}`
  return `${config.frigateUrl}/explore?event_id=${encodeURIComponent(eventId)}`
}

function titleCase(name) {
  return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function prettyName(camera) {
  if (config.cameras && config.cameras[camera]) return config.cameras[camera]
  return titleCase(camera)
}

function overlayDisplay() {
  const placement = config.placement
  if (placement && placement.displayId != null) {
    return screen.getAllDisplays().find(d => d.id === placement.displayId) || screen.getPrimaryDisplay()
  }
  return screen.getPrimaryDisplay()
}

function sizeScale() {
  if (!prefs) return 1
  return liveView ? prefs.liveScale : prefs.popupScale
}

function fitToScreen(width, height) {
  const area = overlayDisplay().workArea
  const fit = Math.min(1, (area.width * 0.9) / width, (area.height * 0.9) / height)
  return { width: Math.round(width * fit), height: Math.round(height * fit), fit }
}

function liveGridSize(count) {
  const inset = 16
  const tileHeight = (config.height || 300) * sizeScale() - inset
  const tileWidth = Math.round(tileHeight * 16 / 9)
  const cols = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / cols)
  const width = cols * tileWidth + inset
  const height = rows * tileHeight + inset
  return fitToScreen(width, height)
}

function overlaySize() {
  if (liveView && liveView.count > 1) return liveGridSize(liveView.count)
  const scale = sizeScale()
  const height = Math.round((config.height || 300) * scale)
  if (prefs && prefs.dynamicSize !== false && dynamicAspect) {
    const inset = 16
    const min = Math.round(height * 0.6)
    const max = Math.round(height * 3.2)
    const width = Math.max(min, Math.min(max, Math.round((height - inset) * dynamicAspect) + inset))
    return fitToScreen(width, height)
  }
  return fitToScreen(Math.round((config.width || 380) * scale), height)
}

function positionWindow() {
  const { width, height } = overlaySize()
  const placement = config.placement
  if (placement && placement.displayId != null) {
    const area = overlayDisplay().workArea
    const anchorX = placement.anchorX === 'right' ? 'right' : 'left'
    const anchorY = placement.anchorY === 'bottom' ? 'bottom' : 'top'
    let x = anchorX === 'right'
      ? area.x + area.width - width - (placement.offsetX || 0)
      : area.x + (placement.offsetX || 0)
    let y = anchorY === 'bottom'
      ? area.y + area.height - height - (placement.offsetY || 0)
      : area.y + (placement.offsetY || 0)
    x = Math.max(area.x, Math.min(x, area.x + area.width - width))
    y = Math.max(area.y, Math.min(y, area.y + area.height - height))
    win.setBounds({ x, y, width, height })
    return
  }
  const area = screen.getPrimaryDisplay().workArea
  const margin = config.margin != null ? config.margin : 24
  const corner = config.corner || 'top-right'
  let x = area.x + area.width - width - margin
  let y = area.y + margin
  if (corner.includes('left')) x = area.x + margin
  if (corner.includes('bottom')) y = area.y + area.height - height - margin
  win.setBounds({ x, y, width, height })
}

function setDynamicAspect(aspect) {
  if (!prefs || prefs.dynamicSize === false) return
  if (!aspect || !isFinite(aspect) || aspect <= 0) return
  const before = overlaySize()
  dynamicAspect = aspect
  const after = overlaySize()
  if (after.width === before.width && after.height === before.height) return
  if (win && !win.isDestroyed() && !placementMode) positionWindow()
}

function clearDynamicAspect() {
  dynamicAspect = null
  if (win && !win.isDestroyed()) positionWindow()
}

function scaleOverlay(factor) {
  if (!prefs || placementMode || !win || win.isDestroyed()) return
  if (typeof factor !== 'number' || !isFinite(factor) || factor <= 0) return
  const { fit } = overlaySize()
  if (factor > 1 && fit < 1) return
  const key = liveView ? 'liveScale' : 'popupScale'
  const next = Math.max(MIN_SIZE_SCALE, Math.min(MAX_SIZE_SCALE, prefs[key] * fit * factor))
  if (next === prefs[key]) return
  prefs[key] = next
  positionWindow()
  clearTimeout(scaleSaveTimer)
  scaleSaveTimer = setTimeout(() => {
    savePrefs()
    buildMenu()
  }, 500)
}

function resetSize() {
  clearTimeout(scaleSaveTimer)
  prefs.popupScale = 1
  prefs.liveScale = 1
  savePrefs()
  if (win && !win.isDestroyed() && !placementMode) positionWindow()
  buildMenu()
}

function validSizeScale(value) {
  return Number.isFinite(value) ? Math.max(MIN_SIZE_SCALE, Math.min(MAX_SIZE_SCALE, value)) : 1
}

function enterPlacement() {
  if (!win || win.isDestroyed()) return
  if (liveView) {
    liveView = null
    win.webContents.send('live-close', { animate: false })
  }
  placementMode = true
  positionWindow()
  win.setMovable(true)
  win.webContents.send('overlay-mode', 'placement')
  win.show()
  win.focus()
}

function exitPlacement(save) {
  if (!win || win.isDestroyed()) return
  if (save) {
    const bounds = win.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const area = display.workArea
    const anchorX = bounds.x + bounds.width / 2 < area.x + area.width / 2 ? 'left' : 'right'
    const anchorY = bounds.y + bounds.height / 2 < area.y + area.height / 2 ? 'top' : 'bottom'
    config.placement = {
      displayId: display.id,
      anchorX,
      anchorY,
      offsetX: anchorX === 'right' ? area.x + area.width - (bounds.x + bounds.width) : bounds.x - area.x,
      offsetY: anchorY === 'bottom' ? area.y + area.height - (bounds.y + bounds.height) : bounds.y - area.y
    }
    saveConfig(config)
  }
  placementMode = false
  win.setMovable(false)
  win.webContents.send('overlay-mode', 'event')
  win.hide()
  buildMenu()
}

function resetPlacement() {
  if (!config) return
  delete config.placement
  saveConfig(config)
  buildMenu()
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
  win.webContents.on('did-fail-load', (e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return
    console.error('[peek] overlay failed to load: ' + description)
    recreateOverlay()
  })
  win.webContents.on('render-process-gone', (e, details) => {
    console.error('[peek] overlay renderer gone: ' + details.reason)
    recreateOverlay()
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  positionWindow()
}

function recreateOverlay() {
  if (overlayRecreateTimer || overlayRecreates >= OVERLAY_MAX_RECREATES) return
  overlayRecreates++
  overlayRecreateTimer = setTimeout(() => {
    overlayRecreateTimer = null
    const old = win
    win = null
    liveView = null
    placementMode = false
    if (old && !old.isDestroyed()) old.destroy()
    createWindow()
    buildMenu()
  }, OVERLAY_RECREATE_DELAY_MS)
}

function defaultPrefs() {
  const cameras = {}
  Object.keys(config.cameras || {}).forEach(c => {
    cameras[c] = true
  })
  return {
    cameras,
    audioLabels: {},
    sound: false,
    snapshot: true,
    dismissSeconds: config.dismissSeconds != null ? config.dismissSeconds : 8,
    clickAction: 'event',
    showAllObjectsInFrame: true,
    showBoundingBoxes: true,
    dynamicSize: true,
    dismissOnStationary: true,
    autoUpdate: false,
    showDock: false,
    openAtLogin: false,
    liveHotkey: DEFAULT_LIVE_HOTKEY,
    liveCameras: {},
    zoneFilter: [],
    zoneLabels: {},
    pausedUntil: 0,
    popupScale: 1,
    liveScale: 1,
    skipVersion: '',
    lastNotify: { version: '', at: 0 }
  }
}

function loadPrefs() {
  const base = defaultPrefs()
  const saved = readPrefs()
  prefs = {
    cameras: Object.assign({}, base.cameras, saved.cameras),
    audioLabels: Object.assign({}, base.audioLabels, saved.audioLabels),
    sound: saved.sound != null ? saved.sound : base.sound,
    snapshot: saved.snapshot != null ? saved.snapshot : base.snapshot,
    dismissSeconds: saved.dismissSeconds != null ? saved.dismissSeconds : base.dismissSeconds,
    clickAction: saved.clickAction != null ? saved.clickAction : base.clickAction,
    showAllObjectsInFrame: saved.showAllObjectsInFrame != null ? saved.showAllObjectsInFrame : base.showAllObjectsInFrame,
    showBoundingBoxes: saved.showBoundingBoxes != null ? saved.showBoundingBoxes : base.showBoundingBoxes,
    dynamicSize: saved.dynamicSize != null ? saved.dynamicSize : base.dynamicSize,
    dismissOnStationary: saved.dismissOnStationary != null ? saved.dismissOnStationary : base.dismissOnStationary,
    autoUpdate: saved.autoUpdate != null ? saved.autoUpdate : base.autoUpdate,
    showDock: saved.showDock != null ? saved.showDock : base.showDock,
    openAtLogin: saved.openAtLogin != null ? saved.openAtLogin : base.openAtLogin,
    liveHotkey: typeof saved.liveHotkey === 'string' ? saved.liveHotkey : base.liveHotkey,
    liveCameras: Object.assign({}, base.liveCameras, saved.liveCameras),
    zoneFilter: normalizeZoneFilter(saved.zoneFilter),
    zoneLabels: normalizeZoneLabels(saved.zoneLabels),
    pausedUntil: Number.isFinite(saved.pausedUntil) ? saved.pausedUntil : base.pausedUntil,
    popupScale: validSizeScale(saved.popupScale),
    liveScale: validSizeScale(saved.liveScale),
    skipVersion: saved.skipVersion != null ? saved.skipVersion : base.skipVersion,
    lastNotify: saved.lastNotify != null ? saved.lastNotify : base.lastNotify
  }
  Object.keys(prefs.cameras).forEach(c => knownCameras.add(c))
  Object.keys(prefs.audioLabels).forEach(l => knownAudioLabels.add(l))
  const savedZones = new Set([...prefs.zoneFilter, ...Object.keys(prefs.zoneLabels)])
  savedZones.forEach(z => knownZones.set(z, { name: z, cameras: new Set() }))
  Object.values(prefs.zoneLabels).forEach(list => list.forEach(l => knownObjectLabels.add(l)))
}

function normalizeZoneFilter(list) {
  if (!Array.isArray(list)) return []
  return [...new Set(list.filter(z => typeof z === 'string' && z.trim()).map(z => z.trim().toLowerCase()))]
}

function setZoneFilter(list) {
  prefs.zoneFilter = normalizeZoneFilter(list)
  zoneEvents.clear()
}

function normalizeZoneLabels(map) {
  const out = {}
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out
  for (const [zone, labels] of Object.entries(map)) {
    const key = typeof zone === 'string' ? zone.trim().toLowerCase() : ''
    const list = normalizeZoneFilter(labels)
    if (key && list.length) out[key] = list
  }
  return out
}

function setZoneLabels(key, labels) {
  const list = normalizeZoneFilter(labels)
  if (list.length) prefs.zoneLabels[key] = list
  else delete prefs.zoneLabels[key]
  zoneEvents.clear()
}

function savePrefs() {
  writePrefs(prefs)
}

function isPaused() {
  return prefs.pausedUntil > Date.now()
}

function endOfToday() {
  const d = new Date()
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

function pausedUntilText() {
  return new Date(prefs.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function schedulePauseEnd() {
  clearTimeout(resumeTimer)
  resumeTimer = null
  if (!isPaused()) return
  resumeTimer = setTimeout(() => {
    resumeTimer = null
    if (isPaused()) schedulePauseEnd()
    else buildMenu()
  }, prefs.pausedUntil - Date.now())
}

function pauseUntil(ts) {
  prefs.pausedUntil = ts
  savePrefs()
  schedulePauseEnd()
  if (win && !win.isDestroyed() && win.isVisible() && !liveView && !placementMode) {
    win.webContents.send('overlay-dismiss')
  }
  buildMenu()
}

function resumeNow() {
  prefs.pausedUntil = 0
  savePrefs()
  schedulePauseEnd()
  buildMenu()
}

function supportsOpenAtLogin() {
  return process.platform === 'darwin' || process.platform === 'win32'
}

function applyOpenAtLogin(enabled) {
  if (!supportsOpenAtLogin() || !app.isPackaged) return
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true })
  } catch (err) {
    console.error('[peek] could not set open on startup: ' + err.message)
  }
}

function applyRuntimePrefs(opts) {
  if (!opts) return
  if (typeof opts.sound === 'boolean') prefs.sound = opts.sound
  if (typeof opts.snapshot === 'boolean') prefs.snapshot = opts.snapshot
  if (opts.dismissSeconds != null) prefs.dismissSeconds = opts.dismissSeconds
  if (opts.clickAction) prefs.clickAction = opts.clickAction
  if (typeof opts.showAllObjectsInFrame === 'boolean') prefs.showAllObjectsInFrame = opts.showAllObjectsInFrame
  if (typeof opts.showBoundingBoxes === 'boolean') prefs.showBoundingBoxes = opts.showBoundingBoxes
  if (typeof opts.dynamicSize === 'boolean') {
    prefs.dynamicSize = opts.dynamicSize
    if (!prefs.dynamicSize) clearDynamicAspect()
  }
  if (typeof opts.dismissOnStationary === 'boolean') prefs.dismissOnStationary = opts.dismissOnStationary
  if (opts.cameras && typeof opts.cameras === 'object') {
    for (const [name, on] of Object.entries(opts.cameras)) {
      prefs.cameras[name] = !!on
    }
  }
  if (opts.audioLabels && typeof opts.audioLabels === 'object') {
    for (const [name, on] of Object.entries(opts.audioLabels)) {
      prefs.audioLabels[name] = !!on
    }
  }
  if (opts.liveCameras && typeof opts.liveCameras === 'object') {
    for (const [name, on] of Object.entries(opts.liveCameras)) {
      prefs.liveCameras[name] = !!on
    }
  }
  if (Array.isArray(opts.zoneFilter)) setZoneFilter(opts.zoneFilter)
  if (opts.zoneLabels && typeof opts.zoneLabels === 'object') {
    for (const [zone, labels] of Object.entries(opts.zoneLabels)) {
      if (Array.isArray(labels)) setZoneLabels(zone.toLowerCase(), labels)
    }
  }
  if (typeof opts.liveHotkey === 'string' && opts.liveHotkey !== prefs.liveHotkey) {
    prefs.liveHotkey = opts.liveHotkey
    applyHotkey(prefs.liveHotkey)
  }
}

function cameraEnabled(camera) {
  return prefs.cameras[camera] !== false
}

function audioLabelEnabled(label) {
  return prefs.audioLabels[label] !== false
}

function liveCameraEnabled(camera) {
  return prefs.liveCameras[camera] !== false
}

function liveClickUrl(camera) {
  return prefs.clickAction === 'disabled' ? null : `${config.frigateUrl}/#${camera}`
}

function openLiveView() {
  if (placementMode || !win || win.isDestroyed()) return
  const cameras = [...knownCameras].sort().filter(liveCameraEnabled)
  if (!cameras.length) {
    if (Notification.isSupported()) {
      new Notification({ title: 'Peek', body: 'No cameras for live view yet. Pick some under Live view cameras.' }).show()
    }
    return
  }
  liveView = { count: cameras.length }
  positionWindow()
  win.showInactive()
  win.webContents.send('live-open', {
    muted: cameras.length > 1 || !prefs.sound,
    cameras: cameras.map(camera => ({
      id: camera,
      name: prettyName(camera),
      streamUrl: streamUrl(camera),
      poster: prefs.snapshot ? snapshotUrl(camera) : null,
      clickUrl: liveClickUrl(camera)
    }))
  })
}

function toggleLiveView() {
  if (liveView) {
    if (win && !win.isDestroyed()) win.webContents.send('live-close', { animate: true })
    return
  }
  openLiveView()
}

function applyHotkey(accelerator) {
  if (registeredHotkey) {
    globalShortcut.unregister(registeredHotkey)
    registeredHotkey = null
  }
  if (accelerator) {
    try {
      if (globalShortcut.register(accelerator, toggleLiveView)) {
        registeredHotkey = accelerator
      } else {
        console.error('[peek] live view shortcut ' + accelerator + ' is in use by another app')
      }
    } catch (err) {
      console.error('[peek] invalid live view shortcut ' + accelerator + ': ' + err.message)
    }
  }
  buildMenu()
  return registeredHotkey === accelerator
}

function hotkeyAvailable(accelerator) {
  if (!accelerator) return true
  try {
    const ok = globalShortcut.register(accelerator, () => {})
    if (ok) globalShortcut.unregister(accelerator)
    return ok
  } catch (err) {
    return false
  }
}

function revealOverlay() {
  liveView = null
  positionWindow()
  win.showInactive()
}

function learnCamera(camera) {
  if (knownCameras.has(camera)) return
  knownCameras.add(camera)
  if (prefs.cameras[camera] == null) prefs.cameras[camera] = true
  buildMenu()
}

function learnAudioLabel(label) {
  if (knownAudioLabels.has(label)) return
  knownAudioLabels.add(label)
  if (prefs.audioLabels[label] == null) prefs.audioLabels[label] = true
  buildMenu()
}

function learnZone(zone, camera) {
  if (typeof zone !== 'string' || !zone) return
  const key = zone.toLowerCase()
  let entry = knownZones.get(key)
  let changed = false
  if (!entry) {
    entry = { name: zone, cameras: new Set() }
    knownZones.set(key, entry)
    changed = true
  } else if (entry.name === key && zone !== key) {
    entry.name = zone
    changed = true
  }
  if (camera && !entry.cameras.has(camera)) {
    entry.cameras.add(camera)
    changed = true
  }
  if (changed) buildMenu()
}

function zoneLabel(key) {
  const entry = knownZones.get(key)
  const name = titleCase((entry && entry.name) || key)
  const cameras = entry ? [...entry.cameras].sort().map(prettyName) : []
  return cameras.length ? `${name} (${cameras.join(', ')})` : name
}

function learnObjectLabel(label) {
  if (typeof label !== 'string' || !label) return
  const key = label.toLowerCase()
  if (knownObjectLabels.has(key)) return
  knownObjectLabels.add(key)
  buildMenu()
}

function zoneAllowsLabel(key, label) {
  if (!prefs.zoneFilter.includes(key)) return false
  const allowed = prefs.zoneLabels[key]
  return !allowed || allowed.includes(String(label).toLowerCase())
}

function eventInSelectedZone(after) {
  const zones = [...(after.current_zones || []), ...(after.entered_zones || [])]
  return zones.some(z => typeof z === 'string' && zoneAllowsLabel(z.toLowerCase(), after.label))
}

function zoneObjectLabels(key) {
  return [...new Set([...knownObjectLabels, ...(prefs.zoneLabels[key] || [])])].sort()
}

function zoneObjectsSummary(key) {
  const allowed = prefs.zoneLabels[key]
  return allowed ? allowed.map(titleCase).join(', ') : 'Any object'
}

function toggleZoneLabel(key, label, on) {
  const next = (prefs.zoneLabels[key] || []).filter(l => l !== label)
  if (on) next.push(label)
  setZoneLabels(key, next)
  savePrefs()
  buildMenu()
}

function toggleZone(key, on) {
  const next = prefs.zoneFilter.filter(z => z !== key)
  if (on) next.push(key)
  setZoneFilter(next)
  savePrefs()
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

  const audioLabelItems = [...knownAudioLabels].sort().map(label => ({
    label: prettyName(label),
    type: 'checkbox',
    checked: audioLabelEnabled(label),
    click: (item) => {
      prefs.audioLabels[label] = item.checked
      savePrefs()
    }
  }))
  if (audioLabelItems.length === 0) {
    audioLabelItems.push({ label: 'Waiting for audio events…', enabled: false })
  }

  const liveCameraItems = [...knownCameras].sort().map(camera => ({
    label: prettyName(camera),
    type: 'checkbox',
    checked: liveCameraEnabled(camera),
    click: (item) => {
      prefs.liveCameras[camera] = item.checked
      savePrefs()
    }
  }))
  if (liveCameraItems.length === 0) {
    liveCameraItems.push({ label: 'Waiting for cameras…', enabled: false })
  }

  const zoneItems = [
    {
      label: 'Anywhere (no zone filter)',
      type: 'checkbox',
      checked: prefs.zoneFilter.length === 0,
      click: () => {
        setZoneFilter([])
        savePrefs()
        buildMenu()
      }
    },
    { type: 'separator' },
    ...[...knownZones.keys()].sort().map(key => ({
      label: zoneLabel(key),
      type: 'checkbox',
      checked: prefs.zoneFilter.includes(key),
      click: (item) => toggleZone(key, item.checked)
    }))
  ]
  if (knownZones.size === 0) {
    zoneItems.push({ label: 'No zones found in Frigate', enabled: false })
  }
  const pickedZones = prefs.zoneFilter.filter(key => knownZones.has(key)).sort()
  if (pickedZones.length) {
    zoneItems.push({ type: 'separator' })
    pickedZones.forEach(key => {
      const entry = knownZones.get(key)
      const labels = zoneObjectLabels(key)
      zoneItems.push({
        label: `Objects in ${titleCase(entry.name || key)}: ${zoneObjectsSummary(key)}`,
        submenu: [
          {
            label: 'Any object',
            type: 'checkbox',
            checked: !prefs.zoneLabels[key],
            click: () => {
              setZoneLabels(key, [])
              savePrefs()
              buildMenu()
            }
          },
          { type: 'separator' },
          ...(labels.length
            ? labels.map(label => ({
                label: titleCase(label),
                type: 'checkbox',
                checked: !!(prefs.zoneLabels[key] && prefs.zoneLabels[key].includes(label)),
                click: (item) => toggleZoneLabel(key, label, item.checked)
              }))
            : [{ label: 'No objects found in Frigate', enabled: false }])
        ]
      })
    })
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

  const pauseOptionItems = PAUSE_OPTIONS.map(opt => ({
    label: opt.label,
    click: () => pauseUntil(opt.minutes == null ? endOfToday() : Date.now() + opt.minutes * 60 * 1000)
  }))
  const paused = isPaused()
  const pauseItems = paused
    ? [
        { label: `Paused until ${pausedUntilText()}`, enabled: false },
        { label: 'Resume pop-ups', click: () => resumeNow() },
        { label: 'Pause pop-ups', submenu: pauseOptionItems }
      ]
    : [{ label: 'Pause pop-ups', submenu: pauseOptionItems }]

  const menu = Menu.buildFromTemplate([
    ...pauseItems,
    { type: 'separator' },
    { label: 'Cameras', submenu: cameraItems },
    { label: 'Audio labels', submenu: audioLabelItems },
    { label: 'Only pop up in zones', submenu: zoneItems },
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
    {
      label: 'Show all objects in frame',
      type: 'checkbox',
      checked: prefs.showAllObjectsInFrame !== false,
      click: (item) => {
        prefs.showAllObjectsInFrame = item.checked
        savePrefs()
      }
    },
    {
      label: 'Show bounding boxes',
      type: 'checkbox',
      checked: prefs.showBoundingBoxes !== false,
      click: (item) => {
        prefs.showBoundingBoxes = item.checked
        savePrefs()
      }
    },
    {
      label: 'Match camera aspect ratio',
      type: 'checkbox',
      checked: prefs.dynamicSize !== false,
      click: (item) => {
        prefs.dynamicSize = item.checked
        if (!item.checked) clearDynamicAspect()
        savePrefs()
      }
    },
    {
      label: 'Dismiss when stationary',
      type: 'checkbox',
      checked: prefs.dismissOnStationary !== false,
      click: (item) => {
        prefs.dismissOnStationary = item.checked
        if (!item.checked) stationaryEvents.clear()
        savePrefs()
      }
    },
    { label: 'Dismiss after', submenu: dismissItems },
    { type: 'separator' },
    {
      label: 'Show live view',
      accelerator: registeredHotkey || undefined,
      registerAccelerator: false,
      click: () => toggleLiveView()
    },
    { label: 'Live view cameras', submenu: liveCameraItems },
    { type: 'separator' },
    { label: 'Set overlay position…', click: () => enterPlacement() },
    ...(config && config.placement ? [{ label: 'Reset overlay position', click: () => resetPlacement() }] : []),
    ...(prefs.popupScale !== 1 || prefs.liveScale !== 1 ? [{ label: 'Reset overlay size', click: () => resetSize() }] : []),
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

  if (tray) {
    tray.setContextMenu(menu)
    tray.setToolTip(paused ? `Peek (paused until ${pausedUntilText()})` : 'Peek')
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Peek')
  buildMenu()
}

function handleEvent(data) {
  if (placementMode) return
  const after = data.after || data.before
  if (!after || !after.label) return

  learnCamera(after.camera)
  if (!cameraEnabled(after.camera)) return

  const labels = config.labels || []
  if (labels.length && !labels.includes(after.label)) return

  ;[...(after.current_zones || []), ...(after.entered_zones || [])].forEach(z => learnZone(z, after.camera))
  learnObjectLabel(after.label)

  if (isPaused()) {
    if (data.type === 'end') {
      zoneEvents.delete(after.id)
      stationaryEvents.delete(after.id)
    }
    return
  }

  let type = data.type
  let zoneEntered = false
  if (prefs.zoneFilter.length) {
    if (zoneEvents.has(after.id)) {
      if (type === 'end') zoneEvents.delete(after.id)
    } else {
      if (type === 'end' || !eventInSelectedZone(after)) return
      type = 'new'
      zoneEntered = true
    }
  }

  if (prefs.dismissOnStationary !== false) {
    if (type === 'end') {
      stationaryEvents.delete(after.id)
    } else if (after.stationary === true) {
      if (stationaryEvents.has(after.id)) return
      stationaryEvents.add(after.id)
      type = 'end'
    } else if (stationaryEvents.has(after.id)) {
      stationaryEvents.delete(after.id)
      type = 'new'
    }
  } else if (type === 'end') {
    stationaryEvents.delete(after.id)
  }

  const score = Math.max(after.score || 0, after.top_score || 0)
  const minScore = config.minScore != null ? config.minScore : 0.6
  if (type === 'new' && score < minScore) return
  if (zoneEntered) zoneEvents.add(after.id)

  const subLabel = Array.isArray(after.sub_label) ? after.sub_label[0] : after.sub_label
  const event = {
    id: after.id,
    type,
    name: prettyName(after.camera),
    label: after.label,
    score,
    subLabel: subLabel || null,
    plate: after.recognized_license_plate || null,
    zones: after.entered_zones || [],
    box: prefs.showBoundingBoxes !== false ? normalizeBox(after.box, after.camera) : null,
    streamUrl: streamUrl(after.camera),
    poster: prefs.snapshot ? snapshotUrl(after.camera) : null,
    sound: prefs.sound,
    dismiss: prefs.dismissSeconds,
    clickUrl: clickUrlForEvent(after.camera, after.id),
    showAllObjectsInFrame: prefs.showAllObjectsInFrame !== false
  }

  if (!win || win.isDestroyed()) return
  if (type === 'new') revealOverlay()
  win.webContents.send('frigate-event', event)
}

function emitAudioEvent(type, camera, label) {
  if (placementMode) return
  if (!win || win.isDestroyed()) return
  if (!cameraEnabled(camera) || !audioLabelEnabled(label)) return
  if (type === 'new' && prefs.zoneFilter.length) return
  if (type === 'new' && isPaused()) return

  const id = `audio-${camera}-${label}`
  const event = {
    id,
    type,
    name: prettyName(camera),
    label,
    score: null,
    subLabel: null,
    plate: null,
    zones: [],
    box: null,
    streamUrl: streamUrl(camera),
    poster: prefs.snapshot ? snapshotUrl(camera) : null,
    sound: prefs.sound,
    dismiss: prefs.dismissSeconds,
    clickUrl: clickUrlForEvent(camera, id),
    showAllObjectsInFrame: prefs.showAllObjectsInFrame !== false
  }

  if (type === 'new') revealOverlay()
  win.webContents.send('frigate-event', event)
}

function handleAudioState(camera, label, on) {
  learnCamera(camera)
  learnAudioLabel(label)
  const key = `${camera}/${label}`
  if (on) {
    if (activeAudio.has(key)) return
    activeAudio.add(key)
    emitAudioEvent('new', camera, label)
  } else {
    if (!activeAudio.has(key)) return
    activeAudio.delete(key)
    emitAudioEvent('end', camera, label)
  }
}

function startMqtt() {
  const prefix = config.topicPrefix || 'frigate'
  const availableTopic = `${prefix}/available`
  mqttClient = mqtt.connect(config.mqtt, { reconnectPeriod: 3000 })
  mqttClient.on('connect', () => {
    mqttClient.subscribe(`${prefix}/events`)
    mqttClient.subscribe(availableTopic)
    mqttClient.subscribe(`${prefix}/+/audio/+`)
  })
  mqttClient.on('message', (topic, payload) => {
    if (topic === availableTopic) {
      handleFrigateAvailability(payload.toString())
      return
    }
    const parts = topic.split('/')
    if (parts.length === 4 && parts[2] === 'audio' && !AUDIO_NON_LABELS.has(parts[3])) {
      handleAudioState(parts[1], parts[3], payload.toString().trim() === 'ON')
      return
    }
    let data
    try {
      data = JSON.parse(payload.toString())
    } catch (err) {
      return
    }
    handleEvent(data)
  })
}

function handleFrigateAvailability(status) {
  const wasAvailable = frigateAvailable
  frigateAvailable = status === 'online'
  if (frigateAvailable && !wasAvailable) requestReauth()
}

function applyCertPin() {
  if (certProcSet) return
  certProcSet = true
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (frigatePin && request.hostname === frigatePin.host) {
      if (frigatePin.certSha256 == null) {
        callback(0)
        return
      }
      const sha = frigateAuth.pemToDerSha256(request.certificate && request.certificate.data)
      if (sha && sha === frigatePin.certSha256) {
        callback(0)
        return
      }
    }
    callback(-3)
  })
}

function parseJwtExp(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch (err) {
    return null
  }
}

function scheduleTokenRefresh(token) {
  if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer)
  const exp = parseJwtExp(token)
  if (!exp) return
  const msUntilExpiry = exp * 1000 - Date.now()
  const delay = Math.min(Math.max(msUntilExpiry - 60 * 1000, 60 * 1000), 55 * 60 * 1000)
  tokenRefreshTimer = setTimeout(() => initFrigateAuth(), delay)
}

async function initFrigateAuth() {
  if (!config || !frigateAuth.isHttps(config.frigateUrl)) return true
  const allowSelfSigned = !!config.frigateAllowSelfSigned
  if (!config.frigateUser) {
    if (allowSelfSigned) {
      frigatePin = { host: new URL(config.frigateUrl).hostname, certSha256: null }
      applyCertPin()
    }
    return true
  }
  try {
    const { token, certSha256 } = await frigateAuth.login(config.frigateUrl, config.frigateUser, config.frigatePassword, allowSelfSigned)
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
    scheduleTokenRefresh(token)
    if (win && !win.isDestroyed()) win.webContents.send('frigate-reauthed')
    return true
  } catch (err) {
    console.error('[frigate-auth] ' + err.message)
    return false
  }
}

function attemptReauth(retriesLeft) {
  initFrigateAuth().then((ok) => {
    if (ok) {
      reauthInFlight = false
      fetchFrigateConfig(frigateToken)
      return
    }
    if (retriesLeft > 0) {
      setTimeout(() => attemptReauth(retriesLeft - 1), REAUTH_RETRY_DELAY_MS)
    } else {
      reauthInFlight = false
    }
  })
}

function requestReauth() {
  const now = Date.now()
  if (reauthInFlight || now - lastReauthAttempt < REAUTH_MIN_INTERVAL_MS) return
  lastReauthAttempt = now
  reauthInFlight = true
  attemptReauth(REAUTH_MAX_RETRIES)
}

function startApp() {
  appStarted = true
  loadPrefs()
  schedulePauseEnd()
  applyOpenAtLogin(prefs.openAtLogin)
  createWindow()
  createTray()
  applyHotkey(prefs.liveHotkey)
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
    height: appStarted ? 1100 : 796,
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
    if (registeredHotkey && !globalShortcut.isRegistered(registeredHotkey)) {
      globalShortcut.register(registeredHotkey, toggleLiveView)
    }
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
      await frigateAuth.login(cfg.frigateUrl, cfg.frigateUser, cfg.frigatePassword, !!cfg.frigateAllowSelfSigned)
      return { ok: true, detail: 'MQTT broker and Frigate login OK.' }
    } catch (err) {
      return { ok: false, error: 'MQTT OK, but Frigate: ' + err.message }
    }
  }
  if (!cfg.frigateUser && frigateAuth.isHttps(cfg.frigateUrl)) {
    try {
      await frigateAuth.fetchConfig(cfg.frigateUrl, null, !!cfg.frigateAllowSelfSigned)
      return { ok: true, detail: 'MQTT broker and HTTPS Frigate URL OK.' }
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

  const { powerMonitor } = require('electron')
  powerMonitor.on('resume', () => {
    if (mqttClient) mqttClient.reconnect()
    initFrigateAuth()
    if (prefs) {
      schedulePauseEnd()
      buildMenu()
    }
  })

  ipcMain.on('overlay-hide', () => {
    liveView = null
    if (win && !win.isDestroyed()) win.hide()
  })
  ipcMain.on('overlay-stream-failed', () => {
    requestReauth()
  })
  ipcMain.on('overlay-open-url', (e, url) => {
    if (typeof url === 'string' && config && config.frigateUrl && url.startsWith(config.frigateUrl)) {
      shell.openExternal(url)
    }
  })
  ipcMain.on('placement-save', () => exitPlacement(true))
  ipcMain.on('placement-cancel', () => exitPlacement(false))
  ipcMain.on('overlay-resize', (e, aspect) => setDynamicAspect(aspect))
  ipcMain.on('overlay-scale', (e, factor) => scaleOverlay(factor))
  ipcMain.handle('setup-load', () => readConfig())
  ipcMain.handle('setup-test', (e, cfg) => testConnection(cfg))
  ipcMain.handle('setup-load-prefs', () => {
    const p = prefs || readPrefs()
    const cameras = appStarted
      ? [...knownCameras].sort().map(name => ({ name, label: prettyName(name), enabled: cameraEnabled(name) }))
      : []
    const liveCameras = appStarted
      ? [...knownCameras].sort().map(name => ({ name, label: prettyName(name), enabled: liveCameraEnabled(name) }))
      : []
    return {
      autoUpdate: !!(p && p.autoUpdate),
      showDock: !!(p && p.showDock),
      openAtLogin: !!(p && p.openAtLogin),
      clickAction: (p && p.clickAction) || 'event',
      platform: process.platform,
      started: appStarted,
      sound: !!(p && p.sound),
      snapshot: !!(p && p.snapshot),
      dismissSeconds: p && p.dismissSeconds != null ? p.dismissSeconds : 8,
      showAllObjectsInFrame: p && p.showAllObjectsInFrame !== false,
      showBoundingBoxes: p && p.showBoundingBoxes !== false,
      dynamicSize: p && p.dynamicSize !== false,
      dismissOnStationary: p && p.dismissOnStationary !== false,
      liveHotkey: p && typeof p.liveHotkey === 'string' ? p.liveHotkey : DEFAULT_LIVE_HOTKEY,
      cameras,
      liveCameras,
      zones: appStarted
        ? [...knownZones.keys()].sort().map(key => ({ name: key, label: zoneLabel(key), enabled: prefs.zoneFilter.includes(key) }))
        : [],
      zoneObjects: appStarted
        ? [...knownZones.keys()].sort().map(key => ({
            zone: key,
            label: titleCase(knownZones.get(key).name || key),
            objects: zoneObjectLabels(key).map(name => ({
              name,
              label: titleCase(name),
              enabled: !!(prefs.zoneLabels[key] && prefs.zoneLabels[key].includes(name))
            }))
          }))
        : []
    }
  })
  ipcMain.handle('setup-save', (e, cfg, opts) => {
    saveConfig(cfg)
    const wantUpdates = !!(opts && opts.autoUpdate)
    const wantDock = !!(opts && opts.showDock)
    const wantOpenAtLogin = !!(opts && opts.openAtLogin)
    if (!appStarted) {
      config = cfg
      startApp()
      prefs.autoUpdate = wantUpdates
      prefs.showDock = wantDock
      prefs.openAtLogin = wantOpenAtLogin
      savePrefs()
      applyOpenAtLogin(wantOpenAtLogin)
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
        config.frigatePassword !== cfg.frigatePassword ||
        !!config.frigateAllowSelfSigned !== !!cfg.frigateAllowSelfSigned
      const wasUpdates = !!prefs.autoUpdate
      prefs.autoUpdate = wantUpdates
      prefs.showDock = wantDock
      prefs.openAtLogin = wantOpenAtLogin
      applyRuntimePrefs(opts)
      savePrefs()
      applyOpenAtLogin(wantOpenAtLogin)
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
  ipcMain.handle('setup-check-hotkey', (e, accelerator) => hotkeyAvailable(accelerator))
  ipcMain.on('setup-hotkey-capture', (e, capturing) => {
    if (!appStarted || !registeredHotkey) return
    if (capturing) {
      globalShortcut.unregister(registeredHotkey)
    } else if (!globalShortcut.isRegistered(registeredHotkey)) {
      globalShortcut.register(registeredHotkey, toggleLiveView)
    }
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
app.on('will-quit', () => globalShortcut.unregisterAll())
