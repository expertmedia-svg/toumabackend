@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\express\package.json" (
 call npm ci
 if errorlevel 1 goto failed
)
node src\server.js
:failed
pause
