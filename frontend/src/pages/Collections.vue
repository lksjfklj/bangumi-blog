<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { NButton, NTabs, NTabPane, NEmpty, NSpin, NPagination, NSelect, NAlert, NModal, NProgress, NDropdown, useMessage } from 'naive-ui';
import { api, COLLECT_STATUS, STATUS_COLOR, parseTags, episodeLabel } from '../api';
import { useUserStore } from '../stores/user';
import SubjectCard from '../components/SubjectCard.vue';

const userStore = useUserStore();
const route = useRoute();
const message = useMessage();

const status = ref(0);
const tag = ref(null);
const page = ref(1);
const size = 30;
const data = ref([]);
const total = ref(0);
const counts = ref({});
const listSource = ref(''); // 'bangumi' | 'local'
const bgmTotal = ref(0);    // Bangumi 实时总条数（本地未导入时用于 Tab 展示）
const tagOptions = ref([]);
const myUpdates = ref([]);
const unreadCount = ref(0);
const updatesLoading = ref(false);
const loading = ref(false);
const importing = ref(false);
const importJob = ref(null); // { running, done, total, expected, currentType, error }
const autoSync = ref(null); // 自动同步信息 { enabled, intervalMs, running, lastRunAt, nextRunAt, lastResult }
let importTimer = null;

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
// 「自动同步」一行摘要：默认每 12 小时，由服务端定时器拉取，不依赖本页面打开
const autoSyncText = computed(() => {
  const a = autoSync.value;
  if (!a || !a.enabled) return '';
  if (a.running) return '🤖 自动同步正在运行，正在从 Bangumi 更新本地收藏…';
  const hours = Math.round((a.intervalMs || 0) / 3600000);
  const interval = hours >= 48 ? `约每 ${Math.round((hours / 24) * 10) / 10} 天` : (hours >= 1 ? `约每 ${hours} 小时` : `约每 ${Math.max(1, Math.round((a.intervalMs || 0) / 60000))} 分钟`);
  const parts = [`🤖 自动同步已开启（${interval}自动从 Bangumi 更新本地收藏）`];
  if (a.lastRunAt) parts.push(`上次 ${fmtClock(a.lastRunAt)}`);
  if (a.nextRunAt) parts.push(`下次 ${fmtClock(a.nextRunAt)}`);
  return parts.join(' · ');
});

async function loadAutoSync() {
  try {
    const d = await api.get('/collections/import/status');
    autoSync.value = (d && d.autoSync) || null;
  } catch (e) { autoSync.value = null; }
}

// 分类顺序贴近 Bangumi：全部、想看、在看、看过、搁置、抛弃
const tabs = [
  { label: '全部', value: 0 },
  { label: '想看', value: 1 },
  { label: '在看', value: 3 },
  { label: '看过', value: 2 },
  { label: '搁置', value: 4 },
  { label: '抛弃', value: 5 }
];

function tabLabel(t) {
  // 本地已导入：显示本地精确统计
  if ((counts.value.total || 0) > 0) {
    const c = t.value === 0 ? counts.value.total : (counts.value[t.value] || 0);
    return c ? `${t.label} ${c}` : t.label;
  }
  // 本地尚未导入：全部 Tab 显示 Bangumi 实时总数，其余只显示标签避免误导
  if (t.value === 0 && bgmTotal.value > 0) return `${t.label} ${bgmTotal.value}`;
  return t.label;
}

// 导入进度：0-100
const importPercent = computed(() => {
  const j = importJob.value;
  if (!j) return 0;
  if (!j.running) return j.queued ? 0 : 100;
  if (j.expected > 0) return Math.max(1, Math.min(99, Math.round((j.done / j.expected) * 100)));
  return 0;
});
const importDoneText = computed(() => {
  const j = importJob.value;
  if (!j) return '';
  if (!j.running && j.queued) return '已进入同步队列，等待前面的任务完成后自动开始，请勿关闭页面…';
  const typeName = j.currentType ? ({ 1: '书籍', 2: '动画', 3: '音乐', 4: '游戏', 6: '三次元' }[j.currentType] || '条目') : '';
  const pruned = j.pruned ? `，已清理 ${j.pruned} 条 Bangumi 侧已取消的收藏` : '';
  return `已导入 ${j.done} 条${typeName ? '（正在处理' + typeName + '…）' : ''}${pruned}`;
});

