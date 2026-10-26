#!/usr/bin/env node
/**
 * 抖音热榜（公开接口，不需要登录/签名）——给 agent 用来「刷抖音」。
 *
 *   node scripts/douyin-hot.mjs            # 默认前 10 条
 *   node scripts/douyin-hot.mjs --limit 20
 *
 * 输出：序号 + 标题 + 热度。失败返回非 0。
 */
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) || 10 : 10;

const ENDPOINTS = [
  'https://aweme.snssdk.com/aweme/v1/hot/search/list/',
  'https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/',
];

async function main() {
  let lastError;
  for (const url of ENDPOINTS) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      const list = json?.data?.word_list ?? json?.word_list ?? [];
      if (!Array.isArray(list) || list.length === 0) throw new Error('返回里没有 word_list');
      console.log(`抖音热榜（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）`);
      list.slice(0, limit).forEach((item, index) => {
        const word = item.word ?? item.sentence ?? item.word_cover?.title ?? '(无标题)';
        const hot = item.hot_value ?? item.hot_score ?? 0;
        const label = item.label_text || item.label || '';
        console.log(`${String(index + 1).padStart(2)}. ${word}${label ? `  [${label}]` : ''}  ${hot ? `热度 ${hot}` : ''}`);
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  console.error(`拿不到热榜：${lastError?.message ?? '未知错误'}`);
  process.exit(1);
}

main();
