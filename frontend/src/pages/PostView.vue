<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NSpin, NTag, NAlert, NButton } from 'naive-ui';
import { api, fmtDate } from '../api';
import { useUserStore } from '../stores/user';

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();
const post = ref(null);
const error = ref('');
const loading = ref(true);

// 仅站长本人可编辑（管理令牌已移除，改走登录态）
const canEdit = computed(() => userStore.isOwner);

async function load() {
  loading.value = true;
  error.value = '';
  post.value = null;
  try {
    post.value = await api.get('/blog/posts/' + route.params.slug);
  } catch (e) {
    error.value = e.message;
  }
  loading.value = false;
}

onMounted(load);
watch(() => route.params.slug, load);

function goEdit() {
  router.push('/blog?edit=' + encodeURIComponent(route.params.slug));
}
</script>

<template>
  <div class="container" style="max-width:820px">
    <n-spin :show="loading">
      <n-alert v-if="error" type="error" style="margin-top:20px">{{ error }}</n-alert>
      <article v-if="post" class="article-card" v-reveal>
        <div class="title-row">
          <h1 class="title grad-title">✿ {{ post.title }}</h1>
          <n-button v-if="canEdit" size="small" round secondary @click="goEdit">✏️ 编辑</n-button>
        </div>
        <div class="meta">
          <span class="date-pill">{{ fmtDate(post.created_at) }}</span>
          <n-tag v-for="t in post.tags" :key="t" size="small" :bordered="false" type="info">{{ t }}</n-tag>
        </div>
        <div class="markdown-body" v-html="post.html"></div>
      </article>
    </n-spin>
  </div>
</template>

<style scoped>
.title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.title { margin: 0 0 10px; font-size: 30px; line-height: 1.35; }
.meta { display: flex; gap: 10px; align-items: center; color: var(--text-dim); font-size: 13px; padding-bottom: 18px; border-bottom: 1px solid var(--border); margin-bottom: 20px; flex-wrap: wrap; }
.date-pill { background: rgba(242,185,78,.12); border: 1px solid rgba(242,185,78,.35); color: #f2b94e; padding: 2px 11px; border-radius: 999px; }
</style>