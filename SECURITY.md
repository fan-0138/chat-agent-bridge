# 安全策略

## 报告问题

发现安全问题时**不要开公开 issue**，请私下联系作者（仓库主页的联系方式，或 GitHub Security Advisory）。

## 这个项目会存哪些敏感东西

| 位置 | 内容 | 说明 |
|---|---|---|
| `.env` / `.env.qq` | API key、OneBot token、允许联系的 QQ 号 | 已在 `.gitignore` 里，**永远别提交** |
| `data/*/account.json` | 微信 iLink 的登录态（含 botToken） | 等同账号凭证 |
| `data/douyin-profile/` | 抖音浏览器登录 cookie | 等同账号凭证 |
| `data/*/memory/*.jsonl` | 你和她的全部聊天记录 | 含隐私 |
| `logs/` | 运行日志，可能带聊天内容片段 | 含隐私 |

建议：`chmod 700 data logs`，并且**只在本人机器上跑**。

## 贡献代码时

- 提交前跑 `npm test`（有单测覆盖主要逻辑）。
- 不要提交任何真实账号、token、cookie、聊天记录、截图。
- 不要把「绕过风控」「批量操作」这类功能做成 PR —— 会被直接拒绝并可能被举报。