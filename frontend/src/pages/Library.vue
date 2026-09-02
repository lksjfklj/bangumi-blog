<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NInput, NSelect, NButton, NPagination, NSpin, NEmpty, NAlert } from 'naive-ui';
import { api } from '../api';
import SubjectCard from '../components/SubjectCard.vue';

const route = useRoute();
const router = useRouter();

// 番剧库：番剧（Bangumi 网页榜单）/ 漫画、轻小说（本地全量同步库）
const mode = ref('browse'); // browse | search
const keyword = ref('');
const searchType = ref(2);
const browseSort = ref('trends'); // 番剧默认「近期注目」（书籍默认排名，见 defaultBrowseSort）
const page = ref(1);
const size = 24;
const result = ref([]);
const total = ref(0);
const loading = ref(false);
const errorMsg = ref('');
const localMode = ref(false);
const browseTag = ref(null);    // 标签筛选
const browseYear = ref(null);   // 年份筛选
const browseAirtime = ref(null); // 季度筛选（番剧，如 2026-7）
const browseRegion = ref(null); // 地区筛选（书籍）
const category = ref('anime'); // anime | manga | lightnovel
const libStatus = ref(null);  // 书籍库同步状态

const categories = [
  { label: '番剧', value: 'anime' },
  { label: '漫画', value: 'manga' },
  { label: '轻小说', value: 'lightnovel' }
];
const isBook = computed(() => category.value !== 'anime');
// 默认排序：番剧按「近期注目」，书籍按排名
const defaultBrowseSort = computed(() => isBook.value ? 'rank' : 'trends');

const typeOptions = [
  { label: '动画', value: 2 },
  { label: '书籍', value: 1 },
  { label: '音乐', value: 3 },
  { label: '游戏', value: 4 },
  { label: '三次元', value: 6 }
];
// 番剧排序（bgm.tv 榜单）；书籍排序（本地库）
const browseSortOptions = computed(() => isBook.value
  ? [
      { label: '按排名', value: 'rank' },
      { label: '按名称', value: 'title' },
      { label: '按评分', value: 'rating' }
    ]
  : [
      { label: '近期注目', value: 'trends' },
      { label: '按排名', value: 'rank' },
      { label: '按名称', value: 'title' }
    ]
);
// 标签筛选（bgm 常用标签）
const ANIME_TAG_OPTIONS = [
  { label: '日常', value: '日常' },
  { label: '科幻', value: '科幻' },
  { label: '恋爱', value: '恋爱' },
  { label: '奇幻', value: '奇幻' },
  { label: '冒险', value: '冒险' },
  { label: '战斗', value: '战斗' },
  { label: '机战', value: '机战' },
  { label: '悬疑', value: '悬疑' },
  { label: '推理', value: '推理' },
  { label: '运动', value: '运动' },
  { label: '音乐', value: '音乐' },
  { label: '搞笑', value: '搞笑' },
  { label: '萌系', value: '萌系' },
  { label: '治愈', value: '治愈' },
  { label: '催泪', value: '催泪' },
  { label: '校园', value: '校园' },
  { label: '后宫', value: '后宫' },
  { label: '百合', value: '百合' },
  { label: '乙女', value: '乙女' },
  { label: '耽美', value: '耽美' },
  { label: '历史', value: '历史' },
  { label: '战争', value: '战争' },
  { label: '猎奇', value: '猎奇' },
  { label: '惊悚', value: '惊悚' }
];
const BOOK_TAG_OPTIONS = [
  { label: '恋爱', value: '恋爱' },
  { label: '科幻', value: '科幻' },
  { label: '奇幻', value: '奇幻' },
  { label: '日常', value: '日常' },
  { label: '校园', value: '校园' },
  { label: '悬疑', value: '悬疑' },
  { label: '推理', value: '推理' },
  { label: '热血', value: '热血' },
  { label: '治愈', value: '治愈' },
  { label: '搞笑', value: '搞笑' },
  { label: '冒险', value: '冒险' },
  { label: '战斗', value: '战斗' },
  { label: '运动', value: '运动' },
  { label: '音乐', value: '音乐' },
  { label: '百合', value: '百合' },
  { label: '后宫', value: '后宫' },
  { label: '少年', value: '少年' },
  { label: '少女', value: '少女' },
  { label: '青年', value: '青年' },
  { label: '历史', value: '历史' },
  { label: '恐怖', value: '恐怖' },
  { label: '惊悚', value: '惊悚' },
  { label: '战争', value: '战争' },
  { label: '萌系', value: '萌系' },
  { label: '青春', value: '青春' },
  { label: '已完结', value: '已完结' },
  { label: '原创', value: '原创' },
  { label: '文学', value: '文学' }
];
const TAG_OPTIONS = computed(() => isBook.value ? BOOK_TAG_OPTIONS : ANIME_TAG_OPTIONS);
const REGION_OPTIONS = [
  { label: '全部地区', value: '' },
  { label: '日本', value: '日本' },
  { label: '中国', value: '中国' },
  { label: '韩国', value: '韩国' },
  { label: '台湾', value: '台湾' },
  { label: '香港', value: '香港' },
  { label: '未标注', value: '未标注' }
];
const yearOptions = computed(() => {
  const y = new Date().getFullYear();
  const arr = [];
  for (let i = y; i >= 1950; i--) arr.push({ label: String(i), value: String(i) });
  return arr;
});
// 季度筛选选项（1/4/7/10 月，往前推 15 年）
const quarterOptions = computed(() => {
  const now = new Date();
  const arr = [];
  for (let y = now.getFullYear(); y >= now.getFullYear() - 15; y--) {
    for (const m of [10, 7, 4, 1]) {
      if (y === now.getFullYear() && m > now.getMonth() + 1) continue;
      arr.push({ label: y + '年' + m + '月番', value: y + '-' + m });
    }
  }
  return arr;
});
const airtimeLabel = computed(() => {
  const o = quarterOptions.value.find(q => q.value === browseAirtime.value);
  return o ? o.label : '';
});
// 搜索模式排序（Bangumi 搜索接口仅支持相关度/评分）
const searchSort = ref('match');

