@echo off
setlocal
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Install Node.js 22+ first.
  pause
  exit /b 1
)
node "src\qq-bot-bridge.mjs" --check
pause
