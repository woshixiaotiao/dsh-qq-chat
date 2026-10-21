# qq-chat-read.ps1 —— 读取指定 QQ（NT 版）对话
#
# 原理：QQ NT 是 Electron/Chromium 应用，**不改它、不重启它**，
#      用 Windows UI Automation 读它的可访问性树（Chromium 在你查询时会自动建树）。
#      ——不碰加密的 nt_msg.db（9.2 GB，QQ 自己加密），也不从进程内存抠密钥。
#
# 只读：只枚举控件与文本，**不点击、不输入、不发送、不删除**。
#       唯一的"写"发生在 -Scroll > 0 时滚动消息列表（结束时滚回底部）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File qq-chat-read.ps1
#   powershell ... -File qq-chat-read.ps1 -Window '小李子' -Scroll 3
#   powershell ... -File qq-chat-read.ps1 -List          # 只列当前有哪些 QQ 窗口
#
# 输出：默认写 D:\AI\DSH\tools\qq\out\<标题>-<时间>.md（并打印到控制台）
param(
  [string]$Window = '',      # 窗口标题模糊匹配；留空 = 自动挑一个聊天窗口
  [int]$Hwnd = 0,            # 直接用窗口句柄指定（推荐：避开中文命令行参数的编码坑）
  [int]$Scroll = 0,          # 向上滚动的次数（每次一屏），用于加载更多历史
  [string]$Out = '',         # 输出文件；留空 = 自动命名
  # 这两个刻意**不用 [switch]**：PowerShell 5.1 用 `-File` 传裸 switch 会报
  # "Cannot convert String to SwitchParameter"。字符串参数最稳：-List 1 / -Json 1
  [string]$List = '',        # 非空 = 只列出 QQ 窗口
  [string]$Json = ''         # 非空 = 额外写一份 JSON
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

Add-Type -Namespace QQR -Name Native -MemberDefinition @'
public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

function Get-QqWindows {
  $qqPids = @(Get-Process QQ -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if ($qqPids.Count -eq 0) { return @() }
  $found = New-Object System.Collections.Generic.List[object]
  $cb = [QQR.Native+EnumProc]{
    param($h, $l)
    $procId = 0
    [void][QQR.Native]::GetWindowThreadProcessId($h, [ref]$procId)
    if ($qqPids -contains $procId -and [QQR.Native]::IsWindowVisible($h)) {
      $len = [QQR.Native]::GetWindowTextLength($h)
      if ($len -gt 0) {
        $sb = New-Object System.Text.StringBuilder ($len + 2)
        [void][QQR.Native]::GetWindowText($h, $sb, $sb.Capacity)
        $rect = New-Object QQR.Native+RECT
        [void][QQR.Native]::GetWindowRect($h, [ref]$rect)
        $title = $sb.ToString()
        $found.Add([pscustomobject]@{
            Hwnd   = $h
            Title  = $title
            Width  = $rect.Right - $rect.Left
            Height = $rect.Bottom - $rect.Top
            IsMain = ($title -eq 'QQ')
          })
      }
    }
    return $true
  }
  [void][QQR.Native]::EnumWindows($cb, [IntPtr]::Zero)
  return $found
}

function Get-ElementByHwnd([int]$Hwnd) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, $Hwnd)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}

function Get-Descendants($element) {
  return $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
}

function Get-ElementText($element) {
  try {
    $tp = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    $text = $tp.DocumentRange.GetText(-1)
    if (-not [string]::IsNullOrWhiteSpace($text)) { return $text.Trim() }
  } catch { }
  $name = $element.Current.Name
  if ($null -eq $name) { return '' }
  return $name.Trim()
}

# ---------------------------------------------------------------- 主流程
$windows = Get-QqWindows
if ($windows.Count -eq 0) { Write-Output 'QQ 未运行（找不到 QQ.exe 的可见窗口）'; exit 1 }

if ($List -ne '') {
  Write-Output "QQ 窗口 $($windows.Count) 个："
  foreach ($w in $windows) { Write-Output ("  hwnd={0} {1}x{2} {3} {4}" -f $w.Hwnd, $w.Width, $w.Height, $(if ($w.IsMain) { '[主窗口]' } else { '[聊天窗口]' }), $w.Title) }
  exit 0
}

