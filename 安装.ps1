param([Parameter(Mandatory=$true)][string]$AgentRoot)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($AgentRoot)
$package=$PSScriptRoot
$voice=Join-Path $package 'voice-bridge'
if (-not (Test-Path -LiteralPath (Join-Path $root 'config\wechatagent.json'))) { throw '请选择 WeChatAgent 的 data\workspace 目录，而非 app 目录。' }
$config=Get-Content -Raw -LiteralPath (Join-Path $root 'config\wechatagent.json') -Encoding UTF8 | ConvertFrom-Json
if ($config.hook.expectedVersion -ne '4.1.10.27') { throw '仅支持微信 4.1.10.27。' }
$exe=if ([IO.Path]::IsPathRooted($config.hook.wechatExecutable)) { $config.hook.wechatExecutable } else { Join-Path $root $config.hook.wechatExecutable }
$expectedExe=Join-Path $root 'state\hook\wechat-4.1.10.27\Weixin.exe'
if ([IO.Path]::GetFullPath($exe) -ine [IO.Path]::GetFullPath($expectedExe)) { throw '微信须位于项目标准隔离目录 state\hook\wechat-4.1.10.27。' }
if ((Get-Item -LiteralPath $exe).VersionInfo.FileVersion -ne '4.1.10.27') { throw '微信程序版本不匹配。' }
if (@(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | Where-Object { $_.ExecutablePath -eq $expectedExe }).Count) { throw '请从托盘完整退出机器人微信，再运行安装；安装不强制结束微信。' }
if (-not (Test-Path -LiteralPath (Join-Path $package 'native\version.dll'))) { throw '公开版未附 DLL，请先执行 构建语音组件.ps1 -AgentRoot 同一工作区路径。' }
$build=Get-Content -Raw -LiteralPath (Join-Path $package 'native\build.json') | ConvertFrom-Json
$newHash=(Get-FileHash -LiteralPath (Join-Path $package 'native\version.dll') -Algorithm SHA256).Hash.ToLowerInvariant()
if ($newHash -ne $build.sha256 -or $build.targetVersion -ne '4.1.10.27') { throw '语音 DLL 校验失败。' }
$native=Join-Path $root 'state\hook\native'
$oldBuild=Get-Content -Raw -LiteralPath (Join-Path $native 'build.json') | ConvertFrom-Json
$installed=Join-Path (Split-Path $exe) 'version.dll'
$installedHash=(Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash.ToLowerInvariant()
$nativeHash=(Get-FileHash -LiteralPath (Join-Path $native 'version.dll') -Algorithm SHA256).Hash.ToLowerInvariant()
if ($nativeHash -ne $oldBuild.sha256 -or $oldBuild.targetVersion -ne '4.1.10.27' -or $installedHash -ne $nativeHash) { throw '当前原生组件与项目清单不一致，请先在 WeChatAgent 修复连接后重试。' }
Get-Command node.exe,python.exe,ffmpeg.exe,ffprobe.exe -ErrorAction Stop | Out-Null
$venv=Join-Path $package '.venv'
if (-not (Test-Path -LiteralPath (Join-Path $venv 'Scripts\python.exe'))) { & python -m venv $venv; if ($LASTEXITCODE) { throw '创建 Python 环境失败。' } }
$python=Join-Path $venv 'Scripts\python.exe'
& $python -m pip install -r (Join-Path $package 'requirements.txt') --find-links (Join-Path $package 'wheels')
if ($LASTEXITCODE) { throw 'Python 依赖安装失败，尚未修改微信组件。' }
$backup=Join-Path $root ('state\voice-exchange-backups\'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $native 'version.dll') -Destination (Join-Path $backup 'version.dll')
Copy-Item -LiteralPath (Join-Path $native 'build.json') -Destination (Join-Path $backup 'build.json')
Copy-Item -LiteralPath (Join-Path $root 'scripts\build-hook.ps1') -Destination (Join-Path $backup 'build-hook.ps1')
Copy-Item -LiteralPath (Join-Path $root 'scripts\native-hook') -Destination (Join-Path $backup 'native-hook') -Recurse
Copy-Item -LiteralPath (Join-Path $native 'build.json') -Destination (Join-Path $native 'build.previous.json') -Force
Copy-Item -LiteralPath (Join-Path $package 'native\version.dll') -Destination (Join-Path $native 'version.dll') -Force
Copy-Item -LiteralPath (Join-Path $package 'native\build.json') -Destination (Join-Path $native 'build.json') -Force
Copy-Item -LiteralPath (Join-Path $package 'source\build-hook.ps1') -Destination (Join-Path $root 'scripts\build-hook.ps1') -Force
Get-ChildItem -LiteralPath (Join-Path $package 'source\native-hook') -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $root 'scripts\native-hook') -Force }
try {
    & (Join-Path $root 'scripts\launch-hook-wechat.ps1') -PrepareOnly -UpdateHook
    if ($LASTEXITCODE) { throw '项目部署脚本返回失败。' }
} catch { throw ('部署未完成。保留备份于 '+$backup+'；错误：'+$_.Exception.Message) }
$cfgFile=Join-Path $voice 'config.json'
$cfg=Get-Content -Raw -LiteralPath $(if(Test-Path -LiteralPath $cfgFile){$cfgFile}else{Join-Path $voice 'config.example.json'}) -Encoding UTF8 | ConvertFrom-Json
$cfg.wechatagentRoot=$root; $cfg.tts.python=$python
$cfg | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $cfgFile -Encoding UTF8
Write-Host ('安装完成。备份：'+$backup)
Write-Host '从 WeChatAgent 打开并登录机器人微信，启动原有文字聊天桥，再运行 开桥.cmd。'
Write-Host '不要把本包 plugins 目录直接覆盖到已有 DSH 插件；正常使用 WeChatAgent 已生成的本机插件。'
