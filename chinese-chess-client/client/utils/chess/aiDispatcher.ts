/**
 * AI 调度器：**纯本地**（本地皮卡鱼 → 旧 TS AI 兜底），不发起任何网络请求。
 *
 * ============================================================================
 * 【2026-10 服务端去 AI 化：在线分支已整体移除】
 *
 * 此前这里是「混合调度」：本地皮卡鱼优先，本地不可用才回退服务端在线皮卡鱼
 * （/api/v1/ai/move），并带一整套配套机制——NetInfo 预判、2s 超时、busy 指数退避、
 * 熔断与半开自愈、主动重连定时器，以及给 UI 订阅的在线状态角标。
 *
 * 服务端 AI 已移除后，那条回退路径**只剩代价、没有收益**：
 *   · 端点不存在 → 每步都要白跑一次注定 404 的请求，再吃一次超时；
 *   · 连续失败打开熔断后，"重连中"角标会常驻——这正是 2026-10 用户实测反馈的
 *     那个误导性提示的同一条路径，删掉服务端反而更容易复发；
 *   · 棋力并不会变强（难度档位本就同源，在线唯一的独有优势只有开局库）。
 *
 * 因此这里删除 onlineAI / onlineMoveGuard 与全部熔断重连状态机，语义收敛为：
 * **本地皮卡鱼 → 旧 TS AI 两层兜底，永远不联网**。
 *
 * 保留的只有一样东西：引擎来源标签（'pikafish-local' / 'pikafish-starting' / 'legacy'），
 * UI 靠它如实显示"这一步是谁算的"。
 * ============================================================================
 * 【离线侧是"本地皮卡鱼"，不再是纯 TS 搜索】
 *
 * 本地实现是**本地皮卡鱼**（utils/chess/pikafish/）：Web 走 Worker+WASM，
 * Android/iOS 走屏幕外 WebView，引擎与二进制随包内置，因此**完全断网可用**。
 * 难度档位定义在 utils/chess/pikafishTier.ts（唯一来源，客户端自持）。
 *
 * 旧 TS AI（AIEngine.ts）是**最后的兜底**：仅在本地皮卡鱼不可用时启用
 * （资产缺失/承载不支持/引擎崩溃）。详见 utils/chess/pikafish/offlineOrchestrator.ts。
 */

import { getBestMoveAsync, getHintMoveAsync, type AIMoveResult } from './AIEngine';
import {
  requestOfflineMove,
  takeOfflinePonder,
  OfflineSearchAbortedError,
} from './offlineAiAdapter';
import { getOfflineEngine } from './pikafish';
import { isMoveKingSafe, getValidMoves, type GameState } from './GameEngine';
import { enumerateLegalMoves } from './RuleEngine';
import type { AIDifficulty } from './types';
import { getJieqiRuntime, buildJieqiSearchPayload, type JieqiRuntime } from './jieqiRuntime';
import { isJieqiHostAvailable, runJieqiSession } from './pikafish/jieqiHost';
import { getJieqiTier } from './pikafish/jieqiTier';
import { consumeEngineLine, createInfoState, parseBestmove, chooseUci, isCriticalErrorLine } from './jieqiUci';

/**
 * 跑一次揭棋引擎搜索。
 *
 * 模型：一次性批量 UCI 会话（见 pikafish/jieqiHost.ts 顶部说明）。
 *
 * @returns 引擎给出的着法；无可用着法时返回 null（调用方回落 TS AI）
 */
