# Consolidate submodules - diagnose and fix parent/submodule merge state.
#
# The parent repo's branch flow (persona -> wip -> work -> main) does not exist
# inside the +wit submodules: they only have main + persona branches, and
# persona merges to main are human-only. A parent work->main PR therefore
# conflicts on the gitlink whenever it pins a commit that is not on the
# submodule's main.
#
# Order of operations:
#   1. merge the submodule persona branch to main (GitHub PR, human)
#   2. run this script with -Bump to pin the merged main commits
#   3. integrate (scripts\integrate-wip.ps1) - the parent PR then merges clean
#
# Usage:
#   scripts\consolidate-submodules.ps1           # report only
#   scripts\consolidate-submodules.ps1 -Merge    # fast-forward submodule main to origin/<persona> (owner merge)
#   scripts\consolidate-submodules.ps1 -Bump     # pin to submodule origin/main, stage, commit
#   scripts\consolidate-submodules.ps1 -Merge -Bump  # full consolidation in one step
#
# -Merge is ff-only: it pushes origin/<persona> to main when the persona branch
# already contains main (the normal case). Anything else aborts - real merge
# decisions stay with the human on GitHub.
param([switch]$Merge, [switch]$Bump, [string]$Persona = (git branch --show-current))

$ErrorActionPreference = 'Stop'
$repo = git rev-parse --show-toplevel
Push-Location $repo
try {
    git fetch origin -q
    $subs = git config --file .gitmodules --get-regexp 'path$' | ForEach-Object { ($_ -split ' ')[1] }
    if (-not $subs) { Write-Output 'no submodules'; exit 0 }

    $dirty = $false
    foreach ($s in $subs) {
        Write-Output "`n=== $s ==="
        $pin = (git ls-tree HEAD $s) -split '\s+' | Select-Object -Index 2
        $mainTip = git -C $s rev-parse origin/main
        $ahead = git -C $s rev-list --count origin/main..$pin 2>$null
        git -C $s merge-base --is-ancestor $pin origin/main
        $onMain = ($LASTEXITCODE -eq 0)
        Write-Output ("  parent pins:      {0}" -f $pin.Substring(0,7))
        Write-Output ("  submodule main:   {0}" -f $mainTip.Substring(0,7))
        Write-Output ("  commits on HEAD not in main: {0}" -f $ahead)
        if ($Merge) {
            git -C $s rev-parse --verify -q "origin/$Persona" 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) { Write-Output "  no origin/$Persona in $s - skip"; continue }
            git -C $s merge-base --is-ancestor origin/main "origin/$Persona"
            if ($LASTEXITCODE -eq 0) {
                git -C $s push -q origin "origin/$Persona`:refs/heads/main"
                Write-Output "  merged: origin/$Persona fast-forwarded to main"
                git -C $s fetch origin -q
                $mainTip = git -C $s rev-parse origin/main
                git -C $s merge-base --is-ancestor $pin origin/main
                $onMain = ($LASTEXITCODE -eq 0)
            } else {
                Write-Output "  NOT fast-forwardable - merge $Persona -> main on GitHub manually"
            }
        }
        if ($onMain) {
            Write-Output "  OK - pin is reachable from submodule main"
            if ($Bump -and $pin -ne $mainTip) {
                git -C $s checkout -q origin/main
                git add $s
                Write-Output ("  bumped pin -> {0} (staged)" -f $mainTip.Substring(0,7))
                $dirty = $true
            }
        } else {
            Write-Output "  CONFLICT - pin not on submodule main: merge persona branch to main first, then -Bump"
        }
    }
    if ($dirty) {
        git commit -q -m "submodules: pin to merged origin/main tips (consolidate-submodules)"
        Write-Output "`ncommit created - integrate with scripts\integrate-wip.ps1"
    } elseif ($Bump) { Write-Output "`nnothing to bump" }
} finally { Pop-Location }
