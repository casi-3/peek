const https = require('https')
const http = require('http')
const crypto = require('crypto')

function isHttps(url) {
  return /^https:/i.test(String(url || ''))
}

function certSha256FromDer(der) {
  return crypto.createHash('sha256').update(der).digest('hex')
}

function pemToDerSha256(pem) {
  if (!pem) return null
  const b64 = String(pem)
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '')
  if (!b64) return null
  try {
    return certSha256FromDer(Buffer.from(b64, 'base64'))
  } catch (err) {
    return null
  }
}

function certErrorText(err) {
  const code = err && err.code
  if (code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return 'Frigate certificate is not trusted by this system. Enable "Allow self-signed certificate" if this is expected.'
  }
  if (code === 'CERT_HAS_EXPIRED') {
    return 'Frigate certificate has expired.'
  }
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || code === 'HOSTNAME_MISMATCH') {
    return 'Frigate certificate does not match the host name.'
  }
  return null
}

function login(frigateUrl, user, password, allowSelfSigned) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(frigateUrl)
    } catch (err) {
      reject(new Error('Invalid Frigate URL.'))
      return
    }
    const body = JSON.stringify({ user: user || '', password: password || '' })
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: '/api/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      rejectUnauthorized: !allowSelfSigned
    }, (res) => {
      let certSha256 = null
      try {
        const cert = res.socket.getPeerCertificate()
        if (cert && cert.raw) certSha256 = certSha256FromDer(cert.raw)
      } catch (err) {}
      let token = null
      const setCookie = res.headers['set-cookie'] || []
      for (const c of setCookie) {
        const m = /frigate_token=([^;]+)/.exec(c)
        if (m) { token = m[1]; break }
      }
      res.resume()
      res.on('end', () => {
        if (res.statusCode === 200 && token) {
          resolve({ token, certSha256 })
        } else if (res.statusCode === 401 || res.statusCode === 400) {
          reject(new Error('Invalid Frigate username or password.'))
        } else {
          reject(new Error('Frigate login failed (HTTP ' + res.statusCode + ').'))
        }
      })
    })
    req.on('error', (err) => {
      const certErr = certErrorText(err)
      reject(new Error(certErr || 'Could not reach Frigate: ' + err.message))
    })
    req.setTimeout(10000, () => req.destroy(new Error('Frigate login timed out.')))
    req.write(body)
    req.end()
  })
}

function fetchConfig(frigateUrl, token, allowSelfSigned) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(frigateUrl)
    } catch (err) {
      reject(new Error('Invalid Frigate URL.'))
      return
    }
    const secure = isHttps(frigateUrl)
    const mod = secure ? https : http
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: '/api/config',
      method: 'GET',
      headers: token ? { Cookie: 'frigate_token=' + token } : {},
      rejectUnauthorized: !allowSelfSigned
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()))
        } catch (e) {
          reject(new Error('Invalid response from /api/config.'))
        }
      })
    })
    req.on('error', (err) => {
      const certErr = certErrorText(err)
      reject(certErr ? new Error(certErr) : err)
    })
    req.setTimeout(10000, () => req.destroy(new Error('Frigate config fetch timed out.')))
    req.end()
  })
}

module.exports = { login, fetchConfig, isHttps, pemToDerSha256, certErrorText }