async function runJieqiEngine(
  state: GameState,
  ctx: JieqiRuntime,
  tier: AIDifficulty | 'hint',
  purpose: 'move' | 'hint'
): Promise<{ move: AIMoveResult; depth: number; timeMs: number } | null> {
  const startedAt = Date.now();
  const t = getJieqiTier(tier === 'hint' ? 'hint' : tier);

  const payload = buildJieqiSearchPayload(state, ctx);

  /**
   * 【2026-10 审计 D9：`degraded` 曾被计算但从不读取】
   * 历史不完整时会退化为「纯 FEN 搜索」，代价是引擎**丢失重复局面感知**
   * （影响长将长捉的重复局面判定与引擎自身的和棋判断）。
   * 行为本身是对的（宁可少信息也不错信息），但此前完全静默 ⇒ 无法排查。
   * 现在显式记录一次：频率若不是「极少」，说明历史重建出了问题。
   */
  if (payload.degraded) {
    console.warn(
      '[jieqi-engine] 历史重放不完整，已退化为纯 FEN 搜索（丢失重复局面感知）'
    );
  }

  /**
   * 【2026-10 审计 D3：只发 `go depth`，不发 `go movetime`】
   *
   * 揭棋引擎是 Pikafish `jieqi_old`，实测 `go depth 4 movetime 3000` 在 **~90ms**
   * 就跑完（揭棋每层分支出暗子身份维度，搜索树比象棋大，但 depth 4 依然很浅）。
   * ⇒ `movetime` 在实际档位下**从不生效**（depth 先耗尽），三档的
   * `movetimeMs`（3000/6000/12000）全是死参数，用户看到的「大师档思考更久」
   * 并没有发生。
   *
   * 更关键的是**确定性**：提示档要求「同一局面两次提示给同一着法」。
   * 若只依赖 `depth` 上限，搜索结果确定；若让 `movetime` 真正生效，
   * 则墙钟随机器负载浮动 → 深度浮动 → 提示可能给出不同着法，违背契约。
   *
   * ⇒ 统一「只发 depth」，让档位语义（棋力上限）与实际行为一致；
   * 墙钟由 depth 自然决定（实测各档都在 0.1–2s 量级，手机上亦可接受）。
   * `getJieqiTier` 的 `movetimeMs` 保留字段但改作「宿主侧墙钟上限」
   * （见下方 runJieqiSession 的 timeout），不再发给引擎。
   */
  const commands: string[] = ['uci', 'isready', `setoption name MultiPV value ${t.multiPV}`];
  if (payload.moves.length > 0) {
    commands.push(`position fen ${payload.fen} moves ${payload.moves.join(' ')}`);
  } else {
    commands.push(`position fen ${payload.fen}`);
  }
  commands.push(`go depth ${t.depth}`);
  commands.push('quit');

  const res = await runJieqiSession(commands, t.movetimeMs + 15000);

  /**
   * 【2026-10 审计 D8：显式识别引擎自杀】
   * 引擎遇到非法局面/着法会输出 `info string CRITICAL ERROR` 并**直接退出**，
   * 此时 bestmove 缺失 → parseBestmove 返回 null → 安全回落 TS AI。
   * 行为本就正确，但此前是「巧合正确」，且 `isCriticalErrorLine` 零调用（死代码）。
   * 现在显式判定：CRITICAL 错误视为**硬失败**，不再把它和「引擎没出着」混为一谈，
   * 便于后续把它纳入「引擎不可用 → 切 TS AI 并提示」的统一降级口径。
   */
  const critical = res.lines.find(isCriticalErrorLine);
  if (critical) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[jieqi-engine] CRITICAL:', critical);
    }
    return null;
  }

  const info = createInfoState();
  let bestLine: string | null = null;
  for (const line of res.lines) {
    if (consumeEngineLine(line, info)) {
      bestLine = line;
      break;
    }
  }

  /**
   * 【2026-10 审计 D5：真正启用 `randomPick`】
   * 此前 `jieqiTier.ts` 里 easy 档的 `randomPick: true` 是**死配置**：
   * aiDispatcher 只 `parseBestmove`（恒取 PV1），`consumeEngineLine` 收集的
   * multiPV 候选被直接丢弃 ⇒ 入门档与进阶档走的是同一条「恒取 PV1」的路径，
   * 只有 depth 3 vs 6 的差别，没有配置里承诺的「随机削弱」。
   *
   * 现在：easy 档用 `chooseUci(info, true)` 从 multiPV 候选里随机挑，
   * 其余档仍取 PV1（bestmove 兜底）。`chooseUci` 早已在 jieqiUci.ts 实现并
   * 有单测覆盖，只是生产侧从未调用。
   */
  let uci: string | null = null;
  if (t.randomPick) {
    uci = chooseUci(info, true);
  }
  if (!uci && bestLine) uci = parseBestmove(bestLine);
  if (!uci) return null;

  const fromCol = uci.charCodeAt(0) - 97;
  const fromRow = 9 - Number(uci[1]);
  const toCol = uci.charCodeAt(2) - 97;
  const toRow = 9 - Number(uci[3]);
  if (!Number.isFinite(fromRow) || !Number.isFinite(toRow)) return null;

  const pieceId = state.qiPan[fromCol]?.[fromRow] ?? -1;
  if (pieceId < 0) return null;

  return {
    move: {
      pieceId,
      fromCol,
      fromRow,
      toCol,
      toRow,
      score: 0,
    },
    depth: info.depth,
    timeMs: Date.now() - startedAt,
  };
}