const sortValue = computed({
  get: () => (mode.value === 'browse' || isBook.value ? browseSort.value : searchSort.value),
  set: (v) => { if (mode.value === 'browse' || isBook.value) browseSort.value = v; else searchSort.value = v; }
});

const from = computed(() => (page.value - 1) * size + 1);
const to = computed(() => (page.value - 1) * size + result.value.length);

const HOT = computed(() => {
  if (category.value === 'manga') return ['海贼王', '进击的巨人', '灌篮高手', '鬼灭之刃', '葬送的芙莉莲'];
  if (category.value === 'lightnovel') return ['无职转生', '刀剑神域', '关于我转生变成史莱姆这档事', '魔法禁书目录', '凉宫春日的忧郁'];
  return ['进击的巨人', '孤独摇滚', '葬送的芙莉莲', '间谍过家家', '鬼灭之刃'];
});
const catLabel = computed(() => categories.find(c => c.value === category.value)?.label || '番剧');
const emptyDescription = computed(() => {
  if (isBook.value) return '没有找到相关内容（书籍库同步完成后可浏览全部' + catLabel.value + '）';
  if (mode.value === 'search' && keyword.value.trim()) return '🔍 没有找到「' + keyword.value.trim() + '」…换个关键词试试，或点上方热门标签';
  return '没有找到相关内容';
});

let loadSeq = 0;
async function load() {
  const seq = ++loadSeq;
  loading.value = true;
  errorMsg.value = '';
  localMode.value = false;
  try {
    let d;
    if (mode.value === 'search' && !isBook.value) {
      d = await api.post('/anime/search', {
        keyword: keyword.value,
        type: searchType.value,
        sort: searchSort.value,
        page: page.value,
        limit: size
      });
    } else {
      let url = '/anime/browser?page=' + page.value + '&sort=' + browseSort.value;
      if (isBook.value) url += '&category=' + category.value;
      if (keyword.value.trim()) url += '&keyword=' + encodeURIComponent(keyword.value.trim());
      if (browseTag.value) url += '&tag=' + encodeURIComponent(browseTag.value);
      if (browseYear.value) url += '&year=' + browseYear.value;
      if (!isBook.value && browseAirtime.value) url += '&airtime=' + browseAirtime.value;
      if (browseRegion.value) url += '&region=' + encodeURIComponent(browseRegion.value);
      d = await api.get(url);
    }
    if (seq !== loadSeq) return; // 快速翻页时，丢弃过期响应，避免旧页内容覆盖新页
    // 页码超界：后端已把 page 钳制到安全页，这里同步分页显示并直接用返回的安全页数据
    const totalPages = d.totalPages || (d.total > 0 ? Math.ceil(d.total / size) : 1);
    if (page.value > totalPages) {
      const target = d.page && d.page > 0 ? d.page : totalPages;
      page.value = target;
      loadSeq++; // 作废当前响应
      result.value = d.data || [];
      total.value = d.total || 0;
      if (d.source === 'local') localMode.value = true;
      errorMsg.value = '已超出可浏览范围，已自动跳转到最后一页（第 ' + target + ' 页）';
      loading.value = false;
      return;
    }
    result.value = d.data || [];
    total.value = d.total || 0;
    if (d.source === 'local') localMode.value = true;
    if (d.error) errorMsg.value = d.error;
  } catch (e) {
    if (seq !== loadSeq) return;
    result.value = [];
    total.value = 0;
    errorMsg.value = e.message || '加载失败，请稍后再试';
  }
  if (seq === loadSeq) loading.value = false;
}

