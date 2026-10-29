param([Parameter(Mandatory=$true)][string]$AgentRoot)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($AgentRoot)
if (-not (Test-Path -LiteralPath (Join-Path $root 'config\wechatagent.json'))) { throw '请选择 WeChatAgent data\workspace 工作区。' }
if (-not (Test-Path -LiteralPath (Join-Path $root 'components\WeChat-Hook\x64_Version_dll.vcxproj'))) { throw '请先独立准备匹配提交的 components\WeChat-Hook 源码，见 README。' }
$exe=Join-Path $root 'state\hook\wechat-4.1.10.27\Weixin.exe'
if (@(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | Where-Object { $_.ExecutablePath -eq $exe }).Count) { throw '请先从托盘完整退出机器人微信。' }
$backup=Join-Path $root ('state\voice-source-backups\'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'scripts\build-hook.ps1') -Destination (Join-Path $backup 'build-hook.ps1')
Copy-Item -LiteralPath (Join-Path $root 'scripts\native-hook') -Destination (Join-Path $backup 'native-hook') -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'source\build-hook.ps1') -Destination (Join-Path $root 'scripts\build-hook.ps1') -Force
Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'source\native-hook') -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $root 'scripts\native-hook') -Force }
Write-Host ('源码备份：'+$backup)
& (Join-Path $root 'scripts\build-hook.ps1') -BuildDirectory 'state\hook\voice-exchange-build-source' -OutputDirectory 'state\hook\voice-exchange-build-output'
if ($LASTEXITCODE) { throw '原生语音编译失败，未安装客户端 DLL。' }
$output=Join-Path $root 'state\hook\voice-exchange-build-output'
$manifest=Get-Content -Raw -LiteralPath (Join-Path $output 'build.json') | ConvertFrom-Json
if ($manifest.targetVersion -ne '4.1.10.27' -or (Get-FileHash -LiteralPath (Join-Path $output 'version.dll') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256) { throw '编译结果校验失败。' }
Copy-Item -LiteralPath (Join-Path $output 'version.dll') -Destination (Join-Path $PSScriptRoot 'native\version.dll') -Force
Copy-Item -LiteralPath (Join-Path $output 'build.json') -Destination (Join-Path $PSScriptRoot 'native\build.json') -Force
Write-Host '本机构建完成。下一步执行 安装.ps1 -AgentRoot 同一工作区路径。'
