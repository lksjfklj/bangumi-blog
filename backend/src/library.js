// library.js - 本地内容库（漫画 / 轻小说 / Galgame·视觉小说）全量同步与查询
// 数据源：Bangumi v0 API /v0/subjects 全量列表（rank 排序）
//   书籍 type=1（含 platform/tags/meta_tags/rating）-> 漫画 / 轻小说
//   游戏 type=4（platform 恒为「游戏」，需按社区标签判定）-> galgame（全年龄 + R18 统一收录）
// 书籍分类规则：platform=漫画 -> 漫画；platform=小说 且 标签含「轻小说」 -> 轻小说
// 游戏分类规则：meta_tags ∪ 用户 tags 命中 GALGAME_MARKERS（Galgame/视觉小说/乙女/BL/GL…）
//            或 EROGE_MARKERS（R18/18禁/eroge/黄油/エロゲー…）-> galgame；
//            系列名命中 GALGAME_NAME_PATTERNS（逆转裁判/兰斯等被标成 AVG/RPG/SLG 的名作）也收录。
//            注意：AVG/ADV 不单独作为白名单（bgm 里塞尔达/大镖客等主机欧美大作同样带 AVG 标签）。
// 游戏同步带站长 Bangumi token 拉全量 rank 列表，R18(nsfw) 条目才可见；token 缺失时降级匿名抓取。
// 地区规则：按每本书的用户标签判定；明确标注为非中日韩地区的条目标记 blocked=1 排除；
//          未标注地区的条目保留（bgm 书籍库以中日韩为主），前端可用「地区」筛选只看已确认的中日韩。
const { bgm, getValidToken } = require('./bangumi');
const { pool } = require('./db');

// 允许地区（中，含香港台湾；日；韩）
const ALLOWED_REGIONS = ['日本', '中国', '韩国', '台湾', '香港'];
// bgm 书籍标签中实际出现的地区标签全集（用于排除非中日韩）
const REGION_TAGS = ['日本', '中国', '韩国', '台湾', '香港', '美国', '法国', '英国', '德国', '泰国', '俄罗斯', '意大利', '西班牙', '加拿大', '马来西亚', '印度', '巴西', '澳大利亚', '新加坡'];

const CATEGORY_PLATFORM = { manga: '漫画', lightnovel: '轻小说' };
const CATEGORY_SQL = { manga: "category = 'manga'", lightnovel: "category = 'lightnovel'", galgame: "category = 'galgame'" };

let syncing = false;
let lastSync = null; // { ok, at, counts }

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function tagNames(item) {
  const set = new Set();
  for (const t of (item.tags || [])) if (t && t.name) set.add(t.name);
  for (const m of (item.meta_tags || [])) if (m) set.add(m);
  return set;
}

function regionsOf(item) {
  const names = tagNames(item);
  return REGION_TAGS.filter(r => names.has(r));
}

// 返回 'manga' | 'lightnovel' | null
function classify(item) {
  const platform = item.platform || '';
  const names = tagNames(item);
  if (platform === '漫画') return 'manga';
  if (platform === '小说' && names.has('轻小说')) return 'lightnovel';
  return null;
}

