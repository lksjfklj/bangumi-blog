import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import './assets/theme.css';
import { initTheme } from './stores/theme';

const app = createApp(App);

// 滚动进入视口时淡入上浮（东方风滚动装饰）
app.directive('reveal', {
  mounted(el) {
    if (typeof IntersectionObserver === 'undefined') { el.classList.add('in'); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { el.classList.add('in'); io.unobserve(el); }
      });
    }, { threshold: 0.06, rootMargin: '0px 0px -24px 0px' });
    io.observe(el);
    el._revealIO = io;
  },
  unmounted(el) { if (el._revealIO) el._revealIO.disconnect(); }
});

app.use(createPinia());
app.use(router);
// naive-ui 组件已按需在各自 .vue 文件中 import，此处不再全局注册，主包体积大幅下降
initTheme();
app.mount('#app');

// PWA：注册 Service Worker（仅生产环境，支持加到主屏 + 简单离线兜底）
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}