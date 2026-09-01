<script setup>
import { ref, computed, onMounted } from 'vue';

import { NConfigProvider, NMessageProvider, NDialogProvider, darkTheme, lightTheme, zhCN, dateZhCN } from 'naive-ui';
import { useUserStore } from './stores/user';
import NavBar from './components/NavBar.vue';
import FooterBar from './components/FooterBar.vue';
import GensokyoAnnounce from './components/GensokyoAnnounce.vue';
import { theme as themeStore } from './stores/theme';

const userStore = useUserStore();
const loading = ref(true);
onMounted(async () => {
  await userStore.fetchMe();
  loading.value = false;
});

const gensokyoOverrides = {
  common: {
    primaryColor: '#f2b94e',
    primaryColorHover: '#ffcf6e',
    primaryColorPressed: '#d19a33',
    primaryColorSuppl: '#f2b94e',
    infoColor: '#7db5e8',
    successColor: '#54c89a',
    warningColor: '#f5a25d',
    errorColor: '#f0616d',
    bodyColor: '#101624',
    cardColor: '#1d2942',
    modalColor: '#1b2740',
    popoverColor: '#1b2740',
    borderColor: '#33415f',
    borderRadius: '12px',
    textColorBase: '#eae7f6',
    textColor1: '#f0edfa',
    textColor2: '#d5d2e8',
    textColor3: '#93a0c0',
    fontFamily: '"Varela Round", "Yuanti SC", "幼圆", "YouYuan", "PingFang SC", "Microsoft YaHei", sans-serif'
  },
  // 标签统一深色东方风（默认 light 主题下 NTag 是浅底浅字，看不清）
  Tag: {
    borderRadius: '8px',
    border: '1px solid rgba(180, 138, 255, .30)',
    color: 'rgba(180, 138, 255, .10)',
    textColor: '#cbb8ff',
    colorCheckable: 'transparent',
    colorHoverCheckable: 'rgba(180, 138, 255, .16)',
    colorPressedCheckable: 'rgba(180, 138, 255, .10)',
    textColorCheckable: '#cbb8ff',
    textColorHoverCheckable: '#e6dcff',
    textColorPressedCheckable: '#e6dcff',
    colorChecked: '#f2b94e',
    colorCheckedHover: '#ffcf6e',
    colorCheckedPressed: '#d19a33',
    textColorChecked: '#171c2e',
    closeIconColor: '#93a0c0',
    closeIconColorHover: '#cbb8ff',
    closeIconColorPressed: '#e6dcff',
    closeColorHover: 'rgba(180, 138, 255, .16)',
    closeColorPressed: 'rgba(180, 138, 255, .10)',
    borderPrimary: '1px solid rgba(242, 185, 78, .35)',
    colorPrimary: 'rgba(242, 185, 78, .16)',
    textColorPrimary: '#ffd98a',
    colorInfo: 'rgba(125, 181, 232, .16)',
    textColorInfo: '#9cc8ef',
    borderInfo: '1px solid rgba(125, 181, 232, .35)',
    colorWarning: 'rgba(245, 162, 93, .16)',
    textColorWarning: '#ffc08a',
    borderWarning: '1px solid rgba(245, 162, 93, .35)',
    colorSuccess: 'rgba(84, 200, 154, .16)',
    textColorSuccess: '#7fd8b2',
    borderSuccess: '1px solid rgba(84, 200, 154, .35)',
    colorError: 'rgba(240, 97, 109, .16)',
    textColorError: '#ff8b95',
    borderError: '1px solid rgba(240, 97, 109, .35)'
  }
};

