# WeChatAgent 后台语音条适配

为使用 DSH 的 WeChatAgent 环境增加微信原生语音条发送能力。正常发送不要求微信在前台，不通过模拟按键录音，也不发送 MP3 附件卡片。

**上游项目：[sourcepro5/WeChatAgent](https://github.com/sourcepro5/WeChatAgent)。本仓库是独立的后台语音条适配项目，不是 WeChatAgent 的 fork、开发分支或官方发行版。** 微信连接、DSH 会话、文字聊天、读取及权限管理继续由上游承担。本项目只提供语音条发送覆盖层、TTS 与 SILK 转换桥、构建安装及检查脚本。

## 工作方式

```text
DSH 回复 → WeChatAgent 消息缓冲 → 按会话和触发规则选择
  → 普通 TTS 或自己的音频 → Tencent SILK
  → /SendVoiceMsg → 微信原生语音工厂 → 后台语音条
```

本实现会在原有文字回复后追加语音条，不隐藏 DSH 文字回复。正常语音发送不抢前台或输入焦点；安装、微信重启和登录仍可能需要用户操作。

## 适用条件

- Windows 10/11 x64，**微信固定为 4.1.10.27**。
- 已通过 WeChatAgent 和 DSH 跑通微信文字收发；参考验证宿主版本为 WeChatAgent 0.4.1。
- Node.js、Python、FFmpeg 和 ffprobe 可从命令行调用。
- 公开版不分发第三方集成 Hook DLL，需要匹配源码和 MSVC v143 C++ 构建工具进行本机构建。
- 本包是宿主适配扩展，不是可拖入 WeChatAgent“能力目录”的 API v2 ZIP，也不是通用于所有 DSH 的独立语音插件。

## 本机构建与安装

解压 Release 适配包到固定位置，从托盘完整退出机器人微信。先在 WeChatAgent 工作区 `components/WeChat-Hook` 准备自己有权使用的匹配 Hook 源码：

```text
来源：https://github.com/aixed/WeChat-Hook
提交：e905d07ade50d2c6472e4eb3bd4f3fe19cf662c6
```

构建脚本检查提交或 UPSTREAM.json，不要覆盖已有目录或直接使用当前最新版。安装 Visual Studio C++ Build Tools（MSVC v143 与 Windows SDK）后运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\构建语音组件.ps1 -AgentRoot "D:\你的WeChatAgent\data\workspace"
powershell -NoProfile -ExecutionPolicy Bypass -File .\安装.ps1 -AgentRoot "D:\你的WeChatAgent\data\workspace"
```

构建步骤会备份并更新工作区的原生覆盖层与编译入口，在独立 state 子目录构建，输出到本包 `native/version.dll` 和 `native/build.json`。安装步骤再备份并部署组件。从 WeChatAgent 重新打开机器人微信并登录，启动原文字聊天桥，再双击 `检查.cmd` 和 `开桥.cmd`。

配置页为 `http://127.0.0.1:8098/`，模板会话列表为空，需明确添加会话。默认触发词为“说一句”“想听你说”。完整步骤、验收与故障排查见 **[部署方案](先读我.md)**；原理、偏移及 HTTP 接口见 **[技术说明](技术原理与接口.md)**。

## 下载与依赖

在 [Releases](https://github.com/chenxinmengY/wechatagent-background-voice-adapter/releases) 下载适配源码包。Release 附件额外带 Python 3.9 Windows x64 wheels 和 DSH 桥接插件参考副本的 npm 依赖；Git 源码通过 requirements 和 package-lock 声明依赖。该 DSH 插件参考副本依赖 WeChatAgent 宿主，不应直接覆盖已有插件或原样导入已脱敏的 cordis.patch.yml。

微信、DSH、WeChatAgent 安装器、Python、Node、FFmpeg 和第三方 Hook 完整源码由使用者独立准备。单独安装 DSH 不具备这套微信发送能力。

## 验证范围

原机器曾通过真实微信账号验证后台原生语音条、手机播放、文件传输助手测试与 DSH 实际会话触发。公开适配包检查脚本语法、依赖离线安装、程序生成测试音的 SILK 编码回解，以及个人数据和声线资源排除情况。

公开版构建入口已在隔离工作区使用匹配源码编译通过，另一台电脑完整部署仍需接收者验收。`accepted` 只表示本地提交，需结合新消息 type=34、服务端 ID 和手机播放判断结果。发送结果未知时不自动重发，只有确认未分发的 429 有限退避。部分原生异步分配采用保留策略，长期内存增长尚未量化。

维护宿主后应重新检查实际加载的 DLL、版本和 `nativeVoiceSend`；不要只看磁盘文件。适配不宣称兼容所有 WeChatAgent 安装包或新版微信。

## 音色边界

本项目不分发小鲸鱼音色、参考录音、模型、个人声线配置或声音服务，也不会自动下载这些资源。默认只用普通 Edge TTS 验证发送通道。

用户指定的声线来源仅作说明：[Esmerubphire/astrbot_plugin_feiyu_voice](https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice)。需要专用声音的人自行阅读原项目并独立配置，其声音资源不随本项目发布。

## 来源与许可

WeChatAgent 上游版权与 MIT 许可保留于 [LICENSE](LICENSE)，组件通知见 [licenses](licenses)。底层 Hook 来源为 [aixed/WeChat-Hook](https://github.com/aixed/WeChat-Hook)，完整源码与集成 DLL 不随公开包分发。原验证构建清单见 [native/reference-build.json](native/reference-build.json)，仅用于追溯。

本仓库署名和许可不额外授予第三方软件、平台、声音素材或模型的权利。本项目不隶属于腾讯、DeepSeek 或上游 WeChatAgent 维护者。
