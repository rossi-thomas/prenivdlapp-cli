# PRENIVDL Online — Cloudflare 前端

公网在线下载页：**Cloudflare Pages 静态前端 + Pages Functions 代理**。

```
浏览器 ──▶ Cloudflare Pages (public/)
             └─ functions/api/[[path]].js（图片验证码会话校验 → 带 token 转发）
                      └─▶ Vercel (prenivdl-sage.vercel.app)
                            └─ yt-dlp 提取直链（无 cookies）
```

## 安全模型（鼠标点选图片验证码，无需密码）

- `PRENIV_API_TOKEN`（Vercel 后端所需的 48 位 hex）**只存在于 Cloudflare secret**，
  浏览器永远拿不到；页面只与同源 `/api/*` 通信。
- 访客闸门 = **鼠标点选图片验证码**（Click-CAPTCHA），全程鼠标操作、不输入任何内容：
  - `GET /api/captcha` → 返回一张 3×3 网格 SVG 图（8 种几何图标：圆/方/三角/
    星/心/菱形/十字/月牙），题目为「请点击图中所有 **X** 图标」，目标图标出现 2–4 次；
    同时返回 `nonce/expires/targetSig/cells[9]/img`（有效期 3 分钟）。
  - 每个格子带 `sig = HMAC(CAPTCHA_SECRET, grid.<nonce>.<id>.<类别>.<过期时间>)`
    （32 hex）。**类别明文永不下发**——格子内容只能靠人眼在图里识别。
  - 目标类别本身也由 `targetSig = HMAC(..., cap.<nonce>.<目标>.<过期>)` 锁定，
    校验时先解出目标、再逐格重算类别，要求点选的格子**恰好等于**全部目标格子
    （不多不少、无重复）；伪造的格子签名（非服务端签发）一律拒绝。
  - `POST /api/captcha/verify` → 选对则发放 **30 分钟短时会话 token**。
  - 之后每个 `/api/*` 请求带 `x-session` 头；验签通过才转发，否则 401。
- 全程无状态：所有答案信息都编码在 HMAC 签名里，校验 = 重算 HMAC + 常数时间比较，
  无需 KV/Durable Objects。
- 未配置 `CAPTCHA_SECRET`：验证码接口返回 503、API 完全开放（仅限本地开发，
  生产必须配置）。

## 已知限制（重要）

云端后端是**无 cookies** 环境（cookies 不上云，且账号 cookie 与云端 IP 不匹配
时 YouTube 会拒绝）。实测结果：

- **YouTube：绝大多数拿不到直链**（`downloads` 为空）——前端会明确提示。
- TikTok 等平台受 IP 风控，时好时坏。
- 完整能力（本机双小号 cookies）只在**本机 CLI / 桌面版**。

前端对所有「解析成功但无可下载直链」的情况都会给出友好提示。

## 目录

```
public/index.html           下载页（单文件，内联 CSS/JS，无构建步骤）
functions/api/[[path]].js   Pages Function（验证码生成/校验 + 会话闸门 + 代理）
wrangler.toml               Pages 构建配置（pages_build_output_dir = "public"）
.dev.vars.example           本地调试环境变量模板（已 gitignore .dev.vars）
```

## 本地开发

1. `cd cf-frontend`
2. `Copy-Item .dev.vars.example .dev.vars`，填入 `PRENIV_API_TOKEN`（仓库 `.env`
   里的值）、`CAPTCHA_SECRET`（任意 64 位 hex，本地生成一个即可）。
3. `npx wrangler pages dev public` → 打开 http://localhost:8788
   - 联调本地带 cookies 的后端：在 `.dev.vars` 里加
     `PRENIV_API_BASE=http://127.0.0.1:8787`（先起 `node selfhost/server.js`）。
   - 本机若配了系统代理且转发被挂住：启动前先
     `$env:HTTP_PROXY=''; $env:HTTPS_PROXY=''; $env:NO_PROXY='*'`。
   - 只想单独看页面 UI（不经 wrangler）：任意静态服务器托 `public/`，
     访问 `http://host:port/?api=http://127.0.0.1:8788/api`（页面支持 `?api=` 联调钩子，
     缺省走同源 `/api`，生产行为不变）。

## 部署

前置：**Vercel 侧先部署带 token 闸门的版本**（未做的话 `prenivdl-sage.vercel.app`
目前仍是无闸门的旧版）：

```bash
# 在仓库根目录（selfhost/ 所在处）
cd selfhost
vercel env add PRENIV_API_TOKEN production   # 值见仓库 .env
vercel --prod
```

然后部署 Cloudflare：

```bash
npx wrangler login
cd cf-frontend

# 首次：创建项目（之后可省略）
npx wrangler pages project create prenivdl-online --production-branch main

# 配置两个 secret（CAPTCHA_SECRET 生成：PowerShell 里
# -join (1..32 | %{ '{0:x2}' -f (Get-Random -Maximum 256) })）
npx wrangler pages secret put PRENIV_API_TOKEN --project-name prenivdl-online
npx wrangler pages secret put CAPTCHA_SECRET --project-name prenivdl-online

# 发布
npx wrangler pages deploy public
```

完成后访问 `https://prenivdl-online.pages.dev`。

后续更新：再次 `npx wrangler pages deploy public` 即可；也可以在
Cloudflare Dashboard 里绑定 GitHub 仓库自动部署。自定义域名：Dashboard →
Pages → 项目 → Custom domains 添加。

## 修改 secret

```bash
npx wrangler pages secret put CAPTCHA_SECRET --project-name prenivdl-online --force
```