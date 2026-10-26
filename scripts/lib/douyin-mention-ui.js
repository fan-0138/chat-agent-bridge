/**
 * 评论区真 @ 人（唯一能保住 sec_uid 的路）。
 *
 * 结论（实测过）：API/XHR 直发时，服务端会把 mention 的 sec_uid 剥掉 ——
 * 名字照样变蓝，但点开是空页、对方**收不到通知**。
 * 只有前端「点选 @ 弹层里的那一行」时，编辑器内存里有完整用户对象，
 * 服务端才认这个来源、保住 sec_uid。
 *
 * 流程（照原样搬过来的，每一步都有踩坑理由）：
 *   ① 评论输入框滚进视口中心 → 真实鼠标点开（不在视口里点击不会展开）
 *   ② 点 .public-DraftEditor-content 聚焦
 *   ③ CDP 键盘事件打「@」（execCommand 不会触发弹层）
 *   ④ 等弹层 → 按昵称找**叶子节点里最窄的那个** → 真实鼠标点选
 *   ⑤ execCommand 补正文（不能重打「@昵称」，会重复）
 *   ⑥ 点输入框右下角红色箭头（svg 里 fill=FE2C55）发布
 *
 * 回复某条评论：先把那条评论滚进视口 → 点它下面的「回复」→ 再走 ①~⑥，
 * 前端会自动带上 reply 关系。
 */

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 「@主人 这句评」→「这句评」：点选 mention 后编辑器里已经有 @主人 了，别再插一遍。 */
export function stripLeadingMention(text, mention) {
  const body = String(text ?? '').trim();
  const lead = `@${mention}`;
  if (!mention || !body.startsWith(lead)) return body;
  return body.slice(lead.length).replace(/^[\s\u3000]+/, '');
}

/**
 * 在页面里找「昵称那一行」，并返回这一**行容器**的中心点。
 * 坑：点昵称那个文字节点不会选中（文字本身没有事件），必须点它所在的那一行；
 *     而那一行的父级往往是「多行列表」的容器，点父级中心会点到别的行上去。
 * 所以：从文字往上找，取「高度 ≤ 单行高度」的最外层容器。
 */
function findMentionRow(page, name) {
  return page.evaluate((needle) => {
    const leaves = [];
    for (const element of document.querySelectorAll('div,span,li,p')) {
      if (element.children.length > 0) continue;
      if ((element.innerText || '').trim() !== needle) continue;
      const rect = element.getBoundingClientRect();
      if (!(rect.width > 4 && rect.height > 8)) continue;
      leaves.push({ element, rect });
    }
    if (leaves.length === 0) return null;

    // 取最靠上、最窄的那个（弹层里同名会出现在最近联系人/搜索结果两处）
    leaves.sort((a, b) => a.rect.top - b.rect.top || a.rect.width - b.rect.width);
    const { element, rect: leafRect } = leaves[0];

    // 往上爬到「够宽的那一行」（实测：文字层 63×64，可点的那一行 235×88）
    let row = element;
    for (let up = 0; up < 5; up += 1) {
      const parent = row.parentElement;
      if (!parent) break;
      const bounds = parent.getBoundingClientRect();
      if (bounds.width < 60 || bounds.height < 20) break;
      if (bounds.height > 140) break; // 再往上就是整个弹层了
      row = parent;
      if (bounds.width >= 150) break; // 找到够宽的一行了
    }
    const bounds = row.getBoundingClientRect();
    return {
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      leaf: { x: Math.round(leafRect.x), y: Math.round(leafRect.y) },
    };
  }, name).catch(() => null);
}

/** 评论区里找包含某段文字的那条评论 → 返回它的坐标。 */
function findCommentByText(page, needle) {
  return page.evaluate((text) => {
    const nodes = [...document.querySelectorAll('[data-e2e="comment-item"], [class*="commentItem"], [class*="comment-item"]')];
    for (const node of nodes) {
      if (!(node.innerText || '').includes(text)) continue;
      node.scrollIntoView({ block: 'center' });
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    }
    return null;
  }, needle).catch(() => null);
}

/** 那条评论下面的「回复」按钮坐标。 */
function findReplyButton(page, needle) {
  return page.evaluate((text) => {
    const nodes = [...document.querySelectorAll('[data-e2e="comment-item"], [class*="commentItem"], [class*="comment-item"]')];
    for (const node of nodes) {
      if (!(node.innerText || '').includes(text)) continue;
      for (const element of node.querySelectorAll('span,div,button,a')) {
        if (element.children.length > 0) continue;
        if ((element.innerText || '').trim() !== '回复') continue;
        const rect = element.getBoundingClientRect();
        if (!(rect.width > 4 && rect.height > 8)) continue;
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      }
    }
    return null;
  }, needle).catch(() => null);
}

