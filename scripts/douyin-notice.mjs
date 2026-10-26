#!/usr/bin/env node
/**
 * 读她的抖音互动通知：谁 @ 了她、谁评论了她、谁回复了她。
 *
 *   node scripts/douyin-notice.mjs                 # 最近 15 条，一行一条
 *   node scripts/douyin-notice.mjs --json          # 完整 JSON（给程序用）
 *   node scripts/douyin-notice.mjs --at            # 只看 @我 的
 *   node scripts/douyin-notice.mjs --limit 30
 *
 * 只读，不会把通知标记成已读。桥接常驻时复用它的浏览器，不关它的页面。
 */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const limit = Number(option('--limit', 15)) || 15;
const wantsJson = flag('--json');
const onlyAt = flag('--at');

const { openBrowser, closeBrowser } = await import('./lib/douyin-browser.mjs');
const { readNotices, pickReplyable } = await import('./lib/douyin-notice.js');

const { context, remote, preexisting } = await openBrowser({ offscreen: true });
try {
  // 自己新开一页：别去动桥接正在用的那几页（以前复用桥接的页，两边互相踩）
  const page = await context.newPage();
  if (!String(page.url() ?? '').includes('douyin.com')) {
    await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    await new Promise((done) => setTimeout(done, 3_000));
  }

  const report = await readNotices(page);
  let items = report.items;
  if (onlyAt) items = items.filter((item) => item.atMe);
  items = items.slice(0, limit);

  if (wantsJson) {
    console.log(JSON.stringify({ ...report, items }, null, 2));
  } else if (items.length === 0) {
    console.log('没有通知（或者接口没返回）。');
    if (report.warnings.length) console.log(`问题：${report.warnings.join('；')}`);
  } else {
    const time = (value) => new Date((value || 0) * 1000).toLocaleString('zh-CN', { hour12: false });
    for (const item of items) {
      const who = item.nickname || '某人';
      const what = item.content || item.rootText || item.replyToText || '';
      const lines = [`${time(item.createTime)}  ${item.typeName}  ${who}`];
      if (what) lines.push(`    「${what.slice(0, 40)}」`);
      if (item.videoUrl) lines.push(`    ${item.videoUrl}`);
      console.log(lines.join('\n'));
    }
    const replyable = pickReplyable(items);
    if (replyable.length) console.log(`\n可以回一句的：${replyable.length} 条`);
    if (report.warnings.length) console.log(`\n注意：${report.warnings.join('；')}`);
  }
} finally {
  await closeBrowser(context, remote, preexisting);
}
