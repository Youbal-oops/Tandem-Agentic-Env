@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.12 or newer, then run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing Tandem dependencies...
  call npm.cmd ci
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo Open http://127.0.0.1:4317 in your browser once the server is ready.
echo Keep this window open. Press Ctrl+C to stop Tandem.
call npm.cmd start
pause
