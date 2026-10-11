/**
 * 浏览器端到端验证：揭棋引擎接入（**含吃暗子**的长对局）
 *
 * ============================================================================
 * 【为什么必须有这个脚本（而不只是单元的 + 引擎的 E2E）】
 *
 * 2026-10 实测暴露的两个 bug 都**躲过了**单元测试与引擎直连 E2E：
 *   1. `require(变量)` 让 Metro **整个 bundle 编译失败** ⇒ 应用跑旧代码
 *      ⇒ 揭棋显示「基础AI」；
 *   2. 声明簿记**跨搜索累积** ⇒ 有吃子后池与盘面不符 ⇒ 引擎被静默跳过
 *      ⇒ 显示「揭棋引擎启动中」。
 *
 * 这两个都只有**走真实 UI + 真实吃子**才能发现。故本脚本：
 *   · 走真实 UI（点击棋盘落子）；
 *   · 用一条**必然吃子**的路线（红兵连续前进，第 3 步吃黑卒=暗子）；
 *   · 全程断言角标**不得**出现「启动中」；
 *   · 最后读存档**证明真的发生了吃子**（否则测试无意义）。
 *
 * 前置：Expo Web 已启动（默认 http://127.0.0.1:5000）
 * 依赖：puppeteer-core（复用本机 Chrome）
 * 用法：node browser-verify-captures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadPuppeteer() {
  const cands = [];
  if (process.env.PUPPETEER_CORE_PATH) cands.push(process.env.PUPPETEER_CORE_PATH);
  if (process.env.NODE_PATH) {
    for (const p of process.env.NODE_PATH.split(path.delimiter)) {
      if (p) cands.push(path.join(p, 'puppeteer-core'));
    }
  }
  cands.push('puppeteer-core');
  for (const c of cands) {
    try { return require(c); } catch { /* next */ }
  }
  return null;
}

const puppeteer = loadPuppeteer();
if (!puppeteer) {
  console.error('[verify-captures] 缺少可选依赖 puppeteer-core。');
  console.error('  npm i puppeteer-core   然后用 PUPPETEER_CORE_PATH 指向它');
  process.exit(2);
}

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5000';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SHOT_DIR = process.env.SHOT_DIR || '';

/**
 * 走子计划（内部坐标，col 0..8 / row 0..9，row0=黑方底线）。
 *
 * 红兵初始在 row6 的 0/2/4/6/8 路，黑卒在 row3 的同列 ⇒
 * 「各前进 3 步」的第 3 步必然吃掉一枚**暗子**（揭棋开局除将帅全暗）。
 * 5 路交替，即使 AI 移走个别目标，也必然命中若干次。
 */
