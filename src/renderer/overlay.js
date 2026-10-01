import { VideoRTC } from './vendor/video-rtc.js'

customElements.define('video-stream', VideoRTC)

const LABELS = {
  person: ['🧍', 'Person'],
  car: ['🚗', 'Car'],
  motorcycle: ['🏍️', 'Motorcycle'],
  bicycle: ['🚲', 'Bicycle'],
  dog: ['🐕', 'Dog'],
  cat: ['🐈', 'Cat'],
  bird: ['🐦', 'Bird'],
  package: ['📦', 'Package'],
  crying: ['😢', 'Crying'],
  yell: ['📢', 'Yelling'],
  scream: ['😱', 'Screaming'],
  speech: ['🗣️', 'Speech'],
  bark: ['🐕', 'Barking'],
  fire_alarm: ['🚨', 'Fire alarm']
}

const COLORS = ['#ff6b6b', '#51cf66', '#339af0', '#fcc419', '#cc5de8', '#ff922b']

const card = document.getElementById('card')
const timerBar = document.getElementById('timer-bar')
const camEl = document.getElementById('cam')
const detectionsEl = document.getElementById('detections')
const infoEl = document.getElementById('info')
const videoBox = document.getElementById('video')
const bboxCanvas = document.getElementById('bbox-canvas')
const bboxCtx = bboxCanvas.getContext('2d')
const poster = document.getElementById('poster')
const closeBtn = document.getElementById('close')
const placementEl = document.getElementById('placement')
const placementLock = document.getElementById('placement-lock')
const placementCancel = document.getElementById('placement-cancel')

const activeEvents = new Map()
const colorMap = new Map()
let colorIndex = 0
let activeStreamUrl = null
let activeClickUrl = null
let stream = null
let dismissTimer = null
let timerAnimation = null
let lastShownEvent = null
let streamWatchdog = null
let streamPlaying = false
let streamFailed = false
let posterFailed = false

const STREAM_TIMEOUT_MS = 8000

function assignColor(id) {
  if (!colorMap.has(id)) {
    colorMap.set(id, COLORS[colorIndex % COLORS.length])
    colorIndex++
  }
  return colorMap.get(id)
}

function showTimerBarActive() {
  if (timerAnimation) { timerAnimation.cancel(); timerAnimation = null }
  timerBar.style.transform = 'scaleX(1)'
  timerBar.style.background = 'rgba(220, 60, 60, 0.85)'
  timerBar.style.opacity = '1'
}

