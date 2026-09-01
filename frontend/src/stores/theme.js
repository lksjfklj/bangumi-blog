import { ref } from 'vue';

const STORAGE_KEY = 'mhf-theme';
const THEMES = ['gensokyo', 'scarlet'];

function readSaved() {
  try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
}

function applyTheme(t) {
  const val = THEMES.includes(t) ? t : 'gensokyo';
  document.documentElement.dataset.theme = val;
  try { localStorage.setItem(STORAGE_KEY, val); } catch (e) { /* ignore */ }
}

export const theme = ref(readSaved() === 'scarlet' ? 'scarlet' : 'gensokyo');

export function setTheme(t) {
  const val = THEMES.includes(t) ? t : 'gensokyo';
  theme.value = val;
  applyTheme(val);
}

export function toggleTheme() {
  setTheme(theme.value === 'gensokyo' ? 'scarlet' : 'gensokyo');
}

// 在应用挂载前调用，避免主题闪烁
export function initTheme() {
  applyTheme(theme.value);
}
