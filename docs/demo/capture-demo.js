const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const OUT = '/tmp/peekdemo'
const FPS = 15

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

app.whenReady().then(async () => {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  const win = new BrowserWindow({
    width: 900,
    height: 560,
    useContentSize: true,
    show: true,
    frame: false,
    webPreferences: { backgroundThrottling: false }
  })
  await win.loadFile(path.join(__dirname, 'demo.html'))
  await sleep(600)

  const period = await win.webContents.executeJavaScript('window.__period')
  const frames = Math.round(period / (1000 / FPS))

  for (let i = 0; i < frames; i++) {
    const t = (i * period) / frames
    await win.webContents.executeJavaScript(`window.__t=${t};window.__draw(${t});`)
    await sleep(40)
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(OUT, `frame-${String(i).padStart(4, '0')}.png`), img.toPNG())
  }

  console.log('CAPTURED ' + frames + ' frames in ' + OUT)
  app.quit()
})
