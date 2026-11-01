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
| `?house=1` | 换成 dsh-in-home 的娃娃屋版（MIT · 星主），白天/夜晚跟着她的钟点切 |
| `?scene=work` | 固定某一幕（sleep/rubik/eat/phone/think/hum/work/window/yawn/stretch/idle） |
| `?scene=sleep` | 看她走到床上躺下、屋里灯暗下来、出 zzz |
| `?walk=work,eat,window,phone` | 按顺序带她走一圈（每 4 秒一个地方，录演示用） |
| `?stroll=1` | 让她每 5 秒起来逛一圈（平时是每 20–45 秒自己逛） |
| `?nowalk=1` | 不播走路，直接站到目标位置（调站位用） |
| `?at=19.5,17.5` | 把她钉在指定坐标（x%、bottom%），配合 `?scene=` 调站位 |
| `?walkclip=float` / `crab` / `run` | 换走路动作对比（默认 float=原地漂浮踏步） |
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
- `scale`：按投影出来的身高换算，拟合出 `scale = 0.8794 - 0.01368 × bottom`
- 气泡：按立绘抬头的位置算，跟着她走

所以她在窗下自然比在地毯上小、走到床边会变大——透视是渲染器的，不是 CSS 猜的。
「晚上上床睡觉」那一幕是坐在床垫上，`bottom` 取床垫表面的高度，人自然也跟着小一点。

房间里有：机柜（LED 在闪）、床（毯子/枕头/鲸鱼玩偶）、书桌（显示器在跑代码、台灯、键盘、杯子）、
圆桌 + 一大碗白饭、餐边柜（饭锅、碗摞、零食）、开放式书架、圆形地毯 + 坐垫、
吊灯、落地灯、窗外的月亮/星星/城市、海报、挂钟、串灯和霓虹灯条。

## 状态怎么变成画面

`scene.mjs` 里的 `sceneOf()` 按她 activity 里的关键词挑一幕：

| activity 关键词 | 她的动作 | 站哪 |
|---|---|---|
| 睡 / 半睡半醒 / 缩在机柜 / 被窝 | 原地小憩沉眠（闭眼打盹 + zzz） | 走到床上坐下，屋里灯暗下来 |
| 刚醒 / 赖在床 / 伸懒腰 | 超大伸懒腰 | 屋子中间 |
| 摸鱼 / 魔方 / 无聊 | 原地专心玩魔方 | 地毯上的坐垫 |
| 吃 / 饭 / 午休 / 西瓜 / 投喂 | 吃白饭 | 饭桌旁 |
| 刷抖音 / 刷手机 / 回味 / 抖音 | 对屏碎碎念 | 地毯上的坐垫 |
| 碎碎念 / 思考 / 琢磨 | 深度思考碎碎念 | 书桌左边 |
| 哼歌 / 心情好 / 开心 | 悠闲哼歌 | 窗下 |
| 窗 / 月亮 / 发呆 / QQ 空间 | 东张西望 | 窗下 |
| 写代码 / 工位 / 机房 / token | 写代码 | 书桌左边 |
| 其他 | 待机呼吸休闲 | 屋子中间 |

另外几条按时段的覆盖：

- **22:00 之后**电量 ≤45 还醒着（刷手机/发呆/摸鱼/写代码）→ **哈欠连天**（先赖一会儿）
- **23:00–7:00** 电量 ≤35 → **真的上床睡**：不管手上在干嘛，走到床沿、爬上床垫坐下，
  整间屋子的灯暗下来，气泡收起，只留 zzz；早上 7:00 醒来，再走回她该待的地方
- **早上**（6:00–9:00）没事做 → **超大伸懒腰**

## 反应：他刚说了什么

`emoteFor()` 只看爸爸最近 10 分钟内的消息，播一小段就回原场景：

| 触发 | 动作 | 播多久 |
|---|---|---|
| 被夸（厉害/真棒/可爱/乖/聪明/喜欢…） | 可爱宅舞 | 45 秒 |
| 被叫「机器人账号 / 肥鱼」 | 点击回应-傲娇生气 | 30 秒 |

