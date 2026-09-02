<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { NButton, NInput, NEmpty, NSpin, NPopconfirm, useMessage } from 'naive-ui';
import { api, fmtDate } from '../api';
import { useUserStore } from '../stores/user';

const props = defineProps({ slug: { type: String, required: true } });
const message = useMessage();
const userStore = useUserStore();

const loading = ref(true);
const posting = ref(false);
const comments = ref([]);
const content = ref('');
const replyTo = ref(null); // 回复的评论 id
const name = ref('');

// 扁平化 + 缩进深度
const flat = computed(() => {
  const out = [];
  const walk = (list, depth) => {
    for (const c of list) {
      out.push({ ...c, depth });
      if (c.children && c.children.length) walk(c.children, depth + 1);
    }
  };
  walk(comments.value, 0);
  return out;
});

async function load() {
  loading.value = true;
  try {
    const d = await api.get('/blog/posts/' + props.slug + '/comments');
    comments.value = d.data || [];
  } catch (e) { comments.value = []; }
  loading.value = false;
}

async function submit() {
  const text = content.value.trim();
  if (!text) { message.warning('评论内容不能为空'); return; }
  posting.value = true;
  try {
    const body = { content: text, parent_id: replyTo.value || 0 };
    if (!userStore.user) body.name = name.value.trim() || '匿名';
    const d = await api.post('/blog/posts/' + props.slug + '/comments', body);
    message.success(d.status === 'approved' ? '评论已发表' : '评论已提交，待站长审核后展示');
    content.value = '';
    replyTo.value = null;
    if (d.status === 'approved') load();
  } catch (e) {
    message.error(e.message);
  }
  posting.value = false;
}

function reply(c) {
  replyTo.value = replyTo.value === c.id ? null : c.id;
  if (replyTo.value) content.value = '';
}

async function remove(c) {
  try {
    await api.del('/blog/comments/' + c.id);
    message.success('已删除');
    load();
  } catch (e) { message.error(e.message); }
}

onMounted(load);
watch(() => props.slug, () => { replyTo.value = null; load(); });
</script>

<template>
  <div class="comment-section">
    <div class="cs-title">💬 评论 <span v-if="comments.length" class="cs-count">{{ comments.length }}</span></div>

    <n-spin :show="loading">
      <div class="comment-form">
        <n-input v-if="replyTo" size="small" style="margin-bottom:8px">
          <template #prefix>回复中</template>
        </n-input>
        <n-input
          v-model:value="content"
          type="textarea"
          :rows="3"
          maxlength="2000"
          show-count
          placeholder="写下你的评论…（站长会在后台审核后展示）"
        />
        <div class="form-foot">
          <n-input v-if="!userStore.user" v-model:value="name" placeholder="昵称（选填）" style="width:180px" />
          <span class="spacer"></span>
          <n-button v-if="replyTo" size="small" round @click="replyTo = null">取消回复</n-button>
          <n-button type="primary" round size="small" :loading="posting" @click="submit">发表评论</n-button>
        </div>
      </div>

      <div v-if="flat.length" class="comment-list">
        <div v-for="c in flat" :key="c.id" class="comment-item" :style="{ marginLeft: Math.min(c.depth, 5) * 26 + 'px' }">
          <div class="c-avatar">{{ (c.name || '匿')[0] }}</div>
          <div class="c-body">
            <div class="c-head">
              <span class="c-name">{{ c.name || '匿名' }}</span>
              <span class="c-time">{{ fmtDate(c.created_at) }}</span>
              <span class="spacer"></span>
              <n-button text size="tiny" type="primary" @click="reply(c)">回复</n-button>
              <n-popconfirm v-if="userStore.isOwner" @positive-click="remove(c)">
                <template #trigger><n-button text size="tiny" type="error">删除</n-button></template>
                确定删除这条评论？
              </n-popconfirm>
            </div>
            <div class="c-content">{{ c.content }}</div>
          </div>
        </div>
      </div>
      <n-empty v-else-if="!loading" description="还没有评论，来抢沙发～" style="padding:30px 0" />
    </n-spin>
  </div>
</template>

<style scoped>
.comment-section { margin-top: 34px; }
.cs-title { font-size: 17px; font-weight: 800; color: var(--text); margin-bottom: 12px; }
.cs-count { font-size: 13px; color: var(--accent); }
.comment-form {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 14px; padding: 14px; margin-bottom: 18px;
}
.form-foot { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.spacer { flex: 1; }
.comment-list { display: flex; flex-direction: column; }
.comment-item { display: flex; gap: 10px; padding: 12px 6px; border-bottom: 1px dashed var(--border); }
.comment-item:last-child { border-bottom: none; }
.c-avatar {
  width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: var(--grad-text); display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 15px;
}
.c-body { flex: 1; min-width: 0; }
.c-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.c-name { font-size: 13px; font-weight: 700; color: var(--accent); }
.c-time { font-size: 12px; color: var(--text-dim); }
.c-content { margin-top: 5px; font-size: 14px; line-height: 1.7; color: var(--text); word-break: break-word; white-space: pre-wrap; }
</style>
