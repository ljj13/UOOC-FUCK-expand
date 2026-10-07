// 面板控件引用校验：bindToggle / on() / syncPanelControls 里引用的所有
// uooc-* 面板 ID 必须存在于 buildPanel 的 HTML 模板中。
// v3.1.1~3.1.2 胶囊打不开的根因就是 uooc-disc-on 引用了不存在的控件，
// 抛异常中断 buildPanel 导致后续所有绑定消失——本脚本防止再犯。
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'content', 'content.js');
const src = fs.readFileSync(file, 'utf8');

// 1. 提取面板 HTML 模板（兼容 CRLF / LF 行尾）
const htmlMatch = src.match(/div\.innerHTML = `([\s\S]*?)`;\s*document\.body\.appendChild/);
if (!htmlMatch) { console.error('无法提取面板 HTML 模板'); process.exit(1); }
const html = htmlMatch[1];
const htmlIds = new Set(
  Array.from(html.matchAll(/id="(uooc-[a-z0-9-]+)"/g)).map((m) => m[1]));

// 2. 提取 JS 引用的面板 ID（覆盖 getElementById / on() / bindToggle）
const jsRefs = new Set();
for (const m of src.matchAll(/(?:getElementById|bindToggle|\bon)\(\s*'(uooc-[a-z0-9-]+)'/g)) jsRefs.add(m[1]);

// 3. 比对：JS 引用了但 HTML 不存在的 = 会中断 buildPanel 的致命遗漏
const missing = [...jsRefs].filter((id) => !htmlIds.has(id));
// 反向：HTML 有但 JS 不引用（仅提示，可能是有意为之）
const unused = [...htmlIds].filter((id) => !jsRefs.has(id));

console.log('面板 HTML 提供的 ID:', htmlIds.size, '个');
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
