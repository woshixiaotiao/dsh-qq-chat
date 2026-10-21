#!/usr/bin/env node
/**
 * qq-activate.mjs —— 本地运行的「QQ 关键词激活」脚本
 *
 * 作用：盯着当前打开的 QQ 对话窗口（UI Automation 只读），当**对方**发来的新消息里
 * 含关键词（默认「小D」）时，把消息投给指定的 DSH 会话（或每次新建一个会话），
 * 等 DeepSeek 回复后，把「提问 + 回复」落到本地回复目录和激活日志（关键文档更新）。
 *
 * 不注入 QQ、不碰加密库、不点击输入框、**不代发 QQ 消息**。
 *
 * 用法：
 *   node qq-activate.mjs --dry-run --once            # 安全自测：只检测并打印，不投递
 *   node qq-activate.mjs --session <sessionId>       # 把激活消息投给已有 DSH 会话
 *   node qq-activate.mjs --session new --cwd D:\AI\DSH  # 每次激活新建一个 DSH 会话
 *   node qq-activate.mjs --fixture test.json --dry-run --once   # 用固定消息测试检测逻辑
 *
 * 常用参数：
 *   --keyword 小D          关键词（可多次给，或逗号分隔）
 *   --window 小李子        按窗口标题模糊匹配（默认取第一个聊天窗口）
 *   --hwnd  1234567        指定窗口句柄
 *   --poll 2500            轮询间隔 ms
 *   --reply-timeout 120000 等回复的最长时间 ms
 *   --once                 只跑一轮（测试用）
 *   --dry-run              不投递 DSH，只打印
 *   --doc/--log            关键文档/日志输出路径（默认 tools/qq/out/ 下）
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url)) // D:\AI\DSH\tools\qq
const NODE = process.execPath
const READER = path.join(HERE, 'qq-chat-read.ps1')
const OUT_DIR = path.join(HERE, 'out')
const STATE_FILE = path.join(OUT_DIR, 'activate-state.json')
const LOG_FILE = path.join(OUT_DIR, 'activate-log.md')
const REPLY_DIR = path.join(OUT_DIR, 'activate-replies')

// ── 参数 ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { keyword: [], poll: 2500, replyTimeout: 120000 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    const hasValue = next !== undefined && !next.startsWith('--')
    switch (key) {
      case 'keyword': if (hasValue) { opts.keyword.push(next); i += 1 }; break
      case 'session': if (hasValue) { opts.session = next; i += 1 }; break
      case 'window': if (hasValue) { opts.window = next; i += 1 }; break
      case 'hwnd': if (hasValue) { opts.hwnd = Number(next); i += 1 }; break
      case 'poll': if (hasValue) { opts.poll = Math.max(800, Number(next)); i += 1 }; break
      case 'reply-timeout': if (hasValue) { opts.replyTimeout = Math.max(5000, Number(next)); i += 1 }; break
      case 'cwd': if (hasValue) { opts.cwd = next; i += 1 }; break
      case 'doc': if (hasValue) { opts.doc = next; i += 1 }; break
      case 'log': if (hasValue) { opts.log = next; i += 1 }; break
      case 'fixture': if (hasValue) { opts.fixture = next; i += 1 }; break
      case 'clipboard': opts.clipboard = true; break
      case 'once': opts.once = true; break
      case 'dry-run': opts.dryRun = true; break
      case 'help': opts.help = true; break
      default: break
    }
  }
  if (typeof opts.session === 'string') opts.session = opts.session.trim()
  return opts
}
const opts = parseArgs(process.argv.slice(2))
if (opts.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 40).join('\n'))
  process.exit(0)
}
if (opts.keyword.length === 0) opts.keyword = ['小D']
const keywords = opts.keyword.flatMap((k) => String(k).split(/[,，]/u)).map((k) => k.trim()).filter(Boolean)
if (keywords.length === 0) { console.error('关键词不能为空'); process.exit(2) }
mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(REPLY_DIR, { recursive: true })
const logPath = opts.log ? path.resolve(opts.log) : LOG_FILE
const docPath = opts.doc ? path.resolve(opts.doc) : LOG_FILE

// ── hub（DSH 会话投递接口） ────────────────────────────────────────────────
const hubStatePath = path.join(os.homedir(), '.dsh', 'session-hub.json')
function loadHub() {
  const state = JSON.parse(readFileSync(hubStatePath, 'utf8'))
  return { endpoint: state.endpoint.replace(/\/$/u, ''), token: state.token }
}
let hub = null
try { hub = loadHub() } catch (error) { console.warn(`读取 hub 配置失败（投递不可用）: ${error.message}`) }
async function hubCall(rest, init) {
  if (!hub) throw new Error('hub 未配置')
  const url = `${hub.endpoint}${rest}${rest.includes('?') ? '&' : '?'}token=${encodeURIComponent(hub.token)}`
  const res = await fetch(url, init)
  const body = await res.json()
  if (!res.ok || body.ok === false) throw new Error(`hub HTTP ${res.status}: ${body.error ?? JSON.stringify(body)}`)
  return body
}
async function createSession() {
  const body = await hubCall(`/sessions?cwd=${encodeURIComponent(opts.cwd ?? 'D:\\AI\\DSH')}`, { method: 'POST' })
  return body.sessionId
}
async function sendToSession(sessionId, text) {
  await hubCall(`/sessions/${encodeURIComponent(sessionId)}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, mode: 'queue' }),
  })
}
async function readTail(sessionId, n = 30) {
  return hubCall(`/sessions/${encodeURIComponent(sessionId)}/tail?n=${n}`)
}

// ── 读 QQ 窗口消息（UI Automation，只读） ─────────────────────────────────
const fixture = opts.fixture ? JSON.parse(readFileSync(path.resolve(opts.fixture), 'utf8')) : null
function readMessagesFromQQ() {
  if (fixture) return { window: fixture.window ?? 'fixture', hwnd: fixture.hwnd ?? 0, messages: fixture.messages ?? [] }
  if (!existsSync(READER)) throw new Error(`找不到读取脚本: ${READER}`)
  const stamp = Date.now()
  const outMd = path.join(OUT_DIR, `activate-read-${stamp}.md`)
  const jsonPath = outMd.replace(/\.md$/u, '.json')
  const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', READER, '-Json', '1', '-Out', outMd]
  if (opts.hwnd) argv.push('-Hwnd', String(opts.hwnd))
  else if (opts.window) argv.push('-Window', opts.window)
  const res = spawnSync('powershell.exe', argv, { encoding: 'utf8', timeout: 30000, windowsHide: true })
  const text = `${res.stdout ?? ''}${res.stderr ?? ''}`
  if (!existsSync(jsonPath)) {
    const firstLine = text.split(/\r?\n/u).map((l) => l.trim()).filter(Boolean)[0] ?? '(无输出)'
    return { error: firstLine }
  }
  try {
    const data = JSON.parse(readFileSync(jsonPath, 'utf8'))
    return { window: data.window, hwnd: data.hwnd, messages: data.messages ?? [] }
  } catch (error) {
    return { error: `解析读取结果失败: ${error.message}` }
  }
}

// ── 状态（去重） ───────────────────────────────────────────────────────────
function loadState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return { seen: Array.isArray(raw.seen) ? raw.seen.slice(-3000) : [] }
  } catch { return { seen: [] } }
}
const state = loadState()
const seen = new Set(state.seen)
function saveState() {
  try { writeFileSync(STATE_FILE, JSON.stringify({ seen: [...seen].slice(-3000), updatedAt: new Date().toISOString() }, null, 2), 'utf8') } catch { /* ignore */ }
}
const msgKey = (m) => `${m.Time ?? ''}|${m.Sender ?? ''}|${m.Text ?? ''}`

