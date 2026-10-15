<#
.SYNOPSIS
  Integrates the committed persona-branch state into origin/wip.

.DESCRIPTION
  Scripted equivalent of the documented integration sequence
  (+wit/common/conventions/git-worktrees.md):

    scripts\sync-persona-branch.ps1 -Upstream origin/wip
    git push origin HEAD        # persona branch backup
    git push origin HEAD:wip    # fast-forward origin/wip

  Pre-flight checks (the errors that otherwise surface as conflicts or
  broken clones for other agents):
  - every submodule pin equals the submodule HEAD (no unpinned commits);
  - every pin is contained in a branch on the submodule's upstream
    (no pin pointing at an unpushed commit);
  - clean working tree, persona branch, no merge/rebase in progress.

  A 'rejected (non-fast-forward)' push to wip just means another agent
  integrated meanwhile — the script re-syncs and retries (default 3x)
  before escalating.

.EXAMPLE
  .\scripts\integrate-wip.ps1
#>
param(
    [int]$Retries = 3
)
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
    git rev-parse --is-inside-work-tree | Out-Null

    $branch = git branch --show-current
    if (-not $branch) { throw "detached HEAD - check out a persona branch first" }
    if ($branch -in @("main", "work", "wip")) {
        throw "refusing to integrate from '$branch' - run this from a persona worktree"
    }
    if (git status --porcelain) { throw "working tree not clean - commit or stash first" }

    # pin sanity: pin == submodule HEAD, and the pinned commit is pushed upstream
    $subs = git config --file .gitmodules --get-regexp 'path$' |
        ForEach-Object { (($_ -split '\s+', 2)[1]).Trim() }
    foreach ($path in $subs) {
        $sub = Join-Path $repo ($path -replace '/', '\')
        if (-not (Test-Path (Join-Path $sub '.git'))) {
            throw "submodule $path is not initialised - run 'git submodule update --init'"
        }
        $pin = ((git ls-tree HEAD $path) -split '\s+')[2]
        if (-not $pin) { throw "submodule $path : no gitlink pinned in HEAD" }
        $head = (git -C $sub rev-parse HEAD).Trim()
        if ($pin -ne $head) {
            throw "submodule $path : checkout $($head.Substring(0,8)) != pin $($pin.Substring(0,8)) - commit the pin or restore the checkout first"
        }
        git -C $sub fetch --quiet origin
        $remote = git -C $sub branch -r --contains $pin
        if (-not $remote) {
            throw "submodule $path : pin $($pin.Substring(0,8)) is not on any upstream branch - push the submodule branch first, or other agents cannot fetch it"
        }
    }

    try { & "$PSScriptRoot\sync-persona-branch.ps1" -Upstream origin/wip }
    catch { throw "sync failed: $_ - resolve as reported, then re-run" }

    git push origin HEAD
    if ($LASTEXITCODE -ne 0) { throw "persona-branch push failed" }

    for ($i = 1; $i -le $Retries; $i++) {
        git push origin "HEAD:wip"
        if ($LASTEXITCODE -eq 0) { break }
        if ($i -eq $Retries) {
            throw "wip push rejected $Retries times in a row - escalate (impediments-log)"
        }
        Write-Host "wip     non-fast-forward - another agent integrated; re-syncing ($i/$Retries)"
        try { & "$PSScriptRoot\sync-persona-branch.ps1" -Upstream origin/wip }
        catch { throw "re-sync failed: $_ - escalate" }
        git push origin HEAD | Out-Null
    }

    Write-Host "done    $branch integrated into origin/wip"
}
finally { Pop-Location }
