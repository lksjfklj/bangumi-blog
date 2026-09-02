<script setup>
import { ref, computed, onMounted } from 'vue';
import { NSelect, NSpin, NEmpty, NAlert } from 'naive-ui';
import { api, img, fmtDate, scoreText } from '../api';

const loading = ref(true);
const errorMsg = ref('');
const year = ref(new Date().getFullYear());
const data = ref(null);

const yearOptions = computed(() => {
  const cur = new Date().getFullYear();
  const list = [];
  for (let y = cur; y >= 2020; y--) list.push({ label: y + ' 年', value: y });
  return list;
});

const statusLabels = { 1: '想看', 2: '看过', 3: '在看', 4: '搁置', 5: '抛弃' };
const statusColors = { 1: '#6ea8fe', 2: '#6cc96c', 3: '#f2b94e', 4: '#a0a0a0', 5: '#e5484d' };

async function load() {
  loading.value = true;
  errorMsg.value = '';
  try {
    data.value = await api.get('/collections/stats?year=' + year.value);
  } catch (e) {
    errorMsg.value = e.message;
  }
  loading.value = false;
}

const maxScoreCount = computed(() => Math.max(1, ...(data.value?.yearStats?.scoreDist || []).map(d => d.count)));
const maxMonthCount = computed(() => Math.max(1, ...(data.value?.yearStats?.monthly || []).map(m => m.count)));
const statusList = computed(() => {
  const o = data.value?.overview?.byStatus || {};
  return [1, 2, 3, 4, 5].map(s => ({ s, label: statusLabels[s], count: o[s] || 0, color: statusColors[s] }));
});
const maxTagCount = computed(() => Math.max(1, ...(data.value?.yearStats?.tags || []).map(t => t.count)));

onMounted(load);
</script>