function startTimerBar(seconds) {
  if (timerAnimation) timerAnimation.cancel()
  timerBar.style.background = 'rgba(255, 255, 255, 0.75)'
  timerBar.style.opacity = '1'
  timerAnimation = timerBar.animate(
    [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
    { duration: seconds * 1000, easing: 'linear', fill: 'forwards' }
  )
}

function resetTimerBar() {
  if (timerAnimation) { timerAnimation.cancel(); timerAnimation = null }
  timerBar.style.opacity = '0'
  timerBar.style.transform = ''
  timerBar.style.background = ''
}

function labelText(label) {
  const entry = LABELS[label]
  return entry ? `${entry[0]} ${entry[1]}` : label
}

function syncCanvasSize() {
  const w = bboxCanvas.offsetWidth
  const h = bboxCanvas.offsetHeight
  if (!w || !h) return false
  if (bboxCanvas.width !== w || bboxCanvas.height !== h) {
    bboxCanvas.width = w
    bboxCanvas.height = h
  }
  return true
}

function getVideoTransform() {
  if (!stream || !stream.video) return null
  const vw = stream.video.videoWidth
  const vh = stream.video.videoHeight
  if (!vw || !vh) return null

  const cw = bboxCanvas.width
  const ch = bboxCanvas.height
  const videoAspect = vw / vh
  const containerAspect = cw / ch

  let scale, offsetX, offsetY
  if (videoAspect > containerAspect) {
    scale = ch / vh
    offsetX = (cw - vw * scale) / 2
    offsetY = 0
  } else {
    scale = cw / vw
    offsetX = 0
    offsetY = (ch - vh * scale) / 2
  }
  return { scale, offsetX, offsetY, vw, vh }
}

function drawBoxes() {
  if (!syncCanvasSize()) return
  bboxCtx.clearRect(0, 0, bboxCanvas.width, bboxCanvas.height)

  const t = getVideoTransform()
  if (!t) return

  for (const [id, ev] of activeEvents) {
    if (!ev.box) continue
    const color = colorMap.get(id) || '#ffffff'
    const [x1, y1, x2, y2] = ev.box

    const cx = x1 * t.vw * t.scale + t.offsetX
    const cy = y1 * t.vh * t.scale + t.offsetY
    const bw = (x2 - x1) * t.vw * t.scale
    const bh = (y2 - y1) * t.vh * t.scale
    const r = Math.min(6, bw / 4, bh / 4)

    bboxCtx.beginPath()
    bboxCtx.roundRect(cx, cy, bw, bh, r)
    bboxCtx.shadowColor = 'rgba(0,0,0,0.75)'
    bboxCtx.shadowBlur = 4
    bboxCtx.strokeStyle = color
    bboxCtx.lineWidth = 2
    bboxCtx.stroke()
    bboxCtx.shadowBlur = 0
  }
}

function clearBoxes() {
  bboxCtx.clearRect(0, 0, bboxCanvas.width, bboxCanvas.height)
}

function renderDetections() {
  const events = [...activeEvents.values()]
  if (events.length > 0) camEl.textContent = events[0].name

  detectionsEl.innerHTML = ''
  for (const ev of events) {
    const color = colorMap.get(ev.id) || 'rgba(255, 255, 255, 0.45)'
    const chip = document.createElement('div')
    chip.className = 'chip'
    chip.style.borderColor = color
    const name = document.createElement('span')
    name.textContent = labelText(ev.label)
    chip.appendChild(name)
    if (ev.score != null) {
      const score = document.createElement('span')
      score.className = 'chip-score'
      score.textContent = Math.round(ev.score * 100) + '%'
      chip.appendChild(score)
    }
    detectionsEl.appendChild(chip)
  }

  const extras = []
  const subLabels = [...new Set(events.flatMap(e => e.subLabel ? [e.subLabel] : []))]
  const plates = [...new Set(events.flatMap(e => e.plate ? [e.plate] : []))]
  const zones = [...new Set(events.flatMap(e => e.zones || []))]
  if (subLabels.length) extras.push('👤 ' + subLabels.join(', '))
  if (plates.length) extras.push('🔢 ' + plates.join(', '))
  if (zones.length) extras.push('📍 ' + zones.join(', '))
  infoEl.textContent = extras.join('   ')
  infoEl.style.display = extras.length ? 'block' : 'none'
}

function applyVideoSettings(muted) {
  if (!stream) return
  if (stream.video) {
    stream.video.muted = muted
    stream.video.controls = false
    stream.video.disableRemotePlayback = true
    stream.video.addEventListener('playing', () => {
      streamPlaying = true
      clearTimeout(streamWatchdog)
      poster.style.opacity = '0'
      const vw = stream.video.videoWidth
      const vh = stream.video.videoHeight
      if (vw && vh) window.overlay.resize(vw / vh)
      drawBoxes()
    }, { once: true })
  } else {
    requestAnimationFrame(() => applyVideoSettings(muted))
  }
}

function startStream(url, muted) {
  stopStream()
  streamPlaying = false
  streamFailed = false
  stream = document.createElement('video-stream')
  stream.background = true
  stream.mode = 'webrtc,mse'
  stream.src = url
  videoBox.appendChild(stream)
  applyVideoSettings(muted)
  streamWatchdog = setTimeout(() => {
    if (!streamPlaying) {
      streamFailed = true
      window.overlay.streamFailed()
    }
  }, STREAM_TIMEOUT_MS)
}

function stopStream() {
  clearTimeout(streamWatchdog)
  if (stream) {
    stream.ondisconnect()
    stream.remove()
    stream = null
  }
}

function show(event) {
  clearTimeout(dismissTimer)
  lastShownEvent = event

  const reuseCard = card.classList.contains('show') && event.streamUrl === activeStreamUrl

  if (!reuseCard || !event.showAllObjectsInFrame) {
    activeEvents.clear()
    activeStreamUrl = event.streamUrl
  }

  activeClickUrl = event.clickUrl || null
  card.classList.toggle('clickable', !!activeClickUrl)

  assignColor(event.id)
  activeEvents.set(event.id, event)
  renderDetections()
  drawBoxes()
  showTimerBarActive()

  if (reuseCard) return

  posterFailed = false
  if (event.poster) {
    poster.style.opacity = '1'
    poster.src = event.poster + (event.poster.includes('?') ? '&' : '?') + 't=' + Date.now()
  } else {
    poster.style.opacity = '0'
    poster.removeAttribute('src')
  }
  startStream(event.streamUrl, !event.sound)
  card.classList.remove('hidden')
  requestAnimationFrame(() => card.classList.add('show'))
}

function hide() {
  clearTimeout(dismissTimer)
  resetTimerBar()
  clearBoxes()
  activeEvents.clear()
  colorMap.clear()
  colorIndex = 0
  activeStreamUrl = null
  activeClickUrl = null
  card.classList.remove('clickable')
  card.classList.remove('show')
  setTimeout(() => {
    stopStream()
    card.classList.add('hidden')
    window.overlay.hide()
  }, 320)
}

window.overlay.onEvent((event) => {
  if (event.type === 'new') {
    show(event)
  } else if (event.type === 'update' && activeEvents.has(event.id)) {
    activeEvents.set(event.id, event)
    renderDetections()
    drawBoxes()
  } else if (event.type === 'end' && activeEvents.has(event.id)) {
    activeEvents.delete(event.id)
    colorMap.delete(event.id)
    if (activeEvents.size > 0) {
      renderDetections()
      drawBoxes()
    } else {
      clearBoxes()
      if (event.dismiss > 0) {
        dismissTimer = setTimeout(hide, event.dismiss * 1000)
        startTimerBar(event.dismiss)
      }
    }
  }
})

poster.addEventListener('error', () => {
  if (!card.classList.contains('show')) return
  posterFailed = true
  window.overlay.streamFailed()
})

window.overlay.onReauth(() => {
  if (!card.classList.contains('show') || !lastShownEvent) return
  if (posterFailed && lastShownEvent.poster) {
    posterFailed = false
    poster.style.opacity = '1'
    poster.src = lastShownEvent.poster + (lastShownEvent.poster.includes('?') ? '&' : '?') + 't=' + Date.now()
  }
  if (streamFailed) {
    startStream(lastShownEvent.streamUrl, !lastShownEvent.sound)
  }
})

closeBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  hide()
})

card.addEventListener('click', () => {
  if (activeClickUrl) window.overlay.openUrl(activeClickUrl)
})

window.overlay.onMode((mode) => {
  placementEl.classList.toggle('hidden', mode !== 'placement')
})

placementLock.addEventListener('click', () => window.overlay.lockPlacement())
placementCancel.addEventListener('click', () => window.overlay.cancelPlacement())
