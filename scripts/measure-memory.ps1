# Private working set (the "Memory" column in Task Manager) for a process and all its descendants.
# Usage: powershell -File scripts\measure-memory.ps1 -RootPid <pid> [-Json]
param(
    [Parameter(Mandatory)][int]$RootPid,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

# Fixed queries with no user input; the PID is only compared in PowerShell, never put in a query.
$all = @(Get-CimInstance -ClassName Win32_Process)
$perf = @(Get-CimInstance -ClassName Win32_PerfFormattedData_PerfProc_Process)

if (-not ($all | Where-Object { $_.ProcessId -eq $RootPid })) {
    throw "Process $RootPid not found"
}

# Walk the parent links down from the root. This script's own process is left out.
$treeIds = [System.Collections.Generic.HashSet[uint32]]::new()
$null = $treeIds.Add([uint32]$RootPid)
$added = $true
while ($added) {
    $added = $false
    foreach ($p in $all) {
        if ($p.ProcessId -ne $PID -and $treeIds.Contains($p.ParentProcessId) -and $treeIds.Add($p.ProcessId)) {
            $added = $true
        }
    }
}

$privateById = @{}
foreach ($row in $perf) { $privateById[[int]$row.IDProcess] = [uint64]$row.WorkingSetPrivate }

$rows = @(foreach ($p in $all) {
    if ($treeIds.Contains($p.ProcessId) -and $privateById.ContainsKey([int]$p.ProcessId)) {
        [pscustomobject]@{
            pid = [int]$p.ProcessId
            name = $p.Name
            privateWorkingSetKB = [int][math]::Round($privateById[[int]$p.ProcessId] / 1KB)
        }
    }
})
$totalKB = [int]($rows | Measure-Object -Property privateWorkingSetKB -Sum).Sum

if ($Json) {
    [pscustomobject]@{ totalKB = $totalKB; processes = $rows } | ConvertTo-Json -Depth 3 -Compress
} else {
    $rows | Sort-Object privateWorkingSetKB -Descending |
        Format-Table pid, name, @{ n = 'privateMB'; e = { '{0:N1}' -f ($_.privateWorkingSetKB / 1KB) } } -AutoSize
    'Total private working set: {0:N1} MB across {1} processes' -f ($totalKB / 1KB), $rows.Count
}
