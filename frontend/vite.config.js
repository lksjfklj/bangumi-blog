import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // 手动分包：框架 / UI 库 / 业务 分离，利用 HTTP/2 并行加载 + 长缓存（UI 库版本稳定几乎不用重新下载）
        manualChunks(id) {
          // 只拆 node_modules：业务代码交给 Vite 按路由懒加载自然分包
          // （非 node_modules 若也指定 chunk，会把所有路由页合并进主包，失去首屏按需加载）
          if (!id.includes('node_modules')) return undefined;
          // naive-ui 及其专属依赖链拆成独立 chunk，版本稳定可长缓存
          if (id.includes('naive-ui') || id.includes('vueuc') || id.includes('vdirs') || id.includes('css-render') || id.includes('date-fns') || id.includes('treemate') || id.includes('seemly') || id.includes('evtd') || id.includes('lodash-es') || id.includes('vooks') || id.includes('async-validator') || id.includes('highlight.js') || id.includes('lodash') || id.includes('@juggle/resize-observer')) return 'naive';
          return 'vendor';
        }
      }
    }
  }
});


