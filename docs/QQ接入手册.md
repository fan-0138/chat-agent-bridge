# QQ 接入（NapCat + OneBot 11）

给一个 QQ 号，让本机的 DSH agent 用它收发消息。**非官方通道**：NapCat 是社区第三方框架，
在腾讯眼里等同于「外挂软件」，用作机器人的号可能被警告、限制、临时甚至永久冻结，且申诉基本无效
（参考 [海豹手册的说明](https://docs.sealdice.com/deploy/platform-qq.html)）。所以本文的默认配置
全部按「当它一定会被封」来设计：可牺牲的小号 + 保守限流 + 熔断 + 审计。

如果你只是想在群里做问答，**官方机器人（q.qq.com）零风险**，值得先评估一次。

---

## 0. 先决条件

| 事项 | 要求 | 为什么 |
|---|---|---|
| 账号 | 单独一个小号，**不是主号**，已实名 + 绑手机 | 封号时不会连带丢好友/群/记录；裸号更像黑产号 |
| 养号 | 新号先在手机 QQ 正常用 **3–7 天**（登录、加群、聊几句、设头像昵称） | 注册当天就挂协议是最快的封法，这步没法用代码加速 |
| 机器 | 一台常开的 Mac/PC，别让它休眠 | 睡眠时连不上，醒来后重登本身就是风控特征 |
| 登录 | 手机 QQ 可以同时在线；**PC QQ 不行** | NTQQ 方案独占 PC 端协议，同时登会互相挤下线 |
| 实例 | 一个 QQ 号只跑**一个** NapCat | 多实例是明确的封号特征 |

---

## 1. 安装 NapCat（macOS）

1. 安装官方 QQ 到 `/Applications/QQ.app`（App Store 版不行，要官网 dmg）。
2. 下载 [NapCat-Mac-Installer](https://github.com/NapNeko/NapCat-Mac-Installer/releases/latest)，选择下载方式并安装。
3. 按提示授权它修改 QQ 的入口，切换到 NapCat 后启动。
4. 首次启动会出现登录二维码，用**小号**手机 QQ 扫码。

> NapCat 近几个版本已原生支持 macOS arm64/x64；更新安装器时会保留配置和插件。
> 不要在 QQ 客户端里点「检查更新」——NapCat 依赖特定 QQ 版本，升级常常要重装框架。

---

## 2. 配 OneBot 正向 WebSocket

启动后，控制台日志会打印 WebUI 地址，形如：

```
[NapCat] [WebUi] WebUi User Panel Url: http://127.0.0.1:6099/webui?token=xxxx
```

也可以用这个 token 打开 WebUI，在「网络配置 → 新建 → WebSocket 服务端」里填：

| 字段 | 值 |
|---|---|
| 名称 | `dsh`（唯一即可） |
| Host | `127.0.0.1` ← 不要 `0.0.0.0` |
| 端口 | `3001` |
| 消息格式 | `array` |
| Token | 自己设一个随机串，同步到 `.env.qq` |
| 上报自身消息 | 关闭 |
| 保存时启用 | ✅ |

不想点 WebUI 就直接改文件 `config/onebot11_<QQ号>.json`（相对 NapCat 的 config 目录）：

```json
{
  "network": {
    "httpServers": [],
    "httpClients": [],
    "websocketServers": [
      {
        "name": "dsh",
        "enable": true,
        "host": "127.0.0.1",
        "port": 3001,
        "messagePostFormat": "array",
        "reportSelfMessage": false,
        "token": "换成你自己的随机串",
        "heartInterval": 30000
      }
    ],
    "websocketClients": []
  },
  "musicSignUrl": "",
  "enableLocalFile2Url": false,
  "parseMultMsg": false
}
```

改完重启 NapCat，确认 3001 在听：

```bash
nc -z -w 2 127.0.0.1 3001 && echo "端口 OK"
```

> 懒得点 WebUI 的话，也可以让脚本代配（读 `webui.json` 里的 token，走 NapCat 自己的 HTTP API 写进去）：
>
> ```bash
> npm run setup:napcat            # 建 127.0.0.1:3001，消息格式 array
> npm run setup:napcat -- --dry-run   # 只打印将写入的配置
> ```
>
> 这个端口只给本机桥接用。**永远不要**把 6099（WebUI）或 3001 暴露到公网/局域网。

---

## 3. 配 `.env.qq`

```bash
cd $REPO
cp .env.qq.example .env.qq
```

最少改三行：

```ini
QQ_ALLOW_LIST=你的QQ号
QQ_WS_TOKEN=第 2 步设的 token
QQ_DRY_RUN=1
```

想让它进群，再加：

```ini
QQ_GROUP_ALLOW_LIST=群号1,群号2
QQ_GROUP_PREFIX=/ai
```

> 群白名单留空 = 任何群都不回。只放你自己建的群，别放进别人的大群——举报是封号最快的路径。

---

## 4. 启动顺序

```bash
npm run selfcheck:qq   # ① 只校验配置和 dsh，不连 NapCat
npm run probe:qq       # ② 连上 NapCat，打印登录号 + 所有群，白名单命中的会标 ✓
npm run start:qq       # ③ 前台跑（调试）；日常用双击「启动QQ桥接.command」后台跑
```

然后：

1. 用手机 QQ 给这个号发一句话（群里就 `@它` 或发 `/ai 你好`）。
2. 看日志：`tail -f logs/qq-bridge.log`。dry-run 模式下会打印 `[DRY-RUN] 本应发送到 …`。
3. 观察一两天，确认回复内容没问题，把 `QQ_DRY_RUN=0` 改回来，重启。

停止：双击「停止QQ桥接.command」，或 `Ctrl-C`。

### 离线验证（不装 NapCat 也能看行为）

```bash
npm run simulate:qq
```

它用真实的触发判断、真实的限流器、真实的 bridge，逐条告诉你「哪条会回、哪条静默、哪条被限流」。

---

## 5. 参数怎么理解

默认就是**保守档**。这些值不是「性能参数」，放宽不会让它更好用，只会让号更危险：

| 参数 | 默认 | 作用 | 建议 |
|---|---|---|---|
| `QQ_GROUP_PREFIX` / @ 触发 | `/ai` | 群里唯一的触发方式 | 别改成「所有消息都回」 |
| `QQ_RATE_PER_GROUP_MIN` | 5 | 每群每分钟触发上限 | 别超过 10 |
| `QQ_RATE_PER_USER_HOUR` | 20 | 每人每小时触发上限 | 别超过 30 |
| `QQ_RATE_GLOBAL_MIN` | 12 | 全局每分钟触发上限 | 别超过 20 |
| `QQ_RATE_OUT_MIN` | 15 | 出站每分钟上限（长回复分段也计数） | 保持 ≤ 15 |
| `QQ_REPLY_DELAY_MIN/MAX_MS` | 600/2500 | 回复前随机延迟 | 别低于 400 |
| `QQ_SEND_FAIL_BREAKER` | 5 | 连续失败几次熔断 | 别调大 |
| `QQ_MAX_RECONNECT` | 12 | 连续重连失败几次放弃 | 别调大 |

代码里还硬编码了几条不给你改的底线：陌生私聊直接丢、群临时会话忽略、自己消息不回环、
`@全体` 不触发、非本机 `QQ_WS_URL` 直接报配置问题。

---

## 6. 出事怎么办

| 现象 | 正确做法 | 千万别做 |
|---|---|---|
| NapCat 掉线 / 频繁重连 | 看 NapCat 面板状态，等 10–30 分钟再手动处理 | 反复扫码重登（这是加重风控的操作） |
| 手机 QQ 提示「账号异常，需要验证」 | 立刻停桥接，在手机上完成验证，冷却 24 小时 | 一边验证一边让脚本继续跑 |
| 发消息失败 / 熔断 | 看日志确认是禁言、掉线还是被限制 | 调大 `QQ_SEND_FAIL_BREAKER` 硬顶 |
| 被禁言 | 停掉那个群的白名单，等解禁 | 换号继续在那个群发 |
| 真被封了 | 按下面「换号流程」 | 用同一个号反复申诉 + 继续挂协议 |

**换号流程**（5 分钟）：

1. NapCat 里退出登录，用新小号扫码。
2. `.env.qq` 改 `QQ_SELF_ID`、`QQ_ALLOW_LIST`（群白名单/prefix 不用动）。
3. 重启桥接。记忆和审计在 `data/qq/` 下，想干净就删掉。

**复盘哪句话招的事**：

```bash
tail -50 data/qq/audit.jsonl | python3 -m json.tool --json-lines
```

`dir=in` 是触发的消息，`dir=out` 是发出去的，`dir=drop` 是被限流丢的。

---

## 7. 日常维护

| 文件 | 内容 |
|---|---|
| `logs/qq-bridge.log` | 运行日志（掉线、熔断、限流都在这） |
| `data/qq/audit.jsonl` | 收发审计，出事回看用 |
| `data/qq/memory/user_group_<群号>.jsonl` | 群聊上下文（按群隔离，不是按人） |
| `data/qq/memory/user_private_<QQ>.jsonl` | 私聊上下文 |
| `data/qq/inbox/` | 收到的图片 |
| `persona.md` | 人设，改完下一条消息生效，不用重启 |

- **不要**开 QQ 自动更新；升级 NapCat 前先备份它的 `config/` 目录。
- Mac 睡眠会断连：用「启动QQ桥接.command」启动会自动 `caffeinate`。
- 微信桥接和 QQ 桥接可以同时跑：不同进程、不同 env、不同数据目录，互不影响。

---

## 8. 已知边界

- 只能被动响应：不能主动私聊陌生人、不能群发、不能自动加好友/同意进群。
- 没有「正在输入」状态（OneBot 11 没这个接口），所以默认关掉了「收到，正在处理」的 ack，少一条出站消息。
- 长回复会按 `MAX_REPLY_CHARS` 分段发（每段之间也有延迟）。
- 图片能收（下载后交给 modlens 识别），**她能发语音**（见 §9）；但**收**到语音还不会转文字，只当没内容。
---

## 9. 语音（她真说话）

她自己决定什么时候「说」：回复里某一行以 `【语音】` 开头，那一行就变成真正的语音条，其余照旧是文字。

```
好呀。
【语音】爸爸晚安
明天见。
```

**链路**（`src/voice-out.js`）：文本 → Edge TTS（`edge-tts`，微软中文神经语音）→ mp3 → ffmpeg → 单声道 24k PCM → `silk-wasm` → SILK → base64 塞进 OneBot `record` 段。整条约 1.5–2 秒，语音时长和文字长度一起算进「打字延迟」。

**硬性边界**（都是故意的）：

| 情况 | 行为 |
|---|---|
| 群里 | 一律不发语音，标了也只发文字 |
| 一轮里标了多句 | 只发第一句，其余降级成文字 |
| 今天已说满 8 条 / 离上条不到 8 分钟 | 降级成文字 |
| TTS 或 ffmpeg 失败（断网、进程崩） | 降级成文字，聊天不卡 |
| emoji / Markdown 记号 | 念之前先剥掉 |

**试听和换音色**

```bash
npm run say -- "爸爸晚安"                  # 合成并在本机播一遍，silk/wav 存在 data/voice-out/
npm run say -- --send "爸爸晚安"           # 真的发到你 QQ
npm run say -- --list                      # 列出所有中文音色
```

默认 `zh-CN-XiaoyiNeural`（晓伊，年轻活泼）。想换就改 `.env.qq`：

```bash
QQ_VOICE_NAME=zh-CN-XiaoxiaoNeural   # 晓晓，更温和
QQ_VOICE_PITCH=+0Hz                  # 音调：+10Hz 更嫩，-10Hz 更沉
QQ_VOICE_RATE=+5%                    # 语速
QQ_VOICE_MAX_PER_DAY=8               # 每天最多几条
QQ_VOICE_MIN_GAP_MIN=8               # 两条之间至少隔几分钟
QQ_VOICE_OUT=0                       # 一键关掉
```

**依赖**：`wechat-bridge/.venv-tts/bin/edge-tts`（独立 venv，`python3 -m venv .venv-tts && .venv-tts/bin/pip install edge-tts`）+ 系统 `ffmpeg`。缺任何一个启动时会打 `语音：不可用 —— 原因`，不影响文字聊天。

**下一步（没做）**：他发语音过来时，用 silk 解码 + 本地 whisper 转文字，让她真能「听见」。现在的兜底是让她请他打字。

---

## 10. 定时提醒（到点喊你）

```bash
node scripts/qq-remind.mjs --at "11:00" --text "起床啦爸爸"     # 加一条（今天过了就排明天）
node scripts/qq-remind.mjs --at "09:30" --date 2026-10-27 --text "面试别忘了"
node scripts/qq-remind.mjs --list                              # 看排了哪些
node scripts/qq-remind.mjs --cancel <id>                       # 取消
```

**她也会用**：人设里写了这条命令，所以直接跟她说「明天 11 点叫我」就行，她自己排，不用你敲命令。

**守护进程**：`scripts/qq-remind.mjs --daemon` 每 15 秒看一次表，到点后用 `scripts/qq-action.mjs`
直接发 `send_private_msg`（不经过桥接，不受聊天限流影响）。外面套一层 `scripts/supervise-remind.sh`，
挂了 5 秒后自动拉起。**双击「启动QQ桥接.command」会同时把它带起来**，不需要单独开。

| 文件 | 作用 |
|---|---|
| `data/qq/scheduled.json` | 待发任务（人可读，坏了不会崩） |
| `data/qq/scheduled.log` | 每次启动/发送/失败/放弃都有记录 |
| `data/qq/scheduled.pid` | daemon 自己的 pid（防重复启动） |
| `logs/qq-remind.log` | 守护循环的输出 |

**可靠性设计**：

- 机器睡过去或者 daemon 挂过，醒/重启后**补发**（宁可晚，不能丢），日志里会带「迟到 Ns」。
- 发送失败不立刻放弃：间隔 15s → 30s → 60s → 120s 退避，**最多重试 30 分钟**才丢弃（QQ 掉线、NapCat 重连都能扛）。
- pid 文件是上次硬杀留下的也不会误判「已在运行」（会核对进程命令行）。
- 提醒发出去了才会从表里删掉；取消/改期用 `--cancel`。

---

## 附：macOS 实测问题（2026-10-24，本机）

在 macOS 15.7.8 + 官方 QQ 7.0.0(52194) + NapCat 4.18.41 上，按上面的官方流程走完后 **NapCat 起不来**，
过程留档，供以后排查或换机时参考：

| 现象 | 原因 | 处理 |
|---|---|---|
| 安装器「程序入口」显示 ✅ NapCat，但 QQ 的 `package.json` 没被改 | 安装器缺「系统设置 → 隐私与安全性 → App 管理」权限，`sudo` 写入失败 | 去 App 管理里把「NapCat 安装器」加进去，再切一次入口 |
| 手动补入口后 QQ 直接闪退（新 QQ 无崩溃报告） | 修改了带 App Sandbox 的签名 bundle，`_libsecinit_appsandbox` 里 SIGTRAP | 不要手改；必须用安装器（它会处理签名） |
| 补入口 + `--no-sandbox` 启动：`NapCat.Core Version: 4.18.41` 能打印，但随后 `[UtilityProcess] Worker进程退出，退出码: 9`，连续 3 次后主进程退出 | worker 进程被系统 SIGKILL；napcat/logs 都没生成 | 目前无解，等适配 |
| 换旧 QQ 6.9.63-30899 时：`退出码: 5`（SIGTRAP） | 旧包签名/沙箱校验更严格 | 同上 |

**结论：这台 Mac 上跑不通，别继续折腾。** 可行的做法：

1. **把 NapCat 放到 Windows / Linux 机器上**（旧笔记本、小主机、N100 盒子都行）—— 这是社区主流路径，
   那里 NapCat 走的是官方主路径，成功率高得多；桥接进程也放那台机器，`QQ_WS_URL` 保持 `127.0.0.1:3001`。
2. 等 NapCat 适配 macOS + QQ 7.0.0 后重试（关注 [NapCatQQ issues](https://github.com/NapNeko/NapCatQQ/issues)）。
3. 只在群里用的话，官方机器人（q.qq.com）零风险。

恢复原版 QQ：

```bash
# 方式一：安装器里点「切换程序入口『原版 QQ』」
# 方式二：重装（会保留聊天数据在 ~/Library/Containers/com.tencent.qq）
brew reinstall --cask qq --force
```

---

## 长期记忆（dsh-longterm-memory，已装好）

桥接层的历史只有最近 8 轮/6000 字（滚动窗口），超出就忘。为了记住长期的事，headless profile 里装了
[`dsh-longterm-memory`](https://www.npmjs.com/package/dsh-longterm-memory)：

| 项 | 值 |
|---|---|
| 记忆仓库 | `wechat-bridge/data/memory-vault/`（Obsidian 兼容的明文 Markdown，可直接用 Obsidian 打开） |
| 模型工具 | `memory_search` / `memory_get` / `memory_save` / `memory_forget` |
| 每次注入 | 常驻偏好块 ≤700 tokens（12 条）+ 按预算召回 ≤600 tokens |
| 生效范围 | QQ 和微信两条桥接共用（都用 `headless` profile，同一个 vault） |

**为什么能跨消息记住**：桥接每条消息都新起一个 `dsh` 进程，插件在进程启动时扫描仓库重建索引，
所以「上一条消息存的」在下一条就能查到。

### 本地补丁（必须）

`dsh-longterm-memory@0.1.4` 有 6 处写死 Windows 分隔符（`join(root, path.split('/').join('\\'))`），
在 macOS 上表现为：`memory_save` 写进 journal、但 `.md` 文件不落盘、索引恒空、召回永远为空。
补丁把这些调用改成正斜杠路径：

```bash
npm run patch:longmem            # 打补丁（幂等）
node scripts/patch-longterm-memory.mjs --check   # 只检查
```

⚠️ 插件升级/重装会覆盖 `node_modules`，升级后要再跑一次补丁。

### 已知小毛病

- `memory_get` 对**中文标题**的文件偶尔报「文件不存在」（`memory_search` 正常）；因为工具搜索可用，不影响使用。
- 关掉了 `enableAutoExtraction`（自动抽取会产生重复条目），只保留模型主动 `memory_save`。
- 记忆是**明文**：别让它存密码/token（persona 里已经写了这条规矩）。

### 重置

```bash
rm -rf data/memory-vault     # 下次调用自动重建空仓库
```

---

## 她自己的抖音号

已接入一个真抖音号（吃白饭的机器人账号），用本机 Edge 有头浏览器刷推荐流，
刷到的会当「心事」存起来，之后主动找主人聊天时分享。

详见 [抖音号接入.md](./抖音号接入.md)。
开关：`QQ_LIFE_ENABLED`；调试：`npm run life`。

---

## 回复慢是怎么回事

一条消息从收到到发出去，要过四段：

| 环节 | 耗时 | 能不能砍 |
|---|---|---|
| `dsh --profile headless` 冷启动 + 模型生成 | 1.5–4 秒（偶发 8–20 秒） | 冷启动是硬成本；模型波动看网关 |
| 她自己在中间调工具（查记忆/跑脚本/翻文件） | 每轮 +2–5 秒 | **能**，靠人设约束 + 把上下文直接喂进去 |
| 拟人延迟（看到→打字） | 原来 2–6 秒 | **能**，改配置 |
| 出站节流（每条消息 250–900ms） | 0.3–1 秒 | **能**，改 `QQ_REPLY_DELAY_*` |

三个关键旋钮：

```ini
# 拟人停顿（原来 800-3000 + 35ms/字，封顶 6 秒，太狠了）
QQ_CHAT_THINK_MIN_MS=400
QQ_CHAT_THINK_MAX_MS=1200
QQ_TYPING_MS_PER_CHAR=12
QQ_THINK_CAP_MS=1800

# 走神概率和时长
QQ_DISTRACTED_CHANCE=0.03
QQ_DISTRACTED_MIN_MS=3000
QQ_DISTRACTED_MAX_MS=8000

# 模型已经很慢时抵扣拟人等待：超过 2.5 秒的部分从打字延迟里扣掉
QQ_TURN_GRACE_MS=2500
```

`QQ_TURN_GRACE_MS` 是最有用的一个：模型跑了 8 秒，那段「看到消息再打字」的延迟会自动扣成 0 —— 人不会让你等两遍。

想让工具更快，还能把 `AGENT_TIMEOUT_MS` 之外的两件事做掉：

1. 人设里明确「闲聊别动手」，否则她会为了回答一句话去跑脚本；
2. 把「她刚刷到的视频」「此刻在干嘛」直接注入 prompt（`src/life.js`），她就**不需要**现查——这一项实测把「你有啥好玩的不」从 9.3 秒降到 3.2 秒。
