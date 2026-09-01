<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { NInput, NTag, NPagination, NSpin, NEmpty, NButton, NModal, NSelect, NPopconfirm, NInputNumber, useMessage } from 'naive-ui';
import { api, fmtDate } from '../api';
import { useUserStore } from '../stores/user';

const route = useRoute();
const message = useMessage();
const userStore = useUserStore();

const posts = ref([]);
const tags = ref([]);
const total = ref(0);
const page = ref(1);
const size = 10;
const q = ref('');
const activeTag = ref('');
const loading = ref(true);

// ---------- 写作权限：仅站长本人（访客/普通用户只读） ----------
const canWrite = computed(() => userStore.isOwner);

// ---------- 编辑器 ----------
const editing = ref(false);
const saving = ref(false);
const form = ref({ id: 0, slug: '', title: '', summary: '', content: '', tags: [], published: 1 });
const tagText = ref('');

function openNew() {
  form.value = { id: 0, slug: '', title: '', summary: '', content: '', tags: [], published: 1 };
  tagText.value = '';
  editing.value = true;
}
function openEdit(p) {
  form.value = { id: p.id, slug: p.slug, title: p.title, summary: p.summary || '', content: '', tags: [], published: p.published };
  tagText.value = '';
  editing.value = true;
  api.get('/blog/posts/' + p.slug).then(d => {
    form.value.content = d.content || '';
    form.value.tags = d.tags || [];
    tagText.value = d.tags.join(', ');
  }).catch(() => {});
}
async function save() {
  if (!form.value.title.trim() || !form.value.slug.trim()) { message.warning('标题和 slug 必填'); return; }
  form.value.tags = tagText.value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  saving.value = true;
  try {
    if (form.value.id) await api.put('/blog/admin/posts/' + form.value.id, form.value);
    else await api.post('/blog/admin/posts', form.value);
    message.success('已保存');
    editing.value = false;
    await Promise.all([load(), loadTags()]);
  } catch (e) { message.error(e.message); }
  saving.value = false;
}
async function remove(id) {
  try {
    await api.del('/blog/admin/posts/' + id);
    message.success('已删除');
    await Promise.all([load(), loadTags()]);
  } catch (e) { message.error(e.message); }
}

// ---------- 图片上传 ----------
const fileInput = ref(null);
const uploading = ref(false);
const contentRef = ref(null);

function pickImage() { fileInput.value && fileInput.value.click(); }
async function onFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 6 * 1024 * 1024) { message.warning('图片不能超过 6MB'); return; }
  uploading.value = true;
  try {
    const { data, mime } = await compressImage(file);
    const d = await api.post('/blog/upload', { data, mime });
    insertIntoContent('\n\n![](' + d.url + ')\n\n');
    message.success('图片已插入正文');
  } catch (err) { message.error('上传失败：' + (err.message || '未知错误')); }
  uploading.value = false;
}
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result);
      if (file.type === 'image/gif' || file.size <= 350 * 1024) {
        resolve({ data: base64.split(',')[1], mime: file.type || 'image/png' });
        return;
      }
      const img = new Image();
      img.onload = () => {
        const maxW = 1600, maxH = 1600;
        let w = img.width, h = img.height;
        if (w > maxW) { h = h * maxW / w; w = maxW; }
        if (h > maxH) { w = w * maxH / h; h = maxH; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        let out = file.type === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85);
        if (out.length > 3.5 * 1024 * 1024) out = canvas.toDataURL('image/jpeg', 0.7);
        const mime = out.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
        resolve({ data: out.split(',')[1], mime });
      };
      img.onerror = () => reject(new Error('图片解析失败'));
      img.src = base64;
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}
function insertIntoContent(text) {
  const el = contentRef.value;
  if (!el) { form.value.content += text; return; }
  const start = el.selectionStart ?? form.value.content.length;
  const end = el.selectionEnd ?? form.value.content.length;
  form.value.content = form.value.content.slice(0, start) + text + form.value.content.slice(end);
  setTimeout(() => { el.focus(); el.selectionStart = el.selectionEnd = start + text.length; }, 30);
}

