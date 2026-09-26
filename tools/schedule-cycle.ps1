<#
.SYNOPSIS
  Trigger one Mission Control cycle on THIS machine (local-only).

.DESCRIPTION
  Calls http://127.0.0.1:3000/api/cycle?group=<Group> with the bearer secret.
  Mission Control must already be running locally (npm run dev / npm start).
  The cycle runs ONE agent at a time, skips agents whose inputs have not
  changed (and whose last successful run is under 7 days old), uses only the
  free models, and never changes code, the database, or production.

  The secret is NEVER stored in this script. It is read, in order, from:
    1. the MC_CRON_SECRET environment variable (user scope), or
    2. the CRON_SECRET line in the repository's .env.local.
  It is never printed.

  Running this script does NOT register a scheduled task. Register the tasks
  yourself (once), e.g. in PowerShell as your own user:

    $repo   = "C:\Projects\footrank-mission-control"
    $script = "$repo\tools\schedule-cycle.ps1"
    $act    = { param($g) New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -Group $g" }
    $set    = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 5)
    # every 4 hours
    $t4h = New-ScheduledTaskTrigger -Once -At 00:05 -RepetitionInterval (New-TimeSpan -Hours 4)
    Register-ScheduledTask -TaskName "MissionControl-4h"   -Action (& $act "4h")    -Trigger $t4h -Settings $set
    # daily
    Register-ScheduledTask -TaskName "MissionControl-daily" -Action (& $act "daily") -Trigger (New-ScheduledTaskTrigger -Daily -At 09:15) -Settings $set
    # every 5 days
    Register-ScheduledTask -TaskName "MissionControl-5day"  -Action (& $act "5day")  -Trigger (New-ScheduledTaskTrigger -Daily -DaysInterval 5 -At 10:15) -Settings $set

  Overlapping triggers are safe: a cycle that finds another one running is
  skipped (not queued).

.PARAMETER Group
  4h | daily | 5day
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("4h", "daily", "5day")]
  [string]$Group
)

$ErrorActionPreference = "Stop"

function Get-CycleSecret {
  if ($env:MC_CRON_SECRET -and $env:MC_CRON_SECRET.Trim()) { return $env:MC_CRON_SECRET.Trim() }
  $envFile = Join-Path (Split-Path -Parent $PSScriptRoot) ".env.local"
  if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
      if ($line -match '^\s*CRON_SECRET\s*=\s*(.*)\s*$') {
        $v = $Matches[1].Trim().Trim('"').Trim("'")
        if ($v) { return $v }
      }
    }
  }
  return $null
}

$secret = Get-CycleSecret
if (-not $secret) {
  Write-Error "No cycle secret found: set MC_CRON_SECRET (user environment) or CRON_SECRET in .env.local. Nothing was run."
  exit 2
}

$uri = "http://127.0.0.1:3000/api/cycle?group=$Group"
try {
  # A cycle runs agents one at a time and can take a few hours.
  $r = Invoke-RestMethod -Method Post -Uri $uri -Headers @{ Authorization = "Bearer $secret" } -TimeoutSec 18000
} catch {
  Write-Error "Mission Control cycle '$Group' failed: $($_.Exception.Message). Is Mission Control running on port 3000?"
  exit 1
} finally {
  Remove-Variable secret -ErrorAction SilentlyContinue
}

$summary = ($r.agents | ForEach-Object { "$($_.agent)=$($_.outcome)" }) -join ", "
Write-Output "Mission Control cycle '$Group': $($r.status). $summary"
exit 0
