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
  progressText: { type: String, default: '' },
  // 关联搜索的命中说明：后端在「书名没命中、靠标签命中」时给出命中的标签
  //（见 backend/src/library.js 的 queryLibrary），这里把它们高亮并排到最前面
  matchedTags: { type: Array, default: () => [] },
  // 关联搜索的命中说明：后端在「书名没命中、靠别名命中」时给出命中的别名原文
  //（见 backend/src/library.js 的 queryLibrary / aliasesOfRows），卡片上印「又名 XXX」
  matchedAliases: { type: Array, default: () => [] },
  // 点标签跳去哪：默认收藏页；番剧库传空串，改由父级监听 tag-click 就地按标签筛选
  tagTarget: { type: String, default: '/collection' }
});
const emit = defineEmits(['tag-click']);
// 命中标签排最前：它可能落在原标签列表 5 个之外，不提前就会被 slice 截掉，
//「这条为什么会出现」的解释也就跟着没了
const shownTags = computed(() => {
  const hit = props.matchedTags;
  const seen = new Set();
  const out = [];
  for (const t of [...hit, ...props.tags, ...props.subjectTags]) {
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push({ text: t, hit: hit.includes(t) });
  }
  return out.slice(0, 5);
});
// 「又名」只在书名没命中、靠别名找回来时才有值（后端只在这时给 matched_aliases），
// 否则每张卡片都挂一行原名，正常浏览时反而变成噪音
const aliasLine = computed(() => {
  const a = props.matchedAliases;
  if (!a || !a.length) return '';
  // 别名和卡片标题一样时（VNDB 的 title 与库里的原名/译名撞了）不要印，否则是「Muv-Luv / 又名 Muv-Luv」
  const shown = [String(props.subject.name_cn || '').trim().toLowerCase(), String(props.subject.name || '').trim().toLowerCase()];
  const keep = a.filter((x) => {
    const v = String(x || '').trim().toLowerCase();
    return v && !shown.includes(v);
  });
  return keep.length ? '又名 ' + keep.join(' / ') : '';
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
// 卡片上印的日期要跟「近期注目」判定是否近期的日期同源，否则列表没法看懂：
// 书籍/游戏用 latest_date（最新一卷 / 最新发售日）判定算不算近期，卡片却只印 air_date（系列首卷首发日），
// 就会出现「标着 2009 年、却排在近期头条」这种看不出道理的列表（排序其实是对的，只是没显示出来）。
// latest_date 没探明（老数据、日历没扫到）或与首卷日相同（单卷完结 / galgame 单作）时，照旧显示 air_date。
const latestDate = computed(() => String(props.subject.latest_date || ''));
const latestLabel = computed(() => (Number(props.subject.type) === 4 ? '最新发售 ' : '最新一卷 '));
const sub = computed(() => {
  const parts = [];
  if (props.calendar && props.subject.air_weekday) {
    const dateText = weekDateText(props.subject.air_weekday);
    if (dateText) parts.push(dateText);
  } else if (latestDate.value && latestDate.value !== props.subject.air_date) {
    parts.push(latestLabel.value + latestDate.value);
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
  emit('tag-click', t);
  if (props.tagTarget) router.push({ path: props.tagTarget, query: { tag: t } });
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
      <div v-if="aliasLine" class="alias-line" :title="aliasLine">{{ aliasLine }}</div>
      <div class="sub">{{ sub }}</div>
      <div v-if="shownTags.length" class="card-tags">
        <span
          v-for="t in shownTags" :key="t.text" class="tag" :class="{ hit: t.hit }"
          :title="t.hit ? '关键词命中的标签 · 点它看同类作品：' + t.text : '筛选标签：' + t.text"
          @click="goTag(t.text, $event)"
        >{{ t.text }}</span>
      </div>
    </div>
  </router-link>
</template>

<style scoped>
a.subject-card { text-decoration: none; color: inherit; }
.no-cover { display: flex; align-items: center; justify-content: center; height: 100%; background: var(--cover-grad); color: var(--accent); font-size: 26px; font-weight: 700; }
/* 关联搜索：「这条是靠哪个别名（原名/译名/罗马字）找回来的」 */
.alias-line { font-size: 11px; line-height: 1.4; color: var(--tag-gold-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.card-tags .tag { font-size: 10px; line-height: 1; padding: 3px 7px; border-radius: 999px; background: var(--src-tag-bg); color: var(--src-tag-text); border: 1px solid var(--src-tag-border); }
.card-tags .tag:hover { background: var(--accent); border-color: var(--accent); color: var(--grad-text); transform: translateY(-1px); }
/* 关键词命中的标签：金色描边标出来，让人一眼看出这条结果是靠哪个标签关联出来的 */
.card-tags .tag.hit { font-weight: 700; background: var(--tag-gold-bg); color: var(--tag-gold-text); border-color: var(--tag-gold-border); }
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
