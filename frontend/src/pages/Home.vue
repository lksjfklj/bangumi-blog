<script setup>
import { ref, computed, onMounted } from 'vue';
import { NSpin, NTabs, NTabPane, NButton, NEmpty, NTag } from 'naive-ui';
import { api, fmtDate, episodeLabel } from '../api';
import SubjectCard from '../components/SubjectCard.vue';
import { useUserStore } from '../stores/user';

const userStore = useUserStore();
const calendar = ref([]);
const loading = ref(true);
const jsDay = new Date().getDay(); // 0=周日
const activeDay = ref(jsDay === 0 ? 7 : jsDay);
const posts = ref([]);
const postsLoading = ref(true);
const myUpdates = ref([]);
const loadingMy = ref(false);
const progressMap = ref({});

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
const dayList = computed(() => calendar.value[activeDay.value - 1] || null);

// 收藏番放送进度：第 ep_status / 共 eps 话
function progressOf(s) {
  const p = progressMap.value[s.id];
  if (!p || !p.ep_status) return null;
  const total = +s.eps || 0;
  const cur = +p.ep_status || 0;
  return { cur, total, pct: total ? Math.min(100, Math.round(cur / total * 100)) : 0 };
}
// 开播倒计时：air_date 在未来 14 天内
function countdownOf(s) {
  if (!s.air_date) return '';
  const t = new Date(String(s.air_date));
  if (isNaN(t)) return '';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayDiff = Math.round((t - today) / 86400000);
  if (dayDiff < 0) return '';
  if (dayDiff === 0) return '今日播出';
  if (dayDiff === 1) return '明晚播出';
  if (dayDiff <= 14) return '还有 ' + dayDiff + ' 天开播';
  return '';
}

onMounted(() => {
  // 并行拉取放送表与最新文章，避免串行等待，首屏更快
  const p1 = api.get('/anime/calendar').then(d => { calendar.value = d; }).catch(() => { calendar.value = []; })
    .finally(() => { loading.value = false; });
  const p2 = api.get('/blog/posts?size=4').then(d => { posts.value = d.data || []; }).catch(() => { /* ignore */ })
    .finally(() => { postsLoading.value = false; });
  const p3 = userStore.isLoggedIn
    ? (async () => {
        // 只读访客也可看「我追的更了」（站长追番数据只读公开）；追番进度属个人数据仅登录用户可看
        try {
          const u = await api.get('/watch/my-updates?limit=5');
          myUpdates.value = (u && u.data) || [];
        } catch (e) { myUpdates.value = []; }
        if (!userStore.viewer) {
          try {
            const d = await api.get('/me/calendar-progress');
            progressMap.value = d || {};
          } catch (e) { progressMap.value = {}; }
        }
        loadingMy.value = false;
      })()
    : Promise.resolve();
  Promise.all([p1, p2, p3]);
});
</script>

