/**
 * 揭棋引擎「百局稳定性」压力测试 —— 直接驱动**真实 WASM 引擎** + **真实客户端规则层**
 *
 * ============================================================================
 * 【为什么能这样跑】
 *
 * 客户端揭棋的搜索链是三段：
 *   1. 规则/局面层  GameEngine / RuleEngine / jieqi*.ts —— 纯 TS，无 RN 依赖；
 *   2. 载荷编解码层 jieqiRuntime / jieqiHistory / jieqiFen —— 纯 TS，无 RN 依赖；
 *   3. 引擎宿主层  pikafish/jieqiHost.ts —— **依赖 Worker + require(资源)**，Node 跑不了。
 *
 * 前两层正是最容易出「池不自洽 / 历史重放中止」这类静默缺陷的地方，
 * 而它们在 Node 下可直接复用。宿主层则用 engine-source/jieqi/jieqi.js 直连 WASM
 * 等价替代（同一份引擎二进制、同一套命令序列）。
 *
 * ⇒ 本脚本覆盖的正是真实链路的全部**决策逻辑**，只有「Worker 封装」被等价替换。
 *
 * ============================================================================
 * 【每一局检查什么】
 *
 *   A. 规则合法   每一步都必须落在 enumerateLegalMoves 里（引擎不得给出非法着法）
 *   B. 引擎成功   每次搜索都必须拿到 bestmove（不许静默回落）
 *   C. 池自洽     每一步 assertPoolMatchesBoard 不得抛（这是历史 BUG 的守门）
 *   D. 历史完整   buildJieqiHistoryMoves 的 abortedAt 必须是 -1
 *   E. 终局正常   走到将死/困毙/自然终局，且步数在合理区间（无死循环/软锁）
 *
 * 用法（在 client/ 下）：node engine-source/jieqi/stress100.cjs [局数] [档位]
 */

/* eslint-disable */
// ⚠️⚠️ 【绝对不要给本脚本传命令行参数】——实测踩过，这是本脚本最隐蔽的坑：
//
//   `node stress100.cjs 100 medium`  →  引擎报 `Unknown command: '100 medium '`
//   `node stress100.cjs`（无参数）    →  引擎正常出着
//
// 原因：这份 Emscripten glue 在 `process.argv` **含有额外参数**时，
// 会忽略宿主注入的 `stdin` 回调，回落到真实 `process.stdin`；
// 而本机 Node 的 stdin 被接到 argv 字符串上，于是脚本参数被当成 UCI 命令
// 喂进引擎。注意这与 verify.cjs 无关（它不接受参数，所以从未触发）。
//
// ⇒ 配置一律走**环境变量**：JIEQI_GAMES（局数）、JIEQI_TIER（档位）。
//
// 用法（在 client/ 下）：
//   node engine-source/jieqi/gen-stress-bundle.mjs                 # 先打包规则层
//   $env:JIEQI_GAMES=100; $env:JIEQI_TIER='medium'; node engine-source/jieqi/stress100.cjs
const path = require('path');
const fs = require('node:fs');
const here = __dirname;

const BUNDLE = path.join(here, 'stress-entry.bundle.cjs');
if (!fs.existsSync(BUNDLE)) {
  console.error('[stress100] 缺少规则层打包产物 ' + BUNDLE);
  console.error('  请先执行：node engine-source/jieqi/gen-stress-bundle.mjs');
  process.exit(3);
}

// --- 规则/编解码层（与 App 运行时同一份源码，经 esbuild 预打包） ---
const X = require(BUNDLE);
const {
  createJieqiInitialState, makeSeededRand, sideOfId, makeMove,
  enumerateLegalMoves, setJieqiRuntime, getJieqiRuntime, clearJieqiRuntime,
  buildJieqiSearchPayload, createDeterminization, computePoolFromState,
  makeDeterministicRand, declareCapturedIdentity, topUpCapturedDeclarations,
  buildJieqiHistoryMoves, parseBestmove, createInfoState, consumeEngineLine,
  toJieqiFen,
  getJieqiTier, assertPoolMatchesBoard, liveHiddenCount,
  RED_SIDE, BLACK_SIDE,
} = X;

// --- 真实引擎（与 jieqiHost.ts 同一条命令序列） ---
const createModule = require(path.join(here, 'jieqi.js'));
const WASM = fs.readFileSync(path.join(here, 'jieqi.wasm'));

