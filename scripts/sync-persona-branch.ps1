<#
.SYNOPSIS
  Syncs the persona branch with upstream integration branches and submodules.

.DESCRIPTION
  Session-start and pre-integration sync (convention:
  +wit/common/conventions/git-worktrees.md).

  For each upstream ref (default: origin/main, then origin/wip):
  - fetches and merges it into the current persona branch;
  - resolves submodule-gitlink conflicts by merging both pinned commits
    inside the submodule on the persona branch and pushing the result to
    the submodule's upstream — a gitlink is never resolved by picking a
    side by hand;
  - append-only files under +team/+coordination/ merge by themselves via
    the .gitattributes union driver.

  Any other conflict aborts the merge, realigns the submodule checkouts
  and throws — escalate to a human (row in
  +team/+coordination/impediments-log.md) instead of resolving by hand.

  Refuses to run: detached HEAD, on main/work/wip, dirty working tree, or
  while a merge/rebase/cherry-pick is in progress.

.EXAMPLE
  .\scripts\sync-persona-branch.ps1                     # origin/main + origin/wip
.EXAMPLE
  .\scripts\sync-persona-branch.ps1 -Upstream origin/wip # integration only
#>
param(
    [string[]]$Upstream = @("origin/main", "origin/wip")
)
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo

function Resolve-Gitlink {
    param([string]$Path, [string]$Ours, [string]$Theirs, [string]$Persona)

    $sub = Join-Path $repo ($Path -replace '/', '\')
    if (-not (Test-Path (Join-Path $sub '.git'))) {
        Write-Host "  pin     $Path : not initialised - cannot arbitrate"
        return $false
    }
    git -C $sub fetch --quiet origin
    git -C $sub cat-file -e "$Theirs^{commit}"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  pin     $Path : $($Theirs.Substring(0,8)) is not on the submodule upstream - the other side pinned an unpushed commit"
        return $false
    }

    $resolved = $null
    git -C $sub merge-base --is-ancestor $Ours $Theirs
    if ($LASTEXITCODE -eq 0) { $resolved = $Theirs }
    else {
        git -C $sub merge-base --is-ancestor $Theirs $Ours
        if ($LASTEXITCODE -eq 0) { $resolved = $Ours }
        else {
            # real divergence - merge inside the submodule on a scratch branch
            git -C $sub switch --quiet -C "sync/pin-arbitration" $Ours
            if ($LASTEXITCODE -ne 0) {
                Write-Host "  pin     $Path : cannot check out $($Ours.Substring(0,8)) inside the submodule"
                return $false
            }
            git -C $sub merge --no-edit $Theirs
            if ($LASTEXITCODE -ne 0) {
                git -C $sub merge --abort
                Write-Host "  pin     $Path : merge inside the submodule conflicts - real content conflict, escalate"
                return $false
            }
            # converge with the pushed persona branch if it moved meanwhile
            git -C $sub rev-parse --verify --quiet "origin/$Persona^{commit}" | Out-Null
            if ($LASTEXITCODE -eq 0) {
                git -C $sub merge-base --is-ancestor "origin/$Persona" HEAD
                if ($LASTEXITCODE -ne 0) {
                    git -C $sub merge --no-edit "origin/$Persona"
                    if ($LASTEXITCODE -ne 0) {
                        git -C $sub merge --abort
                        Write-Host "  pin     $Path : merging origin/$Persona inside the submodule conflicts - escalate"
                        return $false
                    }
                }
            }
            # publish on the persona branch so the pin is fetchable upstream
            git -C $sub branch -f $Persona HEAD
            git -C $sub push --quiet -u origin $Persona
            if ($LASTEXITCODE -ne 0) {
                Write-Host "  pin     $Path : arbitration commit could not be pushed to the submodule upstream"
                return $false
            }
            $resolved = (git -C $sub rev-parse HEAD).Trim()
            Write-Host "  pin     $Path : merged both pins inside the submodule -> $($resolved.Substring(0,8)) (pushed as $Persona)"
        }
    }

    # stage the resolved pin: check the submodule out at it, then git add
    # records that gitlink at stage0 and clears the unmerged stages
    git -C $sub checkout --quiet $resolved
    git add $Path
    Write-Host "  pin     $Path : resolved to $($resolved.Substring(0,8))"
    return $true
}

