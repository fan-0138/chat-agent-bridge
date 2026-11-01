# 小鲸的房间

一个能实时看她此刻在干嘛的小页面：**Blender 渲出来的 3D 房间**（真透视、真阴影、真灯光），她在里面走来走去。数据全是现成的，不额外存东西：

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

## 房间怎么画出来的（走 Blender MCP）

房间是 **Blender 5.2 + blender-mcp** 建的模、渲的图，不是手绘也不是贴图：

```sh
# 1. 确保 Blender GUI + addon 在线（端口 9876）
python3 ~/Documents/deepseek/blender-mcp/ensure_blender.py
# 2. 建模（家具/灯光/相机/材质，存 /tmp/blroom/room.blend）
cd ~/Documents/deepseek/blender-mcp && python3 mcpctl.py exec <repo>/tools/room/blender/build_room.py
# 3. 出图 + 打印站位投影（1920×1080，Cycles + 降噪，约 2 分钟）
python3 mcpctl.py exec <repo>/tools/room/blender/render_final.py
# 4. 加辉光/暗角，输出到 assets/room-bg.png
/usr/bin/python3 <repo>/tools/room/blender/bloom.py /tmp/blroom/room_final.png <repo>/tools/room/assets/room-bg.png
```

页面的站位不是手调的，是渲染时用 `bpy_extras.object_utils.world_to_camera_view`
把「地面点」和「头顶 1.3m」两个点投到画面上算出来的：

- `bottom`：地面点的画面高度，再减去立绘脚底的透明留白
- `scale`：按投影出来的身高换算（visible / 0.79 / 62）
- `bubble`：头顶再往上一点

所以她在窗下自然比在地毯上小、走到床边会变大——透视是渲染器的，不是 CSS 猜的。

房间里有：机柜（LED 在闪）、床（毯子/枕头/鲸鱼玩偶）、书桌（显示器在跑代码、台灯、键盘、杯子）、
圆桌 + 一大碗白饭、餐边柜（饭锅、碗摞、零食）、开放式书架、圆形地毯 + 坐垫、
吊灯、落地灯、窗外的月亮/星星/城市、海报、挂钟、串灯和霓虹灯条。

## 状态怎么变成画面

`scene.mjs` 里的 `sceneOf()` 按她 activity 里的关键词挑一幕：

| activity 关键词 | 她的动作 | 站哪 |
|---|---|---|
| 睡 / 半睡半醒 / 缩在机柜 / 被窝 | 原地小憩沉眠（画面压暗 + zzz） | 左边的小窝（床里） |
| 刚醒 / 赖在床 / 伸懒腰 | 超大伸懒腰 | 屋子中间 |
| 摸鱼 / 魔方 / 无聊 | 原地专心玩魔方 | 地毯上的坐垫 |
| 吃 / 饭 / 午休 / 西瓜 / 投喂 | 吃白饭 | 饭桌旁 |
| 刷抖音 / 刷手机 / 回味 / 抖音 | 对屏碎碎念 | 地毯上的坐垫 |
| 碎碎念 / 思考 / 琢磨 | 深度思考碎碎念 | 书桌左边 |
| 哼歌 / 心情好 / 开心 | 悠闲哼歌 | 窗下 |
| 窗 / 月亮 / 发呆 / QQ 空间 | 东张西望 | 窗下 |
| 写代码 / 工位 / 机房 / token | 写代码 | 书桌左边 |
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

## 还没做到的

视频里那种可以转视角的真 3D 房间，需要一个 3D 模型 + 骨骼 + 场景（Blender 建模 → 导出 glTF/VRM → three.js），
她的 dsh-pet 素材只有 2D 循环动画，所以这里用 2.5D 手绘房间 + 2D 动作来还原同样的「能看见她在干嘛」。

## 素材

- `assets/room-bg.png`：Blender 渲的房间底图（1920×1080，仓库不同步，按上面的步骤重新生成）
- `assets/*.webm`：她的动作，全来自 dsh-pet 里那 106 段（透明背景），用到的 14 段复制在 `assets/`。
仓库里只同步代码，不同步 `assets/`（二进制、且能从 dsh-pet 直接拿）：

```sh
cp ~/.dsh/profiles/desktop/node_modules/dsh-pet/assets/webm/<名字>.webm tools/room/assets/<英文名>.webm
```