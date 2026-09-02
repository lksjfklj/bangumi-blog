
// utils/push.js - PWA Web Push 订阅/退订（配合后端 /api/notify/push-subscribe）
import { api } from '../api';

// base64url -> Uint8Array（VAPID 公钥与订阅密钥格式转换）
export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    return reg;
  } catch (e) {
    console.warn('[push] SW register failed', e);
    return null;
  }
}

// 订阅：返回新订阅对象（含 keys），失败返回 null
export async function subscribePush(vapidPublicKey) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('当前浏览器不支持 Web Push');
  }
  if (!vapidPublicKey) throw new Error('服务器未配置 Web Push（VAPID）');
  const reg = await registerSW();
  if (!reg) throw new Error('Service Worker 注册失败');
  let sub = await reg.pushManager.getSubscription();
  if (sub) return sub;
  sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
  });
  return sub;
}

// 保存订阅到后端
export async function saveSubscription(sub) {
  if (!sub) return;
  await api.post('/notify/push-subscribe', {
    endpoint: sub.endpoint,
    keys: {
      p256dh: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('p256dh')))),
      auth: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('auth'))))
    }
  });
}

// 取消订阅（删除本地 + 后端）
export async function unsubscribePush() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe().catch(() => {});
      await api.del('/notify/push-subscribe', { endpoint }).catch(() => {});
    }
  } catch (e) { /* ignore */ }
}
