// librarydate.test.js - 「最新一卷 / 最新发售日」纯函数单测
// 重点覆盖外部数据里的超常理输入：全角括号/全角数字、混着副标题的卷号、纯符号名、不存在的日期、
// 越界年份、Bangumi/VNDB 两种日期粒度混用。这些输入都来自真实接口，且都能把排序搞坏。
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { stripVolumeSuffix, seriesKey, seriesKeysOf, normalizeDate, latestDate, MIN_YEAR, MAX_YEAR } = require('../src/librarydate');

test('stripVolumeSuffix: 常见卷号写法都能剥干净（半角/全角/中英日）', () => {
  assert.equal(stripVolumeSuffix('冒険者酒場の料理人 (4)'), '冒険者酒場の料理人');
  assert.equal(stripVolumeSuffix('冒険者酒場の料理人（４）'), '冒険者酒場の料理人');
  assert.equal(stripVolumeSuffix('冒険者酒場の料理人 第4巻'), '冒険者酒場の料理人');
  // 卷号写在开头（【第3巻】…）时，若照剥会只剩「【」这种残渣，安全阀宁可原样保留，让它老老实实匹配不上
  assert.equal(stripVolumeSuffix('【第3巻】進撃の巨人'), '【第3巻】進撃の巨人');
  assert.equal(seriesKey('【第3巻】進撃の巨人') === seriesKey('進撃の巨人'), false, '残渣不能和本体撞成一条系列');
  assert.equal(stripVolumeSuffix('進撃の巨人 34巻'), '進撃の巨人');
  assert.equal(stripVolumeSuffix('進撃の巨人 34'), '進撃の巨人');
  assert.equal(stripVolumeSuffix('Harley Quinn in Paradise Vol. 3'), 'Harley Quinn in Paradise');
  assert.equal(stripVolumeSuffix('Harley Quinn in Paradise Volume 12'), 'Harley Quinn in Paradise');
  assert.equal(stripVolumeSuffix('Some Title #12'), 'Some Title');
  assert.equal(stripVolumeSuffix('諸星大二郎短編集成 第12集 月童'), '諸星大二郎短編集成');
  assert.equal(stripVolumeSuffix('[12]'), '[12]', '纯卷号没有系列信息可留，安全阀不剥');
  assert.equal(seriesKey('[12]'), '', '但它的键是空的，调用方会跳过');
});

test('stripVolumeSuffix: 不做多余猜测（名字里的数字不误伤）', () => {
  assert.equal(stripVolumeSuffix('LEVEL 1'), 'LEVEL', '空格+数字属于明确卷号写法，剥掉是有意的');
  assert.equal(stripVolumeSuffix('1Q84'), '1Q84');
  assert.equal(stripVolumeSuffix('5等分の花嫁'), '5等分の花嫁');
  assert.equal(stripVolumeSuffix(''), '');
  assert.equal(stripVolumeSuffix(null), '');
  assert.equal(stripVolumeSuffix(undefined), '');
  assert.equal(stripVolumeSuffix('   '), '');
});

test('seriesKey: 同系列的不同卷号/全角/大小写/标点写法归一成同一个键', () => {
  const base = seriesKey('冒険者酒場の料理人');
  assert.equal(seriesKey('冒険者酒場の料理人 (4)'), base);
  assert.equal(seriesKey('冒険者酒場の料理人 第5巻'), base);
  assert.equal(seriesKey('冒険者酒場の料理人（６）'), base);
  assert.equal(seriesKey(' 冒険者酒場の料理人 '), base);
  assert.equal(seriesKey('Harley Quinn in Paradise Vol. 3'), seriesKey('harley quinn in paradise'));
  assert.equal(seriesKey('Re:从零开始的异世界生活 3'), seriesKey('Re从零开始的异世界生活'), '冒号被去掉后应一致');
});

