/**
 * qq-bot-bridge.mjs —— QQ 小号机器人 ↔ DSH(DeepSeek) 双向桥
 *
 * 架构：
 *   你的 QQ(主号) --私聊--> 小号 QQ（NapCat 注入的官方客户端）
 *        NapCat OneBot 11：HTTP 上报事件 → 本脚本 /onebot；HTTP API ← 本脚本发回复
 *        本脚本：把消息投给 DSH 会话（hub /x-hub）→ 等 DeepSeek 回复 → 用 OneBot API 发回 QQ
 *
 * 零依赖（node:http + fetch）。
 *
 * 用法：
 *   node qq-bot-bridge.mjs --check                 # 检查 OneBot API / hub / 配置
 *   node qq-bot-bridge.mjs                         # 正式跑（读同目录 bot-bridge.config.json）
 *   node qq-bot-bridge.mjs --config <路径> --dry-run --once   # 自测：不真发 QQ
 *
 * NapCat 侧需要两个网络配置（见 napcat/README.md）：
 *   HTTP 服务端（供本脚本调用发消息）：127.0.0.1:3000，token=config.onebot.token
 *   HTTP 客户端（把事件推给本脚本）：http://127.0.0.1:19390/onebot，token 同上
 */
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_CONFIG = {
  onebot: { api: 'http://127.0.0.1:3000', token: '' },
  callback: { host: '127.0.0.1', port: 19390, path: '/onebot' },
  trigger: { keyword: ['小D', '小d', 'ds'], mode: 'keyword', groups: false, allowFrom: [] },
  dsh: { session: 'new', cwd: 'D:\\AI\\日常', replyTimeoutMs: 180000, sessionFile: path.join(HERE, 'out', 'bot-session.json') },
  reply: { sendBack: true, maxChars: 1200, noReplyText: '（DeepSeek 这次没有产出回复，稍后再试）' },
  // 会话轮换（零 token：本地写交接件 → 建新会话 → 下条消息注入摘要）
  rotation: {
    enabled: true,
    everyMessages: 120,      // 定量：处理满 N 条 QQ 消息后轮换
    everyHours: 24,          // 定期：会话存活超过 N 小时
    pressureTokens: 150000,  // 定量缓存：上下文压力（projcache.pressureTokens）超过 N 即轮换
    costYuan: 2.5,           // 定量成本：本会话累计估算成本 ≥ ¥N
    cwd: 'D:\\AI\\日常',     // 新会话工作区（交付日常）
    outDir: 'D:\\AI\\日常\\QQ机器人\\交接',
    index: 'D:\\AI\\日常\\QQ机器人\\README.md',
    rotateScript: path.join(HERE, 'qq-bot-rotate.mjs'),
    stateFile: path.join(HERE, 'out', 'bot-state.json'),
    pendingFile: path.join(HERE, 'out', 'bot-pending-handoff.json'),
  },
  // 余额闸：低于停工线直接回一句并跳过模型，避免烧钱
  balance: {
    enabled: true,
    endpoint: 'http://127.0.0.1:50281/x-balance',
    tokenFile: path.join(os.homedir(), '.dsh', 'balance-widget.json'),
    floorYuan: 30,
    checkSeconds: 300,
  },
  logFile: path.join(HERE, 'out', 'bot-bridge.log'),
}

