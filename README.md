# chat-agent-bridge

**专为 macOS 打造**的个人 AI 桥接：把一个**大模型 Agent** 接进你自己的 QQ / 微信 / 抖音，
养一个「住在你 Mac 里」的数字人格。

她有人设、有长期记忆、有作息和情绪、会自己找话题、会发语音和表情包、能帮你动手干活，
三个平台上还是**同一条鱼**。

> 🍎 **为什么是 Mac 专用**：市面上 QQ 机器人方案几乎全在 Windows / Linux（NapCat 那套）。
> macOS 上 NapCat 装不起来（我们实测踩过，见 [docs](docs/QQ接入手册.md)），
> 所以这里走的是 Docker 里的 OneBot 端 + 原生 macOS 桥接，做的人很少。
> Apple Silicon / Intel 都行；Linux 也能跑，但没在 Linux 上验证过。

> ### ⚠️ 先读这两份
> - [DISCLAIMER.md](DISCLAIMER.md)：非官方接口，封号风险自担；违规使用后果自负。
> - [LICENSE](LICENSE)：**仅限个人非商业使用，禁止售卖与商用**，违反追责。
>
> 继续使用即视为同意以上条款。

## 这是拿来做什么的

简单说：**给你自己造一个「虚拟伴侣」，让她住进你天天用的聊天软件里。**

- 想有个 **AI 女儿 / 赛博女友 / 虚拟伴侣**，在 QQ 或微信上陪你聊 —— 人设、撒娇、吃醋、早晚安、会主动找你
- 想让她**记得住**你：昨天说的事、你的口味、你的作息，跨平台还是同一个人
- 想让她**有点自己的日子**：会饿会困、自己刷抖音、到点提醒你、偶尔给你发张表情包或一段语音
- 也可以反过来当**能干活的私人助理**：能跑命令、看截图、查资料、发抖音评论（dsh 后端）

模型用 DeepSeek 就行（也支持任意 OpenAI 兼容接口）；全跑在你自己 Mac 上，数据不出本机。
所以搜「DeepSeek 虚拟伴侣 / AI 女友 接入 QQ 微信 / 赛博陪伴 bot」进来的，大概就是找这个项目。

## 它是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 一个跑在**你自己电脑上**的桥接进程 | 云端 SaaS，没有任何服务器 |
| 把 LLM 接进聊天软件，让她像人一样聊 | 关键词机器人、规则回复 |
| 完整 agent：能跑命令、读文件、看截图、刷网页 | 只有聊天的 chatbot（不过也支持这种模式） |
| 单人自用、本地存记忆 | 群发、批量、客服、营销工具（明令禁止） |

## 特性

- **人设热改**：`persona.md` 改完下一条消息就生效，不用重启；性格浓度是一组 0-5 的刻度
- **说话方式会长**：她自己的笔记本 `voice.md`，你说「别老用唔开头」她当场就记下来
- **长期记忆**：JSONL 落盘，QQ / 微信 / 抖音共用同一份时间线（同一 key）
- **生活状态**：会饿会困会摸鱼，自己刷抖音、自己找话说（概率 + 静默时段）
- **语音**：文字 → Edge TTS → SILK → 真正的 QQ 语音条（自己决定什么时候说）
- **表情包**：丢进 `data/stickers/` 就会用
- **定时提醒**：独立守护进程，到点私聊喊你，失败重试 30 分钟
- **网络看门狗**：换 WiFi 后 QQ 客户端会「能发不能收」，它负责发现并自动恢复
- **关掉前告别**：正常退出会先说一句；被硬杀下次启动会补一句
- **饭饭账本**：到点记账，月初把上个月的翻给你
- **防「AI 味」的机械兜底**：重复起头、emoji 堆叠、思考过程泄漏到正文……都有代码拦着
- **213 个单测**（`npm test`），核心逻辑都拆成了纯函数

## 架构