// ---------- 资讯 ----------
const tab = ref('posts');
const newsList = ref([]);
const newsSources = ref([]);
const newsTotal = ref(0);
const newsPage = ref(1);
const newsSize = 12;
const newsSource = ref('');
const newsLoading = ref(false);
const SOURCE_MAP = {};
async function loadSources() {
  try {
    const d = await api.get('/news/sources');
    newsSources.value = d.sources || [];
    for (const s of newsSources.value) SOURCE_MAP[s.key] = s;
  } catch (e) { newsSources.value = []; }
}
async function loadNews() {
  newsLoading.value = true;
  try {
    const params = new URLSearchParams({ page: newsPage.value, size: newsSize });
    if (newsSource.value) params.set('source', newsSource.value);
    const d = await api.get('/news?' + params.toString());
    newsList.value = d.data || [];
    newsTotal.value = d.total || 0;
  } catch (e) { newsList.value = []; }
  newsLoading.value = false;
}
function pickNews(k) { newsSource.value = k; newsPage.value = 1; loadNews(); }
function sourceName(k) { return (SOURCE_MAP[k] || {}).name || k; }
function sourceEmoji(k) { return (SOURCE_MAP[k] || {}).emoji || '📰'; }

// ---------- 列表 ----------
async function loadTags() {
  try { tags.value = await api.get('/blog/tags'); } catch (e) { tags.value = []; }
}
async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: page.value, size });
    if (q.value.trim()) params.set('q', q.value.trim());
    if (activeTag.value) params.set('tag', activeTag.value);
    const d = await api.get('/blog/posts?' + params.toString());
    posts.value = d.data || [];
    total.value = d.total || 0;
    if (route.query.edit) {
      const target = posts.value.find(p => p.slug === route.query.edit);
      if (target) openEdit(target);
    }
  } catch (e) { posts.value = []; }
  loading.value = false;
}
function pickTag(t) { activeTag.value = t === activeTag.value ? '' : t; page.value = 1; load(); }
onMounted(async () => {
  loadTags();
  load();
  loadNews();
  loadSources();
});
</script>

