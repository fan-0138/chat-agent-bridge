import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cityLabel, getWeather, weatherKind, weatherLine, weatherText } from '../src/weather.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const at = (iso) => Date.parse(iso);

function fakeFetch({ weather, geo } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (url.includes('ipwho.is')) {
      if (!geo) throw new Error('定位挂了');
      return { ok: true, json: async () => geo };
    }
    if (url.includes('open-meteo.com')) {
      if (!weather) throw new Error('天气挂了');
      return { ok: true, json: async () => weather };
    }
    throw new Error(`没预料到的请求：${url}`);
  };
  return { impl, calls };
}

const sampleWeather = {
  current: { temperature_2m: 21.4, weather_code: 61, is_day: 1 },
  daily: { sunrise: ['2026-11-03T06:20'], sunset: ['2026-11-03T17:30'] },
};

test('天气代码 → 中文', () => {
  assert.equal(weatherText(0), '晴');
  assert.equal(weatherText(61), '小雨');
  assert.equal(weatherText(95), '雷阵雨');
  assert.equal(weatherText(1234), '说不清的天气');
  assert.equal(weatherText('x'), '');
});

test('天气种类 → 房间能用的分类', () => {
  assert.equal(weatherKind(0), 'clear');
  assert.equal(weatherKind(3), 'cloudy');
  assert.equal(weatherKind(61), 'rain');
  assert.equal(weatherKind(75), 'snow');
  assert.equal(weatherKind(45), 'fog');
  assert.equal(weatherKind(95), 'storm');
});

test('城市名中文化，认不出的保留原名', () => {
  assert.equal(cityLabel('Guangzhou'), '广州');
  assert.equal(cityLabel('Atlantis'), 'Atlantis');
  assert.equal(cityLabel(''), '');
});

test('weatherLine：一句人话，带日出日落和温度', () => {
  const line = weatherLine({ at: Date.now(), place: '广州', text: '小雨', tempC: 21.4, sunrise: '...06:20', sunset: '...17:30' });
  assert.match(line, /广州/);
  assert.match(line, /小雨/);
  assert.match(line, /21°C/);
  assert.match(line, /日出 06:20/);
  assert.match(line, /日落 17:30/);
  assert.equal(weatherLine(null), '');
});

test('getWeather：第一次走网络，写进缓存；30 分钟内不再请求', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weather-'));
  try {
    const { impl, calls } = fakeFetch({ weather: sampleWeather, geo: { latitude: 23.1, longitude: 113.2, city: 'Guangzhou' } });
    const now = at('2026-11-03T12:00:00Z');
    const first = await getWeather({ root: dir, now, fetchImpl: impl, log: quiet });
    assert.equal(first.text, '小雨');
    assert.equal(first.place, 'Guangzhou');
    assert.equal(first.tempC, 21.4);
    assert.ok(calls.some((u) => u.includes('open-meteo')));

    const before = calls.length;
    const second = await getWeather({ root: dir, now: now + 10 * 60_000, fetchImpl: impl, log: quiet });
    assert.equal(second.at, first.at);
    assert.equal(calls.length, before, '30 分钟内应该零请求');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getWeather：超过 30 分钟会刷新', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weather-refresh-'));
  try {
    await mkdir(join(dir, 'data'), { recursive: true });
    await writeFile(
      join(dir, 'data/weather.json'),
      JSON.stringify({ at: at('2026-11-03T08:00:00Z'), lat: 23.1, lon: 113.2, place: 'Guangzhou', text: '晴', tempC: 20 }),
      'utf8',
    );
    const { impl, calls } = fakeFetch({ weather: sampleWeather });
    const fresh = await getWeather({ root: dir, now: at('2026-11-03T12:00:00Z'), fetchImpl: impl, log: quiet });
    assert.equal(fresh.text, '小雨');
    assert.ok(calls.some((u) => u.includes('open-meteo')));
    const saved = JSON.parse(await readFile(join(dir, 'data/weather.json'), 'utf8'));
    assert.equal(saved.text, '小雨');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getWeather：网络全挂时退回旧缓存，不抛错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weather-stale-'));
  try {
    const cached = { at: at('2026-11-03T06:00:00Z'), lat: 23.1, lon: 113.2, place: 'Guangzhou', text: '多云', tempC: 25 };
    await mkdir(join(dir, 'data'), { recursive: true });
    await writeFile(join(dir, 'data/weather.json'), JSON.stringify(cached), 'utf8');
    const { impl } = fakeFetch({});
    const weather = await getWeather({ root: dir, now: at('2026-11-03T12:00:00Z'), fetchImpl: impl, log: quiet });
    assert.equal(weather.text, '多云');
    assert.match(weatherLine(weather, at('2026-11-03T12:00:00Z')), /几小时前/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getWeather：没有任何缓存又取不到，返回 null 而不是崩', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weather-empty-'));
  try {
    const { impl } = fakeFetch({});
    const weather = await getWeather({ root: dir, now: at('2026-11-03T12:00:00Z'), fetchImpl: impl, log: quiet });
    assert.equal(weather, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});