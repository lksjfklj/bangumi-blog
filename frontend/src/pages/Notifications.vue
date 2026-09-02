
<script setup>
import { ref, onMounted, computed } from 'vue';
import { NForm, NFormItem, NInput, NSwitch, NButton, NAlert, NSpin, NInputNumber, useMessage } from 'naive-ui';
import { api } from '../api';
import { subscribePush, saveSubscription, unsubscribePush } from '../utils/push';
import { useUserStore } from '../stores/user';

const userStore = useUserStore();
const message = useMessage();
const loading = ref(true);
const saving = ref(false);
const testing = ref(false);
const errorMsg = ref('');

const form = ref({
  enabled: true,
  serverchan_key: '',
  telegram_chat_id: '',
  webhook: '',
  email: ''
});
const info = ref({ subscribed: false, vapidPublicKey: '', telegramAvailable: false, smtpAvailable: false, hasChannels: false });
const profile = ref({ profile_public: false, bio: '' });

async function load() {
  loading.value = true;
  errorMsg.value = '';
  try {
    const [s, me] = await Promise.all([
      api.get('/notify/settings'),
      api.get('/auth/me').catch(() => null)
    ]);
    form.value = {
      enabled: s.enabled !== false,
      serverchan_key: s.serverchan_key || '',
      telegram_chat_id: s.telegram_chat_id || '',
      webhook: s.webhook || '',
      email: s.email || ''
    };
    info.value = {
      subscribed: !!s.subscribed,
      vapidPublicKey: s.vapidPublicKey || '',
      telegramAvailable: !!s.telegramAvailable,
      smtpAvailable: !!s.smtpAvailable,
      hasChannels: !!s.hasChannels
    };
    const u = me && me.user;
    if (u) profile.value = { profile_public: !!u.profile_public, bio: u.bio || '' };
  } catch (e) {
    errorMsg.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    await api.put('/notify/settings', form.value);
    message.success('通知设置已保存');
  } catch (e) {
    message.error('保存失败：' + e.message);
  } finally {
    saving.value = false;
  }
}

async function saveProfile() {
  saving.value = true;
  try {
    await api.put('/profile/public', profile.value);
    message.success(profile.value.profile_public ? '已开启公开分享页' : '已关闭公开分享页');
  } catch (e) {
    message.error('保存失败：' + e.message);
  } finally {
    saving.value = false;
  }
}

// Web Push 订阅/退订
async function toggleSubscribe() {
  try {
    if (info.value.subscribed) {
      await unsubscribePush();
      info.value.subscribed = false;
      message.success('已退订 Web Push');
    } else {
      const sub = await subscribePush(info.value.vapidPublicKey);
      await saveSubscription(sub);
      info.value.subscribed = true;
      message.success('订阅成功，新话更新将推送到此设备');
    }
  } catch (e) {
    message.error('订阅失败：' + (e.message || '浏览器不支持或未授权'));
  }
}

async function sendTest() {
  testing.value = true;
  try {
    const d = await api.post('/notify/test', {});
    const okN = (d.results || []).filter(r => r.ok).length;
    if (okN > 0) message.success('测试推送已发送（' + okN + ' 个渠道成功）');
    else message.warning('未发送成功：请检查渠道配置（无可用渠道时请先开启 Web Push 或填写 Server酱/邮箱等）');
  } catch (e) {
    message.error('测试失败：' + e.message);
  } finally {
    testing.value = false;
  }
}

const shareUrl = computed(() => {
  if (!userStore.user || !userStore.user.bangumi_uid) return '';
  return location.origin + '/share/' + userStore.user.bangumi_uid;
});

onMounted(load);
</script>