一句话里既夸又喊外号，按被夸算。反应期间她会停在原地，气泡换成原因；放完再走回该做的事。

## 小屋版（`?house=1`）

同一套页面逻辑可以挂两块地板：

- 默认：Blender 渲的透视房间（`walk.mjs`，相机投影反算站位）
- `?house=1`：**主星上的机器人账号 · 小屋**的娃娃屋图（`house.mjs`）——
  素材来自 [dsh-in-home](https://www.npmjs.com/package/dsh-in-home)（MIT, © 星主），
  1376×768，白天/夜晚两张图跟着她的钟点切（20:00–7:00 用夜晚那张）。

小屋版里这些照旧：她的 14 段动作、此刻在干嘛、电量心情、饭账本、被夸跳舞、
被叫机器人账号生气、自己闲逛、深夜走到床上打盹。区别只是：

- 地板换成一块大平层，站位和路网在 `house.mjs` 里按图片像素换算
- 缩放直接沿用插件自己的深度系数：图里 y 430→665 对应 scale 0.78→1.0
- 立绘比 Blender 房间小一号（42%），不然她比床还大会像巨人进屋

素材不进仓库（和 assets/ 里其它二进制一样），自己从小屋插件包里拿：

```sh
mkdir -p /tmp/dsh-home && cd /tmp/dsh-home
pnpm pack dsh-in-home && tar xzf dsh-in-home-*.tgz
cp package/assets/hut-night.webp package/assets/hut-day.webp <repo>/tools/room/assets/
```

页面右下角会标注素材来源（MIT）。

## 在屋里走动

走路是**真走**，不是场景一切换就瞬移：

- `floor.mjs` 是通用走法（落脚点图 / 寻路 / 缩放 / 闲逛），`walk.mjs`（Blender 房间）和
  `house.mjs`（娃娃屋）各自只配路点和缩放系数
- 房间地面拆成落脚点（11 个做事的位置 + 7 个闲逛点），连成一张能走的路网，
  床边只能从「床沿」上下、不会从地毯中间穿床过去
- 每次换事做，先 `route()` 寻路，再按实际距离算走路时长（横向 16:9 折算成真实距离，15%/秒）
- 走的时候播 `float.webm`（原地漂浮踏步），每帧重算脚下位置、透视缩放和影子，
  再加一个「步频」——两步一个循环的上下起伏 + 轻微左右摆；往左走会把立绘水平翻转
- 为什么不用「螃蟹走路」：那段动画里她会整个人歪向一边，平移起来像在飘；插件用的
  「原地左转奔跑」也会转圈。对比参数：`?walkclip=crab` / `?walkclip=run`
- 走路速度：Blender 房间 12、小屋 9.5（单位：舞台高度的百分比每秒），慢一点更像在屋里晃
- 她忙自己的事时，每隔 20–45 秒会起来逛一圈：地毯边 → 窗下/书架前/床边，
  站一两秒看看，再走回原来的位置继续（`?stroll=1` 可以马上看到）
- 被夸/被叫机器人账号时会当场停下反应，反应完再走回去

## 还没做到的

视频里那种可以转视角的真 3D 房间，需要一个 3D 模型 + 骨骼 + 场景（Blender 建模 → 导出 glTF/VRM → three.js），
她的 dsh-pet 素材只有 2D 循环动画，所以这里用 2.5D 手绘房间 + 2D 动作来还原同样的「能看见她在干嘛」。

## 素材

- `assets/room-bg.png`：Blender 渲的房间底图（1920×1080，仓库不同步，按上面的步骤重新生成）
- `assets/*.webm`：她的动作，全来自 dsh-pet 里那 106 段（透明背景），用到的 16 段复制在 `assets/`
  （走路相关三段：`float.webm` 原地漂浮踏步、`walk.webm` 螃蟹走路、`run.webm` 原地左转奔跑）。
仓库里只同步代码，不同步 `assets/`（二进制、且能从 dsh-pet 直接拿）：

```sh
cp ~/.dsh/profiles/desktop/node_modules/dsh-pet/assets/webm/<名字>.webm tools/room/assets/<英文名>.webm
```