// 返回 'galgame' | null：bgm 游戏条目的 platform 恒为「游戏」，无法像书籍那样按平台划分，
// 只能靠社区标签判定。meta_tags（官方/高权重标签）∪ 用户 tags 命中以下任一标记即视为 galgame：
//   - GALGAME_MARKERS：强题材标记（全年龄 galgame / 视觉小说 / 乙女 / BL / GL…）
//   - EROGE_MARKERS：成人向标记（R18 / 18禁 / eroge / 黄油…，bgm 的成人条目普遍会打这些标）
//   - GALGAME_NAME_PATTERNS：社区标成 AVG/推理/RPG/SLG 而非 Galgame 的经典系列（见下）
// 注意 AVG/ADV 不单独作为白名单：bgm 里塞尔达/大镖客等主机欧美大作同样带 AVG 标签，
// 按词面无条件收录会把整库主机游戏灌进来。想收紧/放宽范围时直接调整下面几份集合。
const GALGAME_MARKERS = [
  'Galgame', 'galgame', 'GAL', '视觉小说', 'VN', '文字冒险', '文字冒险游戏', '互动小说',
  '乙女', '乙女向', '乙女ゲー', '乙女ゲーム', '乙女系', 'BL', 'BLゲー', 'BLゲーム', 'GL'
];
const EROGE_MARKERS = [
  'R18', 'R-18', '18禁', '18X', '成人', '成人向', '成人游戏',
  'eroge', 'Eroge', 'EROGE', 'エロゲ', 'エロゲー', 'アダルト', 'アダルトゲーム',
  '黄油', '拔作', '抜きゲー', 'H-Game', 'Hgame', 'HGAME'
];
// 部分经典系列被 bgm 社区标成 AVG/推理/RPG/SLG 而不是 Galgame（如逆转裁判、逆转检事、兰斯），
// 单靠标签会把整条系列漏掉：命中条目名特征（中文/日文/英文名任一）的也一并收录。
const GALGAME_NAME_PATTERNS = [
  /逆[转轉]裁判|逆転裁判/,          // 逆转裁判 1-6 / 复苏的逆转 等全系列
  /Ace Attorney/i,                  // 英文标题
  /逆[转轉]检事|逆転検事/,          // 逆转检事 1/2
  /雷顿教授VS逆转裁判|レイトン教授VS逆転裁判/, // 雷逆（联动作品）
  /^兰斯|^ランス/,                  // 兰斯主系列（兰斯10/兰斯6后日谈…）
  /^鬼畜王兰斯|^鬼畜王ランス/,      // 鬼畜王兰斯
  /^戦国ランス/,                    // 战国兰斯（含 FD）
  /\bRance\b/i                      // 英文名（Rance 1/Quest/9/10…）
];
// 一些 bgm 用户会给纯主机/欧美向大作打「Galgame / 视觉小说 / 乙女 / R18」等玩笑标签
//（实测：最终幻想 X-2、密特罗德 融合、十字军之王3 等都被打成过 Galgame），
// 若放任不管会把方案A明确排除的塞尔达/FF/博德之门/任天堂全家桶等灌进 galgame tab。
// 命中以下条目名特征的主机/欧美主流系列直接排除（想再加系列时往这里补正则即可）。
const GALGAME_EXCLUDE_PATTERNS = [
  /塞尔达|ゼルダ|Zelda/i,                       // 塞尔达传说
  /密特罗德|银河战士|Metroid/i,                 // 密特罗德/银河战士
  /最终幻想|ファイナルファンタジー|Final Fantasy/i, // 最终幻想（含 X-2/纷争NT 等）
  /博德之门|柏德之门|Baldur'?s Gate|Baldurs Gate/i, // 博德之门
  /马里奥|马力欧|マリオ|Mario/i,                 // 马里奥
  /宝可梦|口袋妖怪|宠物小精灵|Pok[ée]mon/i,      // 宝可梦
  /异度之刃|异度神剑|ゼノブレイド|Xenoblade/i,   // 异度神剑
  /火焰之纹章|ファイアーエムブレム|Fire Emblem/i, // 火焰之纹章
  /星之卡比|卡比|Kirby/i,                        // 星之卡比
  /动物森友会|动物之森|Animal Crossing/i,        // 动物森友会
  /斯普拉遁|喷射战士|Splatoon/i,                 // 斯普拉遁
  /大乱斗|Smash Bros/i,                          // 任天堂明星大乱斗
  /艾尔登法环|エルデンリング|Elden Ring/i,       // 艾尔登法环
  /黑暗之魂|Dark Souls|血源|Bloodborne|只狼|Sekiro|恶魔之魂|Demon'?s Souls/i, // FromSoftware 魂系
  /荒野大镖客|Red Dead/i,                        // 荒野大镖客
  /侠盗猎车手|Grand Theft Auto|GTA/i,            // GTA
  /巫师|Witcher|上古卷轴|Elder Scrolls|天际|Skyrim|辐射|Fallout/i, // 欧美 ARPG 名作
  /赛博朋克2077|Cyberpunk 2077/i,                // 赛博朋克2077
  /使命召唤|Call of Duty|战地|Battlefield|光环|Halo/i, // 欧美 FPS
  /战神|God of War|刺客信条|Assassin'?s Creed/i, // 战神/刺客信条
  /怪物猎人|Monster Hunter|生化危机|Resident Evil|Biohazard|合金装备|Metal Gear/i, // 日系主机名作
  /十字军之王|Crusader Kings/i,                                      // 十字军之王（Paradox 大战略，被 bgm 用户打过 Galgame 玩笑标签）
  /千年战争|千年戦争/i,                                              // 千年战争Aigis（DMM 塔防手游，用户标签误带 R18）
  /偶像大师|偶像大師|アイドルマスター|THE iDOLM@STER|Idolmaster/i,    // 偶像大师（偶像育成，被用户打 GAL 玩笑标签）
  /P4U|Persona 4 Arena|アルティマックス|Ultimax/i                   // P4U2（女神异闻录4 格斗衍生作，被用户打视觉小说标签）
];
function classifyGame(item) {
  const text = [item && item.name, item && item.name_cn].filter(Boolean).join('\n');
  // 主机/欧美主流系列的玩笑标签（bgm 用户常给塞尔达/FF 等打 Galgame 标签）不进库
  if (GALGAME_EXCLUDE_PATTERNS.some(re => re.test(text))) return null;
  const names = tagNames(item);
  if (GALGAME_MARKERS.some(m => names.has(m))) return 'galgame';
  if (EROGE_MARKERS.some(m => names.has(m))) return 'galgame';
  return GALGAME_NAME_PATTERNS.some(re => re.test(text)) ? 'galgame' : null;
}
// 游戏全量同步已改为带站长 token（R18 条目在列表里可见），此列表降级为“保险兜底”：
// 仍可能漏收的经典/无标签条目（兰斯正传各代、逆转裁判主系列缺失项等）在此按 subject_id 定向补录，
// 每次游戏同步结束自动刷新。想再收某部作品时往数组里加 bgm subject id 即可。
const CURATED_GAME_IDS = [
  // —— 兰斯系列（多为 R18，兜底补录）——
  75442,  // 兰斯1 -寻找小光-（1989 初代）
  80316,  // 兰斯01 寻找小光（重制）
  75508,  // 兰斯02 -反叛的少女们-（重制）
  134929, // 兰斯03 利萨斯陷落（重制）
  83965,  // 兰斯4.1 ～拯救药工场！～
  83997,  // 兰斯4.2 ～天使组～
  11161,  // 兰斯5D：孤单的女孩子
  11168,  // 兰斯6 - 赛斯崩坏 -
  1795,   // 战国兰斯（兰斯7）
  19750,  // 兰斯8（Rance Quest）
  88739,  // 兰斯9 赫尔曼革命
  226254, // 兰斯10 决战
  11158,  // 鬼畜王兰斯
  // —— 逆转裁判主系列缺失项（无 Galgame 标签）——
  145434, // 逆转裁判6
  102690, // 大逆转裁判 成步堂龙之介的冒险
  192977, // 大逆转裁判2 成步堂龙之介的觉悟
  3236,   // 逆转检事
  11129,  // 逆转检事2
  18438   // 雷顿教授VS逆转裁判
];

