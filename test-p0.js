/* P0 上线前 jsdom 真实断言（2026-09-27）
   加载方式：把主 <script>（380 行起）从 HTML 里剥出来，用 JSDOM 重建 DOM 骨架，
   再 window.eval 注入脚本正文。脚本注入时 DOMContentLoaded 已错过，init 不会跑——
   正是实施手册要求的「跳过 init 的 DOMContentLoaded 绑定」。测试自己摆好 D 再驱动。 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DIR = __dirname;
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

const scriptMatch = html.match(/<script>\n[\s\S]*?<\/script>/);
if (!scriptMatch) { console.error('FATAL: 主 <script> 块没找到'); process.exit(2); }
const scriptBody = scriptMatch[0].replace(/^<script>\n/, '').replace(/<\/script>$/, '');
const stripped = html.replace(/<script>\n[\s\S]*?<\/script>/, '');

/* 跳过 init 的 DOMContentLoaded 绑定（实施手册要求），其余原样注入 */
const bodyNoInit = scriptBody.replace(
  "document.addEventListener('DOMContentLoaded', init);",
  '/* P0 测试：DOMContentLoaded 绑定已剥离，init 不跑 */'
);

/* 关键：不能走 window.eval——主脚本带 'use strict'，严格 eval 的绑定不落全局。
   用真实 <script> 元素注入（runScripts:dangerously），与浏览器执行形态一致。 */
const dom = new JSDOM(stripped, { url: 'https://tineng.local/', pretendToBeVisual: true, runScripts: 'dangerously' });
const w = dom.window;
const injector = w.document.createElement('script');
injector.textContent = bodyNoInit;
w.document.body.appendChild(injector); // readyState 已 complete，DOMContentLoaded 已错过 → init 不会跑

let loadErr = null;
try { w.eval('window.__appLoaded = (typeof defaultData === "function") && (typeof CONFIG !== "undefined")'); } catch (e) { loadErr = e; }
if (loadErr || w.eval('window.__appLoaded') !== true) loadErr = loadErr || new Error('脚本注入后全局绑定缺失');

/* 线上明文备份提前注入（① 数据态与 ③ normalizeData 共用） */
const backupRaw = JSON.parse(fs.readFileSync(path.join(DIR, 'backup-20260927', 'data-main.json'), 'utf8'));
w.eval('window.__bkBackup = ' + JSON.stringify(backupRaw) + ';');

const results = [];
function check(name, fn) {
  try { const detail = fn(); results.push({ ok: true, name, detail: detail || '' }); }
  catch (e) { results.push({ ok: false, name, detail: (e && e.message) || String(e) }); }
}

/* ---------- ① PAGES 七页逐页 render，双态验证（蓝图 W8 口径：不抛异常 + innerHTML>500 + 含关键字） ----------
   空数据态：new install 占位卡（每页验证「不抛异常 + 空态关键字」——空态卡本来就短，不硬凑 500）
   线上数据态：normalizeData(线上备份) + 模拟录入 9/23 体测（外部检测 + 家庭体测各一条，
   即发给委托人的录入清单实际形态），验证每页真实渲染 innerHTML>500 */
const PAGES_SPEC = {
  pgToday:   ['renderToday',    'todayBody',    '第一天，从记录开始'],
  pgTrend:   ['renderTrend',    'trendBody',    '趋势从这里开始'],
  pgAbility: ['renderAbility',  'abilityBody',  '能力画像从这里开始'],
  pgGoal:    ['renderGoal',     'goalBody',     '睡眠修复'],
  pgGuide:   ['renderGuideTab', 'guideTabBody', '搜索知识卡标题'],
  pgProfile: ['renderProfile',  'profileBody',  '档案信息'],
  pgTest:    ['renderTest',     'testBody',     '家庭体测']
};
w.eval('D = defaultData();'); // 空数据新装状态
for (const [pg, [fn, bodyId, kw]] of Object.entries(PAGES_SPEC)) {
  check(`①空态 ${pg}：${fn}() 不抛异常且含关键字「${kw}」`, () => {
    if (loadErr) throw loadErr;
    w.eval(fn + '()');
    const h = w.eval(`document.getElementById('${bodyId}').innerHTML`);
    if (h.indexOf(kw) < 0) throw new Error('未找到关键字');
    return `${bodyId} innerHTML = ${h.length} 字符（空态卡）`;
  });
}
check('①空态 pgGoal/pgProfile/pgTest 关键字补查', () => {
  const need = [['goalBody', ['右足康复', '有氧起步']], ['profileBody', ['当前阶段']], ['testBody', ['外部检测录入', '背力']]];
  for (const [id, kws] of need) {
    const h = w.eval(`document.getElementById('${id}').innerHTML`);
    for (const kw of kws) if (h.indexOf(kw) < 0) throw new Error(`${id} 缺关键字「${kw}」`);
  }
  return '命中：右足康复/有氧起步/当前阶段/外部检测录入/背力';
});
w.eval(`D = normalizeData(window.__bkBackup);
  upsertByDate(D.external, recStamp({ date: '2026-09-23', source: '武汉国民体质监测中心',
    items: { '身高': '174.1', '体重': '59.6', '握力': '42.7', '俯卧撑': '22', '坐位体前屈': '-8.1',
      '闭眼单脚站立': '63.07', '选择反应时': '0.59', '背力': '109.1', '血压': '120/76', '静息心率': '60', 'BMI': '19.7' } }));
  upsertByDate(D.tests, recStamp({ date: '2026-09-23', pushupMax: 22, standL: 63.07, standR: 20 }));`);
