import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { RequestHandler, Request, Response, NextFunction } from 'express'

const TOKEN_COOKIE = 'portal_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SESSION_STORE_FILE = 'webui-auth-sessions.json'
const MAX_PERSISTED_TOKENS = 128

type PersistedAuthState = {
  tokens?: Array<{
    value?: unknown
    expiresAt?: unknown
  }>
}

function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!header) return cookies
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    const key = pair.slice(0, idx).trim()
    const value = pair.slice(idx + 1).trim()
    cookies[key] = value
  }
  return cookies
}

function isLocalhostRemote(remote: string): boolean {
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

function isLocalhostHost(host: string): boolean {
  const normalized = host.toLowerCase()
  return normalized.startsWith('localhost:') || normalized === 'localhost' || normalized.startsWith('127.0.0.1:')
}

function isIPv4Octet(value: string): boolean {
  if (!/^\d{1,3}$/.test(value)) return false
  const parsed = Number.parseInt(value, 10)
  return parsed >= 0 && parsed <= 255
}

function isTrustedTailscaleIPv4(remote: string): boolean {
  const normalized = remote.startsWith('::ffff:') ? remote.slice('::ffff:'.length) : remote
  const parts = normalized.split('.')
  if (parts.length !== 4 || !parts.every(isIPv4Octet)) {
    return false
  }

  const first = Number.parseInt(parts[0] ?? '', 10)
  const second = Number.parseInt(parts[1] ?? '', 10)
  return first === 100 && second >= 64 && second <= 127
}

function isTrustedTailscaleIPv6(remote: string): boolean {
  const normalized = remote.toLowerCase()
  return normalized === 'fd7a:115c:a1e0::1' || normalized.startsWith('fd7a:115c:a1e0:')
}

function isTrustedTailscaleRemote(remote: string): boolean {
  return isTrustedTailscaleIPv4(remote) || isTrustedTailscaleIPv6(remote)
}

function isTrustedPrivateRemote(remote: string): boolean {
  const normalized = remote.startsWith('::ffff:') ? remote.slice('::ffff:'.length) : remote.toLowerCase()
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) return true
  const parts = normalized.split('.')
  if (parts.length !== 4 || !parts.every(isIPv4Octet)) return false
  const first = Number.parseInt(parts[0] ?? '', 10)
  const second = Number.parseInt(parts[1] ?? '', 10)
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
}

function isTrustedLanRequest(remoteAddress: string | undefined, hostHeader: string | undefined): boolean {
  const remote = remoteAddress ?? ''
  if (isLocalhostRemote(remote)) return isLocalhostHost(hostHeader ?? '')
  return isTrustedPrivateRemote(remote) || isTrustedTailscaleRemote(remote)
}

function getCodexHomeDir(): string {
  const codexHome = process.env.CODEX_HOME?.trim()
  return codexHome && codexHome.length > 0 ? codexHome : join(homedir(), '.codex')
}

function getSessionStorePath(): string {
  return join(getCodexHomeDir(), SESSION_STORE_FILE)
}

function readPersistedSessions(): Map<string, number> {
  const sessionStorePath = getSessionStorePath()
  if (!existsSync(sessionStorePath)) return new Map()

  try {
    const raw = readFileSync(sessionStorePath, 'utf8')
    const parsed = JSON.parse(raw) as PersistedAuthState
    const now = Date.now()
    const sessions = new Map<string, number>()
    for (const entry of parsed.tokens ?? []) {
      const token = typeof entry?.value === 'string' ? entry.value : ''
      const expiresAt = typeof entry?.expiresAt === 'number' ? entry.expiresAt : 0
      if (!token || !Number.isFinite(expiresAt) || expiresAt <= now) continue
      sessions.set(token, expiresAt)
    }
    return sessions
  } catch {
    return new Map()
  }
}

function persistSessions(validTokens: Map<string, number>): void {
  const sessionStorePath = getSessionStorePath()
  mkdirSync(dirname(sessionStorePath), { recursive: true })

  const tokens = Array.from(validTokens.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_PERSISTED_TOKENS)
    .map(([value, expiresAt]) => ({ value, expiresAt }))
  const tmpPath = `${sessionStorePath}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify({ tokens }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmpPath, sessionStorePath)
}

function tryPersistSessions(validTokens: Map<string, number>): void {
  try {
    persistSessions(validTokens)
  } catch (error) {
    console.warn('[auth] failed to persist login sessions:', error)
  }
}

function pruneExpiredSessions(validTokens: Map<string, number>): boolean {
  const now = Date.now()
  let changed = false
  for (const [token, expiresAt] of validTokens.entries()) {
    if (expiresAt > now) continue
    validTokens.delete(token)
    changed = true
  }
  return changed
}

function buildSessionCookie(token: string, expiresAt: number): string {
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  return [
    `${TOKEN_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(maxAgeSeconds)}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ].join('; ')
}