<template>
  <div class="container" style="max-width:860px">
    <div class="blog-head" v-reveal>
      <div class="head-left">
        <span class="emoji">📖</span><h2>博客</h2>
        <span class="muted head-sub">追番之外的碎碎念</span>
      </div>
      <div class="head-right">
        <n-input v-model:value="q" placeholder="搜索文章…" clearable style="max-width:260px" @keyup.enter="page=1; load()" />
        <n-button v-if="canWrite" type="primary" round @click="openNew">✍️ 写文章</n-button>
      </div>
    </div>

    <div class="blog-tabs">
      <button class="btab" :class="{ active: tab === 'posts' }" @click="tab = 'posts'">📝 文章</button>
      <button class="btab" :class="{ active: tab === 'news' }" @click="tab = 'news'">📰 资讯速递</button>
    </div>

    <template v-if="tab === 'posts'">
    <div class="tool-row">
      <div v-if="tags.length" class="tag-bar">
        <n-tag :type="activeTag === '' ? 'primary' : 'default'" :bordered="false" checkable :checked="activeTag === ''" @click="pickTag('')">全部</n-tag>
        <n-tag v-for="t in tags" :key="t.name" :bordered="false" :type="activeTag === t.name ? 'primary' : 'default'"
          checkable :checked="activeTag === t.name" @click="pickTag(t.name)">{{ t.name }} {{ t.count }}</n-tag>
      </div>
    </div>

    <n-spin :show="loading">
      <div v-for="p in posts" :key="p.id" class="post-card">
        <router-link :to="'/blog/' + p.slug" class="post-link">
          <h3>{{ p.title }}</h3>
          <div class="summary">{{ p.summary }}</div>
        </router-link>
        <div class="meta">
          <span>{{ fmtDate(p.created_at) }}</span>
          <n-tag v-for="t in p.tags" :key="t" size="small" :bordered="false" type="info">{{ t }}</n-tag>
          <span class="spacer"></span>
          <template v-if="canWrite">
            <n-button size="tiny" round secondary @click.stop="openEdit(p)">✏️ 编辑</n-button>
            <n-popconfirm @positive-click.stop="remove(p.id)">
              <template #trigger><n-button size="tiny" round type="error" quaternary @click.stop>删除</n-button></template>
              确定删除这篇文章？
            </n-popconfirm>
          </template>
        </div>
      </div>
      <n-empty v-if="!loading && !posts.length" :description="canWrite ? '还没有文章，点右上角「写文章」发布第一篇吧' : '站长还没写文章，先逛逛番剧库吧'" style="padding:60px 0">
        <template #extra>
          <n-button v-if="canWrite" type="primary" round @click="openNew">✍️ 写第一篇</n-button>
        </template>
      </n-empty>
    </n-spin>

    <div v-if="total > size" style="display:flex;justify-content:center;margin-top:20px">
      <n-pagination v-model:page="page" :page-size="size" :item-count="total" @update:page="load" />
    </div>

    </template>

    <div v-else class="news-wrap">
      <div class="news-bar">
        <span class="news-title">📰 二次元资讯速递</span>
        <div class="news-filters">
          <button class="chip" :class="{ on: newsSource === '' }" @click="pickNews('')">全部</button>
          <button v-for="s in newsSources" :key="s.key" class="chip" :class="{ on: newsSource === s.key }" @click="pickNews(s.key)">{{ s.emoji }} {{ s.name }}</button>
        </div>
      </div>
      <n-spin :show="newsLoading">
        <div v-for="n in newsList" :key="n.id" class="news-card">
          <a class="news-cover" :href="n.link" target="_blank" rel="noopener">
            <img v-if="n.cover" :src="n.cover" loading="lazy" alt="" />
            <span v-else class="cover-ph">{{ sourceEmoji(n.source) }}</span>
          </a>
          <div class="news-body">
            <a class="news-link" :href="n.link" target="_blank" rel="noopener"><h3>{{ n.title }}</h3></a>
            <p class="news-summary">{{ n.summary }}</p>
            <div class="news-meta">
              <span class="src-tag">{{ sourceEmoji(n.source) }} {{ sourceName(n.source) }}</span>
              <span>{{ fmtDate(n.published_at) }}</span>
              <span class="spacer"></span>
              <a class="read-more" :href="n.link" target="_blank" rel="noopener">阅读原文 ↗</a>
            </div>
          </div>
        </div>
        <n-empty v-if="!newsLoading && !newsList.length" description="资讯抓取中，稍后再来看看～" style="padding:60px 0" />
      </n-spin>
      <div v-if="newsTotal > newsSize" style="display:flex;justify-content:center;margin-top:20px">
        <n-pagination v-model:page="newsPage" :page-size="newsSize" :item-count="newsTotal" @update:page="loadNews" />
      </div>
    </div>

    <!-- 管理令牌 -->
    <!-- 写文章 / 编辑 -->
    <n-modal v-model:show="editing" preset="card" :title="form.id ? '✏️ 编辑文章' : '✍️ 写文章'" style="width:840px;max-width:96vw">
      <div class="edit-form">
        <div class="row"><label>标题 *</label><n-input v-model:value="form.title" placeholder="文章标题" /></div>
        <div class="row row2">
          <div><label>Slug *</label><n-input v-model:value="form.slug" placeholder="url 标识，如 my-post" /></div>
          <div><label>状态</label>
            <n-select v-model:value="form.published" :options="[{ label: '发布', value: 1 }, { label: '草稿', value: 0 }]" />
          </div>
        </div>
        <div class="row"><label>摘要</label><n-input v-model:value="form.summary" placeholder="列表页显示的一句话摘要" /></div>
        <div class="row"><label>标签（逗号分隔，如：技术, 随笔）</label><n-input v-model:value="tagText" placeholder="技术, 二次元, 随笔" /></div>
        <div class="row">
          <div class="editor-bar">
            <label>正文 (Markdown)</label>
            <div class="editor-tools">
              <n-button size="tiny" round secondary :loading="uploading" @click="pickImage">📷 插入图片</n-button>
              <span class="muted editor-hint">上传后会自动插入到光标位置</span>
            </div>
          </div>
          <n-input ref="contentRef" v-model:value="form.content" type="textarea" :rows="16" placeholder="# 标题&#10;&#10;正文…" />
          <input ref="fileInput" type="file" accept="image/*" style="display:none" @change="onFile" />
        </div>
        <n-button type="primary" block :loading="saving" @click="save">保存</n-button>
      </div>
    </n-modal>
  </div>