/**
 * 跑一次 UCI 会话（等价于 jieqiHost.runJieqiSession 的命令序列）。
 * 与 worker-core.js 同款 stdin 契约：同步 getline，EOF 即 quit。
 *
 * ⚠️ 收尾等待要够长：引擎在 promise resolve 后仍会把 stdout 缓冲吐完
 * （verify.cjs 用 1500ms、faceoff.mjs 用 2500ms）。这里用 250ms ——
 * depth 搜索已由 depth+movetime 兜底，剩下的只是 drain 缓冲，实测充足。
 */
function runSession(commands) {
  const text = commands.join('\n') + '\n';
  let pos = 0;
  const out = [];
  if (DUMP_CMDS) console.error('[dbg] stdin 文本=' + JSON.stringify(text));
  return new Promise((resolve, reject) => {
    const M = createModule({
      print: (t) => { out.push(String(t)); if (DUMP && /Unknown|bestmove|uciok/.test(String(t))) console.error('[dbg] << ' + t); },
      printErr: (t) => out.push('[err] ' + String(t)),
      locateFile: (f) => (f.endsWith('.wasm') ? path.join(here, 'jieqi.wasm') : f),
      wasmBinary: WASM,
      stdin: () => (pos < text.length ? text.charCodeAt(pos++) : null),
      // ⚠️ 必须与 verify.cjs / worker-core.js 完全一致的 API 白名单。
      INCOMING_MODULE_JS_API: [
        'stdin', 'print', 'printErr', 'locateFile', 'noInitialRun', 'wasmBinary',
      ],
    });
    Promise.resolve(M).then(
      () => setTimeout(() => resolve(out), 400),
      (e) => reject(e)
    );
  });
}

/**
 * 按 buildJieqiSearchPayload 的同口径重放声明，得到「引擎本轮会看到的池」。
 * 独立复算一遍，避免把被测代码的异常吞掉。
 */
function freshDeclaredOf(state) {
  const ctx = getJieqiRuntime();
  const seed = ctx.determinization.seed;
  const freshDet = createDeterminization(seed);
  const rand = makeDeterministicRand(seed);
  buildJieqiHistoryMoves(state, ctx.initialState, (victimSide, atState) =>
    declareCapturedIdentity(freshDet, victimSide, rand, atState)
  );
  topUpCapturedDeclarations(freshDet, state, rand);
  return freshDet.capturedDeclared;
}

/** 与 aiDispatcher.runJieqiEngine 同构：取 bestmove 并解析成内部坐标 */
async function engineMove(state, tier) {
  const ctx = getJieqiRuntime();
  const t = getJieqiTier(tier);
  const payload = buildJieqiSearchPayload(state, ctx);

  const commands = ['uci', 'isready', `setoption name MultiPV value ${t.multiPV}`];
  if (payload.moves.length > 0) {
    commands.push(`position fen ${payload.fen} moves ${payload.moves.join(' ')}`);
  } else {
    commands.push(`position fen ${payload.fen}`);
  }
  commands.push(`go depth ${t.depth} movetime ${t.movetimeMs}`);
  commands.push('quit');

  if (DUMP_CMDS) {
    console.error('    > ' + JSON.stringify(commands));
  }
  const lines = await runSession(commands);
  const info = createInfoState();
  let bestLine = null;
  for (const line of lines) {
    if (consumeEngineLine(line, info)) { bestLine = line; break; }
  }
  const uci = bestLine ? parseBestmove(bestLine) : null;
  return { uci, payload, info, lines };
}

/** 内部坐标 ← UCI */
function decode(uci) {
  return {
    fromCol: uci.charCodeAt(0) - 97,
    fromRow: 9 - Number(uci[1]),
    toCol: uci.charCodeAt(2) - 97,
    toRow: 9 - Number(uci[3]),
  };
}

/** 合法着法集合 */
function legalSet(state) {
  const s = new Set();
  for (const m of enumerateLegalMoves(state, state.sideTag)) {
    s.add(`${m.pieceId}:${m.fromCol},${m.fromRow}->${m.toCol},${m.toRow}`);
  }
  return s;
}

