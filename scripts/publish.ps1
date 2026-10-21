# publish.ps1 - pre-check + commit + push for this repo
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish.ps1 -Message "update: xxx"
# Exit codes: 0 ok/nothing to commit, 2 sensitive match, 3 big file, 1 other error
param([string]$Message = "update: docs/scripts")

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
Write-Host "[publish] repo: $repo"

if (-not (Test-Path (Join-Path $repo '.git'))) {
  Write-Host "[publish] not a git repo: $repo"
  exit 1
}

# ---- checks (working tree, excluding .git) ----
$files = Get-ChildItem $repo -Recurse -File | Where-Object { $_.FullName -notmatch '\\\.git\\' }

$big = $files | Where-Object { $_.Length -gt 10MB }
if ($big) {
  Write-Host "[publish] ERROR: files > 10MB found:"
  $big | ForEach-Object { Write-Host ("  " + $_.FullName + "  " + [math]::Round($_.Length/1MB,2) + " MB") }
  exit 3
}

$patterns = @(
  'session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
  'C:\\Users\\[A-Za-z0-9_-]+\\',
  '-----BEGIN [A-Z ]*PRIVATE KEY-----',
  'sk-[A-Za-z0-9]{20,}',
  'ghp_[A-Za-z0-9]{20,}'
)
$hits = @()
foreach ($p in $patterns) {
  $hits += $files | Select-String -Pattern $p -ErrorAction SilentlyContinue
}
if ($hits) {
  Write-Host "[publish] ERROR: sensitive patterns found:"
  $hits | Select-Object -First 20 | ForEach-Object { Write-Host ("  " + $_.Path + ":" + $_.LineNumber + ": " + $_.Line.Trim()) }
  exit 2
}

# ---- stage / commit / push ----
git add -A
$status = @(git status --porcelain)
if ($status.Count -eq 0) {
  Write-Host "[publish] nothing to commit."
  exit 0
}

git commit -m $Message
if ($LASTEXITCODE -ne 0) { exit 1 }
git push
if ($LASTEXITCODE -ne 0) { exit 1 }

git log --oneline -1
Write-Host "[publish] done."
