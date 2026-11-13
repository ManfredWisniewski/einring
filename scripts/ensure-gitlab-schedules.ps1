<#
.SYNOPSIS
  Creates or updates the WIT pipeline schedules on GitLab projects.

.DESCRIPTION
  Idempotent: schedules are matched by description (= SCHEDULE_TASK value).
  Missing schedules are created, drifted cron/ref/variable values are fixed,
  extra schedules are left alone. The schedule set mirrors the header of
  .gitlab-ci.yml. Cron times are UTC, same as the GitHub workflows.

  Token: personal or project access token with scope api and at least the
  Maintainer role on every project. Pass -Token or set $env:GITLAB_TOKEN.
  The token owner becomes the schedule owner (pipelines run as that user).

.EXAMPLE
  $env:GITLAB_TOKEN = '<token>'
  .\scripts\ensure-gitlab-schedules.ps1                      # project from origin
  .\scripts\ensure-gitlab-schedules.ps1 -Project wit/client-wit, wit/client-faw
  .\scripts\ensure-gitlab-schedules.ps1 -DryRun
#>
param(
    [string[]]$Project,
    [string]$Server = 'https://git.w1t.org',
    [string]$Ref = 'main',
    [string]$Token = $env:GITLAB_TOKEN,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$schedules = [ordered]@{
    'main-to-wip'          = '5 4 * * *'
    'tasks-archive'        = '0 2 * * *'
    'weekly-dailies'       = '0 3 * * 0'
    'open-work-to-main-pr' = '0 5,7,9,11,13,15 * * *'
    'persona-janitor'      = '30 4 * * *'
    'structure-check'      = '0 5 * * *'
}

if (-not $Token) {
    $envFile = Join-Path (git rev-parse --show-superproject-working-tree --show-toplevel | Select-Object -First 1) '.env'
    if (Test-Path $envFile) {
        $line = Get-Content $envFile | Where-Object { $_ -match '^\s*GITLAB_TOKEN\s*=' } | Select-Object -First 1
        if ($line) { $Token = ($line -split '=', 2)[1].Trim().Trim('"', "'") }
    }
}
if (-not $Token) { throw 'no token - pass -Token, set $env:GITLAB_TOKEN or GITLAB_TOKEN= in the repo .env (scope api, role Maintainer)' }

if (-not $Project) {
    $url = (git remote get-url origin) -replace '\.git$', ''
    if ($url -match '^[a-z+]+://') { $path = ([uri]$url).AbsolutePath.Trim('/') }
    else { $path = ($url -split ':', 2)[1] }
    if (-not $path) { throw "cannot derive project path from origin '$url' - pass -Project" }
    $Project = @($path)
}

$headers = @{ 'PRIVATE-TOKEN' = $Token }
function Invoke-GitLab([string]$Method, [string]$Path, [hashtable]$Body) {
    $params = @{ Method = $Method; Uri = "$Server/api/v4/$Path"; Headers = $headers }
    if ($Body) { $params.Body = $Body }
    Invoke-RestMethod @params
}

foreach ($p in $Project) {
    $id = [uri]::EscapeDataString($p)
    Write-Output "== $p"
    $existing = @(Invoke-GitLab GET "projects/$id/pipeline_schedules?per_page=100")

    foreach ($task in $schedules.Keys) {
        $cron = $schedules[$task]
        $s = $existing | Where-Object { $_.description -eq $task } | Select-Object -First 1

        if (-not $s) {
            Write-Output "  create  $task ($cron, ref $Ref)"
            if ($DryRun) { continue }
            $s = Invoke-GitLab POST "projects/$id/pipeline_schedules" @{
                description = $task; ref = $Ref; cron = $cron; cron_timezone = 'UTC'; active = 'true'
            }
            Invoke-GitLab POST "projects/$id/pipeline_schedules/$($s.id)/variables" @{
                key = 'SCHEDULE_TASK'; value = $task
            } | Out-Null
            continue
        }

        if ($s.cron -ne $cron -or $s.ref -ne $Ref -or $s.cron_timezone -ne 'UTC') {
            Write-Output "  update  $task (cron '$($s.cron)' -> '$cron', ref '$($s.ref)' -> '$Ref', tz '$($s.cron_timezone)' -> 'UTC')"
            if (-not $DryRun) {
                Invoke-GitLab PUT "projects/$id/pipeline_schedules/$($s.id)" @{
                    ref = $Ref; cron = $cron; cron_timezone = 'UTC'
                } | Out-Null
            }
        }

        $detail = Invoke-GitLab GET "projects/$id/pipeline_schedules/$($s.id)"
        $var = $detail.variables | Where-Object { $_.key -eq 'SCHEDULE_TASK' } | Select-Object -First 1
        if (-not $var) {
            Write-Output "  add var $task SCHEDULE_TASK=$task"
            if (-not $DryRun) {
                Invoke-GitLab POST "projects/$id/pipeline_schedules/$($s.id)/variables" @{
                    key = 'SCHEDULE_TASK'; value = $task
                } | Out-Null
            }
        } elseif ($var.value -ne $task) {
            Write-Output "  fix var $task SCHEDULE_TASK '$($var.value)' -> '$task'"
            if (-not $DryRun) {
                Invoke-GitLab PUT "projects/$id/pipeline_schedules/$($s.id)/variables/SCHEDULE_TASK" @{
                    value = $task
                } | Out-Null
            }
        } else {
            Write-Output "  ok      $task"
        }
    }
}
