// browserplan.js - 番剧库（bgm.tv 网页榜单）抓取路径组装
//
// bgm.tv 的筛选入口是「路径段叠加」，没有可用的 query 参数版（实测 ?year=/?airtime= 一律被忽略）：
//   /anime/browser                 全库榜单
//   /anime/tag/科幻                 类型标签
//   /anime/tag/科幻/airtime/2024     类型标签 + 年份
//   /anime/tag/2026年7月             季度（bgm 的季度以「年+月」标签形式存在）
// 官网侧边栏的年份入口 /anime/browser/airtime/2024 看起来最正统，但整条 /anime/browser/* 子路径
// 都会被 Cloudflare 人机校验拦成 403（连 /anime/browser/rank 这种不存在的路径也是 403），
// 服务端抓不到；等价的年份标签 /anime/tag/2024年 可以正常抓取，且分页总数准确。
//
// 这里集中放「参数 -> 抓取路径 / 缓存键」的纯函数，原因是早期版本只在 tag 同时存在时才拼 airtime 段，
// 单独传 year（手编 URL，或从书籍库带过来的 ?year=2024）会被静默丢掉：
// 用户以为按年份筛过了，实际看到的还是全库榜单。

const BROWSER_SORTS = ['rank', 'trends', 'title'];
const DEFAULT_SORT = 'trends';

// 季度 2026-7 -> 标签「2026年7月」；格式不合法返回空串（由调用方保证已校验）
function seasonTag(airtime) {
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(airtime || ''));
  if (!m) return '';
  const month = Number(m[2]);
  // 月份越界（2026-13 / 2026-00）一律视为非法：既不拼出不存在的季度标签，也不污染缓存键
  if (month < 1 || month > 12) return '';
  return m[1] + '年' + month + '月';
}

// 输入为已校验的参数，返回本次抓取方案 { sort, tag, period, filtered }
//   tag    非空时拼进 /anime/tag/<tag>
//   period 非空时再拼 /airtime/<period>
// 优先级：季度（最具体，独占）> 类型标签(+年份) > 单独年份 > 全库
function buildBrowserPlan({ sort, tag, year, airtime } = {}) {
  const safeSort = BROWSER_SORTS.includes(sort) ? sort : DEFAULT_SORT;
  const season = seasonTag(airtime);
  // 季度独占：再叠加标签/年份会拼出 /anime/tag/2026年7月/airtime/2024 这种必然为空的条件
  if (season) return { sort: safeSort, tag: season, period: '', filtered: true };
  // 类型标签 + 年份：bgm 支持这种叠加（/anime/tag/<标签>/airtime/<年份>）
  if (tag) return { sort: safeSort, tag: tag, period: year || '', filtered: true };
  // 只给年份：走年份标签，确保「按年份筛选」真的生效，而不是被丢掉
  if (year) return { sort: safeSort, tag: year + '年', period: '', filtered: true };
  return { sort: safeSort, tag: '', period: '', filtered: false };
}

function browserListPath(plan, page) {
  const query = '?sort=' + plan.sort + '&page=' + page;
  if (!plan.tag) return '/anime/browser' + query;
  const base = '/anime/tag/' + encodeURIComponent(plan.tag);
  return (plan.period ? base + '/airtime/' + plan.period : base) + query;
}

// 缓存键沿用 <sort>:<tag>:<period>:<page> 结构：排序或任一筛选条件不同就是不同的键，不会互相串数据
function browserCacheKey(plan, page) {
  return 'bgm:browser:' + plan.sort + ':' + (plan.tag || '-') + ':' + (plan.period || '-') + ':' + page;
}

// 筛选列表的末尾页探测（bgm 筛选页的分页总数经常是「整个标签」的虚高值，需要二分探出真实末页）
function browserEndCacheKey(plan) {
  return 'bgm:browser:end:' + (plan.tag || '-') + ':' + (plan.period || '-');
}

module.exports = { BROWSER_SORTS, DEFAULT_SORT, buildBrowserPlan, browserListPath, browserCacheKey, browserEndCacheKey };
