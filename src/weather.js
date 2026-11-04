/**
 * 窗外真实天气。
 *
 * 以前她想事时写「窗帘缝里漏进白光」「外面在刮风」全是编的——我们从来没给过她天气。
 * 这里拿 open-meteo（免费、不用 key）取本地实况 + 今天的日出日落，落盘缓存，
 * 想事/聊天时当素材喂进去，房间页也能显示。
 *
 * 位置：优先环境变量 QQ_WEATHER_LAT / QQ_WEATHER_LON；
 * 没配就用 ipapi.co 查一次（结果缓存在 data/weather.json 里记着），查不到就退回杭州。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const FALLBACK = { lat: 30.27, lon: 120.15, place: '杭州' };
const REFRESH_MS = 30 * 60_000;

/** WMO weather code → 中文。够用就行，别列全表。 */
const CODE_TEXT = new Map([
  [0, '晴'],
  [1, '晴间多云'],
  [2, '多云'],
  [3, '阴'],
  [45, '雾'],
  [48, '冻雾'],
  [51, '小雨'],
  [53, '小雨'],
  [55, '中雨'],
  [56, '冻雨'],
  [57, '冻雨'],
  [61, '小雨'],
  [63, '中雨'],
  [65, '大雨'],
  [66, '冻雨'],
  [67, '冻雨'],
  [71, '小雪'],
  [73, '中雪'],
  [75, '大雪'],
  [77, '米雪'],
  [80, '阵雨'],
  [81, '阵雨'],
  [82, '暴雨'],
  [85, '阵雪'],
  [86, '阵雪'],
  [95, '雷阵雨'],
  [96, '雷阵雨带冰雹'],
  [99, '雷阵雨带冰雹'],
]);

/** 常见城市名中文化（IP 定位给的是英文名）。 */
const CITY_CN = new Map([
  ['Guangzhou', '广州'], ['Shenzhen', '深圳'], ['Beijing', '北京'], ['Shanghai', '上海'],
  ['Hangzhou', '杭州'], ['Chengdu', '成都'], ['Wuhan', '武汉'], ['Nanjing', '南京'],
  ['Xi\'an', '西安'], ['Chongqing', '重庆'], ['Tianjin', '天津'], ['Suzhou', '苏州'],
  ['Dongguan', '东莞'], ['Foshan', '佛山'], ['Zhuhai', '珠海'], ['Xiamen', '厦门'],
  ['Changsha', '长沙'], ['Zhengzhou', '郑州'], ['Qingdao', '青岛'], ['Hefei', '合肥'],
  ['Fuzhou', '福州'], ['Kunming', '昆明'], ['Nanning', '南宁'], ['Haikou', '海口'],
  ['Guangdong', '广东'], ['Zhejiang', '浙江'], ['Jiangsu', '江苏'], ['Sichuan', '四川'],
]);

export function cityLabel(name) {
  const text = String(name ?? '').trim();
  if (!text) return '';
  return CITY_CN.get(text) ?? text;
}

export function weatherText(code) {
  const n = Number(code);
  return CODE_TEXT.get(n) ?? (Number.isFinite(n) ? '说不清的天气' : '');
}

/** 雨天/雪天/晴天之类，房间窗光可以用。 */
export function weatherKind(code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return 'clear';
  if ((n >= 71 && n <= 77) || n === 85 || n === 86) return 'snow';
  if (n === 45 || n === 48) return 'fog';
  if (n >= 51 && n <= 67) return 'rain';
  if (n >= 80 && n <= 82) return 'rain';
  if (n >= 95) return 'storm';
  if (n >= 1 && n <= 3) return 'cloudy';
  return 'clear';
}

/**
 * 拼一句人话，给 prompt 用。
 * @param {any} weather
 * @param {number} [now]
 */
