// watch.test.js - 番剧更新标题/文件大小解析单测（node:test）
// 注意：require 会触发模块内建表/回填的异步 IIFE，函数本身为纯同步解析。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { episodeOf, sizeToBytes } = require('../src/routes/watch');

test('episodeOf: 第X话/第X集（含全角数字）', () => {
  assert.equal(episodeOf('葬送的芙莉莲 第7话'), '第7话');
  assert.equal(episodeOf('咒术回战 第１２話'), '第12话');
  assert.equal(episodeOf('某番 第3.5集'), '第3.5话');
});

test('episodeOf: SxE 季集格式', () => {
  assert.equal(episodeOf('SPYxFAMILY S2E06 1080p'), 'S2E6');
  assert.equal(episodeOf('某番 S1E01 [1080P]'), 'S1E1');
});

test('episodeOf: 方括号 / 短划线 / 裸数字话数', () => {
  assert.equal(episodeOf('[VCB-Studio] 某番 [06]'), '第6话');
  assert.equal(episodeOf('某番 - 03 [1080P]'), '第3话');
  assert.equal(episodeOf('某番 12 [1080P]'), '第12话');
  assert.equal(episodeOf('某番 05v2 [1080P]'), '第5话');
});

test('episodeOf: 全话 / 特别篇 / 无话数', () => {
  assert.equal(episodeOf('某番 全24话'), '全24话');
  assert.equal(episodeOf('某番 剧场版'), '特别篇');
  assert.equal(episodeOf('某番 OVA'), '特别篇');
  assert.equal(episodeOf('某番 无标题'), '');
  assert.equal(episodeOf(''), '');
});

test('sizeToBytes: 各容量单位换算', () => {
  assert.equal(sizeToBytes('1.5 GB'), Math.round(1.5 * 2 ** 30));
  assert.equal(sizeToBytes('800 MB'), 800 * 2 ** 20);
  assert.equal(sizeToBytes('512 KiB'), 512 * 2 ** 10);
  assert.equal(sizeToBytes('2.25 TiB'), Math.round(2.25 * 2 ** 40));
  assert.equal(sizeToBytes('10 KB'), 10 * 2 ** 10);
});

test('sizeToBytes: 非法输入返回 0', () => {
  assert.equal(sizeToBytes(''), 0);
  assert.equal(sizeToBytes('0'), 0);
  assert.equal(sizeToBytes('abc'), 0);
  assert.equal(sizeToBytes(null), 0);
});

