/**
 * napcat-qr-page.mjs —— 本地二维码镜像页（NapCat 登录用）
 *
 * 为什么需要：NapCat 控制台二维码每 ~2 分钟刷新一次，直接看日志/截图容易过期。
 * 本页自动轮询 `shell/cache/qrcode.png`，始终显示**当前有效**的二维码，并显示登录状态。
 *
 * 用法：
 *   node napcat-qr-page.mjs [--port 19391] [--napcat-bot <bot 目录>]
 *   浏览器打开 http://127.0.0.1:19391 ，用**小号手机 QQ** 扫码登录。
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const port = Number(arg('port', 19391))
const botDir = resolve(arg('napcat-bot', join(HERE, 'napcat', 'bot')))
const qrPath = join(botDir, 'shell', 'cache', 'qrcode.png')
const logPath = join(botDir, 'napcat-out.log')
const webuiJson = join(botDir, 'shell', 'config', 'webui.json')

function webuiToken() {
  try { return JSON.parse(readFileSync(webuiJson, 'utf8')).token ?? '' } catch { return '' }
}
function statusText() {
  try {
    const lines = readFileSync(logPath, 'utf8').split(/\r?\n/u).filter(Boolean).slice(-200)
    const reversed = lines.reverse()
    const hit = (re) => reversed.find((l) => re.test(l)) ?? ''
    if (hit(/登录成功|Login Success/u)) return { state: 'ok', text: '✅ 登录成功' }
    if (hit(/Login Error/u)) return { state: 'wait', text: `等待扫码（上次错误：${hit(/Login Error/u).trim()}）` }
    if (hit(/二维码已保存/u)) return { state: 'wait', text: '等待扫码（二维码会自动刷新）' }
    return { state: 'wait', text: '等待 NapCat 启动…' }
  } catch { return { state: 'error', text: '读不到 NapCat 日志' } }
}

const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>NapCat 小号登录</title>
<style>
 body{margin:0;background:#0f1115;color:#e8eaed;font:14px/1.5 "Microsoft YaHei",system-ui;display:flex;flex-direction:column;align-items:center;padding:28px}
 h1{font-size:18px;margin:0 0 6px}
 .tip{color:#9aa0a6;margin-bottom:18px;text-align:center;max-width:640px}
 .card{background:#171b22;border:1px solid #2a323d;border-radius:14px;padding:18px;text-align:center}
 img{width:300px;height:300px;image-rendering:pixelated;background:#fff;border-radius:8px}
 #st{margin-top:10px;color:#8ab4f8}
 .steps{color:#9aa0a6;margin-top:18px;text-align:left;max-width:640px;font-size:13px}
 code{background:#222831;padding:1px 5px;border-radius:4px}
</style></head><body>
<h1>NapCat · 小号扫码登录</h1>
<div class="tip">用 <b>小号手机 QQ</b> 扫下面这张码（手机扫码后点「确认登录」）。二维码每 ~2 分钟自动刷新，本页会跟着更新。</div>
<div class="card"><img id="qr" src="/qr.png?t=0" alt="QR"><div id="st">加载中…</div></div>
<div class="steps">
 1) 手机上先切到 <b>小号</b>（QQ → 左上角头像 → 切换账号）。<br>
 2) 扫上面的二维码 → 手机弹「确认登录」→ 点确认。<br>
 3) 本页状态变成 <code>✅ 登录成功</code> 即完成；若二维码模糊/过期，等它自动刷新。<br>
 4) 如果小号此刻正登录在电脑版 QQ 客户端里，请先在那边退出，否则会互相踢下线。
</div>
<script>
async function tick(){
  try{
    const r=await fetch('/status',{cache:'no-store'});const s=await r.json();
    document.getElementById('st').textContent=s.text;
    document.getElementById('qr').src='/qr.png?t='+Date.now();
    if(s.state==='ok'){document.getElementById('st').style.color='#34d399'}
  }catch(e){document.getElementById('st').textContent='等待服务…'}
}
tick();setInterval(tick,1500);
</script></body></html>`

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(HTML)
    return
  }
  if (url.pathname === '/status') {
    const body = JSON.stringify(statusText())
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
    return
  }
  if (url.pathname === '/qr.png') {
    if (!existsSync(qrPath)) { res.writeHead(404); res.end('no qr yet'); return }
    const buf = readFileSync(qrPath)
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': buf.length })
    res.end(buf)
    return
  }
  if (url.pathname === '/webui') {
    const token = webuiToken()
    res.writeHead(302, { location: `http://127.0.0.1:6099/webui?token=${token}` })
    res.end()
    return
  }
  res.writeHead(404); res.end('not found')
})
server.listen(port, '127.0.0.1', () => {
  console.log(`NapCat 登录页: http://127.0.0.1:${port}/`)
  console.log(`二维码文件: ${qrPath}`)
  try { console.log(`二维码 mtime: ${statSync(qrPath).mtime.toLocaleString('zh-CN')}`) } catch { console.log('二维码尚未生成') }
})