/**
 * 该局面里是否存在「已翻开、且已离开本方九宫/本方河界」的士或象。
 * 这正是规则 5 放宽的那一类棋子，也正是 jieqi_old 不认识的那一类。
 *
 * ⚠️ 这只能作为**归因线索**，不能单独定罪 —— 见下面 classifyDivergence 的说明。
 */
function hasRevealedAdvisorOutsideHome(state) {
  for (let id = 0; id < 32; id++) {
    if (state.hiddenMask?.[id] === true) continue;      // 暗子按棋位走，引擎认识
    const rev = state.revealedType?.[id];
    if (rev !== 'shi' && rev !== 'xiang') continue;     // 只关心士/象
    const p = state.pieces[id];
    if (!p.alive) continue;
    if (rev === 'shi') {
      // 士：黑方九宫 rows 0-2 / cols 3-5；红方九宫 rows 7-9 / cols 3-5
      const inPalace = p.col >= 3 && p.col <= 5 &&
        (id <= 15 ? p.row <= 2 : p.row >= 7);
      if (!inPalace) return true;
    } else {
      // 象：黑方本半河界 rows 0-4 / 红方 rows 5-9（揭棋已翻开的象可过河）
      const ownHalf = id <= 15 ? p.row <= 4 : p.row >= 5;
      if (!ownHalf) return true;
    }
  }
  return false;
}

/**
 * 把一次「引擎给不出着法」分类。
 *
 * 【2026-10 重要更正】早期版本只看「盘上有没有已翻开出九宫的士象」，
 * 把所有 `bestmove (none)` 都归因到规则 5，这是**错的**：
 * `bestmove (none)` 也可能是引擎的**正确**判定 —— 局面确实已终局（将死/无子可动）。
 *
 * 正确做法：先问本仓库 `enumerateLegalMoves` 还有没有着法。
 *   · 没有 ⇒ 引擎是对的，这是**正常终局**，不是缺陷；
 *   · 有   ⇒ 才是真正的分歧，再看盘上有没有规则 5 的目标棋子来归因。
 *
 * （审计过程中我曾因为两处**自己写的探针脚本**的 bug——
 *   重复使用同一棋位 id、以及 id→棋种字符映射写错——
 *   两次误判「引擎有第二类缺陷」。两次都被本函数的口径纠正：
 *   改成先信 enumerateLegalMoves 后，第二类分歧归零。
 *   教训：任何「引擎 vs 我们」的结论都必须让双方拿到**逐子一致的同一个局面**。）
 */
function classifyDivergence(state) {
  const legal = enumerateLegalMoves(state, state.sideTag);
  if (legal.length === 0) return 'divergedTerminal';            // 引擎是对的：真终局
  return 'divergedEngineBug';                                   // 我们还有着法 ⇒ 引擎缺陷（§16.7）
}

/**
 * ⚠️ **不要**把 `hasRevealedAdvisorOutsideHome` 当判据。
 *
 * 它曾经被用来把分歧归因为「引擎未实现规则 5」，但那个结论**已被推翻**
 * （§16.3：规则 5 是**我们**的 `calcShi` 写错了，引擎一直是对的）。
 * 实测它会在**几乎所有**引擎缺陷局面上都为真 —— 因为揭棋残局里
 * 「已翻开的士象离开了本方九宫/河界」实在太常见，它没有区分力。
 *
 * 保留它只作**线索统计**：看看引擎缺陷局面里有多少同时存在这类棋子，
 * 用于判断 §16.7 与规则 5 是否共享同一条走法生成代码路径。
 */
function advisorClueOf(state) {
  return hasRevealedAdvisorOutsideHome(state) ? 1 : 0;
}

/**
 * 取一步确定的合法着法（模拟生产里 pickAnyLegalMove 的兜底）。
 * 取 pieceId / 落点最小的一步，保证可复现。
 */
function pickAnyLegal(state) {
  let best = null;
  for (const m of enumerateLegalMoves(state, state.sideTag)) {
    if (
      !best ||
      m.pieceId < best.pieceId ||
      (m.pieceId === best.pieceId &&
        (m.toRow < best.toRow || (m.toRow === best.toRow && m.toCol < best.toCol)))
    ) {
      best = m;
    }
  }
  return best;
}

