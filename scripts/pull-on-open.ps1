# Runs pull-on-open.sh in Git Bash - invoked by the pull-on-open VS Code task
# on Windows. The plain `bash` command resolves to the WSL launcher at
# $env:WINDIR\System32\bash.exe (System32 precedes user PATH), which exits 1
# when no WSL distribution is installed, so a real Git Bash is located here.
$bash = (Get-Command bash.exe -All -ErrorAction SilentlyContinue |
    Where-Object { $_.Source -notlike "$env:WINDIR\*" } |
    Select-Object -First 1).Source
if (-not $bash) {
    $candidates = @(
        "$env:ProgramFiles\Git\bin\bash.exe",
        "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
        "$env:LocalAppData\Programs\Git\bin\bash.exe",
        "$env:USERPROFILE\scoop\shims\bash.exe",
        "$env:USERPROFILE\scoop\apps\git\current\usr\bin\bash.exe"
    )
    $bash = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $bash) {
    Write-Error "Git Bash not found - install Git for Windows or add it to PATH."
    exit 1
}
& $bash "$PSScriptRoot\pull-on-open.sh"
exit $LASTEXITCODE
