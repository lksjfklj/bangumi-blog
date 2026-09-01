<script setup>
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { img, scoreText, SUBJECT_TYPES } from '../api';

const props = defineProps({
  subject: { type: Object, required: true },
  tags: { type: Array, default: () => [] },
  subjectTags: { type: Array, default: () => [] },
  calendar: { type: Boolean, default: false }
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
      <img v-if="cover && !coverFailed" :src="cover" :alt="name" loading="lazy" @error="coverFailed = true" />
      <div v-else class="no-cover">{{ name.slice(0, 2) }}</div>
      <span v-if="typeLabel" class="badge">{{ typeLabel }}</span>
      <span v-if="subject.rating && subject.rating.total" class="score">{{ scoreText(subject.rating.score) }}</span>
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
</style>
