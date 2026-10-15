<#
.SYNOPSIS
  Bootstraps the WIT integration branches (work, wip) on the remote.

.DESCRIPTION
  Convention: +wit/common/conventions/repo-setup.md — every WIT repository
  has main, work, wip plus one branch per persona. This script creates
  `work` and `wip` on origin from -From (default: origin/main) if they do
  not exist. Existing branches are never touched — wip/work are
  fast-forward-only branches and MUST NOT be recreated or reset.

  Fresh repositories without a `main` yet (manual setup, no released
  baseline): pass the reviewed starting branch explicitly, e.g.

      .\scripts\init-branches.ps1 -From origin/dominik

  `main` itself is never created by this script — releasing a baseline to
  main is a human decision (merge `work` once reviewed).

.EXAMPLE
  .\scripts\init-branches.ps1                  # work + wip from origin/main
.EXAMPLE
  .\scripts\init-branches.ps1 -From origin/dominik  # bootstrap before main exists
#>
param(
    [string]$From = "origin/main"
)
$ErrorActionPreference = "Stop"

git rev-parse --is-inside-work-tree | Out-Null
git fetch origin --prune

git rev-parse --verify --quiet "$From^{commit}" | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "$From does not exist on the remote - pass -From <ref> (e.g. your reviewed persona branch)"
}

foreach ($target in @("work", "wip")) {
    git rev-parse --verify --quiet "origin/$target^{commit}" | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "skip    $target - already exists on origin"
        continue
    }
    git push origin "$From`:refs/heads/$target"
    if ($LASTEXITCODE -ne 0) { throw "push of $target failed" }
    Write-Host "created $target <- $From"
}

git rev-parse --verify --quiet "origin/main^{commit}" | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "note    origin/main is missing - a human creates it by merging work once the baseline is reviewed"
}
Write-Host "done"
