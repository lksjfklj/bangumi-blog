// query.test.js - 分页/查询参数归一化
// 背景：这些参数全部来自 URL，用户可以传任意字符串、重复参数甚至数组。
// 任何 NaN/小数/负数漏进 SQL 都会变成 500 或者「LIMIT -1 = 不限制」这类越权行为。
const test = require('node:test');
const assert = require('node:assert');
const { strParam, clampInt, paging, escapeLike, LIKE_ESC, MAX_PAGE } = require('../src/query');

test('strParam: 数组只取第一个元素（?tag[]=a&tag[]=b）', () => {
  assert.strictEqual(strParam(['a', 'b']), 'a');
  assert.strictEqual(strParam(['a']), 'a');
});

test('strParam: 空数组/对象/布尔/null 回退默认值', () => {
  assert.strictEqual(strParam([], 'def'), 'def');
  assert.strictEqual(strParam({ a: 1 }, 'def'), 'def');
  assert.strictEqual(strParam(undefined, 'def'), 'def');
  assert.strictEqual(strParam(null, 'def'), 'def');
  assert.strictEqual(strParam(true, 'def'), 'def');
  assert.strictEqual(strParam('x'), 'x');
  assert.strictEqual(strParam(0), '0');
});

test('clampInt: 非数字/Infinity/空串回退默认值', () => {
  assert.strictEqual(clampInt('abc', 10, 1, 50), 10);
  assert.strictEqual(clampInt('1e309', 10, 1, 50), 10); // Infinity
  assert.strictEqual(clampInt('', 10, 1, 50), 10);
  assert.strictEqual(clampInt(undefined, 10, 1, 50), 10);
  assert.strictEqual(clampInt(['x'], 10, 1, 50), 10);
  assert.strictEqual(clampInt(NaN, 10, 1, 50), 10);
});

test('clampInt: 小数被截断成整数（SQLite 不接受小数 LIMIT）', () => {
  assert.strictEqual(clampInt('1.5', 10, 1, 50), 1);
  assert.strictEqual(clampInt('2.9', 10, 1, 50), 2);
  assert.ok(Number.isInteger(clampInt('3.7', 10, 1, 50)));
});

test('clampInt: 负数夹到下限，超大值夹到上限', () => {
  assert.strictEqual(clampInt('-1', 10, 1, 50), 1);
  assert.strictEqual(clampInt('-999', 10, 1, 50), 1);
  assert.strictEqual(clampInt('100000', 10, 1, 50), 50);
  assert.strictEqual(clampInt('1e15', 10, 1, 50), 50);
});

test('clampInt: 数组参数取首元素，不会变成 NaN', () => {
  assert.strictEqual(clampInt(['12', '99'], 10, 1, 50), 12);
  assert.strictEqual(clampInt(['abc'], 10, 1, 50), 10);
});

test('paging: 正常分页', () => {
  assert.deepStrictEqual(paging({ page: '3', size: '20' }, { defSize: 10, maxSize: 50 }),
    { page: 3, size: 20, limit: 20, offset: 40 });
});

test('paging: 缺省值', () => {
  assert.deepStrictEqual(paging({}, { defSize: 12, maxSize: 50 }),
    { page: 1, size: 12, limit: 12, offset: 0 });
});

test('paging: 脏参数一律回到安全值（原来是线上 500 的来源）', () => {
  assert.deepStrictEqual(paging({ size: '1.5' }), { page: 1, size: 1, limit: 1, offset: 0 });
  assert.deepStrictEqual(paging({ page: '1e309' }), { page: 1, size: 10, limit: 10, offset: 0 });
  assert.deepStrictEqual(paging({ size: '-1' }), { page: 1, size: 1, limit: 1, offset: 0 });
  assert.deepStrictEqual(paging({ page: '-5' }), { page: 1, size: 10, limit: 10, offset: 0 });
  assert.deepStrictEqual(paging({ page: ['2', '3'] }), { page: 2, size: 10, limit: 10, offset: 10 });
  assert.deepStrictEqual(paging({ size: '999999' }), { page: 1, size: 50, limit: 50, offset: 0 });
});

test('paging: size=-1 不再退化成「不限制」', () => {
  const { limit } = paging({ size: '-1' }, { defSize: 12, maxSize: 50 });
  assert.ok(limit >= 1 && limit <= 50);
});

test('paging: page 超大值被夹住，offset 不会溢出 int64', () => {
  const { page, offset } = paging({ page: '1e18' });
  assert.strictEqual(page, MAX_PAGE);
  assert.ok(Number.isSafeInteger(offset));
});

test('escapeLike: % _ \\ 全部转义', () => {
  assert.strictEqual(escapeLike('100%'), '100\\%');
  assert.strictEqual(escapeLike('a_b'), 'a\\_b');
  assert.strictEqual(escapeLike('c\\d'), 'c\\\\d');
  assert.strictEqual(escapeLike('plain'), 'plain');
});

test('LIKE_ESC: 是合法的 SQL ESCAPE 子句', () => {
  assert.strictEqual(LIKE_ESC, "ESCAPE '\\'");
});
