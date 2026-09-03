// routes/anime.js - 番剧数据（日历/搜索/条目/章节/角色/制作人员/相关）
const express = require('express');
const { bgm, bgmWeb, cached } = require('../bangumi');
const { queryLibrary, syncStatus, runSync, runVndbSync, vndbStatus, kickVndbEnrich } = require('../library');
const { pool } = require('../db');
const router = express.Router();

const SUBJECT_TYPES = { 1: 'book', 2: 'anime', 3: 'music', 4: 'game', 6: 'real' };

// 本周放送日历（Bangumi 旧版 /calendar 接口，含 7 天）
router.get('/calendar', async (req, res, next) => {
  try {
    const data = await cached('bgm:calendar', 30 * 60 * 1000, () => bgm('/calendar'));
    res.json(data);
  } catch (e) { next(e); }
});

// 搜索条目
// 注意：Bangumi v0 /v0/search/subjects 接口不支持 offset（永远只返回前 10 条），
// 所以默认使用旧版 /search/subject 接口（支持 start 分页，排序为相关度）。
// sort=rank 时使用 v0 接口（Bangumi 仅支持 match/rank），该模式只返回前 10 条（paginated:false）。
// Bangumi 不可达时回退到本地已导入的番剧库（collections 表）搜索。
router.post('/search', async (req, res, next) => {
  try {
    const { keyword = '', type = 2, page = 1, limit = 20, sort = 'match' } = req.body || {};
    const kw = String(keyword).trim().slice(0, 100);
    const types = (Array.isArray(type) && type.length) ? type.map(Number) : [Number(type)];
    const pageNum = Math.max(+(page) || 1, 1);
    const pageSize = Math.min(Math.max(+(limit) || 20, 1), 50);
    const offset = (pageNum - 1) * pageSize;

    if (!kw) {
      return res.json({ total: 0, limit: pageSize, offset: 0, data: [], error: '请输入关键词' });
    }

    // 评分排序：v0 接口支持 sort=rank，但只返回前 10 条
    if (sort === 'rank') {
      const key = 'bgm:searchv0:' + kw + ':' + types.join(',') + ':rank';
      const data = await cached(key, 10 * 60 * 1000, () =>
        bgm('/v0/search/subjects', {
          method: 'POST',
          body: { keyword: kw, sort: 'rank', filter: { type: types }, limit: 10, offset: 0 }
        })
      );
      return res.json({ total: (data && data.total) || 0, data: (data && data.data) || [], limit: 10, offset: 0, sort, paginated: false });
    }

    // 默认相关度：旧版搜索接口（支持 start 分页）
    const key = 'bgm:search:' + kw + ':' + types.join(',') + ':' + pageNum + ':' + pageSize;
    try {
      const data = await cached(key, 10 * 60 * 1000, async () => {
        const out = await bgm(`/search/subject/${encodeURIComponent(kw)}?type=${types.join(',')}&start=${offset}&max_results=${pageSize}`);
        return { total: (out && out.results) || 0, data: (out && out.list) || [] };
      });
      return res.json({ ...data, limit: pageSize, offset, sort: 'match', paginated: true });
    } catch (err) {
      // Bangumi 不可达：回退本地已导入番剧搜索
      const like = `%${kw}%`;
      const conds = ['(name LIKE ? OR name_cn LIKE ?)'];
      const params = [like, like];
      if (types.length === 1 && types[0]) {
        conds.push('subject_type = ?');
        params.push(types[0]);
      }
      const where = conds.join(' AND ') + ' AND user_id = (SELECT id FROM users WHERE is_owner = 1 LIMIT 1)';
      const [totalRows] = await pool.query(`SELECT COUNT(DISTINCT subject_id) AS n FROM collections WHERE ${where}`, params);
      const [rows] = await pool.query(
        `SELECT subject_id AS id, MAX(subject_type) AS type, MAX(name) AS name, MAX(name_cn) AS name_cn, MAX(image) AS image, MAX(subject_tags) AS subject_tags
         FROM collections WHERE ${where} GROUP BY subject_id ORDER BY MAX(updated_at) DESC LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );
      const list = rows.map(r => ({
        ...r,
        images: r.image ? { common: r.image, medium: r.image, large: r.image, grid: r.image, small: r.image } : undefined
      }));
      return res.json({ total: totalRows[0].n, data: list, limit: pageSize, offset, sort: 'match', paginated: true, source: 'local' });
    }
  } catch (e) { next(e); }
});

// 条目详情
router.get('/subjects/:id', async (req, res, next) => {
  try {
    const id = +req.params.id;
    const data = await cached('bgm:subject:' + id, 24 * 3600 * 1000, () => bgm('/v0/subjects/' + id));
    res.json(data);
  } catch (e) { next(e); }
});

// 章节（话数）
router.get('/subjects/:id/episodes', async (req, res, next) => {
  try {
    const id = +req.params.id;
    const offset = +(req.query.offset || 0);
    const limit = Math.min(+(req.query.limit || 100), 200);
    const key = `bgm:episodes:${id}:${offset}:${limit}`;
    const data = await cached(key, 24 * 3600 * 1000, () => bgm(`/v0/episodes?subject_id=${id}&offset=${offset}&limit=${limit}`));
    res.json(data);
  } catch (e) { next(e); }
});

// 角色
router.get('/subjects/:id/characters', async (req, res, next) => {
  try {
    const id = +req.params.id;
    const data = await cached('bgm:chars:' + id, 24 * 3600 * 1000, () => bgm(`/v0/subjects/${id}/characters`));
    res.json(data);
  } catch (e) { next(e); }
});

// 制作人员
router.get('/subjects/:id/persons', async (req, res, next) => {
  try {
    const id = +req.params.id;
    const data = await cached('bgm:persons:' + id, 24 * 3600 * 1000, () => bgm(`/v0/subjects/${id}/persons`));
    res.json(data);
  } catch (e) { next(e); }
});

// 相关条目
router.get('/subjects/:id/related', async (req, res, next) => {
  try {
    const id = +req.params.id;
    const data = await cached('bgm:related:' + id, 24 * 3600 * 1000, () => bgm(`/v0/subjects/${id}/subjects`));
    res.json(data);
  } catch (e) { next(e); }
});


// ---------- 番剧库浏览（Bangumi 网页榜单，经代理抓取；失败回退本地已导入番剧） ----------
const BROWSER_SORTS = ['rank', 'trends', 'title'];

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&apos;/g, "'");
}

function parseBrowserHtml(html) {
  const out = [];
  const chunks = String(html).split(/<li[^>]*id="item_(\d+)"/g);
  // chunks[0] = 前缀；之后每两项为一组：id、主体
  for (let i = 1; i + 1 < chunks.length; i += 2) {
    const id = +chunks[i];
    const body = chunks[i + 1];
    if (!id || !body) continue;

    const imgM = body.match(/<img[^>]+src="([^"]+)"/);
    const nameM = body.match(/<a href="\/subject\/\d+"[^>]*class="l"[^>]*>([\s\S]*?)<\/a>/);
    const origM = body.match(/<small class="grey">([\s\S]*?)<\/small>/);
    const rankM = body.match(/<span class="rank"><small>Rank <\/small>(\d+)<\/span>/);
    const rateM = body.match(/<small class="fade">([\d.]+)<\/small>/);
    const votesM = body.match(/\((\d+)人评分\)/);
    const infoM = body.match(/<p class="info tip">([\s\S]*?)<\/p>/);

    const nameCn = decodeEntities(nameM ? nameM[1] : '');
    const name = decodeEntities(origM ? origM[1] : '') || nameCn;
    let cover = imgM ? imgM[1].trim() : '';
    if (cover.startsWith('//')) cover = 'https:' + cover;

    let airDate = '';
    const infoText = decodeEntities(infoM ? infoM[1] : '').replace(/\s+/g, ' ').trim();
    const dateM = infoText.match(/(\d{4}年\d{1,2}月\d{1,2}日)/);
    if (dateM) airDate = dateM[1].replace(/年|月/g, '-').replace('日', '');

    out.push({
      id,
      type: 2,
      name,
      name_cn: nameCn || name,
      images: cover ? { common: cover, medium: cover, large: cover, grid: cover, small: cover } : undefined,
      rating: rateM ? { score: +rateM[1], total: votesM ? +votesM[1] : 0 } : undefined,
      rank: rankM ? +rankM[1] : undefined,
      air_date: airDate,
      info: infoText
    });
  }
  // 总页数（HTML 页码区：(&nbsp;1&nbsp;/&nbsp;1282&nbsp;)）
  let totalPages = 0;
  const pageM = html.match(/\(&nbsp;\d+&nbsp;\/&nbsp;(\d+)&nbsp;\)/);
  if (pageM) totalPages = +pageM[1];
  return { data: out, total: totalPages * 24, totalPages };
}

// 本地番剧库回退（Bangumi 网页不可达时）
async function localBrowserFallback(page, limit) {
  const ownerSub = '(SELECT id FROM users WHERE is_owner = 1 LIMIT 1)';
  const [totalRows] = await pool.query(
    `SELECT COUNT(DISTINCT subject_id) AS n FROM collections WHERE subject_type = 2 AND user_id = ${ownerSub}`
  );
  const total = totalRows[0].n;
  // 页码超界时回退到最后一页，避免返回空列表（前端会显示“没有找到相关内容”）
  const lastPage = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, lastPage);
  const offset = (safePage - 1) * limit;
  const [rows] = await pool.query(
    `SELECT subject_id AS id, MAX(subject_type) AS type, MAX(name) AS name, MAX(name_cn) AS name_cn,
            MAX(image) AS image, MAX(subject_tags) AS subject_tags
     FROM collections WHERE subject_type = 2 AND user_id = ${ownerSub}
     GROUP BY subject_id ORDER BY MAX(updated_at) DESC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  const list = rows.map(r => ({
    ...r,
    images: r.image ? { common: r.image, medium: r.image, large: r.image, grid: r.image, small: r.image } : undefined
  }));
  return { data: list, total, page: safePage, limit, totalPages: lastPage };
}

// 书籍库（漫画/轻小说）同步状态
router.get('/library/status', async (req, res, next) => {
  try {
    res.json(await syncStatus());
  } catch (e) {
    next(e);
  }
});
// VNDB 元数据回填（galgame 增强源）状态/进度/人工复查清单
router.get('/library/enrich/vndb/status', async (req, res, next) => {
  try { res.json(await vndbStatus()); } catch (e) { next(e); }
});
// 手动触发 VNDB 元数据回填（幂等、可续跑）：
//   dryRun=true 只试跑不写库（建议配 limit）；limit=N 处理够 N 个条目即暂停返回；
//   force=true 无视 30 天宽限期强制重刷；不带参数则整轮后台续跑并立即返回。
router.post('/library/enrich/vndb', async (req, res, next) => {
  try {
    const body = req.body || {};
    const limit = Math.min(Math.max(+(body.limit) || 0, 0), 5000);
    const force = !!(body.force);
    const dryRun = !!(body.dryRun);
    if (dryRun || limit > 0) {
      const result = await runVndbSync({ dryRun, limit: dryRun && !limit ? 200 : limit, force });
      return res.json(result);
    }
    const started = kickVndbEnrich();
    return res.json(started.ok ? { ok: true, started: true, message: 'VNDB 回填已在后台启动（幂等续跑，可随时再调）' } : started);
  } catch (e) { next(e); }
});

router.post('/library/sync', async (req, res, next) => {
  try {
    // 可选 body: { types: [1] | [4] }：只同步书籍或只同步游戏；缺省则两类全量同步
    const result = await runSync({ types: (req.body && req.body.types) || undefined });
    res.json(result);
  } catch (e) {
    next(e);
  }
});
// GET /api/anime/browser?page=1&sort=rank&tag=科幻&year=2024
router.get('/browser', async (req, res, next) => {
  try {
    // 本地内容库分类（漫画/轻小说/Galgame）：本地全量库查询，翻页无上限、支持地区/年份/标签/关键词筛选
    const category = String(req.query.category || '').trim();
    if (category === 'manga' || category === 'lightnovel' || category === 'galgame') {
      const sort = ['rank', 'title', 'rating'].includes(req.query.sort) ? req.query.sort : 'rank';
      const keyword = String(req.query.keyword || '').trim().slice(0, 100);
      const tag = /^[\u4e00-\u9fa5A-Za-z0-9 _\-·+]{1,20}$/.test(String(req.query.tag || '').trim()) ? String(req.query.tag).trim() : '';
      const year = /^(19\d{2}|20[0-2]\d)$/.test(String(req.query.year || '').trim()) ? String(req.query.year).trim() : '';
      const region = String(req.query.region || '').trim().slice(0, 10);
      const limit = 24;
      const out = await queryLibrary({ category, page: +(req.query.page) || 1, limit, sort, keyword, tag, year, region });
      return res.json(out);
    }
    // 限制最大页数：bgm.tv 网页榜单实测 420 页以内有内容、430 页起返回空页（约 1 万部为浏览上限）。
    // 超出会得到空页导致前端“翻不动/无内容”，因此固定可浏览上限为 420 页，并校准 total/totalPages。
    const MAX_BROWSER_PAGE = 420;
    let page = Math.min(Math.max(+(req.query.page) || 1, 1), MAX_BROWSER_PAGE);
    const limit = 24; // bgm.tv 榜单每页固定 24 条
    const sort = BROWSER_SORTS.includes(req.query.sort) ? req.query.sort : 'trends'; // 默认近期注目
    // 标签/年份筛选：bgm 网页筛选入口为 /anime/tag/<标签> 与 /anime/tag/<标签>/airtime/<年份>
    const rawTag = String(req.query.tag || '').trim().slice(0, 20);
    const tag = /^[\u4e00-\u9fa5A-Za-z0-9 _\-·+]{1,20}$/.test(rawTag) ? rawTag : '';
    const year = /^(19\d{2}|20[0-2]\d)$/.test(String(req.query.year || '').trim()) ? String(req.query.year).trim() : '';
    // 季度筛选：airtime 形如 2026-7；bgm 的季度浏览页实际是「2026年7月」标签
    const airtime = /^(19\d{2}|20[0-2]\d)-(0?[1-9]|1[0-2])$/.test(String(req.query.airtime || '').trim()) ? String(req.query.airtime).trim() : '';
    const airtimeTag = airtime ? (airtime.split('-')[0] + '年' + Number(airtime.split('-')[1]) + '月') : '';
    // 季度与类型标签二选一（bgm 链式标签不会叠加过滤，优先季度）
    const effTag = airtimeTag || tag;
    const period = (year && tag) ? year : '';
    const path = effTag
      ? (period ? '/anime/tag/' + encodeURIComponent(effTag) + '/airtime/' + period + '?sort=' + sort + '&page='
              : '/anime/tag/' + encodeURIComponent(effTag) + '?sort=' + sort + '&page=')
      : '/anime/browser?sort=' + sort + '&page=';

    const fetchPage = (p) => cached('bgm:browser:' + sort + ':' + (effTag || '-') + ':' + (period || '-') + ':' + p, 60 * 60 * 1000, async () => {
      const html = await bgmWeb(path + p, {
        headers: { Accept: 'text/html,application/xhtml+xml' }
      });
      const parsed = parseBrowserHtml(html);
      if (!parsed.data.length) {
        // 第 1 页就为空：该标签/年份筛选下没有内容；其他页为空：已超出实际内容范围
        if (p === 1 && effTag) return { data: [], totalPages: 1 };
        throw new Error('browser page empty');
      }
      // 校验：rank 榜非第 1 页却出现 Rank<=24 的条目 = bgm.tv 把越界页重定向回了第 1 页，拒绝该结果
      if (p > 1 && sort === 'rank' && parsed.data[0].rank && parsed.data[0].rank <= 24) {
        throw new Error('browser page out of range');
      }
      return parsed;
    });

    // 标签/年份模式：bgm 分页器上的总页数是按整个标签（全部年份）统计的，
    // 例如 /anime/tag/日常/airtime/2024 显示 4/35，但实际只有前 3 页有内容、第 4 页起为空。
    // 因此用二分探测出真实末页并缓存 1 小时，翻页/跳页时钳制到真实末页，避免空页与虚高的 totalPages。
    const findTagEnd = () => cached('bgm:browser:end:' + effTag + ':' + (period || '-'), 60 * 60 * 1000, async () => {
      const first = await fetchPage(1);
      if (!first.data.length) return { lastPage: 1 };
      const fakeTotal = Math.min(first.totalPages || MAX_BROWSER_PAGE, MAX_BROWSER_PAGE);
      let lo = 2, hi = fakeTotal, last = 1;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        try {
          const d = await fetchPage(mid);
          // 该页首条与第 1 页首条相同 = bgm 把越界页重定向回了第 1 页，同样视为超界
          if (d.data[0] && first.data[0] && d.data[0].id === first.data[0].id) throw new Error('browser page out of range');
          last = mid;
          lo = mid + 1;
        } catch (e) {
          hi = mid - 1;
        }
      }
      return { lastPage: last };
    });

    let data;
    let totalPages;
    if (effTag) {
      // 标签/年份/季度筛选：以真实末页为上限，跳页超界时钳制到真实末页
      const { lastPage } = await findTagEnd();
      page = Math.min(page, lastPage);
      data = await fetchPage(page);
      totalPages = lastPage;
    } else {
      try {
        data = await fetchPage(page);
      } catch (err) {
        // 请求页为空（通常是超界，如超出 420 页）：用第 1 页反推实际总页数，跳到最后一页重拉
        try {
          const first = await fetchPage(1);
          const realTotal = Math.min(first.totalPages || MAX_BROWSER_PAGE, MAX_BROWSER_PAGE);
          page = Math.min(Math.max(page, 1), realTotal);
          data = await fetchPage(page);
        } catch (e2) {
          throw e2; // 交给外层回退本地库
        }
      }
      totalPages = Math.min(data.totalPages || MAX_BROWSER_PAGE, MAX_BROWSER_PAGE);
      // 兜底：解析出的总页数仍小于请求页时，同步跳到最后一页重新拉取
      if (totalPages >= 1 && page > totalPages) {
        page = totalPages;
        data = await fetchPage(page);
        totalPages = Math.min(data.totalPages || totalPages, MAX_BROWSER_PAGE);
      }
    }
    const total = (data.data && data.data.length ? totalPages : 0) * limit;
    return res.json({ ...data, page, limit, totalPages, total, source: 'bgm' });
  } catch (e) { next(e); }
});
module.exports = router;