<template>
  <div class="container" style="max-width:960px">
    <div class="page-head" v-reveal>
      <span class="emoji">📊</span><h2>追番统计</h2>
      <div class="head-right">
        <n-select v-model:value="year" :options="yearOptions" style="width:130px" @update:value="load" />
      </div>
    </div>

    <n-spin :show="loading">
      <n-alert v-if="errorMsg" type="error" style="margin:10px 0">{{ errorMsg }}</n-alert>
      <n-empty v-else-if="!data" description="暂无数据" style="padding:60px 0" />

      <template v-else>
        <!-- 全量概览 -->
        <div class="stat-cards" v-reveal>
          <div class="stat-card"><span class="num grad">{{ data.overview.total }}</span><span class="lbl">收藏总数</span></div>
          <div class="stat-card"><span class="num">{{ data.overview.watched }}</span><span class="lbl">看过</span></div>
          <div class="stat-card"><span class="num">{{ data.overview.avgScore }}</span><span class="lbl">平均评分</span></div>
          <div class="stat-card"><span class="num">{{ data.overview.rated }}</span><span class="lbl">已评分</span></div>
        </div>

        <div class="status-bar card" v-reveal>
          <div class="card-title">收藏状态分布</div>
          <div class="status-row" v-for="st in statusList" :key="st.s">
            <span class="st-label" :style="{ color: st.color }">{{ st.label }}</span>
            <div class="st-track"><div class="st-fill" :style="{ width: (st.count / Math.max(1, data.overview.total) * 100) + '%', background: st.color }"></div></div>
            <span class="st-count">{{ st.count }}</span>
          </div>
        </div>

        <!-- 年度总结 -->
        <div class="section-title" v-reveal>⚡ {{ year }} 年度总结</div>
        <div class="year-banner card" v-reveal>
          <span class="yb-num">{{ data.yearStats.watched }}</span>
          <span class="yb-txt">部动画在 {{ year }} 年被你标记为「看过」</span>
        </div>

        <div class="two-col">
          <div class="card" v-reveal>
            <div class="card-title">评分分布</div>
            <div class="bar-rows">
              <div v-for="d in data.yearStats.scoreDist" :key="d.score" class="bar-row">
                <span class="bar-lbl">{{ d.score }}</span>
                <div class="bar-track"><div class="bar-fill" :style="{ width: (d.count / maxScoreCount * 100) + '%' }"></div></div>
                <span class="bar-count">{{ d.count }}</span>
              </div>
            </div>
          </div>
          <div class="card" v-reveal>
            <div class="card-title">月度追番时间线</div>
            <div class="bar-rows">
              <div v-for="m in data.yearStats.monthly" :key="m.month" class="bar-row">
                <span class="bar-lbl">{{ Number(m.month.slice(5)) }}月</span>
                <div class="bar-track"><div class="bar-fill" :style="{ width: (m.count / maxMonthCount * 100) + '%' }"></div></div>
                <span class="bar-count">{{ m.count }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="card" v-reveal>
          <div class="card-title">标签云</div>
          <div v-if="data.yearStats.tags.length" class="tag-cloud">
            <span v-for="t in data.yearStats.tags" :key="t.name" class="cloud-tag"
              :style="{ fontSize: 12 + Math.round(t.count / maxTagCount * 10) + 'px', opacity: 0.55 + (t.count / maxTagCount) * 0.45 }"
              :title="t.name + ' × ' + t.count">{{ t.name }}</span>
          </div>
          <p v-else class="muted">今年还没有标签记录</p>
        </div>

        <div class="card" v-reveal>
          <div class="card-title">最近看完（{{ year }} 年）</div>
          <div v-if="data.yearStats.timeline.length" class="timeline">
            <router-link v-for="(t, i) in data.yearStats.timeline" :key="t.subject_id" :to="'/subject/' + t.subject_id" class="tl-item">
              <img class="tl-cover" :src="img(t.image)" :alt="t.name_cn || t.name" loading="lazy" />
              <div class="tl-info">
                <div class="tl-name">{{ t.name_cn || t.name }}</div>
                <div class="tl-meta">{{ fmtDate(t.watched_at) }}<span v-if="t.score" class="tl-score">★ {{ scoreText(t.score) }}</span></div>
              </div>
              <span class="tl-no">{{ String(i + 1).padStart(2, '0') }}</span>
            </router-link>
          </div>
          <n-empty v-else description="该年度暂无记录" style="padding:40px 0" />
        </div>
      </template>
    </n-spin>
  </div>
</template>

<style scoped>
.page-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.head-right { margin-left: auto; }
.stat-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 16px 0; }
.stat-card {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 14px;
  padding: 18px 10px; text-align: center; transition: transform .18s, border-color .18s;
}
.stat-card:hover { transform: translateY(-2px); border-color: var(--accent); }
.stat-card .num { display: block; font-size: 30px; font-weight: 800; color: var(--text); }
.stat-card .num.grad {
  background: linear-gradient(120deg, var(--accent), var(--accent-2));
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
.stat-card .lbl { display: block; margin-top: 4px; font-size: 13px; color: var(--text-dim); }
.card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; margin-top: 14px; }
.card-title { font-size: 15px; font-weight: 800; color: var(--text); margin-bottom: 12px; }
.muted { color: var(--text-dim); font-size: 13px; }
.section-title { font-size: 18px; font-weight: 800; margin: 22px 0 4px; color: var(--accent); }
.year-banner { display: flex; align-items: baseline; gap: 12px; justify-content: center; padding: 26px 20px; }
.yb-num {
  font-size: 46px; font-weight: 900;
  background: linear-gradient(120deg, var(--accent), var(--accent-2));
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
.yb-txt { font-size: 15px; color: var(--text-dim); }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.status-row { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
.st-label { width: 40px; font-size: 13px; font-weight: 600; }
.st-track { flex: 1; height: 10px; background: var(--bg-soft); border-radius: 999px; overflow: hidden; }
.st-fill { height: 100%; border-radius: 999px; transition: width .6s; }
.st-count { width: 36px; text-align: right; font-size: 13px; color: var(--text-dim); }
.bar-rows { display: flex; flex-direction: column; gap: 5px; }
.bar-row { display: flex; align-items: center; gap: 8px; }
.bar-lbl { width: 34px; font-size: 12px; color: var(--text-dim); text-align: right; }
.bar-track { flex: 1; height: 8px; background: var(--bg-soft); border-radius: 999px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--accent-2)); transition: width .6s; }
.bar-count { width: 30px; font-size: 12px; color: var(--text-dim); }
.tag-cloud { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
.cloud-tag { color: var(--accent); cursor: default; line-height: 1.3; transition: all .15s; }
.cloud-tag:hover { color: var(--accent-2); transform: scale(1.08); }
.timeline { display: flex; flex-direction: column; }
.tl-item { display: flex; align-items: center; gap: 12px; padding: 8px 4px; border-bottom: 1px dashed var(--border); text-decoration: none; color: inherit; }
.tl-item:last-child { border-bottom: none; }
.tl-item:hover .tl-name { color: var(--accent); }
.tl-cover { width: 44px; height: 60px; object-fit: cover; border-radius: 6px; background: var(--cover-grad); }
.tl-info { flex: 1; min-width: 0; }
.tl-name { font-size: 14px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tl-meta { font-size: 12px; color: var(--text-dim); margin-top: 3px; display: flex; gap: 10px; align-items: center; }
.tl-score { color: #f2b94e; }
.tl-no { font-size: 22px; font-weight: 800; color: var(--border); }
@media (max-width: 720px) {
  .stat-cards { grid-template-columns: repeat(2, 1fr); }
  .two-col { grid-template-columns: 1fr; }
}
</style>
