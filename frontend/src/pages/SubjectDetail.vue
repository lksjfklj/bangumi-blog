<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NSpin, NButton, NTag, NRate, NInput, NSelect, NModal, NEmpty, NAlert, NPopconfirm,
  useMessage
} from 'naive-ui';
import { api, img, fmtDate, scoreText, COLLECT_STATUS, STATUS_COLOR, parseTags } from '../api';
import SubjectCard from '../components/SubjectCard.vue';
import { useUserStore } from '../stores/user';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const userStore = useUserStore();

// 简介过长：折叠 120px + 底部渐隐，可展开全文/收起
const summaryExpanded = ref(false);
const summaryEl = ref(null);
const summaryLong = ref(false);

function measureSummary() {
  const el = summaryEl.value;
  if (!el || summaryExpanded.value) return; // 展开态无 max-height，不需要测
  summaryLong.value = el.scrollHeight > el.clientHeight + 2;
}
function toggleSummary() {
  summaryExpanded.value = !summaryExpanded.value;
  if (!summaryExpanded.value) nextTick(measureSummary); // 收起后重新判断
}
function onWinResize() { measureSummary(); }

const id = computed(() => +route.params.id);
const subject = ref(null);
const episodes = ref([]);
const epsTotal = ref(0);
const characters = ref([]);
const staff = ref([]);
const related = ref([]);
const loading = ref(true);
const error = ref('');
const collection = ref(null);
const coverFailed = ref(false);
const charFailed = {};
const colLoading = ref(true);

// VNDB 增强数据（条目详情接口附带本地 galgame 库已回填的 ext.vndb，无匹配为 null）
const vndb = computed(() => subject.value?.vndb || null);
const VNDB_LENGTH = { 1: '很短', 2: '较短', 3: '中等', 4: '较长', 5: '很长' };
const VNDB_PLATFORMS = {
  win: 'Windows', lin: 'Linux', mac: 'macOS', ios: 'iOS', and: 'Android', web: '网页', mob: '手机(其他)',
  psp: 'PSP', psv: 'PS Vita', ps1: 'PS1', ps2: 'PS2', ps3: 'PS3', ps4: 'PS4', ps5: 'PS5',
  xb3: 'Xbox 360', xbo: 'Xbox One', xxs: 'Xbox Series', swi: 'Switch', sw2: 'Switch 2',
  nds: 'NDS', n3d: '3DS', gba: 'GBA', gbc: 'GBC', nes: 'FC/NES', sfc: 'SFC', wii: 'Wii', wiiu: 'Wii U',
  sat: '土星', drc: 'Dreamcast', vnd: 'VNDS', dos: 'DOS', fmt: 'FM Towns', p98: 'PC-98', pcf: 'PC-FX',
  dvd: 'DVD', bdp: '蓝光播放器', oth: '其他'
};
const VNDB_LANGS = { ja: '日语', zh: '中文', en: '英语', ko: '韩语', ru: '俄语', fr: '法语', de: '德语', es: '西班牙语', it: '意大利语', pt: '葡萄牙语' };
function vndbPlatformLabel(p) { return VNDB_PLATFORMS[p] || String(p || '').toUpperCase(); }
function vndbLengthLabel(n) { return VNDB_LENGTH[n] || (n ? String(n) : ''); }
function vndbLangLabel(l) { return VNDB_LANGS[l] || String(l || '').toUpperCase(); }
function vndbScore(n) { const x = Number(n); return x ? x.toFixed(1) : '—'; }

// 收藏编辑
const editing = ref(false);
const editForm = ref({ status: 1, score: 0, ep_status: 0, comment: '' });

const statusOptions = Object.entries(COLLECT_STATUS).map(([value, label]) => ({ label, value: +value }));

const infobox = computed(() => {
  const map = {};
  for (const item of subject.value?.infobox || []) {
    const v = Array.isArray(item.value) ? item.value.map(x => (typeof x === 'object' ? x.v : x)).join('、') : item.value;
    map[item.key] = v;
  }
  return map;
});

const infoLines = computed(() => {
  const m = infobox.value;
  const keys = [
    '话数', '放送开始', '放送星期', '播放电视台', '原作', '导演', '动画制作', '官网',
    '册数', '出版社', '作者', '发售日', '连载杂志', '文库', '页数', 'ISBN', '完结日期', '开始日期', '别名'
  ];
  const arr = [];
  for (const k of keys) if (m[k]) arr.push([k, m[k]]);
  return arr;
});

