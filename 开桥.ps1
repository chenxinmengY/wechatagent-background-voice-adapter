$ErrorActionPreference='Stop'
$mutex=[Threading.Mutex]::new($false,'Local\DSHVoiceExchangeRestart')
if (-not $mutex.WaitOne(0)) { Write-Host '正在开桥，请稍等。'; exit 2 }
try {
    & (Join-Path $PSScriptRoot '检查.ps1')
    $voice=Join-Path $PSScriptRoot 'voice-bridge'
    New-Item -ItemType Directory -Path (Join-Path $voice 'state') -Force | Out-Null
    $pidFile=Join-Path $voice 'state\bridge.pid'
    if (Test-Path -LiteralPath $pidFile) {
        $oldId=0
        if ([int]::TryParse((Get-Content -Raw -LiteralPath $pidFile).Trim(),[ref]$oldId) -and $oldId -gt 0) {
            $old=Get-CimInstance Win32_Process -Filter "ProcessId=$oldId" -ErrorAction SilentlyContinue
            if ($old) {
                if ($old.Name -ne 'node.exe' -or -not $old.CommandLine.Contains((Join-Path $voice 'voice_bridge.mjs'))) { throw 'PID 文件指向其他进程，拒绝停止。' }
                Stop-Process -Id $oldId -Force
                Wait-Process -Id $oldId -Timeout 10 -ErrorAction SilentlyContinue
            }
        }
    }
    $node=(Get-Command node.exe).Source
    $process=Start-Process -FilePath $node -ArgumentList ('"'+(Join-Path $voice 'voice_bridge.mjs')+'"') -WorkingDirectory $voice -WindowStyle Hidden -RedirectStandardOutput (Join-Path $voice 'state\startup.stdout.log') -RedirectStandardError (Join-Path $voice 'state\startup.stderr.log') -PassThru
    Start-Sleep -Seconds 3
    if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { throw ('语音桥退出，请看 '+(Join-Path $voice 'state\startup.stderr.log')) }
    if ([int](Get-Content -Raw -LiteralPath $pidFile) -ne $process.Id) { throw '语音桥未取得进程锁。' }
    $listeners=@(Get-NetTCPConnection -LocalPort 8098 -State Listen -ErrorAction SilentlyContinue)
    if (-not $listeners.Count) {
        Start-Process -FilePath $node -ArgumentList ('"'+(Join-Path $voice 'config-ui.mjs')+'"') -WorkingDirectory $voice -WindowStyle Hidden | Out-Null
        Start-Sleep -Seconds 1
    } else {
        foreach ($id in @($listeners.OwningProcess | Select-Object -Unique)) {
            $owner=Get-CimInstance Win32_Process -Filter "ProcessId=$id"
            if ($owner.Name -ne 'node.exe' -or -not $owner.CommandLine.Contains((Join-Path $voice 'config-ui.mjs'))) { throw '8098 被其他配置页占用，请关闭另一份语音配置页后重试。' }
        }
    }
    $page=Invoke-WebRequest 'http://127.0.0.1:8098/' -UseBasicParsing -TimeoutSec 5
    if ($page.StatusCode -ne 200) { throw '配置页启动失败。' }
    Write-Host '语音桥已启动或重启。配置：http://127.0.0.1:8098/；首次使用请添加会话。'
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
