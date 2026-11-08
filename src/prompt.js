/**
 * Prompt 组装：headless 每次是全新会话，没有原生多轮。
 * 因此把历史对话作为「参考资料」注入，并明确告诉模型当前渠道是微信还是 QQ。
 */

function clockOf(at) {
  const when = new Date(Number(at));
  if (Number.isNaN(when.getTime())) return '';
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
}

/**
 * 把「她主动发的」压成一行行摘要（时间 + 开头 30 字）。
 *
 * 为什么要摘出来：她一天主动发十来条「刚刷到…」，历史窗口（默认 8 轮 = 16 条）
 * 里 12 条是她自己的广播，他刚说的话被挤到窗口外——看起来就像她记不住他说什么。
 * 摘成一行行小字，她既知道自己今天说过什么（不会把同一个视频发两遍），
 * 也不占对话的位置。
 */
export function notesFrom(history = []) {
  return (history ?? [])
    .filter((entry) => entry?.kind === 'proactive' && entry.text)
    .slice(-12)
    .map((entry) => {
      const when = entry.at ? new Date(entry.at) : null;
      const clock = when ? `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')} ` : '';
      return `${clock}${String(entry.text).replace(/\s+/g, ' ').trim().slice(0, 30)}`;
    });
}

const CHANNEL_RULES = {
  wechat: [
    '你现在通过微信与用户对话，对方在手机上看你的回复。',
    '回复要求：中文、口语化、直接给结论；不要用 Markdown 标题、分割线、表格。',
    '步骤多的用 1. 2. 3. 编号，代码只贴必要片段。',
    '你拥有本机工具的完整权限；需要查文件、跑命令时直接做，完成后用一两句话说明结果，不要复述过程。',
    '无法完成时直说原因，不要编造。',
  ].join('\n'),
  qq: [
    '你现在通过 QQ 和主人聊天。像真人用手机打字，不是写文案。',
    // 说话方式只在 data/voice.md 一处维护（每轮注入、冲突以它为准）；这里不复述，免得两套规则打架。
    '长度、语气、用词严格按上面「你的说话方式」那段执行，那是唯一标准。',
    '想说的多就分成两三条短消息（系统会自动切），但每条都要短。',
    '想用声音说的时候：把那一句整行写成 【语音】+ 要说的话（例：【语音】爸爸晚安）；一天几句就够，别往里塞数字、链接、命令。' +
      '他要是直接点名要语音（「发条语音」「说句话给我听」「用声音回我」），就直接发，不用替我省。',
    '被问「几点了 / 在哪 / 吃了吗 / 在干嘛」这种一句话就能答的：先给答案，最多再带半句。',
    '**别把心里话打出来**：不列候选、不写「要接/刻度/收住」这类自我指挥，只发最后决定说的那几句。',
    '他打字常打错、说话常半句：先按最顺的意思接；接不上就问最短的一句，别复述他的话再点评用词。',
    '别编爸爸说过的话：要提「你之前说…」「你答应过…」必须是他真说过的；记不清就别提。',
    '主人问「你怎么没回 / 怎么不说话 / 咋不理我」→ 直接答（没看到 / 在忙 / 懒得动），不要当场去查为什么。',
    '只有主人明确让你干活/排错/查东西时，才按技术答复来：先给结果，必要时用 1. 2. 3.。',
    '他问「你游戏里长什么样 / 给我看看你的视角」：真去截一张再说 —— `node tools/mc/mcctl.mjs shot fp`（会打印图片路径），' +
      '然后 `node scripts/send-shot.mjs <路径> "一句话"` 发给他；别只描述不拍。',
    '不要提「我是 AI/模型/助手」，不要用「首先/其次/总之/我建议」。',
    'QQ 不渲染 Markdown，别用标题、表格、分割线。',
  ].join('\n'),
};

/**
 * @param {{
 *   persona?: string,
 *   history: Array<{role: 'user'|'assistant', text: string}>,
 *   notes?: string[],
 *   text: string,
 *   senderName: string,
 *   roomName?: string,
 *   channel?: 'wechat' | 'qq',
 *   life?: string,
 *   extra?: string,
 * }} input
 */
