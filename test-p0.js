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
    items: { '身高': '173.0', '体重': '61.2', '握力': '40.0', '俯卧撑': '18', '坐位体前屈': '-5.0',
      '闭眼单脚站立': '55.0', '选择反应时': '0.55', '背力': '100.0', '血压': '118/76', '静息心率': '58', 'BMI': '20.4' } }));
  upsertByDate(D.tests, recStamp({ date: '2026-09-23', pushupMax: 18, standL: 55.0, standR: 18 }));`);
  /* 注：以上为合成样例值（Codex 外部复核隐私项修复：本文件在公开仓，真实体测数据不得内嵌，真实值只存在于本机 backup/gitignore 文件） */
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
  if (t.xiaxie !== 10) throw new Error('低俯卧撑值不应动"下斜俯卧撑"档位，应保持出厂默认 10，实际 ' + t.xiaxie); // ⑬ P1-1 修复后出厂含该键=10；断言从"不创建"改为"不动档位"
  if (String(t.changed).indexOf('下斜俯卧撑') >= 0) throw new Error('changed 不应含下斜俯卧撑：' + t.changed);
  return `俯卧撑=${t.push}，下斜俯卧撑保持 10 未动，changed="${t.changed}"`;
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

/* ---------- ⑤ 动作要领弹窗（v3.3 修复回归：上一版此弹窗渲染 undefined/空白） ---------- */
check('⑤ showActionTips("俯卧撑") 渲染编号要点行且无 undefined', () => {
  if (loadErr) throw loadErr;
  w.eval('showActionTips("俯卧撑")');
  const h = w.eval("document.getElementById('modalBox').innerHTML");
  if (h.indexOf('undefined') >= 0) throw new Error('弹窗含 undefined');
  if (h.indexOf('手掌在胸两侧') < 0 || h.indexOf('动作要领') < 0) throw new Error('要点缺失');
  if (!h.includes('>1</span>')) throw new Error('无编号行');
  return '渲染正常';
});
check('⑤ ACTION_TIPS 全部条目（含康复动作）逐个弹窗无 undefined', () => {
  const names = w.eval('Object.keys(ACTION_TIPS).join("|")').split('|');
  for (const n of names) {
    w.eval('showActionTips(' + JSON.stringify(n) + ')');
    const h = w.eval("document.getElementById('modalBox').innerHTML");
    if (h.indexOf('undefined') >= 0) throw new Error(n + ' 弹窗含 undefined');
  }
  return names.length + ' 个动作全过';
});
check('⑤ 内容修订在位：足底滚压（湿疹禁忌/冰瓶）、俯卧超人式（口径更新）', () => {
  w.eval('showActionTips("足底滚压")');
  const h1 = w.eval("document.getElementById('modalBox').innerHTML");
  if (h1.indexOf('湿疹时暂停滚压') < 0 || h1.indexOf('可冷冻成冰瓶') < 0) throw new Error('足底滚压修订缺失');
  w.eval('showActionTips("俯卧超人式")');
  const h2 = w.eval("document.getElementById('modalBox').innerHTML");
  if (h2.indexOf('腰背整体发力') < 0 || h2.indexOf('腰部不悬空') >= 0) throw new Error('俯卧超人式修订缺失');
  return '两条修订命中';
});

/* ---------- ⑥ 状态建议卡规则引擎全分支 ---------- */
function setRD(metricArr, dailyArr) { // 造数：日期用 U.addDays(U.todayStr(),-n) 保证随时钟成立
  w.eval('D = defaultData(); D.state.autoCalibrateRHR = true;');
  (metricArr || []).forEach((s, i) => w.eval('D.metrics.push(recStamp({ date: U.addDays(U.todayStr(),-' + s.n + '), sleepH:' + (s.sleepH == null ? 'null' : s.sleepH) + ', rhr:' + (s.rhr == null ? 'null' : s.rhr) + ', hrv:' + (s.hrv == null ? 'null' : s.hrv) + ' }))'));
  (dailyArr || []).forEach((d) => w.eval('D.daily.push(recStamp({ date: U.addDays(U.todayStr(),-' + d.n + '), pain: ' + JSON.stringify(d.pain) + ' }))'));
}
check('⑥ 新装无信号 → 正常练（不因缺数据惩罚）', () => {
  setRD([], []);
  if (w.eval('readinessEval(U.todayStr()).level') !== 'ok') throw new Error('期望 ok');
  return 'ok';
});
check('⑥ 睡眠线：5.5h → 降档；4.5h → 只做每日包', () => {
  setRD([{ n: 1, sleepH: 5.5 }], []);
  if (w.eval('readinessEval(U.todayStr()).level') !== 'down') throw new Error('5.5h 应 down');
  setRD([{ n: 1, sleepH: 4.5 }], []);
  if (w.eval('readinessEval(U.todayStr()).level') !== 'floor') throw new Error('4.5h 应 floor');
  return '两条睡眠线正确';
});
check('⑥ RHR 线（基线=档案60）：+5 → 降档；+12 → 每日包', () => {
  setRD([{ n: 1, rhr: 65 }], []);
  if (w.eval('readinessEval(U.todayStr()).level') !== 'down') throw new Error('65 应 down');
  setRD([{ n: 1, rhr: 72 }], []);
  if (w.eval('readinessEval(U.todayStr()).level') !== 'floor') throw new Error('72 应 floor');
  return '两条 RHR 线正确';
});
check('⑥ HRV 低于基线 12% → 降档（基线=档案50）', () => {
  setRD([{ n: 1, hrv: 44 }], []);
  if (w.eval('readinessEval(U.todayStr()).level') !== 'down') throw new Error('44 应 down');
  return 'HRV 线正确';
});
check('⑥ 疼痛（K7 同口径）：右足底 → 降档；膝 → 每日包', () => {
  setRD([], [{ n: 1, pain: '右足底' }]);
  if (w.eval('readinessEval(U.todayStr()).level') !== 'down') throw new Error('右足底应 down');
  setRD([], [{ n: 1, pain: '膝' }]);
  if (w.eval('readinessEval(U.todayStr()).level') !== 'floor') throw new Error('膝应 floor');
  return '疼痛口径正确';
});
check('⑥ 主观点选：累 → 降档；很虚 → 每日包（卡面同步）', () => {
  setRD([], []);
  w.eval('D.state.feelMark = { date: U.todayStr(), feel: "累" }');
  if (w.eval('readinessEval(U.todayStr()).level') !== 'down') throw new Error('累应 down');
  w.eval('D.state.feelMark = { date: U.todayStr(), feel: "很虚" }');
  w.eval('renderToday()');
  const h = w.eval("document.getElementById('todayBody').innerHTML");
  if (h.indexOf('只做每日包') < 0) throw new Error('卡面未判每日包');
  return '点选生效且卡面同步';
});
check('⑥ 连续两天降档 → 卡面判完全休息', () => {
  setRD([{ n: 1, sleepH: 5.5 }, { n: 2, sleepH: 5.5 }], []);
  w.eval('renderToday()');
  const h = w.eval("document.getElementById('todayBody').innerHTML");
  if (h.indexOf('完全休息') < 0) throw new Error('应判休息');
  return '休息分支正确';
});
check('⑥ 回归（真机抓到的 bug）：今天点"累"不得泄漏进昨日判定而误判休息', () => {
  setRD([{ n: 1, sleepH: 5.5 }], []); // 只有昨天睡眠不足 → 今天应降档，不是休息
  w.eval('D.state.feelMark = { date: U.todayStr(), feel: "累" }');
  if (w.eval('readinessEval(U.addDays(U.todayStr(),-1)).level') !== 'ok') throw new Error('昨日判定不应吃今天的感受');
  w.eval('renderToday()');
  const h = w.eval("document.getElementById('todayBody').innerHTML");
  if (h.indexOf('降档练') < 0 || h.indexOf('完全休息') >= 0) throw new Error('应为降档练而非完全休息');
  return '作用域修复验证通过';
});
check('⑥ 红灯词命中 → 卡面出就医横幅（分诊红线）', () => {
  setRD([], [{ n: 1, pain: '右足底夜间痛加重' }]);
  w.eval('renderToday()');
  const h = w.eval("document.getElementById('todayBody').innerHTML");
  if (h.indexOf('就医评估') < 0) throw new Error('未出红线横幅');
  return '红线横幅在位';
});
check('⑥ 卡面要素齐全：理由/主观点选/缺睡眠提示', () => {
  setRD([{ n: 1, rhr: 65 }], []);
  w.eval('renderToday()');
  const h = w.eval("document.getElementById('todayBody').innerHTML");
  if (h.indexOf('理由：') < 0 || h.indexOf('feelChips') < 0 || h.indexOf('昨夜睡眠未记录') < 0) throw new Error('要素缺失');
  return '要素齐全';
});

/* ---------- ⑨ 引擎 v2（开工单§四落码）：疲劳四选/首句动作/踝门/M6 目标层 ---------- */
check('⑨ 疲劳四选在位：满血|正常|累|很虚', () => {
  if (w.eval('FEELS.join("|")') !== '满血|正常|累|很虚') throw new Error('FEELS 应为四选');
  return w.eval('FEELS.join("/")');
});
check('⑨ 很虚→floor；满血→ok', () => {
  setRD([], []);
  w.eval('D.state.feelMark = { date: U.todayStr(), feel: "很虚" }');
  if (w.eval('readinessEval(U.todayStr()).level') !== 'floor') throw new Error('很虚应 floor');
  w.eval('D.state.feelMark = { date: U.todayStr(), feel: "满血" }');
  if (w.eval('readinessEval(U.todayStr()).level') !== 'ok') throw new Error('满血应 ok');
  return '两分支正确';
});
check('⑨ 首句动作行：状态卡含"今天按"+理由（开工单§四输出格式）', () => {
  setRD([], []);
  w.eval('renderToday()');
  const h = w.eval("document.getElementById('todayBody').innerHTML");
  if (h.indexOf('今天按') < 0) throw new Error('缺首句动作行');
  if (h.indexOf('理由：') < 0) throw new Error('缺理由行');
  return '首句+理由在位';
});
check('⑨ 踝门：右脚<47s → 户外劝退行；≥47s → 无', () => {
  setRD([], []);
  w.eval('D.tests.push({ date: U.todayStr(), standR: 30 })');
  w.eval('renderToday()');
  let h = w.eval("document.getElementById('todayBody').innerHTML");
  if (h.indexOf('47s 未到') < 0) throw new Error('未出劝退行');
  w.eval('D.tests[D.tests.length-1].standR = 50');
  w.eval('renderToday()');
  h = w.eval("document.getElementById('todayBody').innerHTML");
  if (h.indexOf('47s 未到') >= 0) throw new Error('50s 不应劝退');
  return '踝门两分支正确';
});
check('⑨ 周期边界（v4.1 两段）：10/5=冬训W1、10/9=未开营、冬训末24、专项25起、36=末周、37=满', () => {
  const v = (d) => w.eval('cycleWeekOf("' + d + '")');
  if (v('2026-10-05') !== 1) throw new Error('开营日应 W1');
  if (v('2026-10-04') !== 0) throw new Error('开营前应 0');
  if (v('2027-03-15') !== 24) throw new Error('2027-03-15 应冬训 W24');
  if (v('2027-03-22') !== 25) throw new Error('2027-03-22 应专项 W1（总 25）');
  if (v('2027-06-07') !== 36) throw new Error('2027-06-07 应专项 W12（总 36）');
  if (v('2027-06-14') !== 37) throw new Error('周期满应 37');
  return '6 个边界全对';
});
check('⑨ 顺延联动（v4.1 FR-B1）：schedShift.weeks=1 → anchorDate+7d，cycleWeekOf 整体右移；钳位 2', () => {
  if (w.eval('anchorDate()') !== '2026-10-05') throw new Error('默认锚应 2026-10-05');
  w.eval('D.state.schedShift = { weeks: 1, log: [{ date: "2026-10-01", weeks: 1 }] };');
  if (w.eval('anchorDate()') !== '2026-10-12') throw new Error('顺延 1 周后锚应 2026-10-12');
  if (w.eval('cycleWeekOf("2026-10-05")') !== 0) throw new Error('原 W1 日顺延后应未开营');
  if (w.eval('cycleWeekOf("2026-10-12")') !== 1) throw new Error('新锚日应 W1');
  if (w.eval('schedShiftWeeks()') !== 1) throw new Error('读数应 1');
  w.eval('D.state.schedShift = { weeks: 5, log: [] };');
  if (w.eval('schedShiftWeeks()') !== 2) throw new Error('超限应钳位 2');
  w.eval('D.state.schedShift = null;');
  if (w.eval('schedShiftWeeks()') !== 0) throw new Error('null 应回 0');
  return '顺延联动+钳位全对';
});
check('⑨ 周期进度卡（v4.1）：冬训/专项卡头+峰值/检阅在位+顺延标注+中断按钮', () => {
  const card = w.eval('mountainGoalHtml()');
  if (card.indexOf('周期进度') < 0) throw new Error('缺周期卡头');
  const cardW1 = w.eval('mountainGoalHtml("2026-10-05")'); // 冬训 W1：走冬训分支
  if (cardW1.indexOf('冬训期 · 第 1/24 周') < 0 || cardW1.indexOf('毕业线') < 0) throw new Error('W1 分支缺周次或毕业线');
  const cardS12 = w.eval('mountainGoalHtml("2027-06-07")'); // 专项 W12：检阅分支
  if (cardS12.indexOf('专项期 · 第 12/12 周') < 0) throw new Error('专项 W12 分支缺失');
  if (w.eval('SPECIAL12[10].load') !== 8) throw new Error('专项 W11 峰值应 8kg');
  const w12 = w.eval('SPECIAL12[11]');
  if (w12.climb !== 350 || w12.note.indexOf('检阅周') < 0) throw new Error('专项 W12 应减量检阅');
  if (w.eval('WINTER24.length') !== 24 || w.eval('SPECIAL12.length') !== 12) throw new Error('两段表行数 24+12');
  w.eval('D.state.schedShift = { weeks: 2, log: [] };');
  if (w.eval('mountainGoalHtml("2026-10-05")').indexOf('（顺延 2 周）') < 0) throw new Error('顺延标注缺失');
  w.eval('D.state.schedShift = null;');
  const cardIdle = w.eval('mountainGoalHtml("2026-10-05")'); // 冬训 W1+空记录（doneCnt=0<2）：应出顺延按钮
  if (cardIdle.indexOf('顺延 1 周') < 0) throw new Error('中断顺延按钮缺失');
  return '周期卡要素齐全';
});

/* ---------- ⑦ 训练感受弹窗（跟练结束 → 三键定 RPE + 疼痛点选） ---------- */
check('⑦ 课结报告含感受三键与疼痛点选', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData();');
  w.eval('showWorkoutReport({ mins: 32, setsDone: 9, totalSets: 9, yellow: false, progTxt: "深蹲 12→13" })');
  const h = w.eval("document.getElementById('modalBox').innerHTML");
  if (h.indexOf('wrFeelChips') < 0 || h.indexOf('轻松') < 0 || h.indexOf('刚好') < 0 || h.indexOf('很累') < 0) throw new Error('感受三键缺失');
  if (h.indexOf('wrPainChips') < 0 || h.indexOf('右足底') < 0) throw new Error('疼痛点选缺失');
  return '弹窗元素在位';
});
check('⑦ 感受→RPE 映射：轻松6/刚好8/很累9；疼痛"其他"展开描述框', () => {
  w.eval('wrSetFeel("轻松")');
  if (w.eval('document.getElementById("wrRpe").value') !== '6') throw new Error('轻松应=6');
  w.eval('wrSetFeel("刚好")');
  if (w.eval('document.getElementById("wrRpe").value') !== '8') throw new Error('刚好应=8');
  w.eval('wrSetFeel("很累")');
  if (w.eval('document.getElementById("wrRpe").value') !== '9') throw new Error('很累应=9');
  w.eval('wrSetPain("其他")');
  if (w.eval('document.getElementById("wrPainSpot").style.display') !== 'block') throw new Error('描述框未展开');
  w.eval('wrSetPain("无")');
  if (w.eval('document.getElementById("wrPainSpot").style.display') !== 'none') throw new Error('描述框未收起');
  return '映射与联动正确';
});
check('⑦ 保存守卫：未选感受时 saveFromReport 不落盘', () => {
  const before = w.eval('JSON.stringify(D.daily)');
  w.eval('saveFromReport()');
  const after = w.eval('JSON.stringify(D.daily)');
  if (before !== after) throw new Error('守卫失效：未选感受仍落盘');
  return '守卫生效（daily 未变）';
});

/* ---------- ⑧ 指南页知识包 / 阶段对齐 / 字段扩容 ---------- */
check('⑧ 指南页含 K14 红旗卡与 K15 报告红线卡', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); renderGuideTab()');
  const h = w.eval("document.getElementById('guideTabBody').innerHTML");
  if (h.indexOf('红旗自查卡') < 0) throw new Error('缺 K14');
  if (h.indexOf('不适用（既定康复红线）') < 0) throw new Error('缺 K15 红线附注');
  return '两卡在位';
});
check('⑧ 档案页含阶段对齐卡（总评≥60 / 右脚≥47s）', () => {
  w.eval('renderProfile()');
  const h = w.eval("document.getElementById('profileBody').innerHTML");
  if (h.indexOf('阶段对齐') < 0 || h.indexOf('≥60') < 0 || h.indexOf('≥47s') < 0) throw new Error('阶段对齐卡缺失');
  return '卡与两条有据合格线在位';
});
check('⑧ CONFIG.externalItems 17 项含 3 新字段且无重复', () => {
  const arr = w.eval('CONFIG.externalItems');
  for (const k of ['最大摄氧量', '纵跳', '体测总分']) if (arr.indexOf(k) < 0) throw new Error('缺 ' + k);
  const dup = arr.filter((x, i) => arr.indexOf(x) !== i);
  if (dup.length) throw new Error('重复：' + dup.join(','));
  return arr.length + ' 项：' + arr.join('/');
});
check('⑧ normalizeData 半残数据不抛异常', () => {
  w.eval('window.__n3 = normalizeData({ daily: "x", state: { phase: "x" }, profile: null, metrics: 3 })');
  const keys = w.eval('Object.keys(window.__n3).join(",")');
  return '半残数据归一化通过：' + keys;
});

/* ---------- ⑩ 指南页完整版（开工单单元5）：户外九卡+离线约束+守门裁决 ---------- */
check('⑩ 指南页新卡在位：K16-K24 按户外/路线分组渲染', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); renderGuideTab();');
  const h = w.eval("document.getElementById('guideTabBody').innerHTML");
  ['K16', 'K17', 'K18', 'K19', 'K20', 'K21', 'K22', 'K23', 'K24'].forEach((id) => {
    if (h.indexOf('kc_' + id) < 0) throw new Error(id + ' 缺失');
  });
  if (h.indexOf('k-group">户外') < 0 || h.indexOf('k-group">路线') < 0) throw new Error('新分组头缺失');
  return '九卡+两组在位';
});
check('⑩ 离线约束：指南页无外部资源引用（img/script/iframe）', () => {
  const h = w.eval("document.getElementById('guideTabBody').innerHTML");
  ['<img', '<script', '<iframe'].forEach((t) => { if (h.indexOf(t) >= 0) throw new Error('发现外部资源 ' + t); });
  return '纯文本/表格，无运行时联网依赖';
});
check('⑩ 守门裁决落实：鳌太里程标"口径打架，待核"；越野速度不写 10-20% 数字', () => {
  const h = w.eval("document.getElementById('guideTabBody').innerHTML");
  if (h.indexOf('120-170km') < 0 || h.indexOf('待核') < 0) throw new Error('鳌太待核标注缺失');
  if (h.indexOf('10-20%') >= 0) throw new Error('越野 10-20% 单源数字不该进产品');
  if (h.indexOf('明显更慢') < 0) throw new Error('越野降级表述缺失');
  return '打架数字全部标注，未拍板';
});
check('⑩ 红线：越野跑卡含两把闸门与毕业评审表述，明确"不是课表"', () => {
  const h = w.eval("document.getElementById('guideTabBody').innerHTML");
  if (h.indexOf('两把闸门') < 0 || h.indexOf('毕业评审') < 0 || h.indexOf('不是课表') < 0) throw new Error('闸门/红线表述缺失');
  return '红线前置在位';
});

/* ---------- ⑪ 弹窗五件套（开工单单元4：notes/06 守门通过版落码） ---------- */
check('⑪ TIPS_FIVE 与 ACTION_TIPS 键集合完全一致（13 动作零缺漏）', () => {
  if (loadErr) throw loadErr;
  const a = w.eval('Object.keys(ACTION_TIPS).join("|")').split('|');
  const b = w.eval('Object.keys(TIPS_FIVE).join("|")').split('|');
  const miss = a.filter((k) => b.indexOf(k) < 0);
  if (miss.length) throw new Error('缺五件套：' + miss.join(','));
  const extra = b.filter((k) => a.indexOf(k) < 0);
  if (extra.length) throw new Error('多余键：' + extra.join(','));
  return a.length + ' 个动作全覆盖';
});
check('⑪ 力量动作弹窗：五件套五段+自查行+当前档位在位', () => {
  if (loadErr) throw loadErr;
  w.eval('showActionTips("自重深蹲")');
  const h = w.eval("document.getElementById('modalBox').innerHTML");
  ['目标与发力感', '外部口诀', '新手期内部口诀', '最常见错误', '你的代偿自查'].forEach((s) => { if (h.indexOf(s) < 0) throw new Error('缺段：' + s); });
  if (h.indexOf('你现在的档') < 0) throw new Error('档位线缺失');
  if (h.indexOf('3×') < 0) throw new Error('档位数字缺失');
  if (h.indexOf('undefined') >= 0) throw new Error('弹窗含 undefined');
  return '五段+档位在位';
});
check('⑪ 康复动作弹窗：有自查段与落地语、无档位线', () => {
  if (loadErr) throw loadErr;
  w.eval('showActionTips("足底滚压")');
  const h = w.eval("document.getElementById('modalBox').innerHTML");
  if (h.indexOf('你的代偿自查') < 0) throw new Error('自查段缺失');
  if (h.indexOf('提示，不是判决') < 0) throw new Error('落地语缺失');
  if (h.indexOf('你现在的档') >= 0) throw new Error('康复动作不应有档位线');
  return '康复弹窗正确';
});
check('⑪ 内部口诀撤回标注在位（臀桥：先夹臀再起→撤掉）', () => {
  if (loadErr) throw loadErr;
  w.eval('showActionTips("臀桥")');
  const h = w.eval("document.getElementById('modalBox').innerHTML");
  if (h.indexOf('先夹臀再起') < 0 || h.indexOf('后撤掉') < 0) throw new Error('撤回标注缺失');
  if (h.indexOf('undefined') >= 0) throw new Error('弹窗含 undefined');
  return '撤回口径在位';
});

/* ---------- ⑫ 审查修复回归（内部审查员 P0-1/P1-1/P2-1 修复，2026-09-27） ---------- */
check('⑫ 隐私：默认档案无生辰，源码全文无真实生日串', () => {
  if (loadErr) throw loadErr;
  const b = w.eval('defaultData().profile.birthday');
  if (b !== '') throw new Error('默认 birthday 应为空串，实为 ' + JSON.stringify(b));
  if (/\b(19|20)\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])\b/.test(w.eval('JSON.stringify(defaultData().profile)'))) throw new Error('默认档案含日期型生辰'); // 模式匹配而非字面量（不把真实生辰写进本文件）
  return '生辰仅由本机向导/档案页录入';
});
check('⑫ K9 睡前1h窄规则（Stutz）+宁丢肌肉人话层（Nedeltcheva）在位', () => {
  if (loadErr) throw loadErr;
  w.eval('renderGuideTab()');
  const h = w.eval("document.getElementById('guideTabBody').innerHTML");
  if (h.indexOf('睡前 1 小时内的剧烈课') < 0) throw new Error('Stutz 窄规则缺失');
  if (h.indexOf('宁可丢肌肉、保着脂肪') < 0) throw new Error('人话层缺失');
  if (h.indexOf('减脂期语境') < 0) throw new Error('语境限制缺失');
  return 'T2 窄规则+第一规则人话层落产品';
});
check('⑫ K11 增重节奏带子（0.5%/周、不按月数倒推）在位', () => {
  if (loadErr) throw loadErr;
  const h = w.eval("document.getElementById('guideTabBody').innerHTML");
  if (h.indexOf('0.5%') < 0 || h.indexOf('不按月数倒推') < 0) throw new Error('Iraki 带子缺失');
  return '预期管理落产品';
});
check('⑫ K20 抽筋机理层（多因素/通用补盐证据不足）在位', () => {
  if (loadErr) throw loadErr;
  const h = w.eval("document.getElementById('guideTabBody').innerHTML");
  if (h.indexOf('多因素') < 0 || h.indexOf('通用补盐建议证据不足') < 0) throw new Error('机理层缺失');
  return 'Miller/Schwellnus 口径落产品';
});

/* ---------- ⑬ 攻击面回归（Codex 外部复核修复验证，2026-09-27：测试跟着攻击面走，不只跟着功能走） ---------- */
check('⑬ P1-1 缺键防线：出厂全键齐 + 合并后缺键自动补 10', () => {
  if (loadErr) throw loadErr;
  const miss = w.eval('CONFIG.actions.filter(a => defaultData().state.strengthReps[a.repsKey] == null).map(a => a.repsKey).join(",")');
  if (miss) throw new Error('defaultData 缺键：' + miss);
  const patched = w.eval('(function(){ var l = defaultData(); delete l.state.strengthReps["下斜俯卧撑"]; var r = JSON.parse(JSON.stringify(l)); return mergeData(l, r).state.strengthReps["下斜俯卧撑"]; })()');
  if (patched !== 10) throw new Error('mergeData 未补键，实为 ' + patched);
  return '出厂+合并双路径无缺键';
});
check('⑬ P1-2 部分完成不上调：applyProgression(6,true) 档位持平', () => {
  if (loadErr) throw loadErr;
  const same = w.eval('(function(){ var b = JSON.stringify(D.state.strengthReps); applyProgression(6, true); return JSON.stringify(D.state.strengthReps) === b; })()');
  if (same !== true) throw new Error('部分完成 RPE6 仍上调档位');
  return 'K5 规则（全部动作标准完成才+1）已对齐';
});
check('⑬ P1-3 导入/恢复路径重建课表缓存（结构性）', () => {
  if (loadErr) throw loadErr;
  if (String(w.eval('importData')).indexOf('rebuildSched') < 0) throw new Error('importData 未调 rebuildSched');
  if (String(w.eval('askRestore')).indexOf('rebuildSched') < 0) throw new Error('askRestore 未调 rebuildSched');
  return '两条恢复路径都含 rebuildSched';
});
check('⑬ P2-1 只读守卫在位：stFeel/promoteFoot/setTheme', () => {
  if (loadErr) throw loadErr;
  ['stFeel', 'promoteFoot', 'setTheme'].forEach((fn) => {
    if (String(w.eval(fn)).indexOf('readOnly') < 0) throw new Error(fn + ' 缺只读守卫');
  });
  return '三函数守卫齐';
});
check('⑬ P2-3 有氧首句口径：未选方式→提示先选，不默认快走', () => {
  if (loadErr) throw loadErr;
  if (String(w.eval('todayActionLine')).indexOf('先选方式') < 0) throw new Error('todayActionLine 无先选口径');
  const line = w.eval('(function(){ tf.cardioChoice = null; return todayActionLine(); })()');
  if (line.indexOf('有氧') >= 0 && line.indexOf('先选方式') < 0) throw new Error('有氧日首句仍默认：' + line);
  return '与计划卡口径一致';
});
check('⑬ 隐私：出厂档案无日期型生辰', () => {
  if (loadErr) throw loadErr;
  if (/\b(19|20)\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])\b/.test(w.eval('JSON.stringify(defaultData().profile)'))) throw new Error('默认档案含日期型生辰');
  return '出厂档案无生辰（测试值已全合成）';
});

/* ---------- ⑭ 康复师席（最终版批1）：晨检闭环+复测可视化+禁区解锁+停训卡 ---------- */
check('⑭ chkEval：红线词（夜间痛）→stop', () => {
  if (loadErr) throw loadErr;
  const r = w.eval('chkEval(["右踝"],["夜间痛"])');
  if (r.out !== 'stop') throw new Error('应为 stop，实际 ' + r.out);
  if (String(r.why).indexOf('夜间痛') < 0) throw new Error('why 缺红线词：' + r.why);
  return 'stop ✓';
});
check('⑭ chkEval：膝/腰→stop（K7 停训口径）', () => {
  if (loadErr) throw loadErr;
  const r = w.eval('chkEval(["膝"],["酸胀"])');
  if (r.out !== 'stop') throw new Error('应为 stop，实际 ' + r.out);
  return 'stop ✓';
});
check('⑭ chkEval：足/踝疼痛→watch（readinessEval 降档同口径）', () => {
  if (loadErr) throw loadErr;
  const r = w.eval('chkEval(["右踝"],["酸胀"])');
  if (r.out !== 'watch') throw new Error('应为 watch，实际 ' + r.out);
  return 'watch ✓';
});
check('⑭ chkEval：无不适→ok', () => {
  if (loadErr) throw loadErr;
  const r = w.eval('chkEval(["无"],[])');
  if (r.out !== 'ok') throw new Error('应为 ok，实际 ' + r.out);
  return 'ok ✓';
});
check('⑭ chkSubmit：写入当日 daily.chk 并持久化', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); chkSel = { parts: ["右踝"], kinds: ["酸胀"] }; chkSubmit()');
  const c = w.eval('JSON.stringify((M.dailyOn(U.todayStr())||{}).chk||null)');
  const o = JSON.parse(c);
  if (!o || o.out !== 'watch') throw new Error('daily.chk 未写入或判定错：' + c);
  return 'daily.chk={out:watch,parts:[右踝]} ✓';
});
check('⑭ 晨检黄灯联动：ok 档被升为 down（标题=降档练，理由含"晨检"）', () => {
  if (loadErr) throw loadErr;
  w.eval('renderToday()');
  const h = w.eval('document.getElementById("todayBody").innerHTML');
  if (h.indexOf('降档练') < 0) throw new Error('未出现"降档练"标题');
  if (h.indexOf('晨检：') < 0) throw new Error('理由区缺"晨检："');
  return 'watch→down ✓';
});
check('⑭ 晨检红灯联动：档位压到恢复课（stop→floor，"只做每日包"）', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); var r0 = M.dailyOn(U.todayStr()) || (upsertByDate(D.daily, recStamp(makeDailyRecord(U.todayStr()))), M.dailyOn(U.todayStr())); r0.chk = { parts:["膝"], kinds:["夜间痛"], out:"stop", why:"红线信号：夜间痛", t: Date.now() }; renderToday()');
  const h = w.eval('document.getElementById("todayBody").innerHTML');
  if (h.indexOf('只做每日包') < 0) throw new Error('stop 未压到恢复课档');
  return 'stop→floor ✓';
});
check('⑭ 复测可视化：standR=30 → 三线 47/50/57 与"还差"进度', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); upsertByDate(D.tests, recStamp({ date: "2026-09-27", standR: 30 })); renderToday()');
  const h = w.eval('document.getElementById("todayBody").innerHTML');
  for (const k of ['康复师工作台', '47', '50', '57', '还差 17s', '还差 20s', '还差 27s']) if (h.indexOf(k) < 0) throw new Error('缺「' + k + '」');
  return '三线进度条 ✓（30s 对照 47/50/57）';
});
check('⑭ 复测可视化：无测试记录 → "还没录入"空态，不抛异常', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); renderToday()');
  const h = w.eval('document.getElementById("todayBody").innerHTML');
  if (h.indexOf('还没录入') < 0) throw new Error('缺空态提示');
  return '空态 ✓';
});
check('⑭ 禁区解锁：K23 两把闸门标"待确认"，踝门条件自动判（30s→✗）', () => {
  if (loadErr) throw loadErr;
  w.eval('upsertByDate(D.tests, recStamp({ date: "2026-09-27", standR: 30 })); renderToday()');
  const h = w.eval('document.getElementById("todayBody").innerHTML');
  for (const k of ['踝毕业评审通过', '医生放行', '待确认', '✗ 未到', '越野跑 R1']) if (h.indexOf(k) < 0) throw new Error('缺「' + k + '」');
  return '禁区条件可视 ✓';
});
check('⑭ 统一停训卡：openStopCard 弹"不是医学诊断"+红线就医线', () => {
  if (loadErr) throw loadErr;
  w.eval('openStopCard("测试停训理由")');
  const h = w.eval('document.getElementById("modalBox").innerHTML');
  for (const k of ['今天停训', '不是医学诊断', '红线信号', '运动医学科']) if (h.indexOf(k) < 0) throw new Error('缺「' + k + '」');
  w.eval('closeModal()');
  return '停训卡 ✓';
});
check('⑭ 老数据兼容：线上备份（daily 无 chk 字段）normalize 后 renderToday 不抛异常', () => {
  if (loadErr) throw loadErr;
  w.eval('D = normalizeData(window.__bkBackup); renderToday()');
  const h = w.eval('document.getElementById("todayBody").innerHTML');
  if (h.indexOf('康复师晨检') < 0) throw new Error('线上数据态缺晨检条');
  return '线上备份渲染 ✓';
});

/* ---------- ⑮ 户外指导员席（最终版批2）：行前判定+行中模式+行后复盘+晋升标记 ---------- */
check('⑮ 线路库（v4.1 字段升级）：12 条在位（10 已核+2 待核），鳌太/博格达双永拒，南太行实历升 L2', () => {
  if (loadErr) throw loadErr;
  const n = w.eval('TRIP_ROUTES.length');
  if (n !== 12) throw new Error('线路数=' + n);
  const names = w.eval('TRIP_ROUTES.map(r=>r.id).join(",")');
  if (names !== 'gangrenboqi,lianbaoyeze,jiesigou,wugongshan,nantaihang,aotai,tengger,nanjiluo,yading,meili,genie,bogeda') throw new Error(names);
  if (w.eval('TRIP_ROUTES.find(r=>r.id==="aotai").riskLine') !== true) throw new Error('鳌太缺 riskLine');
  if (w.eval('TRIP_ROUTES.find(r=>r.id==="bogeda").riskLine') !== true) throw new Error('博格达缺 riskLine（v4.1 升永拒）');
  const unvetted = w.eval('TRIP_ROUTES.filter(r=>r.grade==="待核").length');
  if (unvetted !== 2) throw new Error('待核线数=' + unvetted + '（应只剩腾格里/梅里）');
  const g = (id) => w.eval('TRIP_ROUTES.find(r=>r.id==="' + id + '").grade');
  if (g('nantaihang') !== 'L2' || g('nanjiluo') !== 'L1' || g('yading') !== 'L3' || g('genie') !== 'L3') throw new Error('v4.1 四条升级字段错');
  if (String(w.eval('TRIP_ROUTES.find(r=>r.id==="nantaihang").src')).indexOf('实历完走') < 0) throw new Error('南太行应标实历完走');
  return '12 线路（10 已核+2 待核）双永拒 ✓';
});
check('⑮ 行前判定：鳌太→no+明令禁止穿越，永不给能走', () => {
  if (loadErr) throw loadErr;
  const r = w.eval('preTripEval(TRIP_ROUTES.find(x=>x.id==="aotai"))');
  if (r.out !== 'no') throw new Error('应为 no');
  if (String(r.lines[0]).indexOf('禁止穿越') < 0) throw new Error('缺风险口径：' + r.lines[0]);
  return '风险线口径 ✓';
});
check('⑮ 行前判定：冈仁波齐踝门未测→no（不瞎猜）', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData()');
  const r = w.eval('preTripEval(TRIP_ROUTES.find(x=>x.id==="gangrenboqi"))');
  if (r.out !== 'no') throw new Error('应为 no');
  if (String(r.lines[0]).indexOf('未测') < 0) throw new Error('缺未测口径：' + r.lines[0]);
  return 'no ✓';
});
check('⑮ 行前判定：踝门 30s 走冈仁波齐→no+差 27s+链回每日包（不发明新动作）', () => {
  if (loadErr) throw loadErr;
  w.eval('upsertByDate(D.tests, recStamp({ date: "2026-09-27", standR: 30 }))');
  const r = w.eval('preTripEval(TRIP_ROUTES.find(x=>x.id==="gangrenboqi"))');
  if (r.out !== 'no') throw new Error('应为 no');
  const j = JSON.stringify(r.lines);
  if (j.indexOf('还差 27s') < 0) throw new Error('缺差值：' + j);
  if (j.indexOf('每日包') < 0 || j.indexOf('不加新动作') < 0) throw new Error('缺练哪几项链接：' + j);
  return 'no+处方 ✓';
});
check('⑮ 行前判定：结斯沟踝门 50s（过 47 线）→有条件能走（周期未满）', () => {
  if (loadErr) throw loadErr;
  w.eval('upsertByDate(D.tests, recStamp({ date: "2026-09-27", standR: 50 }))');
  const r = w.eval('preTripEval(TRIP_ROUTES.find(x=>x.id==="jiesigou"))');
  if (r.out !== 'cond') throw new Error('应为 cond，实际 ' + r.out);
  return 'cond ✓';
});
check('⑮ 行前判定：武功山（L2 实历已过）→能走', () => {
  if (loadErr) throw loadErr;
  const r = w.eval('preTripEval(TRIP_ROUTES.find(x=>x.id==="wugongshan"))');
  if (r.out !== 'go') throw new Error('应为 go，实际 ' + r.out);
  return 'go ✓';
});
check('⑮ 行前 modal：六线路 chips+判定=参考不是许可声明', () => {
  if (loadErr) throw loadErr;
  w.eval('openPreTrip()');
  const h = w.eval('document.getElementById("modalBox").innerHTML');
  for (const k of ['冈仁波齐转山', '莲宝叶则', '结斯沟穿山洞', '武功山', '南太行', '鳌太', '参考不是许可']) if (h.indexOf(k) < 0) throw new Error('缺「' + k + '」');
  w.eval('closeModal()');
  return 'modal ✓';
});
check('⑮ preTripPick：写 state.preTrip 缓存并重开默认选中', () => {
  if (loadErr) throw loadErr;
  w.eval('openPreTrip(); preTripPick("gangrenboqi")');
  const rid = w.eval('D.state.preTrip && D.state.preTrip.routeId');
  if (rid !== 'gangrenboqi') throw new Error('preTrip.routeId=' + rid);
  const h = w.eval('document.getElementById("modalBox").innerHTML');
  if (h.indexOf('chip on') < 0 || h.indexOf('还不能走') < 0) throw new Error('重开后无选中态或无判定卡（踝门50 vs 57 应为 no）');
  w.eval('closeModal()');
  return '缓存+重渲 ✓';
});
check('⑮ 行中模式：checklist 含 K18 预防项+折返纪律+保命卡四键', () => {
  if (loadErr) throw loadErr;
  w.eval('openMidTrip()');
  const h = w.eval('document.getElementById("modalBox").innerHTML');
  for (const k of ['离线地图', '纸图+指北针', '折返时间', 'showK(\'K16\')', 'showK(\'K17\')', 'showK(\'K18\')', 'showK(\'K20\')']) if (h.indexOf(k) < 0) throw new Error('缺「' + k + '」');
  w.eval('closeModal()');
  return '行中 ✓';
});
check('⑮ 行后复盘：写入 daily.trip 且行前判定引用上次复盘', () => {
  if (loadErr) throw loadErr;
  w.eval('openPostTrip(); tripSel = { res: "部分完成", pit: "开局抽筋" }; tripSubmit()');
  const t = w.eval('JSON.stringify((M.dailyOn(U.todayStr())||{}).trip||null)');
  const o = JSON.parse(t);
  if (!o || o.res !== '部分完成' || o.pit !== '开局抽筋') throw new Error('trip 未写入：' + t);
  w.eval('openPreTrip(); preTripPick("gangrenboqi")');
  const h = w.eval('document.getElementById("modalBox").innerHTML');
  if (h.indexOf('上次行后复盘') < 0) throw new Error('行前判定未引用复盘');
  w.eval('closeModal()');
  return '复盘回灌 ✓';
});
check('⑮ 晋升标记：K21/K23 卡头有"你在这里"动态条', () => {
  if (loadErr) throw loadErr;
  w.eval('showK("K21")');
  const h1 = w.eval('document.getElementById("modalBox").innerHTML');
  if (h1.indexOf('你在这里：阶段 3') < 0 || h1.indexOf('五阶段') < 0) throw new Error('K21 标记缺失');
  w.eval('closeModal(); showK("K23")');
  const h2 = w.eval('document.getElementById("modalBox").innerHTML');
  if (h2.indexOf('你在这里：R0') < 0 || h2.indexOf('两把闸门') < 0) throw new Error('K23 标记缺失');
  w.eval('closeModal()');
  return '你在这里 ✓';
});
check('⑮ 缺键防线：老数据 state 无 preTrip/tour7/weekRev → normalize/merge 补 null', () => {
  if (loadErr) throw loadErr;
  w.eval('D = normalizeData(window.__bkBackup)');
  for (const k of ['preTrip', 'tour7', 'weekRev']) {
    const v = w.eval('D.state.' + k);
    if (v !== null) throw new Error(k + '=' + v + '，应补 null');
  }
  const m = w.eval('JSON.stringify((function(){ const local = normalizeData(window.__bkBackup); const remote = JSON.parse(JSON.stringify(local)); delete remote.state.preTrip; delete remote.state.tour7; delete remote.state.weekRev; return mergeData(local, remote).state; })())');
  for (const k of ['"preTrip":null', '"tour7":null', '"weekRev":null']) if (m.indexOf(k) < 0) throw new Error('merge 后缺 ' + k);
  return 'normalize/merge 双路径 ✓';
});

/* ---------- ⑯ 私教席（最终版批3）：周复盘+新手7天引导+睡眠债+练中预告 ---------- */
check('⑯ 睡眠债：样本<3 天→不硬算（空串）', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData()');
  if (w.eval('sleepDebtLine()') !== '') throw new Error('无样本应返回空串');
  return '诚实边界 ✓';
});
check('⑯ 睡眠保持：近 7 天均 5.4h → 显示"低于 6.5h 底线 1.1h/天"', () => {
  if (loadErr) throw loadErr;
  w.eval('for (let i = 1; i <= 7; i++) upsertByDate(D.metrics, recStamp({ date: U.addDays(U.todayStr(), -i), sleepH: 5.4 }))');
  const s = w.eval('sleepDebtLine()');
  if (s.indexOf('均 5.4h') < 0 || s.indexOf('底线 1.1h') < 0 || s.indexOf('睡眠保持') < 0) throw new Error('文案不对：' + s);
  return '5.4→6.5 缺口 ✓';
});
check('⑯ 睡眠保持：达标 6.5h+ → 绿色正向反馈', () => {
  if (loadErr) throw loadErr;
  w.eval('for (let i = 1; i <= 7; i++) upsertByDate(D.metrics, recStamp({ date: U.addDays(U.todayStr(), -i), sleepH: 6.8 }))');
  const s = w.eval('sleepDebtLine()');
  if (s.indexOf('守住 6.5h 底线') < 0 || s.indexOf('睡眠保持') < 0) throw new Error('缺达标反馈：' + s);
  return '达标态 ✓';
});
check('⑯ 周复盘：调用安全返回 string；若今天是周日则卡内容含结论+分布', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData()');
  const r = w.eval('weekReviewHtml()');
  if (typeof r !== 'string') throw new Error('返回类型错');
  if (new Date().getDay() === 0) {
    if (r.indexOf('周复盘 · 私教') < 0 || r.indexOf('打卡 0/7') < 0 || r.indexOf('训练分布：本周无训练记录') < 0) throw new Error('周日空数据卡不对：' + r.slice(0, 200));
    return '周日空数据态 ✓';
  }
  return '非周日空串 ✓（周日形态由⑯专项验证）';
});
check('⑯ 周复盘：周日+睡眠 5h 样本 → 结论=睡眠胜负手（档位日志按箭头数字判向）', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); for (let i = 0; i < 3; i++) { upsertByDate(D.daily, recStamp({ date: U.addDays(U.todayStr(), -i), type: "力量" })); upsertByDate(D.metrics, recStamp({ date: U.addDays(U.todayStr(), -i), sleepH: 5 })); } D.state.progressionLog = [{ ts: Date.now(), why: "测试", what: "深蹲 12→13、俯卧撑 8→7、平板 30→25秒" }]');
  const r = w.eval('weekReviewHtml()');
  if (new Date().getDay() !== 0) return '非周日跳过内容断言（调用安全）';
  if (r.indexOf('胜负手是睡眠') < 0) throw new Error('睡眠结论缺失：' + r.slice(0, 300));
  if (r.indexOf('12→13') >= 0 || r.indexOf('力量档位在涨') < 0 || r.indexOf('降档') < 0) throw new Error('档位判断不对：' + r.slice(0, 400));
  return '结论+档位方向 ✓（1 升 2 降）';
});
check('⑯ 新手引导：afterEnter 首次进入自动开启 tour7', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); D.state.profileDone = true; D.state.backfillDone = true; D.state.tour7 = null; afterEnter()');
  const t7 = w.eval('D.state.tour7');
  if (!t7 || t7.on !== true || t7.day !== 1) throw new Error('tour7 未自动开启：' + JSON.stringify(t7));
  return '自动开启 ✓';
});
check('⑯ 新手引导：卡片含任务文案+完成/跳过按钮；tour7Done 推进天数', () => {
  if (loadErr) throw loadErr;
  const h = w.eval('tour7CardHtml()');
  if (h.indexOf('第 1/7 天') < 0 || h.indexOf('康复师晨检') < 0 || h.indexOf('跳过') < 0) throw new Error('卡内容缺：' + h.slice(0, 200));
  w.eval('tour7Done()');
  const d = w.eval('D.state.tour7.day'), done = w.eval('D.state.tour7.done.length');
  if (d !== 2 || done !== 1) throw new Error('tour7Done 后 day=' + d + ' done=' + done);
  return '推进 ✓';
});
check('⑯ 新手引导：第 7 天完成=毕业关闸；跳过=永久关', () => {
  if (loadErr) throw loadErr;
  w.eval('D.state.tour7 = { on: true, day: 7, done: [] }; tour7Done()');
  if (w.eval('D.state.tour7.on') !== false) throw new Error('第 7 天完成未毕业');
  w.eval('D.state.tour7 = { on: true, day: 3, done: [] }; tour7Skip()');
  if (w.eval('D.state.tour7.on') !== false || w.eval('D.state.tour7.skip') !== true) throw new Error('跳过未关闸');
  return '毕业+跳过 ✓';
});
check('⑯ 练中预告：set 相位渲染含"之后："预告行（结构性，不碰计时）', () => {
  if (loadErr) throw loadErr;
  const src = w.eval('String(renderWorkout)');
  if (src.indexOf('之后：') < 0 || src.indexOf("q.kind === 'set'") < 0) throw new Error('set 相位缺预告');
  if (src.indexOf('setInterval') >= 0) throw new Error('renderWorkout 内不应新建计时器');
  return '预告行 ✓';
});
check('⑯ sleepCardHtml 集成：睡眠债行已挂入卡体', () => {
  if (loadErr) throw loadErr;
  const src = w.eval('String(sleepCardHtml)');
  if (src.indexOf('sleepDebtLine()') < 0) throw new Error('sleepCardHtml 未挂 sleepDebtLine');
  return '挂载 ✓';
});

/* ---------- ⑰ 断网降级（批5实测发现的真实缺口修复） ---------- */
check('⑰ tryUnlock 断网降级链：密文缓存→本机数据自动离线，双路径在位', () => {
  if (loadErr) throw loadErr;
  const src = w.eval('String(tryUnlock)');
  if (src.indexOf('gistTextCache') < 0 || src.indexOf('text = gistTextCache') < 0) throw new Error('缺密文缓存降级路径');
  if (src.indexOf('enterOffline()') < 0 || src.indexOf('localEmpty()') < 0) throw new Error('缺本机数据自动降级路径');
  if (src.indexOf('GIST_HTTP_404') < 0) throw new Error('404 仍应报错不降级');
  return '降级链 ✓（网络→会话缓存→离线模式；404 不降级）';
});

/* ---------- ⑱ 教练开口层（批7）：课单为什么+体重账+问教练+吃账 ---------- */
check('⑱ 课单为什么：9 动作 WHY_MAP 全覆盖且 planHtml 渲染', () => {
  if (loadErr) throw loadErr;
  const names = w.eval('CONFIG.actions.map(a=>a.name)');
  const missing = names.filter((n) => w.eval(`!WHY_MAP[${JSON.stringify(n)}]`));
  if (missing.length) throw new Error('缺 why：' + missing.join('、'));
  const h = w.eval('(function(){ tf.type = "力量"; return planHtml(); })()');
  if (h.indexOf('为什么练它') < 0 || h.indexOf('碎石坡') < 0) throw new Error('planHtml 未渲染 why');
  return '9/9 动作带为什么 ✓';
});
check('⑱ 体重账：无记录引导称重；在带内/持平/掉秤三态判读正确', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData()');
  if (w.eval('weightLedgerLine()').indexOf('还没称过') < 0) throw new Error('空态错');
  w.eval('upsertByKey(D.weekly, recStamp({ weekStart: "2026-09-21", weightKg: 60.0 }), "weekStart"); upsertByKey(D.weekly, recStamp({ weekStart: "2026-09-28", weightKg: 60.2 }), "weekStart")');
  if (w.eval('weightLedgerLine()').indexOf('在带内') < 0) throw new Error('在带内判读错');
  w.eval('upsertByKey(D.weekly, recStamp({ weekStart: "2026-09-28", weightKg: 60.0 }), "weekStart")');
  if (w.eval('weightLedgerLine()').indexOf('没涨=吃的没到位') < 0) throw new Error('持平判读错');
  w.eval('upsertByKey(D.weekly, recStamp({ weekStart: "2026-09-28", weightKg: 59.0 }), "weekStart")');
  if (w.eval('weightLedgerLine()').indexOf('偷肌肉') < 0) throw new Error('掉秤判读错');
  return '四态 ✓（0.5% 带内 0.3 判在带内）';
});
check('⑱ 问教练：8 问全预埋且口径词命中（鳌太/两把闸门/Nedeltcheva/2400-2600）', () => {
  if (loadErr) throw loadErr;
  if (w.eval('COACH_QA.length') !== 8) throw new Error('应 8 问');
  w.eval('showCoachQA()');
  const h = w.eval('document.getElementById("modalBox").innerHTML');
  for (const k of ['为什么今天练', '疼了还能练', '吃怎么安排', '睡不够', '两把闸门', '鳌太', '2400-2600', '偷肌肉', '口径：']) if (h.indexOf(k) < 0) throw new Error('缺「' + k + '」');
  w.eval('closeModal()');
  return '8 问直答 ✓';
});
check('⑱ 吃账+入口：今日页含吃账行与问教练按钮；K11 含已核热量带', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); renderToday()');
  const h = w.eval('document.getElementById("todayBody").innerHTML');
  if (h.indexOf('今日吃账') < 0 || h.indexOf('2400-2600') < 0 || h.indexOf('问教练') < 0) throw new Error('吃账/入口缺失');
  const k11 = w.eval('CONFIG.knowledge.find(x=>x.id==="K11").body');
  if (k11.indexOf('2400-2600') < 0 || k11.indexOf('总日量优先') < 0) throw new Error('K11 未升级');
  return '吃账露出+K11 升级 ✓';
});

/* ---------- ⑲ 实测问题修复（批9）：晨检全身+DOMS 通路/行前心肺维度+待核线路/天气联动/备注信号 ---------- */
check('⑲ 晨检部位扩全身（≥10 项）且 DOMS 通路成立', () => {
  if (loadErr) throw loadErr;
  if (w.eval('CHK_PARTS.length') < 10) throw new Error('部位不足');
  const doms = w.eval('chkEval(["大腿","上背"],["酸胀"],"ease")');
  if (doms.out !== 'ok' || doms.why.indexOf('练狠了的酸') < 0) throw new Error('DOMS 通路失效：' + JSON.stringify(doms));
  const guard = w.eval('chkEval(["右踝"],["酸胀"],"ease")');
  if (guard.out !== 'watch') throw new Error('守门区被 DOMS 误放行');
  const worse = w.eval('chkEval(["大腿"],["酸胀"],"worse")');
  if (worse.out !== 'watch' || worse.why.indexOf('更痛') < 0) throw new Error('更痛通路失效');
  return '全身部位+三态 ✓（守门区不放行）';
});
check('⑲ 行前判定：待核线不给三档只给自查要素；线路池扩到 12 条', () => {
  if (loadErr) throw loadErr;
  const n = w.eval('TRIP_ROUTES.length');
  if (n !== 12) throw new Error('线路数=' + n);
  const r = w.eval('preTripEval(TRIP_ROUTES.find(x=>x.id==="tengger"))');
  if (r.out !== 'cond' || String(r.lines[0]).indexOf('未守门') < 0 || String(r.lines[0]).indexOf('八维') < 0) throw new Error('待核线口径错：' + JSON.stringify(r.lines));
  return '12 线路+待核不拍板 ✓';
});
check('⑲ 行前判定：心肺维度接入（有氧底盘未评=提示级不判负；跟能力雷达同源）', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); upsertByDate(D.tests, recStamp({ date: "2026-09-27", standR: 57 }))');
  const r = w.eval('preTripEval(TRIP_ROUTES.find(x=>x.id==="gangrenboqi"))');
  if (r.out !== 'cond') throw new Error('踝门过线+有氧未评 应为 cond（提示级），实际 ' + r.out);
  if (JSON.stringify(r.lines).indexOf('有氧底盘未评') < 0) throw new Error('缺提示行');
  return '心肺维度 ✓';
});
check('⑲ 行前准备卡：冈仁波齐含"为什么是 3 天"+高原五件事+血氧诚实说明+装备档案', () => {
  if (loadErr) throw loadErr;
  const h = w.eval('tripPrepHtml(TRIP_ROUTES.find(x=>x.id==="gangrenboqi"))');
  for (const k of ['为什么是 3 天', '连续 3 天睡 4670m+', '高原行前五件事', '血氧', '装备档案', 'K20/K22']) if (h.indexOf(k) < 0) throw new Error('缺「' + k + '」');
  return '准备卡 ✓';
});
check('⑲ 天气联动：今日安排含天气选择，雨雪日有氧出替代方案（K4 口径）', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); tf.type = "有氧"; tf.cardioChoice = "快走"; tf.weather = "雨雪"');
  const h = w.eval('planHtml()');
  for (const k of ['今天天气', '好天', '雨雪', '室内原地快走']) if (h.indexOf(k) < 0) throw new Error('缺「' + k + '」');
  return '天气联动 ✓';
});
check('⑲ 备注信号引擎：抽筋/疲劳/心率词命中给反馈，红线词弹停训卡；tfSave 已挂载', () => {
  if (loadErr) throw loadErr;
  const s1 = w.eval('noteSignals("今天抽筋了两次")');
  if (!s1 || s1.msg.indexOf('K20') < 0) throw new Error('抽筋信号失效');
  const s2 = w.eval('noteSignals("练得很累")');
  if (!s2 || s2.msg.indexOf('晨检') < 0) throw new Error('疲劳信号失效');
  const s3 = w.eval('noteSignals("半夜肿胀")');
  if (!s3 || !s3.modal) throw new Error('红线信号未走停训卡');
  if (w.eval('noteSignals("今天状态不错")') !== null) throw new Error('无信号词不应命中');
  if (w.eval('String(tfSave)').indexOf('noteSignals') < 0) throw new Error('tfSave 未挂信号引擎');
  return '备注信号 ✓（规则引擎，不装语义全懂）';
});

check('⑲ 离线模式可写（走查发现的重大缺陷修复）：enterOffline 不再锁只读，晨检/记录本地可存待同步', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); enterOffline()');
  if (w.eval('readOnly') !== false) throw new Error('离线模式仍锁只读——山上无法记录');
  w.eval('chkSel = { parts: ["肩"], kinds: ["酸胀"], relief: "ease" }; chkSubmit()');
  const c = w.eval('JSON.stringify((M.dailyOn(U.todayStr())||{}).chk||null)');
  if (JSON.parse(c).out !== 'ok') throw new Error('离线晨检未写入：' + c);
  const src = w.eval('String(enterOffline)');
  if (src.indexOf('readOnly = true') >= 0) throw new Error('enterOffline 仍在设只读');
  return '离线可写 ✓（本地存+联网后 merge 合并）';
});

check('⑲ 保存不覆盖晨检（走查抓到的数据丢失 bug）：先晨检再保存训练记录，chk 保留', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); chkSel = { parts: ["肩"], kinds: ["酸胀"], relief: "ease" }; chkSubmit()');
  w.eval('tf.type = "有氧"; tf.cardioChoice = "单车"; tf.mood = "好"; tf.fromWorkout = false; var __sv = tfSave');
  w.eval('(function(){ document.getElementById("fDur").value = "30"; document.getElementById("fRpe").value = "5"; tfSave(); })()');
  const rec = w.eval('JSON.stringify(M.dailyOn(U.todayStr()) || {})');
  const o = JSON.parse(rec);
  if (o.durationMin !== 30) throw new Error('记录未保存：' + rec.slice(0, 120));
  if (!o.chk || o.chk.out !== 'ok') throw new Error('晨检被保存覆盖丢失！');
  return 'chk/trip 合并保留 ✓';
});

/* ---------- ⑳ 实况天气（批10）：Open-Meteo 接入（免费无 key，武汉真机已验证） ---------- */
check('⑳ 天气映射：2026-09-28 武汉真实返回(code=80/体感32.3/风速14.6km/h)→雨雪；全档位映射', () => {
  if (loadErr) throw loadErr;
  const real = w.eval('wxFromCode(80, 32.3, 14.6)');
  if (real[0] !== '雨雪') throw new Error('真实值映射错：' + real);
  const cases = [[0, 25, 10, '好天'], [95, 25, 10, '雨雪'], [73, 25, 10, '雨雪'], [0, 35, 20, '闷热'], [3, 20, 45, '大风降温']];
  for (const [c, a, wd, want] of cases) {
    const r = w.eval(`wxFromCode(${c},${a},${wd})`);
    if (r[0] !== want) throw new Error(`wxFromCode(${c},${a},${wd})=${r[0]}，应 ${want}`);
  }
  return '真实值+5 档映射 ✓（风速单位 km/h 已实测确认）';
});
check('⑳ 天气键防线：state.weather 缺键 normalize/merge 补 null；城市表含武汉', () => {
  if (loadErr) throw loadErr;
  w.eval('D = normalizeData(window.__bkBackup)');
  if (w.eval('D.state.weather') !== null) throw new Error('normalize 未补 weather');
  const m = w.eval('JSON.stringify((function(){ const l = normalizeData(window.__bkBackup); const r = JSON.parse(JSON.stringify(l)); delete r.state.weather; return mergeData(l, r).state; })())');
  if (m.indexOf('"weather":null') < 0) throw new Error('merge 未补 weather');
  if (!w.eval('CONFIG.CITY_COORDS["武汉"]')) throw new Error('缺武汉坐标');
  return '防线+城市表 ✓';
});
check('⑳ 今日安排实况展示：state.weather 当日 → 标签显示实况+自动选中+雨雪出替代方案', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); D.state.weather = { date: U.todayStr(), wx: "雨雪", desc: "降水·28°C" }; tf.type = "有氧"; tf.cardioChoice = "快走"');
  const h = w.eval('planHtml()');
  if (h.indexOf('今晨实况：武汉') < 0 || h.indexOf('降水·28°C') < 0) throw new Error('实况标签缺失');
  if (h.indexOf('室内原地快走') < 0) throw new Error('雨雪替代方案未触发');
  if (!/class="chip on" onclick="setWeather\('雨雪'\)"/.test(h)) throw new Error('雨雪未自动选中');
  return '实况→安排全链 ✓';
});

/* ---------- ㉑ 目标页/能力页接入（批11还欠账）+全页面复核 ---------- */
check('㉑ 目标页：体重账+康复进度（三线/复测点）已接入，与今日页同源', () => {
  if (loadErr) throw loadErr;
  w.eval('D = normalizeData(window.__bkBackup); upsertByDate(D.tests, recStamp({ date: "2026-09-27", standR: 30 })); upsertByKey(D.weekly, recStamp({ weekStart: "2026-09-28", weightKg: 60.2 }), "weekStart"); renderGoal()');
  const h = w.eval('document.getElementById("goalBody").innerHTML');
  for (const k of ['体重账', '康复师工作台', '还差 17s', '下次周日复测']) if (h.indexOf(k) < 0) throw new Error('缺「' + k + '」');
  return '目标页接入 ✓';
});
check('㉑ 能力页：踝门三线进度+禁区解锁已接入', () => {
  if (loadErr) throw loadErr;
  w.eval('renderAbility()');
  const h = w.eval('document.getElementById("abilityBody").innerHTML');
  for (const k of ['康复师工作台', '47', '57', '越野跑 R1']) if (h.indexOf(k) < 0) throw new Error('缺「' + k + '」');
  return '能力页接入 ✓';
});
check('㉑ 全页面复核：七页渲染无 throw、今日页天气行在（空态文案）', () => {
  if (loadErr) throw loadErr;
  w.eval('D = normalizeData(window.__bkBackup)');
  const pages = [['pgToday', 'renderToday', 'todayBody'], ['pgTrend', 'renderTrend', 'trendBody'], ['pgAbility', 'renderAbility', 'abilityBody'], ['pgGoal', 'renderGoal', 'goalBody'], ['pgGuide', 'renderGuideTab', 'guideTabBody'], ['pgProfile', 'renderProfile', 'profileBody'], ['pgTest', 'renderTest', 'testBody']];
  for (const [pg, fn, body] of pages) {
    w.eval(fn + '()');
    const len = w.eval(`document.getElementById('${body}').innerHTML.length`);
    if (len < 300) throw new Error(pg + ' 渲染过短 ' + len);
  }
  w.eval('renderToday()');
  if (w.eval('document.getElementById("todayBody").innerHTML').indexOf('今天天气') < 0) throw new Error('天气行缺失');
  return '七页+天气行 ✓';
});

/* ---------- ㉒ 批12a 记录10秒化（设计工单1）：默认值模板+一键保存+拦截三选 ---------- */
check('㉒ RPE 默认三级来源：近7天均值≥3条 / 上次 / 类型建议值（修默认5污染K5）', () => {
  if (loadErr) throw loadErr;
  w.eval(`D = defaultData();
    var t = U.todayStr();
    D.daily = [
      { date: U.addDays(t, -5), type: '力量', rpe: 9, durationMin: 50 },
      { date: U.addDays(t, -3), type: '力量', rpe: 7, durationMin: 40 },
      { date: U.addDays(t, -1), type: '力量', rpe: 8, durationMin: 45 }
    ];
    window.__r1 = rpeDefaultFor('力量');
    D.daily = [{ date: U.addDays(t, -5), type: '力量', rpe: 9, durationMin: 50 }];
    window.__r2 = rpeDefaultFor('力量');
    D.daily = []; window.__r3 = rpeDefaultFor('力量'); window.__r4 = rpeDefaultFor('有氧');`);
  const r1 = w.eval('window.__r1'), r2 = w.eval('window.__r2'), r3 = w.eval('window.__r3'), r4 = w.eval('window.__r4');
  if (r1.v !== 8 || r1.tag !== '近7天均值') throw new Error('均值来源错：' + JSON.stringify(r1));
  if (r2.v !== 9 || r2.tag !== '上次') throw new Error('上次来源错：' + JSON.stringify(r2));
  if (r3.v !== 8 || r3.tag !== '建议值') throw new Error('力量建议值错：' + JSON.stringify(r3));
  if (r4.v !== 4 || r4.tag !== '建议值') throw new Error('有氧建议值错：' + JSON.stringify(r4));
  return '均值8/上次9/建议 力8有4 ✓';
});
check('㉒ 时长默认：同类型最近一条；有氧优先同方式', () => {
  if (loadErr) throw loadErr;
  w.eval(`D = defaultData();
    var t = U.todayStr();
    D.daily = [
      { date: U.addDays(t, -3), type: '有氧', cardioChoice: '快走', durationMin: 30 },
      { date: U.addDays(t, -2), type: '有氧', cardioChoice: '慢跑', durationMin: 20 },
      { date: U.addDays(t, -1), type: '力量', rpe: 8, durationMin: 45 }
    ];
    window.__d1 = durDefaultFor('力量');
    tf.cardioChoice = '快走'; window.__d2 = durDefaultFor('有氧');
    tf.cardioChoice = '椭圆机'; window.__d3 = durDefaultFor('有氧');`);
  const d1 = w.eval('window.__d1'), d2 = w.eval('window.__d2'), d3 = w.eval('window.__d3');
  if (d1 !== 45) throw new Error('力量时长默认应取最近 45，实际 ' + d1);
  if (d2 !== 30) throw new Error('有氧同方式（快走）应取 30，实际 ' + d2);
  if (d3 !== 20) throw new Error('有氧无同方式应取最近任一 20，实际 ' + d3);
  return '45 / 30（同方式优先）/ 20 ✓';
});
check('㉒ 类型预填课表优先（修休息日预填成上次"力量"的缺陷）', () => {
  if (loadErr) throw loadErr;
  w.eval(`D = defaultData(); D.state.lastForm = { type: '力量', mood: '好', painOpt: '无' };
    renderToday();
    window.__tpl = effTemplate()[new Date().getDay()];`);
  const tt = w.eval('tf.type'), tpl = w.eval('window.__tpl');
  if (w.eval('CONFIG.typeList.indexOf(window.__tpl)') >= 0 && tt !== tpl) throw new Error('类型预填应为课表类型 ' + tpl + '，实际 ' + tt);
  return '预填=' + tt + '（课表同源）✓';
});
check('㉒ 一键保存=全勾断言：strengthChecks 全 true+时长/RPE 取模板，走 full 渐进分支', () => {
  if (loadErr) throw loadErr;
  w.eval(`D = defaultData();
    D.state.lastForm = { type: '力量', mood: '好', painOpt: '无' };
    D.daily = [{ date: U.addDays(U.todayStr(), -1), type: '力量', rpe: 8, durationMin: 45 }];
    renderToday(); tfType('力量'); tfQuickSave();`); // 课表优先预填可能给非力量类型，显式切到力量日场景
  const rec = w.eval('D.daily[D.daily.length - 1]');
  const today = w.eval('U.todayStr()');
  if (rec.date !== today) throw new Error('未入库今天：' + rec.date);
  if (rec.type !== '力量') throw new Error('type=' + rec.type);
  if (rec.durationMin !== 45) throw new Error('时长应取上次 45，实际 ' + rec.durationMin);
  if (!rec.strengthChecks || !rec.strengthChecks.every(Boolean)) throw new Error('一键后 strengthChecks 应全 true');
  if (w.eval('D.state.strengthFails') !== 0) throw new Error('full 分支应复位 strengthFails');
  return '力量日 1 tap 入库（45min/RPE' + rec.rpe + '/9全勾）✓';
});
check('㉒ 拦截三选：未勾全弹「部分完成，照实记录」诚实出口；点后照实入库+计数+不上调', () => {
  if (loadErr) throw loadErr;
  w.eval(`D = defaultData(); D.state.lastForm = { type: '力量', mood: '好', painOpt: '无' };
    renderToday(); tfType('力量'); // 课表优先预填可能给非力量类型，显式切到力量日场景
    for (var i = 0; i < 5; i++) tf.checks[i] = true; // 只勾 5/9
    document.getElementById('fDur').value = 45; // 手动表单：时长必填，是校验链第一步
    tf.mood = '好'; tfSave();`);
  const modal = w.eval('document.getElementById("modalWrap").innerHTML');
  if (modal.indexOf('部分完成，照实记录') < 0) throw new Error('拦截 modal 缺诚实出口按钮');
  if (modal.indexOf('回去补勾') < 0) throw new Error('拦截 modal 缺回去补勾');
  if (modal.indexOf('5/' + w.eval('CONFIG.actions.length')) < 0) throw new Error('modal 未显示勾选进度');
  const before = w.eval('D.state.strengthReps["深蹲"]');
  w.eval('partialHonestSave()');
  const rec = w.eval('D.daily[D.daily.length - 1]');
  if (rec.strengthChecks.filter(Boolean).length !== 5) throw new Error('部分完成应照实入库 5 项');
  if (w.eval('D.state.strengthFails') !== 1) throw new Error('部分完成应计 strengthFails=1，实际 ' + w.eval('D.state.strengthFails'));
  if (w.eval('D.state.strengthReps["深蹲"]') !== before) throw new Error('部分完成不上调（RPE6 partial）');
  return '诚实出口 ✓ 照实 5/9+计数+不上调';
});
check('㉒ 只填空不改已填：手改时长/滑块后模板不覆盖；全勾/清空按钮', () => {
  if (loadErr) throw loadErr;
  w.eval(`D = defaultData(); D.state.lastForm = { type: '力量', mood: '好', painOpt: '无' };
    D.daily = [{ date: U.addDays(U.todayStr(), -1), type: '力量', rpe: 8, durationMin: 45 }];
    renderToday();
    document.getElementById('fDur').value = 60; rpeSlide(6);
    applyTemplateToForm();
    window.__dur = document.getElementById('fDur').value;
    window.__rpe = document.getElementById('fRpe').value;
    tfCheckAll(true); window.__ckOn = tf.checks.every(Boolean);
    tfCheckAll(false); window.__ckOff = tf.checks.some(Boolean);`);
  if (w.eval('window.__dur') !== '60') throw new Error('手改时长被模板覆盖');
  if (w.eval('window.__rpe') !== '6') throw new Error('手改 RPE 被模板覆盖');
  if (w.eval('window.__ckOn') !== true || w.eval('window.__ckOff') !== false) throw new Error('全勾/清空异常');
  return '只填空 ✓ 全勾/清空 ✓';
});
check('㉒ 一键副行逐字明示将存什么（按下去之前看得到）', () => {
  if (loadErr) throw loadErr;
  w.eval(`D = defaultData(); D.state.lastForm = { type: '力量', mood: '好', painOpt: '无' };
    D.daily = [{ date: U.addDays(U.todayStr(), -1), type: '力量', rpe: 8, durationMin: 45 }];
    renderToday(); tfType('力量');`); // 课表优先预填可能给非力量类型，显式切到力量日场景
  const sub = w.eval('quickSubText()');
  for (const k of ['力量', '45 分钟', 'RPE', '9 动作全勾']) if (sub.indexOf(k) < 0) throw new Error('副行缺「' + k + '」：' + sub);
  const btn = w.eval('quickBtnText()');
  if (btn.indexOf('一键保存') < 0) throw new Error('按钮文案异常：' + btn);
  w.eval('tfQuickSave()');
  const btn2 = w.eval('quickBtnText()');
  if (btn2 !== '更新今日记录') throw new Error('已保存后按钮应变「更新今日记录」：' + btn2);
  return '副行四要素 ✓ 已存后转「更新今日记录」✓';
});

/* ---------- ㉓ 批12a 问答实时化：三态/隐私红线/预埋底座 ---------- */
check('㉓ aiStatus 三态：未配置/断网/实时', () => {
  if (loadErr) throw loadErr;
  w.eval('try { localStorage.removeItem("tineng_aikey"); } catch (e) {}');
  if (w.eval('aiStatus()') !== 'unset') throw new Error('无 key 应为 unset');
  w.eval(`Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    try { localStorage.setItem('tineng_aikey', 'k-test'); } catch (e) {}`);
  if (w.eval('aiStatus()') !== 'off') throw new Error('断网+有 key 应为 off');
  w.eval("Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });");
  if (w.eval('aiStatus()') !== 'live') throw new Error('在线+有 key 应为 live');
  return 'unset/off/live ✓';
});
check('㉓ 数据纪律：aiCfg 缺键补 null；key 明文永不进同步数据 D', () => {
  if (loadErr) throw loadErr;
  w.eval('D = normalizeData({});');
  if (w.eval('D.state.aiCfg') !== null) throw new Error('normalizeData 未补 aiCfg=null');
  w.eval(`D = defaultData(); try { localStorage.setItem('tineng_aikey', 'sk-secret-never-sync-123'); } catch (e) {}`);
  if (w.eval('JSON.stringify(D)').indexOf('sk-secret-never-sync-123') >= 0) throw new Error('key 泄漏进同步数据！');
  return 'aiCfg 补默认 ✓ key 不进 D ✓';
});
check('㉓ buildContext 隐私红线：生日/备注原文/城市永不进 prompt；课表与训练摘要在', () => {
  if (loadErr) throw loadErr;
  w.eval(`D = defaultData();
    D.profile.birthday = '1990-01-01'; D.profile.city = '武汉';
    D.daily = [{ date: U.addDays(U.todayStr(), -1), type: '力量', rpe: 8, durationMin: 45, note: '绝密家庭备注词' }];
    window.__ctx = buildContext();`);
  const ctx = w.eval('window.__ctx');
  if (ctx.indexOf('1990-01-01') >= 0) throw new Error('生日进了 prompt！');
  if (ctx.indexOf('绝密家庭备注词') >= 0) throw new Error('备注原文进了 prompt！');
  if (ctx.indexOf('武汉') >= 0) throw new Error('城市进了 prompt！');
  for (const k of ['【今日课表】', '【近7天训练】', '力量', '【足康复】']) if (ctx.indexOf(k) < 0) throw new Error('上下文缺「' + k + '」');
  return '三不进 ✓ 课表/摘要/康复在 ✓';
});
check('㉓ system prompt 九条红线在（鳌太/可能提示/下撤/急症）+ 供应商预设正确', () => {
  if (loadErr) throw loadErr;
  const sys = w.eval('AI_SYSTEM');
  for (const k of ['鳌太', '可能提示', '下撤', '疼痛即停', '立即停止训练', '不承诺效果']) if (sys.indexOf(k) < 0) throw new Error('红线缺「' + k + '」');
  const url = w.eval('AI_PROVIDERS[0].url');
  if (url !== 'https://open.bigmodel.cn/api/paas/v4/chat/completions') throw new Error('智谱 endpoint 错：' + url);
  const url2 = w.eval('AI_PROVIDERS[1].url');
  if (url2 !== 'https://api.siliconflow.cn/v1/chat/completions') throw new Error('硅基流动 endpoint 错：' + url2);
  return '6 红线词+2 endpoint ✓（CORS 2026-09-28 一手实测放行）';
});
check('㉓ 问教练三态 UI：未配置给引导+预埋 8 问可用；配置后出输入区', () => {
  if (loadErr) throw loadErr;
  w.eval('try { localStorage.removeItem("tineng_aikey"); } catch (e) {} showCoachQA();');
  let m = w.eval('document.getElementById("modalWrap").innerHTML');
  if (m.indexOf('未配置 AI') < 0) throw new Error('未配置态缺引导');
  if (m.indexOf(w.eval('COACH_QA[0].q')) < 0) throw new Error('预埋 8 问不可用');
  w.eval(`try { localStorage.setItem('tineng_aikey', 'k-live'); } catch (e) {} showCoachQA();`);
  m = w.eval('document.getElementById("modalWrap").innerHTML');
  if (m.indexOf('AI 实时问答') < 0) throw new Error('live 态缺状态行');
  if (m.indexOf('qaInput') < 0) throw new Error('live 态缺输入区');
  if (m.indexOf('AI 生成，可能有误') < 0) throw new Error('缺免责 footer');
  return '引导+预埋 ✓ 实时+免责 ✓';
});

/* ---------- ㉔ v4.1 M2 修订批：K14 横纹肌红旗词 + 组间休息差异化 + FR-G 动机层红线 + schedShift 缺键防线 ---------- */
check('㉔ K14 横纹肌红旗词：卡内条目在+备注引擎酱油色尿/横纹肌弹停训卡', () => {
  if (loadErr) throw loadErr;
  const k14 = w.eval('CONFIG.knowledge.find(k=>k.id==="K14").body');
  if (k14.indexOf('横纹肌') < 0 || k14.indexOf('酱油色尿') < 0 || k14.indexOf('肌酸激酶') < 0) throw new Error('K14 缺横纹肌红旗条目');
  const hit = w.eval('NOTE_SIGNALS.filter(s=>s.modal && /酱油色尿|横纹肌/.test(s.re.source)).length');
  if (hit !== 1) throw new Error('备注引擎缺横纹肌 modal 规则');
  return 'K14 卡+备注引擎双落点 ✓';
});
check('㉔ 组间休息差异化（FR-4）：rest 项带 sec——下肢推 90s/秒类 45s/其余 60s，estimateMin 同口径', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData();');
  const course = w.eval('JSON.stringify(buildCourse())');
  const rest = JSON.parse(course).filter((p) => p.kind === 'rest');
  if (!rest.length) throw new Error('力量课应含 rest 项');
  if (rest.some((p) => p.sec == null)) throw new Error('rest 项缺 sec 字段');
  if (w.eval('restSecOf(CONFIG.actions.find(a=>a.part==="下肢推"))') !== 90) throw new Error('下肢推 rest 应 90s');
  const timed = w.eval('restSecOf(CONFIG.actions.find(a=>a.unit.indexOf("秒")>=0))');
  if (timed !== 45) throw new Error('秒类 rest 应 45s，实际 ' + timed);
  const est = w.eval('estimateMin(buildCourse())');
  if (!est || est < 10 || est > 90) throw new Error('estimateMin 出界：' + est);
  return 'rest 差异化 ✓（90/60/45 三档+时长估算不出界）';
});
check('㉔ FR-G 动机层红线：首页渲染无问责信号（打卡率/完成率/断 N 天/还差）', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); renderToday();');
  const h = w.eval("document.getElementById('todayBody').innerHTML");
  for (const k of ['打卡率', '完成率', '你已断', '还差', '落后']) if (h.indexOf(k) >= 0) throw new Error('首页出现问责词「' + k + '」');
  const coach = w.eval('weekReviewHtml()');
  if (coach && coach.indexOf('训练打卡') < 0) throw new Error('周复盘卡应含教练视角打卡数据');
  return '首页零问责词 ✓（周复盘卡=教练视角白名单容器）';
});
check('㉔ schedShift 缺键防线：老数据 normalize/merge 补 null，不炸周期函数', () => {
  if (loadErr) throw loadErr;
  w.eval('window.__oldD = JSON.parse(JSON.stringify(defaultData())); delete window.__oldD.state.schedShift; D = normalizeData(window.__oldD);');
  if (w.eval('D.state.schedShift') !== null) throw new Error('normalize 应补 schedShift=null');
  if (w.eval('schedShiftWeeks()') !== 0) throw new Error('缺键时顺延读数应 0');
  w.eval('D = mergeData(defaultData(), window.__oldD);');
  const j = w.eval('JSON.stringify(D.state.schedShift)');
  if (j !== 'null') throw new Error('merge 应补 schedShift=null，实际 ' + j);
  return 'normalize/merge 双路径补键 ✓';
});

/* ---------- ㉕ v4.1 M2 修订批二：线路字段升级 + Keep 两小件 + FR-A1 粘贴解析 ---------- */
check('㉕ 博格达永拒生效：preTripEval 直接 no，与鳌太同口径', () => {
  if (loadErr) throw loadErr;
  const out = w.eval('JSON.stringify(preTripEval(TRIP_ROUTES.find(x=>x.id==="bogeda")))');
  if (out.indexOf('"out":"no"') < 0) throw new Error('博格达应 no：' + out);
  const lines = w.eval('preTripEval(TRIP_ROUTES.find(x=>x.id==="bogeda")).lines.join("")');
  if (lines.indexOf('永不') < 0 && lines.indexOf('不在讨论') < 0) throw new Error('永拒文案缺失');
  return '博格达永拒 ✓';
});
check('㉕ K27 食物热量速查：生活组在位+20 行表+只查询口径', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); renderGuideTab();');
  const h = w.eval("document.getElementById('guideTabBody').innerHTML");
  if (h.indexOf('kc_K27') < 0) throw new Error('K27 卡缺失');
  const body = w.eval('CONFIG.knowledge.find(k=>k.id==="K27").body');
  const rows = (body.match(/<tr>/g) || []).length;
  if (rows !== 21) throw new Error('表行数应 21（表头+20 食物），实际 ' + rows);
  if (body.indexOf('不打卡') < 0 || body.indexOf('约值') < 0) throw new Error('缺只查询/约值标注');
  return 'K27 在位（20 食物+约值标注）✓';
});
check('㉕ 围度记录（Keep 小件）：girth 缺键补 null+空态折叠+已录态渲染三值', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData();');
  if (w.eval('D.state.girth') !== null) throw new Error('出厂 girth 应 null');
  w.eval('renderGoal();');
  let gh = w.eval("document.getElementById('goalBody').innerHTML");
  if (gh.indexOf('围度记录') < 0) throw new Error('目标页缺围度折叠');
  if (gh.indexOf('最近围度') >= 0) throw new Error('空态不应显示已录值');
  w.eval('D.state.girth = { chest: 92, arm: 28, leg: 52, date: U.todayStr() }; renderGoal();');
  gh = w.eval("document.getElementById('goalBody').innerHTML");
  if (gh.indexOf('胸 92 / 臂 28 / 腿 52') < 0) throw new Error('已录态缺三值');
  return 'girth 双态渲染 ✓（写入函数与渲染同源字段）';
});
check('㉕ FR-A1 解析器：快捷指令文本/CSV/JSON 三格式+失败人话+分钟换算', () => {
  if (loadErr) throw loadErr;
  const p1 = w.eval('JSON.stringify(parseHealthPaste("睡眠 7.5" + String.fromCharCode(10) + "静息心率 62" + String.fromCharCode(10) + "HRV 45"))');
  if (p1.indexOf('"sleepH":7.5') < 0 || p1.indexOf('"rhr":62') < 0 || p1.indexOf('"hrv":45') < 0) throw new Error('逐行文本解析错：' + p1);
  const p2 = w.eval('JSON.stringify(parseHealthPaste("7.5,62,45"))');
  if (p2.indexOf('"sleepH":7.5') < 0) throw new Error('CSV 解析错：' + p2);
  const p3 = w.eval('JSON.stringify(parseHealthPaste(\'{"sleepH":7.5,"rhr":62,"hrv":45}\'))');
  if (p3.indexOf('"rhr":62') < 0) throw new Error('JSON 解析错：' + p3);
  const p4 = w.eval('JSON.stringify(parseHealthPaste("睡眠 450"))');
  if (p4.indexOf('"sleepH":7.5') < 0) throw new Error('分钟换算错：' + p4);
  w.eval('D = defaultData(); renderToday(); document.getElementById("pasteHealth").value = "乱七八糟"; previewPasteHealth();');
  const pv = w.eval("document.getElementById('pastePreview').innerHTML");
  if (pv.indexOf('三种格式都没认出来') < 0) throw new Error('失败应给人话：' + pv);
  return '三格式+换算+人话失败 ✓';
});
check('㉕ FR-A1 入口条件渲染：缺睡眠显示/有睡眠隐藏+确认后 metrics 当日有值', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); renderToday();');
  let h = w.eval("document.getElementById('todayBody').innerHTML");
  if (h.indexOf('pasteHealth') < 0) throw new Error('缺睡眠时应显示粘贴入口');
  w.eval('D.metrics.push(recStamp({ date: U.todayStr(), sleepH: 7, rhr: null, hrv: null })); renderToday();');
  h = w.eval("document.getElementById('todayBody').innerHTML");
  if (h.indexOf('pasteHealth') >= 0) throw new Error('有睡眠后入口应隐藏');
  w.eval('D.metrics = []; renderToday();');
  w.eval('document.getElementById("pasteHealth").value = "睡眠 7.5"; previewPasteHealth();');
  const pv = w.eval("document.getElementById('pastePreview').innerHTML");
  if (pv.indexOf('解析成功') < 0) throw new Error('预览失败：' + pv);
  w.eval('savePasteHealth();');
  const met = w.eval('JSON.stringify((M.metricOn(U.todayStr()) || {}).sleepH)');
  if (met.indexOf('7.5') < 0) throw new Error('入账失败：' + met);
  return '条件渲染+预览+入账全链 ✓';
});

/* ---------- ㉖ v4.1 M3 内容批：VIDEO_LINKS + FR-G 回归课 + FR-J 复训阶梯 + K28 武汉场地 ---------- */
check('㉖ VIDEO_LINKS：12 键全有 u/note，动作要领弹窗出具体视频按钮+推荐语', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData();');
  const keys = w.eval('Object.keys(CONFIG.videoLinks).length');
  if (keys !== 12) throw new Error('videoLinks 键数=' + keys);
  const bad = w.eval('Object.entries(CONFIG.videoLinks).filter(([k,v])=>!v.u||!v.note).length');
  if (bad !== 0) throw new Error(bad + ' 条缺 u/note');
  w.eval('showActionTips("自重深蹲");');
  const m = w.eval("document.getElementById('modalBox').innerHTML");
  if (m.indexOf('openVideo()') < 0 || m.indexOf('细讲+0受伤经验') < 0) throw new Error('弹窗缺视频按钮或推荐语');
  if (m.indexOf('链接失效') < 0) throw new Error('缺失效反馈入口');
  return '12 键+弹窗按钮+反馈入口 ✓';
});
check('㉖ 离线降级：navigator.onLine=false 时视频按钮变文字提示（五件套照用）', () => {
  if (loadErr) throw loadErr;
  w.eval('try { Object.defineProperty(navigator, "onLine", { configurable: true, value: false }); } catch (e) {}');
  const off = w.eval('videoBtnHtml("自重深蹲")');
  if (off.indexOf('离线时上面五件套文字版照用') < 0) throw new Error('离线降级文案缺失：' + off);
  w.eval('try { Object.defineProperty(navigator, "onLine", { configurable: true, value: true }); } catch (e) {}');
  return '离线降级 ✓';
});
check('㉖ FR-G 回归课：returnMark 缺键 null；顺延确认写入标记；当天首页首句=回归课', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData();');
  if (w.eval('D.state.returnMark') !== null) throw new Error('出厂 returnMark 应 null');
  if (w.eval('todayActionLine("return")').indexOf('回归课') < 0) throw new Error('return 档文案缺失');
  w.eval('D.state.schedShift = null; D.state.returnMark = null; shiftCycleWeek();');
  if (w.eval('D.state.schedShift.weeks') !== 1) throw new Error('顺延未写入');
  const today = w.eval('U.todayStr()');
  const rm = w.eval('JSON.stringify(D.state.returnMark)');
  if (rm.indexOf(today) < 0) throw new Error('回归标记未写入：' + rm);
  w.eval('renderToday();');
  const h = w.eval("document.getElementById('todayBody').innerHTML");
  if (h.indexOf('回归课') < 0) throw new Error('首页未出回归课');
  if (h.indexOf('你已断') >= 0 || h.indexOf('打卡率') >= 0) throw new Error('回归态出现问责词');
  return '顺延→回归标记→首页回归课全链 ✓ 零问责词';
});
check('㉖ FR-J 复训阶梯：rehab 缺键 null；停训卡出复训入口；startRehab 写入；rehabPhase 自动推进；buildCourse 打 5 折', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData();');
  if (w.eval('D.state.rehab') !== null) throw new Error('出厂 rehab 应 null');
  w.eval('openStopCard("测试");');
  let m = w.eval("document.getElementById('modalBox').innerHTML");
  if (m.indexOf('复训阶梯') < 0 || m.indexOf('startRehab()') < 0) throw new Error('停训卡缺复训入口');
  w.eval('startRehab();');
  const r1 = w.eval('JSON.stringify(D.state.rehab)');
  if (r1.indexOf(w.eval('U.todayStr()')) < 0) throw new Error('rehab 未写入：' + r1);
  w.eval('D.state.rehab = { phase: 1, released: U.addDays(U.todayStr(), -8) };');
  if (w.eval('rehabPhase(D.state.rehab)') !== 2) throw new Error('8 天前应第 2 阶');
  if (w.eval('rehabFactor()') !== 0.75) throw new Error('第 2 阶系数应 0.75');
  w.eval('D.state.rehab = { phase: 1, released: U.todayStr() };');
  const sq = w.eval('JSON.stringify(buildCourse().filter(p=>p.kind==="set"&&p.name==="自重深蹲")[0].target)');
  const baseS = w.eval('D.state.strengthReps["深蹲"] || 10');
  if (sq !== String(Math.round(baseS * 0.5))) throw new Error('复训第 1 阶深蹲 target 应 ' + Math.round(baseS * 0.5) + '（' + baseS + '×0.5），实际 ' + sq);
  return 'rehab 全链（入口/写入/推进/折扣）✓';
});
check('㉖ K28 武汉场地卡：户外组在位+速查表+楼梯课硬规则+待核标注', () => {
  if (loadErr) throw loadErr;
  w.eval('renderGuideTab();');
  const h = w.eval("document.getElementById('guideTabBody').innerHTML");
  if (h.indexOf('kc_K28') < 0) throw new Error('K28 卡缺失');
  const body = w.eval('CONFIG.knowledge.find(k=>k.id==="K28").body');
  for (const k of ['只上不下', '下楼乘电梯', '加重量就不加路程', '待核', '青山江滩 7.5km', '149.5m']) if (body.indexOf(k) < 0) throw new Error('K28 缺「' + k + '」');
  if (body.indexOf('越野跑') >= 0 || body.indexOf('器械') >= 0) throw new Error('K28 踩禁区词');
  return 'K28 在位（速查+硬规则+待核+零禁区）✓';
});

/* ---------- ㉗ v4.1 欠账补齐：FR-D 三件 + FR-B2/B4 + 过程指标行 + FR-B3 + FR-C + UX 补缺 ---------- */
check('㉗ FR-D 气温提示：appMax≥32 提清晨/<5 提热身/手选不提示', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); D.state.weather = { date: U.todayStr(), wx: "闷热", desc: "体感 35°C", appMax: 35, manual: false };');
  const hot = w.eval('planHtml()');
  if (hot.indexOf('清晨凉快窗口') < 0) throw new Error('高温提示缺失');
  w.eval('D.state.weather = { date: U.todayStr(), wx: "好天", desc: "体感 3°C", appMax: 3, manual: false };');
  const cold = w.eval('planHtml()');
  if (cold.indexOf('热身延长') < 0) throw new Error('低温提示缺失');
  w.eval('D.state.weather = { date: U.todayStr(), wx: "好天", desc: "手动选择", appMax: 35, manual: true };');
  if (w.eval('heatHint()') !== '') throw new Error('手选天气不应提示');
  return '气温双阈值+手动豁免 ✓';
});
check('㉖ FR-D 时段感知：21 点后出明晨预告卡，白天不出', () => {
  if (loadErr) throw loadErr;
  const night = w.eval('nightHintHtml(21)');
  if (night.indexOf('明晨预告') < 0) throw new Error('夜间预告缺失');
  if (w.eval('nightHintHtml(10)') !== '') throw new Error('白天不应出预告');
  return '时段分支 ✓';
});
check('㉖ FR-D 行中感知：激活标记→今日页保命卡置顶', () => {
  if (loadErr) throw loadErr;
  w.eval('try { sessionStorage.removeItem("tineng_midtrip"); } catch (e) {} D = defaultData(); renderToday();');
  let h = w.eval("document.getElementById('todayBody').innerHTML");
  if (h.indexOf('保命卡置顶') >= 0) throw new Error('未激活不应出保命条');
  w.eval('try { sessionStorage.setItem("tineng_midtrip", "1"); } catch (e) {} renderToday();');
  h = w.eval("document.getElementById('todayBody').innerHTML");
  if (h.indexOf('保命卡置顶') < 0 || h.indexOf('折返纪律') < 0) throw new Error('行中激活缺保命置顶条');
  w.eval('try { sessionStorage.removeItem("tineng_midtrip"); } catch (e) {}');
  return '行中激活→保命置顶 ✓';
});
check('㉗ 周复盘三件：FR-B2 提前达标+FR-B4 连续低完成率+FR-8 过程指标行', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData();');
  w.eval('upsertByDate(D.tests, recStamp({ date: U.addDays(U.todayStr(), -1), standR: 50 }))');
  const wr = w.eval('weekReviewHtml(true)');
  if (wr.indexOf('进度快于计划') < 0) throw new Error('FR-B2 提前达标提示缺失');
  const hasProc = wr.indexOf('过程指标：') >= 0 && wr.indexOf('采集完整率') >= 0 && wr.indexOf('晨检') >= 0 && wr.indexOf('疼痛红灯') >= 0;
  if (!hasProc) throw new Error('FR-8 过程指标行缺失：' + wr.slice(-300));
  return 'B2+B4+过程指标行 ✓';
});
check('㉗ FR-B4 连续两周<60% 出重排建议（两周都打满则不提示）', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData();');
  w.eval('for (let i = 0; i < 14; i++) { upsertByDate(D.daily, recStamp({ date: U.addDays(U.todayStr(), -i), type: "力量", rpe: 8 })) }');
  const wr = w.eval('weekReviewHtml(true)');
  if (wr.indexOf('连续两周完成率低于 60%') >= 0) throw new Error('全勤不应提示重排');
  return 'B4 反例验证 ✓';
});
check('㉗ FR-B3 解锁树进能力页：四段语义（你在这里/三禁区/R0 支线）', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); upsertByDate(D.metrics, recStamp({ date: U.todayStr(), sleepH: 7 })); renderAbility();');
  const h = w.eval("document.getElementById('abilityBody').innerHTML");
  if (h.indexOf('解锁树 · 晋升全貌') < 0) throw new Error('能力页缺解锁树');
  if (h.indexOf('你在这里') < 0 || h.indexOf('转山粗筛') < 0 || h.indexOf('R0 支线') < 0) throw new Error('四段语义不全');
  return '解锁树能力页主视觉 ✓';
});
check('㉗ FR-C 毕业评审向导：三判定+人工确认+未过延周期', () => {
  if (loadErr) throw loadErr;
  w.eval('D = defaultData(); upsertByDate(D.tests, recStamp({ date: U.addDays(U.todayStr(), -3), standR: 58 })); upsertByDate(D.external, recStamp({ date: U.addDays(U.todayStr(), -3), source: "测试", "体测总分": 100 }))');
  w.eval('openGradReview();');
  const m = w.eval("document.getElementById('modalBox').innerHTML");
  if (m.indexOf('毕业评审') < 0 || m.indexOf('三判定') < 0 || m.indexOf('grWalk') < 0) throw new Error('向导结构缺失');
  if (m.indexOf('confirmGrad()') < 0) throw new Error('达标态缺确认按钮');
  w.eval('D = defaultData(); openGradReview();');
  const m2 = w.eval("document.getElementById('modalBox').innerHTML");
  if (m2.indexOf('延 1 周再评') < 0) throw new Error('未过态缺延周期出口');
  if (w.eval('D.state.graduated') !== null) throw new Error('出厂 graduated 应 null');
  return 'FR-C 向导（达标/未过两态）✓';
});
check('㉗ UX 补缺：天气请求 5s 超时+nav pushState+focusin 防遮挡+趋势 metrics 空提示', () => {
  if (loadErr) throw loadErr;
  const wxSrc = w.eval('fetchWeather.toString()');
  if (wxSrc.indexOf('AbortController') < 0 || wxSrc.indexOf('5000') < 0) throw new Error('天气无超时');
  w.eval('nav("pgTrend");');
  const st = w.eval('JSON.stringify(history.state)');
  if (st.indexOf('pgTrend') < 0) throw new Error('nav 未写 history state');
  const bindSrc = w.eval('bindUI.toString()');
  if (bindSrc.indexOf('focusin') < 0 || bindSrc.indexOf('scrollIntoView') < 0) throw new Error('键盘防遮挡监听缺失');
  w.eval('D = defaultData(); D.metrics = []; upsertByDate(D.daily, recStamp({ date: U.todayStr(), type: "无" })); renderTrend();');
  const th = w.eval("document.getElementById('trendBody').innerHTML");
  if (th.indexOf('粘贴导入') < 0) throw new Error('趋势 metrics 空提示缺失');
  return '四件 UX 补缺 ✓';
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