// 获取站长（owner）的有效 Bangumi token：查库 + 失效自动刷新；找不到/刷新失败返回 null
async function getOwnerToken() {
  let token = null;
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE is_owner = 1 AND access_token IS NOT NULL LIMIT 1');
    if (rows && rows.length) token = await getValidToken(rows[0]);
  } catch (e) { token = null; }
  return token;
}

// 用站长 token 逐条拉取 CURATED_GAME_IDS 并 upsert；分类失败时按策展列表强制归入 galgame
async function importCuratedGames() {
  const token = await getOwnerToken();
  if (!token) return { ok: false, reason: '未获取到站长 Bangumi token，跳过策展补录' };
  const stmt = pool.getConnection();
  let added = 0;
  let failed = 0;
  try {
    for (const id of CURATED_GAME_IDS) {
      try {
        const item = await bgm('/v0/subjects/' + id, { token });
        const category = classifyGame(item) || 'galgame';
        const row = toRow(category, item);
        await stmt.query(
          'INSERT INTO library_subjects (subject_id, category, name, name_cn, image, air_date, rating_score, rating_total, rank, platform, tags, regions, blocked, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(subject_id, category) DO UPDATE SET ' +
          "name = excluded.name, name_cn = excluded.name_cn, image = excluded.image, " +
          "air_date = excluded.air_date, rating_score = excluded.rating_score, " +
          "rating_total = excluded.rating_total, rank = excluded.rank, platform = excluded.platform, " +
          "tags = excluded.tags, regions = excluded.regions, blocked = excluded.blocked, " +
          "updated_at = excluded.updated_at",
          [row.subject_id, row.category, row.name, row.name_cn, row.image, row.air_date,
           row.rating_score, row.rating_total, row.rank, row.platform, row.tags, row.regions, row.blocked, row.updated_at]
        );
        added++;
      } catch (e) {
        failed++;
        console.error('[library] 策展补录失败 subject=' + id + ':', e.message);
      }
      await delay(120);
    }
  } finally {
    stmt.release();
  }
  return { ok: true, added, failed };
}