</template>

<style scoped>
.blog-head { display: flex; align-items: center; justify-content: space-between; margin: 8px 0 16px; flex-wrap: wrap; gap: 10px; }
.head-left { display: flex; align-items: center; gap: 10px; }
.head-left h2 { margin: 0; }
.head-sub { font-size: 13px; }
.head-right { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.tool-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
.tag-bar { display: flex; flex-wrap: wrap; gap: 8px; }
.mode-tag { background: var(--tag-gold-bg); color: var(--tag-gold-text); border-color: var(--tag-gold-border); }
.post-card { position: relative; }
.post-link { display: block; }
.post-link h3 { margin: 0 0 8px; font-size: 18px; color: var(--text); }
.post-card:hover .post-link h3 { color: var(--accent); }
.edit-form .row { margin-bottom: 12px; }
.edit-form .row2 { display: grid; grid-template-columns: 1fr 160px; gap: 12px; }
.edit-form label { display: block; font-size: 13px; color: var(--text-dim); margin-bottom: 5px; }
.editor-bar { display: flex; align-items: center; justify-content: space-between; }
.editor-tools { display: flex; align-items: center; gap: 8px; }
.editor-hint { font-size: 12px; }
.token-box { padding: 4px 0; }
@media (max-width: 720px) {
  .edit-form .row2 { grid-template-columns: 1fr; }
}

.blog-tabs { display: flex; gap: 10px; margin: 4px 0 18px; }
.btab { border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim); border-radius: 999px; padding: 7px 20px; font-size: 14px; cursor: pointer; transition: all .2s; font-family: inherit; }
.btab:hover { border-color: var(--accent); color: var(--accent); }
.btab.active { background: var(--grad-gold); color: var(--grad-text); border-color: transparent; box-shadow: 0 4px 14px var(--seg-shadow); }
.news-wrap { margin-top: 6px; }
.news-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.news-title { font-size: 17px; font-weight: 700; color: var(--text); }
.news-filters { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim); border-radius: 999px; padding: 5px 14px; font-size: 13px; cursor: pointer; transition: all .2s; font-family: inherit; }
.chip:hover { border-color: var(--accent); color: var(--accent); }
.chip.on { background: var(--tag-gold-bg); color: var(--tag-gold-text); border-color: var(--tag-gold-border); font-weight: 600; }
.news-card { display: flex; gap: 14px; padding: 14px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 16px; margin-bottom: 12px; transition: all .2s; }
.news-card:hover { border-color: var(--accent); box-shadow: 0 6px 18px rgba(0,0,0,.45); transform: translateY(-1px); }
.news-cover { width: 128px; min-width: 128px; height: 80px; border-radius: 10px; overflow: hidden; display: flex; align-items: center; justify-content: center; background: var(--cover-grad); border: 1px solid var(--border); }
.news-cover img { width: 100%; height: 100%; object-fit: cover; }
.cover-ph { font-size: 30px; }
.news-body { flex: 1; min-width: 0; }
.news-link { display: block; }
.news-link h3 { margin: 0 0 6px; font-size: 16px; line-height: 1.45; color: var(--text); }
.news-link:hover h3 { color: var(--accent); }
.news-summary { margin: 0 0 8px; font-size: 13px; color: var(--text-dim); line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.news-meta { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--text-dim); }
.src-tag { background: var(--src-tag-bg); border: 1px solid var(--src-tag-border); color: var(--src-tag-text); padding: 2px 10px; border-radius: 999px; }
.read-more { color: var(--accent); text-decoration: none; font-weight: 600; }
.read-more:hover { text-decoration: underline; }
@media (max-width: 560px) {
  .news-cover { width: 96px; min-width: 96px; height: 66px; }
}
</style>
