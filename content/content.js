'use strict';

/**
 * UOOC 助手 Pro（整合版）content script
 * 整合来源：
 *  - UOOC assistant v1.0.8（视频助手 + LLM 答题）
 *  - UOOC 助手 v41.1（全自动挂机引擎）
 *
 * 整合要点：
 *  - GM_setValue/GM_getValue -> chrome.storage.local（面板 / popup / options 三端同步）
 *  - 两套 UI 合并为一个悬浮控制台（可拖拽 / 最小化成小球 / 日志窗口）
 *  - 弹窗小题三层策略：内存嗅探 -> LLM 兜底 -> 合法组合穷举
 *  - 隐身模块（伪装可见/焦点）只在非考试页面启用，避免干扰考试页环境
 *  - 引擎状态持久化，页面刷新 / 换课自动续跑
 */

if (window.self === window.top) { // 防 iframe 多次注入，只在顶层运行

  // ==================== 0. 页面类型 ====================
  const isExamPage = () => location.pathname.includes('/exam');

  // ==================== 1. 隐身模块（仅学习页，document_start 立即生效） ====================
  // ⚠️ 有意不作用于考试页：考试页可能有切屏检测，且脚本一并不需要在那里挂机。
  if (!isExamPage()) {
    Object.defineProperty(document, 'hidden', { value: false, writable: false });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: false });
    document.hasFocus = () => true; // 焦点锁死：保障全屏打游戏不暂停

    const blockEvent = (e) => e.stopImmediatePropagation();
    document.addEventListener('visibilitychange', blockEvent, true);
    window.addEventListener('blur', blockEvent, true);
    window.addEventListener('focus', blockEvent, true);
    document.addEventListener('blur', blockEvent, true);
    // ⚠️ 不拦截 mouseout / mouseleave：layui 弹层收尾和菜单隐藏依赖它们，掐掉会让弹窗按钮点不动。

    // 🎬 任何 video 一开始加载/播放就立刻接管（装守护 + 上倍速/静音），
    //    loadstart / play 不冒泡，但捕获阶段照样会在 document 上触发。
    document.addEventListener('loadstart', onVideoActivity, true);
    document.addEventListener('play', onVideoActivity, true);
  }

  // ==================== 2. 存储：chrome.storage.local 取代 GM_* ====================
  const Store = {
    cache: {},
    ready: null,
    init() {
      this.ready = chrome.storage.local.get(null)
        .then((items) => Object.assign(this.cache, items));
      // popup / options 改动实时同步到面板
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        for (const [k, v] of Object.entries(changes)) this.cache[k] = v.newValue;
        syncPanelControls();
      });
    },
    get(k, d) { return this.cache[k] === undefined ? d : this.cache[k]; },
    set(obj) { Object.assign(this.cache, obj); return chrome.storage.local.set(obj); }
  };
  Store.init();

  // ==================== 3. 全局状态 ====================
  let engineStarted = false;      // 挂机引擎开关（点火）
  let isJumping = false;          // 正在跳转章节
  let isCoolingDown = false;      // 展开章节后的物理冷静期
  let noVideoTimer = 0;           // 无视频累计秒数（附件跳过用）
  let isExamAlarmed = false;      // 独立测验警报
  let isPopupAlarmed = false;     // 弹窗小题超时警报
  let isVerifyAlarmed = false;    // 智能验证弹窗警报
  let wasPopActive = false;       // 上一轮弹窗是否可见（检测"新一轮弹窗"）
  let lastSuccessIdx = -1;        // 目录雷达上次成功命中的索引
  let wakeLock = null;            // 屏幕常亮锁
  let endReached = false;         // 已到课程末尾（防止封顶后反复空跳）

  const QUIZ_SEL = '#quizLayer, .smallTest-view';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  console.log('[UOOC助手Pro] content script 已加载:', location.href);

  // ==================== 4. 日志（面板未创建前进缓冲区；按前缀分级上色） ====================
  const logBuf = [];

  function logClassOf(m) {
    if (/^[✅🎉🎯🔥✓]/u.test(m)) return 'log-success';
    if (/^[⚠🛑]/u.test(m)) return 'log-warning';
    if (/^[❌⛔×]/u.test(m)) return 'log-danger';
    if (/^[🔄🤖📡🗳🔁]/u.test(m)) return 'log-info';
    return '';
  }

  function appendLogLine(box, m) {
    const d = document.createElement('div');
    const cls = logClassOf(m);
    const sp = cls ? m.indexOf(' ') : -1;
    if (cls && sp > 0 && sp <= 4) {
      // 状态符号带色，正文保持浅灰
      const sym = document.createElement('span');
      sym.className = cls;
      sym.textContent = m.slice(0, sp);
      d.appendChild(sym);
      d.appendChild(document.createTextNode(m.slice(sp)));
    } else {
      d.textContent = m;
    }
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }

  function log(m) {
    const l = document.getElementById('uooc-log');
    if (l) {
      if (l.dataset.empty === '1') { l.innerHTML = ''; l.dataset.empty = '0'; }
      appendLogLine(l, m);
    } else {
      logBuf.push(m);
    }
  }
  function flushLog() {
    const l = document.getElementById('uooc-log');
    if (!l) return;
    logBuf.forEach((m) => log(m));
    logBuf.length = 0;
  }

  // ==================== 5. 视频引擎 ====================

  // 🔍 取"当前真正在播的那个" video。站点会把上一节的 video 留在 DOM 里隐藏着，
  //    直接 querySelector('video') 可能抓到 0 高度的旧元素。
  function currentVideo() {
    const list = Array.from(document.querySelectorAll('video')).filter((v) => v.offsetHeight > 10);
    if (!list.length) return null;
    if (list.length === 1) return list[0];
    // 都可见时取面积最大的那个（真播放器通常最大）
    return list.reduce((a, b) =>
      (b.offsetWidth * b.offsetHeight > a.offsetWidth * a.offsetHeight) ? b : a);
  }

  function onVideoActivity(e) {
    const t = e.target;
    if (t && t.tagName === 'VIDEO') applyVideoPrefs(t);
  }

  // 🎚️ 把倍速/静音按面板勾选按下去。只纠偏勾选了的项，不碰用户手动设置的其它项。
  function applyVideoPrefs(v) {
    if (!v) return;
    hookVideo(v);
    if (Store.get('muteOn', true) && !v.muted) v.muted = true;
    if (Store.get('rateOn', true)) {
      const rate = Number(Store.get('rateValue', 2)) || 2;
      if (Math.abs(v.playbackRate - rate) > 0.01) v.playbackRate = rate;
    }
  }

  // 🎬 给视频装上守护（拦截站点暂停指令 + 播完按"连播"跳下一节）
  function hookVideo(v) {
    if (!v || v.dataset.hook) return;
    v.dataset.hook = 'true';

    v.addEventListener('ended', () => {
      // ⚠️ 只有"当前在播的那个"才算播完。站点会把上一节的 video 留在 DOM 里后台空跑，
      //    那种 hidden 的播完不能触发跳章。
      const other = currentVideo();
      if (other && other !== v) return;
      if (Store.get('continueOn', true)) navigate('视频播完');
      else log('⏹ 视频播完（连播未勾选，不自动跳转）');
    });

    // 🚀 片源加载/开始播放的瞬间立刻把倍速和音量按到位，
    //    否则新视频开场会以 1x + 满音量播一段（要等 800ms 轮询才纠正）。
    ['loadedmetadata', 'loadeddata', 'canplay', 'play', 'playing'].forEach((ev) =>
      v.addEventListener(ev, () => applyVideoPrefs(v)));

    // 🌟 底层夺权：废掉站点的恶意暂停指令。
    //    但弹窗小题"正显示着"的时候必须放行 —— 那会儿得让站点自己的状态机说了算。
    //    ⚠️ 收尾后题层只是 display:none 还留在 DOM 里，所以必须按"是否可见"判断。
    const originalPause = v.pause;
    v.pause = function () {
      if (v.ended || popupVisible(document.querySelector(QUIZ_SEL))) return originalPause.call(v);
      const keepPlaying = engineStarted || Store.get('playOn', true);
      if (keepPlaying) {
        console.log('🛡️ 已拦截 UOOC 的恶意暂停指令');
        return;
      }
      return originalPause.call(v);
    };
    log('🚀 视频守护开启');
  }

  // 确保视频在播。引擎模式永远续播；手动模式听"播放"勾选。
  function resumeVideo() {
    const v = currentVideo();
    if (!v) return;
    hookVideo(v);
    applyVideoPrefs(v);
    const shouldPlay = engineStarted || Store.get('playOn', true);
    if (shouldPlay && v.paused && !v.ended) v.play().catch(() => {});
  }

  // 🔑 让页面"活过来"。优课的弹层 = #quizLayer（题目）+ .layui-layer-shade（全屏遮罩）。
  //    只 display:none 题目层，遮罩依旧压在最高层吃掉所有鼠标事件，
  //    这就是"小题消失了，但整页点不动"的原因。必须一起收掉遮罩和 body 滚动锁。
  // 🛡️ 但智能验证层在屏时不能回收遮罩——验证弹窗依赖遮罩交互（经验取自 xiaochai/UOOC学习助手）
  function unlockPage() {
    if (!verifyLayerVisible()) {
      document.querySelectorAll('.layui-layer-shade').forEach((el) => el.remove());
    }
    document.body.classList.remove('layui-layer-lock', 'layui-layer-nobg');
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
  }

  // 🛡️ 智能验证 / 安全验证类弹层检测（阿里云验证码，提交试卷时可能触发）。
  // 文本特征判断；排除题目层本身（弹窗小题的提交按钮也含"提交"字样）。
  function verifyLayerVisible() {
    return Array.from(document.querySelectorAll('.layui-layer')).some((el) => {
      if (el.classList.contains('layui-layer-shade')) return false;
      if (el.offsetHeight <= 10) return false;
      if (el.id === 'quizLayer' || el.classList.contains('smallTest-view')) return false;
      if (el.querySelector('.ti-q-c')) return false;
      return /验证|智能|安全|提交/.test(el.innerText || '');
    });
  }

  function closeQuizLayer(layer) {
    try {
      const ownClose = layer.querySelector('.layui-layer-close, .close');
      if (ownClose) ownClose.click(); // 优先走站点自己的关闭流程，让它的状态机一起复位
    } catch (e) { /* 忽略 */ }
    if (layer) layer.style.display = 'none';
    unlockPage();
  }

  // 🧹 孤儿遮罩清理：题目层已经没了，遮罩却还压着页面 -> 全页点击失效。每轮主循环自愈。
  function cleanOrphanShade() {
    const shade = document.querySelector('.layui-layer-shade');
    if (!shade) return;
    if (verifyLayerVisible()) return; // 🛡️ 验证层在屏时不动遮罩

    const quizLayer = document.querySelector(QUIZ_SEL);
    const quizVisible = !!quizLayer
      && quizLayer.offsetHeight > 10
      && window.getComputedStyle(quizLayer).display !== 'none';

    const otherLayerVisible = Array.from(document.querySelectorAll('.layui-layer'))
      .some((el) => !el.classList.contains('layui-layer-shade')
        && el.offsetHeight > 10
        && window.getComputedStyle(el).display !== 'none');

    if (quizVisible || otherLayerVisible) return; // 还有正经弹层开着，别动它

    unlockPage();
    log('🧹 检测到孤儿遮罩，已清理，页面恢复点击');
  }

  // ==================== 6. 弹窗小题（嗅探 -> LLM -> 穷举） ====================

  function popupVisible(el) {
    if (!el) return false;
    const st = window.getComputedStyle(el);
    return el.offsetHeight > 10 && st.display !== 'none' && st.visibility !== 'hidden';
  }

  function quizInputs(layer) {
    return Array.from(layer.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
  }

  function quizSubmitBtn(layer) {
    return layer.querySelector('button.btn-success')
      || Array.from(layer.querySelectorAll('button')).find((b) => b.innerText.includes('确'))
      || null;
  }

  // 按位掩码把选项拨到目标状态（只点需要改变的那些）
  function applyMask(inputs, mask) {
    inputs.forEach((inp, j) => {
      const want = !!(mask & (1 << j));
      if (inp.checked === want) return;
      const opt = inp.closest('label.ti-a, .ti-alist > div') || inp.closest('label') || inp.parentElement;
      if (opt) opt.click();
      if (inp.checked !== want) inp.click();
      // 🔑 优课是 AngularJS：只改 DOM 的 checked 不会同步到它的数据模型，
      //    交卷时会表现为"选了却没选"。补一发 input/change 让它认账。
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // 有些 Angular 指令绑的是 mousedown 而不是 click，光调 .click() 可能完全不触发
  function clickHard(el) {
    if (!el) return;
    const o = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.click();
  }

  // 文本归一化：把所有空白（含 &nbsp; / 全角空格）统统去掉再比。
  // 源数据题面是 HTML，textContent 与页面 innerText 的空白形态经常不一致，只 trim() 会误判"匹配不上"。
  const normText = (s) => String(s || '').replace(/[\s\u00a0\u3000]+/g, '');

  const htmlText = (html) => {
    const tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    return tmp.textContent || '';
  };

  // 🧠 主路径：答案明文写在 div[uooc-video] 的 source 属性里，直接读。
  function sniffMask(layer, inputs) {
    const fail = (why) => { layer.dataset.sniffFail = why; return null; };
    layer.dataset.sniffFail = '';
    try {
      const sourceDiv = document.querySelector('div[uooc-video]');
      if (!sourceDiv) return fail('页面上没有 div[uooc-video]');
      const sourceStr = sourceDiv.getAttribute('source');
      if (!sourceStr) return fail('div[uooc-video] 没有 source 属性');

      let source;
      try { source = JSON.parse(sourceStr); }
      catch (e) { return fail('source 不是合法 JSON'); }
      if (!source || !Array.isArray(source.quiz) || !source.quiz.length) {
        return fail('source 里没有 quiz 数组');
      }

      let qEl = layer.querySelector('.ti-q-c');
      if (!qEl) qEl = document.querySelector('.ti-q-c');
      if (!qEl) return fail('找不到 .ti-q-c');

      const domQ = normText(qEl.textContent || qEl.innerText);

      let hit = source.quiz.find((q) => {
        const s = normText(htmlText(q.question));
        return s && (s === domQ || domQ.includes(s) || s.includes(domQ));
      });
      // 兜底 1：整个题块只有一道题，直接用
      if (!hit && source.quiz.length === 1) hit = source.quiz[0];
      // 兜底 2：按顺序对齐 —— 页面第 k 个 .ti-q-c 对应 source.quiz[k]
      if (!hit) {
        const k = Array.from(document.querySelectorAll('.ti-q-c')).indexOf(qEl);
        if (k >= 0 && source.quiz[k]) hit = source.quiz[k];
      }
      if (!hit) return fail(`题面匹配不上（页面题面开头："${domQ.slice(0, 12)}"）`);

      const raw = Array.isArray(hit.answer) ? hit.answer.join('') : String(hit.answer);
      const letters = raw.match(/[A-Z]/g) || [];
      if (!letters.length) {
        return fail(`答案字段里没有字母（原值："${String(hit.answer).slice(0, 20)}"）`);
      }

      // 字母 -> 选项：优先认选项自带的 "A." 前缀标签，认不出再退回位置索引
      const opts = Array.from(layer.querySelectorAll('.ti-alist > div, label.ti-a'));
      let mask = 0;
      for (const L of letters) {
        let opt = opts.find((o) => new RegExp('^\\s*' + L + '\\s*[.、,，:：]').test(o.innerText.trim()));
        if (!opt) opt = opts[L.charCodeAt(0) - 65];
        if (!opt) continue;
        const inp = opt.querySelector('input[type="radio"], input[type="checkbox"]');
        const idx = inputs.indexOf(inp);
        if (idx >= 0) mask |= (1 << idx);
      }
      return mask
        ? { mask, letters: letters.join('') }
        : fail(`答案 ${letters.join('')} 映射不到任何选项（题层里 ${opts.length} 个候选项）`);
    } catch (e) {
      console.error(e);
      return fail('嗅探抛异常，见控制台');
    }
  }

  // 🤖 第二层：嗅探失败且 LLM 已启用时，把题面发给大模型要一个字母答案（单次采样）
  async function llmPopupOnce(layer, inputs) {
    const qEl = layer.querySelector('.ti-q-c');
    const opts = Array.from(layer.querySelectorAll('.ti-alist > div, label.ti-a'));
    if (!qEl || !opts.length) return null;

    let prompt = '请回答以下选择题，只返回答案选项字母（多选如 AB），不要任何解释。\n\n';
    prompt += `题目：${qEl.innerText.trim()}\n`;
    opts.forEach((o, i) => {
      const t = o.innerText.trim().replace(/^[A-H]\s*[.、,，:：]\s*/, '');
      prompt += `${String.fromCharCode(65 + i)}. ${t}\n`;
    });

    const res = await llmChat([{ role: 'user', content: prompt }], 0.3);
    if (!res || !res.ok) return null;
    const text = (res.data && res.data.choices && res.data.choices[0] &&
      res.data.choices[0].message && res.data.choices[0].message.content) || '';
    const letters = [...new Set(text.match(/[A-H]/g) || [])].slice(0, inputs.length);
    if (!letters.length) return null;

    let mask = 0;
    for (const L of letters) {
      const inp = inputs[L.charCodeAt(0) - 65];
      if (inp) mask |= (1 << inputs.indexOf(inp));
    }
    return mask ? { mask, letters: letters.join('') } : null;
  }

  // 🗳️ 采样投票：并行问 3 次，取多数；票数并列时补问 2 次再投，仍并列则放弃。
  // （借鉴 fastuooc 的 self-consistency 方案，显著降低单次幻觉答错率）
  async function llmPopupMaskVote(layer, inputs) {
    const c = Store.get('llmConfig', null);
    if (!Store.get('llmEnabled', false) || !c || !c.baseUrl || !c.apiKey) return null;

    const ask = () => llmPopupOnce(layer, inputs).catch(() => null);
    const first = await Promise.all([ask(), ask(), ask()]);
    let pick = majorityVote(first);
    if (pick.tied) {
      const extra = await Promise.all([ask(), ask()]);
      pick = majorityVote(first.concat(extra));
    }
    if (pick.tied) {
      if (first.every((r) => r === null)) log('🤖 LLM 采样全部失败，请检查 API 配置（设置页可测试连接）');
      return null;
    }
    log(`🗳️ LLM 投票：${pick.letters}（${pick.votes}/${pick.total} 票）`);
    return pick;
  }

  function majorityVote(results) {
    const valid = results.filter(Boolean);
    if (!valid.length) return { tied: true };
    const groups = new Map();
    for (const r of valid) {
      const key = r.letters.split('').sort().join('');
      if (!groups.has(key)) groups.set(key, { key, count: 0, rep: r });
      groups.get(key).count++;
    }
    let best = null;
    for (const g of groups.values()) {
      if (!best || g.count > best.count) best = g;
    }
    const tops = [...groups.values()].filter((g) => g.count === best.count);
    if (tops.length !== 1) return { tied: true };
    return { tied: false, mask: best.rep.mask, letters: best.rep.letters, votes: best.count, total: valid.length };
  }

  // 🚦 单选组一次只能点一个 —— 多 bit 掩码对 radio 根本点不出来，这类组合纯属浪费。
  function maskAchievable(inputs, mask) {
    const seen = new Set();
    for (let j = 0; j < inputs.length; j++) {
      if (!(mask & (1 << j))) continue;
      const inp = inputs[j];
      if (inp.type !== 'radio') continue;
      const key = inp.name || `__r${j}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  }

  // 🧭 当前小节的指纹：用来区分"题被答掉了"和"页面整个跳走了"
  function sectionKey() {
    const n = document.querySelector('.oneline.active, .basic.active');
    return n ? n.innerText.trim().slice(0, 24) : '';
  }

  // 🩺 交卷失败时把现场打出来，日志里直接定位原因
  function quizDiagnose(layer) {
    const btn = quizSubmitBtn(layer);
    const n = quizInputs(layer).length;
    const checked = layer.querySelectorAll('input:checked').length;
    const toast = Array.from(document.querySelectorAll('.layui-layer-content'))
      .map((e) => (e.innerText || '').trim()).filter(Boolean).join(' | ').slice(0, 60);
    log(`🧪 输入框 ${n} 个 / 已勾选 ${checked} 个 / 按钮 ${btn ? `class="${btn.className}" disabled=${btn.disabled}` : '未找到'}`);
    if (btn) log(`🧪 按钮HTML: ${btn.outerHTML.slice(0, 90)}`);
    if (toast) log(`🧪 站点提示: ${toast}`);
  }

  // 题目块的文本指纹。优课的弹窗小测答完之后不会消失（长在视频下方），只贴判分结果，
  // 所以"弹窗是否消失"是永远不成立的判据，真正信号是——题目块的文本变了。
  function layerText(layer) {
    return (layer.innerText || '').replace(/\s+/g, '');
  }

  function verdict(text) {
    if (/回答错误|答案错误|答错了|答错|不正确/.test(text)) return '（站点判为答错）';
    if (/回答正确|答案正确|答对了|答对/.test(text)) return '（站点判为答对）';
    return '';
  }

  // 🧹 收尾：把题层和 layui 遮罩一起收掉，并恢复播放（等价于面板上的急救键）
  function finishPopupQuiz(layer) {
    unlockPage();
    if (layer) {
      layer.style.display = 'none';
      layer.dataset.triedMask = '0';
      layer.dataset.ghostSince = '';
    }
    isPopupAlarmed = false;
    resumeVideo();
  }

  // 🎯 主入口（弹窗小题）：嗅探 → LLM 采样投票 → 穷举兜底。
  // 弹窗小题分值低、站点即时判分，穷举的代价可接受（v2.2 恢复，仅限弹窗；
  // 考试/章节测验不走盲穷举，见闯关流水线的「只爆破错题」）。
  async function handlePopupQuiz(layer) {
    if (!layer || layer.dataset.busy === '1') return;

    const inputs = quizInputs(layer);
    if (!inputs.length || !quizSubmitBtn(layer)) return; // 还没渲染完，或只是空壳

    const tried = Number(layer.dataset.triedMask || 0);
    const qSig = (layer.querySelector('.ti-q-c')?.innerText || '').trim();
    const sec0 = sectionKey();
    const total = (1 << inputs.length) - 1;
    const MAX_TRY = 24;

    // 候选顺序：嗅探命中只交它自己（站点自己的答案，多交反而可能覆盖）；
    // 否则 LLM 投票答案打头，后面跟穷举组合兜底。
    const order = [];
    let firstLabel = null;
    const sniff = sniffMask(layer, inputs);
    if (sniff) {
      order.push(sniff.mask);
      firstLabel = `🎯 内存嗅探命中 ${sniff.letters}`;
    } else {
      const c = Store.get('llmConfig', null);
      if (Store.get('llmEnabled', false) && c && c.baseUrl && c.apiKey) {
        log(`⚠️ 嗅探未命中（${layer.dataset.sniffFail || '未知原因'}），LLM 采样投票中...`);
        const llm = await llmPopupMaskVote(layer, inputs).catch(() => null);
        if (llm) {
          order.push(llm.mask);
          firstLabel = `🗳️ LLM投票 ${llm.letters}`;
        }
      }
      // 穷举兜底：跳过已试过的组合和单选点不出来的多 bit 组合
      for (let m = 1; m <= total && order.length < MAX_TRY + 1; m++) {
        if ((tried & m) || !maskAchievable(inputs, m) || order.includes(m)) continue;
        order.push(m);
      }
    }
    if (!order.length) return;

    layer.dataset.busy = '1';
    let accepted = false;
    try {
      for (const mask of order) {
        if (!popupVisible(document.querySelector(QUIZ_SEL))) break;
        const cur = quizInputs(layer);
        if (cur.length !== inputs.length) break;                      // 结构变了，交给主循环重来
        if ((layer.querySelector('.ti-q-c')?.innerText || '').trim() !== qSig) break; // 换题了

        // ⚠️ 每轮都重新取按钮：站点可能在提交后重新渲染整个题目块，旧引用会变成废节点
        const btn = quizSubmitBtn(layer);
        if (!btn) break;

        if (firstLabel) {
          log(firstLabel + '，提交…');
          firstLabel = null;
        } else {
          log(`🔨 穷举组合 ${mask.toString(2).padStart(inputs.length, '0')}`);
        }

        const before = layerText(layer);
        applyMask(cur, mask);
        layer.dataset.triedMask = String(Number(layer.dataset.triedMask || 0) | mask);
        await wait(200);
        clickHard(btn);
        await wait(1200);

        if (!popupVisible(document.querySelector(QUIZ_SEL))) {
          // 弹窗真没了也可能是"页面整体跳走了"，那不是我们答对的
          if (sectionKey() !== sec0) log('↩️ 弹窗消失但页面已跳转，不计为作答成功');
          else log('✅ 弹窗已关闭，作答成功');
          accepted = true;
          break;
        }

        // 🎯 题目块内容变了 = 站点已受理这次交卷
        const after = layerText(layer);
        if (after !== before) {
          log(`🎯 交卷已受理${verdict(after)}`);
          accepted = true;
          break;
        }
        // 内容没变 = 这次点击没被受理，换下一个候选再试
      }

      if (!accepted) {
        log('⚠️ 候选穷尽仍未被受理，收尾并提醒人工（诊断如下）');
        quizDiagnose(layer);
        speak('弹窗小题请手动处理');
      }
    } catch (e) {
      console.error(e);
    } finally {
      finishPopupQuiz(layer); // 🧹 弹窗小题无论结果都收尾，不阻塞引擎
      layer.dataset.busy = '0';
    }
  }

  // ==================== 7. 章节导航（连播） ====================

  function strike(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    ['mousedown', 'mouseup', 'click'].forEach((t) => {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
  }

  async function navigate(reason = '视频结束') {
    if (isJumping || isCoolingDown) return;
    isJumping = true;
    log(`🎬 [${reason}] 正在定位下一任务...`);

    const dirTab = Array.from(document.querySelectorAll('span, li, div'))
      .find((e) => e.innerText.trim() === '目录' && e.offsetHeight > 0);
    if (dirTab && !dirTab.classList.contains('active')) strike(dirTab);
    await wait(600);

    const radar = Array.from(document.querySelectorAll('.basic, .catalog-item, div[ng-click*="goSource"]'))
      .filter((el) => {
        const t = el.innerText.trim();
        if (el.offsetHeight === 0 || !t || ['目录', '笔记', '提问', '返回'].includes(t)) return false;
        // 只要出现在侧边栏列表中就视为合法目标：未展开的文件夹点一下总能展开
        return true;
      });

    let curIdx = -1;
    for (let i = radar.length - 1; i >= 0; i--) {
      if (radar[i].classList.contains('active') || radar[i].querySelector('.active') || radar[i].querySelector('.oneline.active')) {
        curIdx = i; break;
      }
    }

    if (curIdx > lastSuccessIdx) lastSuccessIdx = curIdx;
    const baseIdx = curIdx !== -1 ? curIdx : lastSuccessIdx;
    const target = radar[baseIdx + 1];

    if (target) {
      const targetText = target.innerText.trim().substring(0, 12).replace(/\n/g, '');
      log(`🎯 目标锁定：${targetText}`);
      strike(target);
      lastSuccessIdx = baseIdx + 1;

      if (targetText.includes('第') || target.nextElementSibling?.tagName === 'UL') {
        log('📂 开启章节大门，进入 3.5秒 冷静期...');
        isCoolingDown = true;
        noVideoTimer = 0;
        setTimeout(() => {
          isCoolingDown = false;
          log('🚦 冷静期结束，开始入室检查！');
        }, 3500);
      }
    } else {
      endReached = true;
      log('🎉 进度封顶，本页任务全部刷完！');
      speak('所有课程已刷完');
    }

    setTimeout(() => { isJumping = false; }, 3000);
  }

  // ==================== 8. 音频心跳 / 语音 / 引擎点火 ====================

  let audioCtx = null;
  function ensureHeartbeat() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      gain.gain.value = 0.001; // 人耳听不见的音量，防后台降频
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
    } catch (e) {
      console.log('[UOOC助手Pro] 音频心跳创建失败', e);
    }
  }

  // 原生合成"叮"提示音
  function playDing() {
    try {
      if (!audioCtx) ensureHeartbeat();
      if (!audioCtx) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const dingOsc = audioCtx.createOscillator();
      const dingGain = audioCtx.createGain();
      dingOsc.type = 'sine';
      dingOsc.frequency.setValueAtTime(900, audioCtx.currentTime);
      dingGain.gain.setValueAtTime(0, audioCtx.currentTime);
      dingGain.gain.linearRampToValueAtTime(0.5, audioCtx.currentTime + 0.02);
      dingGain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
      dingOsc.connect(dingGain);
      dingGain.connect(audioCtx.destination);
      dingOsc.start(audioCtx.currentTime);
      dingOsc.stop(audioCtx.currentTime + 0.5);
    } catch (e) { /* 忽略 */ }
  }

  function speak(text) {
    if (!engineStarted) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 2.5;
      window.speechSynthesis.speak(u);
    } catch (e) { /* 忽略 */ }
  }

  async function startEngine(auto = false) {
    if (engineStarted) return;
    endReached = false;
    // ⚠️ 自动续跑路径没有用户手势：此时创建/恢复 AudioContext 会触发
    // Chrome 自动播放策略警告（扩展错误页里的 "AudioContext was not allowed to start"）。
    // 心跳只在手动点火（有真实点击手势）时启动；自动续跑的防降频由伪装可见性兜底。
    if (!auto) ensureHeartbeat();

    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        log('🌞 屏幕常亮锁已激活');
      }
    } catch (e) {
      log('⚠️ 常亮锁申请失败，请保持浏览器前台');
    }

    engineStarted = true;
    Store.set({ engineRunning: true });
    updateEngineBtn();
    log('🔥 引擎全开！支持全屏打游戏挂机。');
    if (auto) log('🔁 已自动续跑上次的挂机状态');
    else playDing();

    resumeVideo();
    scheduleAutoCollapse(); // 启动 1.5s 后自动收起为胶囊（用户展开过则不收）
  }

  function stopEngine() {
    if (!engineStarted) return;
    engineStarted = false;
    Store.set({ engineRunning: false });
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    updateEngineBtn();
    log('⏹ 引擎已停止');
  }

  function updateEngineBtn() {
    const b = document.getElementById('uooc-start-btn');
    if (b) {
      b.className = engineStarted ? 'running' : '';
      b.innerHTML = (engineStarted ? ICONS.stop : ICONS.play)
        + '<span>' + (engineStarted ? '停止挂机' : '启动挂机') + '</span>';
    }
    const dot = document.getElementById('uooc-header-dot');
    if (dot) dot.classList.toggle('on', engineStarted);
    const st = document.getElementById('uooc-engine-state-text');
    if (st) {
      st.textContent = engineStarted ? '运行中' : '未启动';
      st.classList.toggle('on', engineStarted);
    }
    const ball = document.getElementById('uooc-min-ball');
    if (ball) ball.classList.toggle('running', engineStarted);
  }

  // ==================== 9. LLM 模块 ====================

  // 统一经 background 发请求（绕开页面 CSP/CORS，Key 不进页面）
  async function llmChat(messages, temperature = 0.3) {
    try {
      return await chrome.runtime.sendMessage({ type: 'LLM_CHAT', payload: { messages, temperature } });
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function openLLMSettings() {
    window.open(chrome.runtime.getURL('options/options.html'));
  }

  // ---- 考试/测评页答题（取自 UOOC assistant）----

  // 获取测评页面的 document（可能是 iframe）
  function getQuizDocument() {
    const mainDocContainers = document.querySelectorAll('.queContainer');
    if (mainDocContainers.length > 0) {
      console.log('[UOOC助手-AI] 在主文档中找到题目');
      return document;
    }
    const iframe = document.querySelector('iframe');
    if (iframe) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        const iframeContainers = iframeDoc.querySelectorAll('.queContainer');
        if (iframeContainers.length > 0) {
          console.log('[UOOC助手-AI] 在iframe中找到题目');
          return iframeDoc;
        }
      } catch (e) {
        console.log('[UOOC助手-AI] 无法访问iframe:', e.message);
      }
    }
    return null;
  }

  function extractQuestions() {
    const quizDoc = getQuizDocument();
    if (!quizDoc) {
      console.log('[UOOC助手-AI] 未找到测评页面document');
      return [];
    }
    const containers = quizDoc.querySelectorAll('.queContainer');
    if (containers.length === 0) return [];

    const questions = [];
    containers.forEach((container, index) => {
      const typeElem = container.querySelector('input[type="radio"], input[type="checkbox"]');
      if (!typeElem) return;

      const isRadio = typeElem.type === 'radio';
      const questionText = container.querySelector('.ti-q-c')?.innerText.trim() || '';
      const options = [];

      container.querySelectorAll('.ti-a').forEach((optElem) => {
        const optionLabel = optElem.querySelector('.ti-a-i')?.innerText.trim() || '';
        const optionText = optElem.querySelector('.ti-a-c')?.innerText.trim() || '';
        const inputElem = optElem.querySelector('input');
        options.push({
          label: optionLabel,
          text: optionText,
          value: inputElem?.value || '',
          input: inputElem
        });
      });

      let questionType = '判断题';
      if (options.length > 2) questionType = isRadio ? '单选题' : '多选题';
      else if (options.length === 2) questionType = '判断题';

      questions.push({
        index: index + 1,
        type: questionType,
        question: questionText,
        options: options,
        isRadio: isRadio,
        el: container
      });
    });
    console.log('[UOOC助手-AI] 提取到', questions.length, '道题目');
    return questions;
  }

  function buildPrompt(questions) {
    let prompt = '请回答以下选择题，每题直接给出答案选项字母（如A、B、C、D或A、B等），不需要解释。\n\n';
    questions.forEach((q) => {
      prompt += `第${q.index}题 [${q.type}]\n`;
      prompt += `题目：${q.question}\n`;
      q.options.forEach((opt) => { prompt += `${opt.label}. ${opt.text}\n`; });
      prompt += '\n';
    });
    prompt += '\n请按以下格式返回答案（每行一个题号和答案）：\n';
    prompt += '1. A\n2. B\n3. A,B\n...\n';
    prompt += '注意：多选题答案用逗号分隔，判断题A表示正确，B表示错误。';
    return prompt;
  }

  function parseAnswers(llmResponse, questions) {
    const answers = [];
    const lines = llmResponse.split('\n');

    lines.forEach((line) => {
      const match = line.trim().match(/^(\d+)\.\s*([A-Z,]+)$/);
      if (match) {
        const qIndex = parseInt(match[1]) - 1;
        const answer = match[2].toUpperCase().split(',').map((a) => a.trim());
        answers[qIndex] = answer;
      }
    });

    // 如果解析数量不匹配，尝试其他格式
    if (answers.filter((a) => a).length < questions.length) {
      const allAnswers = llmResponse.match(/\d+\.[\s]*[A-Z]+/g);
      if (allAnswers) {
        allAnswers.forEach((ans, idx) => {
          const match = ans.match(/\d+\.[\s]*([A-Z,]+)/);
          if (match) {
            const answer = match[1].toUpperCase().split(',').map((a) => a.trim());
            answers[idx] = answer;
          }
        });
      }
    }
    return answers;
  }

  async function callLLMExam(questions) {
    const c = Store.get('llmConfig', null);
    if (!c || !c.baseUrl || !c.apiKey) {
      openLLMSettings();
      return null;
    }

    log('📡 正在调用 LLM（3 路采样投票）...');
    const prompt = buildPrompt(questions);
    const answers = await llmVoteAnswers(prompt, questions.length, 0.3, '整卷');
    if (answers === null) {
      alert('AI答题失败：3 路采样全部失败。\n请检查API配置是否正确（设置页可测试连接）。');
      return null;
    }
    const agreed = answers.filter(Boolean).length;
    log(`🗳️ 投票完成：${agreed}/${questions.length} 题达成多数一致`);
    return answers;
  }

  // 🗳️ 通用采样投票：并行问 3 次取多数，票数并列补问 2 轮，仍并列取票数最高候选（先到者胜）。
  // 返回长度为 count 的答案数组（按题号-1 对齐），全部采样失败返回 null。
  async function llmVoteAnswers(prompt, count, temperature = 0.3, tag = '') {
    const ask = async () => {
      const res = await llmChat([
        { role: 'system', content: '你是一个专业的答题助手，请严格按照要求的格式返回答案。' },
        { role: 'user', content: prompt }
      ], temperature);
      if (!res || !res.ok) {
        console.log('[UOOC助手-AI] 采样失败:', res && (res.error || res.status));
        return null;
      }
      return (res.data && res.data.choices && res.data.choices[0] &&
        res.data.choices[0].message && res.data.choices[0].message.content) || '';
    };

    const shim = { length: count }; // parseAnswers 只用到 length
    let parsed = (await Promise.all([ask(), ask(), ask()]))
      .map((t) => (t ? parseAnswers(t, shim) : null));
    if (parsed.every((p) => !p)) return null;

    let votes = voteExamAnswers(parsed, count);
    if (votes.some((v) => v && v.tied)) {
      log(`🗳️ ${tag}部分题目票数并列，补问 2 轮后按多数决...`);
      parsed = parsed.concat((await Promise.all([ask(), ask()]))
        .map((t) => (t ? parseAnswers(t, shim) : null)));
      votes = voteExamAnswers(parsed, count);
    }
    return votes.map((v) => (v ? v.answer : null));
  }

  // 对每道题的多次作答结果投票。返回每题 {answer, tied}；无人作答的题为 null。
  function voteExamAnswers(parsedArr, count) {
    return Array.from({ length: count }, (_, qi) => {
      const groups = new Map();
      for (const p of parsedArr) {
        const ans = p && p[qi];
        if (!ans || !ans.length) continue;
        const key = ans.map((s) => s.toUpperCase()).sort().join(',');
        if (!groups.has(key)) groups.set(key, { key, count: 0, answer: ans });
        groups.get(key).count++;
      }
      if (!groups.size) return null;
      let best = null;
      for (const g of groups.values()) {
        if (!best || g.count > best.count) best = g;
      }
      const tied = [...groups.values()].filter((g) => g.count === best.count).length > 1;
      return { answer: best.answer, tied };
    });
  }

  function fillAnswers(questions, answers) {
    let filledCount = 0;
    questions.forEach((q, idx) => {
      const answer = answers[idx];
      if (!answer) {
        console.log(`[UOOC助手-AI] 第${q.index}题：未找到答案`);
        return;
      }
      answer.forEach((ans) => {
        // 优先按 input 的 value 匹配，认不出再按选项标签（A/B/C…）匹配
        let option = q.options.find((opt) => opt.value === ans);
        if (!option) option = q.options.find((opt) => (opt.label || '').toUpperCase() === ans);
        if (option && option.input && !option.input.checked) {
          option.input.click();
          // AngularJS 数据模型同步
          option.input.dispatchEvent(new Event('input', { bubbles: true }));
          option.input.dispatchEvent(new Event('change', { bubbles: true }));
          filledCount++;
          console.log(`[UOOC助手-AI] 第${q.index}题：选择 ${ans}`);
        }
      });
    });
    console.log('[UOOC助手-AI] 共填入', filledCount, '个答案');
    return filledCount;
  }

  async function autoAnswerQuiz() {
    const c = Store.get('llmConfig', null);
    if (!c || !c.baseUrl || !c.apiKey) {
      openLLMSettings();
      return;
    }

    // 学习页内的章节测验（闯关）且开启闯关模式 → 完整流水线：自动交卷→重做错题→只爆破错题。
    // /exam/ 考试页永不自动交卷、不穷举，只填答案留人工提交。
    if (!isExamPage() && Store.get('gateOn', true)) {
      return runGatePipeline();
    }

    const questions = extractQuestions();
    if (questions.length === 0) {
      alert('未找到题目（.queContainer）。\n请确认当前页面是测评/考试页面，且试卷已加载完成。');
      return;
    }

    log(`🤖 检测到 ${questions.length} 道题目，开始AI答题...`);
    const answers = await callLLMExam(questions);
    if (!answers) return;

    const filledCount = fillAnswers(questions, answers);

    setTimeout(() => {
      alert(`✅ AI答题完成！\n\n已自动填入 ${filledCount} 个答案。\n\n请仔细检查答案后，手动点击"提交试卷"按钮。`);
    }, 500);
  }

  // ==================== 9.5 闯关流水线（学习页章节测验）：交卷 → 重做错题 → 只爆破错题 ====================
  // 思路取自 fuckuooc 的闯关模式三级策略：
  //   LLM 投票作答 → 交卷 → 读每题判分 → 只重做错题（换提示+升温重采样）→ 仍不过 →
  //   锁定已对的题，只对错题穷举候选（每次提交后按判分反馈锁定，对的题永不动）。
  // 已对的题保持原答案，因此爆破不会把分数越刷越低——只会把 0 分题往对了改。

  // 在试卷文档里找交卷按钮（排除"保存试卷"草稿按钮）
  function findSubmitBtn() {
    const d = getQuizDocument() || document;
    const nodes = d.querySelectorAll('button, a.btn, input[type="button"], .exam-btn');
    for (const el of nodes) {
      const t = (el.innerText || el.value || '').trim();
      if (!t || el.offsetHeight <= 0) continue;
      if (t.includes('保存')) continue;
      if (/提交|交卷/.test(t)) return el;
    }
    return null;
  }

  // layui 确认框（"确定提交吗"之类）出现时点它的主按钮
  async function handleConfirmDialog() {
    const dlg = Array.from(document.querySelectorAll('.layui-layer')).find((el) => {
      if (el.classList.contains('layui-layer-shade') || el.offsetHeight <= 10) return false;
      if (el.id === 'quizLayer' || el.querySelector('.ti-q-c')) return false;
      return !!el.querySelector('.layui-layer-btn');
    });
    if (!dlg) return false;
    const btn = dlg.querySelector('.layui-layer-btn .layui-layer-btn0')
      || dlg.querySelector('.layui-layer-btn a, .layui-layer-btn button');
    if (btn) { btn.click(); return true; }
    return false;
  }

  // 交卷一次：点提交 → 处理确认框 → 检查智能验证。返回 'ok' | 'verify' | 'nosubmit'
  async function submitPaper() {
    const btn = findSubmitBtn();
    if (!btn) return 'nosubmit';
    clickHard(btn);
    await wait(900);
    if (await handleConfirmDialog()) await wait(1200);
    if (verifyLayerVisible()) {
      log('🛡️ 交卷触发智能验证，请手动完成验证后重试');
      speak('请完成验证');
      return 'verify';
    }
    await wait(800);
    return 'ok';
  }

  // 读单题判分：红标=错；得分==满分=对；文本判对错；读不到=未知(null)
  function readQuestionResult(container) {
    const scores = container.querySelector('.scores');
    if (!scores) return null;
    const txt = scores.innerText || '';
    if (scores.querySelector('.color-red')) return false;
    if (/回答正确|答案正确|答对了|答对|正确/.test(txt)) return true;
    if (/回答错误|答案错误|答错了|答错|不正确|错误/.test(txt)) return false;
    const m = txt.match(/\d+\.?\d+/g);
    if (m && m.length >= 2) return parseFloat(m[0]) === parseFloat(m[1]);
    return null;
  }

  // 评估整卷：每题对错 + 站点失败弹窗
  function assessPaper() {
    const fresh = extractQuestions();
    let right = 0, wrong = 0, unknown = 0;
    const wrongQs = [];
    for (const q of fresh) {
      const r = readQuestionResult(q.el);
      if (r === true) right++;
      else if (r === false) { wrong++; wrongQs.push(q); }
      else unknown++;
    }
    const dlgText = Array.from(document.querySelectorAll('.layui-layer'))
      .filter((el) => !el.classList.contains('layui-layer-shade') && el.offsetHeight > 10)
      .map((el) => el.innerText || '').join(' ');
    const failDialog = /请重新提交|重新提交测验|未通过|不及格|回答错误/.test(dlgText);
    return {
      pass: right > 0 && wrong === 0 && unknown === 0 && !failDialog,
      failDialog, wrongQs, right, wrong, unknown, total: fresh.length
    };
  }

  // DOM 可能被站点重渲染，按题号重新收集题目
  function collectQuestionByIndex(index) {
    return extractQuestions().find((q) => q.index === index) || null;
  }

  // 清掉一道多选题的已勾选项（radio 由下一次选择自然顶掉，无需清）
  function clearQuestionSelections(q) {
    q.options.forEach((opt) => {
      const inp = opt.input;
      if (inp && inp.checked && inp.type === 'checkbox') {
        (inp.closest('label') || inp.parentElement || inp).click();
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }

  function buildRetryPrompt(wrongQs, prevByIndex) {
    let prompt = '下面这些选择题之前的答案被判定为错误，请重新作答，给出的答案不要与之前的相同。\n';
    prompt += '每题直接给出答案选项字母，多选题用逗号分隔，不要解释。\n\n';
    wrongQs.forEach((q) => {
      const prev = (prevByIndex[q.index] || []).join('、') || '未知';
      prompt += `第${q.index}题 [${q.type}]（之前的错误答案：${prev}）\n`;
      prompt += `题目：${q.question}\n`;
      q.options.forEach((o) => { prompt += `${o.label}. ${o.text}\n`; });
      prompt += '\n';
    });
    prompt += '请按格式返回：\n1. A\n2. B,C\n...';
    return prompt;
  }

  // 重做错题：换提示 + 提高温度重采样，只改错题，已对的题不动
  async function redoWrongQuestions(wrongQs, prevByIndex) {
    const maxIndex = Math.max(...wrongQs.map((q) => q.index));
    const prompt = buildRetryPrompt(wrongQs, prevByIndex);
    const answers = await llmVoteAnswers(prompt, maxIndex, 0.5, '重做');
    if (!answers) {
      log('❌ LLM 重做采样全部失败，请检查 API 配置');
      return false;
    }
    let applied = 0;
    for (const q of wrongQs) {
      const ans = answers[q.index - 1];
      if (!ans || !ans.length) continue;
      const fresh = collectQuestionByIndex(q.index);
      if (!fresh) continue;
      clearQuestionSelections(fresh);
      fillAnswers([fresh], [ans]);
      applied++;
      log(`🔁 第${q.index}题改答 ${ans.join(',')}`);
    }
    return applied > 0;
  }

  // 多选题候选组合顺序：子集大小 2→3→…→n，最后才是单元素（多选答案通常≥2个）
  function multiCombos(n) {
    const out = [];
    for (let size = 2; size <= n; size++) {
      const rec = (start, cur) => {
        if (cur.length === size) { out.push(cur.slice()); return; }
        for (let i = start; i < n; i++) { cur.push(i); rec(i + 1, cur); cur.pop(); }
      };
      rec(0, []);
    }
    for (let i = 0; i < n; i++) out.push([i]);
    return out;
  }

  function lettersToIndices(q, letters) {
    const idx = [];
    (letters || []).forEach((L) => {
      let opt = q.options.find((o) => o.value === L)
        || q.options.find((o) => (o.label || '').toUpperCase() === String(L).toUpperCase());
      if (!opt) opt = q.options[String(L).charCodeAt(0) - 65];
      const i = opt ? q.options.indexOf(opt) : -1;
      if (i >= 0) idx.push(i);
    });
    return idx;
  }

  function maskFromIndices(indices) {
    let mask = 0;
    indices.forEach((i) => { mask |= (1 << i); });
    return mask;
  }

  // 🔨 只爆破错题：对的题锁死不动，逐道错题穷举候选，每次提交后按判分锁定正确组合。
  // 返回整卷是否全部答对。
  async function bruteWrongQuestions(initialWrong) {
    const MAX_SUBMITS = 60;
    let submits = 0;
    const wrong = initialWrong.slice();

    while (wrong.length && submits < MAX_SUBMITS) {
      const q = wrong.shift();
      let solved = false;
      const fresh0 = collectQuestionByIndex(q.index);
      if (!fresh0) continue;
      const n = fresh0.options.length;
      const combos = fresh0.isRadio
        ? Array.from({ length: n }, (_, i) => [i])
        : multiCombos(n);
      const prevIdx = lettersToIndices(q, q.prevAnswer);

      for (const combo of combos) {
        if (submits >= MAX_SUBMITS) { log('⛔ 爆破提交次数达到上限，停止'); break; }
        if (verifyLayerVisible()) {
          log('🛡️ 触发智能验证，停止爆破，请手动处理');
          speak('请完成验证');
          return false;
        }
        // 跳过已判错的组合
        if (combo.length === prevIdx.length && combo.every((v, i) => v === prevIdx[i])) continue;

        const cur = collectQuestionByIndex(q.index);
        if (!cur) break;
        const curInputs = cur.options.map((o) => o.input);
        applyMask(curInputs, maskFromIndices(combo));
        await wait(250);

        const how = await submitPaper();
        if (how === 'nosubmit') { log('❌ 找不到交卷按钮，停止爆破'); return false; }
        if (how === 'verify') return false;
        submits++;
        await wait(600);

        const after = collectQuestionByIndex(q.index);
        const r = after ? readQuestionResult(after.el) : null;
        if (r === true) {
          const ls = combo.map((i) => (cur.options[i] ? (cur.options[i].label || String.fromCharCode(65 + i)) : String.fromCharCode(65 + i))).join(',');
          log(`🔨 第${q.index}题爆破成功（${ls}），已锁定`);
          solved = true;
          const st = assessPaper();
          if (st.pass) return true;
          break;
        }
        if (r === null) {
          log(`⚠️ 第${q.index}题读不到判分反馈，无法继续爆破（可能该卷不显示单题得分），请人工处理`);
          solved = null;
          break;
        }
        // r === false → 换下一个组合
      }
      if (solved === false) log(`❌ 第${q.index}题穷尽候选仍未答对，跳过`);
    }

    const fin = assessPaper();
    log(`🧮 爆破结束：共提交 ${submits} 次，当前对 ${fin.right} / 错 ${fin.wrong} / 未知 ${fin.unknown}`);
    return fin.pass;
  }

  // 🚧 主流程：LLM投票作答 → 自动交卷 → 未通过则 LLM 只重做错题 → 仍不过 → 只爆破错题
  async function runGatePipeline() {
    // ⚡ 接口直答前置尝试：getTaskPaper/commit 直答（任何失败自动回退页面流程）
    if (Store.get('apiDirectOn', true)) {
      try {
        const api = await apiExamSolve();
        if (api) {
          log(`⚡ 接口直答完成：确认 ${api.right}/${api.total} 题，提交 ${api.commits} 次，刷新页面同步状态...`);
          speak('接口直答完成');
          setTimeout(() => location.reload(), 1500);
          return;
        }
        log('↩️ 接口直答不可用，回退页面答题流程');
      } catch (e) {
        log('↩️ 接口直答异常（' + (e.message || e) + '），回退页面答题流程');
      }
    }

    const questions = extractQuestions();
    if (!questions.length) {
      alert('未找到题目（.queContainer）。\n请确认当前是章节测验页面，且试卷已加载完成。');
      return;
    }

    log(`🚧 闯关模式启动：共 ${questions.length} 题，LLM 投票作答中...`);
    const firstAnswers = await callLLMExam(questions);
    if (!firstAnswers) return;
    fillAnswers(questions, firstAnswers);
    const prevByIndex = {};
    questions.forEach((q, i) => { prevByIndex[q.index] = firstAnswers[i] || []; });

    // 第一次交卷
    log('📮 自动交卷...');
    let how = await submitPaper();
    if (how === 'nosubmit') {
      log('❌ 未找到交卷按钮，请手动提交；未通过时可再点「开始答题」进入重做/爆破流程');
      setTimeout(() => alert('未找到"提交试卷"按钮，请手动提交。'), 400);
      return;
    }
    if (how === 'verify') return;

    for (let round = 1; round <= 2; round++) {
      await wait(1200);
      const st = assessPaper();

      if (st.pass) {
        log('🎉 闯关成功（LLM 路径）！');
        speak('闯关成功');
        return;
      }
      if (!st.wrongQs.length) {
        if (st.unknown === st.total && !st.failDialog) {
          log('⚠️ 读不到判分反馈，可能未真正交卷（或该卷不显示单题得分），请人工确认');
          return;
        }
        log('🎉 闯关成功（LLM 路径）！');
        speak('闯关成功');
        return;
      }
      log(`📊 提交结果：对 ${st.right} / 错 ${st.wrong} / 未知 ${st.unknown}${st.failDialog ? '（站点提示未通过）' : ''}`);

      if (round === 1) {
        log(`🔁 重做 ${st.wrongQs.length} 道错题（换提示 + 升温重采样，已对的 ${st.right} 题不动）...`);
        st.wrongQs.forEach((wq) => { wq.prevAnswer = prevByIndex[wq.index] || []; });
        if (!(await redoWrongQuestions(st.wrongQs, prevByIndex))) return;
        how = await submitPaper();
        if (how !== 'ok') return;
      } else {
        // 两轮 LLM 后仍未通过 → 只爆破错题
        log(`🔨 只爆破错题：锁定已对的 ${st.right} 题，仅对 ${st.wrongQs.length} 道错题穷举（每次提交按判分锁定）`);
        st.wrongQs.forEach((wq) => { wq.prevAnswer = prevByIndex[wq.index] || []; });
        const pass = await bruteWrongQuestions(st.wrongQs);
        if (pass) {
          log('🎉 闯关成功（爆破路径）！');
          speak('闯关成功');
        } else {
          speak('闯关结束，请人工复核');
        }
        return;
      }
    }
  }

  // ==================== 9.8 实验性直连接口（课程 Web 会话） ====================
  // 凭据：默认走页面自身 Cookie（同源 fetch 自动携带）；可选在设置页填入手机 App
  // 抓包的 Bearer Token，请求时会附加 Android 客户端头。所有失败路径都回退页面流程。

  const UOOC_API = {
    extraHeaders() {
      const token = Store.get('appToken', '');
      const h = {};
      if (token) {
        h['Authorization'] = 'Bearer ' + token;
        h['sourceFlag'] = 'android';
        h['versionFlag'] = 'v2.0.3';
        h['productFlag'] = 'OnePlus PJA110 13';
        h['machineFlag'] = '';
        h['xgTokenFlag'] = '';
      }
      return h;
    },
    cid() {
      const m = location.href.match(/index#\/(\d+)\//) || location.href.match(/[?&#]cid=(\d+)/);
      return m ? m[1] : null;
    },
    async getJSON(path, params) {
      const qs = new URLSearchParams(params || {}).toString();
      const resp = await fetch(path + (qs ? '?' + qs : ''), { credentials: 'same-origin', headers: this.extraHeaders() });
      return resp.json().catch(() => null);
    },
    async postForm(path, params) {
      const resp = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, this.extraHeaders()),
        body: new URLSearchParams(params).toString()
      });
      return resp.json().catch(() => null);
    },
    async getCourseLearn(cid) {
      const j = await this.getJSON('/home/learn/getCourseLearn', { cid });
      return j && j.data ? j.data : null;
    },
    async getUnitLearn(cid, chapterId, sectionId, catalogId) {
      const j = await this.getJSON('/home/learn/getUnitLearn', {
        cid, chapter_id: chapterId, section_id: sectionId, catalog_id: catalogId
      });
      return j && Array.isArray(j.data) ? j.data : null;
    },
    async getTaskPaper(tid) {
      const j = await this.getJSON('/exam/getTaskPaper', { tid });
      const qs = j && j.data && Array.isArray(j.data.questions) ? j.data.questions : null;
      return qs && qs.length ? qs : null;
    },
    async commit(cid, tid, answers) {
      return this.postForm('/exam/commit', { cid, tid, data: JSON.stringify(answers) });
    }
  };

  // ⚡ 接口直答：getTaskPaper 取卷 → 泄漏答案/LLM 投票 → commit 逐题判分 →
  // 错题接口级穷举 → 整卷提交。任何一步失败返回 null，闯关流水线回退页面流程。
  // ⚠️ 仅用于学习页章节测验；/exam/ 考试页永不调用。
  function buildApiPrompt(paper) {
    let p = '请回答以下选择题，每题直接给出答案选项字母（如 A、B、C、D 或 A,B），不需要解释。\n\n';
    paper.forEach((q, i) => {
      p += `第${i + 1}题\n`;
      Object.keys(q.options || {}).forEach((k, j) => {
        p += `${String.fromCharCode(65 + j)}. ${String(q.options[k]).replace(/<[^>]*>/g, '').trim()}\n`;
      });
      p += '\n';
    });
    p += '请按格式返回：\n1. A\n2. B,C\n...';
    return p;
  }

  async function apiExamSolve() {
    const cid = UOOC_API.cid();
    if (!cid) return null;

    let tid = (location.href.match(/[?&#]tid=(\d+)/) || [])[1] || null;
    let paper = tid ? await UOOC_API.getTaskPaper(tid) : null;
    if (!paper) {
      // 从章节上下文定位当前未完成测验的 task_id
      const learn = await UOOC_API.getCourseLearn(cid);
      if (!learn || !learn.catalog_id) return null;
      const units = await UOOC_API.getUnitLearn(cid, learn.chapter_id, learn.section_id, learn.catalog_id);
      const task = (units || []).find((u) => u.task_id && u.task_id != 0);
      if (!task) return null;
      tid = String(task.task_id);
      paper = await UOOC_API.getTaskPaper(tid);
    }
    if (!paper || !paper.length) return null;
    log(`⚡ 接口直答：取到试卷 ${paper.length} 题（tid=${tid}）`);

    const keysOf = (q) => Object.keys(q.options || {});
    const keyOfLetter = (q, L) => {
      const keys = keysOf(q);
      return keys[(L || 'A').charCodeAt(0) - 65] || keys[0];
    };
    const isSingle = (q) => q.type === 10 || keysOf(q).length <= 2;

    // 首轮答案：泄漏字段优先，缺的用 LLM 投票补
    let answers = paper.map((q) => {
      const leak = q.answer || q.right || q.correct;
      return leak ? (Array.isArray(leak) ? leak : [leak]) : null;
    });
    if (answers.some((a) => !a)) {
      const voted = await llmVoteAnswers(buildApiPrompt(paper), paper.length, 0.3, '接口直答');
      if (voted) {
        answers = answers.map((a, i) =>
          a || (voted[i] ? voted[i].map((L) => keyOfLetter(paper[i], L)) : null));
      }
    }

    const MAX_COMMITS = 200;
    let commits = 0;
    const scoreOf = async (q, ans) => {
      commits++;
      const j = await UOOC_API.commit(cid, tid, [{ qid: q.id, answer: ans }]);
      await wait(100);
      return j && j.data && j.data.score != null ? j.data.score : null;
    };

    let right = 0;
    const finalAnswers = [];
    for (let i = 0; i < paper.length; i++) {
      const q = paper[i];
      let ans = answers[i] || [];

      // 首验：判分接口不可读就直接放弃接口直答（回退页面流程）
      if (ans.length && commits < MAX_COMMITS) {
        const s = await scoreOf(q, ans);
        if (s === null) {
          log('⚠️ 接口未返回判分字段，接口直答不可用');
          return null;
        }
        if (s !== 0) { right++; finalAnswers.push({ qid: q.id, answer: ans }); continue; }
      }

      // 错题/未作答：接口级穷举（单选逐项；多选按子集大小 2→3→…→1）
      const keys = keysOf(q);
      const combos = isSingle(q)
        ? keys.map((k) => [k])
        : multiCombos(keys.length).map((idx) => idx.map((x) => keys[x]));
      let solved = false;
      for (const cand of combos) {
        if (commits >= MAX_COMMITS) break;
        const s = await scoreOf(q, cand);
        if (s !== null && s !== 0) {
          log(`⚡ 第${i + 1}题接口穷举命中（${cand.join('')}）`);
          ans = cand; right++; solved = true;
          break;
        }
      }
      if (!solved) log(`⚠️ 第${i + 1}题未能穷举命中，保留当前作答`);
      finalAnswers.push({ qid: q.id, answer: ans });
    }

    if (commits >= MAX_COMMITS) log('⛔ 接口提交达到上限，直接整卷提交当前答案');
    commits++;
    await UOOC_API.commit(cid, tid, finalAnswers);
    return { right, total: paper.length, commits };
  }

  // ==================== 9.9 讨论区：AI 生成回复并自动发帖 ====================
  // 思路取自 fastuooc 的讨论实现：hash 路由识别讨论视图，页面世界（MAIN world）
  // 里攀爬 Angular scope 取帖子标题/正文、填充 DIR_EDITORS/textarea，
  // 经 courseService.discReply 提交。已回过的帖子持久化去重，回完自动回学习视图。

  // content script 在隔离世界访问不到页面 angular/DIR_EDITORS，
  // 通过 background 的 chrome.scripting(world:'MAIN') 在页面世界执行函数（不受页面 CSP 限制）。
  function pageEval(fn, args) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'PAGE_EVAL', fn: fn.toString(), args: args || [] })
          .then((r) => resolve(r && 'result' in r ? r.result : null))
          .catch(() => resolve(null));
      } catch (e) {
        resolve(null);
      }
    });
  }

  // 在页面世界执行：探测讨论列表 + 帖子详情（标题/正文已剥 HTML）
  function pgProbe() {
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
        hasDiscuz: !!document.querySelector('.Discuz')
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

  // 在页面世界执行：填充编辑器并经 courseService.discReply 发帖
  function pgSubmitReply(cid, tid, content) {
    function climb(scope, pred) {
      let cur = scope;
      for (let i = 0; cur && i < 12; i++) {
        try { if (pred(cur)) return cur; } catch (e) { /* 忽略 */ }
        cur = cur.$parent;
      }
      return null;
    }
    if (!window.angular) return Promise.resolve({ __err: '页面 Angular 不可用' });
    let detail = null;
    const nodes = document.querySelectorAll(
      '[thread-detail],[ng-bind-html*="threads.content"],.discussionDesc,.thesis-content,.discuss-header');
    for (const n of nodes) {
      const s = climb(window.angular.element(n).scope(), (c) =>
        c.threads && (typeof c.replay === 'function' || typeof c.getList === 'function' || typeof c.handleRelease === 'function'));
      if (s) { detail = s; break; }
    }
    if (!detail) return Promise.resolve({ __err: '未找到帖子详情 scope' });

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
      return Promise.resolve({ __err: '未找到 courseService.discReply' });
    }
    return Promise.resolve(courseService.discReply({ cid: String(cid), tid: String(tid), content, images: null }))
      .then(() => {
        // 触发详情刷新，让站点状态机同步
        try {
          if (typeof detail.getList === 'function') detail.getList();
          else if (typeof detail.getDetail === 'function') detail.getDetail();
        } catch (e) { /* 忽略 */ }
        return { ok: true };
      })
      .catch((e) => ({ __err: 'discReply 失败: ' + String(e) }));
  }

  // 讨论路由（hash 解析，无需页面世界）
  function discussionRoute() {
    const segs = location.hash.replace(/^#\/?/, '').split('/').map((s) => {
      try { return decodeURIComponent(s.split(/[?#;]/)[0]); } catch (e) { return s; }
    });
    const low = segs.map((s) => s.toLowerCase());
    const cid = (location.pathname.match(/\/home\/course(?:\/new)?\/(\d+)/i) || [])[1]
      || (location.href.match(/index#\/(\d+)\//) || [])[1] || null;
    const isDetail = low.includes('discussdetail');
    const isList = !isDetail && (low[0] === 'discuss' || low[0] === 'discusscom');
    const nums = segs.filter((s) => /^\d+$/.test(s) && s !== cid);
    // DOM 检测：学习页把讨论作为内嵌资源渲染（hash 是 #/cid/chapter/resource 形式，
    // 不含 discuss 字样），此时靠页面结构判定——列表项 / 详情容器出现即视为讨论视图
    let domList = false, domDetail = false;
    try {
      domList = !!(document.querySelector('[ng-repeat*="tiezi"], .discussion-item, .thread-item, .Discuz'));
      domDetail = !!(document.querySelector('[thread-detail], .thesis-content, .discuss-header, [ng-bind-html*="threads.content"]'));
    } catch (e) { /* 忽略 */ }
    return {
      active: isDetail || isList || domList || domDetail,
      isDetail: isDetail || (!isList && domDetail),
      isList: isList || (domList && !domDetail),
      domInline: !isDetail && !isList, // 学习页内嵌：无 hash 路由，靠 DOM 点击进出帖子
      cid,
      mode: (low[0] === 'discusscom' || (isDetail && low[0] === 'discussdetail')) ? 'old' : 'new',
      tid: isDetail ? (nums[0] || '') : ''
    };
  }
  function navDiscussionList(mode) {
    location.hash = mode === 'old' ? '#/discusscom' : '#/discuss';
  }
  function navDiscussionDetail(route, tid) {
    // 学习页内嵌讨论没有 hash 路由：直接点击列表项进入详情
    const el = document.querySelector('[data-uooc-tid="' + tid + '"]');
    if (el) { try { el.click(); return; } catch (e) { /* 落到 hash 导航 */ } }
    location.hash = route.mode === 'old'
      ? '#/discussdetail/com/' + encodeURIComponent(tid)
      : '#/discuss/' + encodeURIComponent(tid) + '/' + encodeURIComponent(route.cid) + '/discussDetail';
  }
  // 学习页内嵌详情回列表：尝试常见返回/关闭入口
  function dismissDiscussionDetail() {
    const sels = ['.discuss-back', '.back-btn', '.btn-back', '.discuss-header .back',
      '[ng-click*="back"]', '[ng-click*="Back"]', '.layui-layer-close'];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && el.offsetHeight > 0) { try { el.click(); return true; } catch (e) { /* 继续 */ } }
    }
    const backBtn = Array.from(document.querySelectorAll('a, button, span'))
      .find((e) => /^(返回|返 回)$/.test((e.innerText || '').trim()) && e.offsetHeight > 0);
    if (backBtn) { try { backBtn.click(); return true; } catch (e) { /* 忽略 */ } }
    return false;
  }

  // 已回帖持久化去重（按课程，最多留 80 条）
  function discRepliedGet() {
    const all = Store.get('discReplied', {}) || {};
    return Array.isArray(all[UOOC_API.cid() || 'default']) ? all[UOOC_API.cid() || 'default'] : [];
  }
  function discRepliedAdd(tid) {
    const all = Store.get('discReplied', {}) || {};
    const cid = UOOC_API.cid() || 'default';
    const arr = Array.isArray(all[cid]) ? all[cid] : [];
    if (!arr.includes(tid)) arr.push(tid);
    if (arr.length > 80) arr.splice(0, arr.length - 80);
    all[cid] = arr;
    Store.set({ discReplied: all });
  }

  async function genDiscussionReply(title, content) {
    const sys = [
      '你是一名认真参与在线课程讨论的学生。',
      '根据帖子题目和正文，写一条有价值、具体、自然的中文回复。',
      '回应原帖核心问题，补充方法、例子或容易忽略的角度，避免空泛赞同、重复原文和机械套话。',
      '只输出纯文本正文，不要 Markdown、HTML、引号或任何前缀，也不要提及 AI。',
      '80 到 200 字，语气自然，像真实学生参与讨论。'
    ].join('\n');
    const res = await llmChat([
      { role: 'system', content: sys },
      { role: 'user', content: '帖子题目：\n' + title + '\n\n帖子正文：\n' + content }
    ], 0.7);
    if (!res || !res.ok) {
      log('🤖 LLM 调用失败：' + ((res && (res.error || 'HTTP ' + res.status)) || '未知错误'));
      return null;
    }
    const text = ((res.data && res.data.choices && res.data.choices[0] &&
      res.data.choices[0].message && res.data.choices[0].message.content) || '')
      .replace(/[*_`~#>]/g, '').trim();
    return text.slice(0, 500) || null;
  }

  let discState = null;
  let lastLearnHash = '';

  async function discussionTick(route) {
    if (!discState) {
      discState = {
        busy: false, done: false, skip: false, tried: new Set(),
        failCount: 0, coolUntil: 0, firstSeenAt: Date.now()
      };
      log('💬 进入讨论区：AI 将为未回复的帖子自动生成并发帖');
    }
    if (discState.busy || discState.done || discState.skip) return;
    if (Date.now() < discState.coolUntil) return; // 回帖间隔冷却
    if (!Store.get('llmEnabled', false)) {
      if (!discState.llmWarned) {
        discState.llmWarned = true;
        log('⚠️ 讨论区发帖需要 LLM：请打开「LLM 答题」并配置好 API（本次跳过讨论）');
      }
      discState.skip = true; // 放行主循环，按普通资源跨越
      return;
    }

    discState.busy = true;
    try {
      const probe = await pageEval(pgProbe);
      if (!probe || probe.__err) throw new Error((probe && probe.__err) || '页面探针失败');
      const replied = discRepliedGet();

      // 详情视图：回帖
      if (probe.detail && probe.detail.tid) {
        const { tid, title, content } = probe.detail;
        if (!title && !content) throw new Error('帖子内容尚未加载');
        if (replied.includes(tid) || discState.tried.has(tid)) {
          // 已回过：学习页内嵌靠返回按钮，course 页靠 hash 导航
          if (!dismissDiscussionDetail()) navDiscussionList(route.mode);
          return;
        }
        log(`💬 正在回复帖子：${(title || tid).slice(0, 24)}`);
        const reply = await genDiscussionReply(title, content);
        if (!reply) throw new Error('LLM 未返回回复内容');
        const res = await pageEval(pgSubmitReply, [route.cid || '', tid, reply]);
        if (!res || res.__err) throw new Error((res && res.__err) || '发帖失败');
        discRepliedAdd(tid);
        discState.tried.add(tid);
        log(`✅ 讨论回复已发布（${tid}），返回列表继续`);
        discState.coolUntil = Date.now() + 8000 + Math.floor(Math.random() * 12000);
        await wait(1200);
        if (!dismissDiscussionDetail()) navDiscussionList(route.mode);
        return;
      }

      // 列表视图：找下一个未回帖并进入
      if (probe.list && probe.list.length) {
        const next = probe.list.find((it) =>
          it.tid && !replied.includes(it.tid) && !discState.tried.has(it.tid));
        if (!next) {
          discState.done = true;
          log('💬 讨论区当前列表的帖子已全部回复完成');
          speak('讨论完成');
          if (lastLearnHash && route.domInline) location.hash = lastLearnHash; // 内嵌场景回学习视图
          return;
        }
        log(`💬 进入帖子：${(next.title || next.tid).slice(0, 24)}`);
        navDiscussionDetail(route, next.tid);
        return;
      }

      // 探针未就绪（列表/详情都没渲染出来）：等待下一轮，90 秒兜底放行
      if (!discState.notedProbe) {
        discState.notedProbe = true;
        const ng = (probe.debug && probe.debug.ngRepeats || []).join(' | ');
        log('💬 已识别讨论视图，等待内容渲染…' + (ng ? '（页面 ng-repeat: ' + ng.slice(0, 110) + '）' : ''));
      }
      if (discState.firstSeenAt && Date.now() - discState.firstSeenAt > 90000) {
        discState.done = true;
        log('❌ 讨论内容 90 秒内未渲染，放行引擎继续（可稍后重新进入讨论区重试）');
      }
    } catch (e) {
      discState.failCount++;
      log('⚠️ 讨论区处理失败（' + (e.message || e) + '）');
      if (discState.failCount >= 6) {
        discState.done = true;
        log('❌ 讨论区连续失败，本资源不再自动发帖（重新进入讨论区可重试）');
      } else {
        discState.coolUntil = Date.now() + 5000;
      }
    } finally {
      discState.busy = false;
    }
  }

  // 当前激活的小节名（讨论资源识别用）
  function activeNameQuick() {
    const nodes = document.querySelectorAll('.oneline.active, .basic.active');
    const n = nodes.length ? nodes[nodes.length - 1] : null;
    return n ? n.innerText.trim().split(/\r?\n/)[0] : '';
  }

  // ==================== 10. 复制题目答案（已提交测验的回顾页） ====================

  function copyToClipboard(content) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(content).catch(() => fallbackCopy(content));
    } else {
      fallbackCopy(content);
    }
    function fallbackCopy(text) {
      const t = document.createElement('textarea');
      t.value = text;
      document.body.appendChild(t);
      t.select();
      document.execCommand('copy');
      document.body.removeChild(t);
    }
  }

  function copyAnswersClick() {
    try {
      // 试卷可能在主文档，也可能在第一个 iframe 里，两处都找
      const docs = [document];
      try { if (frames[0] && frames[0].document) docs.unshift(frames[0].document); } catch (e) { /* 跨域 iframe */ }

      let examDoc = null;
      for (const d of docs) {
        if (d.querySelector('.testPaper-Top')) { examDoc = d; break; }
      }
      if (!examDoc) {
        alert('该页面不是测验页面，无法复制内容');
        return;
      }
      if (!examDoc.querySelector('.testPaper-Top .fl_right')) {
        alert('该测验可能还没提交，无法复制');
        return;
      }

      const queItems = Array.from(examDoc.querySelectorAll('.queItems'));
      const content = queItems.map((queType) => {
        let res = '';
        if (queType.querySelector('.queItems-type').innerText.indexOf('选') >= 0) {
          const questions = queType.querySelectorAll('.queContainer');
          res += Array.from(questions).map((question) => {
            const que = question.querySelector('.queBox').innerText
              .replace(/\n{2,}/g, '\n').replace(/(\w\.)\n/g, '$1 ');
            const ans = question.querySelector('.answerBox div:first-child').innerText.replace(/\n/g, '');
            const scoresDiv = question.querySelector('.scores');
            let right = false;
            if (scoresDiv) {
              const match = scoresDiv.innerText.match(/\d+\.?\d+/g);
              if (match && match.length >= 2) right = parseFloat(match[0]) === parseFloat(match[1]);
            }
            return `${que}\n${ans}\n是否正确：${right}\n`;
          }).join('\n');
        }
        return res;
      }).join('\n');

      copyToClipboard(content);
      alert('题目及答案已复制到剪切板');
    } catch (err) {
      alert('复制出错：' + err.message);
    }
  }

  // ==================== 11. 悬浮控制台 UI ====================

  // 内嵌 monochrome SVG 图标（不加载外部资源；日志中的 emoji 属于运行内容，不受此限制）
  const _svg = (inner, filled) => `<svg viewBox="0 0 24 24" aria-hidden="true" ${filled
    ? 'fill="currentColor" stroke="none"'
    : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'}>${inner}</svg>`;
  const ICONS = {
    gear: _svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
    minus: _svg('<line x1="5" y1="12" x2="19" y2="12"/>'),
    refresh: _svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
    tool: _svg('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
    copy: _svg('<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    spark: _svg('<path d="M12 2.5l2.1 5.9 5.9 2.1-5.9 2.1L12 18.5l-2.1-5.9L4 10.5l5.9-2.1L12 2.5z"/>', true),
    play: _svg('<polygon points="6 3 20 12 6 21 6 3"/>', true),
    stop: _svg('<rect x="5.5" y="5.5" width="13" height="13" rx="2.5"/>', true),
    check: _svg('<polyline points="20 6 9 17 4 12"/>'),
    x: _svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  };

  // ---- 面板收起/展开 + 挂机后自动退场 ----
  // 启动挂机成功后 1.5s 自动最小化为胶囊；用户主动展开过一次后，
  // 本次页面生命周期内不再自动收起；停止挂机不会强制展开。
  let autoCollapseTimer = null;
  let userReExpanded = false;
  let dragInProgress = false;

  function panelIsVisible() {
    const p = document.getElementById('uooc-video-panel');
    return !!(p && p.style.display !== 'none');
  }

  // 靠近浏览器左右边缘时吸附到 12px 边距
  function snapToEdge(el) {
    const margin = 12, dist = 44;
    let left = parseFloat(el.style.left);
    if (isNaN(left)) left = el.offsetLeft;
    const w = el.offsetWidth;
    if (left < dist) left = margin;
    if (window.innerWidth - left - w < dist) left = window.innerWidth - w - margin;
    el.style.left = left + 'px';
  }

  function minimizePanel() {
    const p = document.getElementById('uooc-video-panel');
    const b = document.getElementById('uooc-min-ball');
    if (!p || !b) return;
    // 胶囊继承面板当前位置，避免跳位
    const r = p.getBoundingClientRect();
    b.style.left = Math.max(8, r.left) + 'px';
    b.style.top = Math.max(8, r.top) + 'px';
    snapToEdge(b);
    p.style.display = 'none';
    b.style.display = 'flex';
  }

  function expandPanel(byUser) {
    const p = document.getElementById('uooc-video-panel');
    const b = document.getElementById('uooc-min-ball');
    if (!p || !b) return;
    const r = b.getBoundingClientRect();
    b.style.display = 'none';
    p.style.display = 'block'; // 先显示再测量，offsetWidth 才有值
    const maxLeft = window.innerWidth - p.offsetWidth - 12;
    p.style.left = Math.max(8, Math.min(r.left, maxLeft)) + 'px';
    p.style.top = Math.max(8, Math.min(r.top, window.innerHeight - 120)) + 'px';
    if (byUser) userReExpanded = true; // 用户主动展开后，本生命周期不再自动收起
  }

  function scheduleAutoCollapse() {
    if (userReExpanded) return;
    if (autoCollapseTimer) clearTimeout(autoCollapseTimer);
    autoCollapseTimer = setTimeout(() => {
      autoCollapseTimer = null;
      if (engineStarted && !userReExpanded && !dragInProgress && panelIsVisible()) {
        minimizePanel();
        log('🎛️ 面板已自动收起，点击左侧胶囊可随时展开');
      }
    }, 1500);
  }

  function buildPanel() {
    if (document.getElementById('uooc-video-panel')) return;

    const css = `
        #uooc-video-panel { position:fixed; top:20px; left:20px; width:264px; background:rgba(11,17,27,.94); backdrop-filter:blur(12px) saturate(130%); color:#f8fafc; z-index:2147483647; pointer-events:auto; border:1px solid rgba(148,163,184,.14); border-radius:12px; box-shadow:0 18px 45px rgba(0,0,0,.28), 0 2px 8px rgba(0,0,0,.22); font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; display:block; }
        #uooc-video-panel * { box-sizing:border-box; }
        #uooc-drag-bar { display:flex; align-items:center; gap:9px; padding:9px 12px; cursor:move; user-select:none; border-bottom:1px solid rgba(148,163,184,.14); }
        #uooc-header-dot { flex:none; width:9px; height:9px; border-radius:50%; background:#64748b; transition:background .2s ease; }
        #uooc-header-dot.on { background:#22c55e; box-shadow:0 0 0 4px rgba(34,197,94,.10); animation:uooc-pulse 2.4s ease-in-out infinite; }
        @keyframes uooc-pulse { 0%,100% { box-shadow:0 0 0 3px rgba(34,197,94,.08); } 50% { box-shadow:0 0 0 6px rgba(34,197,94,.16); } }
        @media (prefers-reduced-motion: reduce) { #uooc-header-dot.on { animation:none; } }
        .uooc-header-text { flex:1; min-width:0; }
        .uooc-header-title { font-size:13px; font-weight:600; line-height:1.25; color:#f8fafc; }
        .uooc-header-sub { font-size:10px; color:#7f8da3; line-height:1.3; }
        .uooc-bar-icons { display:flex; align-items:center; gap:2px; }
        .uooc-bar-icons span { display:flex; align-items:center; justify-content:center; width:24px; height:24px; border-radius:6px; cursor:pointer; color:#7f8da3; transition:background 140ms ease, color 140ms ease; }
        .uooc-bar-icons span:hover { background:rgba(148,163,184,.12); color:#e2e8f0; }
        .uooc-bar-icons svg, .uooc-sec-gear svg { width:15px; height:15px; }
        #uooc-panel-body { padding:8px 12px 10px; }
        .uooc-sec-head { display:flex; align-items:center; justify-content:space-between; margin:2px 0 8px; }
        .uooc-sec-title { font-size:11px; font-weight:600; color:#7f8da3; letter-spacing:.4px; }
        .uooc-sec-status { font-size:10px; color:#64748b; transition:color .2s ease; }
        .uooc-sec-status.on { color:#22c55e; }
        .uooc-sec-gear { display:flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:6px; cursor:pointer; color:#7f8da3; transition:background 140ms ease, color 140ms ease; }
        .uooc-sec-gear:hover { background:rgba(148,163,184,.12); color:#e2e8f0; }
        #uooc-helper-rows, #uooc-ai-sec, .uooc-log-sec { margin-top:8px; padding-top:6px; border-top:1px solid rgba(148,163,184,.10); }
        #uooc-start-btn { display:flex; align-items:center; justify-content:center; gap:7px; width:100%; height:34px; background:#3b82f6; color:#fff; border:none; border-radius:7px; font-size:12px; font-weight:600; cursor:pointer; font-family:inherit; transition:background 140ms ease, border-color 140ms ease, transform 80ms ease; }
        #uooc-start-btn:hover { background:#4b8df8; }
        #uooc-start-btn:active { transform:translateY(1px); }
        #uooc-start-btn:focus-visible { outline:none; box-shadow:0 0 0 2px #0c111b, 0 0 0 4px rgba(59,130,246,.55); }
        #uooc-start-btn.running { background:rgba(239,68,68,.08); border:1px solid rgba(239,68,68,.24); color:#f87171; }
        #uooc-start-btn.running:hover { background:rgba(239,68,68,.14); }
        #uooc-start-btn svg { width:12px; height:12px; }
        .uooc-engine-sub { display:flex; gap:7px; margin-top:7px; }
        #uooc-refresh-btn, #uooc-unlock-btn { flex:1; display:flex; align-items:center; justify-content:center; gap:6px; height:28px; background:transparent; color:#cbd5e1; border:1px solid rgba(148,163,184,.18); border-radius:7px; font-size:11px; font-weight:500; cursor:pointer; font-family:inherit; transition:background 140ms ease, border-color 140ms ease, transform 80ms ease; }
        #uooc-refresh-btn:hover, #uooc-unlock-btn:hover { background:rgba(148,163,184,.08); border-color:rgba(148,163,184,.28); }
        #uooc-refresh-btn:active, #uooc-unlock-btn:active { transform:translateY(1px); }
        #uooc-refresh-btn:focus-visible, #uooc-unlock-btn:focus-visible { outline:none; box-shadow:0 0 0 2px #0c111b, 0 0 0 4px rgba(59,130,246,.55); }
        #uooc-refresh-btn svg, #uooc-unlock-btn svg { width:12px; height:12px; }
        .uooc-setting { display:flex; align-items:center; gap:8px; min-height:38px; padding:5px 6px; margin:0 -6px; border-radius:8px; cursor:pointer; user-select:none; transition:background 140ms ease; }
        .uooc-setting:hover { background:rgba(148,163,184,.07); }
        .uooc-setting-text { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
        .uooc-setting-title { font-size:12px; color:#f8fafc; line-height:1.35; }
        .uooc-setting-desc { font-size:9.5px; color:#7f8da3; line-height:1.3; }
        .uooc-setting input[type=checkbox] { position:absolute; opacity:0; width:0; height:0; }
        .uooc-switch { flex:none; width:30px; height:18px; border-radius:9px; background:#334155; position:relative; transition:background 160ms ease; }
        .uooc-switch::after { content:''; position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%; background:#f8fafc; box-shadow:0 1px 2px rgba(0,0,0,.35); transition:transform 160ms ease; }
        .uooc-setting input:checked + .uooc-switch { background:#3b82f6; }
        .uooc-setting input:checked + .uooc-switch::after { transform:translateX(12px); }
        .uooc-setting input:focus-visible + .uooc-switch { box-shadow:0 0 0 2px #0c111b, 0 0 0 4px rgba(59,130,246,.55); }
        .uooc-select { flex:none; width:64px; height:24px; padding:0 4px; background:#151e2d; color:#cbd5e1; border:1px solid rgba(148,163,184,.18); border-radius:6px; font-size:11px; font-family:inherit; cursor:pointer; }
        .uooc-select:hover { border-color:rgba(148,163,184,.28); }
        .uooc-select:focus-visible { outline:none; border-color:#3b82f6; box-shadow:0 0 0 3px rgba(59,130,246,.13); }
        #uooc-answer-btn, #uooc-copy-btn { display:flex; align-items:center; justify-content:center; gap:7px; width:100%; height:32px; border-radius:7px; font-size:12px; font-weight:500; cursor:pointer; font-family:inherit; transition:background 140ms ease, border-color 140ms ease, transform 80ms ease; }
        #uooc-answer-btn { background:#3b82f6; color:#fff; border:none; margin-top:8px; }
        #uooc-answer-btn:hover { background:#4b8df8; }
        #uooc-answer-btn:active { transform:translateY(1px); }
        #uooc-answer-btn:focus-visible { outline:none; box-shadow:0 0 0 2px #0c111b, 0 0 0 4px rgba(59,130,246,.55); }
        #uooc-answer-btn:disabled { cursor:default; }
        #uooc-answer-btn.ans-loading { opacity:.85; }
        #uooc-answer-btn.ans-ok { background:rgba(34,197,94,.12); color:#4ade80; }
        #uooc-answer-btn.ans-ok:hover { background:rgba(34,197,94,.18); }
        #uooc-answer-btn.ans-err { background:rgba(239,68,68,.12); color:#f87171; }
        #uooc-answer-btn.ans-err:hover { background:rgba(239,68,68,.18); }
        #uooc-answer-btn svg, #uooc-copy-btn svg { width:13px; height:13px; }
        .uooc-spinner { width:12px; height:12px; border:2px solid rgba(255,255,255,.25); border-top-color:#fff; border-radius:50%; animation:uooc-spin .8s linear infinite; }
        @keyframes uooc-spin { to { transform:rotate(360deg); } }
        #uooc-copy-btn { background:transparent; color:#cbd5e1; border:1px solid rgba(148,163,184,.18); margin-top:7px; }
        #uooc-copy-btn:hover { background:rgba(148,163,184,.08); border-color:rgba(148,163,184,.28); }
        #uooc-copy-btn:active { transform:translateY(1px); }
        #uooc-copy-btn:focus-visible { outline:none; box-shadow:0 0 0 2px #0c111b, 0 0 0 4px rgba(59,130,246,.55); }
        .uooc-log-head-clear { font-size:10px; color:#7f8da3; cursor:pointer; padding:2px 6px; border-radius:5px; user-select:none; transition:background 140ms ease, color 140ms ease; }
        .uooc-log-head-clear:hover { background:rgba(148,163,184,.10); color:#cbd5e1; }
        #uooc-log { height:68px; overflow-y:auto; background:#0a101a; border:1px solid rgba(148,163,184,.14); border-radius:8px; padding:7px 8px; font-family:ui-monospace,"Cascadia Code",Consolas,monospace; font-size:10px; line-height:1.55; color:#9eacc0; }
        #uooc-log div { word-break:break-all; }
        #uooc-log .log-success { color:#86efac; }
        #uooc-log .log-warning { color:#fcd34d; }
        #uooc-log .log-danger { color:#fca5a5; }
        #uooc-log .log-info { color:#93c5fd; }
        #uooc-log::-webkit-scrollbar { width:4px; }
        #uooc-log::-webkit-scrollbar-track { background:transparent; }
        #uooc-log::-webkit-scrollbar-thumb { background:rgba(148,163,184,.25); border-radius:2px; }
        #uooc-min-ball { position:fixed; top:20px; left:20px; width:40px; height:40px; background:rgba(15,23,42,.96); border:1px solid rgba(148,163,184,.18); border-radius:12px; z-index:2147483647; pointer-events:auto; display:none; align-items:center; justify-content:center; cursor:move; user-select:none; box-shadow:0 10px 30px rgba(0,0,0,.30); touch-action:none; }
        .uooc-ball-u { font-size:15px; font-weight:700; color:#cbd5e1; }
        .uooc-ball-dot { display:none; position:absolute; top:-2px; right:-2px; width:10px; height:10px; border-radius:50%; background:#22c55e; border:2px solid #0b0f17; }
        #uooc-min-ball.running .uooc-ball-dot { display:block; animation:uooc-ballpulse 2.4s ease-in-out infinite; }
        @keyframes uooc-ballpulse { 0%,100% { box-shadow:0 0 0 2px rgba(34,197,94,.12); } 50% { box-shadow:0 0 0 5px rgba(34,197,94,.30); } }
        @media (prefers-reduced-motion: reduce) { #uooc-min-ball.running .uooc-ball-dot { animation:none; } }
    `;
    const style = document.createElement('style');
    style.innerHTML = css;
    document.head.appendChild(style);

    const div = document.createElement('div');
    div.innerHTML = `
        <div id="uooc-video-panel">
          <div id="uooc-drag-bar">
            <span id="uooc-header-dot"></span>
            <div class="uooc-header-text">
              <div class="uooc-header-title">UOOC Assistant</div>
              <div class="uooc-header-sub">Control Center</div>
            </div>
            <div class="uooc-bar-icons">
              <span id="uooc-set-btn" title="设置（API 配置）">${ICONS.gear}</span>
              <span id="uooc-min-btn" title="收起">${ICONS.minus}</span>
            </div>
          </div>
          <div id="uooc-panel-body">
            <div id="uooc-engine-row">
              <div class="uooc-sec-head">
                <span class="uooc-sec-title">挂机引擎</span>
                <span class="uooc-sec-status" id="uooc-engine-state-text">未启动</span>
              </div>
              <button id="uooc-start-btn" title="全自动挂机：接管视频、秒杀弹窗、自动跳章节">${ICONS.play}<span>启动挂机</span></button>
              <div class="uooc-engine-sub">
                <button id="uooc-refresh-btn" title="强制刷新网页重启兜底">${ICONS.refresh}<span>刷新页面</span></button>
                <button id="uooc-unlock-btn" title="急救：清理卡死的弹窗遮罩，恢复页面点击与播放">${ICONS.tool}<span>页面急救</span></button>
              </div>
            </div>
            <div id="uooc-helper-rows">
              <div class="uooc-sec-head"><span class="uooc-sec-title">视频助手</span></div>
              <label class="uooc-setting" title="自动播放并拦截站点暂停（空格键切换）">
                <span class="uooc-setting-text"><span class="uooc-setting-title">播放托管</span><span class="uooc-setting-desc">自动接管视频播放</span></span>
                <input type="checkbox" id="uooc-play-on">
                <span class="uooc-switch"></span>
              </label>
              <label class="uooc-setting" title="托管播放速度">
                <span class="uooc-setting-text"><span class="uooc-setting-title">倍速</span></span>
                <select id="uooc-rate-value" class="uooc-select">
                  <option value="1">1.0x</option>
                  <option value="1.25">1.25x</option>
                  <option value="1.5">1.5x</option>
                  <option value="2">2.0x</option>
                  <option value="2.5">2.5x</option>
                  <option value="3">3.0x</option>
                </select>
                <input type="checkbox" id="uooc-rate-on">
                <span class="uooc-switch"></span>
              </label>
              <label class="uooc-setting" title="自动静音视频">
                <span class="uooc-setting-text"><span class="uooc-setting-title">静音</span></span>
                <input type="checkbox" id="uooc-mute-on">
                <span class="uooc-switch"></span>
              </label>
              <label class="uooc-setting" title="播完自动跳下一节">
                <span class="uooc-setting-text"><span class="uooc-setting-title">连续播放</span><span class="uooc-setting-desc">完成后进入下一节</span></span>
                <input type="checkbox" id="uooc-continue-on">
                <span class="uooc-switch"></span>
              </label>
              <label class="uooc-setting" title="视频弹窗小题自动作答（内存嗅探 → LLM采样投票 → 穷举兜底）">
                <span class="uooc-setting-text"><span class="uooc-setting-title">弹窗秒答</span><span class="uooc-setting-desc">自动处理视频小题</span></span>
                <input type="checkbox" id="uooc-popup-on">
                <span class="uooc-switch"></span>
              </label>
            </div>
            <div id="uooc-ai-sec">
              <div class="uooc-sec-head">
                <span class="uooc-sec-title">AI 答题</span>
                <span id="uooc-llm-set" class="uooc-sec-gear" title="配置AI答题参数">${ICONS.gear}</span>
              </div>
              <div id="uooc-llm-row">
                <label class="uooc-setting">
                  <span class="uooc-setting-text"><span class="uooc-setting-title">LLM 答题</span><span class="uooc-setting-desc">使用已配置的大模型</span></span>
                  <input type="checkbox" id="uooc-llm-on">
                  <span class="uooc-switch"></span>
                </label>
                <label class="uooc-setting" title="学习页章节测验自动交卷：重做错题 + 只爆破错题（/exam/考试页不受影响，永不自动交卷）">
                  <span class="uooc-setting-text"><span class="uooc-setting-title">闯关模式</span><span class="uooc-setting-desc">只重做 / 爆破错题</span></span>
                  <input type="checkbox" id="uooc-gate-on">
                  <span class="uooc-switch"></span>
                </label>
                <label class="uooc-setting" title="引擎运行且处于课程讨论视图时，AI 生成回复并自动发帖（需要 LLM 答题已开启）">
                  <span class="uooc-setting-text"><span class="uooc-setting-title">讨论区发帖</span><span class="uooc-setting-desc">AI 生成回复并自动发帖</span></span>
                  <input type="checkbox" id="uooc-disc-on">
                  <span class="uooc-switch"></span>
                </label>
              </div>
              <button id="uooc-answer-btn" title="提取试卷题目并用 LLM 投票作答">${ICONS.spark}<span>开始 AI 答题</span></button>
              <button id="uooc-copy-btn" title="在已提交的测验回顾页，复制题目与答案到剪切板">${ICONS.copy}<span>复制题目答案</span></button>
            </div>
            <div class="uooc-log-sec">
              <div class="uooc-sec-head">
                <span class="uooc-sec-title">运行日志</span>
                <span id="uooc-log-clear" class="uooc-log-head-clear" title="清空日志（不影响运行状态）">清空</span>
              </div>
              <div id="uooc-log" data-empty="1">暂无日志</div>
            </div>
          </div>
        </div>
        <div id="uooc-min-ball" title="展开"><span class="uooc-ball-u">U</span><span class="uooc-ball-dot"></span></div>
    `;
    document.body.appendChild(div);
    flushLog();

    const panel = document.getElementById('uooc-video-panel');
    const ball = document.getElementById('uooc-min-ball');
    const dragBar = document.getElementById('uooc-drag-bar');
    const startBtn = document.getElementById('uooc-start-btn');

    // ---- 事件绑定 ----
    // 所有绑定经过 on() 容错：任一元素缺失只跳过该绑定并告警，
    // 绝不让异常中断 buildPanel（否则后续绑定集体消失）。
    const on = (id, handler, evt = 'click') => {
      const el = document.getElementById(id);
      if (!el) {
        console.warn('[UOOC助手Pro] 面板缺少控件 #' + id + '，跳过绑定');
        return;
      }
      el.addEventListener(evt, handler);
    };

    on('uooc-refresh-btn', () => {
      log('🔄 正在强制刷新页面...');
      setTimeout(() => location.reload(), 200);
    });

    on('uooc-unlock-btn', () => {
      finishPopupQuiz(document.querySelector('#quizLayer, .smallTest-view'));
      log('🧹 已清理遮罩、解锁页面并尝试恢复播放');
    });

    on('uooc-start-btn', () => (engineStarted ? stopEngine() : startEngine(false)));

    on('uooc-set-btn', openLLMSettings);
    on('uooc-llm-set', openLLMSettings);

    on('uooc-copy-btn', copyAnswersClick);

    // 复选框 <-> 存储。
    // ⚠️ 必须逐个容错：任何 id 在面板 HTML 里缺失时，getElementById 返回 null，
    // 若直接 el.addEventListener 会抛异常并中断 buildPanel —— 后续所有绑定
    // （拖拽/胶囊/最小化/答题按钮）会集体消失。v3.1.1~3.1.2 胶囊打不开即此原因。
    const bindToggle = (id, key, onChange) => {
      const el = document.getElementById(id);
      if (!el) {
        console.warn('[UOOC助手Pro] 面板缺少控件 #' + id + '，跳过绑定');
        return;
      }
      el.addEventListener('change', async (e) => {
        await Store.set({ [key]: e.target.checked });
        if (onChange) onChange(e.target.checked);
      });
    };
    bindToggle('uooc-rate-on', 'rateOn', (on) => {
      const v = currentVideo();
      if (!on && v) v.playbackRate = 1;
    });
    bindToggle('uooc-mute-on', 'muteOn', (on) => {
      const v = currentVideo();
      if (!on && v) { v.muted = false; }
    });
    bindToggle('uooc-play-on', 'playOn', (on) => {
      if (on) resumeVideo();
    });
    bindToggle('uooc-continue-on', 'continueOn');
    bindToggle('uooc-popup-on', 'popupSolveOn');
    bindToggle('uooc-gate-on', 'gateOn');
    bindToggle('uooc-disc-on', 'discussionOn');

    on('uooc-rate-value', (e) => {
      Store.set({ rateValue: Number(e.target.value) || 2 });
      const v = currentVideo();
      if (v && Store.get('rateOn', true)) v.playbackRate = Number(e.target.value) || 2;
    }, 'change');

    on('uooc-llm-on', async (e) => {
      await Store.set({ llmEnabled: e.target.checked });
      log('🤖 LLM答题 ' + (e.target.checked ? '已启用' : '已禁用'));
      if (e.target.checked) {
        const c = Store.get('llmConfig', null);
        if (!c || !c.baseUrl || !c.apiKey) {
          alert('LLM答题已启用，但尚未配置 API 参数，即将打开设置页。');
          openLLMSettings();
        }
      }
      updateAnswerBtnState();
    }, 'change');

    on('uooc-log-clear', () => {
      const l = document.getElementById('uooc-log');
      if (l) { l.innerHTML = ''; l.dataset.empty = '1'; }
    });

    on('uooc-answer-btn', async function () {
      if (!Store.get('llmEnabled', false)) {
        alert('请先打开"LLM 答题"开关！');
        return;
      }
      const btn = this;
      btn.disabled = true;
      btn.className = 'ans-loading';
      btn.innerHTML = '<span class="uooc-spinner"></span><span>正在答题…</span>';
      try {
        await autoAnswerQuiz();
        btn.className = 'ans-ok';
        btn.innerHTML = ICONS.check + '<span>答题完成</span>';
        setTimeout(() => resetAnswerBtn(btn), 3000);
      } catch (error) {
        console.error(error);
        btn.className = 'ans-err';
        btn.innerHTML = ICONS.x + '<span>答题失败</span>';
        setTimeout(() => resetAnswerBtn(btn), 2000);
      }
    });

    function resetAnswerBtn(btn) {
      btn.disabled = false;
      btn.className = '';
      btn.innerHTML = ICONS.spark + '<span>开始 AI 答题</span>';
      btn.style.opacity = Store.get('llmEnabled', false) ? '1' : '0.5';
    }

    // ---- 拖拽（带左右边缘吸附）与最小化 ----
    // ⚠️ 交互全部走 addEventListener：不用 document.onXXX 属性赋值（会被页面脚本
    // 整体覆盖），不单独依赖 click（会被站点全局 mouse/click 处理器干扰）。
    // v3.1.1/v3.1.2 胶囊打不开的根因即此——事件通道本身被页面吃掉。
    // 胶囊用 Pointer Capture：拖拽与点击判定都在胶囊自身事件上完成。
    let panelDrag = null; // {sx, sy, ix, iy}
    let ballDrag = null;  // {sx, sy, ix, iy, moved}
    let lastExpandAt = 0;

    function tryExpandByUser() {
      const now = Date.now();
      if (now - lastExpandAt < 500) return; // pointerup + click 双通道去重
      lastExpandAt = now;
      try { expandPanel(true); } catch (e) { console.error('[UOOC助手Pro] 展开面板失败', e); }
    }
    function clampDragPos(nl, nt, w) {
      // 左右边缘吸附：进入边缘 44px 范围就吸附到 12px 边距
      if (nl < 44) nl = 12;
      if (window.innerWidth - nl - w < 44) nl = window.innerWidth - w - 12;
      return [nl, Math.max(0, Math.min(nt, window.innerHeight - 40))];
    }

    // 面板拖拽（标题栏起手）；capture 阶段监听，先于页面处理器
    if (dragBar) dragBar.addEventListener('mousedown', (e) => {
      e.preventDefault();
      panelDrag = { sx: e.clientX, sy: e.clientY, ix: panel.offsetLeft, iy: panel.offsetTop };
      dragInProgress = true;
    });
    document.addEventListener('mousemove', (e) => {
      if (!panelDrag) return;
      const [nl, nt] = clampDragPos(
        panelDrag.ix + e.clientX - panelDrag.sx,
        panelDrag.iy + e.clientY - panelDrag.sy,
        panel.offsetWidth);
      panel.style.left = nl + 'px';
      panel.style.top = nt + 'px';
    }, true);
    document.addEventListener('mouseup', (e) => {
      if (!panelDrag) return;
      const [nl, nt] = clampDragPos(
        panelDrag.ix + e.clientX - panelDrag.sx,
        panelDrag.iy + e.clientY - panelDrag.sy,
        panel.offsetWidth);
      panel.style.left = nl + 'px';
      panel.style.top = nt + 'px';
      panelDrag = null;
      dragInProgress = false;
      snapToEdge(panel);
    }, true);

    // 胶囊：Pointer Capture 下拖拽；松手位移 ≤6px 判定为点击展开
    if (ball) ball.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { ball.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      ballDrag = { sx: e.clientX, sy: e.clientY, ix: ball.offsetLeft, iy: ball.offsetTop, moved: false };
      dragInProgress = true;
    });
    ball.addEventListener('pointermove', (e) => {
      if (!ballDrag) return;
      if (Math.abs(e.clientX - ballDrag.sx) + Math.abs(e.clientY - ballDrag.sy) > 6) ballDrag.moved = true;
      if (!ballDrag.moved) return;
      const [nl, nt] = clampDragPos(
        ballDrag.ix + e.clientX - ballDrag.sx,
        ballDrag.iy + e.clientY - ballDrag.sy,
        ball.offsetWidth);
      ball.style.left = nl + 'px';
      ball.style.top = nt + 'px';
    });
    const onBallUp = (e) => {
      if (!ballDrag) return;
      const moved = ballDrag.moved;
      ballDrag = null;
      dragInProgress = false;
      if (!moved) { tryExpandByUser(); return; }
      snapToEdge(ball);
    };
    ball.addEventListener('pointerup', onBallUp);
    ball.addEventListener('pointercancel', () => { ballDrag = null; dragInProgress = false; });
    // 兜底：pointer 事件被环境干扰时，click 仍可展开（500ms 去重防双触发）
    ball.addEventListener('click', () => tryExpandByUser());
    on('uooc-min-btn', () => minimizePanel());

    // ---- 考试页精简：隐藏挂机/视频相关控件 ----
    if (isExamPage()) {
      document.getElementById('uooc-engine-row').style.display = 'none';
      document.getElementById('uooc-helper-rows').style.display = 'none';
      log('📄 测评页面模式：配置好 API 后点「开始 AI 答题」');
    }

    syncPanelControls();
  }

  function syncPanelControls() {
    const $id = (id) => document.getElementById(id);
    const map = {
      'uooc-rate-on': ['rateOn', true],
      'uooc-mute-on': ['muteOn', true],
      'uooc-play-on': ['playOn', true],
      'uooc-continue-on': ['continueOn', true],
      'uooc-popup-on': ['popupSolveOn', true],
      'uooc-gate-on': ['gateOn', true],
      'uooc-disc-on': ['discussionOn', true],
      'uooc-llm-on': ['llmEnabled', false]
    };
    for (const [id, [key, dft]] of Object.entries(map)) {
      const el = $id(id);
      if (el) el.checked = !!Store.get(key, dft);
    }
    const rv = $id('uooc-rate-value');
    if (rv) rv.value = String(Store.get('rateValue', 2));
    updateEngineBtn();
    updateAnswerBtnState();
  }

  function updateAnswerBtnState() {
    const b = document.getElementById('uooc-answer-btn');
    if (!b) return;
    const on = !!Store.get('llmEnabled', false);
    b.style.opacity = on ? '1' : '0.5';
    b.style.pointerEvents = on ? 'auto' : 'none';
  }

  // ==================== 12. 键盘控制（←→ 快进快退，↑↓ 音量，空格 播放/暂停） ====================

  function bindKeyboardEvents() {
    document.addEventListener('keydown', (event) => {
      const t = event.target;
      if (t && (/(INPUT|TEXTAREA|SELECT)/.test(t.tagName) || t.isContentEditable)) return;

      const video = document.getElementById('player_html5_api') || currentVideo();
      if (!video) return;

      const basicActiveDiv = document.querySelector('div.basic.active');
      const complete = !!(basicActiveDiv && basicActiveDiv.classList.contains('complete'));

      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          video.currentTime -= 10;
          break;
        case 'ArrowRight':
          event.preventDefault();
          if (complete) video.currentTime += 10;
          break;
        case 'ArrowUp':
          event.preventDefault();
          video.muted = false;
          if (video.volume + 0.1 <= 1.0) video.volume += 0.1;
          else video.volume = 1.0;
          break;
        case 'ArrowDown':
          event.preventDefault();
          if (video.volume - 0.1 >= 0.0) video.volume -= 0.1;
          else video.volume = 0.0;
          break;
        case ' ':
          event.preventDefault();
          // 空格切换"自动播"：勾上=继续播放，取消=暂停
          const playCb = document.getElementById('uooc-play-on');
          if (playCb) playCb.click();
          break;
      }
    });
  }

  // ==================== 13. 主循环（800ms 神经中枢） ====================

  setInterval(() => {
    try {
      const solvePopup = engineStarted || Store.get('popupSolveOn', true);

      // 第零优先级之外：视频偏好保活（手动模式也生效：倍速/静音/守护）
      const video = currentVideo();
      if (video) applyVideoPrefs(video);

      if (isCoolingDown) return;

      // 🛡️ 智能验证弹层（阿里云验证码等）在屏时冻结一切自动动作：
      // 不答题、不清遮罩——误杀验证层会导致整页无法交卷
      if (verifyLayerVisible()) {
        if (!isVerifyAlarmed) {
          isVerifyAlarmed = true;
          log('🛡️ 检测到智能验证弹窗，已暂停自动作答与清理，请手动完成验证');
          speak('请完成验证');
        }
        return;
      }
      isVerifyAlarmed = false;

      // 💬 讨论区接管：引擎运行 + 「讨论区发帖」开关开启时，AI 发帖流程独占本循环。
      // 识别同时覆盖两种场景：course 页的 #/discuss 系列 hash 路由，以及学习页里
      // 把讨论作为内嵌资源渲染的情况（hash 无 discuss 字样，靠 DOM 结构 + 小节名判定）。
      // 开关关闭 → 不接管，按普通无视频资源跨越（这就是"根据开关而定"）。
      const disc = discussionRoute();
      const discByName = /讨论/.test(activeNameQuick());
      if (engineStarted && (disc.active || discByName) && Store.get('discussionOn', true)) {
        discussionTick(disc);
        if (discState && discState.skip) {
          discState.skip = false; // LLM 未配置：放行本轮，走下面的普通跨越
        } else if (!(discState && discState.done)) {
          return; // 处理中 / 等待内容渲染：独占主循环
        }
        // done：落到下面按普通资源跨越，自动进入下一节
      }
      if (!disc.active && location.hash) lastLearnHash = location.hash; // 记录学习视图 hash，讨论完成后返回

      // ------------------------------------------
      // 第零优先级：弹窗判定与主循环避让
      // ------------------------------------------
      const popBox = document.querySelector(QUIZ_SEL);
      let isPopActive = false;

      if (popBox) {
        const hasSubmitBtn = !!quizSubmitBtn(popBox);
        const hasQuestion = !!popBox.querySelector('.ti-q-c');
        const hasInputs = quizInputs(popBox).length > 0;

        if (hasQuestion || hasSubmitBtn || hasInputs) {
          // ✅ 货真价实的题目 —— 绝对不许动它！
          // （不能用 "div[uooc-video] 的 source 取不到" 当幽灵判据：
          //   弹窗小题弹出时 source 恰好取不到，真小测会被误当成幽灵弹窗。）
          popBox.dataset.ghostSince = '';
          if (popBox.dataset.solved === 'true') popBox.dataset.solved = '';
        } else {
          // 🕐 既没题目、又没按钮、又没选项 —— 才是空壳。给 4 秒宽限避开 DOM 构建瞬间
          if (!popBox.dataset.ghostSince) {
            popBox.dataset.ghostSince = String(Date.now());
          } else if (Date.now() - Number(popBox.dataset.ghostSince) > 4000
                     && popBox.dataset.solved !== 'true') {
            popBox.dataset.solved = 'true';
            log('👻 斩杀空壳幽灵弹窗，释放主循环！');
            closeQuizLayer(popBox);
          }
        }

        isPopActive = popupVisible(popBox) && popBox.dataset.solved !== 'true';

        // 🔁 弹窗由不可见 -> 可见 = 新一轮，清空上一轮的穷举记录，允许重新作答
        if (isPopActive && !wasPopActive) {
          popBox.dataset.triedMask = '0';
          popBox.dataset.busy = '0';
          popBox.dataset.alarmSince = '';
          isPopupAlarmed = false;
        }

        // ⏱️ 真弹窗卡了 20 秒还没解掉 -> 提示人工接管
        if (isPopActive) {
          if (!popBox.dataset.alarmSince) popBox.dataset.alarmSince = String(Date.now());
          if (Date.now() - Number(popBox.dataset.alarmSince) > 20000 && !isPopupAlarmed) {
            isPopupAlarmed = true;
            log('⚠️ 弹窗小题仍未解决，请手动处理');
            speak('弹窗小题没解出来，请手动处理');
          }
        }
      }

      // 弹窗已消失 -> 复位警报标志，下一道小题才能重新计数
      if (!popBox && isPopupAlarmed) isPopupAlarmed = false;
      wasPopActive = isPopActive;

      // 🧹 孤儿遮罩自愈
      cleanOrphanShade();

      // 弹窗期间：专心解题，不强行续播（没答完题本来也不该继续计时）
      if (isPopActive) {
        if (solvePopup) handlePopupQuiz(popBox);
        return;
      }

      // 手动模式到此为止：只保活视频偏好
      if (!engineStarted) return;

      // ------------------------------------------
      // 第一优先级：独立测验紧急刹车
      // 🔑 结构性判据（"软件测试"这种课程名不能误判成大考）：
      //   1) 该项（或其所在 li）带 .icon-video -> 一律不是测验
      //   2) 资源标签 .tag-source-name 里有 测验/考试/试卷
      //   3) 页面级题目 .ti-q-c（不在任何弹层内），或出现"保存试卷"
      // ------------------------------------------
      const pageText = document.body.innerText || '';
      const activeNodes = document.querySelectorAll('.oneline.active, .basic.active');
      const activeNode = activeNodes.length > 0 ? activeNodes[activeNodes.length - 1] : null;
      const activeName = activeNode ? activeNode.innerText.trim().split(/\r?\n/)[0] : '';

      const isCompleted = activeNode && activeNode.classList.contains('complete');

      const pageLevelQuestion = Array.from(document.querySelectorAll('.ti-q-c'))
        .some((el) => !el.closest('#quizLayer, .smallTest-view, .layui-layer'));

      const hasVideoIcon = !!activeNode
        && (!!activeNode.querySelector('.icon-video')
            || !!activeNode.closest('li')?.querySelector('.icon-video'));

      const tagEl = activeNode ? activeNode.querySelector('.tag-source-name') : null;
      const tagText = tagEl ? tagEl.innerText.trim() : '';

      const looksLikeQuiz = !hasVideoIcon
        && (/(测验|考试|试卷)/.test(tagText) || /(测验|考试|试卷)/.test(activeName));

      const strongExamSignal = pageLevelQuestion || pageText.includes('保存试卷');

      const isIndependentExam = !video && (strongExamSignal || looksLikeQuiz) && !isCompleted;

      if (isIndependentExam) {
        if (!isExamAlarmed) {
          isExamAlarmed = true;
          log('🛑 警告：发现独立大考！引擎已挂起，请手动交卷。');
          speak('测验 测验');
        }
        noVideoTimer = 0;
        return;
      }
      isExamAlarmed = false;

      // 🌟 当前是大考但已打勾 -> 解除封印，自动前进
      if ((looksLikeQuiz || pageLevelQuestion) && isCompleted && !isJumping) {
        log('✅ 检测到大考已提交（绿勾亮起），自动继续前进...');
        navigate('大考已完结跳过');
        return;
      }

      // ------------------------------------------
      // 第二优先级：视频托管
      // ------------------------------------------
      if (video) {
        noVideoTimer = 0;
        endReached = false; // 有视频在播说明还没到头，解除封顶锁
        resumeVideo();
        return;
      }

      // ------------------------------------------
      // 第三优先级：无视频内容安全跳过
      // 附件/讨论页 3 秒即跳；其它无视频小节（文本/文档/图文/空白过渡页）
      // 给 6 秒缓冲再跳 —— 否则会永远卡在这种页面上（如日志里"目标锁定：文本"后不动）。
      // ------------------------------------------
      if (!isJumping) {
        // 注：「讨论」不在附件名单里——讨论由上面的 discussionTick 流程控制，
        // 开关关/LLM 未配/处理完成时才落到这里按普通无视频资源跨越（6 秒）。
        const isAttachment = window.location.href.includes('/files')
          || /(附件)/.test(activeName)
          || document.querySelector('.course-select-resource')
          || pageText.includes('请选择课程资源');

        if (endReached) {
          noVideoTimer = 0;
        } else {
          noVideoTimer += 0.8;
          const threshold = isAttachment ? 3 : 6;
          if (noVideoTimer > threshold) {
            log(isAttachment
              ? '⏭️ 确认当前为附件/过渡页，执行安全跨越...'
              : '⏭️ 当前小节无视频内容（文本/文档等），自动跳过...');
            navigate(isAttachment ? '附件跳过' : '无视频内容跳过');
            noVideoTimer = 0;
          }
        }
      }
    } catch (e) {
      console.error('[UOOC助手Pro] 主循环异常:', e);
    }
  }, 800);

  // ==================== 14. 初始化 ====================

  // Popup 的「展开悬浮面板」按钮：任何事件环境问题下的可靠恢复通道
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'PANEL_EXPAND') {
      try { expandPanel(true); } catch (e) { /* 忽略 */ }
    }
  });

  // 切换小节/资源（hash 变化）时重置讨论状态机，让新资源从头识别
  window.addEventListener('hashchange', () => {
    discState = null;
  });

  function waitBody() {
    return new Promise((resolve) => {
      if (document.body) return resolve();
      const t = setInterval(() => {
        if (document.body) { clearInterval(t); resolve(); }
      }, 50);
    });
  }

  (async function init() {
    await Store.ready;
    await waitBody();
    buildPanel();

    if (isExamPage()) return; // 考试页：只要面板（LLM 答题 + 复制），不挂机不隐身

    bindKeyboardEvents();
    if (Store.get('engineRunning', false)) startEngine(true);

    console.log('[UOOC助手Pro] 初始化完成');
  })();

}
