# Opens every site from bench/sites.json in a fresh Brave profile, waits, and prints the private
# working set of Brave's process tree. Same method as `npm run bench:memory`, so numbers compare.
# Usage: powershell -File scripts\bench-brave.ps1 [-BravePath <brave.exe>]
param(
    [string]$BravePath
)

$ErrorActionPreference = 'Stop'

if (-not $BravePath) {
    $candidates = @(
        "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
        "${env:ProgramFiles(x86)}\BraveSoftware\Brave-Browser\Application\brave.exe",
        "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe"
    )
    $BravePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $BravePath -or -not (Test-Path $BravePath)) {
    throw 'brave.exe not found. Pass -BravePath <path to brave.exe>.'
}

$config = Get-Content (Join-Path $PSScriptRoot '..\bench\sites.json') -Raw | ConvertFrom-Json
$urls = @($config.sites | ForEach-Object { $_.url })
$profile = Join-Path ([System.IO.Path]::GetTempPath()) ('brave-bench-' + [guid]::NewGuid())
$brave = $null

try {
    $arguments = @("--user-data-dir=$profile", '--no-first-run') + $urls
    $brave = Start-Process -FilePath $BravePath -ArgumentList $arguments -PassThru
    Write-Host "Brave started (PID $($brave.Id)) with $($urls.Count) sites. Settling for $($config.settleSeconds) s..."
    Start-Sleep -Seconds $config.settleSeconds
    & (Join-Path $PSScriptRoot 'measure-memory.ps1') -RootPid $brave.Id
}
finally {
    # Close only the Brave we started (its whole process tree), then remove the throwaway profile.
    if ($brave) { taskkill /PID $brave.Id /T /F | Out-Null }
    Start-Sleep -Seconds 2
    if (Test-Path $profile) { Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue }
}
