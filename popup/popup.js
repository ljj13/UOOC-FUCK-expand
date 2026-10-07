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

  $('engine-state').textContent = items.engineRunning
    ? '🟢 挂机引擎运行中'
    : '⚪ 引擎未启动（在课程页面面板点火）';

  const c = items.llmConfig;
  $('llm-state').textContent = (c && c.baseUrl && c.apiKey)
    ? `🟢 AI 已配置（${c.model || '默认模型'}）`
    : '⚪ AI 未配置';
}

for (const [id, key] of Object.entries(KEYS)) {
  $(id).addEventListener('change', (e) => chrome.storage.local.set({ [key]: e.target.checked }));
}
$('rate-value').addEventListener('change', (e) =>
  chrome.storage.local.set({ rateValue: Number(e.target.value) || 2 }));
$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener(refresh);
refresh();
