# Removes the service / scheduled task created by install-service.ps1. Run elevated.
param([string]$ServiceName = "WoEStrategyMap", [int]$Port = 8080)
$nssm = Get-Command nssm -ErrorAction SilentlyContinue
if ($nssm -and (Get-Service $ServiceName -ErrorAction SilentlyContinue)) {
  & nssm stop $ServiceName
  & nssm remove $ServiceName confirm
}
if (Get-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false
}
Remove-NetFirewallRule -DisplayName "$ServiceName ($Port)" -ErrorAction SilentlyContinue
Write-Host "Removed $ServiceName. Your data folder was left untouched."