try {
    git rev-parse --is-inside-work-tree | Out-Null

    $branch = git branch --show-current
    if (-not $branch) { throw "detached HEAD - check out a persona branch first" }
    if ($branch -in @("main", "work", "wip")) {
        throw "refusing to sync integration branch '$branch' - run this from a persona worktree"
    }
    foreach ($st in @("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD")) {
        git rev-parse --verify --quiet $st | Out-Null
        if ($LASTEXITCODE -eq 0) { throw "operation in progress ($st) - finish it or 'git merge --abort' first" }
    }
    $rebaseDir = git rev-parse --git-path rebase-merge
    if (Test-Path (Join-Path $repo $rebaseDir)) { throw "rebase in progress - finish or abort it first" }
    if (git status --porcelain) { throw "working tree not clean - commit or stash before syncing" }

    git fetch origin --prune

    foreach ($up in $Upstream) {
        git rev-parse --verify --quiet "$up^{commit}" | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Host "skip    $up - ref does not exist"; continue }
        git merge-base --is-ancestor $up HEAD
        if ($LASTEXITCODE -eq 0) { Write-Host "uptodate $up"; continue }

        Write-Host "merge   $up"
        git merge --no-edit $up
        if ($LASTEXITCODE -eq 0) { continue }

        # conflicted - classify unmerged paths
        $pins = @{}
        $files = @()
        foreach ($line in (git ls-files -u)) {
            if ($line -match '^160000 ([0-9a-f]{40}) ([123])\s+(.+)$') {
                if (-not $pins.ContainsKey($Matches[3])) { $pins[$Matches[3]] = @{} }
                if ($Matches[2] -eq '2') { $pins[$Matches[3]].ours = $Matches[1] }
                if ($Matches[2] -eq '3') { $pins[$Matches[3]].theirs = $Matches[1] }
            }
            else {
                $p = ($line -split "`t")[-1]
                if ($files -notcontains $p) { $files += $p }
            }
        }

        $ok = $true
        foreach ($path in $pins.Keys) {
            $e = $pins[$path]
            if (-not ($e.ours -and $e.theirs)) {
                Write-Host "  pin     $path : one side deleted the submodule - not arbitrable, escalate"
                $ok = $false
                continue
            }
            if (-not (Resolve-Gitlink -Path $path -Ours $e.ours -Theirs $e.theirs -Persona $branch)) { $ok = $false }
        }

        if ($files.Count -gt 0 -or -not $ok) {
            foreach ($f in $files) { Write-Host "  file    $f : content conflict - escalate" }
            git merge --abort
            git submodule update --init --recursive
            throw "merge of $up left unresolved conflicts - escalate to a human (impediments-log), do not resolve by hand"
        }

        git commit --no-edit --quiet
        Write-Host "merge   $up - done (gitlink arbitration applied)"
    }

    git submodule sync --recursive --quiet
    git submodule update --init --recursive

    # detached submodule checkouts are fine — the only loss condition is
    # commits on a detached HEAD that are not on any upstream branch
    $subPaths = git config --file .gitmodules --get-regexp 'path$' |
        ForEach-Object { (($_ -split '\s+', 2)[1]).Trim() }
    foreach ($p in $subPaths) {
        $sdir = Join-Path $repo ($p -replace '/', '\')
        if (-not (Test-Path (Join-Path $sdir '.git'))) { continue }
        git -C $sdir symbolic-ref -q --short HEAD | Out-Null
        if ($LASTEXITCODE -ne 0) {
            $remote = git -C $sdir branch -r --contains HEAD
            if (-not $remote) {
                $h = (git -C $sdir rev-parse --short HEAD).Trim()
                Write-Host "warn    $p : detached at $h, not on any upstream branch - push it or lose it"
            }
        }
    }

    git status --short --branch | Select-Object -First 3
    Write-Host "done    $branch synced ($($Upstream -join ', '))"
}
finally { Pop-Location }