// ---- URL query 同步：分类/筛选/页码写入路由，返回时能恢复原分类与筛选 ----
const CATS = ['anime', 'manga', 'lightnovel'];
function readQuery() {
  const q = route.query;
  category.value = typeof q.cat === 'string' && CATS.includes(q.cat) ? q.cat : 'anime';
  mode.value = q.mode === 'search' ? 'search' : 'browse';
  keyword.value = typeof q.kw === 'string' ? q.kw : '';
  searchType.value = q.type ? +q.type : 2;
  browseSort.value = typeof q.sort === 'string' && q.sort ? q.sort : defaultBrowseSort.value;
  searchSort.value = q.ssort === 'rank' ? 'rank' : 'match';
  const pg = parseInt(q.page, 10);
  page.value = Number.isFinite(pg) && pg > 0 ? pg : 1;
  browseTag.value = typeof q.tag === 'string' ? q.tag : null;
  browseYear.value = typeof q.year === 'string' ? q.year : null;
  browseAirtime.value = typeof q.airtime === 'string' ? q.airtime : null;
  browseRegion.value = typeof q.region === 'string' ? q.region : null;
}
function syncQuery() {
  const q = {};
  if (category.value !== 'anime') q.cat = category.value;
  if (mode.value === 'search') q.mode = 'search';
  if (keyword.value.trim()) q.kw = keyword.value.trim();
  if (mode.value === 'search' && searchType.value !== 2) q.type = String(searchType.value);
  if (mode.value === 'search' && searchSort.value !== 'match') q.ssort = searchSort.value;
  if (browseSort.value !== defaultBrowseSort.value) q.sort = browseSort.value;
  if (page.value > 1) q.page = String(page.value);
  if (browseTag.value) q.tag = browseTag.value;
  if (browseYear.value) q.year = browseYear.value;
  if (browseAirtime.value) q.airtime = browseAirtime.value;
  if (browseRegion.value) q.region = browseRegion.value;
  // replace 避免污染历史；watch(route.query) 会重新 readQuery+load，保持滚动与筛选状态
  router.replace({ path: '/anime', query: q });
}

function doSearch() {
  mode.value = keyword.value.trim() ? 'search' : 'browse';
  page.value = 1;
  syncQuery();
}
function onPage(p) { page.value = p; syncQuery(); }
function onSortChange() { page.value = 1; syncQuery(); }
function onTagChange() {
  if (!isBook.value && browseTag.value) browseAirtime.value = null; // 类型标签与季度互斥：选了标签就清季度
  page.value = 1; syncQuery();
}
function onYearChange() {
  if (!isBook.value && browseAirtime.value) browseTag.value = null; // 季度与类型标签互斥：选了季度就清标签
  page.value = 1; syncQuery();
}
function onRegionChange() { page.value = 1; syncQuery(); }
function onTypeChange() { if (mode.value === 'search' && !isBook.value) { page.value = 1; syncQuery(); } }
function onKeywordClear() {
  if (!keyword.value && mode.value === 'search') {
    mode.value = 'browse';
    page.value = 1;
    syncQuery();
  }
}
function hot(k) { keyword.value = k; doSearch(); }

async function loadLibStatus() {
  try { libStatus.value = await api.get('/anime/library/status'); } catch (e) { /* ignore */ }
}
async function onCategoryChange() {
  keyword.value = '';
  mode.value = 'browse';
  browseTag.value = null;
  browseYear.value = null;
  browseAirtime.value = null;
  browseRegion.value = null;
  browseSort.value = defaultBrowseSort.value;
  page.value = 1;
  syncQuery(); // 重挂载后 onMounted 会 loadLibStatus + load
}
// 手动触发后台同步（同步中再次点击无效果）
async function triggerSync() {
  errorMsg.value = '';
  libStatus.value = { ...(libStatus.value || {}), syncing: true };
  try {
    const d = await api.post('/anime/library/sync');
    await loadLibStatus();
    if (d && d.ok === false && d.reason === 'already syncing') { /* 已在同步 */ }
    page.value = 1;
    syncQuery();
    load();
  } catch (e) {
    libStatus.value = { ...(libStatus.value || {}), syncing: false };
    errorMsg.value = '同步请求失败：' + (e.message || '请稍后再试');
  }
}