// ── 参数 ───────────────────────────────────────────────────────────────────
const args = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const k = a.slice(2), v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) args[k] = true
  else { args[k] = v; i += 1 }
}
const configPath = path.resolve(args.config ?? path.join(HERE, 'bot-bridge.config.json'))
function deepMerge(base, extra) {
  const out = { ...base }
  for (const [k, v] of Object.entries(extra ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v)
      : v
  }
  return out
}
const config = existsSync(configPath) ? deepMerge(DEFAULT_CONFIG, JSON.parse(readFileSync(configPath, 'utf8'))) : DEFAULT_CONFIG
if (args.once) args.once = true
const dryRun = args['dry-run'] === true
mkdirSync(path.dirname(config.logFile), { recursive: true })

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`
  console.log(line)
  try { writeFileSync(config.logFile, line + '\n', { flag: 'a' }) } catch { /* ignore */ }
}

// ── OneBot API ─────────────────────────────────────────────────────────────
const onebotApi = (action) => `${config.onebot.api.replace(/\/$/, '')}/${action}`
async function onebotCall(action, params = {}) {
  const url = config.onebot.token ? `${onebotApi(action)}?access_token=${encodeURIComponent(config.onebot.token)}` : onebotApi(action)
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) })
  const body = await res.json().catch(() => ({}))
  if (body.status !== 'ok' && body.retcode !== 0) throw new Error(`OneBot ${action} 失败: ${JSON.stringify(body).slice(0, 300)}`)
  return body
}
async function sendToQq(event, text) {
  const message = [{ type: 'text', data: { text } }]
  if (event.message_type === 'group') return onebotCall('send_group_msg', { group_id: event.group_id, message })
  return onebotCall('send_private_msg', { user_id: event.user_id, message })
}
async function loginInfo() { return onebotCall('get_login_info') }

// ── DSH hub ────────────────────────────────────────────────────────────────
const hubState = JSON.parse(readFileSync(path.join(os.homedir(), '.dsh', 'session-hub.json'), 'utf8'))
const hubBase = hubState.endpoint.replace(/\/$/, '')
const hubToken = hubState.token
async function hubCall(rest, init) {
  const url = `${hubBase}${rest}${rest.includes('?') ? '&' : '?'}token=${encodeURIComponent(hubToken)}`
  const res = await fetch(url, init)
  const body = await res.json()
  if (!res.ok || body.ok === false) throw new Error(`hub ${res.status}: ${body.error ?? ''}`)
  return body
}
function sessionFile() { return path.resolve(config.dsh.sessionFile) }
function loadSessionId() {
  try { return JSON.parse(readFileSync(sessionFile(), 'utf8')).sessionId ?? null } catch { return null }
}
function saveSessionId(sessionId) {
  try { mkdirSync(path.dirname(sessionFile()), { recursive: true }); writeFileSync(sessionFile(), JSON.stringify({ sessionId, updatedAt: new Date().toISOString() }, null, 2)) } catch { /* ignore */ }
}
async function ensureSession() {
  const wanted = String(config.dsh.session ?? 'new')
  if (wanted.startsWith('session-')) return wanted
  const existing = loadSessionId()
  if (existing) return existing
  const body = await hubCall(`/sessions?cwd=${encodeURIComponent(config.dsh.cwd)}`, { method: 'POST' })
  const sessionId = body.sessionId
  saveSessionId(sessionId)
  log(`[DSH] 新建会话: ${sessionId}`)
  return sessionId
}
async function dshTail(sessionId, n = 30) { return hubCall(`/sessions/${encodeURIComponent(sessionId)}/tail?n=${n}`) }
async function dshSend(sessionId, text) {
  return hubCall(`/sessions/${encodeURIComponent(sessionId)}/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, mode: 'queue' }),
  })
}
async function waitDshReply(sessionId, startedAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const tail = await dshTail(sessionId, 30)
      const replies = (tail.messages ?? []).filter((m) => m.role === 'assistant' && (m.time ?? 0) >= startedAt - 2000)
      if (replies.length > 0) {
        const text = replies[replies.length - 1]?.text
        if (text && text !== last) return text
      }
    } catch { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return last
}

