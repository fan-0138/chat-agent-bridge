/**
 * 抖音私信：判断一条消息是谁发的。
 *
 * 抖音网页版的私信列表里没有可靠的「发送方」字段：
 *  - `message.isMyMessage` **恒为 true**（连对方发的也是 true，实测过）；
 *  - 外层/内层 class 名完全一样；
 *  - 消息行都是整行宽，没有左右布局差异。
 *
 * 唯一稳定的信号是**头像落在列表左半边还是右半边**：
 *  - 对方：头像靠左；
 *  - 她：头像靠右。
 * 而且同一人连发时，**只有这一组最旧的那条带头像**，后面几条没有 ⇒ 要继承。
 * DOM 是「新的在上」（column-reverse），所以继承要从**旧往新**（倒着遍历）。
 *
 * 这里只放纯逻辑，DOM 读取在 douyin-channel.js 里；这样继承方向这种容易写反的
 * 地方能被单测盯住。
 */

/**
 * 给每条消息补上 from。
 * @param {Array<{own?: 'me'|'them'|'', text?: string}>} messages 最新的在前（DOM 顺序）
 * @returns {Array<{own: string, from: 'me'|'them'|'unknown', text: string}>}
 */
export function assignSides(messages) {
  const list = Array.isArray(messages) ? messages.map((item) => ({ ...item })) : [];
  let carry = '';
  // 倒着走 = 从旧到新；缺头像的继承前一条（真正说话的那个人）
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const own = list[i].own === 'me' || list[i].own === 'them' ? list[i].own : '';
    if (own) carry = own;
    list[i].own = own;
    list[i].from = own || carry || 'unknown';
  }
  return list;
}

/**
 * 最新一条如果是对面发的，就返回它；是自己发的（或认不出来但内容是自己刚发的）就返回 null。
 *
 * @param {Array<{from: string, text: string}>} messages 最新在前
 * @param {(text: string) => boolean} [isOurs] 认不出来时的兜底：这句话是不是刚发出去的
 */
export function pickInbound(messages, isOurs = () => false) {
  const first = messages?.[0];
  if (!first) return null;
  if (first.from === 'me') return null;
  if (first.from === 'them') return first;
  return isOurs(first.text) ? null : first;
}

/** 调试/日志用：把方向压成一行。 */
export function describeSides(messages) {
  return (messages ?? [])
    .map((item) => `${item.from === 'me' ? '我' : item.from === 'them' ? 'TA' : '?'}:${String(item.text ?? '').slice(0, 14)}`)
    .join(' | ');
}
/**
 * 抖音网页版渲染不了的消息（图片/表情/语音/分享卡片）只显示一句占位文案。
 * 这类消息往往没有头像，缺头像会被「继承上一条」误判成自己发的，
 * 于是整轮判成「对方还没回」—— 实测卡了主人好几条消息。
 * @param {string} text
 */
export const UNSUPPORTED_PATTERN = '暂不支持该消息类型|请到抖音手机端';

export function isUnsupportedMessage(text) {
  return new RegExp(UNSUPPORTED_PATTERN).test(String(text ?? ''));
}
