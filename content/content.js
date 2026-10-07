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
  let wasPopActive = false;       // 上一轮弹窗是否可见（检测"新一轮弹窗"）
  let lastSuccessIdx = -1;        // 目录雷达上次成功命中的索引
  let wakeLock = null;            // 屏幕常亮锁
  let endReached = false;         // 已到课程末尾（防止封顶后反复空跳）

  const QUIZ_SEL = '#quizLayer, .smallTest-view';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  console.log('[UOOC助手Pro] content script 已加载:', location.href);

  // ==================== 4. 日志（面板未创建前进缓冲区） ====================
  const logBuf = [];
  function log(m) {
    const l = document.getElementById('uooc-log');
    if (l) {
      const d = document.createElement('div');
      d.textContent = '> ' + m;
      l.appendChild(d);
      l.scrollTop = l.scrollHeight;
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
  function unlockPage() {
    document.querySelectorAll('.layui-layer-shade').forEach((el) => el.remove());
    document.body.classList.remove('layui-layer-lock', 'layui-layer-nobg');
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
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

  // 🤖 第二层：嗅探失败且 LLM 已启用时，把题面发给大模型要一个字母答案
  async function llmPopupMask(layer, inputs) {
    if (!Store.get('llmEnabled', false)) return null;
    const c = Store.get('llmConfig', null);
    if (!c || !c.baseUrl || !c.apiKey) return null;

    const qEl = layer.querySelector('.ti-q-c');
    const opts = Array.from(layer.querySelectorAll('.ti-alist > div, label.ti-a'));
    if (!qEl || !opts.length) return null;

    let prompt = '请回答以下选择题，只返回答案选项字母（多选如 AB），不要任何解释。\n\n';
    prompt += `题目：${qEl.innerText.trim()}\n`;
    opts.forEach((o, i) => {
      const t = o.innerText.trim().replace(/^[A-H]\s*[.、,，:：]\s*/, '');
      prompt += `${String.fromCharCode(65 + i)}. ${t}\n`;
    });

    const res = await llmChat([{ role: 'user', content: prompt }], 0.1);
    if (!res || !res.ok) {
      log('🤖 LLM 调用失败：' + ((res && (res.error || 'HTTP ' + res.status)) || '未知错误'));
      return null;
    }
    const text = (res.data && res.data.choices && res.data.choices[0] &&
      res.data.choices[0].message && res.data.choices[0].message.content) || '';
    const letters = (text.match(/[A-H]/g) || []).slice(0, inputs.length);
    if (!letters.length) return null;

    let mask = 0;
    for (const L of new Set(letters)) {
      const inp = inputs[L.charCodeAt(0) - 65];
      if (inp) mask |= (1 << inputs.indexOf(inp));
    }
    return mask ? { mask, letters: [...new Set(letters)].join('') } : null;
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

  // 🎯 主入口：嗅探 -> LLM -> 穷举，交一次卷后自动收尾
  async function handlePopupQuiz(layer) {
    if (!layer || layer.dataset.busy === '1') return;

    const inputs = quizInputs(layer);
    if (!inputs.length || !quizSubmitBtn(layer)) return; // 还没渲染完，或只是空壳

    const sniff = sniffMask(layer, inputs);
    if (!sniff) log(`⚠️ 嗅探未命中（${layer.dataset.sniffFail || '未知原因'}），转入兜底`);

    const tried = Number(layer.dataset.triedMask || 0);
    const qSig = (layer.querySelector('.ti-q-c')?.innerText || '').trim();
    const sec0 = sectionKey();
    const total = (1 << inputs.length) - 1;
    const MAX_TRY = 24;

    // 候选顺序：嗅探命中就只交它自己（多交只会把正确答案覆盖掉）；
    // 否则先问 LLM，再退而求其次逐个试合法组合。
    const order = [];
    let llmMask = null;
    if (sniff) {
      order.push(sniff.mask);
    } else {
      const llm = await llmPopupMask(layer, inputs).catch(() => null);
      if (llm) {
        llmMask = llm.mask;
        order.push(llm.mask);
        log(`🤖 LLM 建议 ${llm.letters}，优先提交`);
      }
      for (let m = 1; m <= total && order.length < MAX_TRY + 1; m++) {
        if ((tried & m) || !maskAchievable(inputs, m)) continue;
        if (!order.includes(m)) order.push(m);
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

        const bits = mask.toString(2).padStart(inputs.length, '0');
        if (sniff && mask === sniff.mask) log(`🎯 内存嗅探命中 ${sniff.letters}，提交…`);
        else if (mask === llmMask) log(`🤖 LLM 答案 ${maskLetters(cur, mask)}，提交…`);
        else log(`🔨 尝试组合 ${bits}`);

        const before = layerText(layer);
        applyMask(cur, mask);
        layer.dataset.triedMask = String(Number(layer.dataset.triedMask || 0) | mask);
        await wait(200);
        clickHard(btn);
        await wait(1200);

        if (!popupVisible(document.querySelector(QUIZ_SEL))) {
          // 弹窗真没了也可能是"页面整体跳走了"，那不是我们答对的
          if (sectionKey() !== sec0) log(`↩️ 弹窗消失但页面已跳转（${bits}），不计为作答成功`);
          else log(`✅ 弹窗已关闭（${bits}），作答成功`);
          accepted = true;
          break;
        }

        // 🎯 题目块内容变了 = 站点已受理这次交卷
        const after = layerText(layer);
        if (after !== before) {
          log(`🎯 交卷已受理（${bits}）${verdict(after)}，自动收尾`);
          accepted = true;
          break;
        }
        // 内容没变 = 这次点击没被受理，换下一个候选再试
      }

      if (!accepted) {
        log('⚠️ 交卷没有收到站点响应，已直接收尾（诊断如下）');
        quizDiagnose(layer);
      }
    } catch (e) {
      console.error(e);
    } finally {
      finishPopupQuiz(layer); // 🧹 无论结果如何都自动收尾
      layer.dataset.busy = '0';
    }
  }

  function maskLetters(inputs, mask) {
    const out = [];
    inputs.forEach((inp, j) => { if (mask & (1 << j)) out.push(String.fromCharCode(65 + j)); });
    return out.join('');
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
    ensureHeartbeat();
    endReached = false;

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
    if (!b) return;
    if (engineStarted) { b.className = 'running'; b.innerText = '⏹ 停止挂机'; }
    else { b.className = ''; b.innerText = '🚀 点火启动'; }
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
        isRadio: isRadio
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

    log('📡 正在调用 LLM API...');
    const prompt = buildPrompt(questions);
    const res = await llmChat([
      { role: 'system', content: '你是一个专业的答题助手，请严格按照要求的格式返回答案。' },
      { role: 'user', content: prompt }
    ], 0.3);

    if (!res || !res.ok) {
      const why = res ? (res.error || `HTTP ${res.status}`) : '未知错误';
      log(`❌ LLM 调用失败: ${why}`);
      alert(`AI答题失败: ${why}\n请检查API配置是否正确。`);
      return null;
    }

    const answerText = (res.data && res.data.choices && res.data.choices[0] &&
      res.data.choices[0].message && res.data.choices[0].message.content) || '';
    console.log('[UOOC助手-AI] LLM返回:', answerText);
    return parseAnswers(answerText, questions);
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

  function buildPanel() {
    if (document.getElementById('uooc-video-panel')) return;

    const css = `
        #uooc-video-panel { position:fixed; top:20px; left:20px; width:216px; background:rgba(20,20,20,0.88); color:#fff; z-index:2147483647; pointer-events:auto; border-radius:8px; box-shadow:0 4px 15px rgba(0,0,0,0.5); border:1px solid #3498db; backdrop-filter:blur(5px); font-family:sans-serif; display:block; }
        #uooc-drag-bar { padding:8px 12px; background:#2980b9; cursor:move; border-radius:8px 8px 0 0; font-size:12px; font-weight:bold; display:flex; justify-content:space-between; align-items:center; user-select:none; }
        #uooc-drag-bar .uooc-bar-icons span { cursor:pointer; margin-left:6px; }
        #uooc-min-ball { position:fixed; top:20px; left:20px; width:40px; height:40px; background:#2980b9; border-radius:50%; z-index:2147483647; pointer-events:auto; display:none; align-items:center; justify-content:center; cursor:move; box-shadow:0 4px 10px rgba(0,0,0,0.5); font-size:16px; user-select:none; border:2px solid #fff; }
        #uooc-start-btn { flex:1; padding:8px 0; background:#e74c3c; color:white; border:none; border-radius:4px; font-weight:bold; cursor:pointer; transition:0.3s; font-size:12px; }
        #uooc-start-btn:hover { background:#c0392b; }
        #uooc-start-btn.running { background:#27ae60; }
        #uooc-start-btn.running:hover { background:#219a52; }
        #uooc-refresh-btn { width:35px; background:#f39c12; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold; }
        #uooc-unlock-btn { width:35px; background:#8e44ad; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold; }
        .uooc-row { display:flex; align-items:center; gap:7px; margin-bottom:6px; font-size:12px; color:#ccc; flex-wrap:wrap; }
        .uooc-row label { display:flex; align-items:center; gap:3px; cursor:pointer; user-select:none; }
        .uooc-row input[type=checkbox] { width:12px; height:12px; margin:0; cursor:pointer; }
        #uooc-rate-value { background:#111; color:#0f0; border:1px solid #333; border-radius:3px; font-size:11px; padding:1px 2px; cursor:pointer; }
        #uooc-llm-set { cursor:pointer; font-size:14px; }
        #uooc-answer-btn { flex:1; padding:4px 10px; font-size:12px; background:linear-gradient(135deg,#667eea 0%,#764ba2 100%); color:white; border:none; border-radius:4px; cursor:pointer; transition:all 0.3s; }
        #uooc-copy-btn { flex:1; padding:4px 10px; font-size:12px; background:#34495e; color:#ecf0f1; border:1px solid #46637f; border-radius:4px; cursor:pointer; }
        #uooc-log { height:64px; background:#111; color:#0f0; overflow-y:auto; padding:5px; border-radius:4px; font-family:monospace; font-size:10px; line-height:1.4; }
        #uooc-log div { word-break:break-all; }
    `;
    const style = document.createElement('style');
    style.innerHTML = css;
    document.head.appendChild(style);

    const div = document.createElement('div');
    div.innerHTML = `
        <div id="uooc-video-panel">
          <div id="uooc-drag-bar">
            <span>🤖 UOOC助手 Pro</span>
            <span class="uooc-bar-icons"><span id="uooc-set-btn" title="设置（API 配置）">⚙️</span><span id="uooc-min-btn" title="收起">➖</span></span>
          </div>
          <div style="padding:10px;">
            <div id="uooc-engine-row" style="display:flex; gap:5px; margin-bottom:7px;">
              <button id="uooc-start-btn" title="全自动挂机：接管视频、秒杀弹窗、自动跳章节">🚀 点火启动</button>
              <button id="uooc-refresh-btn" title="强制刷新网页重启兜底">🔄</button>
              <button id="uooc-unlock-btn" title="急救：清理卡死的弹窗遮罩，恢复页面点击与播放">🧹</button>
            </div>
            <div id="uooc-helper-rows">
              <div class="uooc-row">
                <label><input type="checkbox" id="uooc-rate-on">倍速</label>
                <select id="uooc-rate-value">
                  <option value="1">1.0x</option>
                  <option value="1.25">1.25x</option>
                  <option value="1.5">1.5x</option>
                  <option value="2">2.0x</option>
                  <option value="2.5">2.5x</option>
                  <option value="3">3.0x</option>
                </select>
                <label><input type="checkbox" id="uooc-mute-on">静音</label>
              </div>
              <div class="uooc-row">
                <label title="自动播放并拦截站点暂停（空格键切换）"><input type="checkbox" id="uooc-play-on">播放</label>
                <label title="播完自动跳下一节"><input type="checkbox" id="uooc-continue-on">连播</label>
                <label title="视频弹窗小题自动作答（嗅探/LLM/穷举）"><input type="checkbox" id="uooc-popup-on">弹窗秒答</label>
              </div>
            </div>
            <div class="uooc-row" id="uooc-llm-row">
              <span id="uooc-llm-set" title="配置AI答题参数">⚙️</span>
              <label><input type="checkbox" id="uooc-llm-on">LLM答题</label>
              <button id="uooc-answer-btn">🤖 开始答题</button>
            </div>
            <div class="uooc-row">
              <button id="uooc-copy-btn" title="在已提交的测验回顾页，复制题目与答案到剪切板">📋 复制题目答案</button>
            </div>
            <div id="uooc-log">等待点火...</div>
          </div>
        </div>
        <div id="uooc-min-ball" title="展开">🤖</div>
    `;
    document.body.appendChild(div);
    flushLog();

    const panel = document.getElementById('uooc-video-panel');
    const ball = document.getElementById('uooc-min-ball');
    const dragBar = document.getElementById('uooc-drag-bar');
    const startBtn = document.getElementById('uooc-start-btn');

    // ---- 事件绑定 ----
    document.getElementById('uooc-refresh-btn').onclick = () => {
      log('🔄 正在强制刷新页面...');
      setTimeout(() => location.reload(), 200);
    };

    document.getElementById('uooc-unlock-btn').onclick = () => {
      finishPopupQuiz(document.querySelector('#quizLayer, .smallTest-view'));
      log('🧹 已清理遮罩、解锁页面并尝试恢复播放');
    };

    startBtn.onclick = () => (engineStarted ? stopEngine() : startEngine(false));

    document.getElementById('uooc-set-btn').onclick = openLLMSettings;
    document.getElementById('uooc-llm-set').onclick = openLLMSettings;

    document.getElementById('uooc-copy-btn').onclick = copyAnswersClick;

    // 复选框 <-> 存储
    const bindToggle = (id, key, onChange) => {
      const el = document.getElementById(id);
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

    document.getElementById('uooc-rate-value').addEventListener('change', (e) => {
      Store.set({ rateValue: Number(e.target.value) || 2 });
      const v = currentVideo();
      if (v && Store.get('rateOn', true)) v.playbackRate = Number(e.target.value) || 2;
    });

    document.getElementById('uooc-llm-on').addEventListener('change', async (e) => {
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
    });

    document.getElementById('uooc-answer-btn').onclick = async function () {
      if (!Store.get('llmEnabled', false)) {
        alert('请先勾选"LLM答题"复选框！');
        return;
      }
      const btn = this;
      btn.disabled = true;
      btn.innerHTML = '⏳ 正在答题...';
      btn.style.opacity = '0.7';
      try {
        await autoAnswerQuiz();
        btn.innerHTML = '✅ 答题完成';
        btn.style.background = '#28a745';
        setTimeout(() => resetAnswerBtn(btn), 3000);
      } catch (error) {
        console.error(error);
        btn.innerHTML = '❌ 答题失败';
        btn.style.background = '#dc3545';
        setTimeout(() => resetAnswerBtn(btn), 2000);
      }
    };

    function resetAnswerBtn(btn) {
      btn.disabled = false;
      btn.innerHTML = '🤖 开始答题';
      btn.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
      btn.style.opacity = Store.get('llmEnabled', false) ? '1' : '0.5';
    }

    // ---- 拖拽与最小化 ----
    let isDragging = false, startX, startY, initLeft, initTop;
    dragBar.onmousedown = ball.onmousedown = (e) => {
      isDragging = true;
      startX = e.clientX; startY = e.clientY;
      const t = panel.style.display !== 'none' ? panel : ball;
      initLeft = t.offsetLeft; initTop = t.offsetTop;
    };
    document.onmousemove = (e) => {
      if (!isDragging) return;
      const t = panel.style.display !== 'none' ? panel : ball;
      t.style.left = (initLeft + e.clientX - startX) + 'px';
      t.style.top = (initTop + e.clientY - startY) + 'px';
    };
    document.onmouseup = () => { isDragging = false; };
    document.getElementById('uooc-min-btn').onclick = () => {
      panel.style.display = 'none';
      ball.style.display = 'flex';
    };
    ball.onclick = () => {
      ball.style.display = 'none';
      panel.style.display = 'block';
    };

    // ---- 考试页精简：隐藏挂机/视频相关控件 ----
    if (isExamPage()) {
      document.getElementById('uooc-engine-row').style.display = 'none';
      document.getElementById('uooc-helper-rows').style.display = 'none';
      log('📄 测评页面模式：配置好 API 后点「🤖 开始答题」');
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
        const isAttachment = window.location.href.includes('/files')
          || /(附件|讨论)/.test(activeName)
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
