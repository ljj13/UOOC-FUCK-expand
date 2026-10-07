'use strict';

// 首次安装/更新时补齐默认配置
chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(null);
  const defaults = {
    rateOn: true,
    rateValue: 2,
    muteOn: true,
    playOn: true,
    continueOn: true,
    popupSolveOn: true,
    gateOn: true,
    discussionOn: true,
    apiDirectOn: true,
    appToken: '',
    llmEnabled: false,
    engineRunning: false,
    llmConfig: null
  };
  const patch = {};
  for (const k of Object.keys(defaults)) {
    if (!(k in cur)) patch[k] = defaults[k];
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});

// Base URL 自动规范化：
//   https://api.openai.com              -> https://api.openai.com/v1/chat/completions
//   https://api.openai.com/v1           -> https://api.openai.com/v1/chat/completions
//   https://ark.cn-beijing.volces.com/api/v3 -> .../api/v3/chat/completions（保留已有版本号）
//   误填到 .../chat/completions          -> 去重后拼回
function normalizeApiUrl(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '');
  u = u.replace(/\/chat\/completions$/i, '');
  if (!/\/v\d+$/.test(u)) u += '/v1';
  return u + '/chat/completions';
}

// 页面世界求值：content script 访问不到页面 angular/DIR_EDITORS，
// 由这里用 chrome.scripting(world:'MAIN') 在页面世界执行（不受页面 CSP 限制）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'PAGE_EVAL') return;
  if (!sender.tab || !sender.tab.id) return sendResponse({ result: { __err: '无目标标签页' } });
  try {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: new Function('return (' + msg.fn + ')')(),
      args: msg.args || []
    }).then((injections) => {
      const first = injections && injections[0];
      sendResponse({ result: first && 'result' in first ? first.result : null });
    }).catch((e) => sendResponse({ result: { __err: String((e && e.message) || e) } }));
  } catch (e) {
    sendResponse({ result: { __err: String((e && e.message) || e) } });
  }
  return true; // 异步 sendResponse
});

// LLM 请求统一走 Service Worker：
// 1) 不受页面 CSP / CORS 限制（需在设置页保存时授予 API 域名的可选权限）；
// 2) API Key 只存在 chrome.storage.local，不进入页面脚本环境。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'LLM_CHAT') return;

  (async () => {
    try {
      const { llmConfig } = await chrome.storage.local.get('llmConfig');
      const cfg = llmConfig || {};
      if (!cfg.baseUrl || !cfg.apiKey) {
        return sendResponse({ ok: false, error: '未配置 API，请点击面板 ⚙️ 打开设置页' });
      }
      const resp = await fetch(normalizeApiUrl(cfg.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify({
          model: cfg.model || 'gpt-3.5-turbo',
          messages: msg.payload.messages,
          temperature: msg.payload.temperature === undefined ? 0.3 : msg.payload.temperature
        })
      });
      const data = await resp.json().catch(() => ({}));
      sendResponse({ ok: resp.ok, status: resp.status, data });
    } catch (e) {
      sendResponse({
        ok: false,
        error: String((e && e.message) || e) +
          '（若提示 Failed to fetch，请到设置页重新保存配置并同意跨域授权）'
      });
    }
  })();

  return true; // 异步 sendResponse
});