/** 输入框右下角的发布箭头。 */
function findSendButton(page) {
  return page.evaluate(() => {
    const root = document.getElementById('comment-input-container');
    if (!root) return null;
    for (const svg of root.querySelectorAll('svg')) {
      if (!String(svg.innerHTML || '').includes('FE2C55')) continue;
      let element = svg;
      for (let up = 0; up < 4 && element; up += 1) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 24 && rect.height > 24) {
          return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        }
        element = element.parentElement;
      }
    }
    // 兜底：常见的提交按钮 class
    for (const selector of ['[class*="commentInput"] [class*="submit"]', '[class*="comment-input"] button', '[class*="commentInput"] [role="button"]']) {
      const node = root.querySelector(selector);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width > 16 && rect.height > 16) {
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      }
    }
    return null;
  }).catch(() => null);
}

/**
 * @param {any} page
 * @param {string} url 视频页
 * @param {string} text 评论正文（可以带「@昵称」开头，会去掉避免重复）
 * @param {{mention: string, replyText?: string, dryRun?: boolean}} options
 */
export async function postCommentWithMention(page, url, text, { mention, replyText = '', dryRun = false } = {}) {
  if (!mention) return { ok: false, reason: '没有要给谁 @' };
  const awemeId = String(url).match(/\/video\/(\d{15,20})/)?.[1] ?? '';
  if (!awemeId) return { ok: false, reason: '视频链接里没有 19 位 id，打不开' };

  // 虚拟机里的 chromium 没 GPU，视频页很重：只等导航提交，再自己轮询输入框出现
  await page.goto(`https://www.douyin.com/video/${awemeId}`, { waitUntil: 'commit', timeout: 60_000 }).catch(() => {});
  for (let wait = 0; wait < 40; wait += 1) {
    const ready = await page.evaluate(() => Boolean(document.getElementById('comment-input-container'))).catch(() => false);
    if (ready) break;
    await sleep(1_000);
  }
  await sleep(2_500);

  // 回复某条评论：先滚到那条、点它下面的「回复」
  let repliedTo = null;
  if (replyText) {
    await page.evaluate(() => {
      document.querySelector('#comment-input-container')?.scrollIntoView({ block: 'center' });
    }).catch(() => {});
    await sleep(1_200);

    let hit = null;
    for (let attempt = 0; attempt < 20 && !hit; attempt += 1) {
      hit = await findCommentByText(page, replyText);
      if (!hit) {
        await page.evaluate(() => {
          const list = document.querySelector('[class*="commentList"], [class*="comment-list"]');
          if (list) list.scrollTop += 900;
          else window.scrollBy(0, 900);
        }).catch(() => {});
        await sleep(1_300);
      }
    }
    if (!hit) return { ok: false, reason: `评论区里找不到含「${replyText}」的评论` };

    const replyButton = await findReplyButton(page, replyText);
    if (!replyButton) return { ok: false, reason: '找到了那条评论，但它下面没有「回复」按钮' };
    await page.mouse.click(replyButton.x, replyButton.y);
    await sleep(1_800);
    repliedTo = replyText;
  }

  // ① 输入框滚进视口中心 → 真实鼠标点开
  const box = await page.evaluate(() => {
    const node = document.getElementById('comment-input-container');
    if (!node) return null;
    node.scrollIntoView({ block: 'center' });
    const rect = node.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  }).catch(() => null);
  if (!box) return { ok: false, reason: '找不到 #comment-input-container' };
  await page.mouse.click(box.x, box.y);
  await sleep(1_500);

  // ② 点 DraftJS 编辑器聚焦
  const editor = await page.evaluate(() => {
    const node = document.querySelector('.public-DraftEditor-content');
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  }).catch(() => null);
  if (!editor) return { ok: false, reason: '评论编辑器没展开（.public-DraftEditor-content 不存在）' };
  const cdp = await page.context().newCDPSession(page).catch(() => null);
  /** CDP 真实鼠标事件：Playwright 的 mouse.click 在 React 候选行上点不动（实测） */
  const clickAt = async (x, y, gap = 90) => {
    if (!cdp) {
      await page.mouse.click(x, y);
      return;
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }).catch(() => {});
    await sleep(250);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }).catch(() => {});
    await sleep(gap);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
  };
  await clickAt(editor.x, editor.y);
  await sleep(400);

  // 清空：抖音会保留草稿，上一次失败留下的「@谁 正文」会混进这一条。
  // 用键盘删（Ctrl+A / Backspace）而不是 execCommand —— DraftJS 只认键盘事件，
  // 直接改 DOM 会让它内部 state 和显示对不上，后面点 @ 候选行就点不动了。
  const editorTextNow = () =>
    page.evaluate(() => String(document.querySelector('.public-DraftEditor-content')?.innerText ?? '')).catch(() => '');
  // 草稿是异步回填的，可能删完又被塞回来 —— 最多清三次
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!String(await editorTextNow()).trim()) break;
    await clickAt(editor.x, editor.y);
    await sleep(200);
    await page.keyboard.press('Control+A').catch(() => {});
    await sleep(150);
    await page.keyboard.press('Backspace').catch(() => {});
    await sleep(500);
  }

  // ③ 用 CDP 打「@」——Playwright 的高层键盘事件有时不会触发弹层
  const raw = cdp
    ? {
        down: (opts) => cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...opts }),
        up: (opts) => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...opts }),
      }
    : null;
  if (raw) {
    await raw.down({ text: '@', key: '@', code: 'Digit2', windowsVirtualKeyCode: 50, nativeVirtualKeyCode: 50 }).catch(() => {});
    await raw.up({ key: '@', code: 'Digit2', windowsVirtualKeyCode: 50, nativeVirtualKeyCode: 50 }).catch(() => {});
  } else {
    await page.keyboard.type('@', { delay: 120 }).catch(() => {});
  }
  await sleep(1_800);

  // ④ 点弹层里的那一行
  const row = await findMentionRow(page, mention);
  if (!row) {
    cdp?.detach?.().catch?.(() => {});
    return { ok: false, reason: `@ 弹层里没找到「${mention}」（可能没互关 / 昵称不对）` };
  }
  // 先悬停再点：React 的候选行要靠 mouseenter 才把这一行设成「当前项」
  await clickAt(row.x, row.y);
  await sleep(1_800);

  // 只看 DOM 里有没有真正的 mention token —— 它的文字是账号昵称，可能和弹层里显示的名字不一样
  let mentionPicked = await page
    .evaluate(() => {
      const editor = document.querySelector('.public-DraftEditor-content');
      if (!editor) return false;
      return Boolean(editor.querySelector('.douyin_mention_word, [data-mention], a[href*="user"]'));
    })
    .catch(() => false);
  if (!mentionPicked) {
    // 没自动插入 token：退化成文字，至少名字是蓝的（会丢 sec_uid，对方可能收不到通知）
    await page
      .evaluate((lead) => {
        const node = document.querySelector('.public-DraftEditor-content');
        if (!node) return;
        node.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(node);
        range.collapse(true); // 开头
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('insertText', false, `${lead} `);
      }, `@${mention}`)
      .catch(() => {});
    await sleep(500);
  }

  // ⑤ 补正文
  const body = stripLeadingMention(text, mention);
  if (body) {
    await page
      .evaluate((value) => {
        const node = document.querySelector('.public-DraftEditor-content');
        if (!node) {
          const prefix = /[\s\u3000]$/.test(String(node.innerText ?? '')) ? '' : ' ';
        document.execCommand('insertText', false, prefix + value);
          return;
        }
        node.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(node);
        range.collapse(false); // 光标放到末尾，别插到 @ 前面
        selection.removeAllRanges();
        selection.addRange(range);
        const prefix = /[\s\u3000]$/.test(String(node.innerText ?? '')) ? '' : ' ';
        document.execCommand('insertText', false, prefix + value);
      }, body)
      .catch(() => {});
    await sleep(600);
  }
  const editorText = await page
    .evaluate(() => String(document.querySelector('.public-DraftEditor-content')?.innerText ?? '').slice(0, 120))
    .catch(() => '');

  if (dryRun) {
    await cdp?.detach?.().catch?.(() => {});
    return { ok: true, dryRun: true, editorText, popupRow: row, repliedTo, mentionPicked };
  }

  // ⑥ 点红色箭头发布
  const send = await findSendButton(page);
  if (!send) {
    await cdp?.detach?.().catch?.(() => {});
    return { ok: false, reason: '找不到发布箭头', editorText };
  }
  await clickAt(send.x, send.y);
  await sleep(4_000);

  const after = await page
    .evaluate(() => String(document.querySelector('.public-DraftEditor-content')?.innerText ?? '(gone)').slice(0, 60))
    .catch(() => '(gone)');
  await cdp?.detach?.().catch?.(() => {});

  return {
    ok: true,
    mention,
    mentionPicked,
    repliedTo,
    editorText,
    editorAfter: after,
    published: after.trim().length === 0 || after === '(gone)',
  };
}