$target = $null
if ($Hwnd -ne 0) {
  $target = $windows | Where-Object { $_.Hwnd -eq $Hwnd } | Select-Object -First 1
  if ($null -eq $target) { Write-Output "hwnd=$Hwnd 不是当前可见的 QQ 窗口。用 -List 看可用句柄。"; exit 1 }
} elseif ($Window -ne '') {
  $target = $windows | Where-Object { $_.Title -like "*$Window*" } | Select-Object -First 1
  if ($null -eq $target) { Write-Output "没有匹配 '$Window' 的 QQ 窗口。当前可选："; $windows | ForEach-Object { Write-Output "  - $($_.Title)" }; exit 1 }
} else {
  $target = $windows | Where-Object { -not $_.IsMain } | Select-Object -First 1
  if ($null -eq $target) { $target = $windows | Select-Object -First 1 }
}
Write-Output "读取窗口: $($target.Title)  (hwnd=$($target.Hwnd))"

$win = Get-ElementByHwnd $target.Hwnd
if ($null -eq $win) { Write-Output 'UIA 找不到该窗口'; exit 1 }

function Read-Messages {
  $all = Get-Descendants $win
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $rows = @()
  $lastTime = ''
  # 关键：**按文档顺序**遍历整棵树。`.message__timestamp` 是消息容器的**兄弟**节点（不是子节点），
  # 所以只能顺序扫：遇到时间戳记住它，遇到下一条消息就把它挂上去。
  foreach ($el in $all) {
    $cn = $el.Current.ClassName
    if ($null -eq $cn) { continue }

    if ($cn -like '*message__timestamp*') {
      # 时间戳容器自身的 Name 往往是空的，真正的 "00:11" 挂在它的子元素上
      $stampText = ''
      foreach ($s in (Get-Descendants $el)) {
        $sname = $s.Current.Name
        if (-not [string]::IsNullOrWhiteSpace($sname)) { $stampText = $sname.Trim(); break }
      }
      if ($stampText -eq '') { $stampText = (Get-ElementText $el) }
      if (-not [string]::IsNullOrWhiteSpace($stampText)) { $lastTime = $stampText }
      continue
    }
    if ($cn -notlike '*message-container*') { continue }

    # 跳过嵌套容器：只认"父节点不是消息容器"的那一层，否则同一条消息会被记多次
    $parent = $walker.GetParent($el)
    if ($null -ne $parent) {
      $pcn = $parent.Current.ClassName
      if ($null -ne $pcn -and $pcn -like '*message-container*') { continue }
    }

    $self = $cn -like '*container--self*'
    $sender = ''
    $parts = @()
    foreach ($s in (Get-Descendants $el)) {
      $scn = $s.Current.ClassName
      $sname = $s.Current.Name
      if ($null -ne $scn -and ($scn -like '*avatar-span*' -or $scn -like '*nickname*' -or $scn -like '*member-name*')) {
        if (-not [string]::IsNullOrWhiteSpace($sname)) { $sender = $sname.Trim() }
        continue
      }
      if ($null -ne $sname -and $sname.Trim() -ne '') { $parts += $sname.Trim() }
    }
    $text = ($parts | Select-Object -Unique) -join ' '
    if ($text -eq '') { $text = (Get-ElementText $el) }
    if ($text -eq '') { continue }
    $rows += [pscustomobject]@{
      Time   = $lastTime
      Self   = $self
      Sender = $(if ($self) { '我' } else { $(if ($sender -ne '') { $sender } else { '对方' }) })
      Text   = $text
    }
  }
  return $rows
}

function Get-ScrollElement {
  # 不按类名猜，**按能力找**：谁能真的垂直滚动就用谁。
  # （实测：`ml-area ... chat-msg-area__vlist` 不支持 ScrollPattern；
  #   真正的滚动容器是它的祖先 `q-scroll-view ... ml-container`。）
  foreach ($el in (Get-Descendants $win)) {
    $pat = $null
    if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pat)) { continue }
    try {
      $sp = [System.Windows.Automation.ScrollPattern]$pat
      if ($sp.Current.VerticallyScrollable) { return $el }
    } catch { }
  }
  return $null
}