// ========== 红魔馆 · 浅色/复古主题覆盖 ==========
const scarletOverrides = {
  common: {
    primaryColor: '#b3273d',
    primaryColorHover: '#d13a52',
    primaryColorPressed: '#8f1e30',
    primaryColorSuppl: '#b3273d',
    infoColor: '#3d74c4',
    successColor: '#2c9c62',
    warningColor: '#c9882f',
    errorColor: '#c13a4e',
    bodyColor: '#f8efe1',
    cardColor: '#fffaf2',
    modalColor: '#fffaf2',
    popoverColor: '#fffdf8',
    borderColor: '#e0c9a8',
    borderRadius: '12px',
    textColorBase: '#47292e',
    textColor1: '#3f2328',
    textColor2: '#5c4143',
    textColor3: '#8f6a5f',
    fontFamily: '"Varela Round", "Yuanti SC", "幼圆", "YouYuan", "PingFang SC", "Microsoft YaHei", sans-serif'
  },
  Tag: {
    borderRadius: '8px',
    border: '1px solid rgba(179, 39, 61, .28)',
    color: 'rgba(179, 39, 61, .08)',
    textColor: '#8f1e30',
    colorCheckable: 'transparent',
    colorHoverCheckable: 'rgba(179, 39, 61, .14)',
    colorPressedCheckable: 'rgba(179, 39, 61, .08)',
    textColorCheckable: '#8f1e30',
    textColorHoverCheckable: '#b3273d',
    textColorPressedCheckable: '#b3273d',
    colorChecked: '#b3273d',
    colorCheckedHover: '#d13a52',
    colorCheckedPressed: '#8f1e30',
    textColorChecked: '#fff8ee',
    closeIconColor: '#a07a6a',
    closeIconColorHover: '#b3273d',
    closeIconColorPressed: '#8f1e30',
    closeColorHover: 'rgba(179, 39, 61, .12)',
    closeColorPressed: 'rgba(179, 39, 61, .08)',
    borderPrimary: '1px solid rgba(179, 39, 61, .30)',
    colorPrimary: 'rgba(179, 39, 61, .10)',
    textColorPrimary: '#9c2132',
    colorInfo: 'rgba(61, 116, 196, .10)',
    textColorInfo: '#2e5c9e',
    borderInfo: '1px solid rgba(61, 116, 196, .28)',
    colorWarning: 'rgba(201, 136, 47, .14)',
    textColorWarning: '#96600f',
    borderWarning: '1px solid rgba(201, 136, 47, .32)',
    colorSuccess: 'rgba(44, 156, 98, .12)',
    textColorSuccess: '#1e7a4d',
    borderSuccess: '1px solid rgba(44, 156, 98, .30)',
    colorError: 'rgba(193, 58, 78, .10)',
    textColorError: '#b3273d',
    borderError: '1px solid rgba(193, 58, 78, .30)'
  }
};

// 当前主题（gensokyo 秘封之夜 / scarlet 红魔馆）
const naivTheme = computed(() => themeStore.value === 'scarlet' ? lightTheme : darkTheme);
const themeOverrides = computed(() => themeStore.value === 'scarlet' ? scarletOverrides : gensokyoOverrides);
const sceneSrc = computed(() => themeStore.value === 'scarlet' ? '/img/scarlet-scene.svg' : '/img/scene.svg');

// 秘封之夜：缓缓上升的星光粒子
const stars = Array.from({ length: 26 }, (_, i) => ({
  char: ['·', '✦', '✧', '☆', '·', '★'][i % 6],
  left: (i * 47 + 13) % 100,
  size: 9 + (i % 5) * 4,
  duration: 10 + (i % 6) * 2.8,
  delay: -((i * 29) % 18),
  opacity: 0.35 + ((i % 6) / 10)
}));

// 樱花花瓣：自上而下飘落
const petals = Array.from({ length: 14 }, (_, i) => ({
  left: (i * 61 + 7) % 100,
  size: 9 + (i % 4) * 4,
  duration: 9 + (i % 5) * 2.6,
  delay: -((i * 17) % 15),
  drift: (i % 2 ? 1 : -1) * (4 + (i % 4) * 2)
}));
</script>

