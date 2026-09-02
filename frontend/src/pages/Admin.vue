<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { NButton, NTag, NModal, NInput, NInputNumber, NPopconfirm, NSwitch, NRadioGroup, NRadioButton, useMessage } from 'naive-ui';
import { api, fmtDate } from '../api';
import { useUserStore } from '../stores/user';

const router = useRouter();
const message = useMessage();
const userStore = useUserStore();

// ---------- 博客 ----------
const posts = ref([]);
const editing = ref(false);
const form = ref({ id: 0, slug: '', title: '', summary: '', content: '', tags: [], published: 1 });
const tagText = ref('');

async function load() {
  try {
    posts.value = await api.get('/blog/admin/posts');
  } catch (e) {
    if (e.status === 403 || e.status === 401) { router.replace('/'); return; }
    message.error(e.message);
  }
}

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
  try {
    if (form.value.id) await api.put('/blog/admin/posts/' + form.value.id, form.value);
    else await api.post('/blog/admin/posts', form.value);
    message.success('已保存');
    editing.value = false;
    load();
  } catch (e) { message.error(e.message); }
}
async function remove(id) {
  try {
    await api.del('/blog/admin/posts/' + id);
    message.success('已删除');
    load();
  } catch (e) { message.error(e.message); }
}

// ---------- 全站公告 ----------
const anns = ref([]);
const annEditing = ref(false);
const annForm = ref({ id: 0, title: '', content: '', published: 1 });
const annSaving = ref(false);

async function loadAnns() {
  try {
    const d = await api.get('/announce/admin/list');
    anns.value = (d && d.data) || [];
  } catch (e) { message.error(e.message); }
}

function openAnnNew() {
  annForm.value = { id: 0, title: '', content: '', published: 1 };
  annEditing.value = true;
}
function openAnnEdit(a) {
  annForm.value = { id: a.id, title: a.title, content: a.content || '', published: a.published };
  annEditing.value = true;
}
async function saveAnn() {
  if (!annForm.value.title.trim()) { message.warning('公告标题必填'); return; }
  annSaving.value = true;
  try {
    if (annForm.value.id) await api.put('/announce/' + annForm.value.id, annForm.value);
    else await api.post('/announce', annForm.value);
    message.success('公告已保存，发布后访客会看到弹窗');
    annEditing.value = false;
    loadAnns();
  } catch (e) { message.error(e.message); }
  annSaving.value = false;
}
async function toggleAnn(a) {
  try {
    await api.put('/announce/' + a.id, { ...a, published: a.published ? 0 : 1 });
    message.success(a.published ? '已下线' : '已发布');
    loadAnns();
  } catch (e) { message.error(e.message); }
}
async function removeAnn(id) {
  try {
    await api.del('/announce/' + id);
    message.success('已删除');
    loadAnns();
  } catch (e) { message.error(e.message); }
}

// ---------- 评论审核 ----------
const comments = ref([]);
const commentStatus = ref('pending');
const STATUS_TEXT = { pending: '待审', approved: '已通过', spam: '垃圾' };
const STATUS_TYPE = { pending: 'warning', approved: 'success', spam: 'error' };

async function loadComments() {
  try {
    const d = await api.get('/blog/comments?status=' + commentStatus.value);
    comments.value = (d && d.data) || [];
  } catch (e) { message.error(e.message); }
}
async function setCommentStatus(c, status) {
  try {
    await api.put('/blog/comments/' + c.id, { status });
    message.success(status === 'approved' ? '已通过' : status === 'spam' ? '已标记垃圾' : '已恢复待审');
    loadComments();
  } catch (e) { message.error(e.message); }
}
async function removeComment(id) {
  try {
    await api.del('/blog/comments/' + id);
    message.success('已删除');
    loadComments();
  } catch (e) { message.error(e.message); }
}

onMounted(() => { if (userStore.isOwner) { load(); loadAnns(); loadComments(); } else router.replace('/'); });
</script>

