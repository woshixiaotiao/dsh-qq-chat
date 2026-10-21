@echo off
setlocal
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Install Node.js 22+ first.
  pause
  exit /b 1
)
if not exist "src\qq-bot-bridge.mjs" (
  echo [ERROR] src\qq-bot-bridge.mjs not found. Run this script from the repo root.
  pause
  exit /b 1
)
node "src\qq-bot-bridge.mjs" %*
