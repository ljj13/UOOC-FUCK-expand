// 面板控件引用校验：bindToggle / on() / syncPanelControls 里引用的所有
// uooc-* 面板 ID 必须存在于 buildPanel / mountDock 的 HTML 模板中。
// v3.1.1~3.1.2 胶囊打不开的根因就是 uooc-disc-on 引用了不存在的控件，
// 抛异常中断 buildPanel 导致后续所有绑定消失——本脚本防止再犯。
// v3.2.0 起停靠条（#uooc-dock-*）是第二套 HTML 模板，同样纳入校验。
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'content', 'content.js');
const src = fs.readFileSync(file, 'utf8');

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
if (!fail) console.log('\n✅ 面板控件引用校验通过');
process.exit(fail ? 1 : 0);
