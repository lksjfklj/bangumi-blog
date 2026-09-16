<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NInput, NButton, NForm, NFormItem, useMessage } from 'naive-ui';
import { api } from '../api';
import { useUserStore } from '../stores/user';

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();
const message = useMessage();

const redirect = String(route.query.redirect || '/');
const switching = computed(() => route.query.switch === '1' && userStore.isLoggedIn);
const mode = ref('login'); // login | register

const form = ref({ username: '', password: '', nickname: '', email: '', code: '', password2: '' });
const submitting = ref(false);
const viewerLoading = ref(false);
const mailSending = ref(false);
const mailCd = ref(0);
let mailTimer = null;

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

function startMailCountdown(sec) {
  mailCd.value = sec;
  if (mailTimer) clearInterval(mailTimer);
  mailTimer = setInterval(() => {
    mailCd.value--;
    if (mailCd.value <= 0) { clearInterval(mailTimer); mailTimer = null; }
  }, 1000);
}

async function sendCode() {
  const email = form.value.email.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { message.warning('请先填写正确的邮箱'); return; }
  if (mailCd.value > 0 || mailSending.value) return;
  mailSending.value = true;
  errorText.value = '';
  try {
    await api.post('/auth/mail/request-code', { email });
    message.success('验证码已发送到 ' + email + '，请查收邮件');
    startMailCountdown(60);
  } catch (e) { errorText.value = e.message || '验证码发送失败'; }
  mailSending.value = false;
}

onUnmounted(() => { if (mailTimer) clearInterval(mailTimer); });

async function doRegister() {
  const f = form.value;
  if (!f.username.trim() || !f.password) { message.warning('请输入用户名和密码'); return; }
  if (f.password.length < 8) { message.warning('密码长度至少 8 位'); return; }
  if (f.password !== f.password2) { message.warning('两次输入的密码不一致'); return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) { message.warning('请填写正确的邮箱'); return; }
  if (!/^\d{6}$/.test(f.code.trim())) { message.warning('请填写 6 位邮箱验证码'); return; }
  submitting.value = true;
  errorText.value = '';
  try {
    await userStore.registerLocal(f.username.trim(), f.password, f.nickname.trim(), f.email.trim(), f.code.trim());
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

// 用原生 <a href> 跳转：手机端比 location.href 更可靠，也能长按复制链接。
// 点击后 6 秒仍没跳走，说明多半是 bgm.tv 在当前网络下打不开，直接给出提示。
const bgmGo = ref(false);
const bgmStuck = ref(false);
let bgmTimer = null;
function bgmStart() {
  bgmStuck.value = false;
  bgmGo.value = true;
  if (bgmTimer) clearTimeout(bgmTimer);
  bgmTimer = setTimeout(() => { bgmStuck.value = true; }, 6000);
}
onUnmounted(() => { if (bgmTimer) clearTimeout(bgmTimer); });
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
        <n-form-item v-if="mode === 'register'" label="邮箱">
          <div class="mail-row">
            <n-input v-model:value="form.email" placeholder="接收验证码，注册成功后绑定账号" @keyup.enter="sendCode" />
            <n-button size="small" :loading="mailSending" :disabled="mailCd > 0" @click="sendCode">
              {{ mailCd > 0 ? mailCd + 's 后可重发' : (mailSending ? '发送中…' : '发送验证码') }}
            </n-button>
          </div>
        </n-form-item>
        <n-form-item v-if="mode === 'register'" label="验证码">
          <n-input v-model:value="form.code" maxlength="6" placeholder="6 位数字验证码" @keyup.enter="doRegister" />
        </n-form-item>

        <n-form-item label="密码">
          <n-input v-model:value="form.password" type="password" show-password-on="click" placeholder="密码（8-72 位）" @keyup.enter="mode === 'login' ? doLogin() : doRegister()" />
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

      <a class="bgm-btn" :class="{ busy: bgmGo }" href="/api/auth/bangumi" @click="bgmStart">
        <span class="bgm-badge">B</span>
        <span class="bgm-btn-txt">{{ bgmGo ? '正在跳转到 Bangumi 授权页…' : '通过 Bangumi 账号登录（收藏可联动同步）' }}</span>
      </a>
      <p v-if="bgmStuck" class="bgm-warn">
        页面好像没能跳转：Bangumi 官网 bgm.tv 在国内部分网络（尤其是手机流量）无法直接打开。
        请开启代理后重试；或先在开着代理的电脑上用 Bangumi 登录、到「追番」页完成连接，
        之后手机直接用本站账号密码登录即可，同步由服务器完成。
      </p>
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

/* Bangumi 登录改用原生 <a>：手机端更可靠，长文案也能换行 */
.bgm-btn {
  display: flex; align-items: center; justify-content: center;
  width: 100%; box-sizing: border-box; min-width: 0;
  padding: 11px 14px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--bg-soft);
  color: var(--text); font-size: 14px; font-weight: 600; line-height: 1.45;
  text-decoration: none; text-align: center;
  transition: border-color .18s, color .18s;
}
.bgm-btn:hover { border-color: var(--accent); color: var(--accent); }
.bgm-btn.busy { opacity: .7; pointer-events: none; }
.bgm-btn-txt { min-width: 0; overflow-wrap: anywhere; }
.bgm-warn {
  margin: 12px 0 0; padding: 10px 12px; border-radius: 12px;
  border: 1px dashed var(--viewer-border); background: var(--viewer-bg);
  color: var(--text-dim); font-size: 12px; line-height: 1.7;
}

/* 手机端：收紧留白并允许长文案换行，避免横向溢出 */
@media (max-width: 560px) {
  .login-wrap { padding: 22px 12px 46px; }
  .login-card { padding: 22px 16px 20px; border-radius: 18px; }
  .card-head { margin-bottom: 18px; }
  .card-head .emoji { font-size: 28px; }
  .card-head h1 { font-size: 21px; letter-spacing: 2px; }
  .card-head h1::after { margin-left: 5px; font-size: 13px; vertical-align: 4px; }
  .mail-row { flex-direction: column; align-items: stretch; gap: 8px; }
  .mail-row :deep(.n-button) { width: 100%; }
  .switch-hint { flex-direction: column; align-items: flex-start; }
  .switch-hint .switch-logout { margin-left: 0; }
  .bgm-btn { font-size: 13px; padding: 10px 12px; }
}
.mail-row { display: flex; gap: 8px; align-items: center; width: 100%; }
.mail-row :deep(.n-input) { flex: 1 1 auto; }
</style>