```
   你的手机                    你的 Mac
┌───────────┐   协议    ┌──────────────────────────────────────────┐
│  QQ 客户端 │◄────────►│ OneBot 端（SnowLuma / NapCat，Docker 或本机）│
└───────────┘           └───────────────┬──────────────────────────┘
                                        │ WebSocket (OneBot 11)
┌───────────┐   iLink   ┌───────────────▼──────────────────────────┐
│  微信     │◄─────────►│            chat-agent-bridge              │
└───────────┘           │  transport → bridge → prompt → runner     │
┌───────────┐   CDP     │   记忆 / 人设 / 节奏 / 语音 / 表情包 / 提醒   │
│  抖音网页 │◄─────────►│                                          │
└───────────┘           └───────────────┬──────────────────────────┘
                                        │
                        ┌───────────────▼───────────────┐
                        │ 模型后端：dsh（完整 agent）    │
                        │        或 openai（纯聊天）     │
                        └───────────────────────────────┘
```

三个通道互不影响：QQ 挂了微信照常，抖音炸了不影响聊天。
每个通道独立进程、独立配置、独立日志。

## 快速开始（macOS）

### 0. 前置

- macOS（Apple Silicon / Intel 都行），Node **22+**
- Docker（推荐，用来跑 OneBot 端）
- 一个大模型的 key（DeepSeek 或其他 OpenAI 兼容服务）

### 1. 起一个 OneBot 端

macOS 上 **NapCat 装不起来**（我们踩过，详见 [docs/QQ接入手册.md](docs/QQ接入手册.md) 末尾的实测记录），
所以用 Docker 跑一个 OneBot 实现（下面以 SnowLuma 为例，是社区维护的第三方镜像）：

```bash
docker run -d --name snowluma \
  -p 127.0.0.1:3001:3001 -p 127.0.0.1:5099:5099 -p 127.0.0.1:6081:6081 \
  -v "$PWD/qq-data/config:/app/.config" \
  -v "$PWD/qq-data/share:/app/.local/share" \
  -v "$PWD/qq-data/data:/app/data" \
  --restart unless-stopped \
  docker.1panel.live/motricseven7/snowluma:latest
```

起来之后打开 `http://127.0.0.1:5099`（WebUI）扫码登录你的**小号 QQ**，
确认 OneBot 的「正向 WebSocket」开在 `3001`。