onMounted(() => { readQuery(); loadLibStatus(); load(); });
// 翻页/筛选通过 router.replace 更新 query（页面不再整页重挂载），监听 query 同步并重新加载
watch(() => route.query, () => { readQuery(); load(); }, { deep: true });
</script>

<template>
  <div class="container">
    <div class="page-head" v-reveal>
      <span class="emoji">🍡</span><h2>番剧库</h2>
    </div>

    <!-- 分类：番剧 / 漫画 / 轻小说 -->
    <div class="cat-tabs" v-reveal>
      <button
        v-for="c in categories"
        :key="c.value"
        class="cat-tab"
        :class="{ active: category === c.value }"
        @click="category = c.value; onCategoryChange()"
      >{{ c.label }}</button>
    </div>

    <div class="search-bar" v-reveal>
      <n-input
        v-model:value="keyword"
        :placeholder="isBook ? '搜索' + catLabel + '…（如：' + HOT[0] + '）' : '搜索番剧、书籍、游戏…（如：进击的巨人）'"
        size="large" clearable @keyup.enter="doSearch" @clear="onKeywordClear"
      />
      <n-select v-if="mode === 'search' && !isBook" v-model:value="searchType" :options="typeOptions" style="width:110px" @update:value="onTypeChange" />
      <n-select
        v-model:value="sortValue"
        :options="isBook ? browseSortOptions : (mode === 'browse' ? browseSortOptions : [{ label: '相关度', value: 'match' }, { label: '评分', value: 'rank' }])"
        style="width:130px"
        @update:value="onSortChange"
      />
      <n-button type="primary" size="large" round @click="doSearch" :loading="loading">搜索</n-button>
    </div>

    <div v-if="mode === 'browse' || isBook" class="filter-bar">
      <span class="muted">筛选：</span>
      <n-select v-model:value="browseTag" :options="TAG_OPTIONS" placeholder="全部标签" clearable style="width:150px" @update:value="onTagChange" />
      <n-select v-if="!isBook" v-model:value="browseAirtime" :options="quarterOptions" placeholder="全部季度" clearable style="width:140px" @update:value="onYearChange" />
      <n-select v-else v-model:value="browseYear" :options="yearOptions" placeholder="全部年份" clearable style="width:120px" @update:value="onYearChange" />
      <n-select v-if="isBook" v-model:value="browseRegion" :options="REGION_OPTIONS" clearable style="width:130px" @update:value="onRegionChange" />
      <span v-if="!isBook" class="muted filter-hint">季度按放送月份筛选（如 2026年7月番）；季度与类型标签二选一</span>
      <span v-if="isBook" class="muted filter-hint">地区按 Bangumi 用户标签判定，未标注的默认保留</span>
    </div>

    <!-- 书籍库同步状态 -->
    <div v-if="isBook && libStatus" class="sync-note" :class="{ syncing: libStatus.syncing }">
      <span v-if="libStatus.syncing">⏳ 正在从 Bangumi 同步书籍数据…（首次约 1-2 分钟）</span>
      <span v-else-if="libStatus.lastSync && libStatus.lastSync.ok">
        ✅ 书籍库已同步：漫画 {{ libStatus.lastSync.counts?.manga || 0 }} 部 · 轻小说 {{ libStatus.lastSync.counts?.lightnovel || 0 }} 部
        <span class="muted">（{{ (libStatus.lastSync.at || '').replace('T', ' ').slice(0, 16) }}）</span>
      </span>
      <span v-else>⚠️ 书籍库同步失败或尚未完成</span>
      <button class="sync-btn" :disabled="libStatus.syncing" @click="triggerSync">重新同步</button>
    </div>

    <div class="hot-row">
      <span class="muted">热门：</span>
      <span v-for="k in HOT" :key="k" class="hot-tag" @click="hot(k)">{{ k }}</span>
    </div>

    <div class="result-info">
      <template v-if="!errorMsg">
        <span v-if="isBook">
          {{ catLabel }}库 · {{ browseSortOptions.find(o => o.value === browseSort)?.label }}
          <template v-if="browseTag"> · 标签「{{ browseTag }}」</template><template v-if="browseYear"> · {{ browseYear }} 年</template><template v-if="browseRegion"> · 地区「{{ browseRegion }}」</template>
          （共 {{ total }} 部，第 {{ from }}-{{ to }} 条）
        </span>
        <span v-else-if="mode === 'browse'">
          番剧库 · {{ browseSortOptions.find(o => o.value === browseSort)?.label }}
          <template v-if="browseTag"> · 标签「{{ browseTag }}」</template><template v-if="browseAirtime"> · {{ airtimeLabel }}</template><template v-if="browseYear"> · {{ browseYear }} 年</template>
          （共 {{ total }} 部动画，第 {{ from }}-{{ to }} 条）
        </span>
        <span v-else>共 {{ total }} 条结果<template v-if="result.length">（第 {{ from }}-{{ to }} 条）</template></span>
        <span v-if="localMode && isBook" class="local-note">· 数据来自 Bangumi 本地同步库</span>
        <span v-if="localMode && !isBook" class="local-note">· Bangumi 在线不可用，已显示本地已导入番剧</span>
      </template>
      <span v-if="errorMsg" class="local-note">· {{ errorMsg }}</span>
    </div>

    <n-spin :show="loading">
      <div v-if="result.length" class="card-grid" v-reveal>
        <SubjectCard v-for="s in result" :key="category + '-' + s.id" :subject="s" />
      </div>
      <n-empty v-else-if="!loading && !errorMsg" :description="emptyDescription" style="padding:60px 0" />
    </n-spin>

    <div v-if="total > size" style="display:flex;justify-content:center;margin-top:24px;flex-wrap:wrap;gap:8px">
      <n-pagination v-model:page="page" :page-size="size" :item-count="total" :page-slot="20" responsive show-quick-jumper @update:page="onPage" />
    </div>
  </div>
