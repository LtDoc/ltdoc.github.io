# Installs the WoE Strategy Map as a Windows service (NSSM) or, if NSSM is not installed,
# as a scheduled task that starts at boot and restarts on failure.
# Run from an elevated PowerShell:  .\scripts\install-service.ps1 -Port 8080
param(
  [string]$ServiceName = "WoEStrategyMap",
  [int]$Port = 8080,
  [string]$DataDir = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
if (-not $DataDir) { $DataDir = Join-Path $root "data" }

$nssm = Get-Command nssm -ErrorAction SilentlyContinue
if ($nssm) {
  Write-Host "Installing service '$ServiceName' with NSSM"
  & nssm install $ServiceName $node "server\index.js"
  & nssm set $ServiceName AppDirectory $root
  & nssm set $ServiceName AppEnvironmentExtra "PORT=$Port" "WOE_DATA_DIR=$DataDir"
  & nssm set $ServiceName AppStdout (Join-Path $logDir "out.log")
  & nssm set $ServiceName AppStderr (Join-Path $logDir "err.log")
  & nssm set $ServiceName AppRotateFiles 1
  & nssm set $ServiceName AppRotateBytes 10485760
  & nssm set $ServiceName Start SERVICE_AUTO_START
  & nssm set $ServiceName AppExit Default Restart
  & nssm start $ServiceName
} else {
  Write-Host "NSSM not found; registering a scheduled task '$ServiceName' instead (runs as SYSTEM at boot)."
  $cmd = "/c set PORT=$Port&& set WOE_DATA_DIR=$DataDir&& `"$node`" server\index.js >> `"$logDir\out.log`" 2>&1"
  $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $cmd -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $ServiceName -Action $action -Trigger $trigger -Settings $settings `
    -User "SYSTEM" -RunLevel Highest -Force | Out-Null
  Start-ScheduledTask -TaskName $ServiceName
}

if (-not (Get-NetFirewallRule -DisplayName "$ServiceName ($Port)" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "$ServiceName ($Port)" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
  Write-Host "Opened inbound TCP $Port in Windows Firewall."
}
Write-Host "Done. Browse to http://localhost:$Port/"
