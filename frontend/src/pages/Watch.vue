<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NInput, NTag, NPagination, NSpin, NEmpty, NButton, NSelect, NSwitch, NModal, NDynamicTags, NSkeleton, NAlert, useMessage } from 'naive-ui';
import { api, episodeLabel } from '../api';
import { useUserStore } from '../stores/user';

const message = useMessage();
const route = useRoute();
const router = useRouter();
const userStore = useUserStore();

// ---------- 分组视图状态 ----------
const groups = ref([]);
const total = ref(0);
const page = ref(1);
const size = 12;
const q = ref('');
const source = ref('');       // '' = 全部
const subGroup = ref(null);   // null = 全部
const quality = ref(null);    // null = 全部
const days = ref(30);         // 时间范围（天）
const myOnly = ref(false);    // 只看我追的
const loading = ref(false);
const loadingMy = ref(false);

// 展开的番：series_key -> 全部版本
const expanded = ref({});
const expanding = ref(null);

// 来源 / 筛选 / 状态
const sources = ref([]);
const filterOptions = ref({ sub_groups: [], qualities: [] });
const lastRunAt = ref(0);
const lastError = ref('');
// 告警提示：同一错误「显示一次后点掉就不再弹出」，直到错误内容变化（localStorage 记忆）
const dismissedErr = ref(localStorage.getItem('watch_dismissed_err') || '');
const showErr = computed(() => lastError.value && lastError.value !== dismissedErr.value);
function dismissErr() { dismissedErr.value = lastError.value; localStorage.setItem('watch_dismissed_err', dismissedErr.value); }
const refreshing = ref(false);
const SOURCE_MAP = {};

// ---------- RSS 源配置（站长） ----------
const showConfig = ref(false);
const savingConfig = ref(false);
const configForm = ref({ sources: [], excludeKeywords: [] });
const notifyDesc = ref('');
const testingNotify = ref(false);

function sourceName(k) { return (SOURCE_MAP[k] || {}).name || k; }
function sourceEmoji(k) { return (SOURCE_MAP[k] || {}).emoji || '🍥'; }

const subGroupOptions = computed(() => (filterOptions.value.sub_groups || []).map(s => ({ label: s, value: s })));
const qualityOptions = computed(() => (filterOptions.value.qualities || []).map(s => ({ label: s, value: s })));
const daysOptions = [
  { label: '近 7 天', value: 7 },
  { label: '近 14 天', value: 14 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
  { label: '近 365 天', value: 365 },
  { label: '全部', value: 0 }
];

function buildParams() {
  const p = new URLSearchParams({ page: page.value, size });
  if (source.value) p.set('source', source.value);
  if (q.value.trim()) p.set('q', q.value.trim());
  if (subGroup.value) p.set('sub_group', subGroup.value);
  if (quality.value) p.set('quality', quality.value);
  if (days.value) p.set('days', days.value);
  if (myOnly.value) p.set('my', '1');
  return p;
}

async function load() {
  loading.value = true;
  try {
    const d = await api.get('/watch/groups?' + buildParams().toString());
    groups.value = d.data || [];
    total.value = d.total || 0;
  } catch (e) {
    groups.value = [];
    total.value = 0;
    if (e.status === 401) {
      message.warning('请先登录后再使用「只看我追的」');
      myOnly.value = false;
      return load();
    }
    message.error(e.message);
  }
  loading.value = false;
}

async function loadSources() {
  try {
    const d = await api.get('/watch/sources');
    sources.value = d.sources || [];
    lastRunAt.value = d.lastRunAt || 0;
    lastError.value = d.lastError || '';
    for (const s of sources.value) SOURCE_MAP[s.key] = s;
  } catch (e) { sources.value = []; }
}

async function loadFilters() {
  try {
    const d = await api.get('/watch/filters');
    filterOptions.value = d || { sub_groups: [], qualities: [] };
  } catch (e) { /* ignore */ }
}

function pickSource(k) { source.value = k; page.value = 1; load(); }
function onSearch() { page.value = 1; load(); }
function onFilterChange() { page.value = 1; load(); }
function onPage(p) { page.value = p; load(); }

async function toggleMy(v) {
  if (v && !userStore.isLoggedIn) {
    message.info('登录后即可使用「只看我追的」');
    myOnly.value = false;
    router.push({ path: '/login', query: { redirect: '/watch' } });
    return;
  }
  myOnly.value = v;
  page.value = 1;
  load();
}

// 展开全部版本
async function toggleExpand(g) {
  if (expanded.value[g.series_key]) {
    const next = { ...expanded.value };
    delete next[g.series_key];
    expanded.value = next;
    return;
  }
  expanding.value = g.series_key;
  try {
    const d = await api.get('/watch/group-versions?series_key=' + encodeURIComponent(g.series_key));
    expanded.value = { ...expanded.value, [g.series_key]: (d.data || []) };
  } catch (e) {
    message.error(e.message);
  }
  expanding.value = null;
}

async function copyMagnet(m, e) {
  e.preventDefault();
  e.stopPropagation();
  try {
    await navigator.clipboard.writeText(m);
    message.success('磁力链接已复制 ⚡');
  } catch (err) {
    try {
      const ta = document.createElement('textarea');
      ta.value = m;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) message.success('磁力链接已复制 ⚡');
      else message.error('复制失败，请手动复制');
    } catch (e2) { message.error('复制失败，请手动复制'); }
  }
}

