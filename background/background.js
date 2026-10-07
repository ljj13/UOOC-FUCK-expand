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

// ============================================================
// 页面世界函数（chrome.scripting world:'MAIN' 注入）
// ⚠️ MV3 扩展页 CSP 禁止 unsafe-eval：绝不能 new Function/eval 构造注入函数，
// 必须传函数引用（Chrome 内部序列化）。函数必须自包含，不能引用外部作用域。
// ⚠️ 每个函数内不能再嵌套引用本文件其它函数——序列化后外部作用域不存在。
// ============================================================

// 探测讨论列表 + 帖子详情（标题/正文已剥 HTML）；列表项打 data-uooc-tid 供隔离世界点击
function uoocPageProbe() {
  function climb(scope, pred) {
    let cur = scope;
    for (let i = 0; cur && i < 12; i++) {
      try { if (pred(cur)) return cur; } catch (e) { /* 忽略 */ }
      cur = cur.$parent;
    }
    return null;
  }
  function strip(html, cap) {
    const d = document.createElement('div');
    d.innerHTML = String(html || '');
    d.querySelectorAll('br').forEach((n) => n.replaceWith(document.createTextNode('\n')));
    const t = (d.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return t.slice(0, cap);
  }
  const out = { hasAngular: !!window.angular };
  try {
    // 结构诊断信息：探针未命中时输出，便于定位站点结构差异
    out.debug = {
      ngRepeats: Array.from(document.querySelectorAll('[ng-repeat]'))
        .slice(0, 12).map((n) => String(n.getAttribute('ng-repeat')).slice(0, 40)),
      hasDiscuz: !!document.querySelector('.Discuz'),
      inIframe: window.self !== window.top,
      replyBtns: Array.from(document.querySelectorAll('button, a, [ng-click]'))
        .filter((n) => n.offsetHeight > 0 && /^回\s*复$/.test((n.textContent || '').trim()))
        .slice(0, 6)
        .map((n) => n.tagName + '|' + String(n.className).slice(0, 40) + '|' + String(n.getAttribute('ng-click') || '').slice(0, 40)),
      net: (window.__uoocNet || []).slice(-6)
    };
    if (window.angular) {
      const lnodes = document.querySelectorAll(
        '[ng-repeat*="chapter_tiezi in questionList[2]"],[ng-repeat*="tiezi in studentList[0]"],[ng-repeat*="tiezi in comList"],[uooc-pager],.Discuz');
      for (const n of lnodes) {
        const s = climb(window.angular.element(n).scope(), (c) =>
          (typeof c.getPageDiscussion === 'function' && c.questionListPaper) ||
          (typeof c.getCourseDiscussionList === 'function' && c.noteListPaper));
        if (s) {
          const list = Array.isArray(s.studentList && s.studentList[0]) ? s.studentList[0]
            : Array.isArray(s.comList) ? s.comList
            : Array.isArray(s.questionList && s.questionList[2]) ? s.questionList[2] : [];
          const listEls = document.querySelectorAll('[ng-repeat*="tiezi"], .discussion-item, .thread-item');
          out.list = list.map((it, i) => {
            const tid = String(it.tid || it.thread_id || it.topic_id || it.id || '');
            const el = listEls[i];
            if (el && tid) { try { el.setAttribute('data-uooc-tid', tid); } catch (e) { /* 忽略 */ } }
            return { tid, title: strip(it.subject || it.title || it.content || '', 100) };
          }).filter((x) => x.tid);
          const pages = (s.noteListPaper && (s.noteListPaper.total || s.noteListPaper.pages))
            || (s.questionListPaper && s.questionListPaper[2] && (s.questionListPaper[2].pageCount || s.questionListPaper[2].pages)) || 1;
          out.pages = Number(pages) || 1;
          break;
        }
      }
      const dnodes = document.querySelectorAll(
        '[thread-detail],[ng-bind-html*="threads.content"],.discussionDesc,.thesis-content,.discuss-header');
      for (const n of dnodes) {
        const s = climb(window.angular.element(n).scope(), (c) =>
          c.threads && (typeof c.replay === 'function' || typeof c.getList === 'function' || typeof c.handleRelease === 'function'));
        if (s) {
          const t = s.threads || {};
          out.detail = {
            tid: String(t.tid || t.id || ''),
            title: strip(t.subject || t.title || '', 150),
            content: strip(t.content || (n.innerText || ''), 1500)
          };
          break;
        }
      }
    }
  } catch (e) { out.err = String(e); }
  return out;
}

// 填充编辑器并经 courseService.discReply 发帖
function uoocPageSubmitReply(cid, tid, content) {
  function climb(scope, pred) {
    let cur = scope;
    for (let i = 0; cur && i < 12; i++) {
      try { if (pred(cur)) return cur; } catch (e) { /* 忽略 */ }
      cur = cur.$parent;
    }
    return null;
  }
  if (!window.angular) return { __err: '页面 Angular 不可用' };
  let detail = null;
  const nodes = document.querySelectorAll(
    '[thread-detail],[ng-bind-html*="threads.content"],.discussionDesc,.thesis-content,.discuss-header');
  for (const n of nodes) {
    const s = climb(window.angular.element(n).scope(), (c) =>
      c.threads && (typeof c.replay === 'function' || typeof c.getList === 'function' || typeof c.handleRelease === 'function'));
    if (s) { detail = s; break; }
  }
  if (!detail) return { __err: '未找到帖子详情 scope' };

  // 编辑器填充：DIR_EDITORS（富文本）+ scope.noteContent + textarea 双保险
  const editor = window.DIR_EDITORS && (window.DIR_EDITORS.noteEditorAll || window.DIR_EDITORS.noteEditor);
  if (editor && typeof editor.setContent === 'function') {
    try { editor.setContent(content); } catch (e) { /* 忽略 */ }
  }
  if ('noteContent' in detail) detail.noteContent = content;
  document.querySelectorAll('textarea[ng-model="content"], textarea[ng-model="noteContent"]').forEach((ta) => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    if (set && set.set) set.set.call(ta, content); else ta.value = content;
    try {
      const es = window.angular.element(ta).scope();
      if (es && 'content' in es) { es.content = content; if (es.$evalAsync) es.$evalAsync(); }
      if (es && 'noteContent' in es) { es.noteContent = content; if (es.$evalAsync) es.$evalAsync(); }
    } catch (e) { /* 忽略 */ }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  });

  let injector = null;
  try { injector = window.angular.element(document.body || document.documentElement).injector(); } catch (e) { /* 忽略 */ }
  const courseService = injector && injector.get('courseService');
  if (!courseService || typeof courseService.discReply !== 'function') {
    return { __err: '未找到 courseService.discReply' };
  }
  // 同步返回 Promise 会被 executeScript 正确等待（injected promise）
  return Promise.resolve(courseService.discReply({ cid: String(cid), tid: String(tid), content, images: null }))
    .then(() => {
      try {
        if (typeof detail.getList === 'function') detail.getList();
        else if (typeof detail.getDetail === 'function') detail.getDetail();
      } catch (e) { /* 忽略 */ }
      return { ok: true };
    })
    .catch((e) => ({ __err: 'discReply 失败: ' + String(e) }));
}