export interface HybridMoveResult extends AIMoveResult {
  /**
   * 走法来源引擎：
   *   · 'pikafish-local'=**客户端本地皮卡鱼**、'pikafish-starting'=引擎仍在启动
   *     （这一步暂由兜底 AI 算出，会自动升级）、'legacy'=旧 TS AI 兜底
   * 带 engine 是为了区分"真引擎"与"兜底"——两者棋力差一个量级，
   * UI 必须能让用户看出当前用的是哪一档（否则升级后毫无感知）。
   */
  engine?: string;
  depth?: number;
  timeMs?: number;
}


/**
 * 统一出口过滤：着法在交给界面落子前，必须确认它不会送将。
 *
 * 本地 AI 与本地提示的搜索本就逐层用 isSideInCheck 过滤（见 AIEngine），正常不会
 * 产出送将着法；这里仍做一道出口断言，因为送将的后果不是"下得差一点"，而是
 * **盘面进入非法状态且无法靠对方补救**（皮卡鱼不吃将，对局会永久僵在非法局面）。
 * 判据与落子闸门（screens/game、screens/lanBattle）共用同一个 isMoveKingSafe，
 * 三处口径一致。
 */
function rejectMoverUnsafe(state: GameState, move: AIMoveResult | null): AIMoveResult | null {
  if (!move) return null;
  /**
   * 【2026-10 审计 D2：补上「落点合法性」闸】
   *
   * 此前这里**只查送将**，不查落点是否真legal。对象棋来说本地皮卡鱼与本仓库
   * 同源引擎，`rejectMoverUnsafe` 够用；但揭棋引擎是**另一套实现**
   * （Pikafish `jieqi_old`，其「暗子按棋位走」与「已翻开士/象是否仍受九宫河界限制」
   * 均未经源码逐行核实）。两边一旦对某个落点有分歧，引擎给的着法会直达
   * `screens/game/index.tsx` 的 makeMove（它不校验），**盘面直接进入非法状态**，
   * 且无法靠对方补救（引擎不吃将，对局永久僵死）。
   *
   * ⇒ 这里补 `getValidMoves` 落点检查：揭棋路径与象棋路径同款，只是揭棋更容易失配，
   * 所以这道闸在揭棋上尤其关键。失败即回落（下面的兜底会挑一步合法棋）。
   */
  if (!isMoveKingSafe(state, move.pieceId, move.toCol, move.toRow)) return null;
  try {
    const pts = getValidMoves(state, move.pieceId);
    if (!pts[move.toCol]?.[move.toRow]) return null;
  } catch {
    return null;
  }
  return move;
}

/**
 * 兜底着法的评分：它不是搜索产物，没有真实评估分。
 * 用 `0` 作哨兵——**任何真实搜索分的量级都远大于 0**
 * （MATE_SCORE = 1 000 000，静默分约 -1e5 量级），
 * 故 0 不会被误当成"这是个好棋"。调用方也不读 score（它只用于排序/展示）。
 */
const FALLBACK_MOVE_SCORE = 0;

/**
 * 【2026-10 实测 BUG 的最后一道兜底】出口守卫拒收**之后**的最后一条路。
 *
 * 守卫把着法拒了却直接返回 null，界面拿到 null 就只能报「AI 暂时无法出招，请重开本局」，
 * 而此时该方往往**明明还有合法着法**（实测 seed 9434 红方有 15 步，见
 * jieqiAiLegalityParity.test.ts）。玩家被逼重开一整局，性质上就是「AI 算不出来」，
 * 其实只是引擎内部合法性口径与守卫口径分叉后的一次抖动。
 *
 * 这里不再挑「最优」，只保证**一定有一步可走的合法棋**：
 * 枚举该方全部合法着法，取 pieceId / 落点最小的那一步（保证确定性，便于复现与录像）。
 * 走一步平庸的棋，远好过把整局锁死。
 *
 * ⚠️ 判据与守卫用**同一个** isMoveKingSafe ⇒ 返回的着法必然过闸，不会二次被拒。
 * 枚举结果为空（真无棋可走 = 已被绝杀/困毙）时返回 null，由调用方按终局处理。
 */