> Windows / Linux 用户：直接用 [NapCat](https://napneko.github.io/) 更省事，配置一样。

### 2. 配桥接

```bash
git clone https://github.com/fan-0138/chat-agent-bridge.git chat-agent-bridge && cd chat-agent-bridge
npm install
cp .env.qq.example .env.qq
cp persona.example.md persona.md            # 她是谁，自己改
cp persona.traits.example.json persona.traits.json
mkdir -p data/stickers
cp examples/voice.md data/voice.md
cp examples/slang.md data/slang.md
```

打开 `.env.qq`，最少改这几行：

```bash
QQ_ALLOW_LIST=你的QQ号
AGENT_CWD=/Users/你/Documents        # 她能动手的目录
```

### 3. 选模型后端

**A. dsh（推荐，完整 agent）**

装 [DeepSeek Harness](https://www.deepseek.com/zh/harness/)，把 key 写进 `~/.dsh/.credentials.yaml`
或 `.env.qq` 的 `DEEPSEEK_API_KEY`。桥接会自动找到 App 里的 CLI，也可以用 `AGENT_CLI` 指定。

**B. openai（任何兼容接口，纯聊天）**

```bash
AGENT_BACKEND=openai
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_MODEL=deepseek-chat
OPENAI_API_KEY=sk-xxx
```

区别：openai 后端**没有工具能力**（不能跑命令、不能看图、不能整理表情包），
人设、记忆、节奏、语音这些桥接层的能力都还在。

### 4. 跑起来

```bash
npm run start:qq
```

第一次启动会打印你的 QQ 号 —— 填进 `QQ_ALLOW_LIST` 再重启一次。

### 5. 可选能力

```bash
# 语音（她真能发语音条）：需要 python3 + ffmpeg
python3 -m venv .venv-tts && .venv-tts/bin/pip install edge-tts
npm run say -- "爸爸晚安"          # 本机试听
npm run say -- --send "爸爸晚安"   # 真发一条到 QQ

# 抖音（刷视频 / 发评论 / 网页版私信）
npm run douyin:login               # 扫码登录她自己的抖音号
QQ_DOUYIN_CHAT_ENABLED=1           # 写进 .env.qq

# 定时提醒
npm run remind -- --at "11:00" --text "起床啦" --to 你的QQ号
nohup ./scripts/supervise-remind.sh >> logs/qq-remind.log 2>&1 &   # 常驻

# 网络看门狗（换 WiFi 后自动恢复 QQ 连接）
nohup ./scripts/net-watch.sh >> logs/net-watch.log 2>&1 &
```

## 目录结构

```
src/
  index-qq.js        QQ 入口（OneBot 11）
  index.js           微信入口（iLink）
  transport-*.js     各平台适配层：登录、收消息、发消息、限流、熔断、审计
  bridge.js          与平台解耦的核心：记忆 → prompt → 模型 → 切分 → 发送
  prompt.js          按渠道拼 prompt（微信 / QQ 两套说话规矩）
  persona.js         人设加载（热更新）
  thinking-guard.js  拦住「把心里话当正文发出去」
  voice-out.js       TTS → SILK → QQ 语音条
  meals.js           饭饭账本
  runner-factory.js  选模型后端：dsh / openai
  ...
scripts/             运维与一次性工具：提醒、语音、表情包、抖音、看门狗
docs/                踩坑记录、平台接入手册、性格刻度说明
test/                213 个单测
```

## 常用命令

| 命令 | 干什么 |
|---|---|
| `npm run start:qq` | 启动 QQ 桥接 |
| `npm run selfcheck:qq` | 只检查配置，不连 OneBot |
| `npm run probe:qq` | 连上 OneBot 读一下登录号和群列表 |
| `npm test` | 跑单测（不联网、不需要账号） |
| `npm run say -- "话"` | 合成一条语音试听 |
| `npm run meal -- --list` | 看饭饭账本 |
| `npm run remind -- --at "08:30" --text "起床"` | 加一条提醒 |

## 已知边界

- **NapCat 在 macOS 上跑不通**（实测，见 docs），所以 Mac 用户走 Docker 的 OneBot 实现
- **微信只能 1:1 私聊**，不能进群（iLink 通道限制）；主动发消息有 24 小时窗口
- **抖音走网页版**：图片/语音/卡片这类消息网页渲染不出来，只能让她请对方打字
- **QQ 客户端换网络会「能发不能收」**，靠 `net-watch.sh` 兜
- 所有通道都是非官方接口，**有风控风险**，请用小号

## 开发

```bash
npm test          # 213 个用例
npm run check     # 语法检查
```

桥接层（`bridge.js`）和平台层（`transport-*.js`）是解耦的：
`bridge` 只认规范消息对象，所以加一个新平台只需要写一个 transport，
不用碰记忆、人设、prompt 这些逻辑。

## 致谢

- [OneBot 11](https://github.com/botuniverse/onebot-11) 协议
- [NapCat](https://napneko.github.io/)、SnowLuma 等实现
- [silk-wasm](https://github.com/idranme/silk-wasm)、[edge-tts](https://github.com/rany2/edge-tts)
- 所有在踩坑帖里留下记录的人

## License

见 [LICENSE](LICENSE)：MIT 正文 + **仅限个人非商业使用** 附加条款。
因含禁止商用条款，本项目不是 OSI 定义的开源软件，属于 source-available。