<#
.SYNOPSIS
  Creates one git worktree per persona under a target root.

.DESCRIPTION
  Convention: +wit/common/conventions/git-worktrees.md
  - worktree dir: <TargetRoot>\<repo>-<persona>
  - persona list: +wit/agents/personas/*/profile.md (trurl/profile.md -> trurl)
  - existing persona branch -> checked out; origin/<persona> -> tracked;
    otherwise a new branch is created from -BaseBranch (wip)
  - stale worktree registrations are pruned first
  - `git submodule update --init` runs in each new worktree
#>
param(
    [string]$TargetRoot = "P:\git\agents",
    [string]$BaseBranch = "wip"
)
$ErrorActionPreference = "Stop"

$repo     = Split-Path -Parent $PSScriptRoot
$repoName = Split-Path -Leaf $repo

Push-Location $repo
try {
    git fetch origin --prune
    git worktree prune

    # base new persona branches on the remote tip when available —
    # local integration branches may be stale
    git show-ref --verify --quiet "refs/remotes/origin/$BaseBranch"
    if ($LASTEXITCODE -eq 0) { $BaseBranch = "origin/$BaseBranch" }

    # branches already checked out in a registered worktree
    $inUse = git worktree list --porcelain |
        Select-String -Pattern '^branch refs/heads/(.+)$' |
        ForEach-Object { $_.Matches[0].Groups[1].Value }

    $personas = Get-ChildItem "$repo\+wit\agents\personas\*\profile.md" |
        ForEach-Object { $_.Directory.Name.ToLower() } |
        Sort-Object -Unique

    New-Item -ItemType Directory -Force -Path $TargetRoot | Out-Null

    foreach ($p in $personas) {
        $path = Join-Path $TargetRoot "$repoName-$p"

        if ($inUse -contains $p) {
            Write-Host "skip  $p - branch already checked out in a worktree"
            continue
        }
        if (Test-Path $path) {
            Write-Host "skip  $p - $path already exists"
            continue
        }

        git show-ref --verify --quiet "refs/heads/$p"
        $local = ($LASTEXITCODE -eq 0)
        git show-ref --verify --quiet "refs/remotes/origin/$p"
        $remote = ($LASTEXITCODE -eq 0)

        if ($local -or $remote) {
            git worktree add $path $p
        }
        else {
            git worktree add -b $p $path $BaseBranch
        }
        if ($LASTEXITCODE -ne 0) { Write-Warning "worktree add failed for $p"; continue }

        git -C $path submodule update --init
        Write-Host "ok    $p -> $path"
    }
}
finally { Pop-Location }
