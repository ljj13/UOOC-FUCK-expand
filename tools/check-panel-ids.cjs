// 面板控件引用校验：bindToggle / on() / syncPanelControls 里引用的所有
// uooc-* 面板 ID 必须存在于 buildPanel / mountDock 的 HTML 模板中。
// v3.1.1~3.1.2 胶囊打不开的根因就是 uooc-disc-on 引用了不存在的控件，
// 抛异常中断 buildPanel 导致后续所有绑定消失——本脚本防止再犯。
// v3.2.0 起停靠条（#uooc-dock-*）是第二套 HTML 模板，同样纳入校验。
const fs = require('node:fs');
const path = require('node:path');

// 可传入目标文件路径（默认 content/content.js）：便于对历史版本跑回归验证
const file = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'content', 'content.js');
const src = fs.readFileSync(file, 'utf8');
console.log('检查文件:', path.relative(path.join(__dirname, '..'), file));

// 1. 提取 HTML 模板集合（兼容 CRLF / LF 行尾）：
//    a) 悬浮面板：div.innerHTML = `...`; document.body.appendChild
//    b) 顶部停靠条：dock.innerHTML = `...`;
const htmlBlocks = [];
const panelMatch = src.match(/div\.innerHTML = `([\s\S]*?)`;\s*document\.body\.appendChild/);
if (!panelMatch) { console.error('无法提取面板 HTML 模板'); process.exit(1); }
htmlBlocks.push({ name: '悬浮面板', html: panelMatch[1] });
const dockMatch = src.match(/dock\.innerHTML = `([\s\S]*?)`;/);
if (dockMatch) htmlBlocks.push({ name: '顶部停靠条', html: dockMatch[1] });
else console.warn('⚠️ 未找到停靠条 HTML 模板（改名了？如是请同步本工具）');

const htmlIds = new Set();
for (const b of htmlBlocks) {
  for (const m of b.html.matchAll(/id="(uooc-[a-z0-9-]+)"/g)) htmlIds.add(m[1]);
}