<template>
  <div class="container narrow">
    <div class="page-head" v-reveal>
      <span class="emoji">🔔</span><h2>通知与分享</h2>
    </div>

    <n-spin :show="loading">
      <n-alert v-if="errorMsg" type="error" style="margin:10px 0">{{ errorMsg }}</n-alert>

      <div class="card" v-reveal>
        <div class="card-title">📢 新话更新推送</div>
        <p class="muted">当「我追的番」有新的字幕组发布时，通过以下渠道主动通知你（不配置也不影响站内未读角标）。</p>
        <n-form label-placement="top">
          <n-form-item label="开启推送">
            <n-switch v-model:value="form.enabled" />
          </n-form-item>
          <n-form-item label="Server酱 SendKey">
            <n-input v-model:value="form.serverchan_key" placeholder="sct…（选填）" />
            <span class="hint">填入后新话更新会推送至你的微信（sctapi.ftqq.com）</span>
          </n-form-item>
          <n-form-item label="Telegram Chat ID">
            <n-input v-model:value="form.telegram_chat_id" :disabled="!info.telegramAvailable" :placeholder="info.telegramAvailable ? '如 123456789（选填）' : '站长未配置 Bot Token'" />
            <span class="hint">需要站长配置全局 Bot Token 后生效</span>
          </n-form-item>
          <n-form-item label="通用 Webhook URL">
            <n-input v-model:value="form.webhook" placeholder="https://example.com/hook（选填）" />
            <span class="hint">将以 POST JSON {title, body, url} 调用，可对接自建机器人/ntfy 等</span>
          </n-form-item>
          <n-form-item label="邮件通知">
            <n-input v-model:value="form.email" :disabled="!info.smtpAvailable" :placeholder="info.smtpAvailable ? 'you@example.com（选填）' : '站长未配置 SMTP'" />
            <span class="hint">新话更新发送到该邮箱（SMTP 需站长配置）</span>
          </n-form-item>
          <div class="row-actions">
            <n-button type="primary" round :loading="saving" @click="save">保存设置</n-button>
            <n-button round secondary :loading="testing" @click="sendTest">📨 发送测试推送</n-button>
          </div>
        </n-form>
      </div>

      <div class="card" v-reveal>
        <div class="card-title">🖥 PWA 桌面/移动推送</div>
        <p class="muted">
          <template v-if="info.vapidPublicKey">已就绪：订阅后无需打开网站也能收到新话提醒。</template>
          <template v-else>服务器未配置 VAPID（暂不可用）。</template>
        </p>
        <div class="row-actions">
          <n-button round :type="info.subscribed ? 'default' : 'primary'" :disabled="!info.vapidPublicKey" @click="toggleSubscribe">
            {{ info.subscribed ? '✅ 已订阅（点击退订）' : '🔔 订阅本设备推送' }}
          </n-button>
        </div>
      </div>

      <div class="card" v-reveal>
        <div class="card-title">🌐 公开追番分享页</div>
        <p class="muted">开启后，朋友无需登录即可通过链接查看你的追番收藏与评分。</p>
        <n-form label-placement="top">
          <n-form-item label="开启公开分享">
            <n-switch v-model:value="profile.profile_public" @update:value="saveProfile" />
          </n-form-item>
          <n-form-item label="个人简介（显示在分享页）">
            <n-input v-model:value="profile.bio" type="textarea" :rows="3" maxlength="300" show-count placeholder="介绍一下自己吧…" />
            <div class="row-actions">
              <n-button size="small" round secondary @click="saveProfile">保存简介</n-button>
              <a v-if="shareUrl" class="share-link" :href="shareUrl" target="_blank">🔗 {{ shareUrl }}</a>
            </div>
          </n-form-item>
        </n-form>
      </div>
    </n-spin>
  </div>
</template>

<style scoped>
.container.narrow { max-width: 680px; }
.card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px; padding: 20px 22px; margin-top: 16px; }
.card-title { font-size: 17px; font-weight: 800; margin-bottom: 6px; color: var(--text); }
.muted { color: var(--text-dim); font-size: 13px; margin: 0 0 12px; line-height: 1.6; }
.hint { font-size: 12px; color: var(--text-dim); opacity: .75; margin-top: 2px; }
.row-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 6px; }
.share-link { font-size: 13px; color: var(--accent); text-decoration: none; word-break: break-all; }
.share-link:hover { text-decoration: underline; }
</style>