async function refresh() {
  refreshing.value = true;
  try {
    await api.post('/watch/refresh');
    message.success('已重新抓取 RSS');
    await Promise.all([load(), loadSources()]);
  } catch (e) {
    message.error(e.message || '刷新失败');
  }
  refreshing.value = false;
}

// ---------- 配置 ----------
async function openConfig() {
  try {
    const d = await api.get('/watch/config');
    configForm.value = {
      sources: (d.sources || []).map(s => ({ ...s })),
      excludeKeywords: Array.isArray(d.excludeKeywords) ? [...d.excludeKeywords] : []
    };
    notifyDesc.value = d.notify || '';
    showConfig.value = true;
  } catch (e) {
    message.error(e.message);
  }
}

async function saveConfig() {
  savingConfig.value = true;
  try {
    const body = {
      sources: configForm.value.sources.map(s => ({
        key: s.key, enabled: s.enabled !== false, url: s.url || '',
        name: s.name || '', emoji: s.emoji || '', magnetFrom: s.magnetFrom || ''
      })),
      excludeKeywords: configForm.value.excludeKeywords
    };
    await api.post('/watch/config', body);
    message.success('配置已保存');
    showConfig.value = false;
    await Promise.all([loadSources(), load()]);
  } catch (e) {
    message.error(e.message);
  }
  savingConfig.value = false;
}

async function testNotify() {
  testingNotify.value = true;
  try {
    const d = await api.post('/watch/notify-test');
    if (d.delivered) message.success('通知已发送 ✓');
    else message.warning('当前未配置任何通知渠道（Server酱 / Telegram / Webhook）');
    notifyDesc.value = d.describe || '';
  } catch (e) {
    message.error(e.message);
  }
  testingNotify.value = false;
}