function pickAnyLegalMove(state: GameState): AIMoveResult | null {
  let best: (AIMoveResult & { score: number }) | null = null;
  try {
    for (const m of enumerateLegalMoves(state, state.sideTag)) {
      const cand = { ...m, score: FALLBACK_MOVE_SCORE };
      if (!best) { best = cand; continue; }
      // 确定性排序：先比 pieceId，再比落点，避免每次兜底走法漂移
      if (
        cand.pieceId < best.pieceId ||
        (cand.pieceId === best.pieceId &&
          (cand.toRow < best.toRow || (cand.toRow === best.toRow && cand.toCol < best.toCol)))
      ) {
        best = cand;
      }
    }
  } catch {
    return null;
  }
  return best && isMoveKingSafe(state, best.pieceId, best.toCol, best.toRow) ? best : null;
}

/**
 * 离线执行：优先本地皮卡鱼，失败再退到旧 TS AI。
 *
 * 为什么要**两层**：本地皮卡鱼需要加载 6MB 引擎 + 实例化 WASM（冷启动有耗时），
 * 且在极少数环境（资产缺失、CSP 拦 Worker、WebView 起不来）根本不可用。
 * 若直接依赖它，一次失败就会让对局卡在「AI 回合」——玩家点不动棋子、也没有下一步。
 * 旧 TS AI 永远可用（纯 JS，无外部资产），因此它必须留在最后一层。
 *
 * 取消（AbortError / OfflineSearchAbortedError）**不**降级：
 * 那意味着"用户悔棋/重开/离场了"，此时应静默丢弃，而不是让兜底 AI 白算一步。
 */
