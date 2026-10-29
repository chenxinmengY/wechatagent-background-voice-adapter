$ErrorActionPreference='Stop'
$cfgFile=Join-Path $PSScriptRoot 'voice-bridge\config.json'
if (-not (Test-Path -LiteralPath $cfgFile)) { throw '请先执行 安装.ps1 -AgentRoot 你的工作区路径。' }
$cfg=Get-Content -Raw -LiteralPath $cfgFile -Encoding UTF8 | ConvertFrom-Json
Get-Command node.exe,ffmpeg.exe,ffprobe.exe -ErrorAction Stop | Out-Null
& $cfg.tts.python -c 'import pilk, edge_tts'
if ($LASTEXITCODE) { throw 'Python 依赖检查失败。' }
$root=$cfg.wechatagentRoot
$agent=Get-Content -Raw -LiteralPath (Join-Path $root 'config\wechatagent.json') -Encoding UTF8 | ConvertFrom-Json
$base=([Uri]$agent.hook.baseUrl)
if (-not $base.IsLoopback -or $base.Scheme -ne 'http') { throw '仅允许本机 HTTP Hook 地址。' }
$token=(Get-Content -Raw -LiteralPath (Join-Path $root 'state\hook\native-token.txt')).Trim()
$health=Invoke-RestMethod ($base.AbsoluteUri.TrimEnd('/')+'/WeChatAgent/health') -Headers @{Authorization='Bearer '+$token} -TimeoutSec 8
if ($health.version -ne '4.1.10.27') { throw '微信版本不匹配。' }
if (-not $health.nativeVoiceSend) { throw '微信加载的组件没有语音接口。请停止机器人微信后重新执行安装，再登录；不要升级微信。' }
if (@($health.databaseAccounts | Where-Object {$_}).Count -ne 1) { throw '请先登录且仅登录一个机器人微信账号。' }
if (-not (Test-Path -LiteralPath (Join-Path $root 'state\social-messages.json'))) { throw '缺少 WeChatAgent 消息缓冲；请先跑通 DSH 文字聊天。' }
Write-Host ('检查通过：微信 '+$health.version+'，语音接口已加载，账号就绪。')
Write-Host '此检查没有发送消息，不能证明实际送达。'
