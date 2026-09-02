// title.test.js - 番名/话数/字幕组/画质解析单测（node:test）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTitle, extractEpisode, extractSubGroup, norm, stripSeason, snorm } = require('../src/title');

test('parseTitle: 常见字幕组发布标题', () => {
  const r = parseTitle('【喵萌奶茶屋】咒术回战 第二季 [07][1080p][繁日字幕][HEVC]');
  assert.equal(r.seriesTitle, '咒术回战');
  assert.equal(r.episode, '7');
  assert.equal(r.subGroup, '喵萌奶茶屋');
  assert.equal(r.quality, '1080P');
});

test('parseTitle: 短划线话数 + 画质括号', () => {
  const r = parseTitle('[Kisssub] 葬送的芙莉莲 - 01 [1080P][简繁内封][HEVC]');
  assert.equal(r.seriesTitle, '葬送的芙莉莲');
  assert.equal(r.episode, '1');
  assert.equal(r.subGroup, 'Kisssub');
  assert.equal(r.quality, '1080P');
});

test('parseTitle: SxE 季集格式——季号不当话数，SxE 由 episodeOf 单独处理', () => {
  const r = parseTitle('咒术回战 S2E13 1080p');
  assert.equal(r.seriesTitle, '咒术回战');
  assert.equal(r.episode, '');
});

test('parseTitle: Season 2 被剥离、话数取自方括号', () => {
  const r = parseTitle('[VCB-Studio] SPYxFAMILY Season 2 [06][Ma10p_1080p][x265_flac_aac]');
  assert.equal(r.episode, '6');
  assert.equal(r.subGroup, 'VCB-Studio');
  assert.equal(r.quality, '1080P');
  assert.ok(!/season/i.test(r.seriesTitle), '不应残留 Season 标记');
});

test('parseTitle: 空输入', () => {
  const r = parseTitle('');
  assert.deepEqual(r, { seriesTitle: '', episode: '', subGroup: '', quality: '' });
});

test('extractEpisode: 第X话 / 长连播集数 / 无话数', () => {
  assert.equal(extractEpisode('Fate/Grand Order 第5话'), '5');
  assert.equal(extractEpisode('ONE PIECE [1176]'), '1176');
  assert.equal(extractEpisode('某番剧 无标题'), '');
});

test('extractSubGroup: 只取第一个方括号且剔除月新番装饰', () => {
  assert.equal(extractSubGroup('[07月新番] 某番剧'), '');
  assert.equal(extractSubGroup('[喵萌奶茶屋&LoliHouse] 某番剧'), '喵萌奶茶屋&LoliHouse');
  assert.equal(extractSubGroup('无括号标题'), '');
});

test('norm / snorm: 全角转半角、去符号、繁转简', () => {
  assert.equal(norm('  [Test] 中文 Space_Underscore '), 'test中文spaceunderscore');
  assert.equal(snorm('妳好 世界'), '你好世界');
});

test('stripSeason: 剥离季号', () => {
  assert.equal(stripSeason('葬送的芙莉莲 第2季'), '葬送的芙莉莲');
  assert.equal(stripSeason('SPYxFAMILY Season 2'), 'SPYxFAMILY');
  assert.equal(stripSeason('进击的巨人 Final Season'), '进击的巨人 Final Season'); // 无季号的 Final Season 属于标题一部分
});


