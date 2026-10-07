'use strict';

const $ = (id) => document.getElementById(id);
const KEYS = {
  'rate-on': 'rateOn',
  'mute-on': 'muteOn',
  'play-on': 'playOn',
  'continue-on': 'continueOn',
  'popup-on': 'popupSolveOn',
  'gate-on': 'gateOn',
  'llm-on': 'llmEnabled'
};

async function refresh() {
  const items = await chrome.storage.local.get(
    [...Object.values(KEYS), 'rateValue', 'engineRunning', 'llmConfig']);

  for (const [id, key] of Object.entries(KEYS)) $(id).checked = !!items[key];
  $('rate-value').value = String(items.rateValue ?? 2);

  // 状态用圆点颜色 + 纯文本表达，不再用 🟢⚪ emoji
  $('engine-dot').classList.toggle('on', !!items.engineRunning);
  $('engine-state').textContent = items.engineRunning ? '运行中' : '未启动';

  const c = items.llmConfig;
  const ok = !!(c && c.baseUrl && c.apiKey);
  $('llm-dot').classList.toggle('on', ok);
  $('llm-state').textContent = ok ? (c.model || '已配置') : '未配置';

  $('pp-ver').textContent = 'v' + chrome.runtime.getManifest().version;
}

for (const [id, key] of Object.entries(KEYS)) {
  $(id).addEventListener('change', (e) => chrome.storage.local.set({ [key]: e.target.checked }));
}
$('rate-value').addEventListener('change', (e) =>
  chrome.storage.local.set({ rateValue: Number(e.target.value) || 2 }));
$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener(refresh);
refresh();