</template>

<style scoped>
.cat-tabs { display: flex; gap: 10px; margin: 18px 0 14px; flex-wrap: wrap; }
.cat-tab {
  cursor: pointer; padding: 7px 22px; border-radius: 999px; border: 1px solid var(--back-btn-border);
  background: var(--back-btn-bg); color: var(--text-dim); font-size: 14px; font-weight: 600;
  transition: all .18s; letter-spacing: 2px;
}
.cat-tab:hover { color: var(--accent); border-color: var(--accent); transform: translateY(-1px); }
.cat-tab.active {
  background: linear-gradient(120deg, var(--accent), var(--accent-2)); border-color: transparent;
  color: var(--grad-text); box-shadow: 0 0 18px var(--seg-shadow);
}
.search-bar { display: flex; gap: 10px; margin-top: 4px; }
.filter-bar { display: flex; align-items: center; gap: 10px; margin: 14px 0 4px; flex-wrap: wrap; font-size: 13px; }
.filter-hint { font-size: 12px; opacity: .7; }
.result-info { margin: 16px 0 14px; font-size: 13px; color: var(--text-dim); }
.local-note { color: #e6a23c; }
.sync-note { display: flex; align-items: center; gap: 10px; margin: 12px 0 0; font-size: 12px; color: var(--ep-done-text); }
.sync-note.syncing { color: var(--accent); }
.sync-btn {
  cursor: pointer; padding: 3px 12px; border-radius: 999px; font-size: 12px; color: var(--accent);
  background: var(--src-tag-bg); border: 1px solid var(--src-tag-border); transition: all .15s;
}
.sync-btn:hover:not(:disabled) { background: var(--accent); border-color: var(--accent); color: var(--grad-text); }
.sync-btn:disabled { opacity: .5; cursor: not-allowed; }
.hot-row { display: flex; align-items: center; gap: 8px; margin: 14px 0 6px; flex-wrap: wrap; font-size: 13px; }
.hot-tag { cursor: pointer; padding: 4px 12px; border-radius: 999px; font-size: 12px; color: var(--tag-gold-text); background: var(--tag-gold-bg); border: 1px solid var(--tag-gold-border); transition: all .15s; }
.hot-tag:hover { background: linear-gradient(120deg, var(--accent), var(--accent-2)); border-color: transparent; color: var(--grad-text); transform: translateY(-2px); }
/* 虚拟列表式优化：离屏卡片跳过渲染，滚动到附近才绘制（配合封面 loading=lazy） */
.card-grid > a {
  content-visibility: auto;
  contain-intrinsic-size: 300px;
}
@media (max-width: 720px) {
  .search-bar { flex-wrap: wrap; }
  .search-bar .n-input { width: 100% !important; }
}
</style>