function isAuthorizedByRequestLike(
  remoteAddress: string | undefined,
  hostHeader: string | undefined,
  cookieHeader: string | undefined,
  validTokens: Map<string, number>,
): boolean {
  const remote = remoteAddress ?? ''
  // SSH reverse tunnels terminate on loopback, so remoteAddress alone is not enough
  // to prove this is a direct local browser request.
  if (isLocalhostRemote(remote) && isLocalhostHost(hostHeader ?? '')) {
    return true
  }
  if (isTrustedTailscaleRemote(remote)) {
    return true
  }

  const cookies = parseCookies(cookieHeader)
  const token = cookies[TOKEN_COOKIE]
  if (!token) return false
  const expiresAt = validTokens.get(token)
  return typeof expiresAt === 'number' && expiresAt > Date.now()
}

const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex Web</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0a0a0a;color:#e5e5e5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem}
.card{background:#171717;border:1px solid #262626;border-radius:12px;padding:2rem;width:100%;max-width:380px}
h1{font-size:1.25rem;font-weight:600;margin-bottom:1.5rem;text-align:center;color:#fafafa}
label{display:block;font-size:.875rem;color:#a3a3a3;margin-bottom:.5rem}
input{width:100%;padding:.625rem .75rem;background:#0a0a0a;border:1px solid #404040;border-radius:8px;color:#fafafa;font-size:1rem;outline:none;transition:border-color .15s}
input:focus{border-color:#3b82f6}
button{width:100%;padding:.625rem;margin-top:1rem;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:.9375rem;font-weight:500;cursor:pointer;transition:background .15s}
button:hover{background:#2563eb}
.error{color:#ef4444;font-size:.8125rem;margin-top:.75rem;text-align:center;display:none}
</style>
</head>
<body>
<div class="card">
<h1>Codex Web</h1>
<form id="f">
<label for="pw">Password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Sign in</button>
<p class="error" id="err">Incorrect password</p>
</form>
</div>
<script>
const form=document.getElementById('f');
const errEl=document.getElementById('err');
form.addEventListener('submit',async e=>{
  e.preventDefault();
  errEl.style.display='none';
  const res=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
  if(res.ok){window.location.reload()}else{errEl.style.display='block';document.getElementById('pw').value='';document.getElementById('pw').focus()}
});
</script>
</body>
</html>`

const FIRST_RUN_SETUP_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex Remote · 首次使用设置</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;background:#f4f4f5;color:#18181b;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem}
.card{background:#fff;border:1px solid #e4e4e7;border-radius:18px;padding:1.5rem;width:100%;max-width:440px;box-shadow:0 20px 50px rgba(0,0,0,.12)}
.eyebrow{color:#71717a;font-size:.75rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin-bottom:.65rem}
h1{font-size:1.4rem;font-weight:650;color:#18181b}
.intro{color:#52525b;font-size:.9rem;line-height:1.6;margin-top:.65rem}
.choice{border:1px solid #e4e4e7;border-radius:14px;padding:1rem;margin-top:1.1rem}
.choice h2{font-size:1rem;margin-bottom:.4rem}
.choice p{color:#71717a;font-size:.82rem;line-height:1.55}
label{display:block;font-size:.82rem;font-weight:600;color:#3f3f46;margin:1rem 0 .4rem}
input{width:100%;padding:.7rem .8rem;background:#fff;border:1px solid #d4d4d8;border-radius:9px;color:#18181b;font-size:1rem;outline:none}
input:focus{border-color:#18181b;box-shadow:0 0 0 3px rgba(24,24,27,.1)}
button{width:100%;padding:.72rem;margin-top:.75rem;border-radius:9px;font-size:.9rem;font-weight:600;cursor:pointer}
.primary{background:#18181b;color:#fff;border:1px solid #18181b}
.secondary{background:#fff;color:#3f3f46;border:1px solid #d4d4d8}
.warning{color:#b45309!important;margin-top:.5rem}
.error{color:#dc2626;font-size:.8rem;margin-top:.65rem;display:none}
@media(prefers-color-scheme:dark){body{background:#09090b;color:#f4f4f5}.card{background:#18181b;border-color:#3f3f46}.eyebrow,.choice p{color:#a1a1aa}h1,.choice h2{color:#fafafa}.intro{color:#d4d4d8}.choice{border-color:#3f3f46}label{color:#d4d4d8}input{background:#09090b;border-color:#52525b;color:#fafafa}.primary{background:#fafafa;border-color:#fafafa;color:#18181b}.secondary{background:#27272a;border-color:#52525b;color:#e4e4e7}}
</style>
</head>
<body>
<main class="card">
  <p class="eyebrow">Codex Remote</p>
  <h1>首次使用设置</h1>
  <p class="intro">选择适合你的访问方式。设置完成后会进入 Codex 页面。</p>
  <section class="choice">
    <h2>设置访问密码</h2>
    <p>如果你准备通过璇玑星桥或其他方式从公网访问，必须先设置密码。</p>
    <form id="password-form">
      <label for="password">密码</label>
      <input id="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
      <label for="confirm-password">确认密码</label>
      <input id="confirm-password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
      <button class="primary" type="submit">设置密码并继续</button>
      <p class="error" id="password-error"></p>
    </form>
  </section>
  <section class="choice">
    <h2>仅局域网使用</h2>
    <p>不设置密码，直接在当前电脑和可信局域网中使用。</p>
    <p class="warning">不设置密码时无法启用公网远程访问。</p>
    <button class="secondary" id="skip-password" type="button">暂不设置，仅局域网使用</button>
  </section>
</main>
<script>
const form=document.getElementById('password-form');
const passwordInput=document.getElementById('password');
const confirmInput=document.getElementById('confirm-password');
const errorElement=document.getElementById('password-error');
const skipButton=document.getElementById('skip-password');
function showError(message){errorElement.textContent=message;errorElement.style.display='block'}
function setBusy(busy){for(const element of document.querySelectorAll('button,input'))element.disabled=busy}
async function post(path,body){
  const response=await fetch(path,{method:'POST',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(typeof payload.error==='string'?payload.error:'设置失败，请重试。');
}
form.addEventListener('submit',async event=>{
  event.preventDefault();errorElement.style.display='none';
  if(passwordInput.value!==confirmInput.value){showError('两次输入的密码不一致。');confirmInput.focus();return}
  setBusy(true);
  try{await post('/auth/setup',{password:passwordInput.value});window.location.reload()}
  catch(error){setBusy(false);showError(error instanceof Error?error.message:'设置失败，请重试。')}
});
skipButton.addEventListener('click',async()=>{
  if(!window.confirm('确认仅在本机和局域网使用？未设置密码时无法启用公网远程访问。'))return;
  errorElement.style.display='none';setBusy(true);
  try{await post('/auth/setup/skip');window.location.reload()}
  catch(error){setBusy(false);showError(error instanceof Error?error.message:'设置失败，请重试。')}
});
</script>
</body>
</html>`

const LAN_ONLY_DENIED_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex Remote</title></head><body><h1>已禁止公网访问</h1><p>未设置访问密码，仅允许从本机或局域网访问。</p></body></html>`

export function createAuthMiddleware(password: string): RequestHandler {
  return createAuthSession(password).middleware
}

export type AuthSession = {
  middleware: RequestHandler
  isRequestAuthorized: (req: IncomingMessage) => boolean
  hasPassword: () => boolean
}

export type AuthSessionOptions = {
  password?: string
  setupRequired?: boolean
  persistPassword?: (password: string) => Promise<void>
  persistPasswordSkip?: () => Promise<void>
  lanOnly?: boolean
}

export function createAuthSession(passwordOrOptions: string | AuthSessionOptions): AuthSession {
  const options = typeof passwordOrOptions === 'string' ? { password: passwordOrOptions } : passwordOrOptions
  let password = options.password ?? ''
  let setupRequired = options.setupRequired === true
  let lanOnly = options.lanOnly === true
  const validTokens = password ? readPersistedSessions() : new Map<string, number>()
  if (pruneExpiredSessions(validTokens)) {
    tryPersistSessions(validTokens)
  }

  function createSignedInSession(res: Response): void {
    validTokens.clear()
    const token = randomBytes(32).toString('hex')
    const expiresAt = Date.now() + SESSION_TTL_MS
    validTokens.set(token, expiresAt)
    tryPersistSessions(validTokens)
    res.setHeader('Set-Cookie', buildSessionCookie(token, expiresAt))
  }

  function handlePasswordUpdate(req: Request, res: Response): void {
    let body = ''
    let bodyTooLarge = false
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      if (bodyTooLarge) return
      body += chunk
      if (body.length > 4096) bodyTooLarge = true
    })
    req.on('end', () => {
      void (async () => {
        if (bodyTooLarge) {
          res.status(413).json({ error: '请求内容过大。' })
          return
        }
        let parsed: { password?: string }
        try {
          parsed = JSON.parse(body) as { password?: string }
        } catch {
          res.status(400).json({ error: '请求内容无效。' })
          return
        }
        const nextPassword = typeof parsed.password === 'string' ? parsed.password : ''
        if (nextPassword.length < 8 || nextPassword.length > 128) {
          res.status(400).json({ error: '密码长度需要在 8 到 128 个字符之间。' })
          return
        }
        if (!options.persistPassword) {
          res.status(500).json({ error: '当前启动方式不支持保存密码。' })
          return
        }
        try {
          await options.persistPassword(nextPassword)
          password = nextPassword
          setupRequired = false
          lanOnly = false
          createSignedInSession(res)
          res.json({ ok: true, passwordProtected: true, lanOnly: false })
        } catch {
          res.status(500).json({ error: '密码保存失败，请检查 Codex 配置目录权限。' })
        }
      })()
    })
  }

  function handleAuthorizedSecurityRoute(req: Request, res: Response): boolean {
    if (req.method === 'GET' && req.path === '/auth/status') {
      res.json({ passwordProtected: password.length > 0, lanOnly })
      return true
    }
    if (req.method === 'POST' && req.path === '/auth/password') {
      handlePasswordUpdate(req, res)
      return true
    }
    return false
  }

  const middleware: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    if (password && pruneExpiredSessions(validTokens)) {
      tryPersistSessions(validTokens)
    }

    if (setupRequired) {
      if (!isTrustedLanRequest(req.socket.remoteAddress, req.headers.host)) {
        res.status(403).type('text/html; charset=utf-8').send(LAN_ONLY_DENIED_HTML)
        return
      }
      if (req.method === 'POST' && req.path === '/auth/setup/skip') {
        if (!options.persistPasswordSkip) {
          res.status(500).json({ error: '当前启动方式不支持跳过密码设置。' })
          return
        }
        void options.persistPasswordSkip()
          .then(() => {
            setupRequired = false
            password = ''
            lanOnly = true
            validTokens.clear()
            tryPersistSessions(validTokens)
            res.json({ ok: true, passwordProtected: false })
          })
          .catch(() => {
            res.status(500).json({ error: '使用模式保存失败，请检查 Codex 配置目录权限。' })
          })
        return
      }
      if (req.method === 'POST' && req.path === '/auth/setup') {
        handlePasswordUpdate(req, res)
        return
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.status(200).send(FIRST_RUN_SETUP_HTML)
      return
    }

    if (!password) {
      if (lanOnly && !isTrustedLanRequest(req.socket.remoteAddress, req.headers.host)) {
        res.status(403).type('text/html; charset=utf-8').send(LAN_ONLY_DENIED_HTML)
        return
      }
      if (handleAuthorizedSecurityRoute(req, res)) return
      next()
      return
    }

    if (isAuthorizedByRequestLike(req.socket.remoteAddress, req.headers.host, req.headers.cookie, validTokens)) {
      if (handleAuthorizedSecurityRoute(req, res)) return
      next()
      return
    }

    // Handle login POST
    if (req.method === 'POST' && req.path === '/auth/login') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        let parsed: { password?: string }
        try {
          parsed = JSON.parse(body) as { password?: string }
        } catch {
          res.status(400).json({ error: 'Invalid request body' })
          return
        }

        const provided = typeof parsed.password === 'string' ? parsed.password : ''
        if (!constantTimeCompare(provided, password)) {
          res.status(401).json({ error: 'Invalid password' })
          return
        }

        try {
          const token = randomBytes(32).toString('hex')
          const expiresAt = Date.now() + SESSION_TTL_MS
          validTokens.set(token, expiresAt)
          tryPersistSessions(validTokens)
          res.setHeader('Set-Cookie', buildSessionCookie(token, expiresAt))
          res.json({ ok: true })
        } catch {
          res.status(500).json({ error: 'Failed to create login session' })
        }
      })
      return
    }

    // Handle one-click auth links like /password=<value>
    if (req.method === 'GET' && req.path.startsWith('/password=')) {
      const provided = req.path.slice('/password='.length)
      if (constantTimeCompare(provided, password)) {
        const token = randomBytes(32).toString('hex')
        const expiresAt = Date.now() + SESSION_TTL_MS
        validTokens.set(token, expiresAt)
        tryPersistSessions(validTokens)
        res.setHeader('Set-Cookie', buildSessionCookie(token, expiresAt))
        res.redirect(302, '/')
        return
      }
    }

    // No valid session — serve login page
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.status(200).send(LOGIN_PAGE_HTML)
  }

  return {
    middleware,
    isRequestAuthorized: (req: IncomingMessage) => setupRequired
      ? false
      : password
        ? isAuthorizedByRequestLike(req.socket.remoteAddress, req.headers.host, req.headers.cookie, validTokens)
        : !lanOnly || isTrustedLanRequest(req.socket.remoteAddress, req.headers.host),
    hasPassword: () => password.length > 0,
  }
}
