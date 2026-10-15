# Update a repository's managed files from +wit/common/templates/common/.
#
# Managed set (copied verbatim, overwrite allowed):
#   .github/workflows/, scripts/, .gitattributes
# Everything else in the template (README, AGENTS.md, .gitignore, +intent,
# +team, .vscode, .obsidian) is repo-specific and is NOT touched.
#
# Usage (inside the target repo, on your persona branch):
#   scripts\update-from-templates.ps1            # report diffs, copy files, stage
#   scripts\update-from-templates.ps1 -Commit    # also commit + push persona branch
param([switch]$Commit)

$ErrorActionPreference = 'Stop'
$repo = git rev-parse --show-toplevel
Push-Location $repo
try {
    $tpl = Join-Path $repo '+wit/common/templates/common'
    if (-not (Test-Path $tpl)) { throw "template tree not found at $tpl - is +wit checked out?" }

    $targets = @('.github/workflows', 'scripts', '.gitattributes')
    $changed = @()
    foreach ($t in $targets) {
        $src = Join-Path $tpl $t
        $dst = Join-Path $repo $t
        if (-not (Test-Path $src)) { continue }
        if (Test-Path $dst -PathType Leaf) { $dst = Split-Path $dst }
        New-Item -ItemType Directory -Force -Path $dst | Out-Null
        Copy-Item (Join-Path $src '*') $dst -Recurse -Force
        $changed += $t
    }
    git add -A
    $pending = git status --porcelain
    if ($pending) {
        Write-Output "updated managed files: $($changed -join ', ')"
        Write-Output ($pending | Out-String)
        if ($Commit) {
            git commit -q -m "managed files: update from +wit/common/templates/common (update-from-templates)"
            git push -q origin HEAD
            Write-Output "committed and pushed"
        } else {
            Write-Output "staged - commit or run with -Commit"
        }
    } else {
        Write-Output "already up to date"
    }
} finally { Pop-Location }
