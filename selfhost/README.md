# PRENIVDL 自建后端（self-hosted download API）

把 PRENIVDL CLI 依赖的所有下载 API 自建化 —— 引擎是开源的 **yt-dlp**，不再依赖
上游不稳定的 `prenivapi.vercel.app`。后端只返回**直链**，媒体字节由 CLI 自己下载
（服务器从不代理数据流），所以 Vercel 的 60s 超时只覆盖提取阶段。

```
CLI (axios) ──> selfhost API  /api/<platform>?url=...
                    │
                    └── yt-dlp 提取（本地二进制 / 打包进 Vercel 函数的 Linux 二进制）
                         │
                         └── 按 routes/*.js 的契约映射 JSON 直链返回
```

## 目录结构

```
selfhost/
├── server.js          # 本地零依赖 http 服务（端口 8787，PORT 可改）
├── app.js             # 共享 handler：URL 解析 / 平台别名 / rednote&pinterest 契约
├── api/
│   ├── download.js    # Vercel serverless 函数（与 server.js 完全同逻辑）
│   └── bin/yt-dlp     # Linux 版 yt-dlp 二进制（部署时放入，gitignore）
├── lib/
│   ├── ytdlp.js       # yt-dlp 子进程执行器（90s 超时，EXTRACTOR_ARGS 调参表）
│   └── mappers.js     # 每平台 yt-dlp→CLI 契约 JSON 的映射器
├── vendor/            # 参考项目浅克隆（cobalt / f2 / yt-dlp 源码，gitignore）
├── vercel.json        # /api/:platform → /api/download rewrite + 超时/内存
└── package.json       # 零运行时依赖
```

## 本地运行（Windows / 有系统 yt-dlp 的机器）

```powershell
# 1. 需要系统可用的 yt-dlp（含 ffmpeg）
where.exe yt-dlp            # 或有 python -m yt_dlp

# 2. 启动
cd selfhost
node server.js              # http://127.0.0.1:8787

# 3. CLI 指向本地后端
$env:PRENIV_API_BASE = "http://127.0.0.1:8787"
node ..\index.js tw <twitter_url>     # 或直接裸贴 URL 自动识别
```

自定义 yt-dlp 二进制：`$env:YTDLP_BIN = "C:\path\to\yt-dlp.exe"`。

## 部署到 Vercel

Vercel 函数里装的是 Linux 二进制，Windows 本地那套系统 yt-dlp 不适用：

```powershell
cd selfhost

# 1. 下载 Linux yt-dlp 二进制（curl 跟随重定向）
curl.exe -L -o api/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
# （Linux/macOS 还需要 chmod +x api/bin/yt-dlp）

# 2. 登录并部署
vercel login
vercel --prod
```

部署后即用：`PRENIV_API_BASE=https://<your-project>.vercel.app node ..\index.js <platform> <url>`。

> 注意：Vercel 函数每次冷启动都是新的，包内的 `api/bin/yt-dlp` 每次都会被重新
> 写入 tmp 并挂掉 `PATH` 查找（见 `lib/ytdlp.js` 的二进制解析），所以 `api/bin/`
> 打了 gitignore —— 每次 deploy 前重新下载一遍即可（或者把它放进仓库、去掉
> gitignore，看个人权衡；放仓库=体积 ~30MB，不放=每次部署多一步）。

## 支持矩阵（本仓库 yt-dlp 2026.08.19 实测）

| 平台 | 状态 | 引擎 |
|---|---|---|
| youtube / tiktok / instagram / facebook / twitter(X) / weibo / bluesky / pinterest | ✅ 已验证 | yt-dlp 官方提取器 |
| douyin | ⚠️ 需 cookies | 数据中心 IP 被风控（见下方 cookies 一节） |
| rednote（小红书） | ⚠️ 视网络 | 官方提取器存在，但数据中心 IP 常被验证墙挡在提取器之前 |
| threads / kuaishou / capcut | ❌ 此版本无提取器 | yt-dlp 主线不含；诚实报错 |
| spotify / applemusic | ❌ | DRM，诚实返回 unsupported（上游也一样） |

> offline 注意：红色 ❌ 平台 CLI 会显示明确的 JSON 错误（不再摸到不稳定的
> 上游）。如果必须覆盖 threads/kuaishou/capcut，可以像 cobalt 那样为它们各写
> 一个专用抓取器 —— 属于后续工作，不在本期范围。

## 平台契约（CLI routes 需要的 JSON 形状，来自 routes/*.js）

- rednote：`data.status === 200`（数字 200，不是布尔）
- pinterest：`data.success === true`（不是 status）
- tiktok：v1 回退分支用 `normalizeTikTok(data, 'v1')` 形状（video/audio/image 数组）
- twitter：单条 media → CLI 自动下载；多条 → 键盘选质量
- 其余平台：`status: true` + `data`，字段见 `lib/mappers.js` 头部注释

## 直链铁律

CLI 用 axios 直接把返回 URL 下载成文件。**绝不能返回 m3u8/HLS 清单**（会把
1KB 的播放列表文本存成 .mp4）。`mappers.js` 统一过滤：progressive 直链优先，
只有 HLS 的格式直接跳过。twitter 的"无编解码声明"渐进式 mp4 靠 height 标签识别。

## 调参

`lib/ytdlp.js` 的 `EXTRACTOR_ARGS` 是每平台 `--extractor-args` 调参表（现在几乎为
空）。抖音/小红书等数据中心 IP 被风控、或 YouTube 视频被 Bot 盾保护时，需要
带有效登录 cookies，支持三种注入方式：

```powershell
# ① Vercel / serverless（推荐）：单行 base64，冷启动自动写到 /tmp
#    从浏览器导出 cookies.txt（Netscape 格式，需已登录），然后：
$env:YTDLP_COOKIES_B64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\cookies.txt"))
node server.js

# ② 本地：直接指 cookies 文件路径
$env:YTDLP_COOKIES = "C:\path\to\cookies.txt"
node server.js

# ③ 本地：把 cookies.txt 内容本身塞进环境变量（同上，自动物化到临时文件）
```

没有 cookies 时 douyin/rednote 会返回干净的 JSON 错误而不是挂住；Bot 盾视频
返回明确受限提示。其余平台调参（如 youtube player_client）在 `EXTRACTOR_ARGS` 加。

> Vercel 部署：在项目 Settings → Environment Variables 里加 `YTDLP_COOKIES_B64`
> （值 = 上面 ① 输出的 base64 字符串；用一次性小号 + 接受 Google 风控风险）。
> 每次冷启动解析一次、写 `$TMPDIR/prnv-ytdlp-cookies.txt`（用后即弃），不会
> 把 cookies 落进 git 或日志。

## 验证

```powershell
# 健康检查
Invoke-RestMethod http://127.0.0.1:8787/

# 全平台形状自查（npm test 里的 test/api.test.js 覆盖 15 个终端的 URL 拼接）
npm run check
```