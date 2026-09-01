<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api';

const list = ref([]);
const loading = ref(true);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const d = await api.get('/announce/list');
    list.value = (d && d.data) || [];
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

const paragraphs = (s) => String(s || '').split(/\r?\n+/).filter(Boolean);

onMounted(load);
</script>

<template>
  <div class="container" style="max-width:860px">
    <div class="head">
      <h2><span class="emoji">📰</span>公告中心</h2>
      <div class="head-sub muted">文文。新闻速报 · 妖怪之山的独家放送</div>
    </div>

    <div v-if="loading" class="muted" style="padding:60px 0;text-align:center">🌙 加载中…</div>
    <div v-else-if="error" class="muted" style="padding:60px 0;text-align:center">公告加载失败：{{ error }}</div>
    <div v-else-if="!list.length" class="muted" style="padding:60px 0;text-align:center">暂无公告，敬请期待文文的下一条速报</div>

    <article v-for="a in list" :key="a.id" class="ann-card">
      <div class="ann-head">
        <span class="ann-badge">文文。新闻</span>
        <span class="ann-vol">号外 · 第{{ a.id }}刊</span>
        <span class="ann-date">{{ new Date(a.created_at).toLocaleDateString('zh-CN') }}</span>
      </div>
      <h3>{{ a.title }}</h3>
      <div class="ann-body">
        <p v-for="(p, i) in paragraphs(a.content)" :key="i" :class="{ sign: p.trim().startsWith('——') }">{{ p }}</p>
      </div>
      <div class="ann-sign">—— 射命丸文 · 于妖怪之山</div>
    </article>
  </div>
</template>

<style scoped>
.head { margin: 8px 0 18px; }
.head h2 { margin: 0 0 4px; }
.head-sub { font-size: 13px; letter-spacing: 1px; }
.ann-card {
  position: relative;
  background: var(--ann-grad);
  border: 1px solid var(--ann-border);
  border-radius: 18px;
  padding: 22px 24px;
  margin-bottom: 16px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, .35);
  overflow: hidden;
}
.ann-card::before {
  content: ''; position: absolute; top: -40px; right: -40px;
  width: 130px; height: 130px;
  background: radial-gradient(circle, var(--announce-glow), transparent 70%);
  pointer-events: none;
}
.ann-card::after {
  content: '🌸'; position: absolute; bottom: 10px; left: 14px; font-size: 16px; opacity: .45; pointer-events: none;
}
.ann-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.ann-badge {
  background: var(--announce-badge);
  color: var(--announce-badge-text); font-weight: 800; font-size: 12px; letter-spacing: 2px;
  padding: 4px 11px; border-radius: 999px;
}
.ann-vol { color: var(--ann-vol); font-size: 12px; letter-spacing: 2px; }
.ann-date { margin-left: auto; font-size: 12px; color: var(--text-dim); }
.ann-card h3 { margin: 0 0 8px; font-size: 19px; color: var(--announce-title); letter-spacing: 1px; }
.ann-body p { margin: 8px 0; font-size: 14px; line-height: 1.85; color: var(--text-2); }
.ann-body .sign { text-align: right; color: var(--ann-sign); font-size: 12px; margin-top: 12px; letter-spacing: 1px; }
@media (max-width: 560px) {
  .ann-date { margin-left: 0; width: 100%; }
}
</style>

