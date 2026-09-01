<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NInput, NButton, NForm, NFormItem, NMessageProvider, useMessage } from 'naive-ui';
import { useUserStore } from '../stores/user';

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();
const message = useMessage();

const redirect = String(route.query.redirect || '/');
const switching = computed(() => route.query.switch === '1' && userStore.isLoggedIn);
const mode = ref('login'); // login | register

const form = ref({ username: '', password: '', nickname: '', password2: '' });
const submitting = ref(false);
const viewerLoading = ref(false);

const errorText = ref('');

onMounted(() => {
  const err = route.query.login_error;
  if (err) {
    const map = { state_mismatch: '登录状态校验失败，请重试', token_failed: 'Bangumi 授权失败，请重试' };
    errorText.value = map[err] || String(err);
  }
});

function go() { router.replace(redirect); }

async function doLogin() {
  if (!form.value.username.trim() || !form.value.password) { message.warning('请输入用户名和密码'); return; }
  submitting.value = true;
  errorText.value = '';
  try {
    await userStore.loginLocal(form.value.username.trim(), form.value.password);
    message.success('欢迎回来，' + (userStore.user?.nickname || form.value.username));
    go();
  } catch (e) { errorText.value = e.message; }
  submitting.value = false;
}

async function doRegister() {
  if (!form.value.username.trim() || !form.value.password) { message.warning('请输入用户名和密码'); return; }
  if (form.value.password !== form.value.password2) { message.warning('两次输入的密码不一致'); return; }
  submitting.value = true;
  errorText.value = '';
  try {
    await userStore.registerLocal(form.value.username.trim(), form.value.password, form.value.nickname.trim());
    message.success('注册成功，欢迎来到秘封俱乐部');
    go();
  } catch (e) { errorText.value = e.message; }
  submitting.value = false;
}

async function enterViewer() {
  viewerLoading.value = true;
  errorText.value = '';
  try {
    await userStore.enterViewer();
    message.success('已进入只读访客模式（站长视角）');
    go();
  } catch (e) { errorText.value = e.message; }
  viewerLoading.value = false;
}

function bgmLogin() { location.href = '/api/auth/bangumi'; }
</script>

<template>
  <div class="login-wrap">
    <div class="login-card">
      <div v-if="switching" class="switch-hint">
        当前以「{{ userStore.user?.nickname || userStore.user?.username }}」身份登录，登录其他账号即可切换身份。
        <button class="switch-logout" @click="userStore.logout()">先退出登录</button>
      </div>
      <div class="card-head">
        <span class="emoji">🌙</span>
        <h1>秘封俱乐部</h1>
        <p class="sub">结界之内，皆为梦境。选择你的入场方式</p>
      </div>

      <div class="viewer-box">
        <div class="viewer-title">✨ 只读访客模式</div>
        <p class="viewer-desc">不登录，直接以站长视角浏览全站信息（追番、博客、资讯），仅可查看，不可修改任何数据。</p>
        <n-button type="primary" round block size="large" :loading="viewerLoading" @click="enterViewer">以站长视角进入（只读）</n-button>
      </div>

      <div class="divider"><span>或登录你的账号</span></div>

      <div class="seg">
        <button :class="['seg-btn', { on: mode === 'login' }]" @click="mode = 'login'">登录</button>
        <button :class="['seg-btn', { on: mode === 'register' }]" @click="mode = 'register'">注册</button>
      </div>

      <n-form class="local-form" @submit.prevent="mode === 'login' ? doLogin() : doRegister()">
        <n-form-item :label="mode === 'login' ? '用户名' : '用户名（2-24 位字母/数字/下划线/中文）'">
          <n-input v-model:value="form.username" placeholder="输入用户名" @keyup.enter="mode === 'login' ? doLogin() : doRegister()" />
        </n-form-item>
        <n-form-item v-if="mode === 'register'" label="昵称（可选）">
          <n-input v-model:value="form.nickname" placeholder="展示名字，不填默认用用户名" />
        </n-form-item>
        <n-form-item label="密码">
          <n-input v-model:value="form.password" type="password" show-password-on="click" placeholder="密码（至少 6 位）" @keyup.enter="mode === 'login' ? doLogin() : doRegister()" />
        </n-form-item>
        <n-form-item v-if="mode === 'register'" label="确认密码">
          <n-input v-model:value="form.password2" type="password" show-password-on="click" placeholder="再输入一次密码" @keyup.enter="doRegister" />
        </n-form-item>
        <p v-if="errorText" class="err">{{ errorText }}</p>
        <n-button type="primary" round block :loading="submitting" @click="mode === 'login' ? doLogin() : doRegister()">
          {{ mode === 'login' ? '登录' : '注册并登录' }}
        </n-button>
      </n-form>

      <div class="divider"><span>或使用 Bangumi 账号</span></div>

      <n-button secondary round block size="large" @click="bgmLogin">
        <span class="bgm-badge">B</span> 通过 Bangumi 账号登录（收藏可联动同步）
      </n-button>
      <p class="foot-note">本地账号的数据（追番、评分、评论、标签）保存在本站服务器；Bangumi 账号则与你的 Bangumi 双向同步。</p>
    </div>
  </div>
