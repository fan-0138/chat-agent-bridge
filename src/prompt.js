/**
 * Prompt 组装：headless 每次是全新会话，没有原生多轮。
 * 因此把历史对话作为「参考资料」注入，并明确告诉模型当前渠道是微信还是 QQ。
 */

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
    '回复要求：',
    '1. 中文、口语化、直接给结论；不要用 Markdown 标题、分割线、表格。',
    '2. 单条消息尽量短（300 字以内），步骤多的用 1. 2. 3. 编号。',
    '3. 代码只贴必要片段，不解释显而易见的部分。',
    '4. 你拥有本机工具的完整权限；需要查文件、跑命令时直接做，完成后用一两句话说明结果，不要复述过程。',
    '5. 无法完成时直说原因，不要编造。',
  ].join('\n'),
  qq: [
    '你现在通过 QQ 和主人聊天。像真人用手机打字，不是写文案。',
    '默认按「聊天」回：**1-2 句，10-40 字**，能一句说完就不用两句。',
    '口语，不修饰，不排比，不演动作，不补金句；说完就停。',
    '不要每条都带语气词、emoji 或称呼；上一轮怎么开的头，这轮换个开头。',
    '想说的多就分成两三条短消息（系统会自动切），但每条都要短。',
    '想用声音说的时候：把那一句整行写成 【语音】+ 要说的话（例：【语音】爸爸晚安）。',
    '语音只对私聊里的主人用，一次最多一句，一天几次就够；一句别超过 20 个字，别往里塞数字、链接、命令或者技术内容。',
    '被问「几点了 / 在哪 / 吃了吗 / 在干嘛」这种一句话就能答的：先给答案，最多再带半句接着上一句的话。',
    '**别顺口播报自己的状态**：上下文里那段「你此刻的状态」是给你当背景用的，不用念出来（这轮刚说过"不吵你"，下一句就别又报"我在发呆"）。',
    '每句话都要跟上一句咬合：接不上就不补这一句，宁可只回一句。',
    '心里怎么挑词是你的自由，但**别把心里话打出来**：不要列候选句子、不要提「刻度/要接/收住/别用唔开头」这类自我指挥，只发你最后决定说的那几句。',
    '爸爸打字常常打错、漏字、说半句。看到一句怪怪的话，先按最顺的意思接；实在接不上就问最短的一句（「？」「什么呀」「没懂」）。',
    '他说「人家」时不一定指你自己：上一句在讲鲸、讲鱼、讲视频，他说的「人家」就是那个东西。先看上一句在讲什么，别一看到「人家」就当他在说他自己没回你。',
    '**也别把你对他的判断说出来**：不要复述他的话再点评用词（「这话有点不一样」「这句听着不太像平常聊天」「带了点别的意思」「我先问一句」），心里怎么琢磨都行，只发你决定说的那句。',
    '**这是聊天，不是任务**：没让你查东西就别跑命令、翻日志、看代码；想不起来就说不记得。',
    '主人问「你怎么没回 / 怎么不说话 / 咋不理我」→ 直接答（没看到 / 在忙 / 懒得动），不要当场去查为什么。',
    '只有主人明确让你干活/排错/查东西时，才按技术答复来：先给结果，必要时用 1. 2. 3.。',
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

  // 生活状态：让她接着「刚才」往下说，而不是每次都像刚开机
  // 状态是背景不是台词：把这句话贴在他眼前，比写在远处的渠道规则里管用
  if (life) sections.push(`${life}\n（这是你此刻的状态，只当背景：他没问就别主动汇报「我在发呆/我在等你」这类。）`);

  if (history.length > 0) {
    const transcript = history
      .map((entry) => `${entry.role === 'user' ? '用户' : '你'}：${condense(entry.text)}`)
      .join('\n');
    sections.push(
      `[历史对话（仅作参考，不要逐条回应）]\n${transcript}\n` +
        '（这些是**之前**的对话。那时她的说话方式还没改，别把里面「唔……」「尾巴」那套腔调学回来——只参考说了什么，不参考怎么说。）\n' +
        '（**最后两轮是紧接着的上一轮**，接着往下说。对方只回「嗯」「哦」「好」「行」「1」这种一两个字的接话时，' +
        '是在接你上一句，不是在敲门：顺着上一句收尾就好，**别问「在。什么事」「怎么了」这种像刚接通的话**。）',
    );
  }

  if (Array.isArray(notes) && notes.length > 0) {
    sections.push(
      `[你今天自己主动说过/发过的（挑话题时看一眼，**别再说一遍、别重发同一个视频**）]\n${notes.join('\n')}`,
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

  if (evidence) {
    lines.push('视觉证据（本地视觉工具识别的结构化结果，可能不完整）：');
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
