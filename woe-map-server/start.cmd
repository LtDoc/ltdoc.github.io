@echo off
rem Run the WoE Strategy Map in a console window (for testing; use scripts\install-service.ps1 for a service).
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
)
if "%PORT%"=="" set PORT=8080
echo Starting on http://localhost:%PORT%/
node server\index.js