async function runOffline(
  state: GameState,
  tier: AIDifficulty | 'hint',
  purpose: 'move' | 'hint'
): Promise<{ move: AIMoveResult; engine: string; depth: number; timeMs: number } | null> {
  const startedAt = Date.now();

  /**
   * 揭棋：皮卡鱼**只懂象棋**，喂给它揭棋 FEN 只会得到垃圾着法或直接报错，
   * 所以揭棋必须在入口就短路到本地 TS 引擎（它已支持揭棋，见 AIEngine 揭棋分支）。
   *
   * ⚠️ 这道闸必须在 `requestOfflineMove` **之前**：引擎不认揭棋，
   * 让它先跑一遍只会浪费一整个时间预算（hard 档 2.5s）再回落，
   * 表现为「揭棋 AI 每步都慢半拍」。
   *
   * 不走 runOffline 的 catch 兜底：那是给「引擎不可用」用的降级路径，
   * 揭棋是**永久性**的能力缺失，走降级路径会让 engine 标签显示成
   * 「皮卡鱼启动中」，虚报棋力来源（与 resolveOfflineEngineLabel 的注释同源问题）。
   */
  /**
   * 揭棋：优先用**揭棋引擎**（jieqi.wasm），失败或产物缺失则回落本地 TS AI。
   *
   * ⚠️ 与象棋路径的关键差别：
   *   · 引擎**不是常驻实例**——我们的 WASM 是同步阻塞的 UCI 循环，
   *     一次搜索 = 一个实例生命周期（见 pikafish/jieqiHost.ts 顶部说明）；
   *   · 引擎需要**暗子池**（精确多重集）与**带揭晓后缀的历史**，
   *     二者由 `jieqiRuntime` 上下文提供（开局时由页面注册）。
   *
   * 产品定稿：**保留 TS AI 作为兜底**。引擎不可用/出错/超时时静默回落，
   * 对局不中断；标签如实反映这一步是谁算的（不虚报棋力来源）。
   */
  if (state.variant === 'jieqi') {
    const jieqiTier = tier === 'hint' ? 'hard' : tier;

    const ctx = getJieqiRuntime();
    if (ctx && isJieqiHostAvailable()) {
      try {
        const outcome = await runJieqiEngine(state, ctx, tier, purpose);
        if (outcome) {
          const safe = rejectMoverUnsafe(state, outcome.move);
          if (safe) {
            return {
              move: safe,
              engine: 'jieqi-engine',
              depth: outcome.depth,
              timeMs: outcome.timeMs || Date.now() - startedAt,
            };
          }
          // 引擎着法送将（不应发生，出口守卫拦截）→ 回落 TS AI
          console.warn('[aiDispatcher] 揭棋引擎着法未通过出口守卫，回落 TS AI');
        }
      } catch (err) {
        if (isAbortLike(err)) return null;
        console.warn('[aiDispatcher] 揭棋引擎未给出可用着法，回落 TS AI:', describeError(err));
      }
    }

    // 兜底：本地 TS AI（揭棋分支已实现，见 AIEngine）
    const move = tier === 'hint'
      ? await getHintMoveAsync(state)
      : await getBestMoveAsync(state, jieqiTier);
    const safe = rejectMoverUnsafe(state, move);
    if (!safe) {
      // 守卫拒收了 TS AI 的着法（历史上唯一成因：AIEngine 揭棋分支漏判飞将，
      // 已于 2026-10 修复；此处是防止同类口径漂移再次把整局锁死）。
      // 先退「随便一步合法棋」，再退 null（真无棋可走 = 已被绝杀/困毙）。
      const any = pickAnyLegalMove(state);
      if (!any) return null;
      console.warn('[aiDispatcher] 揭棋兜底 AI 着法被出口守卫拒收，已改用合法兜底着法');
      return { move: any, engine: 'legacy', depth: 0, timeMs: Date.now() - startedAt };
    }
    // 标签区分「引擎产物缺失/永久不可用」与「引擎本次失败（下次可能好）」
    const engine = ctx && isJieqiHostAvailable() ? 'jieqi-engine-starting' : 'legacy';
    return { move: safe, engine, depth: 0, timeMs: Date.now() - startedAt };
  }

  try {
    const outcome = await requestOfflineMove(state, tier, purpose);
    // requestOfflineMove 已过三重守卫；这里再确认一次送将（与在线路径同构的出口断言）
    if (!rejectMoverUnsafe(state, outcome)) return null;
    return {
      move: outcome,
      // 引擎标签由「编排器对**这一步**盖的章」决定（outcome.engine），
      // 而不是事后查全局状态（2026-10 审计 P1 竞态修复）：
      // 事后查状态在"引擎恰好在兜底搜索期间启动完成"时，会把 TS 兜底算出的着法
      // 标成"皮卡鱼（绿灯）"。getStatus() 现在只用来区分兜底的两种**性质**——
      // 引擎还在启动/重试（会自动升级）vs 已判永久不可用（本局一直兜底）。
      engine: resolveOfflineEngineLabel(outcome.engine),
      depth: outcome.depth,
      timeMs: outcome.timeMs || Date.now() - startedAt,
    };
  } catch (err) {
    if (err instanceof OfflineSearchAbortedError || isAbortLike(err)) {
      // 取消：调用方应丢弃，不产生任何着法
      return null;
    }
    console.warn('[aiDispatcher] 本地皮卡鱼未给出可用着法，回退兜底 TS AI:', describeError(err));
  }

  // 兜底：旧 TS AI（提示走 hard 预算；产品难度各档有自身预算）
  const fallbackTier = tier === 'hint' ? 'hard' : tier;
  const fallback = tier === 'hint' ? await getHintMoveAsync(state) : await getBestMoveAsync(state, fallbackTier);
  const safe = rejectMoverUnsafe(state, fallback);
  if (!safe) {
    // 同揭棋分支：守卫拒收不等于「无棋可走」。宁可走一步平庸的合法棋，
    // 也不能让 screens/game 弹出「AI 暂时无法出招，请重开本局」把整局锁死。
    const any = pickAnyLegalMove(state);
    if (!any) return null;
    console.warn('[aiDispatcher] 兜底 AI 着法被出口守卫拒收，已改用合法兜底着法');
    return { move: any, engine: 'legacy', depth: 0, timeMs: Date.now() - startedAt };
  }
  return { move: safe, engine: 'legacy', depth: 0, timeMs: Date.now() - startedAt };
}

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * 把「这一步由谁算出」＋「引擎当前状态」翻译成 UI 标签。
 *
 * 输入 `servedBy` 是编排器为**本次搜索**盖的章（'pikafish' | 'legacy'），
 * 是"谁算的"的唯一权威来源；`getStatus()` 只用来在**兜底**情形下区分性质。
 *
 * · 'pikafish-local'    —— 这一步确实由本地皮卡鱼算出（绿灯）
 * · 'pikafish-starting' —— 这一步是兜底，且引擎仍在启动/冷却重试（会自动升级）
 * · 'legacy'            —— 这一步是兜底，且引擎已判永久不可用（本局一直兜底）
 *
 * 为什么不能只查 getStatus()（2026-10 审计 P1 竞态）：
 * 兜底 TS 搜索可能持续 0.5~2.5s，期间引擎可能刚好启动完成，于是搜索**结束后**
 * 查到的状态是 'pikafish'，而这一步实际是 TS 算的 —— 界面就会给兜底着法点绿灯、
 * 显示"皮卡鱼（难度）"，虚报棋力来源一个量级。按盖章判定则不受时序影响。
 */