// 网络钩子：记录讨论相关请求（诊断 + 兜底直连线索）。幂等，多 frame 注入安全。
function uoocNetHook() {
  if (window.__uoocNetInstalled) return { already: true };
  window.__uoocNetInstalled = true;
  var recs = [];
  window.__uoocNet = recs;
  function rec(method, url, body) {
    try {
      var u = String(url || '');
      var b = String(body || '');
      if (!/disc|reply|tiezi|comment/i.test(u + b) && !/^POST/.test(method + ' ')) return;
      recs.push({ m: method, u: u.slice(0, 160), b: b.slice(0, 240) });
      if (recs.length > 30) recs.shift();
    } catch (e) { /* 忽略 */ }
  }
  var of = window.fetch;
  if (of) {
    window.fetch = function (input, init) {
      try {
        var u = typeof input === 'string' ? input : (input && input.url);
        rec((init && init.method) || (input && input.method) || 'GET', u, init && init.body);
      } catch (e) { /* 忽略 */ }
      return of.apply(this, arguments);
    };
  }
  var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__uoocM = m; this.__uoocU = u; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    try { rec(this.__uoocM, this.__uoocU, body); } catch (e) { /* 忽略 */ }
    return os.apply(this, arguments);
  };
  return { installed: true };
}

const PAGE_INJECT = { probe: uoocPageProbe, submit: uoocPageSubmitReply, hook: uoocNetHook };

// 页面世界求值入口：content script 访问不到页面 angular/DIR_EDITORS，
// 由这里用 chrome.scripting(world:'MAIN') 在页面世界执行
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'PAGE_EVAL') return;
  if (!sender.tab || !sender.tab.id) { sendResponse({ result: { __err: '无目标标签页' } }); return; }
  const func = PAGE_INJECT[msg.fn];
  if (!func) { sendResponse({ result: { __err: '未知探针: ' + msg.fn } }); return; }
  chrome.scripting.executeScript({
    target: { tabId: sender.tab.id, allFrames: true },
    world: 'MAIN',
    func,
    args: msg.args || []
  }).then((injections) => {
    // 多 frame 时挑最有用的一份：优先含 detail/list 的结果
    const results = (injections || [])
      .map((r) => (r && 'result' in r ? r.result : null))
      .filter((r) => r && !r.__err);
    const hit = results.find((r) => (r.detail && r.detail.tid) || (r.list && r.list.length)) || results[0] || null;
    if (msg.fn === 'hook') { sendResponse({ result: { ok: true, frames: (injections || []).length } }); return; }
    if (hit) { sendResponse({ result: hit }); return; }
    const anyErr = (injections || [])
      .map((r) => (r && 'result' in r ? r.result : null))
      .find((r) => r && r.__err);
    sendResponse({ result: anyErr || null });
  }).catch((e) => sendResponse({ result: { __err: String((e && e.message) || e) } }));
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
