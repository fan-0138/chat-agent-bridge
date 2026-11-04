/**
 * 把「她这边出事了」发到爸爸 QQ。
 *
 * 单独一个文件的原因：桥接、想事循环、房间三处都要喊人，但它们不共用进程，
 * 统一走 scripts/notify.mjs（它自己读 .env.qq、调 qq-action 的 send_private_msg）。
 * 这里只负责「跑一下脚本，告诉我成没成」——失败返回 false，让 health 下次再试。
 */

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

export function createNotifier({ root = process.cwd(), log = console, timeoutMs = 30_000 } = {}) {
  const script = resolve(root, 'scripts/notify.mjs');
  return function notify(text) {
    const body = String(text ?? '').trim();
    if (!body) return Promise.resolve(false);
    return new Promise((done) => {
      execFile(process.execPath, [script, body], { cwd: root, timeout: timeoutMs }, (error, _stdout, stderr) => {
        if (error) {
          log?.warn?.(`喊人失败：${String(stderr || error.message).replace(/\s+/g, ' ').slice(0, 200)}`);
          return done(false);
        }
        return done(true);
      });
    });
  };
}