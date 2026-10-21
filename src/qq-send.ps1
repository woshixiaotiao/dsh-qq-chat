# qq-send.ps1 —— 往"当前打开的 QQ 聊天窗口"发送一条消息（UI Automation，兜底方案）
#
# 背景：NapCat 走不通时（例如小号正登录在普通 QQ 客户端、无法再登录一次），
# 用 UI 自动化把回复敲进小号客户端的输入框发给对方。只用于**你自己账号之间**的机器人用途。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File qq-send.ps1 -Text '你好' -List 1
#   powershell ... -File qq-send.ps1 -Text '你好' -Hwnd 1234567
#   powershell ... -File qq-send.ps1 -Text '你好' -Window '刘玉兆'
#   powershell ... -File qq-send.ps1 -Text '你好' -DryRun 1   # 只填入不发送（看输入框是否可用）
param(
  [string]$Text = '',
  [string]$Window = '',
  [int]$Hwnd = 0,
  [string]$List = '',
  [string]$DryRun = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace QQW -Name Native -MemberDefinition @'
public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder s, int n);
'@

function Get-QqWindows {
  $qqPids = @(Get-Process QQ -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if ($qqPids.Count -eq 0) { return @() }
  $found = New-Object System.Collections.Generic.List[object]
  $cb = [QQW.Native+EnumProc]{
    param($h, $l)
    $procId = 0
    [void][QQW.Native]::GetWindowThreadProcessId($h, [ref]$procId)
    if ($qqPids -contains $procId -and [QQW.Native]::IsWindowVisible($h)) {
      $len = [QQW.Native]::GetWindowTextLength($h)
      if ($len -gt 0) {
        $sb = New-Object System.Text.StringBuilder ($len + 2)
        [void][QQW.Native]::GetWindowText($h, $sb, $sb.Capacity)
        $found.Add([pscustomobject]@{ Hwnd = [long]$h; Title = $sb.ToString(); Pid = $procId })
      }
    }
    return $true
  }
  [void][QQW.Native]::EnumWindows($cb, [IntPtr]::Zero)
  return $found
}

$windows = Get-QqWindows
if ($windows.Count -eq 0) { Write-Output 'QQ 未运行或没有可见窗口'; exit 1 }
if ($List -ne '') { foreach ($w in $windows) { Write-Output ("hwnd={0} pid={1} title={2}" -f $w.Hwnd, $w.Pid, $w.Title) }; exit 0 }
if ($Text -eq '') { Write-Output '缺 -Text'; exit 2 }

$target = $null
if ($Hwnd -ne 0) { $target = $windows | Where-Object { $_.Hwnd -eq $Hwnd } | Select-Object -First 1 }
elseif ($Window -ne '') { $target = $windows | Where-Object { $_.Title -like "*$Window*" } | Select-Object -First 1 }
else { $target = $windows | Select-Object -First 1 }
if ($null -eq $target) { Write-Output '找不到目标 QQ 窗口；用 -List 1 看句柄'; exit 1 }

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]$target.Hwnd)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if ($null -eq $win) { Write-Output 'UIA 找不到窗口'; exit 1 }
# 触发 Chromium 建树
$all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
Write-Output "窗口: $($target.Title) hwnd=$($target.Hwnd) pid=$($target.Pid) 元素=$($all.Count)"

# 1) 找输入区：msg-input 组下的 ProseMirror 编辑器（或 Edit/Document）
$inputGroup = $null
foreach ($el in $all) {
  $c = $el.Current.ClassName
  if ($null -ne $c -and $c -like '*msg-input*') { $inputGroup = $el; break }
}
$editor = $null
if ($null -ne $inputGroup) {
  $sub = $inputGroup.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($el in $sub) {
    $ct = $el.Current.ControlType.ProgrammaticName
    $c = $el.Current.ClassName
    if ($ct -match 'Document|Edit' -or ($null -ne $c -and $c -like '*ProseMirror*')) { $editor = $el; break }
  }
}
if ($null -eq $editor) { Write-Output '找不到输入框（QQ 版本/窗口状态可能变了）'; exit 1 }
Write-Output "输入框: type=$($editor.Current.ControlType.ProgrammaticName) class=$($editor.Current.ClassName)"

# 2) 设置内容：优先 ValuePattern
$ok = $false
$vp = $null
if ($editor.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
  try { ([System.Windows.Automation.ValuePattern]$vp).SetValue($Text); $ok = $true } catch { Write-Output "ValuePattern.SetValue 失败: $($_.Exception.Message)" }
}
if (-not $ok) {
  # 兜底：聚焦 + 剪贴板粘贴
  try {
    $editor.SetFocus()
    Start-Sleep -Milliseconds 150
    Set-Clipboard -Value $Text
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 300
    $ok = $true
  } catch { Write-Output "剪贴板粘贴失败: $($_.Exception.Message)" }
}
if (-not $ok) { Write-Output '写入输入框失败'; exit 1 }

# 3) 找发送按钮（class send-msg / name 发送）
Start-Sleep -Milliseconds 250
$sendBtn = $null
$all2 = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($el in $all2) {
  if ($el.Current.ControlType.ProgrammaticName -eq 'ControlType.Button' -and $el.Current.Name -eq '发送') { $sendBtn = $el; break }
}
if ($null -eq $sendBtn) {
  # 退而求其次：class 含 send-msg
  foreach ($el in $all2) { $c = $el.Current.ClassName; if ($null -ne $c -and $c -like '*send-msg*') { $sendBtn = $el; break } }
}
if ($null -eq $sendBtn) { Write-Output '找不到发送按钮'; exit 1 }
$enabled = -not ($sendBtn.Current.ClassName -like '*send--disabled*')
Write-Output "发送按钮: class=$($sendBtn.Current.ClassName) 可用=$enabled"
if ($DryRun -ne '') { Write-Output 'dry-run：只填入，不发送'; exit 0 }
if (-not $enabled) { Write-Output '发送按钮仍禁用（输入可能没生效）'; exit 1 }

$inv = $null
if ($sendBtn.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) {
  ([System.Windows.Automation.InvokePattern]$inv).Invoke()
} else {
  # 兜底：模拟回车
  $editor.SetFocus()
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
}
Start-Sleep -Milliseconds 600
Write-Output '已发送'