function Invoke-ScrollUpOnePage {
  $scrollEl = Get-ScrollElement
  if ($null -ne $scrollEl) {
    $sp = $scrollEl.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
    $sp.Scroll([System.Windows.Automation.ScrollAmount]::LargeDecrement, [System.Windows.Automation.ScrollAmount]::NoAmount)
    return $true
  }
  # 兜底：把最早那条消息 ScrollIntoView（虚拟列表会因此加载更早的内容）
  $first = $null
  foreach ($el in (Get-Descendants $win)) {
    $cn = $el.Current.ClassName
    if ($null -ne $cn -and $cn -like '*message-container*') { $first = $el; break }
  }
  if ($null -eq $first) { return $false }
  $pat = $null
  if (-not $first.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$pat)) { return $false }
  ([System.Windows.Automation.ScrollItemPattern]$pat).ScrollIntoView()
  return $true
}

$seen = @{}
$order = @()
$pass = 0
$maxPass = [Math]::Max(0, $Scroll) + 1
while ($pass -lt $maxPass) {
  $rows = Read-Messages
  foreach ($r in $rows) {
    $key = "$($r.Time)|$($r.Sender)|$($r.Text)"
    if (-not $seen.ContainsKey($key)) { $seen[$key] = $true; $order += $r }
  }
  $pass++
  if ($pass -ge $maxPass) { break }
  try {
    if (-not (Invoke-ScrollUpOnePage)) { Write-Output "（第 $pass 次：找不到可滚动容器，停止回溯）"; break }
    Start-Sleep -Milliseconds 900
    Write-Output "（已向上滚 $pass 次，继续读取…）"
  } catch {
    Write-Output "（滚动失败：$($_.Exception.Message)）"
    break
  }
}

# 读完后把列表滚回底部，恢复用户原来的视觉位置
if ($Scroll -gt 0) {
  $scrollEl = Get-ScrollElement
  if ($null -ne $scrollEl) {
    try {
      $sp = $scrollEl.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
      while ($sp.Current.VerticallyScrollable -and $sp.Current.VerticalScrollPercent -lt 99) {
        $sp.Scroll([System.Windows.Automation.ScrollAmount]::LargeIncrement, [System.Windows.Automation.ScrollAmount]::NoAmount)
        Start-Sleep -Milliseconds 400
      }
    } catch { }
  }
}

if ($order.Count -eq 0) { Write-Output '没有读到消息（窗口里可能没有打开对话，或消息列表为空）'; exit 2 }

$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$safeTitle = ($target.Title -replace '[\\/:*?"<>|]', '_')
if ($Out -eq '') {
  $dir = Join-Path $PSScriptRoot 'out'
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $Out = Join-Path $dir "$safeTitle-$stamp.md"
}

$lines = @()
$lines += "# QQ 对话 · $($target.Title)"
$lines += ''
$lines += "- 读取时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$lines += "- 消息条数：$($order.Count)（向上回溯 $Scroll 屏）"
$lines += "- 来源：UI Automation 读取 QQ 窗口（只读，未接触本地消息库）"
$lines += ''
$lines += '> 时间标注：`[09:30]` 是 QQ 显示的**时间分隔符**；`[~09:30]` 表示这条在该分隔符**之后**（QQ 不逐条显示时间）。'
$lines += ''
$carried = ''
foreach ($r in $order) {
  if ($r.Time -eq '') {
    $prefix = ''
  } elseif ($r.Time -ne $carried) {
    $prefix = "[$($r.Time)] "     # QQ 真正显示的时间分隔符
    $carried = $r.Time
  } else {
    $prefix = "[~$($r.Time)] "    # 继承上一条分隔符（QQ 没有为这条显示时间）
  }
  $lines += "**$prefix$($r.Sender)**：$($r.Text)"
  $lines += ''
}
[System.IO.File]::WriteAllText($Out, ($lines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))

if ($Json -ne '') {
  $jsonPath = [System.IO.Path]::ChangeExtension($Out, '.json')
  $json = [pscustomobject]@{
    window   = $target.Title
    hwnd     = $target.Hwnd
    readAt   = (Get-Date).ToString('o')
    scrolled = $Scroll
    messages = $order
  } | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($jsonPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Output "JSON: $jsonPath"
}

Write-Output "共 $($order.Count) 条消息 → $Out"
Write-Output ''
$lines | Select-Object -First 40 | ForEach-Object { Write-Output $_ }