test('seriesKey: 空名/纯符号/单字符返回空键（否则无关条目会被串成一个系列）', () => {
  for (const bad of ['', '   ', null, undefined, '（4）', '()', '【】', '！？', '-', '、', 'あ', 'A']) {
    assert.equal(seriesKey(bad), '', JSON.stringify(bad) + ' 应得空键');
  }
  assert.equal(seriesKey('AB'), 'ab');
});

test('seriesKeysOf: 原名/中文名各取一键、去重、丢空键', () => {
  assert.deepEqual(seriesKeysOf('冒険者酒場の料理人 (4)', '冒险者酒场的料理人'), ['冒険者酒場の料理人', '冒险者酒场的料理人'].map(seriesKey));
  assert.deepEqual(seriesKeysOf('同名作品', '同名作品'), [seriesKey('同名作品')]);
  assert.deepEqual(seriesKeysOf('', null, '（5）'), []);
  assert.deepEqual(seriesKeysOf(), []);
});

test('normalizeDate: 年/年月/年月日三种粒度都补到合法日期', () => {
  assert.equal(normalizeDate('2024-03-05'), '2024-03-05');
  assert.equal(normalizeDate('2024-3-5'), '2024-03-05');
  assert.equal(normalizeDate('2024-3'), '2024-03-01');
  assert.equal(normalizeDate('2024'), '2024-01-01');
  assert.equal(normalizeDate('2024/03/05'), '2024-03-05');
  assert.equal(normalizeDate('2024.3.5'), '2024-03-05');
  assert.equal(normalizeDate('２０２４－０３－０５'), '2024-03-05', '全角数字/连字符经 NFKC 归一');
  assert.equal(normalizeDate(' 2024-03-05 '), '2024-03-05');
  assert.equal(normalizeDate(2024), '2024-01-01');
});

test('normalizeDate: TBA/空/乱码/越界年份/不存在的日期一律返回空串', () => {
  for (const bad of ['TBA', 'tba', '未知', '', '   ', null, undefined, {}, [], 'abc', '2024-13-01', '2024-00-10',
                     '2024-02-30', '2024-04-31', '1000-01-01', String(MIN_YEAR - 1), String(MAX_YEAR + 1), '99999']) {
    assert.equal(normalizeDate(bad), '', JSON.stringify(bad) + ' 应视为无日期');
  }
  assert.equal(normalizeDate(MIN_YEAR + '-01-01'), MIN_YEAR + '-01-01');
  assert.equal(normalizeDate(MAX_YEAR + '-12-31'), MAX_YEAR + '-12-31');
  assert.equal(normalizeDate('2024-02-29'), '2024-02-29', '闰年 2/29 合法');
  assert.equal(normalizeDate('2023-02-29'), '', '平年 2/29 不存在');
});

test('normalizeDate: 宽松前缀匹配也能挡住脏尾巴（不会产出非法日期）', () => {
  assert.equal(normalizeDate('2024-03-05T00:00:00Z'), '2024-03-05');
  assert.equal(normalizeDate('2024-03-05 发售'), '2024-03-05');
  assert.equal(normalizeDate('2024-03'), '2024-03-01');
  assert.equal(normalizeDate('2024-03-99'), '');
});

test('latestDate: 取更晚的一个，无效值视为不存在（用于只增不减回写）', () => {
  assert.equal(latestDate('2024-05-01', '2026-01-02'), '2026-01-02');
  assert.equal(latestDate('2026-01-02', '2024-05-01'), '2026-01-02');
  assert.equal(latestDate('2024', '2024-06-01'), '2024-06-01');
  assert.equal(latestDate('', '2024'), '2024-01-01');
  assert.equal(latestDate('2024', ''), '2024-01-01');
  assert.equal(latestDate('', ''), '');
  assert.equal(latestDate('TBA', null), '');
  assert.equal(latestDate('2024-02-30', '2023-12-31'), '2023-12-31', '非法日期不参与比较');
});
