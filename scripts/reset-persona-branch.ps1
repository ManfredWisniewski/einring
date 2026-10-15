<#
.SYNOPSIS
  Hard-resets the current persona branch to a base ref and re-initialises submodules.

.DESCRIPTION
  For when the base branch was restructured and merging is not worth it — the
  persona branch is discarded and rebuilt from the base. Destructive by design:
  - a safety branch <branch>-pre-reset is created first (unless -NoBackup)
  - refuses to run on integration branches (main, work, wip)
  - submodules are de-initialised, the branch is reset --hard, submodules are
    re-initialised from the new .gitmodules
  - stale submodule checkouts (untracked dirs that still contain a .git
    gitfile/dir) are removed

  Convention: +wit/common/conventions/git-worktrees.md

.EXAMPLE
  .\scripts\reset-persona-branch.ps1                  # reset to origin/main
  .\scripts\reset-persona-branch.ps1 -Base origin/wip # reset to wip tip
#>
param(
    [string]$Base = "origin/main",
    [switch]$NoBackup
)
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
    git rev-parse --is-inside-work-tree | Out-Null

    $branch = git branch --show-current
    if (-not $branch) { throw "detached HEAD - check out a persona branch first" }
    if ($branch -in @("main", "work", "wip")) {
        throw "refusing to reset integration branch '$branch' - run this from a persona worktree"
    }

    git fetch origin --prune

    git rev-parse --verify --quiet $Base | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "base ref '$Base' does not exist" }

    if (-not $NoBackup) {
        $backup = "$branch-pre-reset"
        git show-ref --verify --quiet "refs/heads/$backup"
        if ($LASTEXITCODE -eq 0) { $backup = "$branch-pre-reset-$(Get-Date -Format yyyyMMdd-HHmm)" }
        git branch $backup $branch
        Write-Host "backup  $branch -> $backup"
    }

    git submodule deinit -f --all
    git reset --hard $Base
    git submodule update --init --recursive --force

    # stale submodule checkouts: untracked dirs that still contain .git
    $stale = git ls-files --others --exclude-standard --directory |
        Where-Object { Test-Path (Join-Path $repo "$_/.git") }
    foreach ($dir in $stale) {
        Remove-Item -Recurse -Force (Join-Path $repo $dir)
        Write-Host "clean   $dir (stale submodule checkout)"
    }

    git status --short --branch
    Write-Host "done    $branch == $Base - backup kept at $backup"
}
finally { Pop-Location }
