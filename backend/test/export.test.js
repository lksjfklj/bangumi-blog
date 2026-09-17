// export.test.js - 导出文件（CSV / ICS）转义
// 背景：收藏数据里的 name / comment / tags 都是用户自己填的，导出后会被 Excel、WPS、
// Google Sheets 直接打开。不加处理时 =cmd|'/c calc'!A1 这类单元格会被当公式执行（DDE），
// =WEBSERVICE(...) 还能把本机数据往外部发。ICS 里漏掉单独一个 \r 会把日历行直接切断。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { csvEsc, escIcs } = require('../src/routes/extras');

const CR = String.fromCharCode(13); // 单独一个回车，用来测 ^[=+\-@\t\r] 这一支

test('csvEsc: = + - @ 制表符 回车 开头的值都加前导单引号断开公式', () => {
  assert.equal(csvEsc('=cmd|\'/c calc\'!A1'), "'=cmd|'/c calc'!A1");
  assert.equal(csvEsc('+1+1'), "'+1+1");
  assert.equal(csvEsc('-1+1'), "'-1+1");
  assert.equal(csvEsc('@SUM(1+1)'), "'@SUM(1+1)");
  assert.equal(csvEsc('\t=x'), "'\t=x");
  // 回车本身也要按 CSV 规则包引号，所以是 " ' <CR> =x "
  assert.equal(csvEsc(CR + '=x'), '"' + "'" + CR + '=x"');
  // 只加前导单引号就能挡住的公式前缀，不应额外改变内容
  assert.equal(csvEsc('=1+1'), "'=1+1");
});

test('csvEsc: 公式防护与引号包裹可以同时生效', () => {
  assert.equal(csvEsc('=HYPERLINK("http://evil/x","点我")'), '"\'=HYPERLINK(""http://evil/x"",""点我"")"');
});

test('csvEsc: 普通值不改变，逗号/引号/换行按 CSV 规则包裹', () => {
  assert.equal(csvEsc('普通名称'), '普通名称');
  assert.equal(csvEsc('123'), '123');
  assert.equal(csvEsc('含,逗号'), '"含,逗号"');
  assert.equal(csvEsc('说"引号'), '"说""引号"');
  assert.equal(csvEsc('换\n行'), '"换\n行"');
  assert.equal(csvEsc(null), '');
  assert.equal(csvEsc(undefined), '');
});

test('escIcs: 单独 \\r 也要转义（旧写法 /\\r?\\n/ 会漏）', () => {
  assert.equal(escIcs('a\rb'), 'a\\nb');
  assert.equal(escIcs('a\nb'), 'a\\nb');
  assert.equal(escIcs('a\r\nb'), 'a\\nb');
  assert.equal(escIcs('a\r\rb'), 'a\\n\\nb');
});

test('escIcs: 反斜杠/分号/逗号转义，其余控制字符剔除', () => {
  assert.equal(escIcs('a;b,c\\d'), 'a\\;b\\,c\\\\d');
  assert.equal(escIcs('a\u0000b\u0007c'), 'abc');
  assert.equal(escIcs('保留\t制表符'), '保留\t制表符');
  assert.equal(escIcs(null), '');
  assert.equal(escIcs(undefined), '');
});