let loadSeq = 0;
async function load() {
  const seq = ++loadSeq;
  loading.value = true;
  try {
    const q = new URLSearchParams({ subject_type: '2', limit: String(size), offset: String((page.value - 1) * size) });
    if (status.value) q.set('status', status.value);
    if (tag.value) q.set('tag', tag.value);
    const d = await api.get('/me/collections?' + q.toString());
    if (seq !== loadSeq) return; // 快速翻页时丢弃过期响应
    data.value = d.data || [];
    total.value = d.total || data.value.length;
    if (d.counts) counts.value = d.counts;
    listSource.value = d.source || '';
    bgmTotal.value = d.bgmTotal || 0;
  } catch (e) {
    if (seq !== loadSeq) return;
    data.value = [];
    total.value = 0;
    message.error(e.message);
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

async function loadTags() {
  try {
    const d = await api.get('/me/collections/tags?subject_type=2&limit=100');
    tagOptions.value = (d.data || []).map(t => ({ label: `${t.name} (${t.count})`, value: t.name }));
  } catch (e) { /* ignore */ }
}

function onTabChange() { page.value = 1; load(); }
function onTagChange() { page.value = 1; load(); }
function onPage(p) { page.value = p; load(); }

// 从 Bangumi 拉取收藏到本地（入全局队列串行执行，带每用户冷却）；
// 同步开始时会先把本站待重推（Bangumi 同步失败）的改动补推给 Bangumi，再拉取最新收藏回写本地
async function startSync() {
  importing.value = true;
  importJob.value = { kind: 'import', running: false, queued: true, done: 0, expected: 0, total: 0, currentType: 0, error: '' };
  try {
    const d = await api.post('/collections/import');
    if (d && d.ok === false) { throw new Error(d.error || (d.reason === 'already queued' ? '已有同步任务在排队，请等待完成后再试' : '请求被拒绝')); }
    if (d && d.reason === 'rate-limited') { throw new Error('操作过于频繁，请 ' + (d.retryAfterSec || 60) + ' 秒后再试'); }
    pollImport();
  } catch (e) {
    importing.value = false;
    importJob.value = null;
    message.error(e.message || '请求失败');
  }
}
function importFromBgm() { startSync(); }

async function pollImport() {
  try {
    const d = await api.get('/collections/import/status');
    importJob.value = { ...(importJob.value || {}), ...d };
    // 排队中或执行中都继续轮询；两者都结束才算完成
    if (d.running || d.queued) {
      importTimer = setTimeout(pollImport, 1200);
      return;
    }
    importing.value = false;
    if (d.error) {
      message.error('导入失败：' + d.error);
    } else {
      const n = d.total || d.done || 0;
      message.success(n ? '导入完成：' + n + ' 条' : '没有需要导入的收藏');
    }
    importJob.value = null;
    page.value = 1;
    await Promise.all([load(), loadTags()]);
  } catch (e) {
    importing.value = false;
    importJob.value = null;
    message.error(e.message);
  }
}


function login() { location.href = '/login?redirect=/collection'; }

async function loadUpdates() {
  updatesLoading.value = true;
  try {
    const u = await api.get('/watch/my-updates?limit=5');
    myUpdates.value = (u && u.data) || [];
    if (!userStore.viewer) {
      const un = await api.get('/watch/updates/unread?limit=1').catch(() => ({ unread: 0 }));
      unreadCount.value = (un && un.unread) || 0;
    } else {
      unreadCount.value = 0;
    }
  } catch (e) { myUpdates.value = []; }
  updatesLoading.value = false;
}


const exportOptions = [
  { label: '导出 JSON', key: 'json' },
  { label: '导出 CSV（Excel 可直接打开）', key: 'csv' }
];
function doExport(fmt) {
  const a = document.createElement('a');
  a.href = '/api/collections/export-download?format=' + fmt;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  message.success('导出中，请稍候…');
}

async function markAllRead() {
  try {
    await api.post('/watch/updates/read', {});
    unreadCount.value = 0;
    window.dispatchEvent(new Event('bb:updates-read'));
    message.success('已全部标记为已读');
    loadUpdates();
  } catch (e) { message.error(e.message); }
}

onMounted(() => {
  if (route.query.tag) tag.value = String(route.query.tag);
  if (userStore.user) {
    load();
    loadTags();
    loadUpdates();
    if (userStore.user.connected && !userStore.viewer) loadAutoSync();
  }
});
onUnmounted(() => { if (importTimer) clearTimeout(importTimer); });
watch(() => route.query.tag, (v) => {
  const next = v === undefined ? null : String(v);
  if (next !== tag.value) {
    tag.value = next;
    page.value = 1;
    load();
  }
});
</script>

<template>
  <div class="container">
    <div v-if="!userStore.user" style="text-align:center;padding:80px 0">
      <n-empty description="登录后即可追番，并与 Bangumi 收藏联动">
        <template #extra>
          <n-button type="primary" @click="login">登录 / 注册 / 只读访客</n-button>
        </template>
      </n-empty>
    </div>

    <template v-else>
      <n-alert v-if="userStore.viewer" type="warning" :show-icon="false" style="margin:10px 0 4px">
        🌙 只读访客模式：当前以站长视角浏览，所有数据仅可查看，不可修改。
      </n-alert>
      <div class="head" v-reveal>
        <h2><span class="emoji">🌙</span>我的追番</h2>
        <div class="actions" v-if="userStore.user.connected && !userStore.viewer">
          <n-button size="small" :loading="importing" @click="importFromBgm">导入 Bangumi 收藏</n-button>
          <n-dropdown trigger="hover" :options="exportOptions" @select="doExport">
            <n-button size="small" secondary>💾 导出本地备份</n-button>
          </n-dropdown>
        </div>
      </div>

      <div class="auto-sync-line" v-if="autoSyncText">{{ autoSyncText }}</div>
      <div class="auto-sync-line" v-if="userStore.user.connected && !userStore.viewer">💡 双向同步：在本站修改收藏/进度会立即写入 Bangumi；在 Bangumi 上的改动点「导入 Bangumi 收藏」或等待自动同步拉回本站。不再需要手动推送。</div>

      <div v-if="!updatesLoading && myUpdates.length" class="updates-bar" v-reveal>
        <div class="upd-head">
          <span class="upd-title">📣 你追的番有更新</span>
          <n-tag v-if="unreadCount" size="small" type="error" round :bordered="false">{{ unreadCount }} 条未读</n-tag>
          <span class="spacer"></span>
          <n-button v-if="!userStore.viewer && unreadCount" text type="primary" size="small" @click="markAllRead">全部已读</n-button>
          <n-button text type="primary" size="small" @click="$router.push('/watch?my=1')">去新番更新 →</n-button>
        </div>
        <div class="upd-list">
          <router-link v-for="u in myUpdates" :key="u.series_key" :to="{ path: '/watch', query: { my: '1', q: u.series_title || u.name_cn || u.name } }" class="upd-item" :title="'查看 ' + (u.name_cn || u.name || u.series_title) + ' 的更新'">
            <span v-if="+u.unread > 0" class="upd-dot" title="未读更新"></span>
            <span class="upd-name">{{ u.name_cn || u.name || u.series_title }}</span>
            <n-tag v-if="u.episode" size="small" :bordered="false" type="warning" round>{{ episodeLabel(u.episode) }}</n-tag>
            <span class="spacer"></span>
            <span class="upd-time">{{ (u.published_at || '').slice(5, 10) }}</span>
          </router-link>
        </div>
      </div>

      <n-tabs v-model:value="status" type="line" @update:value="onTabChange">
        <n-tab-pane v-for="t in tabs" :key="t.value" :name="t.value">
          <template #tab>{{ tabLabel(t) }}</template>
        </n-tab-pane>
      </n-tabs>

      <!-- Bangumi 实时列表与本地统计不一致时的两种方向提示（v-if / v-else-if 必须相邻，注释放前面） -->
      <n-alert v-if="status === 0 && listSource === 'bangumi' && bgmTotal > (counts.total || 0)" type="info" :show-icon="false" style="margin:8px 0 2px">
        🌙 列表实时来自 Bangumi（共 {{ bgmTotal }} 条）· 收藏统计来自本地库（已导入 {{ counts.total || 0 }} 条）{{ autoSyncText ? '· 已开启自动同步，统计会自动补全' : '· 点右上角「导入 Bangumi 收藏」后统计即为完整' }}
      </n-alert>
      <n-alert v-else-if="status === 0 && listSource === 'bangumi' && (counts.total || 0) > bgmTotal" type="warning" :show-icon="false" style="margin:8px 0 2px">
        ⚠️ Bangumi 上现有 {{ bgmTotal }} 条，本地统计多出 {{ (counts.total || 0) - bgmTotal }} 条（多半是已在 Bangumi 侧取消收藏的条目）· 点右上角「导入 Bangumi 收藏」{{ autoSyncText ? "或等自动同步" : "" }}即可对齐计数与导出
      </n-alert>

      <div class="toolbar">
        <n-select
          v-model:value="tag"
          :options="tagOptions"
          filterable
          clearable
          placeholder="按标签筛选（如：热血、恋爱）"
          style="width:260px"
          @update:value="onTagChange"
        />
        <span v-if="tag" class="muted tag-count">{{ total }} 部相关</span>
      </div>

      <n-spin :show="loading">
        <div v-if="data.length" class="card-grid" style="margin-top:14px">
          <SubjectCard v-for="c in data" :key="c.subject_id" :subject="{ ...c, id: c.subject_id }" :tags="parseTags(c.tags)" :subject-tags="parseTags(c.subject_tags)" />
        </div>
        <n-empty v-else-if="!loading" description="这里空空如也，去番剧库找点想看的吧" style="padding:60px 0">
          <template #extra>
            <n-button v-if="tag" type="primary" @click="tag = null; onTagChange()">清除标签筛选</n-button>
            <n-button v-else type="primary" @click="$router.push('/anime')">去番剧库</n-button>
          </template>
        </n-empty>
      </n-spin>

      <div v-if="total > size" style="display:flex;justify-content:center;margin-top:24px;flex-wrap:wrap;gap:8px">
        <n-pagination v-model:page="page" :page-size="size" :item-count="total" :page-slot="20" responsive show-quick-jumper @update:page="onPage" />
      </div>
    </template>

    <!-- 导入进度弹窗：不可关闭，避免导入中断 -->
    <n-modal :show="!!importJob" preset="card" title="正在同步 Bangumi 收藏" :mask-closable="false" :close-on-esc="false" style="width:460px;max-width:92vw">
      <div class="import-box" v-if="importJob">
        <p class="muted import-tip">正在从 Bangumi 拉取收藏并写入本地数据库（若本站有改动但 Bangumi 暂未同步成功，会先自动补推）。收藏较多时可能需要 1-3 分钟，请勿关闭页面。</p>
        <n-progress type="line" :percentage="importPercent" :show-indicator="true" :processing="importJob.running" />
        <p class="muted import-done">{{ importDoneText }}</p>
      </div>
    </n-modal>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; margin: 10px 0 4px; flex-wrap: wrap; gap: 10px; }
.head h2 { margin: 0; }
.actions { display: flex; gap: 8px; }
.auto-sync-line { font-size: 12px; color: var(--text-dim); margin: 0 0 6px; }
.toolbar { display: flex; align-items: center; gap: 12px; margin: 12px 0 2px; flex-wrap: wrap; }
.tag-count { font-size: 13px; }
.updates-bar { margin: 12px 0 2px; background: var(--bg-card); border: 1px solid var(--accent); border-radius: 14px; padding: 12px 14px 8px; }
.updates-bar .spacer { flex: 1; }
.upd-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.upd-title { font-size: 14px; font-weight: 700; color: var(--accent); }
.upd-list { display: flex; flex-direction: column; }
.upd-item { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 2px; border-bottom: 1px dashed var(--border); text-decoration: none; color: inherit; }
.upd-item:last-child { border-bottom: none; }
.upd-item:hover .upd-name { color: var(--accent); }
.upd-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent-4); flex: none; box-shadow: 0 0 0 3px rgba(255,125,156,.16); }
.upd-name { font-size: 13px; font-weight: 600; color: var(--text); }
.upd-time { font-size: 12px; color: var(--text-dim); white-space: nowrap; }
.import-box { padding: 4px 2px; }
.import-tip { margin: 0 0 14px; line-height: 1.6; }
.import-done { margin: 12px 0 0; }
</style>