const epsWithStatus = computed(() => {
  const epStatus = collection.value ? +collection.value.ep_status : 0;
  return episodes.value.map((ep, i) => ({
    ...ep,
    done: ep.sort <= epStatus,
    isCur: ep.sort === epStatus + 1
  }));
});

async function loadSubject() {
  loading.value = true;
  error.value = '';
  subject.value = null;
  coverFailed.value = false;
  episodes.value = [];
  characters.value = [];
  staff.value = [];
  related.value = [];
  try {
    const [s, eps, chars, stf, rel] = await Promise.all([
      api.get('/anime/subjects/' + id.value),
      api.get('/anime/subjects/' + id.value + '/episodes?limit=200').catch(() => ({ data: [], total: 0 })),
      api.get('/anime/subjects/' + id.value + '/characters').catch(() => ({ data: [] })),
      api.get('/anime/subjects/' + id.value + '/persons').catch(() => ({ data: [] })),
      api.get('/anime/subjects/' + id.value + '/related').catch(() => ({ data: [] }))
    ]);
    subject.value = s;
    episodes.value = eps.data || [];
    epsTotal.value = eps.total || episodes.value.length;
    characters.value = (chars.data || []).filter(c => c.type === 1 || c.type === 2).slice(0, 24);
    staff.value = (stf.data || []).filter(pr => pr.type === 1).slice(0, 24);
    related.value = (rel.data || []).filter(r => r.type === 2).slice(0, 12);
  } catch (e) {
    error.value = e.message;
  }
  loading.value = false;
  loadCollection();
}

async function loadCollection() {
  if (!userStore.user) { collection.value = null; colLoading.value = false; return; }
  colLoading.value = true;
  try {
    const d = await api.get('/me/collections/' + id.value);
    collection.value = d.collection || null;
  } catch (e) {
    collection.value = null;
  }
  colLoading.value = false;
}

function openEdit(status) {
  const cur = collection.value || {};
  editForm.value = {
    status: status || cur.status || 1,
    score: cur.score || 0,
    ep_status: cur.ep_status || 0,
    comment: cur.comment || '',
    tags: parseTags(cur.tags)
  };
  editing.value = true;
}

async function saveCollection() {
  try {
    const d = await api.put('/collections/' + id.value, editForm.value);
    collection.value = { ...collection.value, ...editForm.value, subject_id: id.value };
    if (d && d.bgmSynced === false) message.warning('已保存（Bangumi 同步失败，稍后可重试）');
    else message.success('已保存');
    editing.value = false;
  } catch (e) {
    message.error(e.message);
  }
}

async function removeCollection() {
  try {
    await api.del('/collections/' + id.value);
    collection.value = null;
    message.success('已取消收藏');
  } catch (e) {
    message.error(e.message);
  }
}

async function markEp(ep) {
  if (!userStore.user) { login(); return; }
  const epStatus = ep.sort;
  editForm.value = {
    status: collection.value?.status || 3,
    score: collection.value?.score || 0,
    ep_status: epStatus,
    comment: collection.value?.comment || ''
  };
  try {
    const d = await api.put('/collections/' + id.value, editForm.value);
    collection.value = { ...(collection.value || {}), ...editForm.value, subject_id: id.value };
    if (d && d.bgmSynced === false) message.warning('进度已更新到第 ' + epStatus + ' 话（Bangumi 同步失败）');
    else message.success('进度已更新到第 ' + epStatus + ' 话');
  } catch (e) {
    message.error(e.message);
  }
}

function login() { location.href = '/login?redirect=' + encodeURIComponent(route.fullPath); }
// 返回上一页（从番剧库/漫画/轻小说/我的追番等进入时回到原位置）；无历史记录时回番剧库
function goBack() {
  const st = window.history.state;
  if (st && st.back) router.back();
  else router.replace('/anime');
}
onMounted(() => { window.addEventListener('resize', onWinResize); loadSubject(); });
onBeforeUnmount(() => window.removeEventListener('resize', onWinResize));
watch(id, loadSubject);
// 每条目加载完成后检测简介是否超长
watch(subject, (sVal) => {
  summaryExpanded.value = false;
  summaryLong.value = false;
  if (sVal && sVal.summary) nextTick(measureSummary);
});
</script>