function resolveOfflineEngineLabel(
  servedBy?: 'pikafish' | 'legacy'
): 'pikafish-local' | 'pikafish-starting' | 'legacy' {
  // 这一步由真引擎算出：与当前状态无关，恒为"皮卡鱼已就绪"
  if (servedBy !== 'legacy') return 'pikafish-local';
  // 兜底：用状态区分"会自动升级"与"已永久降级"
  try {
    const s = getOfflineEngine().getStatus().source;
    return s === 'pikafish' || s === 'starting' ? 'pikafish-starting' : 'legacy';
  } catch {
    return 'legacy';
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * 获取 AI 的最佳走法（纯本地，永不联网）。
 *
 * 2026-10 服务端去 AI 化后，原先的 `getHybridBestMove`（混合：本地优先 + 在线兜底）
 * 与 `getHybridBestMoveLocal`（残局专用、显式纯本地）**语义已完全相同** ——
 * 两者都只会走本地皮卡鱼 → 旧 TS AI。因此这里合并为一个入口，
 * 避免调用方再按"要不要联网"做无意义的区分。
 *
 * 返回的 `engine` 标明这一步究竟是谁算的：
 * 'pikafish-local' / 'pikafish-starting' / 'legacy'。
 */
export async function getBestMoveOffline(
  state: GameState,
  difficulty: AIDifficulty
): Promise<HybridMoveResult | null> {
  const offline = await runOffline(state, difficulty, 'move');
  if (!offline) return null;
  return {
    ...offline.move,
    engine: offline.engine,
    depth: offline.depth,
    timeMs: offline.timeMs,
  };
}

/**
 * 获取"提示"走法（纯本地，永不联网）。
 *
 * 固定最高强度且完全确定：走**本地皮卡鱼 hint 档**（multiPV=1、depth=8、纯最佳，
 * 同一局面结果恒定），搜索前清置换表。
 *
 * 先取后台预计算：玩家思考期间已经在算（或已算完），复用比重新搜索更快，
 * 且完全离线也有效。预计算失败/被拒再落到现场搜索。
 */
export async function getHintMoveOffline(state: GameState): Promise<HybridMoveResult | null> {
  const pondered = takeOfflinePonder(state);
  if (pondered) {
    const p = await pondered;
    if (p && rejectMoverUnsafe(state, p)) {
      // 标签用预计算结果自带的 engine（编排器在算那一步时盖的章），
      // 而不是此刻重查状态：预计算可能在引擎降级/升级**之后**才完成，
      // 重查状态会把"谁算的"搞错（2026-10 审计 P1）。
      return { ...p, engine: resolveOfflineEngineLabel(p.engine) };
    }
    // 预计算失败/被拒 → 落到下面的现场搜索
  }
  const offline = await runOffline(state, 'hint', 'hint');
  if (!offline) return null;
  return { ...offline.move, engine: offline.engine, depth: offline.depth, timeMs: offline.timeMs };
}