// 是否应排除：有地区标签但没有任何允许地区（即明确非中日韩）
function isBlocked(regions) {
  if (!regions || !regions.length) return 0;
  return regions.some(r => ALLOWED_REGIONS.includes(r)) ? 0 : 1;
}

function toRow(category, item) {
  const regions = regionsOf(item);
  const imgs = item.images || {};
  const rating = item.rating || {};
  return {
    subject_id: item.id,
    category,
    name: item.name || '',
    name_cn: item.name_cn || '',
    image: imgs.common || imgs.medium || imgs.large || '',
    air_date: item.date || '',
    rating_score: rating.score || 0,
    rating_total: rating.total || 0,
    rank: rating.rank || 0,
    platform: item.platform || '',
    tags: JSON.stringify([...tagNames(item)]),
    regions: JSON.stringify(regions),
    blocked: isBlocked(regions),
    updated_at: Date.now()
  };
}

// 拉取指定类型条目全量（rank 排序，offset 分页，每页 50）
// stopOnRangeEnd：游戏库 offset 越界时 v0 列表接口返回 HTTP 400，视为已到库底（正常结束）
// token：传站长 Bangumi token 时列表请求带 Authorization（bgm 匿名请求隐藏 R18/nsfw 条目）
async function fetchByType(type, onBatch, { stopOnRangeEnd = false, token = null } = {}) {
  const limit = 50;
  let offset = 0;
  let total = 0;
  const auth = token ? { token } : {};
  for (;;) {
    let data;
    try {
      data = await bgm(`/v0/subjects?type=${type}&sort=rank&offset=${offset}&limit=${limit}`, auth);
    } catch (e) {
      // 游戏库已拉到底（offset 越界返回 400）
      if (stopOnRangeEnd && e && e.status === 400) break;
      // 失败重试一次（网络/限流），仍失败则抛错终止本次同步
      await delay(600);
      try {
        data = await bgm(`/v0/subjects?type=${type}&sort=rank&offset=${offset}&limit=${limit}`, auth);
      } catch (e2) {
        if (stopOnRangeEnd && e2 && e2.status === 400) break;
        throw e2;
      }
    }
    const batch = (data && data.data) || (Array.isArray(data) ? data : []);
    if (!batch.length) break;
    total += batch.length;
    if (onBatch) await onBatch(batch);
    if (batch.length < limit) break;
    offset += limit;
    await delay(60); // 轻微限速，避免触发反爬
  }
  return total;
}

async function fetchAllBooks(onBatch) { return fetchByType(1, onBatch); }
async function fetchAllGames(onBatch) {
  // 带站长 token 拉取：bgm 对匿名请求隐藏 R18(nsfw) 条目，带 token 才能把全年龄+R18 完整扫进来
  const token = await getOwnerToken();
  if (!token) console.warn('[library] 未获取到站长 Bangumi token，本次游戏同步看不到 R18(nsfw) 条目');
  return fetchByType(4, onBatch, { stopOnRangeEnd: true, token });
}