<template>
  <div class="container">
    <n-spin :show="loading">
      <n-alert v-if="error" type="error" style="margin-top:20px">{{ error }}</n-alert>

      <template v-if="subject">
        <div class="back-row">
          <button class="back-btn" @click="goBack">← 返回</button>
        </div>
        <div class="detail-head" v-reveal>
          <div class="cover">
            <img v-if="subject.images && !coverFailed" :src="img(subject.images.common || subject.images.large)" :alt="subject.name_cn || subject.name" @error="coverFailed = true" />
            <div v-else class="cover-fallback">🎴</div>
          </div>
          <div class="main">
            <div class="names">
              <h1>{{ subject.name_cn || subject.name }}</h1>
              <div v-if="subject.name_cn" class="jp">{{ subject.name }}</div>
            </div>
            <div class="score-line">
              <span v-if="subject.rating && subject.rating.total" class="score">{{ scoreText(subject.rating.score) }}</span>
              <span v-if="subject.rating" class="muted">{{ subject.rating.total }} 人评分 · Rank {{ subject.rank || '-' }}</span>
              <n-tag v-if="subject.date" size="small" :bordered="false">{{ subject.date }}</n-tag>
              <n-tag size="small" type="info" :bordered="false">{{ subject.platform || '' }}</n-tag>
            </div>
            <div class="tags">
              <n-tag v-for="t in (subject.tags || []).slice(0, 12)" :key="t.name" size="small" :bordered="false" style="margin:2px">{{ t.name }}</n-tag>
            </div>
            <div class="col-actions" v-if="!colLoading">
              <template v-if="userStore.viewer">
                <n-tag size="small" round type="warning" :bordered="false">🌙 只读访客，不可修改收藏</n-tag>
              </template>
              <template v-else-if="userStore.user">
                <n-button v-for="(label, val) in COLLECT_STATUS" :key="val" size="small"
                  :type="collection && +collection.status === +val ? 'primary' : 'default'"
                  @click="openEdit(+val)">{{ label }}</n-button>
                <n-popconfirm v-if="collection" @positive-click="removeCollection">
                  <template #trigger><n-button size="small" type="error" quaternary>取消收藏</n-button></template>
                  确定要取消收藏吗？
                </n-popconfirm>
                <n-button v-if="collection" size="small" @click="openEdit(collection.status)">编辑</n-button>
              </template>
              <n-button v-else size="small" type="primary" @click="login">登录后追番</n-button>
            </div>
            <div v-if="collection && parseTags(collection.tags).length" class="my-tags">
              <span class="muted" style="margin-right:4px">我的标签：</span>
              <n-tag v-for="t in parseTags(collection.tags)" :key="t" size="small" type="info" :bordered="false" style="margin:2px">{{ t }}</n-tag>
            </div>
            <div v-if="subject.summary" class="summary-box" :class="{ long: summaryLong, expanded: summaryExpanded }">
                <div ref="summaryEl" class="summary" :class="{ expanded: summaryExpanded, long: summaryLong }">{{ subject.summary }}</div>
                <button v-if="summaryLong" class="summary-toggle" @click="toggleSummary">{{ summaryExpanded ? '收起 ↑' : '展开全部 ↓' }}</button>
              </div>
          </div>
        </div>

        <div class="detail-grid">
          <div class="left">
            <div v-if="infoLines.length" class="block">
              <div class="block-title">基本信息</div>
              <table class="info-table">
                <tr v-for="[k, v] in infoLines" :key="k"><td class="k">{{ k }}</td><td>{{ v }}</td></tr>
              </table>
            </div>

            <div class="block">
              <div class="block-title">章节 ({{ epsTotal }})</div>
              <div v-if="episodes.length" class="ep-list">
                <div v-for="ep in epsWithStatus" :key="ep.id" class="ep-item" :class="{ done: ep.done, cur: ep.isCur }"
                  :title="ep.name_cn || ep.name" @click="markEp(ep)">
                  {{ ep.sort }}<span v-if="ep.name_cn || ep.name" class="ep-name">{{ (ep.name_cn || ep.name).slice(0, 6) }}</span>
                </div>
              </div>
              <n-empty v-else description="暂无章节" :show-icon="false" style="padding:20px" />
            </div>

            <div v-if="characters.length" class="block">
              <div class="block-title">角色</div>
              <div class="char-grid">
                <div v-for="c in characters" :key="c.id" class="char-item">
                  <img v-if="c.images && c.images.grid && !charFailed[c.id]" :src="img(c.images.grid)" :alt="c.name" @error="charFailed[c.id] = true" />
                  <div v-else class="char-noimg">{{ c.name.slice(0, 1) }}</div>
                  <div class="char-name">{{ c.name_cn || c.name }}</div>
                </div>
              </div>

            <div v-if="staff.length" class="block">
              <div class="block-title">STAFF / 制作人员</div>
              <div class="char-grid">
                <div v-for="pr in staff" :key="pr.id" class="char-item">
                  <img v-if="pr.images && pr.images.grid" :src="img(pr.images.grid)" :alt="pr.name" @error="$event.target.style.display='none'" />
                  <div v-else class="char-noimg">{{ (pr.name_cn || pr.name).slice(0, 1) }}</div>
                  <div class="char-name">{{ pr.name_cn || pr.name }}</div>
                  <div class="char-relation">{{ (pr.career || []).concat(pr.relation ? [pr.relation] : []).slice(0, 3).join(' / ') }}</div>
                </div>
              </div>
            </div>
            </div>
          </div>

          <div class="right">
            <div v-if="vndb" class="block">
              <div class="block-title">
                VNDB 增强数据
                <a class="vndb-link" :href="'https://vndb.org/v' + vndb.id" target="_blank" rel="noopener">v{{ vndb.id }} ↗</a>
              </div>
              <div class="vndb-head">
                <img v-if="vndb.image" class="vndb-cover" :src="img(vndb.image)" alt="VNDB 封面" loading="lazy" @error="$event.target.style.display='none'" />
                <div v-else class="vndb-cover vndb-noimg">🎮</div>
                <div class="vndb-summary">
                  <div class="vndb-score-line">
                    <span class="vndb-score">{{ vndbScore(vndb.rating) }}</span>
                    <span class="muted">{{ vndb.votecount || 0 }} 人投票</span>
                  </div>
                  <div class="muted" style="font-size:12px">热度 {{ vndb.popularity || 0 }}</div>
                  <div v-if="vndb.title && vndb.title !== subject.name && vndb.title !== subject.name_cn" class="vndb-vntitle">{{ vndb.title }}</div>
                </div>
              </div>
              <table class="info-table">
                <tr v-if="vndb.developers && vndb.developers.length"><td class="k">开发商</td><td class="v">{{ vndb.developers.join('、') }}</td></tr>
                <tr v-if="vndb.released"><td class="k">发行日</td><td class="v">{{ vndb.released }}</td></tr>
                <tr v-if="vndb.olang"><td class="k">语言</td><td class="v">{{ vndbLangLabel(vndb.olang) }}</td></tr>
                <tr v-if="vndb.length"><td class="k">时长</td><td class="v">{{ vndbLengthLabel(vndb.length) }}</td></tr>
                <tr v-if="vndb.platforms && vndb.platforms.length"><td class="k">平台</td><td class="v">{{ vndb.platforms.map(vndbPlatformLabel).join(' / ') }}</td></tr>
              </table>
              <div v-if="vndb.aliases && vndb.aliases.length" class="vndb-aliases" :title="vndb.aliases.join('、')">
                别名：{{ vndb.aliases.slice(0, 6).join('、') }}<span v-if="vndb.aliases.length > 6">…</span>
              </div>
            </div>
            <div v-if="related.length" class="block">
              <div class="block-title">相关条目</div>
              <div class="related-list">
                <SubjectCard v-for="s in related" :key="s.id" :subject="s" />
              </div>
            </div>
          </div>
        </div>
      </template>
    </n-spin>

    <n-modal v-model:show="editing" preset="card" title="追番设置" style="width:420px;max-width:92vw">
      <div class="edit-form">
        <div class="field">
          <label>状态</label>
          <n-select v-model:value="editForm.status" :options="statusOptions" />
        </div>
        <div class="field">
          <label>评分 (0-10)</label>
          <n-rate v-model:value="editForm.score" :max="10" clearable />
          <span class="muted" style="margin-left:8px">{{ editForm.score }}</span>
        </div>
        <div class="field">
          <label>{{ subject.type === 1 ? '看到第几卷/话' : '看到第几话' }}</label>
          <n-input-number v-model:value="editForm.ep_status" :min="0" :max="Math.max(epsTotal, 1)" style="width:100%" />
        </div>
        <div class="field">
          <label>评论</label>
          <n-input v-model:value="editForm.comment" type="textarea" :rows="3" maxlength="1000" show-count placeholder="写点感想…" />
        </div>
        <div class="field">
          <label>标签（回车添加，最多 20 个）</label>
          <n-dynamic-tags v-model:value="editForm.tags" :max="20" placeholder="输入标签后回车" />
        </div>
        <n-button type="primary" block @click="saveCollection">保存</n-button>
      </div>
    </n-modal>
  </div>
