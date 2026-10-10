@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 20 or newer, then run this file again.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:3000/ in Edge or Chrome.
echo Keep this window open while using the app.
node server.mjs
pause