<template>
  <div class="container">
    <section class="hero" v-reveal>
      <img class="hero-bg" src="/img/hero-scene.svg" alt="" aria-hidden="true" />
      <div class="hero-veil" aria-hidden="true"></div>
      <img class="hero-seal seal-spin" src="/img/seal.svg" alt="" aria-hidden="true" />
      <img class="hero-gohei" src="/img/gohei.svg" alt="" aria-hidden="true" />
      <img class="hero-lantern hl1" src="/img/lantern.svg" alt="" aria-hidden="true" />
      <img class="hero-lantern hl2" src="/img/lantern.svg" alt="" aria-hidden="true" />
      <img class="hero-ofuda hf1" src="/img/ofuda.svg" alt="" aria-hidden="true" />
      <img class="hero-ofuda hf2" src="/img/ofuda.svg" alt="" aria-hidden="true" />
      <img class="hero-bunny" src="/img/bunny.svg" alt="" aria-hidden="true" />
      <img class="hero-orb ho1" src="/img/yin-yang-orb.svg" alt="" aria-hidden="true" />
      <img class="hero-orb ho2" src="/img/yin-yang-orb.svg" alt="" aria-hidden="true" />
      <span class="hero-petal p1">🌙</span>
      <span class="hero-petal p2">✦</span>
      <span class="hero-petal p3">✧</span>
      <p class="hero-kana">—— 月夜の境界、その向こうへ ——</p>
      <h1 class="hero-title">秘<span>封</span>俱乐部</h1>
      <p class="hero-sub">在境界的另一侧，追番 · 搜索 · 资讯 · 与 Bangumi 联动</p>
      <div class="hero-actions">
        <n-button type="primary" size="large" round @click="$router.push('/anime')">⛩ 进入番剧库</n-button>
        <n-button size="large" round ghost @click="$router.push('/collection')">🌙 我的追番</n-button>
      </div>
      <div class="hero-chips">
        <span>✨ 新番放送</span><span>🌙 收藏同步</span><span>📖 个人博客</span>
      </div>
    </section>

    <div v-if="!loadingMy && myUpdates.length" class="my-update-box" v-reveal>
      <div class="mu-head">
        <span class="mu-title">📣 我追的更了</span>
        <span class="mu-sub">近 30 天你收藏的番有新资源</span>
        <span class="spacer"></span>
        <n-button text type="primary" size="small" @click="$router.push('/watch?my=1')">去新番更新 →</n-button>
      </div>
      <div class="mu-list">
        <router-link v-for="u in myUpdates" :key="u.series_key" :to="{ path: '/watch', query: { my: '1', q: u.series_title || u.name_cn || u.name } }" class="mu-item" :title="'查看 ' + (u.name_cn || u.name || u.series_title) + ' 的更新'">
          <span class="mu-name">{{ u.name_cn || u.name || u.series_title }}</span>
          <n-tag v-if="u.episode" size="small" :bordered="false" type="warning" round>{{ episodeLabel(u.episode) }}</n-tag>
          <n-tag v-if="u.sub_group" size="small" :bordered="false" round>{{ u.sub_group }}</n-tag>
          <span class="spacer"></span>
          <span class="mu-time">{{ fmtDate(u.published_at) }}</span>
        </router-link>
      </div>
    </div>

    <div class="tori-divider" v-reveal><span>⛩</span></div>
    <div class="section-title" v-reveal>本周放送</div>
    <n-spin :show="loading" v-reveal>
      <n-tabs v-model:value="activeDay" type="line" animated size="medium">
        <n-tab-pane v-for="(day, i) in calendar" :key="i" :name="i + 1" :tab="'周' + WEEK[i]">
          <div v-if="day.items && day.items.length" class="card-grid">
            <div v-for="s in day.items.slice(0, 24)" :key="s.id" class="cal-cell">
              <SubjectCard :subject="s" :calendar="true" />
              <div v-if="progressOf(s)" class="cal-progress" :title="'看到第 ' + progressOf(s).cur + ' 话 / 共 ' + (progressOf(s).total || '?') + ' 话'">
                <div class="cp-track"><div class="cp-fill" :style="{ width: progressOf(s).pct + '%' }"></div></div>
                <span class="cp-txt">第 {{ progressOf(s).cur }}/{{ progressOf(s).total || '?' }} 话</span>
              </div>
              <div v-else-if="countdownOf(s)" class="cal-countdown">⏳ {{ countdownOf(s) }}</div>
            </div>
          </div>
          <n-empty v-else description="暂无放送" />
        </n-tab-pane>
      </n-tabs>
    </n-spin>

    <div class="tori-divider" v-reveal><span>⛩</span></div>
    <div class="section-title" v-reveal>最新文章</div>
    <n-spin :show="postsLoading">
      <router-link v-for="(p, i) in posts" :key="p.id" :to="'/blog/' + p.slug" class="post-card" v-reveal :style="{ transitionDelay: (i % 4) * 70 + 'ms' }">
        <h3>{{ p.title }}</h3>
        <div class="summary">{{ p.summary }}</div>
        <div class="meta">
          <span>{{ fmtDate(p.created_at) }}</span>
          <n-tag v-for="t in p.tags" :key="t" size="small" :bordered="false" type="info">{{ t }}</n-tag>
        </div>
      </router-link>
      <n-empty v-if="!postsLoading && !posts.length" description="还没有文章" />
      <div v-if="posts.length" style="margin-top:8px">
        <n-button text type="primary" @click="$router.push('/blog')">查看全部文章 →</n-button>
      </div>
    </n-spin>
  </div>