const PLAN = [
  [2, 6, 2, 5], [2, 5, 2, 4], [2, 4, 2, 3],
  [4, 6, 4, 5], [4, 5, 4, 4], [4, 4, 4, 3],
  [0, 6, 0, 5], [0, 5, 0, 4], [0, 4, 0, 3],
  [8, 6, 8, 5], [8, 5, 8, 4], [8, 4, 8, 3],
  [6, 6, 6, 5], [6, 5, 6, 4], [6, 4, 6, 3],
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 900000,
  defaultViewport: { width: 480, height: 900 },
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const problems = [];
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.text();
    // 引擎回落时会打这条；出现即视为问题
    if (/\[aiDispatcher\]\s*揭棋引擎/.test(t)) problems.push('引擎回落: ' + t.slice(0, 200));
  });
  page.on('pageerror', (e) => problems.push('页面异常: ' + e.message.slice(0, 200)));

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await new Promise((r) => setTimeout(r, 12000)); // 等 Metro 首次 bundle

  async function clickText(label, maxExtra = 6) {
    return page.evaluate((lbl, extra) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      let best = null;
      for (const e of Array.from(document.querySelectorAll('div,span,button,a'))) {
        const t = norm(e.innerText);
        if (!t) continue;
        if (!(t === lbl || (t.length <= lbl.length + extra && t.includes(lbl)))) continue;
        const r = e.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const area = r.width * r.height;
        if (!best || area < best.area) best = { el: e, area };
      }
      if (!best) return false;
      best.el.click();
      return true;
    }, label, maxExtra);
  }

  const chip = () =>
    page.evaluate(() => {
      const t = document.body.innerText;
      return t.split('\n').map((s) => s.trim()).find((l) => /引擎|皮卡鱼|基础AI/.test(l)) || '(无)';
    });

  const boardRect = () =>
    page.evaluate(() => {
      let best = null;
      for (const e of Array.from(document.querySelectorAll('div'))) {
        const r = e.getBoundingClientRect();
        if (r.width < 240 || r.height < 240) continue;
        const ratio = r.width / r.height;
        if (ratio < 0.7 || ratio > 1.35) continue;
        const area = r.width * r.height;
        if (!best || area > best.area) best = { area, r };
      }
      return best ? { x: best.r.x, y: best.r.y, w: best.r.width, h: best.r.height } : null;
    });

  console.log('=== 进入揭棋对局（执红 / 入门档）===');
  await clickText('人机对战'); await new Promise((r) => setTimeout(r, 3000));
  await clickText('揭棋');     await new Promise((r) => setTimeout(r, 1500));
  await clickText('入门');     await new Promise((r) => setTimeout(r, 1000));
  await clickText('开始');     await new Promise((r) => setTimeout(r, 5000));

  const rect = await boardRect();
  if (!rect) throw new Error('未找到棋盘');
  const cw = rect.w / 9;
  const ch = rect.h / 10;
  const px = (c, r) => ({ x: rect.x + cw * (c + 0.5), y: rect.y + ch * (r + 0.5) });

  const first = await chip();
  console.log('开局角标:', first);
  if (!/揭棋引擎/.test(first)) problems.push('开局角标不是「揭棋引擎」: ' + first);

  for (let i = 0; i < PLAN.length; i++) {
    const [fc, fr, tc, tr] = PLAN[i];
    const a = px(fc, fr);
    const b = px(tc, tr);
    await page.mouse.click(a.x, a.y);
    await new Promise((r) => setTimeout(r, 800));
    await page.mouse.click(b.x, b.y);
    await new Promise((r) => setTimeout(r, 2500));

    const afterMine = await chip();
    if (/启动中/.test(afterMine)) {
      problems.push(`红方第 ${i + 1} 手后出现回落: ${afterMine}`);
    }

    // 等 AI 回应（入门档 movetime 3000ms，留足余量）
    let afterAi = afterMine;
    for (let k = 0; k < 16; k++) {
      await new Promise((r) => setTimeout(r, 2000));
      afterAi = await chip();
      if (!/启动中/.test(afterAi)) break;
    }
    if (/启动中/.test(afterAi)) {
      problems.push(`AI 第 ${i + 1} 回合回应后出现回落: ${afterAi}`);
      break;
    }
    if (SHOT_DIR) {
      await page.screenshot({ path: path.join(SHOT_DIR, `ply${i + 1}.png`) });
    }
  }

  const finalChip = await chip();
  console.log('结束角标:', finalChip);

  // ---- 读存档，证明真的发生了吃子 ----
  console.log('\n=== 读取存档（证明覆盖了「吃暗子」触发条件）===');
  await clickText('返回', 0);
  await new Promise((r) => setTimeout(r, 1500));
  await clickText('保存', 0);
  await new Promise((r) => setTimeout(r, 3000));

  const save = await page.evaluate(() => {
    const raw = localStorage.getItem('chess_jieqi_save');
    if (!raw) return { err: 'no-save' };
    try {
      const o = JSON.parse(raw);
      return {
        capturedRed: o.capturedRed,
        capturedBlack: o.capturedBlack,
        moveCount: o.moveCount,
        moves: o.gameState?.moveHistory?.length,
        variant: o.gameState?.variant,
        hasIdentity: !!o.jieqiIdentity,
      };
    } catch (e) {
      return { err: 'parse: ' + String(e).slice(0, 80) };
    }
  });
  console.log(' ', JSON.stringify(save));

  const totalCaptured = (save.capturedRed ?? 0) + (save.capturedBlack ?? 0);
  if (save.err) problems.push('存档读取失败: ' + save.err);
  else if (totalCaptured === 0) {
    problems.push('本局未记录到吃子 —— 测试未覆盖触发条件（需调整走法计划）');
  }

  // ---- 结论 ----
  console.log('\n========== 结果 ==========');
  console.log(`角标（开局→结束）: ${first} → ${finalChip}`);
  console.log(`被吃总数: ${totalCaptured}（红被吃 ${save.capturedRed ?? '-'} / 黑被吃 ${save.capturedBlack ?? '-'}）`);
  if (problems.length === 0) {
    console.log('✅ PASS：全程「揭棋引擎」，且确认发生过吃子');
    process.exitCode = 0;
  } else {
    console.log('❌ FAIL：');
    problems.forEach((p) => console.log('   - ' + p));
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