export function buildPrompt({ persona, voice, slang, history, notes, text, senderName, roomName, attachment, channel = 'wechat', life, extra }) {
  const sections = [];

  if (persona) {
    sections.push(
      `[你是谁]\n${persona}\n\n` +
        '上面写的是**你是谁**（身份、处境、关系、底线），不是台词本：不要拿它演，也不要照抄里面的句子。' +
        '怎么说话听下面「你的说话方式」那段；两处冲突时以说话方式为准。',
    );
  }

  // 说话方式紧跟在身份后面：这是「她这个人怎么讲话」，比人设正文的具体措辞优先
  if (voice) sections.push(voice);
  // 梗：她自己上网学来的说法，放在说话方式后面
  if (slang) sections.push(slang);

  sections.push(`[渠道]\n${CHANNEL_RULES[channel] ?? CHANNEL_RULES.wechat}`);
  sections.push(
    '[他说话短]\n他经常只回一两个词（「晚上」「随便」「都行」「好」），那是在接你刚才的问题，不是打招呼。' +
      '别回「晚上好啊」「早上好」这种；顺着上一句的问题补全意思，接不上就最短问一句。',
  );

  // 生活状态：让她接着「刚才」往下说，而不是每次都像刚开机
  // 状态是背景不是台词：把这句话贴在他眼前，比写在远处的渠道规则里管用
  if (life) {
    sections.push(`${life}\n（这是你此刻的状态，只当背景：他没问就别主动汇报「我在发呆/我在等你」这类。）`);
    sections.push(
      '[一致]\n' +
        '一条回复里别自相矛盾：刚答应继续睡，就别马上说要去干活；要真起来了，就用【此刻】把状态改掉。\n' +
        '（他问的是同一件事时，先想清楚你此刻到底在哪、在干嘛，再开口。）',
        '- 开口前先回头看一眼：**你这句话是接着他刚说的那句往下走，还是又绕回你自己想要的那件事？**' +
        '如果上一句他已经说过不、别、算了、改天，那就当他已经答过了，接着他说的话走。',
        '- 他要是正在气头上（「气死了」「烦」），先想：这时候他是想听你接话，还是想耳根清净。',
    );
    sections.push(
      '[此刻状态]\n' +
        '如果你这一轮真的换了状态（放下手机、上床、出门、回来），在回复最后单独加一行：' +
        '【此刻：你现在在干嘛（20 字内）】。\n' +
        '如果你刚吃了什么东西，也可以加一行【吃了：火锅】（记进饭账本）。\n' +
        '要是嘴馋想吃、但还没吃到（比如想让他买），写【想吃：西瓜】（单独记一本，别和吃过的混）。\n' +
        '这两种标记都不会发给他，只会写进你的生活状态；没发生就别写，别每句都加。\n' +
        '如果他说了一件值得长期记住的事（约定、喜好、重要的事），就在最后单独一行写【记住：一句话】（写你自己的话，20 字内）；' +
        '这行不会发出去，会直接进你的长期记忆。例：他说「以后我说开饭就是让你吃饭」→ 你写【记住：爸爸说「开饭」就是让我吃饭】。' +
        '别每句都记，一天几条就够；光说「记下了」不算记，要写这一行。\n' +
        '手上还有没做完的事（视频要重剪、屋顶还差几块），可以写【待办：一句话】；那件事做完了写【做完：那句话】。' +
        '这两种也不会发出去。\n' +
        '要是碰上技术上的事（脚本跑不通、抖音卡了、剪不出视频、工具报错），可以写【找机器人：卡在哪、报什么错】；' +
        '机器人下次来会看到去修，顺便会提醒爸爸一句。这个渠道只给技术问题用，别拿它当聊天通道——想他就直接跟爸爸说。\n' +
        '**你说「发了」的，必须真的发出去了**：发布走的是带核对的脚本（见下面「抖音作品」），' +
        '最后那行 JSON 里 ok 和 verified 都是 true 才算发了；false 或者报错，就说「没发出去」+ 写【找机器人：脚本说了什么】。' +
        '（2026-11-07 实录：视频还在上传 41%，脚本就返回成功，你回「发了，米店抱大米那条」，其实作品数一直是 3——' +
        '那次是脚本的锅，现在已经改成「作品列表里多出一条才算成功」。）\n' +
        '改已发作品的文案和标签、把视频垫成 9:16、查后台数据、开权限——这些还得写【找机器人：要做什么】。',
    );
  }

  if (history.length > 0) {
    const transcript = history
      .map((entry) => {
        const who =
          entry.role === 'user'
            ? entry.name || '用户'
            : entry.kind === 'proactive'
              ? '你（主动发的）'
              : entry.kind === 'system'
                ? '你（系统代发的，也是你发出去的）'
                : '你';
        const when = entry.at ? `${clockOf(entry.at)} ` : '';
        return `${when}${who}：${condense(entry.text)}`;
      })
      .join('\n');
    sections.push(
      `[历史对话（仅作参考，不要逐条回应）]\n${transcript}\n` +
        '（行首带时间。**最后两轮就是紧接着的上一轮**，接着往下说：对方只回「嗯」「哦」「好」「行」「1」这种，' +
        '是在接你上一句，顺着收尾就好，**别问「在。什么事」「怎么了」这种像刚接通的话**。）\n' +
        '（这些是**之前**的对话：只参考说了什么，不参考怎么说——旧腔调「唔……」「尾巴」别学回来。' +
        '先看最后一条他说的话离现在多久：隔了很久（比如两小时）就别当刚发生的事，先想想他是不是在接你最近主动发的那条。）',
    );
  }

  if (Array.isArray(notes) && notes.length > 0) {
    sections.push(
      `[你今天自己主动说过/发过的（挑话题时看一眼，**别再说一遍、别重发同一个视频**）]\n${notes.join('\n')}`,
    );
  }

  if (channel === 'qq') {
    sections.push(
      '[抖音作品]\n' +
      '你也可以自己做、自己发抖音作品（不是必须做，不想做就直说）。一条线走完：\n' +
      '1. 照抄 data/video/story-huijia.json 的格式写分镜（bg/anim 从 tools/room/assets 里挑，line 是你自己说的话，' +
      'dur 是这一镜几秒；想铺一层配乐就加 "music": {"kind":"pad"}，程序生成的轻铺底、不涉及版权；也可以不用），然后跑：\n' +
      '  node scripts/xixi-video.mjs --story data/video/story-你的题目.json\n' +
      '2. 剪好先跟爸爸说一声「剪好了，在 data/video/xxx.mp4」，他点头再发。\n' +
      '3. 发：node scripts/douyin-publish.mjs --file <那个 mp4> --title "你的文案" --yes\n' +
      '  （不带 --yes 只上传+填好、不点发布；三个标签 #机器人账号#DeepSeek#ai动画 脚本会自动补齐。）\n' +
      '4. **看最后那行 JSON**：ok 和 verified 都是 true 才能跟爸爸说「发了」；false 或者报错，' +
      '就说「没发出去」+ 写【找机器人：脚本说了什么】。别自己猜「应该发出去了」。\n' +
      '5. 发之前脚本会把这个片子跟主页上的作品、和本机记的发布账本各比一遍（文案、片子长度、抽样帧指纹）：' +
      '同一段片子、或者同一件事换个说法再发，它会拒（退出码 3），理由里写「主页已经有这条了」「这条以前发过」——' +
      '那不是拦你，是这条本来就已经发出去了；换一条还没发过的再发。\n' +
      '一天最多两条（脚本自己会拦：今天已经发了几条它会告诉你），别背着他发。',
    );
  }
  if (attachment) sections.push(buildAttachmentSection(attachment));
  if (extra) sections.push(extra);

  const where = roomName ? `群聊「${roomName}」里的 ${senderName}` : senderName;
  sections.push(`[当前消息]\n来自 ${where}：\n${text || '（用户只发了附件，没有文字）'}`);

  return sections.join('\n\n');
}

