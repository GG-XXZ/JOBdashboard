@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODE_EXE=%~dp0..\.tools\node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
set "NPM_EXE=%~dp0..\.tools\node\npm.cmd"
if not exist "%NPM_EXE%" set "NPM_EXE=npm"
set "DASHBOARD_URL=http://localhost:8420/dashboard.html"
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8420 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  start "" "%DASHBOARD_URL%"
  exit /b 0
)
if not exist "%~dp0node_modules\imapflow" (
  echo First run: installing dashboard email dependencies...
  call "%NPM_EXE%" install --omit=dev
  if errorlevel 1 (
    echo Dependency installation failed. Check the network/proxy settings and run npm install in dashboard.
    pause
    exit /b 1
  )
)
start "" "%DASHBOARD_URL%"
"%NODE_EXE%" server.js
pause
