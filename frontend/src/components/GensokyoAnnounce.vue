<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';

// 已读标记按公告 id 记录：只有站长发布「新公告」才会重新弹出
const KEY = 'hf-gensokyo-announce-seen-v2';
const shown = ref(false);
const announce = ref(null);
const route = useRoute();
// 登录页绝不弹公告：朋友首次访问登录/访客入口不能被弹窗挡住
const isLoginPage = computed(() => route.path.startsWith('/login'));

onMounted(async () => {
  try {
    const data = await api.get('/announce');
    if (!data || !data.id) return;
    announce.value = data;
    if (localStorage.getItem(KEY) === String(data.id)) return;
    setTimeout(() => { shown.value = true; }, 900);
  } catch (e) { /* 公告服务暂不可用时静默，不影响浏览 */ }
});

// 知晓了：记住已读，下次不再弹
function close() {
  if (announce.value) {
    try { localStorage.setItem(KEY, String(announce.value.id)); } catch (e) { /* ignore */ }
  }
  shown.value = false;
}
// 稍后再说：本次关掉，下次访问仍会提示（不写已读）
function later() {
  shown.value = false;
}

const paragraphs = (s) => String(s || '').split(/\r?\n+/).filter(Boolean);
</script>

<template>
  <transition name="announce">
    <div v-if="shown && announce && !isLoginPage" class="announce-mask">
      <div class="announce-card">
        <div class="announce-head">
          <span class="announce-badge">文文。新闻</span>
          <span class="announce-vol">号外 · 特刊</span>
        </div>
        <h3>{{ announce.title }}</h3>
        <div class="announce-date">{{ new Date(announce.created_at).toLocaleDateString('zh-CN') }}</div>
        <div class="announce-body">
          <p v-for="(p, i) in paragraphs(announce.content)" :key="i" :class="{ sign: p.trim().startsWith('——') }">{{ p }}</p>
        </div>
        <div class="announce-actions">
          <router-link to="/announcements" class="announce-more" @click="close">📰 查看全部公告</router-link>
          <button class="announce-later" @click="later">稍后再说</button>
          <button class="announce-close" @click="close">✕ 知晓了</button>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
/* 遮罩不拦截页面点击：只有弹窗卡片本身可点，背景照常使用 */
.announce-mask { pointer-events: none; }
.announce-card { pointer-events: auto; }
.announce-date { font-size: 12px; color: var(--ann-vol); letter-spacing: 1px; margin-bottom: 6px; }
.announce-actions { display: flex; align-items: center; gap: 10px; margin-top: 18px; }
.announce-close, .announce-later { margin-top: 0; width: auto; flex: 1; padding: 10px; font-family: inherit; font-size: 13px; font-weight: 700; border-radius: 999px; cursor: pointer; border: 1px solid var(--ann-border); transition: all .18s; }
.announce-close { background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: var(--grad-text); border: none; }
.announce-later { background: transparent; color: var(--text-dim); }
.announce-later:hover { color: var(--accent); border-color: var(--accent); }
.announce-more {
  font-size: 13px; color: var(--ann-link); text-decoration: none; white-space: nowrap;
  border-bottom: 1px dashed var(--ann-link-border); padding-bottom: 2px;
  transition: color .15s;
}
.announce-more:hover { color: var(--ann-link-hover); }
.announce-body .sign { text-align: right; color: var(--ann-sign); font-size: 12px; margin-top: 12px; letter-spacing: 1px; }
</style>
