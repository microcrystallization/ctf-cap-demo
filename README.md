# CTF Cap Demo（自部署人机验证能力测试页）

本仓库为**自主部署的人机验证能力测试环境**（极简 CTF Flag 提交靶场），集成自托管开源验证码 **[Cap](https://trycap.dev)**（HashWX PoW + 浏览器插桩），仅用于测试 Cap 的人机验证与防自动化防护能力。

## 架构

- **前端（GitHub Pages）**：根目录静态页 (`index.html` / `style.css` / `app.js`)，使用锁定版本 `cap-widget@0.1.64`。
- **后端（Cloudflare Workers + Durable Object）**：`worker/` 目录使用 `capjs-core@0.1.20`：
  - `POST /cap/challenge`：签发 HashWX + instrumentation 挑战（`scope: "ctf-flag"`）。
  - `POST /cap/redeem`：校验解题结果并通过 Durable Object SQLite 原子防重放（`consumeNonce`），签发一次性 token。
  - `POST /api/submit-flag`：先原子校验并销毁 `cap-token`（单次有效，fail-closed），再校验 Flag。

## 部署 Cloudflare Worker

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put CAP_SECRET   # 输入任意 32 字节以上随机字符串
npm run deploy
```

部署完成后，在页面底部的「后端 Worker 配置」填入你的 `https://ctf-cap-demo.<subdomain>.workers.dev` 地址（或通过 `?api=https://...` 访问），或者直接把 `app.js` 中的 `DEFAULT_API_BASE` 改为该地址后推送。

> 默认演示 Flag 为 `flag{cap_pow_verified_2026}`，可在 `worker/wrangler.toml` 中修改 `CTF_FLAG`，或在 Cloudflare Dashboard 中配置为 Secret。

## 本地运行

```bash
# 1. 启动 Worker（默认监听 127.0.0.1:8787）
cd worker && npm run dev

# 2. 另开终端在根目录启动任意静态服务器，例如：
npx serve .
```
