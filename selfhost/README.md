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
│   ├── download.js    # Vercel serverless 函数（与 server.js 同逻辑，加 captcha/session 门）
│   └── bin/yt-dlp     # Linux/amd64 版 yt-dlp 二进制（已入库，Git 部署依赖它）
├── public/
│   └── index.html     # 在线网页版前端（单文件，同源调用 /api，3×3 图片验证码）
├── lib/
│   ├── ytdlp.js       # yt-dlp 子进程执行器（90s 超时，EXTRACTOR_ARGS 调参表）
│   ├── webgate.js     # 图片验证码 + 会话（captcha/session，从 CF 版移植的独立实现）
│   └── mappers.js     # 每平台 yt-dlp→CLI 契约 JSON 的映射器
├── scripts/
│   └── fetch-ytdlp.cjs# 刷新 api/bin/yt-dlp 到最新版本（或指定版本）
├── cloudflare/        # Cloudflare Containers 部署套件（需 Workers Paid + Docker）
├── vendor/            # 参考项目浅克隆（cobalt / f2 / yt-dlp 源码，gitignore）
├── vercel.json        # /api/:platform → /api/download rewrite + 超时/内存/打包
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

### 方式 A：Git 自动部署（推荐，推送即上线）

Vercel 后台把这个仓库接进来后，每次 `git push` 都会自动部署。关键配置：

| 设置项 | 值 | 为什么 |
|---|---|---|
| Root Directory | `selfhost` | `vercel.json` / `api/` / `public/` 都在这一层 |
| Production Branch | `main` | 推送主线即生产 |
| Framework Preset | Other | 纯函数项目 |
| Environment Variables | `YTDLP_COOKIES_B64`（可选）<br>`CAPTCHA_SECRET`（可选，见下）<br>`PRENIV_API_TOKEN`（可选，见下） | Bot 盾视频/抖音/小红书需要 cookies；网页版需要验证码密钥；加密 API 需要共享密钥 |

> **`api/bin/yt-dlp` 必须入库。** 它已在仓库里（38 MB，linux/amd64）。Git 构建
> 遵守 `.gitignore`，若不入库，部署产物会缺少引擎、API 全部报错。`vercel.json`
> 用 `includeFiles: api/bin/**` 显式声明它随函数打包。
>
> 刷新到更新的 yt-dlp：`node scripts/fetch-ytdlp.cjs`（或
> `node scripts/fetch-ytdlp.cjs 2026.08.19` 指定版本），然后提交。

### 方式 B：本地 CLI 部署（手动）

```powershell
cd selfhost
vercel login
vercel --prod
```

CLI 上传的是本地工作目录（遵守 `.vercelignore`，其中 `api/bin/` 明确保留），
所以本地 `api/bin/yt-dlp` 会一起上传。**注意：这种方式不会随 `git push` 更新**——
改了代码必须重新跑 `vercel --prod`。

部署后即用：`PRENIV_API_BASE=https://<your-project>.vercel.app node ..\index.js <platform> <url>`。

### 在线网页版（同步部署）

`public/index.html` 是完整的单文件前端（原 Cloudflare Pages 版已并入本 Vercel
项目并退役），与 API 同源，无需单独部署：

- 打开 `https://<your-project>.vercel.app` 即用；`?api=` 查询参数可把请求指向
  其它后端（本地联调：`http://127.0.0.1:8787/?api=http://127.0.0.1:8787/api`）。
- 首次解析先弹 3×3 图片验证码，验证通过后签发 30 分钟会话（localStorage
  `prenivdl_session_v1`），后续请求带 `x-session` 头；401 时自动重验证码。
- 验证码与会话由 `lib/webgate.js` 实现（Node webcrypto，零依赖，与旧 CF 版逻辑
  一致）。**需要设置 `CAPTCHA_SECRET`**（任意随机串，`openssl rand -hex 32`），
  否则 `/api/captcha` 返回 503、网页版退回纯 API 直连。设置 `PRENIV_API_TOKEN`
  后 cookie/CLI 通道不变（`x-api-token` 直接放行），未设置则仅验证码会话可用。

> **直链缓存**：通过验证码会话的响应一律 `no-store`（防止 CDN 缓存绕过验证码）；
> `x-api-token`（CLI）的响应缓存 `s-maxage=120`。两者互不影响。

## 支持矩阵（本仓库 yt-dlp 2026.08.19 实测）

| 平台 | 状态 | 引擎 |
|---|---|---|
| youtube | ⚠️ 视网络 | 见下方「YouTube 风控」一节 |
| tiktok / instagram / facebook / twitter(X) / weibo / bluesky / pinterest | ✅ 已验证 | yt-dlp 官方提取器 |
| douyin | ⚠️ 需 cookies | 数据中心 IP 被风控（见下方 cookies 一节） |
| rednote（小红书） | ⚠️ 视网络 | 官方提取器存在，但数据中心 IP 常被验证墙挡在提取器之前 |
| threads / kuaishou / capcut | ❌ 此版本无提取器 | yt-dlp 主线不含；诚实报错 |
| spotify / applemusic | ❌ | DRM，诚实返回 unsupported（上游也一样） |

> **YouTube 风控（重要，如实说明）**：YouTube 会对**数据中心 IP**（Vercel/CF 等
> 云厂商）主动风控，返回 "Sign in to confirm you're not a bot"。症状是提取结果
> 只有 HLS 音频格式（或全部被滤掉），云端提示「未能提取可下载的直链」。已实测
> 9 种 player client、登录态 cookies 均无法绕开 —— 这是 YouTube 对云 IP 的
> 硬性拦截，**代码无法修复**。住宅/家庭宽带 IP（含本机自建）不受影响，实测同
> 版本可拿 27–29 个 progressive 格式。若云端对某视频返回此错误，请改用本地
> `server.js`。

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

`lib/ytdlp.js` 的 `EXTRACTOR_ARGS` 是每平台 `--extractor-args` 调参表（目前只有
youtube 的多 player_client 尝试：`web,android,ios,default`，对本机住宅 IP 有实益，
对云端数据中心 IP 无济于事）。抖音/小红书等数据中心 IP 被风控时，需要
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

没有 cookies 时 douyin/rednote 会返回干净的 JSON 错误而不是挂住；数据中心 IP 的
YouTube Bot 盾返回明确受限提示（cookies 无法绕开，见支持矩阵一节）。其余平台
调参在 `EXTRACTOR_ARGS` 加。

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

# 网页版全链 e2e（captcha → verify → session → youtube；默认打线上，可用 BASE 覆盖）
# 注意：走代理环境时脚本自动用 node --use-env-proxy 重跑自己
$env:BASE = "https://prenivdl-sage.vercel.app"   # 或本地 http://127.0.0.1:8787
node scripts/e2e-online.cjs
```