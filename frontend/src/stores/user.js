import { defineStore } from 'pinia';
import { api } from '../api';

export const useUserStore = defineStore('user', {
  state: () => ({
    user: null,
    viewer: false,
    loaded: false
  }),
  getters: {
    isOwner: (s) => !!s.user && s.user.role === 'owner' && !s.viewer,
    isLoggedIn: (s) => !!s.user
  },
  actions: {
    async fetchMe() {
      try {
        const data = await api.get('/auth/me');
        this.user = data.user;
        this.viewer = !!data.viewer;
      } catch (e) {
        this.user = null;
        this.viewer = false;
      } finally {
        this.loaded = true;
      }
    },
    // 登录 / 注册 / 进入只读访客后统一从服务端重新同步状态，
    // 否则 SPA 内 user 不同步，路由守卫会误判为未登录
    async loginLocal(username, password) {
      await api.post('/auth/login', { username, password });
      await this.fetchMe();
      return { ok: true };
    },
    async registerLocal(username, password, nickname, email, code) {
      await api.post('/auth/register', { username, password, nickname, email, code });
      await this.fetchMe();
      return { ok: true };
    },
    async enterViewer() {
      await api.post('/auth/viewer');
      await this.fetchMe();
      return { ok: true };
    },
    async logout() {
      try { await api.post('/auth/logout'); } catch (e) { /* ignore */ }
      this.user = null;
      this.viewer = false;
      location.href = '/';
    }
  }
});