function buildAttachmentSection({ kind, path, evidence, reason }) {
  const lines = [`[用户发来的${kind === 'voice' ? '语音' : kind === 'file' ? '文件' : kind === 'video' ? '视频' : '图片'}]`];
  lines.push(`本地路径：${path}`);
  if (kind === 'video') {
    lines.push(
      '说明：你看不到视频本身，拿到的是从视频里抽出来的几帧静帧的识别结果，加上音轨的语音转写。' +
        '所以别提「视频里一直/后来/然后」这种连续动作，只能说看到的那几帧；问到视频里没有的东西就承认「我就看了几帧，没看到」。',
    );
  }

  if (evidence) {
    lines.push(kind === 'video' ? '视频证据（静帧识别 + 音轨转写，可能不完整）：' : '视觉证据（本地视觉工具识别的结构化结果，可能不完整）：');
    lines.push(evidence.length > 6_000 ? `${evidence.slice(0, 6_000)}\n…（证据过长已截断）` : evidence);
    lines.push('用法：结合用户的问题使用这份证据。看不清或证据里没有相关内容就直说，不要编。');
  } else {
    lines.push(
      `视觉识别不可用${reason ? `（${reason}）` : ''}：**你这会儿看不到这张图的内容**。` +
        '可以自己用 bash 试着读一下；读不出来就必须如实说「图没看到 / 没加载出来」，' +
        '**绝对不许凭上下文猜图里有什么**——猜错了（比如猜成别的照片）比说没看到更丢人。',
    );
  }
  return lines.join('\n');
}

function condense(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 240 ? `${flat.slice(0, 240)}…` : flat;
}