</template>

<style scoped>
.back-row { padding: 6px 0 0; }
.back-btn {
  cursor: pointer; padding: 6px 18px; border-radius: 999px; font-size: 13px; font-weight: 600; letter-spacing: 1px;
  color: var(--text-dim); background: var(--back-btn-bg);
  border: 1px solid rgba(180, 138, 255, .35); transition: all .18s;
}
.back-btn:hover { color: var(--grad-text); background: linear-gradient(120deg, var(--accent), var(--accent-2)); border-color: transparent; transform: translateY(-1px); }
.detail-head { display: flex; gap: 24px; padding: 28px 0 8px; }
.detail-head .cover { width: 220px; flex-shrink: 0; aspect-ratio: 3/4; border-radius: 14px; overflow: hidden; background: var(--cover-grad); box-shadow: var(--shadow); }
.detail-head .cover img { width: 100%; height: 100%; object-fit: cover; }
.detail-head .cover .cover-fallback { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 44px; color: var(--accent); }
.main { flex: 1; min-width: 0; }
.names h1 { margin: 0 0 4px; font-size: 24px; }
.names .jp { color: var(--text-dim); font-size: 14px; }
.score-line { display: flex; align-items: center; gap: 12px; margin: 10px 0; }
.score { font-size: 26px; font-weight: 800; color: var(--accent); }
.tags { margin: 8px 0; }
.summary-box { position: relative; margin-top: 12px; }
.summary { position: relative; color: var(--text-dim); font-size: 13px; line-height: 1.7; max-height: 120px; overflow: hidden; white-space: pre-line; word-break: break-word; }
.summary.long:not(.expanded)::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 48px; pointer-events: none; background: linear-gradient(to bottom, transparent, var(--bg)); }
.summary.expanded { max-height: none; }
.summary-toggle { display: block; margin-top: 4px; padding: 0; border: none; background: none; color: var(--accent); font-size: 12px; cursor: pointer; opacity: .9; }
.summary-toggle:hover { opacity: 1; text-decoration: underline; }
.col-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
.my-tags { margin-top: 10px; font-size: 13px; }
.detail-grid { display: grid; grid-template-columns: 1fr 320px; gap: 24px; margin-top: 10px; }
.block { background: var(--bg-card); border: 1px solid var(--border); border-radius: 14px; padding: 16px; margin-bottom: 16px; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
.block-title { font-weight: 700; margin-bottom: 12px; }
.block-title::before { content: '✿ '; color: var(--accent); }
.info-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.info-table td { padding: 5px 8px; vertical-align: top; }
.info-table .k { color: var(--text-dim); width: 90px; white-space: nowrap; }
.ep-name { display: block; font-size: 10px; color: var(--text-dim); margin-top: 2px; }
.char-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 10px; }
.char-item { text-align: center; }
.char-item img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; }
.char-noimg { width: 100%; aspect-ratio: 1; background: var(--cover-grad); color: var(--accent); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 24px; }
.char-relation { margin-top: 4px; font-size: 11px; color: var(--muted, #8892b0); line-height: 1.3; word-break: break-all; }
.char-name { font-size: 12px; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.related-list { display: flex; flex-direction: column; gap: 10px; }
.related-list :deep(.subject-card) { flex-direction: row; align-items: center; }
.related-list :deep(.cover) { width: 64px; aspect-ratio: auto; height: 86px; flex-shrink: 0; }
.field { margin-bottom: 14px; }
.field label { display: block; font-size: 13px; color: var(--text-dim); margin-bottom: 6px; }
.vndb-link { float: right; font-size: 12px; color: var(--accent); text-decoration: none; opacity: .9; }
.vndb-link:hover { text-decoration: underline; opacity: 1; }
.vndb-head { display: flex; gap: 12px; align-items: flex-start; margin: 4px 0 10px; }
.vndb-cover { width: 82px; height: 116px; object-fit: cover; border-radius: 8px; background: var(--cover-grad); flex-shrink: 0; box-shadow: var(--shadow); }
.vndb-noimg { display: flex; align-items: center; justify-content: center; font-size: 30px; color: var(--accent); }
.vndb-summary { flex: 1; min-width: 0; }
.vndb-score-line { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.vndb-score { font-size: 24px; font-weight: 800; color: var(--accent); line-height: 1.15; }
.vndb-vntitle { margin-top: 8px; font-size: 12px; color: var(--text-dim); word-break: break-all; }
.info-table td.v { word-break: break-word; }
.vndb-aliases { margin-top: 8px; font-size: 11px; color: var(--text-dim); line-height: 1.6; word-break: break-all; }
@media (max-width: 900px) {
  .detail-head { flex-direction: column; }
  .detail-head .cover { width: 160px; }
  .detail-grid { grid-template-columns: 1fr; }
}
</style>