<template>
  <n-config-provider :theme="naivTheme" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <n-message-provider>
      <n-dialog-provider>
        <img class="site-scene" :src="sceneSrc" alt="" aria-hidden="true" />
        <div class="scene-veil" aria-hidden="true"></div>
        <div v-if="themeStore === 'gensokyo'" class="night-layer" aria-hidden="true">
          <img class="fl-lantern l1" src="/img/lantern.svg" alt="" />
          <img class="fl-lantern l2" src="/img/lantern.svg" alt="" />
          <img class="fl-ofuda o1" src="/img/ofuda.svg" alt="" />
          <img class="fl-ofuda o2" src="/img/ofuda.svg" alt="" />
          <img class="fl-orb orb1" src="/img/yin-yang-orb.svg" alt="" />
          <img class="fl-orb orb2" src="/img/yin-yang-orb.svg" alt="" />
          <img class="fl-orb orb3" src="/img/yin-yang-orb.svg" alt="" />
          <img class="fl-bunny bunny1" src="/img/bunny.svg" alt="" />
          <img class="fl-bunny bunny2" src="/img/bunny.svg" alt="" />
          <img class="fl-book book1" src="/img/magic-book.svg" alt="" />
          <img class="fl-sakura" src="/img/sakura-branch.svg" alt="" />
          <img class="corner-lily" src="/img/spider-lily.svg" alt="" />
          <span v-for="(s, i) in stars" :key="'s' + i" class="star"
            :style="{ left: s.left + '%', fontSize: s.size + 'px', animationDuration: s.duration + 's', animationDelay: s.delay + 's', '--o': s.opacity }">{{ s.char }}</span>
          <span v-for="(p, i) in petals" :key="'p' + i" class="petal"
            :style="{ left: p.left + '%', width: p.size + 'px', height: p.size + 'px', animationDuration: p.duration + 's', animationDelay: p.delay + 's', '--drift': p.drift + 'vw' }"></span>
        </div>
        <div v-else class="scarlet-layer" aria-hidden="true">
          <img class="sd-moon" src="/img/moon.svg" alt="" />
          <img class="sd-candle c1" src="/img/candle.svg" alt="" />
          <img class="sd-candle c2" src="/img/candle.svg" alt="" />
          <img class="sd-bat b1" src="/img/bat.svg" alt="" />
          <img class="sd-bat b2" src="/img/bat.svg" alt="" />
          <img class="sd-bat b3" src="/img/bat.svg" alt="" />
          <span class="sd-rose r1">🌹</span>
          <span class="sd-rose r2">🌹</span>
          <span v-for="(p, i) in petals" :key="'rp' + i" class="petal sd-petal"
            :style="{ left: p.left + '%', width: p.size + 'px', height: p.size + 'px', animationDuration: p.duration + 's', animationDelay: p.delay + 's', '--drift': p.drift + 'vw' }"></span>
        </div>
        <div class="layout">
          <NavBar v-if="!loading" />
          <div class="page" v-if="!loading">
            <router-view />
          </div>
          <div v-else class="loading">🌙 加载中…</div>
          <FooterBar v-if="!loading" />
        </div>
        <GensokyoAnnounce />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<style>
.night-layer { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
.night-layer .star {
  position: absolute; bottom: -6vh;
  color: #f4e9c8; text-shadow: 0 0 8px rgba(244, 233, 200, .55);
  animation-name: starRise; animation-timing-function: linear; animation-iteration-count: infinite;
  will-change: transform, opacity;
}
@keyframes starRise {
  0% { transform: translate3d(0, 0, 0) scale(1); opacity: 0; }
  8% { opacity: var(--o, .6); }
  45% { opacity: calc(var(--o, .6) * .85); }
  90% { opacity: 0; }
  100% { transform: translate3d(-6vw, -112vh, 0) scale(.55); opacity: 0; }
}
.night-layer .l1 { top: 70px; left: 34px; }
.night-layer .l2 { top: 112px; right: 26px; width: 36px; animation-delay: 1.2s; }
.night-layer .o1 { top: 62px; right: 128px; }
.night-layer .o2 { top: 168px; left: 132px; animation-delay: 2s; }
.layout { position: relative; z-index: 1; }
.loading { padding: 90px; text-align: center; color: var(--text-dim); font-size: 16px; }
@media (max-width: 720px) {
  .night-layer .l1, .night-layer .l2, .night-layer .o1, .night-layer .o2 { display: none; }
}
</style>