function fmtDateTime(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return String(s);
  const pad = n => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function groupVersions(g) {
  return expanded.value[g.series_key] || g.versions || [];
}

onMounted(() => {
  // 支持站内联动跳转：/watch?my=1&q=番名（首页「我追的更了」等入口）
  if (route.query.my === '1' && userStore.isLoggedIn) myOnly.value = true;
  if (route.query.q) q.value = String(route.query.q);
  Promise.all([load(), loadSources(), loadFilters()]);
});
</script>

<template>
  <div class="container" style="max-width:920px">
    <div class="watch-head" v-reveal>
      <div class="head-left">
        <span class="emoji">📡</span><h2>新番更新</h2>
        <span class="muted head-sub">按番聚合 · RSS 订阅 · 磁力 / 种子直连</span>
      </div>
      <div class="head-right">
        <n-input v-model:value="q" placeholder="搜索番名…" clearable style="max-width:220px" @keyup.enter="onSearch" />
        <n-button v-if="userStore.isOwner" round secondary @click="openConfig">⚙️ 配置</n-button>
        <n-button v-if="userStore.isOwner" type="primary" round secondary :loading="refreshing" @click="refresh">🔄 刷新</n-button>
      </div>
    </div>

    <div class="tool-row">
      <div class="src-bar">
        <button class="chip" :class="{ on: source === '' }" @click="pickSource('')">全部 <span class="cnt">{{ sources.reduce((a, s) => a + (s.count || 0), 0) }}</span></button>
        <button v-for="s in sources" :key="s.key" class="chip" :class="{ on: source === s.key }" @click="pickSource(s.key)">{{ s.emoji }} {{ s.name.split(' ')[0] }} <span class="cnt">{{ s.count }}</span></button>
      </div>
      <div class="filters">
        <n-select v-model:value="subGroup" :options="subGroupOptions" placeholder="字幕组" clearable filterable size="small" style="width:150px" @update:value="onFilterChange" />
        <n-select v-model:value="quality" :options="qualityOptions" placeholder="画质" clearable size="small" style="width:110px" @update:value="onFilterChange" />
        <n-select v-model:value="days" :options="daysOptions" size="small" style="width:110px" @update:value="onFilterChange" />
        <div class="my-switch" :title="userStore.isLoggedIn ? '只显示你追的番的更新' : '登录后可用'">
          <n-switch v-model:value="myOnly" size="small" :disabled="!userStore.isLoggedIn" @update:value="toggleMy" />
          <span class="my-label">只看我追的</span>
        </div>
      </div>
    </div>
    <div class="tool-row2">
      <span v-if="lastRunAt" class="sync-hint">上次同步 {{ fmtDateTime(lastRunAt) }}</span>
      <span class="spacer2"></span>
      <span v-if="total" class="sync-hint">共 {{ total }} 部番剧有更新</span>
    </div>
    <div v-if="showErr" class="sync-err"><span>⚠️ {{ lastError }}（可通过「配置 → 测试通知」接入告警）</span><span class="sync-err-dismiss" @click="dismissErr">知道了</span></div>

    <!-- 骨架屏：首屏/筛选时显示 -->
    <div v-if="loading" class="skeleton-list">
      <n-skeleton v-for="i in 4" :key="i" height="150px" :sharp="false" style="border-radius:16px;margin-bottom:12px" />
    </div>

    <template v-else>
      <div v-for="g in groups" :key="g.series_key" class="group-card">
        <div class="group-head">
          <div class="g-cover">
            <img v-if="g.cover" :src="g.cover" loading="lazy" decoding="async" alt="" />
            <span v-else class="cover-ph">🎞️</span>
          </div>
          <div class="g-info">
            <div class="g-title-row">
              <h3 class="g-title" :title="g.series_title">{{ g.series_title }}</h3>
              <n-tag v-if="g.latest_episode" size="small" :bordered="false" type="warning" round>{{ episodeLabel(g.latest_episode) }}</n-tag>
              <n-tag size="small" :bordered="false" type="info" round>{{ g.count }} 条</n-tag>
            </div>
            <div class="g-tags">
              <n-tag v-for="s in g.sub_groups" :key="s" size="small" :bordered="false" round>{{ s }}</n-tag>
              <n-tag v-for="qq in g.qualities" :key="qq" size="small" :bordered="false" type="warning" round>{{ qq }}</n-tag>
            </div>
            <div class="g-meta">
              <span class="src-tag" v-for="s in g.sources" :key="s">{{ sourceEmoji(s) }} {{ sourceName(s).split(' ')[0] }}</span>
              <span class="time">更新于 {{ fmtDateTime(g.latest_published_at) }}</span>
            </div>
          </div>
          <div class="g-actions">
            <n-button v-if="g.bgm_subject_id" size="small" round secondary @click="$router.push('/subject/' + g.bgm_subject_id)">详情 ↗</n-button>
            <n-button size="small" round :loading="expanding === g.series_key" @click="toggleExpand(g)">
              {{ expanded[g.series_key] ? '收起' : '展开全部版本' }}
            </n-button>
          </div>
        </div>

        <div class="ver-list">
          <div v-for="v in groupVersions(g)" :key="v.id" class="ver-row">
            <div class="ver-main">
              <span class="ver-title" :title="v.title">{{ v.title }}</span>
              <div class="ver-tags">
                <n-tag v-if="v.sub_group" size="tiny" :bordered="false" round>{{ v.sub_group }}</n-tag>
                <n-tag v-if="v.quality" size="tiny" :bordered="false" type="warning" round>{{ v.quality }}</n-tag>
                <n-tag v-if="v.episode" size="tiny" :bordered="false" type="error" round>{{ episodeLabel(v.episode) }}</n-tag>
                <span class="time">{{ fmtDateTime(v.published_at) }}</span>
                <span v-if="v.file_size" class="fsize">📦 {{ v.file_size }}</span>
              </div>
            </div>
            <div class="ver-btns">
              <n-button v-if="v.magnet" size="tiny" round secondary type="warning" @click="copyMagnet(v.magnet, $event)">⚡ 复制磁力</n-button>
              <a v-if="v.torrent_url" class="read-more" :href="v.torrent_url" target="_blank" rel="noopener" @click.stop>种子 ↓</a>
              <a class="read-more" :href="v.link" target="_blank" rel="noopener" @click.stop>详情 ↗</a>
            </div>
          </div>
          <div v-if="!expanded[g.series_key] && (!g.versions || !g.versions.length)" class="ver-empty muted">暂无版本详情</div>
        </div>
      </div>

      <n-empty v-if="!groups.length" description="暂无更新记录，正在等待 RSS 同步…" style="padding:60px 0">
        <template #extra>
          <n-button v-if="userStore.isOwner" type="primary" @click="refresh">立即刷新 RSS</n-button>
        </template>
      </n-empty>
    </template>

    <div v-if="total > size" style="display:flex;justify-content:center;margin-top:20px">
      <n-pagination v-model:page="page" :page-size="size" :item-count="total" @update:page="onPage" />
    </div>

    <p class="foot-tip">📌 本站仅聚合各字幕组发布的更新与下载链接，视频文件均在第三方站点，服务器不存储任何影视资源。死种检测暂未提供（1 核小机负担重），磁力客户端会自动跳过失效资源。</p>

    <!-- 站长：RSS 源与关键词过滤配置 -->
    <n-modal v-model:show="showConfig" preset="card" title="⚙️ RSS 源配置" style="width:640px;max-width:94vw">
      <n-alert v-if="notifyDesc" type="info" :show-icon="false" style="margin-bottom:12px">
        📣 告警渠道：{{ notifyDesc }}<n-button text type="primary" style="margin-left:10px" size="tiny" :loading="testingNotify" @click="testNotify">测试通知</n-button>
      </n-alert>
      <div v-for="s in configForm.sources" :key="s.key" class="cfg-row">
        <n-switch v-model:value="s.enabled" size="small" />
        <span class="cfg-name">{{ s.emoji }} {{ s.name }}</span>
        <span class="cfg-desc muted">{{ s.desc }}</span>
        <n-input v-model:value="s.url" size="small" placeholder="RSS 地址" style="flex:1;min-width:180px" />
      </div>
      <div class="cfg-exclude">
        <div class="muted" style="margin:14px 0 6px">全局排除关键词（命中即忽略该资源）：</div>
        <n-dynamic-tags v-model:value="configForm.excludeKeywords" size="small" />
      </div>
      <template #footer>
        <div style="display:flex;justify-content:flex-end;gap:10px">
          <n-button size="small" @click="showConfig = false">取消</n-button>
          <n-button size="small" type="primary" :loading="savingConfig" @click="saveConfig">保存</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.watch-head { display: flex; align-items: center; justify-content: space-between; margin: 8px 0 16px; flex-wrap: wrap; gap: 10px; }
.head-left { display: flex; align-items: center; gap: 10px; }
.head-left h2 { margin: 0; }
.head-sub { font-size: 13px; }
.head-right { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.emoji { font-size: 24px; }
.tool-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
.tool-row2 { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
.spacer2 { flex: 1; }
.src-bar { display: flex; flex-wrap: wrap; gap: 8px; }
.filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.my-switch { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-dim); white-space: nowrap; }
.chip {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 999px; padding: 5px 13px; font-size: 13px; cursor: pointer;
  transition: all .2s; font-family: inherit;
}
.chip:hover { border-color: var(--accent); color: var(--accent); }
.chip.on { background: var(--tag-gold-bg); color: var(--tag-gold-text); border-color: var(--tag-gold-border); font-weight: 600; }
.chip .cnt { opacity: .72; font-size: 12px; }
.sync-hint { font-size: 12px; color: var(--text-dim); }
.sync-err { margin: 4px 0 10px; font-size: 12px; color: var(--accent-4); background: var(--viewer-bg); border: 1px solid var(--viewer-border); border-radius: 10px; padding: 6px 12px; display: flex; align-items: center; gap: 10px; }
.sync-err-dismiss { flex-shrink: 0; margin-left: auto; color: var(--accent-1); cursor: pointer; font-weight: 600; user-select: none; }
.sync-err-dismiss:hover { text-decoration: underline; }
.skeleton-list { margin-top: 4px; }

.group-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 16px; margin-bottom: 14px; overflow: hidden; transition: border-color .2s, box-shadow .2s; }
.group-card:hover { border-color: var(--accent); box-shadow: 0 6px 18px rgba(0,0,0,.45); }
.group-head { display: flex; gap: 14px; padding: 14px 14px 10px; align-items: flex-start; flex-wrap: wrap; }
.g-cover { width: 96px; min-width: 96px; height: 60px; border-radius: 10px; overflow: hidden; display: flex; align-items: center; justify-content: center; background: var(--cover-grad); border: 1px solid var(--border); }
.g-cover img { width: 100%; height: 100%; object-fit: cover; }
.cover-ph { font-size: 24px; }
.g-info { flex: 1; min-width: 220px; }
.g-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.g-title { margin: 0; font-size: 16px; color: var(--text); line-height: 1.4; }
.g-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.g-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 7px; font-size: 12px; color: var(--text-dim); }
.g-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.ver-list { border-top: 1px dashed var(--border); padding: 6px 14px 12px; }
.ver-row { display: flex; align-items: center; gap: 10px; padding: 9px 2px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.ver-row:last-child { border-bottom: none; }
.ver-main { flex: 1; min-width: 220px; }
.ver-title { display: block; font-size: 13px; color: var(--text); line-height: 1.45; margin-bottom: 4px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.ver-tags { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 12px; color: var(--text-dim); }
.ver-btns { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ver-empty { padding: 8px 0; font-size: 12px; }
.src-tag { background: var(--src-tag-bg); border: 1px solid var(--src-tag-border); color: var(--src-tag-text); padding: 2px 10px; border-radius: 999px; white-space: nowrap; }
.time { white-space: nowrap; }
.fsize { white-space: nowrap; }
.read-more { color: var(--accent); text-decoration: none; font-weight: 600; white-space: nowrap; }
.read-more:hover { text-decoration: underline; }
.foot-tip { margin-top: 22px; text-align: center; font-size: 12px; color: var(--text-dim); }
.cfg-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px dashed var(--border); flex-wrap: wrap; }
.cfg-name { font-size: 13px; font-weight: 700; color: var(--text); white-space: nowrap; }
.cfg-desc { font-size: 12px; color: var(--text-dim); flex: 1; min-width: 120px; }
.cfg-exclude { margin-top: 4px; }
@media (max-width: 560px) {
  .g-cover { width: 72px; min-width: 72px; height: 48px; }
  .g-actions { width: 100%; justify-content: flex-end; }
}
</style>
