/**
 * napcat-onebot-setup.mjs —— 给已登录的 NapCat 写 OneBot 网络配置
 *
 * 做的事：
 *   1) 在 NapCat 安装目录里递归找 `config/onebot11_<QQ号>.json`（需要先用小号登录过一次）；
 *   2) 写入两项网络配置（保留其它字段）：
 *      - HTTP 服务端 httpServers：127.0.0.1:3000，token = bot-bridge.config.json 的 onebot.token（桥调用发消息）
 *      - HTTP 客户端 httpClients：http://127.0.0.1:19390/onebot，同一 token（QQ 事件推给桥）
 *   3) 打印「重启 NapCat 生效」提示。
 *
 * 用法：
 *   node napcat-onebot-setup.mjs [--napcat-root <目录>] [--bridge-config <路径>] [--config <onebot11_xx.json>]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const bridgeConfigPath = resolve(arg('bridge-config', join(HERE, 'bot-bridge.config.json')))
if (!existsSync(bridgeConfigPath)) { console.error(`找不到桥接配置: ${bridgeConfigPath}`); process.exit(2) }
const bridgeConfig = JSON.parse(readFileSync(bridgeConfigPath, 'utf8'))
const token = String(bridgeConfig.onebot?.token ?? '')
const apiPort = Number(String(bridgeConfig.onebot?.api ?? 'http://127.0.0.1:3000').split(':').pop()) || 3000
const callbackUrl = `http://${bridgeConfig.callback?.host ?? '127.0.0.1'}:${bridgeConfig.callback?.port ?? 19390}${bridgeConfig.callback?.path ?? '/onebot'}`

/** 递归找 config/onebot11_*.json（跳过 node_modules/. 目录，最多 6 层） */
function findOnebotConfigs(base) {
  const out = []
  function walk(dir, depth) {
    if (depth > 6 || !existsSync(dir)) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
      const full = join(dir, ent.name)
      if (ent.name === 'config') {
        try {
          for (const f of readdirSync(full)) if (/^onebot11_.*\.json$/u.test(f)) out.push(join(full, f))
        } catch { /* ignore */ }
        continue
      }
      walk(full, depth + 1)
    }
  }
  walk(base, 0)
  return out
}

const explicit = arg('config', '')
const base = resolve(arg('napcat-root', join(HERE, 'napcat')))
const configs = explicit ? [resolve(explicit)] : findOnebotConfigs(base)
if (configs.length === 0) {
  console.error(`没有在 ${base} 下找到 config/onebot11_<QQ>.json。先启动 NapCat 并让小号扫码登录一次，再跑本脚本。`)
  process.exit(2)
}
let done = 0
for (const configFile of configs) {
  if (!existsSync(configFile)) { console.log(`[跳过] 不存在: ${configFile}`); continue }
  let current = {}
  try { current = JSON.parse(readFileSync(configFile, 'utf8')) } catch { current = {} }
  const network = current.network ?? {}
  const servers = Array.isArray(network.httpServers) ? network.httpServers : []
  const clients = Array.isArray(network.httpClients) ? network.httpClients : []
  const server = {
    name: 'dsh-api',
    enable: true,
    host: '127.0.0.1',
    port: apiPort,
    enableCors: true,
    enableWebsocket: false,
    messagePostFormat: 'array',
    token,
    debug: false,
  }
  const client = {
    name: 'dsh-callback',
    enable: true,
    url: callbackUrl,
    messagePostFormat: 'array',
    reportSelfMessage: false,
    token,
    debug: false,
  }
  const next = {
    ...current,
    network: {
      ...network,
      httpServers: [server, ...servers.filter((s) => s?.name !== 'dsh-api')],
      httpClients: [client, ...clients.filter((c) => c?.name !== 'dsh-callback')],
    },
  }
  writeFileSync(configFile, JSON.stringify(next, null, 2), 'utf8')
  done += 1
  console.log(`[OK] 已写入 ${configFile}`)
  console.log(`     HTTP 服务端: 127.0.0.1:${apiPort}（token 已设置）`)
  console.log(`     HTTP 客户端: ${callbackUrl}（token 已设置）`)
}
if (done > 0) console.log('\n重启 NapCat（关掉 bot 实例再运行 run-napcat.cmd）后配置生效。')
else { console.error('没有写入任何配置'); process.exit(1) }
