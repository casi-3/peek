const https = require('https')
const fs = require('fs')
const path = require('path')

const REPO = 'casi-3/peek'
const UA = 'Peek-Updater'

function get(url, json) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': UA,
        Accept: json ? 'application/vnd.github+json' : '*/*'
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        resolve(get(res.headers.location, json))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error('HTTP ' + res.statusCode))
        return
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        resolve(json ? JSON.parse(buf.toString()) : buf)
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('Request timed out')))
  })
}

function parseVersion(v) {
  return String(v).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0)
}

function isNewer(remote, local) {
  const a = parseVersion(remote)
  const b = parseVersion(local)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

function pickAsset(assets, platform) {
  const names = assets || []
  if (platform === 'win32') {
    return names.find(a => /setup.*\.exe$/i.test(a.name)) ||
      names.find(a => /\.exe$/i.test(a.name)) || null
  }
  if (platform === 'darwin') {
    return names.find(a => /\.zip$/i.test(a.name)) ||
      names.find(a => /\.dmg$/i.test(a.name)) || null
  }
  return names.find(a => /\.appimage$/i.test(a.name)) || null
}

async function getLatest(repo = REPO) {
  const data = await get(`https://api.github.com/repos/${repo}/releases/latest`, true)
  return {
    version: String(data.tag_name || '').replace(/^v/i, ''),
    name: data.name || data.tag_name || '',
    notes: data.body || '',
    url: data.html_url || '',
    assets: (data.assets || []).map(a => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size
    }))
  }
}

function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        resolve(download(res.headers.location, dest, onProgress))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error('HTTP ' + res.statusCode))
        return
      }
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let received = 0
      const file = fs.createWriteStream(dest)
      res.on('data', c => {
        received += c.length
        if (onProgress && total) onProgress(received / total)
      })
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve(dest)))
      file.on('error', err => {
        fs.unlink(dest, () => reject(err))
      })
    }).on('error', reject)
  })
}

function shouldNotify(prefs, version, now, throttleMs) {
  if (!prefs) return true
  if (prefs.skipVersion === version) return false
  const last = prefs.lastNotify || { version: '', at: 0 }
  if (last.version === version && (now - last.at) < throttleMs) return false
  return true
}

module.exports = { getLatest, isNewer, pickAsset, parseVersion, download, shouldNotify }
