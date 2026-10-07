'use strict';

const $ = (id) => document.getElementById(id);
const status = (t) => { $('status').textContent = t; };

const TOGGLES = {
  'rate-on': 'rateOn',
  'mute-on': 'muteOn',
  'play-on': 'playOn',
  'continue-on': 'continueOn',
  'popup-on': 'popupSolveOn',
  'gate-on': 'gateOn'
};

async function load() {
  const items = await chrome.storage.local.get(['llmConfig', ...Object.values(TOGGLES), 'rateValue']);
  const c = items.llmConfig || {};
  $('baseurl').value = c.baseUrl || '';
  $('apikey').value = c.apiKey || '';
  $('model').value = c.model || '';
  for (const [id, key] of Object.entries(TOGGLES)) $(id).checked = items[key] !== false;
  $('rate-value').value = String(items.rateValue ?? 2);
}

$('btn-save').onclick = async () => {
  const baseUrl = $('baseurl').value.trim();
  const apiKey = $('apikey').value.trim();
  const model = $('model').value.trim();
  if (!baseUrl || !apiKey) { status('❌ Base URL 和 API Key 必填'); return; }

  await chrome.storage.local.set({ llmConfig: { baseUrl, apiKey, model } });

  // 授予该 API 域名的可选跨域权限，后台才能直连（否则可能被 CORS 拦截）
  let msg = '✅ 配置已保存';
  try {
    const origin = new URL(baseUrl).origin + '/*';
    const ok = await chrome.permissions.request({ origins: [origin] });
    msg += ok
      ? '，已授予该 API 域名的跨域访问权限'
      : '，⚠️ 未授权跨域访问（调用可能因 CORS 失败，可重新保存并同意授权）';
  } catch (e) {
    msg += '，⚠️ 授权请求失败：' + e.message;
  }
  status(msg);
};

$('btn-test').onclick = async () => {
  status('⏳ 测试中...');
  // 先保存再测，避免测的是旧配置
  const baseUrl = $('baseurl').value.trim();
  const apiKey = $('apikey').value.trim();
  if (!baseUrl || !apiKey) { status('❌ 请先填写 Base URL 和 API Key'); return; }
  await chrome.storage.local.set({ llmConfig: { baseUrl, apiKey, model: $('model').value.trim() } });

  const res = await chrome.runtime.sendMessage({
    type: 'LLM_CHAT',
    payload: { messages: [{ role: 'user', content: '请只回复两个字符：OK' }], temperature: 0 }
  });
  if (res && res.ok) {
    const text = res.data?.choices?.[0]?.message?.content || '(空响应)';
    status(`✅ 连接成功，模型返回：${text.trim().slice(0, 50)}`);
  } else {
    status(`❌ 连接失败：${res ? (res.error || 'HTTP ' + res.status) : '无响应'}`);
  }
};

for (const [id, key] of Object.entries(TOGGLES)) {
  $(id).addEventListener('change', (e) => chrome.storage.local.set({ [key]: e.target.checked }));
}
$('rate-value').addEventListener('change', (e) =>
  chrome.storage.local.set({ rateValue: Number(e.target.value) || 2 }));

load();