// 全量同步入库
// 默认只同步书籍（type=1，历史行为，12h 定时器沿用）；游戏（type=4）全量拉取较重，
// 仅在显式请求时同步：手动「重新同步」或调度器按 last_run_games 的 7 天周期触发。
// 可传 { types: [4] } 只同步游戏；{ types: [1, 4] } 书籍+游戏一起同步。
async function runSync(options = {}) {
  if (syncing) return { ok: false, reason: 'already syncing' };
  syncing = true;
  const started = Date.now();
  const types = Array.isArray(options && options.types) ? options.types.map(Number) : null;
  const doBooks = !types || types.includes(1);
  const doGames = !types || types.includes(4);
  try {
    await setMeta('status', 'syncing');
    const insertBatch = async (classifier, batch) => {
      const stmt = pool.getConnection();
      try {
        for (const item of batch) {
          const category = classifier(item);
          if (!category) continue;
          const row = toRow(category, item);
          await stmt.query(
            `INSERT INTO library_subjects (subject_id, category, name, name_cn, image, air_date, rating_score, rating_total, rank, platform, tags, regions, blocked, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(subject_id, category) DO UPDATE SET
               name = excluded.name, name_cn = excluded.name_cn, image = excluded.image,
               air_date = excluded.air_date, rating_score = excluded.rating_score,
               rating_total = excluded.rating_total, rank = excluded.rank, platform = excluded.platform,
               tags = excluded.tags, regions = excluded.regions, blocked = excluded.blocked,
               updated_at = excluded.updated_at`,
            [row.subject_id, row.category, row.name, row.name_cn, row.image, row.air_date,
             row.rating_score, row.rating_total, row.rank, row.platform, row.tags, row.regions, row.blocked, row.updated_at]
          );
        }
      } finally {
        stmt.release();
      }
    };
    if (doBooks) await fetchAllBooks((batch) => insertBatch(classify, batch));
    if (doGames) {
      await fetchAllGames((batch) => insertBatch(classifyGame, batch));
      // 匿名列表看不到的 R18/无 Galgame 标签经典系列，用站长 token 定向补录
      const curated = await importCuratedGames();
      if (!curated || !curated.ok) console.error('[library] 策展补录:', curated && curated.reason);
    }
    // 计数以库内实时数据为准（兼容只同步单类/多分类合并的场景），不再按本次抓取行数累加
    const mergedCounts = await liveCounts();
    lastSync = { ok: true, at: new Date().toISOString(), counts: mergedCounts };
    await setMeta('status', 'done');
    await setMeta('last_synced', lastSync.at); // 展示用：最近一次（任意分类）同步时间
    if (doBooks) await setMeta('last_run', lastSync.at);       // 书籍 12h 周期基准
    if (doGames) await setMeta('last_run_games', lastSync.at); // 游戏 7 天周期基准
    await setMeta('counts', JSON.stringify(mergedCounts));
    return { ok: true, counts: mergedCounts, elapsedMs: Date.now() - started };
  } catch (e) {
    lastSync = { ok: false, at: new Date().toISOString(), error: e.message };
    await setMeta('status', 'error');
    await setMeta('last_error', e.message);
    return { ok: false, error: e.message };
  } finally {
    syncing = false;
  }
}

// 从库内实时统计各分类已收录数量（blocked=1 为判定非中日韩地区、不参与展示的条目，不计入展示数）
async function liveCounts() {
  const counts = { manga: 0, lightnovel: 0, galgame: 0, total: 0, blocked: 0 };
  try {
    const [rows] = await pool.query(
      "SELECT category, COUNT(*) AS n FROM library_subjects WHERE blocked = 0 GROUP BY category"
    );
    for (const r of rows) {
      if (Object.prototype.hasOwnProperty.call(counts, r.category)) counts[r.category] = Number(r.n);
    }
    const [b] = await pool.query("SELECT COUNT(*) AS n FROM library_subjects WHERE blocked = 1");
    counts.blocked = Number((b && b[0] && b[0].n) || 0);
    counts.total = counts.manga + counts.lightnovel + counts.galgame;
  } catch (e) { /* ignore */ }
  return counts;
}

async function setMeta(key, value) {
  try {
    await pool.query(
      'INSERT INTO library_sync (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, String(value)]
    );
  } catch (e) { /* ignore */ }
}

async function getMeta(key) {
  try {
    const [rows] = await pool.query('SELECT value FROM library_sync WHERE key = ?', [key]);
    return rows.length ? rows[0].value : '';
  } catch (e) { return ''; }
}

// 定时同步：书籍每 12h（库为空则立即）；Galgame 库为空或距上次游戏同步超过 7 天时单独同步
async function ensureSync() {
  if (syncing) return;
  try {
    const [rows] = await pool.query('SELECT COUNT(*) AS n FROM library_subjects');
    const empty = !rows[0].n;
    const last = await getMeta('last_run');
    const stale = !last || (Date.now() - new Date(last).getTime() > 12 * 3600 * 1000);
    if (empty || stale) {
      await runSync();
    }
    if (syncing) return; // 书籍同步占用中，游戏交给下一轮/手动
    const [gRows] = await pool.query("SELECT COUNT(*) AS n FROM library_subjects WHERE category = 'galgame'");
    const lastGames = await getMeta('last_run_games');
    const gamesStale = !lastGames || (Date.now() - new Date(lastGames).getTime() > 7 * 24 * 3600 * 1000);
    if (!gRows[0].n || gamesStale) {
      await runSync({ types: [4] });
    }
  } catch (e) { console.error('[library] ensureSync fail:', e.message); }
}

