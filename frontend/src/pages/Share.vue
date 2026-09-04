<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NSpin, NEmpty, NAlert, NTag, NButton } from 'naive-ui';
import { api, img, scoreText, parseTags } from '../api';

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const errorMsg = ref('');
const data = ref(null);

const STATUS_TEXT = { 1: '想看', 2: '看过', 3: '在看', 4: '搁置', 5: '抛弃' };
const STATUS_COLOR = { 1: 'info', 2: 'success', 3: 'warning', 4: 'default', 5: 'error' };

const statList = computed(() => {
  if (!data.value) return [];
  const o = data.value.stats.byStatus || {};
  return [1, 2, 3, 4, 5]
    .map(s => ({ s, label: STATUS_TEXT[s], count: o[s] || 0 }))
    .filter(x => x.count > 0);
});

async function load() {
  loading.value = true;
  errorMsg.value = '';
  data.value = null;
  try {
    data.value = await api.get('/share/' + route.params.uid);
  } catch (e) {
    if (e.status === 404) errorMsg.value = '该用户未开启公开分享，或用户不存在';
    else errorMsg.value = e.message;
  }
  loading.value = false;
  document.title = data.value ? data.value.user.nickname + ' 的追番 · 秘封俱乐部' : '秘封俱乐部';
}
onMounted(load);
</script>

<template>
  <div class="container" style="max-width:960px">
    <n-spin :show="loading">
      <n-alert v-if="errorMsg" type="warning" style="margin-top:30px">
        {{ errorMsg }}
        <template #action><n-button size="small" round @click="router.push('/')">回首页</n-button></template>
      </n-alert>

      <template v-if="data">
        <div class="profile-card" v-reveal>
          <n-avatar v-if="data.user.avatar" :src="img(data.user.avatar)" :size="72" round />
          <n-avatar v-else :size="72" round style="background:linear-gradient(135deg,var(--accent),var(--accent-2));font-size:30px">{{ (data.user.nickname || 'U')[0] }}</n-avatar>
          <div class="p-info">
            <h2>{{ data.user.nickname }}</h2>
            <p v-if="data.user.bio" class="p-bio">{{ data.user.bio }}</p>
            <div class="p-stats">
              <span>收藏 <b>{{ data.stats.total }}</b></span>
              <span>评分 <b>{{ data.stats.rated }}</b></span>
              <span>均分 <b>{{ data.stats.avgScore }}</b></span>
              <span class="p-tag" v-for="st in statList" :key="st.s" :style="{ color: st.s === 2 ? '#6cc96c' : '' }">{{ st.label }} {{ st.count }}</span>
            </div>
          </div>
        </div>

        <div class="section-title" v-reveal>🎬 追番收藏</div>
        <div v-if="data.data.length" class="share-grid" v-reveal>
          <router-link v-for="c in data.data" :key="c.subject_id" :to="'/subject/' + c.subject_id" class="share-card">
            <div class="sc-cover">
              <img v-if="c.image" :src="img(c.image)" :alt="c.name_cn || c.name" loading="lazy" decoding="async" />
              <div v-else class="no-cover">{{ (c.name_cn || c.name || '?').slice(0, 2) }}</div>
              <span v-if="c.statusText" class="sc-status" :class="'s' + c.status">{{ c.statusText }}</span>
              <span v-if="c.score" class="sc-score">★ {{ scoreText(c.score) }}</span>
            </div>
            <div class="sc-name">{{ c.name_cn || c.name }}</div>
            <div v-if="parseTags(c.tags).length" class="sc-tags">
              <n-tag v-for="t in parseTags(c.tags).slice(0, 3)" :key="t" size="tiny" :bordered="false">{{ t }}</n-tag>
            </div>
          </router-link>
        </div>
        <n-empty v-else description="还没有收藏" style="padding:50px 0" />
      </template>
    </n-spin>
  </div>
</template>

<style scoped>
.profile-card {
  display: flex; gap: 18px; align-items: center; flex-wrap: wrap;
  background: var(--bg-card); border: 1px solid var(--accent); border-radius: 18px;
  padding: 24px 26px; margin-top: 20px;
  background-image: linear-gradient(120deg, rgba(242,185,78,.08), transparent 55%);
}
.p-info { flex: 1; min-width: 240px; }
.p-info h2 { margin: 0 0 6px; font-size: 24px; }
.p-bio { color: var(--text-dim); font-size: 13px; margin: 0 0 10px; line-height: 1.6; }
.p-stats { display: flex; gap: 14px; flex-wrap: wrap; font-size: 13px; color: var(--text-dim); }
.p-stats b { color: var(--accent); font-size: 15px; }
.p-tag { color: var(--text-dim); }
.section-title { font-size: 18px; font-weight: 800; margin: 26px 0 10px; color: var(--accent); }
.share-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); gap: 14px; }
.share-card { text-decoration: none; color: inherit; }
.sc-cover { position: relative; aspect-ratio: 3/4; border-radius: 10px; overflow: hidden; background: var(--cover-grad); }
.sc-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.no-cover { display: flex; align-items: center; justify-content: center; height: 100%; font-size: 24px; font-weight: 700; color: var(--accent); }
.sc-status { position: absolute; top: 6px; left: 6px; font-size: 10px; padding: 2px 8px; border-radius: 999px; background: rgba(0,0,0,.55); color: #fff; backdrop-filter: blur(4px); }
.sc-score { position: absolute; bottom: 6px; right: 6px; font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 999px; background: rgba(242,185,78,.92); color: #222; }
.sc-name { font-size: 13px; font-weight: 600; margin-top: 7px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sc-tags { margin-top: 4px; display: flex; gap: 3px; flex-wrap: wrap; }
@media (max-width: 560px) { .share-grid { grid-template-columns: repeat(3, 1fr); gap: 10px; } }
</style>
