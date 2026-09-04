import { createRouter, createWebHistory } from 'vue-router';
import { useUserStore } from './stores/user';

const routes = [
  { path: '/', name: 'home', component: () => import('./pages/Home.vue'), meta: { title: '首页' } },
  { path: '/login', name: 'login', component: () => import('./pages/Login.vue'), meta: { title: '登录' } },
  { path: '/anime', name: 'anime', component: () => import('./pages/Library.vue'), meta: { title: '番剧库' } },
  { path: '/watch', name: 'watch', component: () => import('./pages/Watch.vue'), meta: { title: '新番更新' } },
  { path: '/subject/:id', name: 'subject', component: () => import('./pages/SubjectDetail.vue') },
  { path: '/collection', name: 'collection', component: () => import('./pages/Collections.vue'), meta: { title: '我的追番', auth: true } },
  { path: '/stats', name: 'stats', component: () => import('./pages/Stats.vue'), meta: { title: '追番统计', auth: true, noViewer: true } },
  { path: '/notify', name: 'notify', component: () => import('./pages/Notifications.vue'), meta: { title: '通知设置', auth: true, noViewer: true } },
  { path: '/share/:uid', name: 'share', component: () => import('./pages/Share.vue') },
  { path: '/announcements', name: 'announcements', component: () => import('./pages/Announcements.vue'), meta: { title: '公告' } },
  { path: '/blog', name: 'blog', component: () => import('./pages/Blog.vue'), meta: { title: '博客' } },
  { path: '/blog/:slug', name: 'post', component: () => import('./pages/PostView.vue') },
  { path: '/about', name: 'about', component: () => import('./pages/About.vue'), meta: { title: '关于' } },
  { path: '/admin', name: 'admin', component: () => import('./pages/Admin.vue'), meta: { title: '站务管理', auth: true, owner: true } },
  { path: '/:pathMatch(.*)*', redirect: '/' }
];

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior() { return { top: 0 }; }
});

router.beforeEach(async (to) => {
  const userStore = useUserStore();
  if (!userStore.loaded) await userStore.fetchMe();
  // 已登录/访客模式访问登录页：直接回首页（但带 switch=1 的「切换账号」请求除外）
  if (to.name === 'login' && userStore.isLoggedIn && to.query.switch !== '1') return '/';
  // 需要登录的页面（我的追番 / 博客管理）
  if (to.meta.auth && !userStore.isLoggedIn) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }
  // 只读访客：统计页 / 通知设置页会请求受保护接口（403），直接引导回首页
  if (to.meta.noViewer && userStore.viewer) return '/';
  // 仅站长可进（博客管理）
  if (to.meta.owner && !userStore.isOwner) {
    return userStore.isLoggedIn ? '/' : { path: '/login', query: { redirect: to.fullPath } };
  }
  return true;
});

router.afterEach((to) => {
  document.title = to.meta.title ? to.meta.title + ' · 秘封俱乐部' : '秘封俱乐部';
});

export default router;