// ── 会话轮换：状态 / 指标 / 触发 / 执行 ────────────────────────────────────
const PROJ_DIR = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')
function botStateFile() { return path.resolve(config.rotation.stateFile) }
function loadBotState() {
  try { return JSON.parse(readFileSync(botStateFile(), 'utf8')) } catch { return { sessionId: null, messages: 0, since: null } }
}
function saveBotState(state) {
  try { mkdirSync(path.dirname(botStateFile()), { recursive: true }); writeFileSync(botStateFile(), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)) } catch { /* ignore */ }
}
function readSessionMetrics(sessionId) {
  try {
    const j = JSON.parse(readFileSync(path.join(PROJ_DIR, sessionId + '.json'), 'utf8'))
    const rows = (j.record ?? j).rows ?? {}
    const val = (k) => (rows[k] ? (rows[k].val !== undefined ? rows[k].val : rows[k]) : null)
    const usage = (val('tokenUsage') ?? {}).totals ?? {}
    const stats = val('sessionStats') ?? {}
    const pressure = val('contextPressure') ?? {}
    const identity = (j.record ?? j).identity ?? {}
    const miss = Number(usage.uncachedInputTokens ?? 0)
    const cache = Number(usage.cacheReadTokens ?? 0)
    const out = Number(usage.outputTokens ?? 0)
    return {
      turns: Number(stats.turns ?? 0),
      pressureTokens: Number(pressure.pressureTokens ?? 0),
      cost: (miss * 0.15 + cache * 0.003 + out * 0.6) / 1e6 * 7.2,
      createdAt: Number(identity.createdAt ?? 0),
    }
  } catch { return null }
}
function rotationReason(sessionId) {
  const r = config.rotation ?? {}
  if (!r.enabled) return null
  const st = loadBotState()
  if (st.sessionId !== sessionId) { saveBotState({ sessionId, messages: 0, since: new Date().toISOString() }); return null }
  const msgs = Number(st.messages ?? 0)
  const hours = st.since ? (Date.now() - Date.parse(st.since)) / 3600e3 : 0
  if (msgs > 0 && msgs >= Number(r.everyMessages ?? Infinity)) return `messages=${msgs}`
  if (hours >= Number(r.everyHours ?? Infinity)) return `hours=${hours.toFixed(1)}`
  const m = readSessionMetrics(sessionId)
  if (m) {
    if (m.pressureTokens > 0 && m.pressureTokens >= Number(r.pressureTokens ?? Infinity)) return `pressure=${m.pressureTokens}`
    if (m.cost >= Number(r.costYuan ?? Infinity)) return `cost=¥${m.cost.toFixed(2)}`
  }
  return null
}
function runRotation(sessionId, reason) {
  const script = path.resolve(config.rotation.rotateScript)
  log(`[轮换] 触发（${reason}），准备轮换会话 ${sessionId}…`)
  try {
    const out = spawnSync(process.execPath, [script, '--apply', '--json', '--reason', reason,
      '--session', sessionId,
      '--cwd', config.rotation.cwd ?? config.dsh.cwd,
      '--out-dir', config.rotation.outDir,
      '--index', config.rotation.index,
    ], { encoding: 'utf8', timeout: 120000 })
    const text = `${out.stdout ?? ''}\n${out.stderr ?? ''}`
    const line = text.split(/\r?\n/u).map((l) => l.trim()).filter((l) => l.startsWith('{"ok"')).pop()
    if (out.status !== 0 || !line) { log(`[轮换] 失败（status=${out.status}）: ${text.slice(-400)}`); return null }
    const result = JSON.parse(line)
    log(`[轮换] 完成：${result.oldSessionId} → ${result.newSessionId}，交接件 ${result.handoffPath}`)
    return result.newSessionId
  } catch (error) {
    log(`[轮换] 异常: ${error.message}`)
    return null
  }
}

// ── 余额闸 ─────────────────────────────────────────────────────────────────
let balanceCache = { at: 0, value: null, error: null }
async function currentBalance() {
  const b = config.balance ?? {}
  if (!b.enabled) return null
  if (Date.now() - balanceCache.at < Number(b.checkSeconds ?? 300) * 1000) return balanceCache
  balanceCache = { at: Date.now(), value: null, error: null }
  try {
    const state = JSON.parse(readFileSync(path.resolve(b.tokenFile ?? path.join(os.homedir(), '.dsh', 'balance-widget.json')), 'utf8'))
    const res = await fetch(`${b.endpoint}?token=${encodeURIComponent(state.token)}`, { signal: AbortSignal.timeout(8000) })
    const body = await res.json()
    const cny = (body.wallets ?? []).find((w) => w.currency === 'CNY')?.balance
    balanceCache.value = cny === undefined ? null : Number(cny)
  } catch (error) { balanceCache.error = error.message }
  return balanceCache
}