export function weatherLine(weather, now = Date.now()) {
  if (!weather || !weather.at) return '';
  const text = String(weather.text || '').trim();
  if (!text) return '';
  const fresh = now - Number(weather.at) < 2 * 3_600_000;
  const temp = Number.isFinite(Number(weather.tempC)) ? `${Math.round(Number(weather.tempC))}°C` : '';
  const place = weather.place ? `${weather.place}` : '';
  const bits = [`外面${text}`, temp].filter(Boolean).join(' ');
  const sun =
    weather.sunrise && weather.sunset
      ? `，今天日出 ${String(weather.sunrise).slice(-5)}，日落 ${String(weather.sunset).slice(-5)}`
      : '';
  const stale = fresh ? '' : '（数据是几小时前的）';
  return `${place ? `${place}，` : ''}${bits}${sun}${stale}`;
}

/** 只有网络请求超时/失败才退回缓存，别让天气挡住她说话。 */
async function fetchJson(url, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取天气：30 分钟内用缓存，过期就刷新；刷新失败退回旧缓存（或 null）。
 * @param {{root?: string, now?: number, fetchImpl?: Function, timeoutMs?: number, log?: any}} options
 */
export async function getWeather({ root = process.cwd(), now = Date.now(), fetchImpl = fetch, timeoutMs = 8_000, allowFetch = true, log } = {}) {
  const file = resolve(root, 'data/weather.json');
  let cached = null;
  try {
    cached = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    cached = null;
  }
  if (cached?.at && now - Number(cached.at) < REFRESH_MS) return cached;
  // 对话 prompt 里只读缓存：回消息不能被天气接口拖住
  if (!allowFetch) return cached ?? null;

  const env = process.env;
  let lat = Number(env.QQ_WEATHER_LAT);
  let lon = Number(env.QQ_WEATHER_LON);
  let place = String(env.QQ_WEATHER_PLACE || '').trim();

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    // 用上次查到的坐标，省一次请求；没有就问 ipapi
    if (cached?.lat && cached?.lon) {
      lat = Number(cached.lat);
      lon = Number(cached.lon);
      place = place || cached.place || '';
    } else {
      // 依次试几个免费的 IP 定位；ipapi.co 在国内经常 403
      for (const probe of [
        {
          url: 'https://ipwho.is/',
          read: (d) => ({ lat: d.latitude, lon: d.longitude, place: d.city || d.region || '' }),
        },
        {
          url: 'https://ipinfo.io/json',
          read: (d) => {
            const [la, lo] = String(d.loc || '').split(',').map(Number);
            return { lat: la, lon: lo, place: d.city || d.region || '' };
          },
        },
        {
          url: 'https://ifconfig.co/json',
          read: (d) => ({ lat: d.latitude, lon: d.longitude, place: d.city || d.region_name || '' }),
        },
      ]) {
        try {
          const info = await fetchJson(probe.url, timeoutMs, fetchImpl);
          const found = probe.read(info ?? {});
          if (Number.isFinite(Number(found.lat)) && Number.isFinite(Number(found.lon))) {
            lat = Number(found.lat);
            lon = Number(found.lon);
            place = place || found.place || '';
            break;
          }
        } catch (error) {
          log?.debug?.(`定位 ${probe.url} 失败：${error?.message ?? error}`);
        }
      }
    }
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    lat = FALLBACK.lat;
    lon = FALLBACK.lon;
    place = place || FALLBACK.place;
  }

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      '&current=temperature_2m,weather_code,is_day&daily=sunrise,sunset&timezone=auto&forecast_days=1';
    const data = await fetchJson(url, timeoutMs, fetchImpl);
    const current = data?.current ?? {};
    const daily = data?.daily ?? {};
    const fresh = {
      at: now,
      lat,
      lon,
      place,
      tempC: Number(current.temperature_2m),
      code: Number(current.weather_code),
      text: weatherText(current.weather_code),
      isDay: current.is_day === 1 || current.is_day === true,
      sunrise: Array.isArray(daily.sunrise) ? daily.sunrise[0] : undefined,
      sunset: Array.isArray(daily.sunset) ? daily.sunset[0] : undefined,
    };
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(fresh, null, 2)}\n`, 'utf8');
    return fresh;
  } catch (error) {
    log?.debug?.(`天气没取到：${error?.message ?? error}`);
    return cached ?? null;
  }
}