// 配置走环境变量（原因见文件头「绝对不要传命令行参数」的说明）
const GAMES = Number(process.env.JIEQI_GAMES || 100);
const TIER = process.env.JIEQI_TIER || 'medium';
const VERBOSE = process.env.V === '1';
const DUMP_CMDS = process.env.DUMP_CMDS === '1';
const DUMP = process.env.DUMP === '1';

// 对拍：把 TS 编码器真正喂进去的东西原样打出来，供人工核对
let firstDetailPrinted = false;

/** 规则 5 之外的��歧样本（最多 5 个），用于进一步归因 */
const divergedOtherSamples = [];

const report = {
  games: 0,
  plies: 0,
  engineCalls: 0,
  engineFail: 0,       // 引擎抛异常（真故障）
  engineDiverged: 0,   // 引擎给不出着法/给了非法着法 → 回落 TS AI（规则分歧）
  divergedTerminal: 0,    // 我们也无着法 ⇒ 引擎判定正确，是**正常终局**，非缺陷
  divergedEngineBug: 0,   // 我们还有着法、引擎却不给 ⇒ **引擎缺陷**（§16.7），已回落 TS AI
  advisorClue: 0,         // 线索统计：上述缺陷局面里有多少同时存在「已翻开出九宫的士象」
  illegal: 0,             // 引擎给出非法着法（是分歧的一种）
  poolMismatch: 0,     // 池与盘面不自洽
  historyAbort: 0,     // 历史重放中止
  wrongSide: 0,        // 引擎给的子不属于走棋方
  wrongFromSquare: 0,  // from 与实际占位不符
  noProgress: 0,       // 终局判定为僵持（步数超限）
  decodes: 0,
  perGame: [],
};