<template>
  <div class="container" style="max-width:900px">
    <div class="head">
      <h2><span class="emoji">🗒</span>站务管理</h2>
      <div class="actions">
        <n-button size="small" type="primary" @click="userStore.logout()">退出登录</n-button>
      </div>
    </div>

    <!-- 全站公告 -->
    <div class="section-title">
      <h3>📰 全站公告</h3>
      <n-button size="small" type="primary" @click="openAnnNew">发布公告</n-button>
    </div>
    <p class="section-hint muted">保存后勾选「已发布」即全站生效：访客首次访问弹出，点「知晓了」不再自动弹，之后可在导航栏「公告」中随时查看。</p>
    <div class="post-card" v-for="a in anns" :key="a.id">
      <h3>{{ a.title }} <n-tag v-if="!a.published" size="small" type="warning" :bordered="false">未发布</n-tag></h3>
      <div class="meta"><span>{{ fmtDate(a.created_at) }}</span><span class="muted">#{{ a.id }}</span></div>
      <div class="opts">
        <n-button size="tiny" @click="openAnnEdit(a)">编辑</n-button>
        <n-button size="tiny" :type="a.published ? 'warning' : 'success'" quaternary @click="toggleAnn(a)">{{ a.published ? '下线' : '发布' }}</n-button>
        <n-popconfirm @positive-click="removeAnn(a.id)">
          <template #trigger><n-button size="tiny" type="error" quaternary>删除</n-button></template>
          确定删除这条公告？
        </n-popconfirm>
      </div>
    </div>
    <div v-if="!anns.length" class="muted" style="padding:20px 0;text-align:center">还没有公告，点「发布公告」写第一条</div>

    <hr style="border-color:var(--nav-border);margin:26px 0" />

    <!-- 博客 -->
    <div class="section-title">
      <h3>📝 博客管理</h3>
      <n-button size="small" type="primary" @click="openNew">写新文章</n-button>
    </div>
    <div class="post-card" v-for="p in posts" :key="p.id">
      <h3>{{ p.title }} <n-tag v-if="!p.published" size="small" type="warning" :bordered="false">草稿</n-tag></h3>
      <div class="meta"><span>{{ fmtDate(p.created_at) }}</span><span class="muted">/blog/{{ p.slug }}</span></div>
      <div class="opts">
        <n-button size="tiny" @click="openEdit(p)">编辑</n-button>
        <n-popconfirm @positive-click="remove(p.id)">
          <template #trigger><n-button size="tiny" type="error" quaternary>删除</n-button></template>
          确定删除这篇文章？
        </n-popconfirm>
      </div>
    </div>
    <div v-if="!posts.length" class="muted" style="padding:40px 0;text-align:center">还没有文章</div>

    <hr style="border-color:var(--nav-border);margin:26px 0" />

    <!-- 评论审核 -->
    <div class="section-title">
      <h3>💬 评论审核</h3>
      <n-radio-group v-model:value="commentStatus" size="small" @update:value="loadComments">
        <n-radio-button value="pending">待审</n-radio-button>
        <n-radio-button value="approved">已通过</n-radio-button>
        <n-radio-button value="spam">垃圾</n-radio-button>
        <n-radio-button value="all">全部</n-radio-button>
      </n-radio-group>
    </div>
    <div class="comment-card" v-for="c in comments" :key="c.id">
      <div class="c-head">
        <span class="c-name">{{ c.name || '匿名' }}</span>
        <n-tag size="small" :type="STATUS_TYPE[c.status] || 'default'" :bordered="false">{{ STATUS_TEXT[c.status] || c.status }}</n-tag>
        <span class="c-post">在《{{ c.post_title || '?' }}》</span>
        <span class="muted">#{{ c.id }}</span>
      </div>
      <div class="c-content">{{ c.content }}</div>
      <div class="meta">
        <span>{{ fmtDate(c.created_at) }}</span>
        <span v-if="c.ip" class="muted">IP {{ c.ip }}</span>
        <span v-if="c.parent_id" class="muted">回复 #{{ c.parent_id }}</span>
      </div>
      <div class="opts">
        <n-button v-if="c.status !== 'approved'" size="tiny" type="success" quaternary @click="setCommentStatus(c, 'approved')">通过</n-button>
        <n-button v-if="c.status !== 'spam'" size="tiny" type="warning" quaternary @click="setCommentStatus(c, 'spam')">标记垃圾</n-button>
        <n-popconfirm @positive-click="removeComment(c.id)">
          <template #trigger><n-button size="tiny" type="error" quaternary>删除</n-button></template>
          确定删除这条评论？（子回复一并删除）
        </n-popconfirm>
      </div>
    </div>
    <div v-if="!comments.length" class="muted" style="padding:24px 0;text-align:center">当前状态下没有评论</div>

    <!-- 博客编辑弹窗 -->
    <n-modal v-model:show="editing" preset="card" title="编辑文章" style="width:760px;max-width:94vw">
      <div class="edit-form">
        <div class="row"><label>标题</label><n-input v-model:value="form.title" placeholder="文章标题" /></div>
        <div class="row"><label>Slug</label><n-input v-model:value="form.slug" placeholder="url 标识，如 my-first-post" /></div>
        <div class="row"><label>摘要</label><n-input v-model:value="form.summary" placeholder="列表页显示的一句话摘要" /></div>
        <div class="row"><label>标签</label><n-input v-model:value="tagText" placeholder="逗号分隔，如：技术, 随笔" /></div>
        <div class="row"><label>正文 (Markdown)</label><n-input v-model:value="form.content" type="textarea" :rows="16" placeholder="# 标题&#10;&#10;正文…" /></div>
        <div class="row"><label>发布（1=发布，0=草稿）</label><n-input-number v-model:value="form.published" :min="0" :max="1" style="width:100%" /></div>
        <n-button type="primary" block @click="save">保存</n-button>
      </div>
    </n-modal>

    <!-- 公告编辑弹窗 -->
    <n-modal v-model:show="annEditing" preset="card" title="编辑公告" style="width:620px;max-width:94vw">
      <div class="edit-form">
        <div class="row"><label>标题</label><n-input v-model:value="annForm.title" placeholder="如：本站将于今晚 0 点维护" /></div>
        <div class="row"><label>正文（每行一段）</label><n-input v-model:value="annForm.content" type="textarea" :rows="10" placeholder="公告内容…" /></div>
        <div class="row publish-row"><label>立即发布（访客会看到弹窗）</label><n-switch v-model:value="annForm.published" /></div>
        <n-button type="primary" block :loading="annSaving" @click="saveAnn">保存公告</n-button>
      </div>
    </n-modal>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; margin: 16px 0; }
.head h2 { margin: 0; }
.actions { display: flex; gap: 8px; }
.section-title { display: flex; align-items: center; justify-content: space-between; margin: 18px 0 12px; }
.section-title h3 { margin: 0; }
.section-hint { margin: 0 0 12px; font-size: 13px; }
.post-card { position: relative; }
.post-card h3 { margin: 0 0 6px; font-size: 17px; }
.meta { font-size: 12px; color: var(--text-dim); margin-bottom: 10px; display: flex; gap: 12px; }
.opts { display: flex; gap: 8px; }
.comment-card { margin: 10px 0; padding: 14px 18px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; }
.comment-card .c-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
.comment-card .c-name { font-weight: 700; color: var(--accent); }
.comment-card .c-post { font-size: 13px; color: var(--text-dim); }
.comment-card .c-content { font-size: 14px; line-height: 1.7; color: var(--text); white-space: pre-wrap; margin-bottom: 8px; }
.edit-form .row { margin-bottom: 12px; }
.edit-form label { display: block; font-size: 13px; color: var(--text-dim); margin-bottom: 5px; }
.publish-row { display: flex; align-items: center; justify-content: space-between; }
.publish-row label { margin: 0; }
</style>


