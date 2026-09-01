import { createApp } from 'vue';
import { createPinia } from 'pinia';
import naive from 'naive-ui';
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
app.use(naive);
initTheme();
app.mount('#app');