</template>

<style scoped>
.switch-hint {
  border: 1px solid var(--viewer-border); border-radius: 12px; padding: 10px 14px; margin-bottom: 16px;
  background: var(--viewer-bg); color: var(--text-dim); font-size: 12.5px; line-height: 1.7; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
}
.switch-hint .switch-logout {
  margin-left: auto; cursor: pointer; padding: 5px 14px; border-radius: 999px; border: 1px solid var(--back-btn-border);
  background: var(--back-btn-bg); color: var(--text-dim); font-size: 12px; font-weight: 700; font-family: inherit; transition: all .15s;
}
.switch-hint .switch-logout:hover { color: var(--accent); border-color: var(--accent); }
.login-wrap { display: flex; justify-content: center; padding: 46px 16px 70px; }
.login-card {
  width: 420px; max-width: 100%;
  background: var(--panel-grad);
  border: 1px solid var(--border); border-radius: 22px; padding: 30px 28px 26px;
  box-shadow: 0 18px 50px rgba(0,0,0,.5), inset 0 0 60px rgba(180,138,255,.06);
}
.card-head { text-align: center; margin-bottom: 22px; }
.card-head .emoji { font-size: 34px; display: block; margin-bottom: 4px; animation: moonPulse 3.4s ease-in-out infinite; }
@keyframes moonPulse { 0%,100% { opacity:.8; transform: scale(1); } 50% { opacity:1; transform: scale(1.08); } }
.card-head h1 { margin: 0; font-size: 26px; letter-spacing: 4px; }
.card-head h1::after {
  content: '✧'; margin-left: 10px; color: var(--accent-2); font-size: 16px; vertical-align: 6px;
}
.card-head .sub { margin: 8px 0 0; font-size: 13px; color: var(--text-dim); }
.viewer-box {
  border: 1px dashed var(--viewer-border); border-radius: 14px; padding: 14px 16px;
  background: var(--viewer-bg); margin-bottom: 6px;
}
.viewer-title { font-weight: 800; color: var(--accent); font-size: 15px; margin-bottom: 6px; }
.viewer-desc { margin: 0 0 12px; font-size: 12.5px; color: var(--text-dim); line-height: 1.65; }
.divider { display: flex; align-items: center; gap: 12px; color: var(--text-dim); font-size: 12px; margin: 18px 0 14px; }
.divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, transparent, var(--border), transparent); }
.divider span { letter-spacing: 1px; }
.seg { display: flex; background: var(--bg-soft); border: 1px solid var(--nav-border); border-radius: 999px; padding: 4px; margin-bottom: 16px; }
.seg-btn { flex: 1; border: none; background: transparent; color: var(--text-dim); padding: 8px 0; border-radius: 999px; font-size: 14px; cursor: pointer; font-family: inherit; font-weight: 600; transition: all .2s; }
.seg-btn.on { background: var(--grad-gold); color: var(--grad-text); box-shadow: 0 4px 14px var(--seg-shadow); }
.local-form :deep(.n-form-item-label) { color: var(--text-dim); }
.err { color: #f0616d; font-size: 13px; margin: 0 0 10px; }
.bgm-badge {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 50%;
  background: var(--grad-gold); color: var(--grad-text);
  font-weight: 900; font-size: 13px; margin-right: 8px;
}
.foot-note { margin: 14px 0 0; font-size: 11.5px; color: var(--text-dim); line-height: 1.6; text-align: center; }
</style>
