#!/usr/bin/env node
/**
 * 抖音登录：开一个真的 Edge 窗口，用手机扫码（或手机号验证码）登录，
 * 登录态写进 data/douyin-profile/，之后 douyin-feed.mjs 直接复用。
 *
 *   node scripts/douyin-login.mjs            # 打开窗口，等你扫码（最多 10 分钟）
 *   node scripts/douyin-login.mjs --check    # 只检查登录态，不开窗口给人看
 *   node scripts/douyin-login.mjs --timeout 300
 *
 * 退出码：0=已登录，1=失败/超时。
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBrowser, closeBrowser, stealth, isLoggedIn, fetchSelf, pause, STATE_DIR, stamp, CDP_URL } from './lib/douyin-browser.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const TIMEOUT_S = Number(option('--timeout', 600));
const CHECK_ONLY = flag('--check');

async function main() {
  // 登录要看得见窗口扫码，必须自己起一个（别连桥接那个隐藏的）
  const { context, remote, preexisting } = await openBrowser({ offscreen: CHECK_ONLY, forceLaunch: true });
  if (remote) console.log(`连接虚拟机浏览器：${CDP_URL}`);

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await stealth(page);

    const before = await isLoggedIn(context);
    if (before.loggedIn) {
      console.log(`已经登录过了（cookie: ${before.names.join(', ')}）`);
      const self = await fetchSelf(context);
      if (self?.nickname) console.log(`账号：${self.nickname}${self.uniqueId ? `（抖音号 ${self.uniqueId}）` : ''}`);
      console.log('无需重复登录。要换号就删掉 data/douyin-profile/ 再来一次。');
      return 0;
    }

    if (CHECK_ONLY) {
      console.log('尚未登录。运行 node scripts/douyin-login.mjs 打开窗口扫码。');
      return 1;
    }

    console.log('正在打开抖音首页…');
    await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' });
    await page.bringToFront().catch(() => {});
    await pause(1_500, 2_500);

    // 把扫码弹窗点出来
    const loginEntry = page
      .locator('text=登录, [data-e2e="login-button"], #login-panel-new')
      .first();
    await loginEntry.click({ timeout: 8_000 }).catch(() => {});

    if (remote) {
      // 虚拟机里的浏览器没有窗口，把二维码截出来给人扫
      const qrPath = resolve(STATE_DIR, `login-qr-${stamp()}.png`);
      await page.screenshot({ path: qrPath }).catch(() => {});
      console.log('');
      console.log(`  📱 二维码已截图：${qrPath}`);
      console.log('     打开这张图，用手机抖音扫；二维码会过期，脚本会每 25 秒刷新一次。');
    }

    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║  窗口已打开，请用手机抖音扫码登录            ║');
    console.log(`  ║  最多等 ${String(TIMEOUT_S).padStart(4)} 秒，登录成功会自动关窗口      ║`);
    console.log('  ║  如果要短信验证/滑块，直接在弹出的窗口里做   ║');
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');

    const shotPath = resolve(STATE_DIR, `login-panel-${stamp()}.png`);
    await page.screenshot({ path: shotPath }).catch(() => {});
    console.log(`（窗口截图：${shotPath}）`);

    const deadline = Date.now() + TIMEOUT_S * 1_000;
    let tick = 0;
    while (Date.now() < deadline) {
      await pause(2_000, 2_500);
      const status = await isLoggedIn(context);
      tick += 1;
      if (status.loggedIn) {
        await pause(1_200, 2_000);
        const self = await fetchSelf(context);
        const okShot = resolve(STATE_DIR, `login-ok-${stamp()}.png`);
        await page.screenshot({ path: okShot }).catch(() => {});
        const record = {
          loggedInAt: new Date().toISOString(),
          nickname: self?.nickname ?? '',
          uniqueId: self?.uniqueId ?? '',
          uid: self?.uid ?? '',
          secUid: self?.secUid ?? '',
          followers: self?.followers ?? 0,
          cookies: status.names,
        };
        await writeFile(resolve(STATE_DIR, 'login.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        console.log('');
        console.log(`✅ 登录成功${self?.nickname ? `：${self.nickname}` : ''}${self?.uniqueId ? `（抖音号 ${self.uniqueId}）` : ''}`);
        console.log(`   cookie：${status.names.join(', ')}`);
        console.log(`   已保存到 data/douyin-profile/（下次直接用，不用再扫码）`);
        console.log(`   截图：${okShot}`);
        await pause(800, 1_200);
        return 0;
      }
      if (remote && tick % 12 === 0) {
        const qrPath = resolve(STATE_DIR, `login-qr-${stamp()}.png`);
        await page.screenshot({ path: qrPath }).catch(() => {});
        console.log(`  二维码已刷新：${qrPath}`);
      }
      if (tick % 15 === 0) {
        console.log(`  还在等…已等 ${Math.round((Date.now() - (deadline - TIMEOUT_S * 1_000)) / 1_000)}s`);
      }
    }

    console.error(`❌ ${TIMEOUT_S} 秒内没有检测到登录。窗口里如果已经登录了，重新跑一次 --check 试试。`);
    return 1;
  } finally {
    await closeBrowser(context, remote, preexisting);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`登录失败：${error?.message ?? error}`);
    process.exit(1);
  });