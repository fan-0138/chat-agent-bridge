import { existsSync } from 'node:fs';
import { openBrowser, closeBrowser, stealth } from './lib/douyin-browser.mjs';
if (existsSync('.env.qq') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env.qq');
const { context, remote, preexisting } = await openBrowser({ offscreen: true });
try {
  const page = await context.newPage();
  await stealth(page);
  await page.goto('https://creator.douyin.com/creator-micro/content/manage', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 11000));
  const info = await page.evaluate(() => {
    const text = document.body.innerText.replace(/\s+/g, ' ');
    return { url: location.href, head: text.slice(0, 1200) };
  });
  console.log(JSON.stringify(info, null, 1).slice(0, 2000));
  await page.screenshot({ path: '/tmp/manage.png' });
} finally {
  await closeBrowser(context, remote, preexisting).catch(() => {});
  process.exit(0);
}
