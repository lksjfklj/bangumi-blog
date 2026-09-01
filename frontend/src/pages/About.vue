<script setup>
</script>

<template>
  <div class="container" style="max-width:820px">
    <div class="page-head" v-reveal>
      <span class="emoji">🌙</span><h2>关于</h2>
    </div>
    <div class="about-card markdown-body" v-reveal>
      <h2>秘封俱乐部是什么</h2>
      <p>「秘封俱乐部」是一个个人搭建的番剧资讯与个人博客站点，灵感来自 <a href="https://bgm.tv" target="_blank" rel="noreferrer">Bangumi 番组计划</a> 和 Animeko 等追番工具，以及东方 Project 里那两位在境界之间漫步的少女。</p>
      <ul>
        <li><b>本周放送</b>：首页展示周一到周日的动画放送日历</li>
        <li><b>番剧库</b>：搜索动画 / 书籍 / 游戏 / 音乐条目，按评分、收藏数排序</li>
        <li><b>追番联动</b>：使用 Bangumi 账号登录后，可把 Bangumi 收藏一键导入，观看进度、评分、评论双向同步</li>
        <li><b>个人博客</b>：Markdown 写作，标签归档</li>
        <li><b>二次元资讯</b>：Galgame / 视觉小说 / 动画 / 漫画 / 轻小说领域精选 RSS</li>
      </ul>
      <h2>技术栈</h2>
      <ul>
        <li>前端：Vue 3 · Vite · Naive UI（SPA）</li>
        <li>后端：Node.js · Express · SQLite（node:sqlite）</li>
        <li>数据源：Bangumi API v0（图片与接口经本站代理缓存）</li>
        <li>部署：宝塔面板 · Nginx · 阿里云</li>
      </ul>
      <h2>数据说明</h2>
      <p>番剧数据与图片版权归 Bangumi 及原作者所有，本站仅作个人学习与展示用途。</p>
    </div>
  </div>
</template>