// ── 事件处理 ───────────────────────────────────────────────────────────────
const seenIds = new Set()
function extractText(event) {
  const m = event.message
  if (typeof m === 'string') return m
  if (!Array.isArray(m)) return event.raw_message ?? ''
  return m.map((seg) => (seg.type === 'text' ? (seg.data?.text ?? '') : seg.type === 'at' ? `@${seg.data?.qq ?? ''} ` : `[${seg.type}]`)).join('').trim()
}
function matchKeyword(text) {
  const kws = [].concat(config.trigger.keyword ?? []).filter(Boolean)
  if (String(config.trigger.mode ?? 'keyword') === 'all') return { keyword: '(all)', prompt: text }
  for (const k of kws) {
    const idx = String(text).toLowerCase().indexOf(String(k).toLowerCase())
    if (idx >= 0) return { keyword: k, prompt: String(text).slice(idx + String(k).length).replace(/^[\s,，:：]+/u, '').trim() || String(text) }
  }
  return null
}
let queue = Promise.resolve()
function enqueue(task) { queue = queue.then(task).catch((e) => log('[错误]', e.message)) }

async function handleMessage(event) {
  const text = extractText(event)
  if (!text) return
  if (event.message_type === 'group' && config.trigger.groups !== true) return
  const allow = (config.trigger.allowFrom ?? []).map(String)
  if (allow.length > 0 && !allow.includes(String(event.user_id))) return
  const hit = matchKeyword(text)
  if (!hit) {
    log(`[忽略] ${event.message_type} ${event.user_id}: ${text.slice(0, 40)}`)
    return
  }
  log(`[QQ] ${event.message_type} ${event.user_id}: ${text.slice(0, 80)}`)

  // 余额闸：低于停工线直接回一句，不调模型
  const bal = await currentBalance()
  if (bal?.value !== null && bal.value !== undefined && bal.value <= Number(config.balance.floorYuan ?? 30)) {
    log(`[余额闸] 余额 ¥${bal.value.toFixed(2)} ≤ ¥${config.balance.floorYuan}，跳过模型`)
    if (config.reply.sendBack === true) {
      try { await sendToQq(event, `余额已到停机线（¥${bal.value.toFixed(2)}），DeepSeek 暂停回答。充值后自动恢复。`) } catch (e) { log(`[余额闸] 回信失败: ${e.message}`) }
    }
    return
  }

  let sessionId = await ensureSession()
  const reason = rotationReason(sessionId)
  if (reason !== null) {
    const newId = runRotation(sessionId, reason)
    if (newId) {
      sessionId = newId
      saveBotState({ sessionId, messages: 0, since: new Date().toISOString() })
    }
  }

  // 首条消息注入交接摘要（本地生成，零额外模型轮次）
  let handoffPrefix = ''
  try {
    const pendingFile = path.resolve(config.rotation.pendingFile)
    if (existsSync(pendingFile)) {
      const pending = JSON.parse(readFileSync(pendingFile, 'utf8'))
      handoffPrefix = `${pending.summary ?? ''}\n\n`
      writeFileSync(pendingFile, JSON.stringify({ ...pending, consumedAt: new Date().toISOString() }, null, 2), 'utf8')
      rmSync(pendingFile, { force: true })
      log(`[交接] 已注入上一段会话摘要（${String(pending.summary ?? '').length} 字）`)
    }
  } catch (error) { log(`[交接] 读取失败: ${error.message}`) }

  const startedAt = Date.now()
  const prompt = `${handoffPrefix}[来自 QQ 的对话 · ${event.message_type}${event.group_id ? ` 群${event.group_id}` : ''} · 对方 QQ ${event.user_id}]\n${hit.prompt}\n\n（这是 QQ 对话，请直接给出可以回复给对方的中文回答，不要带内部思考过程。）`
  await dshSend(sessionId, prompt)
  const st = loadBotState()
  saveBotState({ sessionId, messages: Number(st.messages ?? 0) + 1, since: st.since ?? new Date().toISOString() })
  log(`[DSH] 已投递给 ${sessionId}，等待回复…`)
  const reply = await waitDshReply(sessionId, startedAt, Number(config.dsh.replyTimeoutMs) || 180000)
  if (!reply) { log('[DSH] 等回复超时'); return }
  const clipped = reply.length > config.reply.maxChars ? `${reply.slice(0, config.reply.maxChars)}…（回复超长已截断）` : reply
  log(`[DSH→QQ] ${clipped.slice(0, 80).replace(/\n/gu, ' ')}…`)
  if (dryRun || config.reply.sendBack !== true) { log('[dry-run] 不发送 QQ'); return }
  await sendToQq(event, clipped)
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.startsWith(config.callback.path)) { res.writeHead(404); res.end('not found'); return }
  let body = ''
  req.on('data', (chunk) => { body += chunk; if (body.length > 4_000_000) req.destroy() })
  req.on('end', () => {
    res.writeHead(204); res.end()
    let event
    try { event = JSON.parse(body) } catch { return }
    if (event?.post_type !== 'message') return
    const id = `${event.message_id ?? ''}:${event.time ?? ''}:${event.user_id ?? ''}`
    if (seenIds.has(id)) return
    seenIds.add(id)
    if (seenIds.size > 5000) { const first = seenIds.values().next().value; seenIds.delete(first) }
    enqueue(() => handleMessage(event))
  })
})

