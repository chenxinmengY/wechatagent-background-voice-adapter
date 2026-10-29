$ErrorActionPreference='Stop'
$voice=Join-Path $PSScriptRoot 'voice-bridge'
$pidFile=Join-Path $voice 'state\bridge.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host '本包语音桥未运行。'; exit 0 }
$bridgeId=0
if (-not [int]::TryParse((Get-Content -Raw -LiteralPath $pidFile).Trim(),[ref]$bridgeId) -or $bridgeId -le 0) { throw '无效 PID 文件。' }
$process=Get-CimInstance Win32_Process -Filter "ProcessId=$bridgeId" -ErrorAction SilentlyContinue
if ($process) {
    if ($process.Name -ne 'node.exe' -or -not $process.CommandLine.Contains((Join-Path $voice 'voice_bridge.mjs'))) { throw 'PID 不属于本包语音桥，拒绝结束。' }
    Stop-Process -Id $bridgeId -Force
}
Remove-Item -LiteralPath $pidFile -Force
Write-Host '本包语音桥已停止，配置页保留。'