</template>

<style scoped>
.hero {
  position: relative; text-align: center; padding: 96px 24px 84px; margin-top: 20px;
  border-radius: 26px; overflow: hidden;
  background: var(--hero-bg);
  border: 1px solid var(--hero-border);
  box-shadow: 0 12px 34px rgba(0, 0, 0, .45);
}
.hero-bg {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; z-index: 0; pointer-events: none;
}
.hero-veil {
  position: absolute; inset: 0; z-index: 1; pointer-events: none;
  background:
    radial-gradient(ellipse at 50% 30%, rgba(10, 14, 30, .28), transparent 55%),
    linear-gradient(180deg, rgba(8, 12, 26, .45), rgba(8, 12, 26, .18) 45%, rgba(8, 12, 26, .55));
}
.hero-seal {
  position: absolute; z-index: 1; width: 300px; height: 300px;
  right: 4%; top: 50%; margin-top: -150px;
  opacity: .34; pointer-events: none;
}
.hero-gohei {
  position: absolute; z-index: 1; width: 60px; left: 5%; bottom: 4%;
  opacity: .92; pointer-events: none; transform-origin: top center;
  animation: heroSway 5.5s ease-in-out infinite;
}
.hero-lantern { position: absolute; z-index: 1; pointer-events: none; filter: drop-shadow(0 0 12px rgba(255, 140, 80, .4)); }
.hl1 { width: 40px; top: 14px; left: 12px; transform-origin: top center; animation: heroSway 5s ease-in-out infinite; }
.hl2 { width: 34px; top: 44px; right: 14px; transform-origin: top center; animation: heroSway 6s ease-in-out infinite reverse; }
.hero-ofuda { position: absolute; z-index: 1; width: 26px; pointer-events: none; transform-origin: top center; animation: heroSway 4.6s ease-in-out infinite; }
.hf1 { top: 8px; right: 96px; }
.hf2 { top: 130px; left: 118px; animation-delay: 2s; }
.hero-bunny {
  position: absolute; z-index: 1; width: 52px; pointer-events: none;
  top: 20px; left: 24%; opacity: .6;
  animation: heroBunny 7s ease-in-out infinite;
}
@keyframes heroBunny {
  0%, 100% { transform: translateY(0) rotate(-4deg); }
  50% { transform: translateY(-16px) rotate(5deg); }
}
.hero-orb {
  position: absolute; z-index: 1; width: 34px; pointer-events: none; opacity: .85;
  animation: heroOrb 8s ease-in-out infinite;
  filter: drop-shadow(0 0 8px rgba(192, 57, 72, .4));
}
.ho1 { bottom: 18%; left: 9%; }
.ho2 { top: 16%; right: 22%; width: 26px; animation-delay: -3s; }
@keyframes heroOrb {
  0%, 100% { transform: translateY(0) rotate(-10deg); }
  50% { transform: translateY(-14px) rotate(16deg); }
}
@keyframes heroSway {
  0%, 100% { transform: rotate(-5deg); }
  50% { transform: rotate(6deg); }
}
.hero-kana {
  position: relative; z-index: 2; margin: 0 0 10px;
  color: rgba(246, 231, 174, .85); font-size: 14px; letter-spacing: 5px;
  text-shadow: 0 2px 10px rgba(0, 0, 0, .6);
}
.hero-title {
  position: relative; z-index: 2; font-size: 52px; margin: 0 0 12px; letter-spacing: 8px; color: var(--text);
  text-shadow: 0 3px 16px rgba(0, 0, 0, .55);
}
.hero-title span {
  background: linear-gradient(120deg, var(--accent), var(--accent-2));
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
.hero-sub { position: relative; z-index: 2; color: var(--text-dim); font-size: 15px; margin: 0 0 26px; letter-spacing: 2px; }
.hero-actions { position: relative; z-index: 2; display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
.hero-chips { position: relative; z-index: 2; margin-top: 26px; display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.hero-chips span {
  font-size: 12px; color: var(--accent); background: var(--hero-chip-bg);
  border: 1px solid var(--hero-border); padding: 4px 13px; border-radius: 999px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, .3);
}
.hero-petal { position: absolute; z-index: 2; animation: heroPetal 5s ease-in-out infinite; opacity: .65; font-size: 22px; }
.p1 { left: 8%; top: 16%; }
.p2 { right: 9%; top: 30%; animation-delay: 1.4s; font-size: 18px; color: var(--accent); }
.p3 { left: 15%; bottom: 14%; animation-delay: 2.6s; font-size: 16px; color: var(--accent-2); }
@keyframes heroPetal {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  50% { transform: translateY(-12px) rotate(20deg); }
}
.my-update-box { margin: 16px 0 2px; background: var(--bg-card); border: 1px solid var(--accent); border-radius: 16px; padding: 14px 16px 10px; box-shadow: 0 6px 18px rgba(0,0,0,.3); }
.my-update-box .spacer { flex: 1; }
.mu-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.mu-title { font-size: 15px; font-weight: 700; color: var(--accent); }
.mu-sub { font-size: 12px; color: var(--text-dim); }
.mu-list { display: flex; flex-direction: column; }
.mu-item { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 7px 4px; border-bottom: 1px dashed var(--border); text-decoration: none; color: inherit; }
.mu-item:last-child { border-bottom: none; }
.mu-item:hover .mu-name { color: var(--accent); }
.mu-name { font-size: 13px; font-weight: 600; color: var(--text); }
.mu-time { font-size: 12px; color: var(--text-dim); white-space: nowrap; }
.post-card {
  display: block; margin: 10px 0; padding: 16px 20px;
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 14px;
  transition: border-color .18s, transform .18s, box-shadow .18s;
}
.post-card:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 8px 20px rgba(0, 0, 0, .3); }
.post-card h3 { margin: 0 0 6px; font-size: 17px; color: var(--text); }
.post-card .summary { color: var(--text-dim); font-size: 13px; margin-bottom: 8px; }
.post-card .meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--text-dim); }
.cal-cell { position: relative; }
.cal-progress {
  position: absolute; left: 8px; right: 8px; bottom: 46px; display: flex; align-items: center; gap: 6px;
  background: rgba(0,0,0,.62); backdrop-filter: blur(4px); border-radius: 999px; padding: 3px 8px;
}
.cp-track { flex: 1; height: 5px; background: rgba(255,255,255,.22); border-radius: 999px; overflow: hidden; }
.cp-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent-2)); border-radius: 999px; }
.cp-txt { font-size: 10px; color: #fff; white-space: nowrap; font-weight: 600; }
.cal-countdown {
  position: absolute; top: 6px; left: 6px; font-size: 10px; font-weight: 700;
  background: rgba(229,72,77,.92); color: #fff; padding: 3px 8px; border-radius: 999px;
  box-shadow: 0 2px 8px rgba(0,0,0,.35);
}
@media (max-width: 720px) {
  .hero { padding: 64px 18px 58px; }
  .hero-title { font-size: 36px; letter-spacing: 5px; }
  .hero-kana { letter-spacing: 2px; font-size: 12px; }
  .hero-seal { width: 200px; height: 200px; right: -8%; top: 46%; margin-top: -100px; }
  .hero-gohei { display: none; }
  .hero-lantern, .hero-ofuda, .hero-bunny, .hero-orb { display: none; }
}
</style>

