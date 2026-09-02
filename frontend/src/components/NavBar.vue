<script setup>
import { computed, ref, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NButton, NAvatar, NDropdown, NSpace, NTag } from 'naive-ui';
import { useUserStore } from '../stores/user';
import { api } from '../api';
import { theme as themeStore, toggleTheme } from '../stores/theme';

const userStore = useUserStore();
const route = useRoute();
const router = useRouter();
const nav = [
  { to: '/', label: '首页' },
  { to: '/anime', label: '番剧库' },
  { to: '/watch', label: '新番更新' },
  { to: '/collection', label: '我的追番' },
  { to: '/blog', label: '博客' },
  { to: '/announcements', label: '公告' },
  { to: '/about', label: '关于' }
];
// 跟随当前路由实时高亮：子页面（详情/分页/搜索）保持所在栏目高亮
const activeKey = computed(() => {
  const p = route.path;
  if (p === '/') return '/';
  if (p.startsWith('/anime') || p.startsWith('/subject/')) return '/anime';
  if (p.startsWith('/watch')) return '/watch';
  if (p.startsWith('/collection')) return '/collection';
  if (p.startsWith('/blog')) return '/blog';
  if (p.startsWith('/announcements')) return '/announcements';
  if (p.startsWith('/about')) return '/about';
  return '';
});

const userOptions = computed(() => {
  const opts = [
    { label: '我的追番', key: '/collection' },
    { label: '📊 追番统计', key: '/stats' },
    { label: '🔔 通知设置', key: '/notify' }
  ];
  if (userStore.isOwner) opts.push({ label: '站务管理', key: '/admin' });
  opts.push({ label: '切换账号 / 访客', key: '/login' });
  opts.push({ label: '退出登录', key: 'logout' });
  return opts;
});
function onSelect(k) {
  if (k === 'logout') return userStore.logout();
  if (k === '/login') return router.push({ path: '/login', query: { switch: '1' } });
  // 站内页面走 SPA 跳转，避免整页刷新
  router.push(k).catch(() => location.assign(k));
}

// ---------- 新话更新未读角标 ----------
const unread = ref(0);
let unreadTimer = null;
async function fetchUnread() {
  if (!userStore.user || userStore.viewer) { unread.value = 0; return; }
  try {
    const d = await api.get('/watch/updates/unread?limit=1');
    unread.value = d.unread || 0;
  } catch (e) { unread.value = 0; }
}
watch(() => userStore.user, (u) => {
  if (u) {
    fetchUnread();
    clearInterval(unreadTimer);
    unreadTimer = setInterval(fetchUnread, 60000);
  } else {
    unread.value = 0;
    clearInterval(unreadTimer);
  }
}, { immediate: true });
onMounted(() => { if (userStore.user) fetchUnread(); });
onUnmounted(() => clearInterval(unreadTimer));
</script>

<template>
  <header class="navbar">
    <div class="container nav-inner">
      <router-link to="/" class="logo"><span class="logo-icon">🌙</span>秘<span>封</span>俱乐部</router-link>
      <nav class="links">
        <router-link v-for="n in nav" :key="n.to" :to="n.to" :class="{ on: activeKey === n.to }">{{ n.label }}</router-link>
      </nav>
      <div class="spacer"></div>
      <button v-if="userStore.user" class="bell-btn" title="新话更新通知" @click="router.push('/notify')">
        🔔<span v-if="unread" class="bell-badge">{{ unread > 99 ? '99+' : unread }}</span>
      </button>
      <button class="theme-toggle" :title="themeStore === 'gensokyo' ? '切换到红魔馆·浅色复古' : '切换到秘封之夜·深色东方'" @click="toggleTheme">
        <span class="tt-ico">{{ themeStore === 'gensokyo' ? '🌹' : '🌙' }}</span>
        <span class="tt-txt">{{ themeStore === 'gensokyo' ? '红魔馆' : '秘封之夜' }}</span>
      </button>
      <img class="nav-lantern" src="/img/lantern.svg" alt="" aria-hidden="true" />
      <n-dropdown v-if="userStore.user" :options="userOptions" trigger="hover" @select="onSelect">
        <n-space align="center" style="cursor:pointer">
          <n-avatar v-if="userStore.user.avatar" :src="userStore.user.avatar" round :size="30" />
          <n-avatar v-else round :size="30" style="background:linear-gradient(135deg,var(--accent),var(--accent-2))">{{ (userStore.user.nickname || 'U')[0] }}</n-avatar>
          <span class="nick">{{ userStore.user.nickname || userStore.user.username }}</span>
          <n-tag v-if="userStore.viewer" size="small" round type="warning" :bordered="false">只读访客</n-tag>
          <n-tag v-else-if="userStore.isOwner" size="small" round type="primary" :bordered="false">站长</n-tag>
        </n-space>
      </n-dropdown>
      <n-button v-else type="primary" round size="small" @click="router.push('/login')">登录 / 访客</n-button>
    </div>
  </header>