// ── 回复落盘（关键文档更新） ───────────────────────────────────────────────
function appendLog(line) {
  try {
    if (!existsSync(logPath)) writeFileSync(logPath, '# QQ 关键词激活日志\n\n| 时间 | 窗口 | 发送者 | 关键词消息 | DSH 会话 | 回复字符 | 回复文件 |\n|---|---|---|---|---|---|---|\n', 'utf8')
    appendFileSync(logPath, line + '\n', 'utf8')
  } catch (error) { console.warn(`写日志失败: ${error.message}`) }
}
function saveReply(record) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
  const safeSender = String(record.sender).replace(/[\\/:*?"<>|\s]/gu, '_').slice(0, 24) || 'peer'
  const file = path.join(REPLY_DIR, `${stamp}-${safeSender}.md`)
  const body = [
    `# QQ 激活回复 · ${record.window}`,
    '',
    `- 时间：${record.at}`,
    `- 发送者：${record.sender}`,
    `- 触发词：${record.keyword}`,
    `- DSH 会话：${record.sessionId ?? '(dry-run 未投递)'}`,
    '',
    '## QQ 原消息',
    '',
    record.text,
    '',
    '## DeepSeek 回复',
    '',
    record.reply ?? '(未取得)',
    '',
  ].join('\n')
  writeFileSync(file, body, 'utf8')
  return file
}

// ── 等回复 ─────────────────────────────────────────────────────────────────
async function waitForReply(sessionId, startedAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const tail = await readTail(sessionId, 30)
      const replies = (tail.messages ?? []).filter((m) => m.role === 'assistant' && (m.time ?? 0) >= startedAt - 2000)
      if (replies.length > 0) {
        const candidate = replies[replies.length - 1]
        if (candidate.text && candidate.text !== last) { last = candidate.text; return candidate.text }
      }
    } catch { /* hub 暂时不可达，继续等 */ }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return last
}

