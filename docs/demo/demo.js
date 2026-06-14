const card = document.getElementById('card')
const canvas = document.getElementById('feed')
const ctx = canvas.getContext('2d')
const W = canvas.width
const H = canvas.height
const groundY = 232

const PERIOD = 5200
const IN_AT = 500
const OUT_AT = 4500

function scene(time) {
  const sky = ctx.createLinearGradient(0, 0, 0, groundY)
  sky.addColorStop(0, '#10182b')
  sky.addColorStop(1, '#1d2a44')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, W, groundY)

  const ground = ctx.createLinearGradient(0, groundY, 0, H)
  ground.addColorStop(0, '#222c38')
  ground.addColorStop(1, '#161d27')
  ctx.fillStyle = ground
  ctx.fillRect(0, groundY, W, H - groundY)

  ctx.fillStyle = 'rgba(255,255,255,0.04)'
  for (let i = 0; i < 7; i++) {
    const px = 30 + i * 52 + Math.sin(i * 2.3) * 8
    ctx.fillRect(px, 70, 2, 2)
  }

  const lamp = ctx.createRadialGradient(36, 30, 6, 36, 30, 150)
  lamp.addColorStop(0, 'rgba(255, 214, 150, 0.55)')
  lamp.addColorStop(0.4, 'rgba(255, 200, 130, 0.16)')
  lamp.addColorStop(1, 'rgba(255, 200, 130, 0)')
  ctx.fillStyle = lamp
  ctx.fillRect(0, 0, W, H)

  ctx.fillStyle = '#0d1018'
  ctx.fillRect(238, 96, 86, 136)
  ctx.fillStyle = '#11151f'
  ctx.fillRect(246, 104, 70, 128)
  ctx.fillStyle = 'rgba(255, 210, 150, 0.10)'
  ctx.fillRect(254, 150, 18, 0)
}

function person(x, time) {
  const swing = Math.sin(time / 150) * 0.5
  const bob = Math.abs(Math.sin(time / 150)) * 3
  const baseY = groundY - bob
  const grad = ctx.createLinearGradient(x - 18, 0, x + 18, 0)
  grad.addColorStop(0, '#05070b')
  grad.addColorStop(1, '#1a2130')
  ctx.fillStyle = grad
  ctx.strokeStyle = grad

  ctx.save()
  ctx.lineCap = 'round'

  ctx.lineWidth = 9
  ctx.beginPath()
  ctx.moveTo(x, baseY - 78)
  ctx.lineTo(x, baseY - 34)
  ctx.stroke()

  ctx.lineWidth = 8
  ctx.beginPath()
  ctx.moveTo(x, baseY - 34)
  ctx.lineTo(x + Math.sin(swing) * 14, baseY)
  ctx.moveTo(x, baseY - 34)
  ctx.lineTo(x - Math.sin(swing) * 14, baseY)
  ctx.stroke()

  ctx.lineWidth = 7
  ctx.beginPath()
  ctx.moveTo(x, baseY - 70)
  ctx.lineTo(x + Math.cos(swing) * 13, baseY - 44)
  ctx.moveTo(x, baseY - 70)
  ctx.lineTo(x - Math.cos(swing) * 13, baseY - 44)
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(x, baseY - 90, 11, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function grain(time) {
  ctx.globalAlpha = 0.05
  for (let i = 0; i < 40; i++) {
    const gx = (Math.sin(i * 12.9 + time / 90) * 0.5 + 0.5) * W
    const gy = (Math.cos(i * 78.2 + time / 70) * 0.5 + 0.5) * H
    ctx.fillStyle = i % 2 ? '#ffffff' : '#000000'
    ctx.fillRect(gx, gy, 1.4, 1.4)
  }
  ctx.globalAlpha = 1

  ctx.globalAlpha = 0.04
  ctx.fillStyle = '#000'
  for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1)
  ctx.globalAlpha = 1

  const vig = ctx.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, 230)
  vig.addColorStop(0, 'rgba(0,0,0,0)')
  vig.addColorStop(1, 'rgba(0,0,0,0.45)')
  ctx.fillStyle = vig
  ctx.fillRect(0, 0, W, H)
}

function easeOutCubic(p) {
  return 1 - Math.pow(1 - p, 3)
}

function cardState(t) {
  const SLIDE = 520
  if (t < IN_AT) return { x: 440, o: 0 }
  if (t < IN_AT + SLIDE) {
    const p = easeOutCubic((t - IN_AT) / SLIDE)
    return { x: 440 * (1 - p), o: p }
  }
  if (t < OUT_AT) return { x: 0, o: 1 }
  if (t < OUT_AT + SLIDE) {
    const p = easeOutCubic((t - OUT_AT) / SLIDE)
    return { x: 440 * p, o: 1 - p }
  }
  return { x: 440, o: 0 }
}

function draw(t) {
  ctx.clearRect(0, 0, W, H)
  scene(t)
  if (t > IN_AT && t < OUT_AT + 400) {
    const p = (t - IN_AT) / (OUT_AT - IN_AT)
    person(-30 + p * 410, t)
  }
  grain(t)
  const s = cardState(t)
  card.style.transform = `translateX(${s.x}px)`
  card.style.opacity = s.o
}

window.__draw = draw
window.__period = PERIOD

function loop() {
  if (window.__t == null) draw(Date.now() % PERIOD)
  requestAnimationFrame(loop)
}

requestAnimationFrame(loop)
