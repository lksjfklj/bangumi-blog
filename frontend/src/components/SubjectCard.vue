<script setup>
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { img, scoreText, SUBJECT_TYPES } from '../api';

const props = defineProps({
  subject: { type: Object, required: true },
  tags: { type: Array, default: () => [] },
  subjectTags: { type: Array, default: () => [] },
  calendar: { type: Boolean, default: false },
  // 放送进度：pct 0-100（null 时不显示进度线），text 形如「第 80/100 话」
  progressPct: { type: Number, default: null },
  progressText: { type: String, default: '' }
});
const allTags = computed(() => {
  const seen = new Set();
  const out = [];
  for (const t of [...props.tags, ...props.subjectTags]) {
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.slice(0, 5);
});
const coverFailed = ref(false);
// 首页放送表（首屏上方）优先加载，其余列表默认 auto
const fetchP = computed(() => (props.calendar ? 'high' : 'auto'));
const router = useRouter();
const cover = computed(() => {
  const imgs = props.subject.images;
  const u = (imgs && (imgs.common || imgs.medium || imgs.large)) || props.subject.image || '';
  return u ? img(u) : '';
});
const name = computed(() => props.subject.name_cn || props.subject.name || '未命名');
function weekDateText(weekday) {
  const n = Number(weekday);
  if (!n || n < 1 || n > 7) return '';
  const now = new Date();
  const jsDay = now.getDay(); // 0=周日
  const mondayOffset = jsDay === 0 ? -6 : 1 - jsDay;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
  const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + n - 1);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}
const sub = computed(() => {
  const parts = [];
  if (props.calendar && props.subject.air_weekday) {
    const dateText = weekDateText(props.subject.air_weekday);
    if (dateText) parts.push(dateText);
  } else if (props.subject.air_date) parts.push(props.subject.air_date);
  if (props.subject.rating && props.subject.rating.total) parts.push(scoreText(props.subject.rating.score) + ' 分');
  return parts.join(' · ');
});
const typeLabel = computed(() => {
  const t = props.subject.type;
  if (t && SUBJECT_TYPES[t]) return SUBJECT_TYPES[t];
  return '';
});
function goTag(t, e) {
  e.preventDefault();
  e.stopPropagation();
  router.push({ path: '/collection', query: { tag: t } });
}
</script>

<template>
  <router-link :to="'/subject/' + subject.id" class="subject-card" :title="name">
    <div class="cover">
      <img v-if="cover && !coverFailed" :src="cover" :alt="name" loading="lazy" decoding="async" :fetchpriority="fetchP" @error="coverFailed = true" />
      <div v-else class="no-cover">{{ name.slice(0, 2) }}</div>
      <span v-if="typeLabel" class="badge">{{ typeLabel }}</span>
      <span v-if="subject.rating && subject.rating.total" class="score">{{ scoreText(subject.rating.score) }}</span>
      <span v-if="progressText" class="watch-progress" :title="progressText">{{ progressText }}</span>
      <div v-if="progressPct !== null" class="cover-progress"><i :style="{ width: progressPct + '%' }"></i></div>
    </div>
    <div class="info">
      <div class="title" :title="subject.name">{{ name }}</div>
      <div class="sub">{{ sub }}</div>
      <div v-if="allTags.length" class="card-tags">
        <span v-for="t in allTags" :key="t" class="tag" :title="'筛选标签：' + t" @click="goTag(t, $event)">{{ t }}</span>
      </div>
    </div>
  </router-link>
</template>

<style scoped>
a.subject-card { text-decoration: none; color: inherit; }
.no-cover { display: flex; align-items: center; justify-content: center; height: 100%; background: var(--cover-grad); color: var(--accent); font-size: 26px; font-weight: 700; }
.card-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.card-tags .tag { font-size: 10px; line-height: 1; padding: 3px 7px; border-radius: 999px; background: var(--src-tag-bg); color: var(--src-tag-text); border: 1px solid var(--src-tag-border); }
.card-tags .tag:hover { background: var(--accent); border-color: var(--accent); color: var(--grad-text); transform: translateY(-1px); }
/* 封面内放送进度：左下角话数徽章（评分在右下角，左右对称、不遮挡标题） */
.cover .watch-progress {
  position: absolute; left: 8px; bottom: 8px; max-width: calc(100% - 64px);
  font-size: 11px; font-weight: 700; line-height: 1; padding: 4px 8px; border-radius: 999px;
  color: #fff; background: rgba(0, 0, 0, .62); border: 1px solid rgba(255, 255, 255, .18);
  backdrop-filter: blur(4px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 封面底边细进度线：整宽贴合，不会被裁切 */
.cover .cover-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(0, 0, 0, .42); }
.cover .cover-progress > i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent-2)); transition: width .3s ease; }
</style>