for (const [pg, [fn, bodyId]] of Object.entries(PAGES_SPEC)) {
  check(`①数据态 ${pg}：${fn}() 不抛异常且 ${bodyId} 内容>500`, () => {
    if (loadErr) throw loadErr;
    w.eval(fn + '()');
    const len = w.eval(`document.getElementById('${bodyId}').innerHTML.length`);
    if (!(len > 500)) throw new Error(`${bodyId} innerHTML 长度 ${len} ≤ 500`);
    return `${bodyId} innerHTML = ${len} 字符`;
  });
}

/* ---------- ② applyTestToPlan 档位判断（9/26 对抗审查：标准俯卧撑对力竭 22 者无效组） ---------- */
check('② pushupMax=22 → strengthReps["下斜俯卧撑"]=11 且不抛异常', () => {
  if (loadErr) throw loadErr;
  w.eval(`D = defaultData();
    var ch1 = applyTestToPlan({ date: '2026-09-27', pushupMax: 22 });
    window.__t1 = { xiaxie: D.state.strengthReps['下斜俯卧撑'], old: D.state.strengthReps['俯卧撑'], changed: ch1.join(' | ') };`);
  const t = w.eval('window.__t1');
  if (t.xiaxie !== 11) throw new Error('strengthReps["下斜俯卧撑"] = ' + t.xiaxie + '，应为 11（22×50%）');
  if (t.old !== 8) throw new Error('旧键"俯卧撑"应保持 8 不删，实际 ' + t.old);
  if (String(t.changed).indexOf('下斜俯卧撑(档位)') < 0) throw new Error('changed 提示缺档位标记：' + t.changed);
  return `下斜俯卧撑=${t.xiaxie}，旧键俯卧撑=${t.old}（保留），changed="${t.changed}"`;
});
check('② pushupMax=15 → strengthReps["俯卧撑"]=8（走标准档）', () => {
  if (loadErr) throw loadErr;
  w.eval(`D = defaultData();
    var ch2 = applyTestToPlan({ date: '2026-09-27', pushupMax: 15 });
    window.__t2 = { push: D.state.strengthReps['俯卧撑'], xiaxie: D.state.strengthReps['下斜俯卧撑'], changed: ch2.join(' | ') };`);
  const t = w.eval('window.__t2');
  if (t.push !== 8) throw new Error('strengthReps["俯卧撑"] = ' + t.push + '，应为 8（15×50%=7.5 → 四舍五入 8）');
  if (t.xiaxie !== undefined) throw new Error('不应创建"下斜俯卧撑"，实际 ' + t.xiaxie);
  return `俯卧撑=${t.push}，下斜俯卧撑未创建，changed="${t.changed}"`;
});

/* ---------- ③ normalizeData 双数据不抛异常 ---------- */
check('③ normalizeData({}) 不抛异常', () => {
  if (loadErr) throw loadErr;
  w.eval('window.__n1 = normalizeData({})');
  const keys = w.eval('Object.keys(window.__n1).join(",")');
  return '返回对象，顶层键：' + keys;
});
check('③ normalizeData(backup-20260927/data-main.json) 不抛异常', () => {
  if (loadErr) throw loadErr;
  w.eval('window.__n2 = normalizeData(window.__bkBackup)');
  const size = w.eval('JSON.stringify(window.__n2).length');
  return '线上明文数据归一化通过，输出 ' + size + ' 字符';
});

/* ---------- ④ 四处改动的运行时直证 ---------- */
check('④ 动作库含下斜俯卧撑（name/repsKey 对齐，sets=3）', () => {
  if (loadErr) throw loadErr;
  const ok = w.eval("CONFIG.actions.some(a => a.name === '下斜俯卧撑' && a.repsKey === '下斜俯卧撑' && a.sets === 3)");
  if (!ok) throw new Error('CONFIG.actions 缺条目或字段不对');
  return '已就位（动作库共 ' + w.eval('CONFIG.actions.length') + ' 个动作）';
});
check('④ ACTION_TIPS["下斜俯卧撑"] 有 4 条要点', () => {
  if (loadErr) throw loadErr;
  const n = w.eval("(ACTION_TIPS['下斜俯卧撑'] || []).length");
  if (n !== 4) throw new Error('要点条数 ' + n + '，应为 4');
  return '4 条';
});
check('④ CONFIG.externalItems 含「背力」且无重复', () => {
  if (loadErr) throw loadErr;
  const arr = w.eval('CONFIG.externalItems');
  if (arr.indexOf('背力') < 0) throw new Error('缺背力');
  const dup = arr.filter((x, i) => arr.indexOf(x) !== i);
  if (dup.length) throw new Error('出现重复项：' + dup.join(','));
  return arr.length + ' 项：' + arr.join('/');
});

/* ---------- 输出 ---------- */
const fails = results.filter(r => !r.ok);
console.log('================ P0 jsdom 断言报告（node ' + process.version + ' · jsdom ' + require('jsdom/package.json').version + '） ================');
console.log('脚本注入：' + (loadErr ? '失败！' + loadErr.message : '成功（init 未触发，符合预期）'));
for (const r of results) {
  console.log((r.ok ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? ' | ' + r.detail : ''));
}
console.log('================ 合计 ' + results.length + ' 项，通过 ' + (results.length - fails.length) + '，失败 ' + fails.length + ' ================');
process.exit(fails.length || loadErr ? 1 : 0);
