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
check('⑨ M6 周次边界：9/28=W1、12/20=W12、12/27=满、9/27=未开营', () => {
  const v = (d) => w.eval('mountainWeekOf("' + d + '")');
  if (v('2026-09-28') !== 1 || v('2026-12-20') !== 12 || v('2026-12-27') !== 13 || v('2026-09-27') !== 0) throw new Error('周次边界错');
  return '4 个边界全对';
});
check('⑨ M6 卡：W11 峰值 8kg / W12 检阅周减量 / 毕业线提示在位', () => {
  const card = w.eval('mountainGoalHtml()');
  if (card.indexOf('转山倒排') < 0) throw new Error('缺倒排卡头');
  const cardW1 = w.eval('mountainGoalHtml("2026-09-28")'); // W1 周一：走 W1-12 分支
  if (cardW1.indexOf('第 1/12 周') < 0 || cardW1.indexOf('毕业线') < 0) throw new Error('W1 分支缺周次或毕业线');
  if (w.eval('MOUNTAIN12[10].load') !== 8) throw new Error('W11 峰值应 8kg');
  const w12 = w.eval('MOUNTAIN12[11]');
  if (w12.climb !== 350 || w12.note.indexOf('检阅周') < 0) throw new Error('W12 应减量检阅');
  return '倒排卡要素齐全';
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

/* ---------- 输出 ---------- */
const fails = results.filter(r => !r.ok);
console.log('================ P0 jsdom 断言报告（node ' + process.version + ' · jsdom ' + require('jsdom/package.json').version + '） ================');
console.log('脚本注入：' + (loadErr ? '失败！' + loadErr.message : '成功（init 未触发，符合预期）'));
for (const r of results) {
  console.log((r.ok ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? ' | ' + r.detail : ''));
}
console.log('================ 合计 ' + results.length + ' 项，通过 ' + (results.length - fails.length) + '，失败 ' + fails.length + ' ================');
process.exit(fails.length || loadErr ? 1 : 0);