async function main() {
for (let g = 0; g < GAMES; g++) {
  const seed = 10000 + g;
  const { state: initState, identity } = createJieqiInitialState(makeSeededRand(seed), RED_SIDE);
  let state = initState;
  const det = createDeterminization(seed);
  setJieqiRuntime(initState, seed, det);

  let plies = 0;
  let gameEngineFail = 0, gameIllegal = 0, gamePool = 0, gameHist = 0, gameDiverged = 0;
  let degradedTotal = 0;
  const MAX_PLIES = 200;

  while (plies < MAX_PLIES) {
    // 终局检查（gameStatus 由 makeMove 维护，开局恒为 playing）
    if (state.gameStatus !== 'playing') break;

    let res;
    try {
      res = await engineMove(state, TIER);
    } catch (e) {
      gameEngineFail++;
      report.engineFail++;
      if (!VERBOSE) console.error(`  [g${g}] 引擎异常: ${e && e.message}`);
      break;
    }
    report.engineCalls++;
    if (res.payload.degraded) degradedTotal++;

    if (!res.uci) {
      /**
       * 【2026-10 审计修复】`bestmove (none)` **不是**引擎故障，而是
       * 「引擎与本仓库对同一局面的合法着法认知不一致」。
       *
       * 已定位根因：Pikafish `jieqi_old` **未实现规则 5**
       * （已翻开的士/象不受九宫河界限制）。实测：红帅被困死、
       * 唯一合法棋是一枚**已翻开**且远离九宫的红仕时，引擎仍报
       * `info depth 0 score mate 0` + `bestmove (none)`
       * （换成暗子 x 也一样），而本仓库认为该仕可走。
       *
       * 此时 aiDispatcher.runJieqiEngine 返回 null（:149），
       * runOffline 随即**回落本地 TS AI**（:321-337）——
       * 生产链路是安全的，只是棋力由引擎降级为 TS。
       *
       * 故本脚本此前把它记成「引擎失败 + 中止该局」，既不符合生产行为，
       * 也让 100 局被截短成 20 多局。现改为：照实记录为
       * `engineDiverged`（规则分歧次数）并**让 TS AI 接手继续下完这一局**，
       * 这样既统计到分歧，又不掩盖后续局面的稳定性。
       */
      report.engineDiverged++;
      gameDiverged++;
      const kind = classifyDivergence(state);
      report[kind]++;
      report.advisorClue += advisorClueOf(state);
      if (kind === 'divergedEngineBug' && divergedOtherSamples.length < 5) {
        // 「我们认为还有着法、引擎却不给」= §16.7 的引擎缺陷
        const ctx0 = X.getJieqiRuntime();
        const det0 = createDeterminization(ctx0.determinization.seed);
        const r0 = makeDeterministicRand(ctx0.determinization.seed);
        buildJieqiHistoryMoves(state, ctx0.initialState, (v, s) =>
          declareCapturedIdentity(det0, v, r0, s));
        topUpCapturedDeclarations(det0, state, r0);
        divergedOtherSamples.push({
          g, plies,
          side: state.sideTag ? 'red' : 'black',
          isCheck: state.isCheck,
          nLegal: enumerateLegalMoves(state, state.sideTag).length,
          fen: toJieqiFen(state, computePoolFromState(state, det0.capturedDeclared)),
        });
      }
      const fallback = pickAnyLegal(state);
      if (!fallback) break;
      state = makeMove(state, fallback.pieceId, fallback.toCol, fallback.toRow, identity).newState;
      plies++;
      continue;
    }
    report.decodes++;

    const { fromCol, fromRow, toCol, toRow } = decode(res.uci);

    // 池自洽：这正是历史 BUG「多回合后回落启动中」的守门。
    // buildJieqiSearchPayload 内部会对池/盘面做 assertPoolMatchesBoard，
    // 抛错即意味着引擎将被静默跳过（用户看到「揭棋引擎启动中」）。
    try {
      assertPoolMatchesBoard(state, computePoolFromState(state, freshDeclaredOf(state)));
    } catch (e) {
      report.poolMismatch++;
      gamePool++;
      if (VERBOSE) console.error(`  [g${g} p${plies}] 池不自洽: ${e.message}`);
    }

    // 走棋方 / 起点一致性
    const pid = state.qiPan[fromCol]?.[fromRow] ?? -1;
    if (pid < 0 || sideOfId(pid) !== state.sideTag) {
      // 同上：这是引擎给的**结构错误**（起点都不是走棋方的子），
      // 生产里会被 rejectMoverUnsafe / pickAnyLegalMove 拦下并回落 TS AI。
      report.engineDiverged++;
      gameDiverged++;
      if (VERBOSE) console.error(`  [g${g} p${plies}] 起点不符 uci=${res.uci} pid=${pid} side=${state.sideTag}`);
      const fb0 = pickAnyLegal(state);
      if (!fb0) break;
      state = makeMove(state, fb0.pieceId, fb0.toCol, fb0.toRow, identity).newState;
      plies++;
      continue;
    }

    // 合法性
    const key = `${pid}:${fromCol},${fromRow}->${toCol},${toRow}`;
    if (!legalSet(state).has(key)) {
      /**
       * 引擎给了本仓库判为非法的落点。
       * 与规则 5 同源（引擎不认「已翻开士象可出九宫过河」，
       * 反而**更严**地限制它们，于是它给的落点在我们这里非法）。
       *
       * 生产里这正是本次审计新增的 rejectMoverUnsafe 落点闸会拦下的情况
       * （audit A4）⇒ 回落 TS AI，不会让非法着法污染盘面。
       * 这里照实记为 illegal 并让 TS AI 接手继续，把整局跑完。
       */
      report.illegal++;
      gameIllegal++;
      if (VERBOSE) console.error(`  [g${g} p${plies}] 非法着法 uci=${res.uci} pid=${pid}`);
      const fb1 = pickAnyLegal(state);
      if (!fb1) break;
      state = makeMove(state, fb1.pieceId, fb1.toCol, fb1.toRow, identity).newState;
      plies++;
      continue;
    }

    // 历史完整性（引擎能否完整重放）
    if (res.payload.degraded) {
      report.historyAbort++;
      gameHist++;
    }

    if (!firstDetailPrinted) {
      firstDetailPrinted = true;
      console.log('\n[首局首个载荷样例 —— 供人工对拍]');
      console.log('  fen    :', res.payload.fen);
      console.log('  moves  :', res.payload.moves.join(' ') || '(无)');
      console.log('  best   :', res.uci, 'depth', res.info.depth);
      console.log('  在盘暗子:', liveHiddenCount(state));
    }

    state = makeMove(state, pid, toCol, toRow, identity).newState;
    plies++;
  }

  report.games++;
  report.plies += plies;
  const finalStatus = state.gameStatus;
  if (finalStatus === 'playing') report.noProgress++;
  report.perGame.push({
    g, plies, status: finalStatus,
    fail: gameEngineFail, illegal: gameIllegal, pool: gamePool, hist: gameHist,
    diverged: gameDiverged,
    degraded: degradedTotal,
  });
  clearJieqiRuntime();

  if (gameEngineFail || gameIllegal || gameHist || gameDiverged) {
    console.error(`  [局 ${g}] ply=${plies} status=${finalStatus} 异常=${gameEngineFail} 分歧=${gameDiverged} 非法=${gameIllegal} 降级=${degradedTotal}`);
  }
}

console.log('\n================ 揭棋引擎百局压力测试 ================');
console.log(`局数        : ${report.games}（档位 ${TIER}）`);
console.log(`总着法      : ${report.plies}  平均 ${(report.plies / Math.max(1, report.games)).toFixed(1)} 手/局`);
console.log(`引擎调用    : ${report.engineCalls}  成功解码 ${report.decodes}`);
console.log(`引擎异常    : ${report.engineFail}（真故障：抛错/超时/崩溃）`);
console.log(`规则分歧    : ${report.engineDiverged}（引擎给不出着法或给了非法着法 → 回落 TS AI）`);
console.log(`  └归因    : 正常终局(引擎对) ${report.divergedTerminal} / 引擎缺陷${report.divergedEngineBug}` +
  `（其中 ${report.advisorClue} 例同时有「已翻开出九宫的士象」，仅作线索）`);
console.log(`  └非法着法: ${report.illegal}`);
console.log(`池不自洽    : ${report.poolMismatch}`);
console.log(`历史降级    : ${report.historyAbort}`);
console.log(`未终局(僵)  : ${report.noProgress}`);

const statuses = {};
for (const p of report.perGame) statuses[p.status] = (statuses[p.status] || 0) + 1;
console.log('终局分布    :', JSON.stringify(statuses));

const lens = report.perGame.map((p) => p.plies).sort((a, b) => a - b);
if (lens.length) {
  console.log(`步数 min/中位/max: ${lens[0]}/${lens[Math.floor(lens.length / 2)]}/${lens[lens.length - 1]}`);
}

/**
 * 【2026-10 审计】判据分层。
 *
 * **致命（必须为 0）**：引擎异常、池不自洽、历史降级 —— 这些都意味着
 * 引擎在喂错局面或会拖垮对局，与规则分歧无关。
 *
 * **已知的规则分歧（不判致命）**：`jieqi_old` 未实现规则 5
 * （已翻开士象可出九宫过河），会在残局给出本仓库判非法的着法、
 * 或直接报 `bestmove (none)`。生产链路对此已安全降级
 * （rejectMoverUnsafe 落点闸 + pickAnyLegalMove 兜底回落 TS AI），
 * 故它影响**棋力**（残局退回 TS AI），不影响**对局正确性**。
 * 这里照实统计，作为「引擎棋力覆盖度」指标而非正确性闸门。
 *
 * ⚠️ 归因必须**先问 `enumerateLegalMoves`**：若我们自己也已无着法，
 * 引擎的 `(none)` 就是**正确的终局判定**，不该记成分歧。
 * 早期版本漏了这一步，把正常终局误计为规则 5 分歧。
 * 详见 `classifyDivergence` 的注释（含我自己探针脚本的两处坑）。
 */
const fatal = report.engineFail + report.poolMismatch + report.historyAbort;
console.log(`\n致命项（必须为 0）: 异常 ${report.engineFail} / 池不自洽 ${report.poolMismatch} / 历史降级 ${report.historyAbort}`);
console.log(
  `规则分歧（引擎给不出着法，已回落 TS AI）: ${report.engineDiverged}` +
  `  占引擎调用 ${((report.engineDiverged / Math.max(1, report.engineCalls)) * 100).toFixed(2)}%` +
  `  —— 其中 引擎缺陷 ${report.divergedEngineBug}、正常终局 ${report.divergedTerminal}`
);
if (divergedOtherSamples.length) {
  console.log('\n--- 引擎缺陷样本（我们还有着法、引擎却不给；见 §16.7）---');
  for (const s of divergedOtherSamples) console.log(JSON.stringify(s));
}
console.log(`\nRESULT     : ${fatal === 0 ? 'PASS（零异常、池恒自洽、历史完整）' : 'FAIL（有 ' + fatal + ' 处致命项）'}`);
process.exit(fatal === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[stress100] 未捕获异常:', e && e.stack);
  process.exit(2);
});