// ── 启动 ───────────────────────────────────────────────────────────────────
async function check() {
  const out = { config: configPath, dryRun }
  try { const info = await loginInfo(); out.onebot = { ok: true, data: info.data } } catch (e) { out.onebot = { ok: false, error: e.message } }
  try { const st = await hubCall('/sessions'); out.hub = { ok: true, roots: st.count } } catch (e) { out.hub = { ok: false, error: e.message } }
  try { const sid = await ensureSession(); out.session = { ok: true, sessionId: sid } } catch (e) { out.session = { ok: false, error: e.message } }
  log('[check]', JSON.stringify(out))
  console.log(JSON.stringify(out, null, 2))
  return out
}

log(`QQ ↔ DSH 桥启动  onebot=${config.onebot.api}  callback=${config.callback.host}:${config.callback.port}${config.callback.path}`)
log(`触发: mode=${config.trigger.mode} keyword=${(config.trigger.keyword ?? []).join('/')} groups=${config.trigger.groups} allowFrom=${(config.trigger.allowFrom ?? []).join(',') || '(不限)'}`)
log(`DSH: session=${config.dsh.session} 回复上限=${config.reply.maxChars} 发回QQ=${config.reply.sendBack}`)
const rot = config.rotation ?? {}
log(`轮换: enabled=${rot.enabled} 每 ${rot.everyMessages} 条 / ${rot.everyHours} 小时 / 压力 ${rot.pressureTokens} / 成本 ¥${rot.costYuan} → 新会话 cwd=${rot.cwd}`)
log(`余额闸: enabled=${config.balance?.enabled} 停工线 ¥${config.balance?.floorYuan}`)
if (args.check) { await check(); process.exit(0) }
server.listen(config.callback.port, config.callback.host, () => log(`回调服务: http://${config.callback.host}:${config.callback.port}${config.callback.path}`))
if (args.once) { setTimeout(() => { log('[once] 10 秒内无消息则退出'); setTimeout(() => process.exit(0), 10000) }, 100) }
