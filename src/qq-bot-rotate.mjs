/**
 * qq-bot-rotate.mjs —— QQ 机器人会话轮换 + 交付到日常（零 token，本地生成交接件）
 *
 * 做的事（默认 dry-run，只读不写）：
 *   1) 找到机器人当前绑定的 DSH 会话（tools/qq/out/bot-session.json，可用 --session 覆盖）；
 *   2) 从 projcache 读轮次/步数/token 用量/上下文压力/最近轮次摘要；
 *   3) 生成「交接件」Markdown（写 D:\AI\日常\QQ机器人\交接\<时间>-<标题>.md），并更新索引；
 *   4) --apply 时：建新会话（cwd 默认 D:\AI\日常）→ 改名新会话 → 旧会话改名【已轮换】→
 *      更新 bot-session.json（桥下条消息自动用新会话）→ 写 bot-pending-handoff.json（桥在首条消息注入摘要）；
 *   5) 不发任何模型请求（零 token）；新会话的上下文在机器人下一条 QQ 消息里注入。
 *
 * 用法：
 *   node qq-bot-rotate.mjs                       # dry-run：看计划 + 交接件预览
 *   node qq-bot-rotate.mjs --apply               # 真轮换（交付到日常）
 *   node qq-bot-rotate.mjs --session <id前缀> --apply
 *   node qq-bot-rotate.mjs --cwd D:\AI\日常 --out-dir D:\AI\日常\QQ机器人\交接 --apply
 *   node qq-bot-rotate.mjs --reason messages --json   # 供桥自动调用（输出 JSON 结果）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = process.env.USERPROFILE
const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const flag = (n) => argv.includes(`--${n}`)
const CLAIM_APPLY = arg('apply', '') === '' ? flag('apply') : true
const APPLY = CLAIM_APPLY
const JSON_OUT = flag('json')
const REASON = String(arg('reason', 'manual'))
const SESSION_ARG = String(arg('session', '') || '')
const OUT_DIR = resolve(String(arg('out-dir', 'D:\\AI\\日常\\QQ机器人\\交接')))
const CWD = String(arg('cwd', 'D:\\AI\\日常'))
const INDEX_FILE = resolve(String(arg('index', join(dirname(OUT_DIR), 'README.md'))))
const BOT_SESSION_FILE = resolve(arg('session-file', join(HERE, 'out', 'bot-session.json')))
const PENDING_FILE = resolve(arg('pending-file', join(HERE, 'out', 'bot-pending-handoff.json')))
const FORCE = flag('force')

const hub = JSON.parse(readFileSync(join(HOME, '.dsh', 'session-hub.json'), 'utf8'))
const API = String(hub.endpoint).replace(/\/+$/u, '')
const HEADERS = { 'x-hub-token': hub.token, 'content-type': 'application/json' }
async function api(pathname, init) {
  const res = await fetch(API + pathname, { ...(init ?? {}), headers: { ...HEADERS, ...(init?.headers ?? {}) } })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

// ── 当前会话 ────────────────────────────────────────────────────────────────
function readBotSessionId() {
  try { return JSON.parse(readFileSync(BOT_SESSION_FILE, 'utf8')).sessionId ?? null } catch { return null }
}
let sessionId = SESSION_ARG || readBotSessionId()
if (!sessionId) { console.error('没有机器人会话（--session 或 tools/qq/out/bot-session.json）'); process.exit(2) }

const list = await api('/sessions?scope=all')
const sessions = (list.groups ?? []).flatMap((g) => g.sessions ?? [])
let target = sessions.find((s) => s.id === sessionId)
  ?? sessions.find((s) => s.id.startsWith(sessionId))
  ?? sessions.find((s) => s.id.includes(sessionId))
if (!target) { console.error(`找不到会话: ${sessionId}`); process.exit(3) }
if (target.running && !FORCE) { console.error(`拒绝轮换正在运行的会话 ${target.id}（--force 可强制，但不建议）`); process.exit(4) }

// ── projcache 指标 ─────────────────────────────────────────────────────────
const PROJ_DIR = join(HOME, '.dsh', 'storages', 'session_projcache', 'sessions')
function readMetrics(id) {
  const file = join(PROJ_DIR, id + '.json')
  if (!existsSync(file)) return null
  const j = JSON.parse(readFileSync(file, 'utf8'))
  const rows = (j.record ?? j).rows ?? {}
  const val = (k) => (rows[k] ? (rows[k].val !== undefined ? rows[k].val : rows[k]) : null)
  const usage = (val('tokenUsage') ?? {}).totals ?? {}
  const stats = val('sessionStats') ?? {}
  const pressure = val('contextPressure') ?? {}
  const breakdown = val('contextBreakdown') ?? {}
  const outline = val('turnOutline') ?? {}
  const model = (val('modelSelection') ?? {}).lastUsed ?? {}
  const goal = (val('goal') ?? {}).current ?? null
  const todos = val('todos')
  const preset = val('agentPreset') ?? null
  const identity = (j.record ?? j).identity ?? {}
  const miss = Number(usage.uncachedInputTokens ?? 0)
  const cache = Number(usage.cacheReadTokens ?? 0)
  const out = Number(usage.outputTokens ?? 0)
  const cost = (miss * 0.15 + cache * 0.003 + out * 0.6) / 1e6 * 7.2 // flash 非高峰口径 ≈¥，仅用于轮换阈值
  return {
    turns: Number(stats.turns ?? 0),
    steps: Number(stats.steps ?? 0),
    miss, cache, out, cost,
    pressureTokens: Number(pressure.pressureTokens ?? 0),
    contextWindow: Number(pressure.contextWindow ?? 0),
    surfaceTokens: Number(pressure.surfaceTokens ?? 0),
    systemTokens: Number(breakdown.breakdown?.systemTokens ?? 0),
    toolsTokens: Number(breakdown.breakdown?.toolsTokens ?? 0),
    messageTokens: Number(breakdown.breakdown?.messageTokens ?? 0),
    createdAt: Number(identity.createdAt ?? 0),
    title: target.title ?? '(无标题)',
    cwd: target.cwd ?? '',
    preset,
    model: `${model.provider ?? '?'}/${model.model ?? '?'}${model.reasoningEffort ? '/' + model.reasoningEffort : ''}`,
    goal,
    todos,
    tail: Array.isArray(outline.turns) ? outline.turns.slice(-10) : [],
    outlineAll: Array.isArray(outline.turns) ? outline.turns : [],
  }
}
const m = readMetrics(target.id)
if (!m) { console.error(`缺少 projcache: ${join(PROJ_DIR, target.id + '.json')}（会话可能还没跑过一轮）`); process.exit(5) }
const nowShift = new Date(Date.now() + 8 * 3600e3)
const stamp = nowShift.toISOString().replace(/[-:T.]/gu, '').slice(0, 12)
const stampHuman = nowShift.toISOString().replace('T', ' ').slice(0, 16)
const safeTitle = String(m.title).replace(/[\\/:*?"<>|\s]+/gu, '_').slice(0, 24) || 'QQ对话'
const id8 = target.id.replace(/^session-/u, '').slice(0, 8)

// ── 交接件 Markdown ────────────────────────────────────────────────────────
const handoffPath = join(OUT_DIR, `${stamp}-${safeTitle}-${id8}.md`)
const summaryLine = m.tail.slice(-3).map((t) => `用户：${String(t.prompt ?? '').replace(/\s+/gu, ' ').slice(0, 80)} → 助手：${String(t.response ?? '').replace(/\s+/gu, ' ').slice(0, 100)}`).join(' / ')
const md = []
md.push(`# QQ 机器人交接件 · ${m.title}`)
md.push('')
md.push(`> 生成：${stampHuman}　｜　来源会话：\`${target.id}\`　｜　触发：${REASON}　｜　工作区：\`${m.cwd}\``)
md.push(`> 轮次/步骤：${m.turns}/${m.steps}　｜　累计 token：缓存读 ${m.cache.toLocaleString()} / 未命中 ${m.miss.toLocaleString()} / 输出 ${m.out.toLocaleString()}　｜　≈¥${m.cost.toFixed(3)}（flash 非高峰口径）`)
md.push(`> 上下文压力：${m.pressureTokens.toLocaleString()} tokens（窗口 ${m.contextWindow.toLocaleString()}，消息体 ${m.messageTokens.toLocaleString()}）`)
md.push(`> 本文件由脚本零 token 生成，**不发模型请求**。`)
md.push('')
md.push('## 0. 交接给谁')
md.push('')
md.push(`这是 QQ 机器人（小号 <BOT_QQ>）对话会话的接续交接件。旧会话已退休（\`${target.id}\` 不再接收任务）。`)
md.push('新会话身份：**QQ 私聊机器人**——经 QQ 私聊收到用户消息、由本地桥转发，回复会自动发回 QQ。')
md.push('要求：中文、口语、简洁（QQ 里一次回复 ≤1200 字），先给结论；不要长篇、不要输出内部过程。')
md.push('')
md.push('## 1. 最近对话（最近 ' + m.tail.length + ' 轮摘要）')
md.push('')
for (const t of m.tail) {
  md.push(`### 轮次 ${t.turn}`)
  md.push(`- 用户：${String(t.prompt ?? '').replace(/\s+/gu, ' ').slice(0, 240)}`)
  md.push(`- 助手：${String(t.response ?? '').replace(/\s+/gu, ' ').slice(0, 400)}`)
  md.push('')
}
md.push('## 2. 交接上下文')
md.push('')
md.push(`- 模型：\`${m.model}\`　｜　agentPreset：\`${m.preset ?? '(默认)'}\``)
if (m.goal) md.push(`- 旧会话目标：${String(m.goal).slice(0, 300)}`)
if (Array.isArray(m.todos) && m.todos.length > 0) {
  for (const t of m.todos.slice(0, 12)) md.push(`- todo：${t.status ? `[${t.status}] ` : ''}${String(t.content ?? t.text ?? t).slice(0, 200)}`)
} else md.push('- 旧会话没有未完成 todo。')
md.push('')
md.push('## 3. 机器人口径与红线')
md.push('')
md.push('- 只处理**用户 QQ 私聊**（主号 <MAIN_QQ> ↔ 小号 <BOT_QQ>）；不群发、不加陌生人、不主动消息。')
md.push('- 回复走本地 OneBot 桥（tools/qq/qq-bot-bridge.mjs），端口只绑 127.0.0.1；QQ 内容不上传外部。')
md.push('- 余额 ≤ ¥30 停机（桥内置余额闸）；每次用户消息只调一次模型。')
md.push('- 不主动唤醒其它会话、不开循环任务（日常工作区成本纪律）。')
md.push('')
const mdText = md.join('\n')

function previewSummary(maxLen = 1100) {
  const line = `【上下文交接】上一段 QQ 机器人会话已轮换（${m.turns} 轮，约 ¥${m.cost.toFixed(2)}）。交接件：${handoffPath}\n最近对话摘要：${summaryLine}`
  return line.length > maxLen ? line.slice(0, maxLen) + '…' : line
}

// ── dry-run 输出 ───────────────────────────────────────────────────────────
if (!APPLY) {
  console.log(`[轮换计划] DRY-RUN（触发=${REASON}）`)
  console.log(`  源会话：${target.id}  「${m.title}」  工作区=${m.cwd}`)
  console.log(`  轮次/步骤=${m.turns}/${m.steps}  上下文压力=${m.pressureTokens.toLocaleString()}  累计≈¥${m.cost.toFixed(3)}`)
  console.log(`  交接件：${handoffPath}（${(Buffer.byteLength(mdText, 'utf8') / 1024).toFixed(1)} KB）`)
  console.log(`  新会话：cwd=${CWD}（创建后改名）↔ 旧会话改名【已轮换 ${stamp}】`)
  console.log(`  首条消息注入摘要（约 ${previewSummary().length} 字）：${previewSummary(300)}`)
  console.log('\n[交接件预览]\n' + mdText.slice(0, 1200))
  console.log('\n（未执行。--apply 才会：写交接件 → 建/改名会话 → 更新 bot-session.json → 写 pending-handoff）')
  process.exit(0)
}

// ── APPLY ─────────────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(handoffPath, mdText + '\n', 'utf8')
const kb = (Buffer.byteLength(mdText, 'utf8') / 1024).toFixed(1)
console.log(`[轮换] 交接件已写：${handoffPath}（${kb} KB，零 token）`)

const created = await api(`/sessions?cwd=${encodeURIComponent(CWD)}${m.preset ? `&preset=${encodeURIComponent(m.preset)}` : ''}`, { method: 'POST' })
const newId = created.sessionId
if (!newId) throw new Error('建新会话失败（没有 sessionId）')
console.log(`[轮换] 新会话：${newId}（workspace=${created.workspaceTitle ?? ''} cwd=${created.cwd ?? ''}）`)

const newTitle = `QQ 对话 · 日常 · ${stamp.slice(4, 8)}-${stamp.slice(8, 12)}`
try { await api(`/sessions/${encodeURIComponent(newId)}/rename?title=${encodeURIComponent(newTitle)}`, { method: 'POST' }) } catch (e) { console.log(`  ⚠️ 新会话改名失败（忽略）: ${e.message}`) }
const oldTitle = `【已轮换 ${stamp}】${m.title}`
try { await api(`/sessions/${encodeURIComponent(target.id)}/rename?title=${encodeURIComponent(oldTitle)}`, { method: 'POST' }) } catch (e) { console.log(`  ⚠️ 旧会话改名失败（忽略）: ${e.message}`) }

writeFileSync(BOT_SESSION_FILE, JSON.stringify({
  sessionId: newId,
  previousSessionId: target.id,
  handoffPath,
  rotatedAt: new Date().toISOString(),
  reason: REASON,
}, null, 2), 'utf8')
writeFileSync(PENDING_FILE, JSON.stringify({
  from: target.id, to: newId, handoffPath, at: new Date().toISOString(),
  summary: previewSummary(),
}, null, 2), 'utf8')

// 索引：供日常 workspace 快速回看
try {
  if (!existsSync(INDEX_FILE)) {
    writeFileSync(INDEX_FILE, '# QQ 机器人 · 会话交接索引\n\n> 每次轮换生成一份交接件；桥会自动把摘要注入下一段会话的首条消息。\n\n| 时间 | 旧会话 | 轮次 | 约￥ | 交接件 |\n|---|---|---|---|---|\n', 'utf8')
  }
  appendFileSync(INDEX_FILE, `| ${stampHuman} | ${target.id} | ${m.turns} | ${m.cost.toFixed(2)} | ${handoffPath} |\n`, 'utf8')
} catch (e) { console.log(`  ⚠️ 索引写入失败（忽略）: ${e.message}`) }

const result = { ok: true, applied: true, oldSessionId: target.id, newSessionId: newId, handoffPath, index: INDEX_FILE, turns: m.turns, cost: m.cost, reason: REASON }
console.log(JSON.stringify(result))
console.log(`[轮换完成] 旧会话已退休 → 新会话 ${newId}；桥下一条 QQ 消息自动改投新会话并注入摘要。`)