async function syncStatus() {
  // 进程重启后内存态丢失，从数据库恢复上次同步状态
  let restored = null;
  try {
    const status = await getMeta('status');
    const last = await getMeta('last_synced') || await getMeta('last_run');
    if (last) {
      restored = { ok: status === 'done', at: last, counts: await liveCounts() };
    }
  } catch (e) { /* ignore */ }
  return { syncing, lastSync: lastSync || restored, meta: null };
}

// 本地库分页查询（category: manga / lightnovel / galgame）
async function queryLibrary({ category, page = 1, limit = 24, sort = 'rank', keyword = '', tag = '', year = '', region = '' }) {
  const where = [CATEGORY_SQL[category], 'blocked = 0'];
  const params = [];
  const kw = String(keyword).trim();
  if (kw) {
    where.push('(name LIKE ? OR name_cn LIKE ?)');
    const like = `%${kw}%`;
    params.push(like, like);
  }
  if (tag) {
    where.push('tags LIKE ?');
    params.push(`%"${tag}"%`);
  }
  if (/^\d{4}$/.test(year)) {
    where.push("substr(air_date, 1, 4) = ?");
    params.push(year);
  }
  if (region) {
    if (region === '未标注') {
      where.push("regions = '[]'");
    } else {
      where.push('regions LIKE ?');
      params.push(`%"${region}"%`);
    }
  }
  const whereSql = where.join(' AND ');
  const [totalRows] = await pool.query(`SELECT COUNT(*) AS n FROM library_subjects WHERE ${whereSql}`, params);
  const total = totalRows[0].n;
  const lastPage = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(Math.max(page, 1), lastPage);
  const offset = (safePage - 1) * limit;
  const order = sort === 'title' ? 'ORDER BY name_cn ASC, name ASC'
    : sort === 'rating' ? 'ORDER BY rating_score DESC, rating_total DESC'
    : 'ORDER BY rank ASC, rating_score DESC';
  const [rows] = await pool.query(
    `SELECT subject_id AS id, category, name, name_cn, image, air_date,
            rating_score, rating_total, rank, platform, tags, regions
     FROM library_subjects WHERE ${whereSql} ${order} LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const list = rows.map(r => {
    let tags = [], regions = [];
    try { tags = JSON.parse(r.tags || '[]'); } catch (e) {}
    try { regions = JSON.parse(r.regions || '[]'); } catch (e) {}
    const imgs = r.image ? { common: r.image, medium: r.image, large: r.image, grid: r.image, small: r.image } : undefined;
    return {
      id: r.id,
      // 游戏分类按 Bangumi 类型 4 输出，详情页/卡片才能正确显示「游戏」
      type: r.category === 'galgame' ? 4 : 1,
      category: r.category,
      name: r.name,
      name_cn: r.name_cn || r.name,
      images: imgs,
      air_date: r.air_date,
      rating: r.rating_total ? { score: r.rating_score, total: r.rating_total } : undefined,
      rank: r.rank || undefined,
      platform: r.platform,
      tags,
      regions
    };
  });
  return { data: list, total, page: safePage, limit, totalPages: lastPage, source: 'local' };
}

// 启动定时：进程启动后延时 5s 同步一次（不阻塞启动），之后每 12 小时一次
let timer = null;
function startScheduler() {
  if (timer) return;
  setTimeout(() => { ensureSync().catch(() => {}); }, 5000);
  timer = setInterval(() => { ensureSync().catch(() => {}); }, 12 * 3600 * 1000);
}

async function getStatus() {
  let s = null;
  try { s = await syncStatus(); } catch (e) {}
  return {
    module: 'library',
    syncing: !!(s && s.syncing),
    lastSync: s && s.lastSync ? { ok: !!s.lastSync.ok, at: s.lastSync.at, counts: s.lastSync.counts } : null
  };
}

module.exports = { runSync, ensureSync, startScheduler, syncStatus, queryLibrary, classify, classifyGame, importCuratedGames, regionsOf, getStatus };