// ── 主循环 ─────────────────────────────────────────────────────────────────
let lastWindow = null
let lastError = null
function pickKeyword(text) {
  for (const k of keywords) {
    const idx = text.toLowerCase().indexOf(k.toLowerCase())
    if (idx >= 0) {
      const prompt = text.slice(idx + k.length).replace(/^[\s,，:：]+/u, '').trim() || text.trim()
      return { keyword: k, prompt }
    }
  }
  return null
}
async function cycle() {
  const read = readMessagesFromQQ()
  if (read.error) {
    if (read.error !== lastError) { console.log(`[等待] ${read.error}（QQ 聊天窗口需要保持打开/可见）`); lastError = read.error }
    return
  }
  lastError = null
  if (read.window !== lastWindow) { console.log(`监听窗口: ${read.window} (hwnd=${read.hwnd})`); lastWindow = read.window }
  const messages = read.messages
  let activated = 0
  for (const m of messages) {
    if (m.Self === true) continue
    const text = String(m.Text ?? '')
    if (!text) continue
    const key = msgKey(m)
    if (seen.has(key)) continue
    seen.add(key)
    const hit = pickKeyword(text)
    if (!hit) { continue }
    activated += 1
    const record = { at: new Date().toISOString(), window: read.window, sender: m.Sender ?? '对方', keyword: hit.keyword, text, prompt: hit.prompt, sessionId: null, reply: null }
    console.log(`\n[激活] ${read.window} / ${record.sender}：${text.slice(0, 100)}`)
    if (opts.dryRun) { console.log('[dry-run] 检测到激活；不投递 DSH、不落盘（验证检测逻辑用）'); continue }
    if (!hub) { console.log('[跳过] hub 配置不可用'); continue }
    let sessionId = opts.session
    try {
      if (!sessionId || sessionId === 'new') sessionId = await createSession()
      record.sessionId = sessionId
      const startedAt = Date.now()
      const text2 = `[QQ 激活 · ${read.window}]\n${record.sender}: ${hit.prompt}\n\n（这是由 QQ 消息触发的任务，请直接给出可以回给对方的回复。）`
      await sendToSession(sessionId, text2)
      console.log(`[投递] 已发给 DSH 会话 ${sessionId}，等待回复…`)
      const reply = await waitForReply(sessionId, startedAt, opts.replyTimeout)
      record.reply = reply
      const file = saveReply(record)
      appendLog(`| ${record.at.replace('T', ' ').slice(0, 19)} | ${read.window} | ${record.sender} | ${text.replace(/\|/gu, '\\|').slice(0, 60)} | ${sessionId} | ${reply ? reply.length : 0} | ${path.basename(file)} |`)
      if (reply && opts.clipboard) {
        try {
          spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Set-Clipboard -Value $input'], { input: reply, encoding: 'utf8', windowsHide: true })
        } catch { /* 剪贴板失败不影响落盘 */ }
      }
      console.log(reply ? `[回复] ${reply.slice(0, 120)}…\n[落盘] ${file}${opts.clipboard ? '（已复制到剪贴板，可直接粘进 QQ）' : ''}` : '[超时] 没有在限定时间内拿到回复')
    } catch (error) {
      console.log(`[失败] ${error.message}`)
    }
  }
  if (!opts.dryRun) saveState()
  if (activated === 0 && process.env.QQ_ACTIVATE_VERBOSE === '1') console.log(`[轮询] ${messages.length} 条消息，无新激活（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）`)
}

console.log(`QQ 关键词激活脚本`)
console.log(`  关键词: ${keywords.join(' / ')}`)
console.log(`  目标会话: ${opts.dryRun ? '(dry-run 不投递)' : (opts.session ?? '(未指定，激活时新建)')}`)
console.log(`  hub: ${hub ? hub.endpoint : '未配置'}`)
console.log(`  窗口: ${opts.fixture ? `fixture ${opts.fixture}` : opts.window ? `标题含「${opts.window}」` : opts.hwnd ? `hwnd=${opts.hwnd}` : '自动取一个聊天窗口'}`)
console.log(`  日志: ${logPath}`)
console.log(`  提示: 需要把 QQ 聊天窗口保持打开（脚本只读窗口；不改 QQ、不代发消息）\n`)

if (opts.once) {
  await cycle()
  process.exit(0)
}
for (;;) {
  try { await cycle() } catch (error) {
    if (String(error.message) !== lastError) { console.log(`[错误] ${error.message}`); lastError = String(error.message) }
  }
  await new Promise((r) => setTimeout(r, opts.poll))
}