</template>

<style scoped>
.navbar {
  position: sticky; top: 0; z-index: 100;
  background: var(--nav-bg);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--nav-border);
}
.navbar::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; z-index: 1;
  background: linear-gradient(90deg, transparent, rgba(242, 185, 78, .9), rgba(180, 138, 255, .9), transparent);
}
.nav-inner { display: flex; align-items: center; gap: 18px; height: 60px; }
.logo { font-size: 23px; font-weight: 800; letter-spacing: 2px; color: var(--text); display: flex; align-items: center; gap: 4px; }
.logo-icon { font-size: 20px; animation: logoWiggle 3.2s ease-in-out infinite; display: inline-block; }
@keyframes logoWiggle {
  0%, 100% { transform: rotate(0deg); }
  5% { transform: rotate(-12deg) scale(1.15); }
  10% { transform: rotate(10deg); }
  15% { transform: rotate(-6deg); }
  20% { transform: rotate(0deg); }
}
.logo span:last-child {
  background: linear-gradient(120deg, var(--accent), var(--accent-2));
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
.links { display: flex; gap: 6px; }
.links a {
  padding: 7px 14px; border-radius: 999px; font-size: 14px; font-weight: 600;
  color: var(--text-dim); transition: all .18s;
}
.links a:hover { color: var(--accent); background: var(--hover-bg); }
.links a.on { color: var(--accent); background: var(--nav-on-bg); box-shadow: inset 0 0 0 1px var(--nav-on-ring); }
.nav-lantern {
  width: 26px; opacity: .85; pointer-events: none;
  transform-origin: top center;
  animation: navSway 4.5s ease-in-out infinite;
  filter: drop-shadow(0 0 8px rgba(255, 140, 80, .4));
}
@keyframes navSway {
  0%, 100% { transform: rotate(-4deg); }
  50% { transform: rotate(5deg); }
}
.nick { font-size: 13px; color: var(--text-dim); font-weight: 600; }
.theme-toggle {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--nav-border); border-radius: 999px;
  background: var(--bg-soft); color: var(--text-dim);
  padding: 6px 14px; font-size: 13px; font-weight: 700; font-family: inherit;
  cursor: pointer; transition: all .18s; white-space: nowrap;
}
.theme-toggle:hover { color: var(--accent); border-color: var(--accent); transform: translateY(-1px); }
.theme-toggle .tt-ico { font-size: 15px; }
@media (max-width: 900px) { .theme-toggle .tt-txt { display: none; } }
@media (max-width: 720px) { .theme-toggle { padding: 5px 10px; } }
.bell-btn {
  position: relative; display: inline-flex; align-items: center; justify-content: center;
  width: 38px; height: 38px; border-radius: 50%;
  border: 1px solid var(--nav-border); background: var(--bg-soft); cursor: pointer;
  font-size: 17px; transition: all .18s; color: var(--text-dim);
}
.bell-btn:hover { color: var(--accent); border-color: var(--accent); transform: translateY(-1px); }
.bell-badge {
  position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; padding: 0 4px;
  border-radius: 999px; background: #e5484d; color: #fff; font-size: 11px; font-weight: 800;
  display: inline-flex; align-items: center; justify-content: center; line-height: 1;
  box-shadow: 0 2px 6px rgba(0,0,0,.35);
}
@media (max-width: 720px) {
  .nav-inner { gap: 8px; height: auto; min-height: 56px; flex-wrap: wrap; padding: 8px 0; row-gap: 4px; }
  .logo { font-size: 19px; letter-spacing: 1px; }
  .links { flex-wrap: wrap; }
  .links a { padding: 6px 9px; font-size: 13px; }
  .nick { display: none; }
  .nav-lantern { display: none; }
}
</style>







