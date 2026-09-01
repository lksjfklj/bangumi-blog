<script setup>
</script>

<template>
  <footer class="footer">
    <img class="foot-sakura" src="/img/sakura-branch.svg" alt="" aria-hidden="true" />
    <img class="foot-bunny" src="/img/bunny.svg" alt="" aria-hidden="true" />
    <div class="container">
      <div class="tori-divider"><span>⛩</span></div>
      <p class="foot-love">🌙 秘封俱乐部 · 个人番剧资讯与博客 🌙</p>
      <p class="foot-line">月夜之下，境界线的另一侧 —— 秘封入</p>
      <p class="muted">数据来自 <a href="https://bgm.tv" target="_blank" rel="noreferrer">Bangumi 番组计划</a> · 本站为个人站点，非商业用途。番剧数据与图片版权归原作者所有。</p>
    </div>
  </footer>
</template>

<style scoped>
.footer {
  position: relative; overflow: hidden;
  border-top: 1px solid var(--border); padding: 22px 0 28px; text-align: center;
  font-size: 13px; color: var(--text-dim);
}
.foot-sakura {
  position: absolute; left: 0; bottom: -8px; width: 190px; opacity: .2; pointer-events: none;
  transform-origin: bottom left; animation: footSway 12s ease-in-out infinite;
}
.foot-bunny {
  position: absolute; right: 4%; top: 16px; width: 36px; opacity: .4; pointer-events: none;
  animation: footBunny 8s ease-in-out infinite;
}
@keyframes footSway {
  0%, 100% { transform: rotate(-1.4deg); }
  50% { transform: rotate(1.6deg); }
}
@keyframes footBunny {
  0%, 100% { transform: translateY(0) rotate(-3deg); }
  50% { transform: translateY(-12px) rotate(4deg); }
}
.footer .tori-divider { margin: 0 0 14px; }
.footer a { color: var(--accent); }
.footer p { margin: 4px 0; }
.foot-love { color: var(--accent); font-weight: 600; letter-spacing: 1px; }
.foot-line { color: var(--foot-accent); letter-spacing: 3px; font-size: 12px; }
@media (max-width: 720px) { .foot-sakura, .foot-bunny { display: none; } }
</style>