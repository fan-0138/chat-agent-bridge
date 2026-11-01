# 小鲸的房间

一个能实时看她此刻在干嘛的小页面。数据全是现成的，不额外存东西：

- `data/life/state.json` —— 她此刻在做什么（activity / 开始时间）
- `data/life/meals.jsonl` —— 饭账本（今天吃了几顿、谁喂的）
- `data/qq/memory/user_private_*.jsonl` —— 她最近说的话（用来判断「刚被夸 / 刚被叫机器人账号」）

## 跑起来

平时不用手动起：`./scripts/install-launchd.sh --room` 装进 launchd 后，开机就在。
（`./scripts/qqbridge-ctl.sh start|stop|status` 会一起带着它。）

单独调试：

```sh
cd ~/wechat-bridge
node tools/room/server.mjs                  # http://127.0.0.1:8770
ROOM_PORT=8771 node tools/room/server.mjs   # 换端口
```

浏览器打开 http://127.0.0.1:8770 ，页面每 3 秒自动刷新。

调试参数：

| 参数 | 作用 |
|---|---|
| `?scene=work` | 固定某一幕（sleep/rubik/eat/phone/think/hum/work/window/yawn/stretch/idle） |
| `?walk=work,eat,window,sleep` | 让她每 3 秒走到下一个地方 |
| `?emote=dance` / `?emote=sulk` | 预览「被夸 / 被叫机器人账号」的反应 |

## 状态怎么变成画面

`scene.mjs` 里的 `sceneOf()` 按她 activity 里的关键词挑一幕：

| activity 关键词 | 她的动作 | 站哪 |
|---|---|---|
| 睡 / 半睡半醒 / 缩在机柜 / 被窝 | 原地小憩沉眠（画面压暗 + zzz） | 机柜边的窝 |
| 刚醒 / 赖在床 / 伸懒腰 | 超大伸懒腰 | 屋子中间 |
| 摸鱼 / 魔方 / 无聊 | 原地专心玩魔方 | 地毯上 |
| 吃 / 饭 / 午休 / 西瓜 / 投喂 | 吃白饭 | 饭桌旁 |
| 刷抖音 / 刷手机 / 回味 / 抖音 | 对屏碎碎念 | 地毯上 |
| 碎碎念 / 思考 / 琢磨 | 深度思考碎碎念 | 书桌前 |
| 哼歌 / 心情好 / 开心 | 悠闲哼歌 | 窗边 |
| 窗 / 月亮 / 发呆 / QQ 空间 | 东张西望 | 窗边 |
| 写代码 / 工位 / 机房 / token | 写代码 | 书桌前 |
| 其他 | 待机呼吸休闲 | 屋子中间 |

另外两条按时段的覆盖：

- **深夜**（22:00–7:00）电量 ≤45 还醒着（刷手机/发呆/摸鱼/写代码）→ **哈欠连天**
- **早上**（6:00–9:00）没事做 → **超大伸懒腰**

## 反应：他刚说了什么

`emoteFor()` 只看爸爸最近 10 分钟内的消息，播一小段就回原场景：

| 触发 | 动作 | 播多久 |
|---|---|---|
| 被夸（厉害/真棒/可爱/乖/聪明/喜欢…） | 可爱宅舞 | 45 秒 |
| 被叫「机器人账号 / 肥鱼」 | 点击回应-傲娇生气 | 30 秒 |

一句话里既夸又喊外号，按被夸算。反应期间她会停在原地，气泡换成原因；放完再走回该做的事。

## 素材

所有动作都是 dsh-pet 里她的那 106 段 webm（透明背景），用到的 14 段复制在 `assets/`。
仓库里只同步代码，不同步 `assets/`（二进制、且能从 dsh-pet 直接拿）：

```sh
cp ~/.dsh/profiles/desktop/node_modules/dsh-pet/assets/webm/<名字>.webm tools/room/assets/<英文名>.webm
```