# aifanyi 便携版 — 使用说明

AI 翻译工具:上传**视频或音频** → 语音识别 → AI 翻译 → 生成字幕 SRT / 译文 TXT / 烧录字幕。
本包**零依赖**:不需要安装 Java / Docker / MySQL / Node,解压即用。

## 快速开始

1. 双击 `start.bat`(首次启动约 20 秒),浏览器会自动打开 `http://localhost:8080`
2. 用演示账号登录:`demo / demo123`(也可以注册自己的账号)
3. 首次登录会弹出**配置向导**,跟着填两把钥匙即可;详细图文点页面右上角「教程」
   - **Groq API Key**(语音识别用,免费注册:https://console.groq.com)
   - **LLM Base URL / API Key / 模型**(翻译用,任何 OpenAI 兼容接口,推荐 DeepSeek:https://api.deepseek.com)
4. 回到首页 →「普通 AI 翻译」→ 上传视频/音频 → 等待完成 → 下载 SRT / 译文 TXT / 烧录视频
5. 用完双击 `stop.bat` 关闭

## 目录说明

| 目录/文件 | 作用 |
|---|---|
| `start.bat` / `stop.bat` | 一键启动 / 停止(可带端口参数,如 `start.bat 9090`) |
| `data\` | 你的所有数据:数据库、任务视频、字幕(备份/搬家拷这个目录即可) |
| `data\backend-8080.log` | 后端日志(按端口命名),出问题先看这里 |
| `app\` `runtime\` `bin\` | 程序本体、内置 Java 运行时、内置 FFmpeg,勿动 |
| `setup-ai-service.bat` | (可选)安装本地 Whisper 语音识别,见下 |

## 本地 Whisper 离线识别(完整版开箱即用)

**完整版安装包已内置全部运行时和模型**——翻译时「语音识别」直接选"本地 Whisper"任意档位即可,识别服务自动启动,模型本地加载,全程无需联网、无需安装任何东西。有 NVIDIA 显卡自动 GPU 加速,没有则自动用 CPU。

> 精简版(不含 ai-service\python 和 models 的小包)才需要:装 Python 3.10~3.12 → 双击 `setup-ai-service.bat`;或直接改用 Groq 云端识别。

> 没装本地组件时一切功能可用,只是时间轴对齐会降级(字幕起止精度略降)。

## 常见问题

- **端口被占**:`start.bat 9090` 换端口(浏览器地址也换成 :9090)
- **上传大视频**:没有大小限制,受磁盘空间约束;任务文件在 `data\tasks\`
- **数据搬家**:整个文件夹(或仅 `data\`)拷到新电脑,再 `start.bat` 即可
- **安全提示**:服务只监听本机(localhost),密钥保存在本机 `data\` 的数据库里,不要把 `data\` 发给别人