// 2. 提取 JS 引用的面板 ID（覆盖 getElementById / on() / bindToggle）
const jsRefs = new Set();
for (const m of src.matchAll(/(?:getElementById|bindToggle|\bon)\(\s*'(uooc-[a-z0-9-]+)'/g)) jsRefs.add(m[1]);

// 3. 比对：JS 引用了但 HTML 不存在的 = 会中断 buildPanel 的致命遗漏
const missing = [...jsRefs].filter((id) => !htmlIds.has(id));
// 反向：HTML 有但 JS 不引用（仅提示，可能是有意为之）
const unused = [...htmlIds].filter((id) => !jsRefs.has(id));

console.log('HTML 模板提供的 ID:', htmlIds.size, '个（' + htmlBlocks.map((b) => b.name).join(' + ') + '）');
console.log('JS 引用的面板 ID:', jsRefs.size, '个');

let fail = false;
if (missing.length) {
  console.error('\n❌ 致命：以下 ID 被 JS 引用但 HTML 中不存在，会中断 buildPanel：');
  missing.forEach((id) => console.error('   #' + id));
  fail = true;
}
if (unused.length) {
  console.log('\n提示：以下 ID 存在于 HTML 但 JS 未直接引用（可能由查询选择器或样式使用）：');
  unused.forEach((id) => console.log('   #' + id));
}

// 4. 危险绑定审计：所有 addEventListener 的接收者必须有存在性防护，
//    否则站点 DOM 意外缺失时会抛 "Cannot read properties of null (reading 'addEventListener')"
//    并中断整个 buildPanel / 污染 chrome://extensions 错误页
//    （v3.1.2 胶囊消失、v3.2.0 错误页刷条目的同类根因）。
//
//    预处理（关键）：JS 无法用简单状态机剥离——代码里有 `/[*_`~#>]/g` 这种
//    字符类含反引号的正则字面量，会把朴素剥离器带进模板字符串状态导致其后全部误清空。
//    因此：先按锚点把三大模板（css / 面板 HTML / 停靠条 HTML）的正文挖成空白，
//    再对剩余代码做"正则字面量启发式"感知的字符串剥离。
function blankRegion(s, start, end) {
  return s.slice(0, start) + s.slice(start, end).replace(/[^\n]/g, ' ') + s.slice(end);
}
function preClean(source) {
  let s = source;
  // a) const css = `...`;
  let m = s.match(/const css = `[\s\S]*?`;/);
  if (m) s = blankRegion(s, m.index, m.index + m[0].length);
  // b) 面板 HTML：div.innerHTML = `...`; document.body.appendChild
  m = s.match(/div\.innerHTML = `[\s\S]*?`;\s*\n\s*document\.body\.appendChild/);
  if (m) s = blankRegion(s, m.index, m.index + m[0].length);
  // c) 停靠条 HTML：dock.innerHTML = `...`;
  m = s.match(/dock\.innerHTML = `[\s\S]*?`;/);
  if (m) s = blankRegion(s, m.index, m.index + m[0].length);
  return s;
}

// 字符串/模板/注释剥离（正则字面量感知）：
// 遇 `/` 时看上一个有效字符：标识符/数字/`)`/`]` → 除法；否则 → 正则字面量，
// 直到未转义且不在 [ ] 字符类里的 `/` 结束。
function codeOnlyLines(source) {
  const res = [];
  let state = null; // null | "'" | '"' | '`' | '/*' | 'regex'
  let inClass = false;
  let lastSig = ''; // 上一个有效代码字符（跨行保留，判断除法 vs 正则）
  for (const line of source.split('\n')) {
    let code = '';
    let j = 0;
    while (j < line.length) {
      const ch = line[j], nx = line[j + 1];
      if (state === null) {
        if (ch === '/' && nx === '/') break;                    // 行注释
        if (ch === '/' && nx === '*') { state = '/*'; j += 2; continue; }
        if (ch === '/' ) {
          const isRegex = lastSig === '' || /[([{,;:=!&|?+\-*%<>~^]/.test(lastSig);
          if (isRegex) { state = 'regex'; inClass = false; j++; continue; }
        }
        if (ch === "'" || ch === '"' || ch === '`') { state = ch; j++; continue; }
        code += ch;
        if (!/\s/.test(ch)) lastSig = ch;
        j++;
      } else if (state === '/*') {
        if (ch === '*' && nx === '/') { state = null; j += 2; } else j++;
      } else if (state === "'" || state === '"') {
        if (ch === '\\') { j += 2; continue; }
        if (ch === state) state = null;
        j++;
      } else if (state === '`') {
        if (ch === '\\') { j += 2; continue; }
        if (ch === '`') state = null;
        j++;
      } else { // regex
        if (ch === '\\') { j += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { state = null; lastSig = '/'; }
        j++;
      }
    }
    res.push(code);
  }
  return res;
}

// 计算每行所处的 if 包裹块（栈式括号配对）+ 最内层块起始行（供守卫作用域比对）
const codeLines = codeOnlyLines(preClean(src));
const ALWAYS_PRESENT = new Set(['document', 'window']);

const enclosingConds = [];   // lineIdx -> [cond 文本…]
const innermostOpener = [];  // lineIdx -> 最内层 { 所在行号（无则 -1）
{
  const stack = []; // { opener, cond }
  for (let i = 0; i < codeLines.length; i++) {
    const st = codeLines[i];
    // 行首快照（供本行的绑定判断使用）
    enclosingConds[i] = stack.map((s) => s.cond).filter(Boolean);
    innermostOpener[i] = stack.length ? stack[stack.length - 1].opener : -1;
    // ⚠️ 花括号必须按出现顺序逐个处理（先开后关）：
    // 一行内的平衡结构（如 `try { ... } catch (e) { ... }`）若按
    // "先弹后压"处理，会把外层作用域（如 if (ball) {）误弹出。
    for (let k = 0; k < st.length; k++) {
      const ch = st[k];
      if (ch === '{') {
        const before = st.slice(0, k);
        const ifm = before.match(/if\s*\(((?:[^()]|\([^()]*\))*)\)\s*$/);
        stack.push({ opener: i, cond: ifm ? ifm[1] : null });
      } else if (ch === '}') {
        if (stack.length) stack.pop();
      }
    }
  }
}

// 提前返回守卫识别：`if (<cond 判空 base>) { … return/throw; }`（含多行块形式）。
// 返回 true 当且仅当该守卫确实让后续代码在 base 为 null 时不可达。
function hasEarlyReturnGuard(base, bindingLineIdx) {
  const baseRe = '\\b' + base.replace(/\$/g, '\\$') + '\\b';
  const nullCondRe = new RegExp(
    '!\\s*' + baseRe + '\\b' +
    '|' + baseRe + '\\s*[!=]==?\\s*(null|undefined)' +
    '|!\\s*\\(\\s*' + baseRe + '\\b');
  const opener = innermostOpener[bindingLineIdx];
  for (let j = bindingLineIdx - 1; j >= 0 && j > bindingLineIdx - 200; j--) {
    const lineStart = codeLines[j].indexOf('if');
    const ifm = codeLines[j].match(/if\s*\(((?:[^()]|\([^()]*\))*)\)\s*\{?/);
    if (ifm && nullCondRe.test(ifm[1])) {
      // 同行 return/throw，或紧邻的 5 行内出现（覆盖多行守卫块）
      if (/\b(return|throw)\b/.test(codeLines[j])) return true;
      for (let k = j + 1; k <= Math.min(j + 5, bindingLineIdx); k++) {
        if (/\b(return|throw)\b/.test(codeLines[k])) return true;
      }
      // 守卫在 if 块里、return 更远：视为未防护（保守放过，宁可少报）
      return false;
    }
    // 扫到与绑定同层的语句边界（同层块的关括号）即停
    if (innermostOpener[j] !== opener && innermostOpener[j] < opener && lineStart === 0) {
      // 仅当该行是纯粹的作用域边界时停止扫描
      if (/^\s*\}?;?\s*$/.test(codeLines[j])) break;
    }
  }
  return false;
}

const unsafe = [];
for (let i = 0; i < codeLines.length; i++) {
  const st = codeLines[i];

  // 规则 A：querySelector/getElementById 的结果直接链式调 addEventListener
  // —— 查询结果可为 null 且没有内联判空的余地，一律视为缺陷。
  const chain = st.match(/(querySelector|getElementById)\s*\([^()]*\)[^;]*\.addEventListener\s*\(/);
  if (chain) {
    unsafe.push({ line: i + 1, code: st.trim().slice(0, 90), why: '查询结果未判空直接链式绑定' });
    continue;
  }

  // 规则 B：标识符接收者（可能由查询赋值而来）必须有存在性防护
  const m = st.match(/([A-Za-z_$][\w$]*)\s*\.addEventListener\s*\(/);
  if (!m) continue;
  const base = m[1];
  if (ALWAYS_PRESENT.has(base) || base === 'chrome') continue;
  const baseRe = '\\b' + base.replace(/\$/g, '\\$') + '\\b';
  const recvIdx = st.indexOf('.' + m[1] + '.addEventListener') >= 0
    ? st.indexOf('.' + m[1] + '.addEventListener')
    : st.indexOf('.addEventListener');

  let guarded = false;

  // a) 同一行内联判空：addEventListener 之前的文本里出现 if (...base...) 或 base &&
  const prefix = st.slice(0, recvIdx);
  if (new RegExp('if\\s*\\([^)]*' + baseRe).test(prefix)) guarded = true;
  if (new RegExp(baseRe + '\\s*&&').test(prefix)) guarded = true;

  // b) 处于某个 if (… base …) { } 包裹块内（如 if (ball) { ball.addEventListener… }）
  if (!guarded && enclosingConds[i].some((c) => new RegExp(baseRe).test(c))) guarded = true;

  // c) 同一块内先有提前返回守卫：if (!base …) { … return; }
  if (!guarded && hasEarlyReturnGuard(base, i)) guarded = true;

  if (!guarded) unsafe.push({ line: i + 1, code: st.trim().slice(0, 90), why: '接收者未见存在性判空' });
}
if (unsafe.length) {
  console.error('\n❌ 致命：以下 addEventListener 的接收者未见存在性防护（站点 DOM 意外缺失时会抛 null 错误并中断面板）：');
  unsafe.forEach((u) => console.error('   第 ' + u.line + ' 行 [' + u.why + ']: ' + u.code));
  fail = true;
} else {
  console.log('\n✅ 事件绑定防护审计通过（所有 addEventListener 接收者均有判空或恒存在）');
}

if (!fail) console.log('\n✅ 面板控件引用校验通过');
process.exit(fail ? 1 : 0);
