/**
 * 中国象棋 AI 引擎（强化版）
 *
 * 参考 ElephantEye 等开源象棋引擎的评估思路：
 * 1. 标准子力价值体系（车600 马270 炮300 士/象120 兵60/120）
 * 2. 精细位置加成表（基于象棋理论，与棋子价值成比例）
 * 3. 王安全评估（士象完整性、将帅暴露度）
 * 4. 静态搜索（Quiescence Search）— 消除水平线效应
 * 5. 杀手走法启发（Killer Move Heuristic）— 提高剪枝效率
 * 6. 历史重复局面惩罚 — 抑制循环走法（见 evaluate 内的 historyHashCount 用法）
 * 7. 迭代加深 + 时间预算 — 保证固定时间内返回最佳结果
 *
 * ⚠️ 本引擎**没有置换表（Transposition Table）**，也**没有机动性评估**：
 * 二者曾写在文件头的能力清单里，但代码从未实现（接手时不要按注释找）。
 * 现有的 historyHashCount 只是"局面出现次数计数器"，用于重复局面惩罚，
 * 不存储搜索结果、不做剪枝，与置换表无关。
 */

import { type GameState, type PieceState } from './GameEngine';
import { fillPathPoints, createPathPointsBuffer, getPathPoints } from './MoveCheck';
import { RED_SIDE, BLACK_SIDE, BOARD_COLS, BOARD_ROWS, type SideTag, type MoveRecord } from './types';
import { isMoveBanned } from './RuleEngine';

// ======================== 棋子价值 ========================

/**
 * 标准中国象棋子力价值（参考 ElephantEye）
 * 将=100000 车=600 炮=300 马=270 士=120 象=120 兵=60/120
 */
const PIECE_VALUES: number[] = [
  // 黑方 (0-15): 将 士 士 象 象 马 马 车 车 炮 炮 卒 卒 卒 卒 卒
  100000, 120, 120, 120, 120, 270, 270, 600, 600, 300, 300, 60, 60, 60, 60, 60,
  // 红方 (16-31): 帅 仕 仕 相 相 马 马 车 车 炮 炮 兵 兵 兵 兵 兵
  100000, 120, 120, 120, 120, 270, 270, 600, 600, 300, 300, 60, 60, 60, 60, 60,
];

// ======================== 精细位置加成表 ========================

/**
 * 兵/卒位置加成（黑方卒视角，红方兵镜像使用）
 * 兵卒过河后价值大幅提升，逼近底线时价值下降（无路可走）
 */
const PAWN_POSITION_BONUS: number[][] = [
  // row 0-2: 未过河，基本无加成
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  // row 3: 即将过河，小幅加成
  [6, 12, 18, 24, 30, 24, 18, 12, 6],
  // row 4: 刚过河，价值提升
  [12, 24, 36, 48, 60, 48, 36, 24, 12],
  // row 5: 深入敌阵
  [18, 30, 42, 60, 72, 60, 42, 30, 18],
  // row 6: 接近九宫
  [24, 36, 54, 72, 84, 72, 54, 36, 24],
  // row 7: 威胁九宫
  [30, 42, 60, 78, 90, 78, 60, 42, 30],
  // row 8: 逼近底线，仍具威胁
  [18, 30, 42, 60, 72, 60, 42, 30, 18],
  // row 9: 底线，价值下降
  [6, 12, 18, 24, 30, 24, 18, 12, 6],
];

/**
 * 马位置加成
 * 马在中心位置价值最大，边角位置受限严重
 */
const HORSE_POSITION_BONUS: number[][] = [
  [0, -12, 6, 6, 6, 6, 6, -12, 0],
  [0, 6, 18, 24, 24, 24, 18, 6, 0],
  [6, 18, 30, 36, 36, 36, 30, 18, 6],
  [6, 24, 36, 42, 48, 42, 36, 24, 6],
  [12, 24, 42, 48, 54, 48, 42, 24, 12],
  [12, 24, 42, 48, 54, 48, 42, 24, 12],
  [6, 24, 36, 42, 48, 42, 36, 24, 6],
  [6, 18, 30, 36, 36, 36, 30, 18, 6],
  [0, 6, 18, 24, 24, 24, 18, 6, 0],
  [0, -12, 6, 6, 6, 6, 6, -12, 0],
];

/**
 * 车位置加成
 * 车在开放线和肋道价值最大，沉底和骑河也有加成
 */
const ROOK_POSITION_BONUS: number[][] = [
  [12, 18, 12, 24, 30, 24, 12, 18, 12],
  [12, 24, 18, 30, 36, 30, 18, 24, 12],
  [6, 18, 18, 24, 30, 24, 18, 18, 6],
  [6, 12, 12, 18, 24, 18, 12, 12, 6],
  [0, 12, 12, 18, 24, 18, 12, 12, 0],
  [0, 12, 12, 18, 24, 18, 12, 12, 0],
  [6, 12, 12, 18, 24, 18, 12, 12, 6],
  [6, 18, 18, 24, 30, 24, 18, 18, 6],
  [12, 24, 18, 30, 36, 30, 18, 24, 12],
  [12, 18, 12, 24, 30, 24, 12, 18, 12],
];

/**
 * 炮位置加成
 * 炮在中路和底线价值最大，需要炮架才能发挥
 */
const CANNON_POSITION_BONUS: number[][] = [
  [6, 12, 6, 18, 24, 18, 6, 12, 6],
  [12, 18, 18, 24, 30, 24, 18, 18, 12],
  [6, 12, 12, 18, 24, 18, 12, 12, 6],
  [6, 12, 12, 18, 24, 18, 12, 12, 6],
  [6, 12, 12, 18, 24, 18, 12, 12, 6],
  [6, 12, 12, 18, 24, 18, 12, 12, 6],
  [6, 12, 12, 18, 24, 18, 12, 12, 6],
  [12, 18, 18, 24, 30, 24, 18, 18, 12],
  [6, 12, 6, 18, 24, 18, 6, 12, 6],
  [0, 0, 6, 12, 18, 12, 6, 0, 0],
];

// ======================== 搜索控制 ========================
// 【2026-10 主线程响应性重构】搜索控制状态从模块级全局变量收进「单次搜索会话」对象。
//
// 为什么要这么做：搜索是异步分片执行的，一次搜索没结束就可能被下一次搜索启动
// （玩家走子后 AI 搜索 vs 后台提示预计算），而原先 searchDeadline / searchAborted /
// pureBestMode 都是模块级单例 —— 新搜索会把旧搜索的 deadline 覆盖掉、把旧搜索刚
// 收到的 abort 复位成 false，于是「已被取消的旧搜索」会继续按新预算跑到自然结束，
// 与真正需要结果的搜索抢主线程算力（表现为：AI 落子后越打越卡、提示搜索永远不止）。
// 现在每次搜索各自持有一份状态，旧搜索被 abort 后再也不会被新搜索"复活"。
//
// 另外，让出点原先只在根节点走法之间（两次让出之间跑完一整个根走法子树），
// 单次阻塞实测可达 130ms（Node；真机 Hermes 更久），触摸/动画全部被推迟。
// 现在 checkSearch 带「分片发送」语义：跑满约 SEND_SLICE_MS 就让出主线程一次，
// 让出点因此落在递归树内部，单次阻塞被压到 ~12ms。
//
// 【2026-10 续跑式分片】让出必须"原地挂起、原地恢复"，不能"回到根节点重试"。
// 早期版本让 checkSearch 抛 SearchYieldSignal、根节点循环捕获后 `i--; continue`
// 重跑同一个根走法，实测不可用：
//   - 比一个分片更大的根走法子树永远跑不完：每片都从头重算，永远到不了叶子，
//     形成活锁（eng-ply10 深度 4、60s 预算：2036ms 后仍在跑；不分片 481ms 就跑完）；
//   - 即使侥幸跑完，重算的节点也是纯冗余：实测 17.6 倍节点，并且可能返回更浅层
//     （退化）的结果 —— 正确性一并被破坏。
// 现在 minimax/quiescence 是**生成器**：checkSearch 判定分片跑满时 `yield` 出
// SearchYieldSignal 挂起，栈帧、局部变量、棋盘全部原样保留；驱动循环 await 一次
// 宏任务让出主线程后调用 gen.next()，**从 yield 的下一句继续**。遍历顺序、剪枝、
// 节点数与不分片时逐节点一致（同一份逻辑，只是把 JS 调用栈换成了可挂起的对象）。

/**
 * 搜索会话：一次 searchWithTimeBudget 调用独占的状态。
 * 不放在模块级，避免并发搜索互相污染（见上方说明）。
 */
interface SearchSession {
  /**
   * 搜索截止时间戳（毫秒）—— **纯搜索时间**的截止点。
   *
   * 注意：这里刻意**不把让出主线程的墙钟耗时算进预算**。
   * 分片让出（await yieldToEventLoop）在 RN 上是真宏任务，一帧的成本按 60fps 帧预算算约 16ms；
   * 若把这段空转计入 deadline，同一预算下真机搜索到的节点数会比桌面少一大截，
   * 表现为"棋力下降"。本会话因此只累计**真正在搜索的片段时间**：
   * 每片开始时重置 sliceStart/yieldBegin，让出后把 (yieldBegin → 恢复时刻) 这段
   * 纯等待累加到 yieldSpent，于是 deadline 的推进速度与「不分片」完全一致 ——
   * 节点序列不变、结果逐位相同，棋力严格不变，让出成本不再侵蚀预算。
   */
  deadline: number;
  /** 是否已被中止（超时 / 外部 abortSearch / 被更新的搜索取代） */
  aborted: boolean;
  /** 已搜索节点数（用于周期性检查时间，避免每次节点都调 Date.now） */
  nodeCount: number;
  /**
   * 纯最佳模式（提示功能专用）：
   * 开启后搜索完全确定性 —— 跳过根节点多样化随机、重复局面惩罚、长将/长捉惩罚，
   * 只返回客观评分最高的走法。与 AI 对弈思考（需要变化与反循环策略）严格区分。
   */
  pureBest: boolean;
  /** 本分片开始时间戳 */
  sliceStart: number;
  /** 本分片挂起、开始让出等待的时间戳（用于把让出开销从预算里剔除） */
  yieldBegin: number;
  /**
   * 已让出主线程期间流逝的墙钟毫秒数（让出开销的累计值）。
   * 与 searchSpent 相加即得总墙钟，因此可以把两者分离：
   * 分片长度判断用 sliceStart（墙钟，保证单次阻塞 ≈ SEND_SLICE_MS），
   * 预算判断用 searchSpent（纯搜索，不含让出，保证棋力不降）。
   */
  yieldSpent: number;
  /** 已让出主线程次数（诊断用：确认分片粒度按预期生效） */
  yields: number;
}

/** 当前正在执行的搜索会话（仅用于外部 abortSearch 定位目标） */
let activeSearch: SearchSession | null = null;

/**
 * 分片让出信号：checkSearch 判定本分片已跑满时，搜索生成器 `yield` 出本值挂起，
 * 驱动循环（searchWithTimeBudget）捕获后 await 一次宏任务让出主线程，
 * 再调用 gen.next() 从挂起点**原地继续**——不重放、不重试、不重复计节点。
 *
 * 为什么用生成器而不是「抛异常 + 回到根节点重试」：minimax 的返回值是局面分数
 * （number），用特殊 number 当哨兵会和评分空间冲突；异常虽然能让每层的
 * `unapplyMove(state, undo)` 走 finally 补齐，但异常语义是"这一层递归被放弃"，
 * 只能回到根节点重跑整棵子树 —— 于是比分片更大的根子树永远跑不完（活锁），
 * 跑完的那些也在重复计算（实测 17.6 倍节点）。
 * 生成器把「函数调用栈」变成可挂起的对象：yield 时栈帧与棋盘保持原样，
 * next() 时从 yield 的下一句继续，因此切片只改变"什么时候回事件循环"，
 * 不改变遍历与结果。
 */
const SearchYieldSignal = Symbol('search-yield');

/** 可挂起搜索生成器：yield 表示"本分片跑满，请让出主线程后再恢复我"，返回值是该节点的分数 */
type SearchGen = Generator<typeof SearchYieldSignal, number, void>;

/** checkSearch 的裁决结果 */
type SearchCheck = 'ok' | 'abort' | 'send';

/** 每跑满约这么多毫秒就让出一次主线程（一个 60fps 帧的预算） */
const SEND_SLICE_MS = 12;
/**
 * 周期性子检查间隔（节点数）：检查"本分片是否跑满"与"是否已超预算"。
 * 64 节点 ≈ 十几微秒的粒度，能把单次连续阻塞牢牢压在 12ms 附近
 * （原先 512 节点会让分片尾部多溢出几毫秒，真机上叠加首帧/GC 更容易顶到 16.7ms 掉帧线）。
 * 注：**中止（abort）本身不在这里轮询**——checkSearch 每次调用第一行就查 session.aborted，
 * 即逐节点生效；本间隔只影响分片边界与截止时间的检查粒度。
 */
const TIME_POLL_NODES = 64;
/** 时间检查的节点掩码 */
const TIME_POLL_MASK = TIME_POLL_NODES - 1;

/**
 * 让出主线程、把控制权交回事件循环（触摸/动画/音频消息得以处理）。
 *
 * 【为什么在 React Native 上必须用 setTimeout 而不是 setImmediate】
 * 让出只有在"回到**宏任务队列**"时才有意义：触摸事件、定时器、动画回调都排在宏任务
 * 队列里，只有让出到那里，它们才有机会插进来。
 *
 * 但 RN 0.81 的 setImmediate 不是宏任务。bridgeless（newArchEnabled，见
 * client/app.config.ts）下 RN 把 setImmediate polyfill 成 queueMicrotask：
 *   Libraries/Core/setUpTimers.js:22  polyfillGlobal('setImmediate', () => require('./Timers/immediateShim').setImmediate)
 *   Libraries/Core/Timers/immediateShim.js:44-51  global.queueMicrotask(() => callback.apply(undefined, args))
 * 微任务在**当前任务结束前**就会被全部排干（宿主 RuntimeScheduler::performMicrotaskCheckpoint
 * 里 `while (retries < kRetriesBound) { if (runtime.drainMicrotasks()) break; }`），
 * 永远轮不到宏任务队列。于是搜索的每一次"让出"只是同一个微任务队列里的下一个微任务：
 * 微任务队列永远不空 → 触摸事件在整个搜索期间根本排不进来。
 * 这正是实机上"AI 走子后点棋子要等 1-3 秒才响应"的机制（250ms 启动延迟 + 2500ms 预算）。
 *
 * 而 setTimeout(0) 在 RN 上是真定时器：TimerManager.cpp:126 `platformTimerRegistry_->createTimer(timerID, delay)`
 * 落到平台事件循环，回调作为独立任务回到 JS 任务队列 —— 触摸可以在两次让出之间插进来。
 *
 * Node 上反过来：setImmediate 本身就是真宏任务（比 setTimeout 快两个数量级），
 * 所以按运行时分流，两边都取各自最快的那一种。
 *
 * 【为什么在设备上退化到"让满一帧"而不是 setTimeout(0)】
 * Android 对 0ms 定时器有节流钳制，最小间隔约 4ms；一帧预算是 16.7ms。
 * 两者都只是"排进宏任务队列"，但真正决定手感的不是钳制后的间隔，而是
 * 触摸事件要等多久才被消费。让出到 rAF（渲染帧）意味着**每一分片都保证对齐一次真实帧**，
 * 触摸最迟在下一帧被处理，既不丢帧也不饿手；setTimeout(0) 的 ~4ms 轮询则会在两次
 * 帧之间反复空转，把本来留给渲染的时间吃掉（实测 Node 上同样策略空转占墙钟 23.3%）。
 * 因此：设备端走 requestAnimationFrame（宏任务，且对齐帧），Node 端走 setImmediate。
 */
const isNodeRuntime =
  typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === 'string';

/**
 * 设备端优先用 requestAnimationFrame 让出：它是真正的宏任务（渲染帧回调），
 * 比 setTimeout(0) 更"对齐"——每个分片都落在真实帧边界上，触摸最迟下一帧被消费，
 * 也不会像 0ms 定时器那样在两次帧之间反复空转。没有 rAF 时（极老环境/测试）退回定时器。
 * Node 端没有 rAF，走 setImmediate（真宏任务且最快）。
 */
const requestFrame =
  typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame === 'function'
    ? (globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame
    : null;

/**
 * rAF 让出的兜底计时器：万一帧回调被暂停/节流（窗口不可见、系统回收帧），
 * 让出不能永远挂着——那会让搜索挂死、AI 永远不出招。这里让"定时器"和"帧"
 * 谁先到算谁，帧正常时定时器会在同一轮宏任务里被清掉，不产生额外开销。
 */
const YIELD_FALLBACK_MS = 32;

let yieldToEventLoop = (): Promise<void> => {
  if (isNodeRuntime && typeof (globalThis as { setImmediate?: unknown }).setImmediate === 'function') {
    yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));
  } else if (requestFrame) {
    yieldToEventLoop = () =>
      new Promise<void>(resolve => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, YIELD_FALLBACK_MS);
        requestFrame(done);
      });
  } else {
    yieldToEventLoop = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return yieldToEventLoop();
};

/**
 * 【本副本额外导出】最近一次搜索的诊断计数。
 * 用于验证「分片不产生冗余节点」「每个分片的实际阻塞时长」这两个验收指标：
 * 与不分片版本（同源、只把 SEND_SLICE_MS 调成无穷大）对比时，节点数应当一致。
 * 生产代码不读它，也不影响任何搜索行为。
 */
export const __searchStats = { nodeCount: 0, yields: 0 };

/** 新建搜索会话 */
function createSession(timeBudget: number, pureBest: boolean): SearchSession {
  __searchStats.nodeCount = 0;
  __searchStats.yields = 0;
  const now = Date.now();
  return {
    deadline: now + timeBudget,
    aborted: false,
    nodeCount: 0,
    pureBest,
    sliceStart: now,
    yields: 0,
    yieldBegin: now,
    yieldSpent: 0,
  };
}

/**
 * 会话已消耗的"纯搜索时间"：墙钟减去让出主线程的等待时间。
 * 调用点都在分片内（此时没有让出在途），所以这个减法恰好等于
 * 「已完成分片时长之和 + 当前分片已跑时长」，与不分片时的耗时口径一致。
 */
function searchSpent(session: SearchSession): number {
  return Date.now() - session.yieldSpent;
}

/**
 * 周期性检查（每 TIME_POLL_NODES 个节点一次，避免每节点 Date.now 开销）：
 *  - 'abort'：已中止 / 超时 → 调用方立即返回中立分，结果被上层丢弃
 *  - 'send' ：本分片跑满 → 调用方 `yield SearchYieldSignal` 挂起本节点，
 *             由驱动循环让出主线程后从挂起点原地恢复
 *  - 'ok'   ：继续搜索
 *
 * 预算判断用 searchSpent（不含让出耗时），分片判断用 sliceStart（墙钟）：
 * 前者保证让出开销不侵蚀棋力预算，后者保证单次阻塞仍然 ≈ SEND_SLICE_MS。
 */
function checkSearch(session: SearchSession): SearchCheck {
  if (session.aborted) return 'abort';
  if ((++session.nodeCount & TIME_POLL_MASK) !== 0) return 'ok';
  __searchStats.nodeCount = session.nodeCount;

  if (searchSpent(session) > session.deadline) {
    session.aborted = true;
    return 'abort';
  }
  const now = Date.now();
  if (now - session.sliceStart >= SEND_SLICE_MS) {
    return 'send';
  }
  return 'ok';
}

/**
 * 开启一个新的分片（每次真正让出主线程、恢复搜索前调用）。
 * 把「本片结束 → 让出等待结束」这段纯等待的墙钟耗时记入 yieldSpent，从预算里扣除。
 *
 * 时间轴：sliceStart ──(分片搜索)──> yieldBegin ──(让出等待)──> now
 *                    ^计入预算          ^不计入预算（这才是让出的代价）
 */
function enterSearchSlice(session: SearchSession): void {
  const now = Date.now();
  session.yieldSpent += now - session.yieldBegin;
  session.sliceStart = now;
}

// ======================== 局面评估 ========================

/**
 * 判断一枚棋子的坐标是否落在棋盘内（[0,BOARD_COLS) × [0,BOARD_ROWS)）。
 *
 * 引擎内部用 -1 同时表达两种语义：「该子不存在」（缺席子、已走完让子摆位）
 * 与「该子被吃掉了」。任何用 col/row 去索引定长查表（ZOBRIST_TABLE、位置加成表、
 * pathPoints、qiPan）的地方都必须先过这道闸：坐标一旦越界，`table[-1]` 是 undefined，
 * 再取 `[-1]` 会抛
 * `TypeError: Cannot read properties of undefined (reading '-1')`
 * —— 这正是 2026-10 线上红屏（runHintSearch → searchWithTimeBudget）的报错原文。
 *
 * 越界只可能来自「外部数据（存档 / 服务端快照）带进来的非法局面」或引擎自身 bug，
 * 不是正常对局能产生的状态；因此这里一律按「该子不在盘上」处理（不崩溃、不生成走法）。
 */
function isOnBoard(col: number, row: number): boolean {
  return Number.isInteger(col) && Number.isInteger(row) &&
    col >= 0 && col < BOARD_COLS && row >= 0 && row < BOARD_ROWS;
}

/**
 * 获取棋子的位置加成
 *
 * 坐标越界一律返回 0（视作「无位置加成」），而不是让 -1 下标穿透到查表里抛
 * `Cannot read properties of undefined (reading '-1')`。
 */
function getPositionBonus(pieceId: number, col: number, row: number): number {
  if (!isOnBoard(col, row)) return 0;
  // 兵/卒 (黑方11-15, 红方27-31)
  if (pieceId >= 11 && pieceId <= 15) {
    // 黑方卒
    if (row >= 3) {
      // 过河后额外加成
      const crossedRiver = row >= 5;
      return PAWN_POSITION_BONUS[row][col] + (crossedRiver ? 60 : 0);
    }
    return PAWN_POSITION_BONUS[row][col];
  }
  if (pieceId >= 27 && pieceId <= 31) {
    // 红方兵（镜像）
    const mirrorRow = 9 - row;
    if (mirrorRow >= 3) {
      const crossedRiver = mirrorRow >= 5;
      return PAWN_POSITION_BONUS[mirrorRow][8 - col] + (crossedRiver ? 60 : 0);
    }
    return PAWN_POSITION_BONUS[mirrorRow][8 - col];
  }
  // 马 (黑方5-6, 红方21-22)
  if (pieceId === 5 || pieceId === 6 || pieceId === 21 || pieceId === 22) {
    return HORSE_POSITION_BONUS[row][col];
  }
  // 车 (黑方7-8, 红方23-24)
  if (pieceId === 7 || pieceId === 8 || pieceId === 23 || pieceId === 24) {
    return ROOK_POSITION_BONUS[row][col];
  }
  // 炮 (黑方9-10, 红方25-26)
  if (pieceId === 9 || pieceId === 10 || pieceId === 25 || pieceId === 26) {
    return CANNON_POSITION_BONUS[row][col];
  }
  return 0;
}

/**
 * 评估王安全
 * 士象完整度 + 将帅位置安全度
 */
function evaluateKingSafety(state: GameState): number {
  let score = 0;

  // 红方士象完整度
  const redShi1 = state.pieces[17].alive;
  const redShi2 = state.pieces[18].alive;
  const redXiang1 = state.pieces[19].alive;
  const redXiang2 = state.pieces[20].alive;
  const redShiCount = (redShi1 ? 1 : 0) + (redShi2 ? 1 : 0);
  const redXiangCount = (redXiang1 ? 1 : 0) + (redXiang2 ? 1 : 0);
  score += redShiCount * 15 + redXiangCount * 10;

  // 黑方士象完整度
  const blackShi1 = state.pieces[1].alive;
  const blackShi2 = state.pieces[2].alive;
  const blackXiang1 = state.pieces[3].alive;
  const blackXiang2 = state.pieces[4].alive;
  const blackShiCount = (blackShi1 ? 1 : 0) + (blackShi2 ? 1 : 0);
  const blackXiangCount = (blackXiang1 ? 1 : 0) + (blackXiang2 ? 1 : 0);
  score -= blackShiCount * 15 + blackXiangCount * 10;

  // 将帅暴露惩罚（将帅不在九宫中心时安全性降低）
  const redGeneral = state.pieces[16];
  if (redGeneral.alive) {
    const distFromCenter = Math.abs(redGeneral.col - 4);
    score -= distFromCenter * 8;
  }
  const blackGeneral = state.pieces[0];
  if (blackGeneral.alive) {
    const distFromCenter = Math.abs(blackGeneral.col - 4);
    score += distFromCenter * 8;
  }

  return score;
}

/**
 * 局面评估函数
 * 从红方视角返回分数（正分红方优势，负分黑方优势）
 */
function evaluate(state: GameState, currentSide: SideTag): number {
  let score = 0;

  // 1. 子力价值 + 位置加成
  for (let i = 0; i < 32; i++) {
    const piece = state.pieces[i];
    if (!piece.alive) continue;

    const baseValue = PIECE_VALUES[i];
    const posBonus = getPositionBonus(i, piece.col, piece.row);
    const totalValue = baseValue + posBonus;

    if (i <= 15) {
      score -= totalValue;
    } else {
      score += totalValue;
    }
  }

  // 2. 王安全评估
  score += evaluateKingSafety(state);

  // 3. 历史重复局面惩罚（Zobrist 哈希检测）
  // 仅当局面已真正重复（历史出现 >= 2 次）才惩罚：这是反循环机制，
  // 只应对后期重复走法；出现过 1 次的正常局面完全不受干扰。
  // 纯最佳模式（提示）同样生效：游戏规则中 4 步循环重复 3 次即判负（连杀），
  // 提示若引导玩家走向重复局面等于引导判负，绝非"客观最优"——惩罚是确定性的规则感知，非随机策略
  const hash = state.zobristHash;
  const historyCount = historyHashCount.get(hash) || 0;
  if (historyCount >= 2) {
    // 重复越严重惩罚越大：第 2 次 -60，第 3 次及以上 -150
    const repetitionPenalty = historyCount >= 3 ? 150 : 60;
    // 从当前走棋方视角扣分（如果是红方回合扣红方分，黑方回合扣黑方分）
    score -= (currentSide === RED_SIDE ? repetitionPenalty : -repetitionPenalty);
  }

  // 5. 残局进展奖励（鼓励推进兵线、压缩对方空间）
  const endgameBonus = evaluateEndgameProgress(state, currentSide);
  score += endgameBonus;

  return score;
}

/**
 * 评估残局进展（鼓励 AI 向前推进，避免消极防守）
 * 返回从当前走棋方视角的奖励分
 */
function evaluateEndgameProgress(state: GameState, currentSide: SideTag): number {
  let redAliveCount = 0;
  let blackAliveCount = 0;
  let redPawnAdvance = 0;
  let blackPawnAdvance = 0;

  for (let i = 0; i < 32; i++) {
    const piece = state.pieces[i];
    if (!piece.alive) continue;

    if (i <= 15) {
      blackAliveCount++;
      // 黑方卒（11-15）过河深度奖励
      if (i >= 11 && i <= 15) {
        blackPawnAdvance += piece.row; // row 越大越深入红方阵地
      }
    } else {
      redAliveCount++;
      // 红方兵（27-31）过河深度奖励
      if (i >= 27 && i <= 31) {
        redPawnAdvance += (9 - piece.row); // 9-row 越大越深入黑方阵地
      }
    }
  }

  // 残局判定：双方棋子总数 <= 10
  const isEndgame = (redAliveCount + blackAliveCount) <= 10;

  if (!isEndgame) return 0;

  // 残局阶段：兵线推进奖励（鼓励进攻）
  const redProgress = redPawnAdvance * 3;
  const blackProgress = blackPawnAdvance * 3;

  // 从红方视角返回
  return redProgress - blackProgress;
}



// ======================== Zobrist 哈希（历史重复检测） ========================

/** 基础哈希种子（FNV 风格混合） */
let hashSeed = 0x9E3779B9;

/**
 * 伪随机数生成器（确定性，避免每次启动不同）
 * 使用 xorshift32 算法，速度快且分布均匀
 */
function nextRandom(): number {
  hashSeed ^= hashSeed << 13;
  hashSeed ^= hashSeed >>> 17;
  hashSeed ^= hashSeed << 5;
  return hashSeed >>> 0; // 返回无符号 32 位整数
}

/**
 * Zobrist 随机表：32 个棋子 × 9 列 × 10 行
 * 每个位置一个 32 位随机数，用于增量哈希
 */
const ZOBRIST_TABLE: number[][][] = Array.from({ length: 32 }, () =>
  Array.from({ length: 9 }, () =>
    Array.from({ length: 10 }, () => nextRandom())
  )
);

/** 走棋方哈希值（红方 XOR 此值区分红黑回合） */
const ZOBRIST_SIDE = nextRandom();

/**
 * 计算局面的 Zobrist 哈希值（全量计算，仅在初始化时调用一次）
 * 之后通过增量更新维护
 */
export function computeZobristHash(state: GameState): number {
  let hash = 0;
  for (let i = 0; i < 32; i++) {
    const piece = state.pieces[i];
    // 坐标越界的「活子」（悬空子）不是合法盘面的一部分，不参与哈希：
    // 直接索引会读到 ZOBRIST_TABLE[i][-1]（undefined）再取 [-1] 而抛 TypeError。
    if (piece.alive && isOnBoard(piece.col, piece.row)) {
      hash ^= ZOBRIST_TABLE[i][piece.col][piece.row];
    }
  }
  if (state.sideTag === RED_SIDE) {
    hash ^= ZOBRIST_SIDE;
  }
  return hash;
}

/** 历史局面哈希计数器（key: Zobrist 哈希，value: 出现次数） */
const historyHashCount = new Map<number, number>();

/**
 * 更新历史哈希表（走棋后调用）
 */
export function recordHistoryHash(state: GameState): void {
  const hash = computeZobristHash(state);
  historyHashCount.set(hash, (historyHashCount.get(hash) || 0) + 1);
}

/**
 * 清空历史哈希表（新对局开始时调用）
 */
export function clearHistoryHash(): void {
  historyHashCount.clear();
}


/**
 * 飞将（白脸将）判定：两将/帅同列且中间无任何棋子时视为互相照面。
 *
 * 与引擎 MoveCheck.afterMoveStillJiangJun 的飞将段完全同口径：isSideInCheck
 * 经 isGeneralAttacked 调用本函数，因此 AI 的合法性过滤会正确地把「走完后造成
 * 将帅照面」的着法判为非法 —— 这正是飞将军能被 AI 主动走出来的前提。
 *
 * 【与 isJiangJun 的分工】isJiangJun（走子前判当前是否被将）只遍历 5..15 /
 * 21..31 这些非将子，不含照面；afterMoveStillJiangJun（走子后判是否仍被将）
 * 则额外含照面。本函数属于后者，不得用于前者。
 *
 * 【唯一真源在引擎，本函数只是镜像】规则真源是 MoveCheck.afterMoveStillJiangJun
 * 的飞将段与 GameEngine.isJiangJun；本文件不得再演化成第二套独立实现
 * （历史上 AI 曾自建 canPieceReach/isSquareAttacked，把将帅当直线攻击者，
 * 假阳性率极高，直接导致 minimax 的合法性过滤丢弃引擎认可的取胜着法，
 * 表现为「AI 不飞将绝杀、反而退将或动自己的帅」）。若本函数与引擎判据
 * 出现分歧，以引擎为准，并跑 node _review/probe_ai_mate.cjs 复现
 * （期望：漏绝杀 0/25、findImmediateWin 与引擎一致 25/25、假阳性 0），
 * 同时跑 node _review/probe_diff_head.cjs 确认未外溢到常规对局。
 */
function areGeneralsFacing(qiPan: number[][]): boolean {
  let blackCol = -1, blackRow = -1, redCol = -1, redRow = -1;
  for (let c = 0; c < 9; c++) {
    const colArr = qiPan[c];
    for (let r = 0; r < 10; r++) {
      if (colArr[r] === 0) { blackCol = c; blackRow = r; }
      else if (colArr[r] === 16) { redCol = c; redRow = r; }
    }
  }
  if (blackCol < 0 || redCol < 0 || blackCol !== redCol) return false;
  const top = Math.min(blackRow, redRow);
  const bottom = Math.max(blackRow, redRow);
  for (let r = top + 1; r < bottom; r++) {
    if (qiPan[blackCol][r] !== -1) return false;
  }
  return true;
}

/**
 * 检查指定一方是否被将军（其将/帅是否被敌方攻击）
 * 注意：applyMove 后 sideTag 已切换，调用方需明确传入要检测的一方
 *
 * 口径统一到引擎：本函数只用于「已走完某步之后，己方是否仍被攻击」的判定，
 * 必须与引擎 MoveCheck（GameEngine.hasAnyLegalMove / isJueSha / isKunBi 的
 * 底层判据 afterMoveStillJiangJun）严格一致：
 *   - 只检查非将子的攻击：红帅被 5..15（黑子）攻击，黑将被 21..31（红子）攻击；
 *   - 同时包含飞将（白脸将）判定：两将/帅同列且中间无子 ⇒ 视为被攻击。
 * 早期版本用自建的 isSquareAttacked + canPieceReach 重写这套逻辑，与引擎口径
 * 存在大量不一致（假阳性方向居多），导致 minimax/quiescence 的合法性过滤把引擎
 * 认定合法的取胜着法全部丢弃 —— 表现为「AI 明明有一步绝杀却去退将/动自己的帅」。
 * 宁可多调一次引擎走法生成，也不维护第二套规则实现（宁可慢，不可错）。
 */
function isSideInCheck(state: GameState, side: SideTag): boolean {
  const generalId = side === RED_SIDE ? 16 : 0;
  const general = state.pieces[generalId];
  // 将/帅缺席（!alive）或坐标越界（悬空）时都按「无合法将位」处理：
  // 缺席口径与 GameEngine.isJiangJun / MoveCheck.afterMoveStillJiangJun 的 R-2 守卫一致；
  // 不加这道闸的话，-1 会被拿去索引 pathPoints[x][y] → undefined[-1] 抛 TypeError。
  if (!general.alive || !isOnBoard(general.col, general.row)) return true;
  return isGeneralAttacked(state.qiPan, general.col, general.row, side);
}

/**
 * 引擎口径的「(col,row) 上的将/帅是否仍被攻击」。
 *
 * 直接复用 MoveCheck 的两段判据：
 *   1) 飞将：两将/帅同列且中间无任何棋子；
 *   2) 被敌方非将子攻击（红帅看 5..15，黑将看 21..31），用引擎的
 *      getPathPoints（走法生成）而不是手写的 canPieceReach。
 */
function isGeneralAttacked(qiPan: number[][], col: number, row: number, side: SideTag): boolean {
  // 1) 飞将（白脸将）：两将/帅同列且中间无子
  if (areGeneralsFacing(qiPan)) return true;

  // 2) 被敌方非将子攻击
  const attackerStart = side === RED_SIDE ? 5 : 21;
  const attackerEnd = side === RED_SIDE ? 15 : 31;
  const positions = getPiecePositions(qiPan);
  for (let id = attackerStart; id <= attackerEnd; id++) {
    if (!positions[id].alive) continue;
    if (getPathPoints(id, qiPan, positions)[col][row]) return true;
  }
  return false;
}

/** 从棋盘重建棋子位置数组（getPathPoints 所需的形状） */
function getPiecePositions(qiPan: number[][]): Array<{ col: number; row: number; alive: boolean }> {
  const positions = Array.from({ length: 32 }, () => ({ col: -1, row: -1, alive: false }));
  for (let c = 0; c < 9; c++) {
    for (let r = 0; r < 10; r++) {
      const id = qiPan[c][r];
      if (id === -1) continue;
      positions[id].col = c;
      positions[id].row = r;
      positions[id].alive = true;
    }
  }
  return positions;
}

// ======================== 走法生成 ========================

interface Move {
  pieceId: number;
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
  score: number; // MVV-LVA 排序分
}

// 搜索热路径的复用缓冲：
// - 搜索每访问一个节点就要为在场每个棋子调一次走点计算（占搜索总耗时约 18%），
//   每次新建 1 个外层数组 + 9 个列数组 + 32 个棋子位置对象会造成大量短命分配，
//   加重 GC 压力并拉长单次主线程阻塞（表现为点击棋子偶发卡顿）。
// - 这两块缓冲只在 generatePseudoMoves 内部使用、读取完即弃，而 generatePseudoMoves
//   不会递归调用自己，因此复用是安全的。
//   注意：返回的 moves 数组仍必须每次新建 —— 调用方（minimax/quiescence）会跨递归
//   持有它，若共享会被子节点覆盖。
const scratchPositions: { col: number; row: number; alive: boolean }[] = Array.from(
  { length: 32 },
  () => ({ col: 0, row: 0, alive: false })
);
const scratchPathPoints = createPathPointsBuffer();

/**
 * 生成当前行动方的所有伪合法走法
 */
function generatePseudoMoves(state: GameState): Move[] {
  const moves: Move[] = [];
  const positions = scratchPositions;
  for (let i = 0; i < 32; i++) {
    const p = state.pieces[i];
    positions[i].col = p.col;
    positions[i].row = p.row;
    positions[i].alive = p.alive;
  }
  const side = state.sideTag;
  const start = side === RED_SIDE ? 16 : 0;
  const end = side === RED_SIDE ? 31 : 15;

  for (let i = start; i <= end; i++) {
    const piece = state.pieces[i];
    if (!piece.alive) continue;
    // 悬空活子（alive=true 但 col/row 为 -1 或越界）不在盘上，不生成走法：
    // fillPathPoints 只查 .alive，会用 -1 去算走点（士/仕尤其会误产出 (0,0)），
    // 那步「走法」随后在 applyMove 的 ZOBRIST_TABLE[id][-1][-1] 上抛 TypeError。
    if (!isOnBoard(piece.col, piece.row)) continue;
    const pathPoints = scratchPathPoints;
    fillPathPoints(i, state.qiPan, positions, pathPoints);

    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        if (!pathPoints[c][r]) continue;

        // MVV-LVA 排序：吃子价值 - 攻击者价值/10
        const target = state.qiPan[c][r];
        let score = 0;
        if (target !== -1) {
          score = PIECE_VALUES[target] * 10 - PIECE_VALUES[i];
        }

        moves.push({
          pieceId: i,
          fromCol: piece.col,
          fromRow: piece.row,
          toCol: c,
          toRow: r,
          score,
        });
      }
    }
  }

  // 按 MVV-LVA 降序排序
  moves.sort((a, b) => b.score - a.score);
  return moves;
}

// ======================== 原地走棋/撤销（带增量哈希） ========================

/**
 * 搜索用的私有状态副本。
 *
 * 搜索核心（applyMove/unapplyMove）是**原地改写**的，这是它比每次浅拷贝快一个量级的
 * 原因，必须保留。但它此前直接改写**调用方传入的对象**——而调用方传入的正是
 * screens/game 的 React state 对象。搜索在根节点走法之间会 `await setTimeout(0)`
 * 周期性让出主线程（getBestMoveAsync 30ms / 提示预计算 8ms），让出期间棋盘停留在
 * 搜索树某一步的局面；此时若 React 重渲染（如 setAiThinking 等状态更新触发），
 * 页面就会短暂显示出搜索树内的错误局面（闪棋）。
 *
 * 因此在进入搜索前复制一份：搜索在副本上原地改写，调用方的对象始终保持原样。
 * 只需复制会被改写的部分（棋盘、棋子、哈希、走棋方）——搜索全程不写 moveHistory /
 * ruleState，但为避免与其它持有者共享引用被间接改写，一并做浅层复制。
 */
export function cloneForSearch(state: GameState): GameState {
  return {
    ...state,
    qiPan: state.qiPan.map(col => [...col]),
    pieces: state.pieces.map(p => ({ ...p })),
    moveHistory: state.moveHistory.map(m => ({ ...m })),
    ruleState: state.ruleState
      ? {
          ...state.ruleState,
          positionKeys: [...state.ruleState.positionKeys],
          banChaseTargets: [...state.ruleState.banChaseTargets],
          banMoves: state.ruleState.banMoves.map(m => ({ ...m })),
          red: { ...state.ruleState.red, jiangPieceIds: [...state.ruleState.red.jiangPieceIds], jiangZhuoPieceIds: [...state.ruleState.red.jiangZhuoPieceIds], zhuoCounts: { ...state.ruleState.red.zhuoCounts } },
          black: { ...state.ruleState.black, jiangPieceIds: [...state.ruleState.black.jiangPieceIds], jiangZhuoPieceIds: [...state.ruleState.black.jiangZhuoPieceIds], zhuoCounts: { ...state.ruleState.black.zhuoCounts } },
        }
      : state.ruleState,
  };
}

interface UndoInfo {
  pieceId: number;
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
  capturedPieceId: number;
  capturedCol: number;
  capturedRow: number;
  prevSideTag: SideTag;
  prevHash: number; // 走棋前的 Zobrist 哈希（用于撤销恢复）
}

function applyMove(state: GameState, pieceId: number, toCol: number, toRow: number): UndoInfo {
  const piece = state.pieces[pieceId];
  const capturedPieceId = state.qiPan[toCol][toRow];
  const prevHash = state.zobristHash; // 保存旧哈希用于撤销

  const undo: UndoInfo = {
    pieceId,
    fromCol: piece.col,
    fromRow: piece.row,
    toCol,
    toRow,
    capturedPieceId,
    capturedCol: capturedPieceId !== -1 ? state.pieces[capturedPieceId].col : -1,
    capturedRow: capturedPieceId !== -1 ? state.pieces[capturedPieceId].row : -1,
    prevSideTag: state.sideTag,
    prevHash,
  };

  // 增量更新 Zobrist 哈希：移除起点棋子 + 添加终点棋子
  state.zobristHash ^= ZOBRIST_TABLE[pieceId][piece.col][piece.row];
  state.zobristHash ^= ZOBRIST_TABLE[pieceId][toCol][toRow];

  // 更新棋盘
  state.qiPan[piece.col][piece.row] = -1;
  state.qiPan[toCol][toRow] = pieceId;

  // 更新棋子位置
  piece.col = toCol;
  piece.row = toRow;

  // 处理被吃棋子（从哈希中移除被吃棋子）
  if (capturedPieceId !== -1) {
    state.zobristHash ^= ZOBRIST_TABLE[capturedPieceId][toCol][toRow];
    state.pieces[capturedPieceId].alive = false;
    state.pieces[capturedPieceId].col = -1;
    state.pieces[capturedPieceId].row = -1;
  }

  // 切换行动方（切换走棋方哈希）
  state.zobristHash ^= ZOBRIST_SIDE;
  state.sideTag = state.sideTag === RED_SIDE ? BLACK_SIDE : RED_SIDE;

  return undo;
}

function unapplyMove(state: GameState, undo: UndoInfo): void {
  const piece = state.pieces[undo.pieceId];

  // 恢复 Zobrist 哈希（直接回滚到走棋前状态）
  state.zobristHash = undo.prevHash;

  // 恢复行动方
  state.sideTag = undo.prevSideTag;

  // 恢复被吃棋子
  if (undo.capturedPieceId !== -1) {
    state.pieces[undo.capturedPieceId].alive = true;
    state.pieces[undo.capturedPieceId].col = undo.capturedCol;
    state.pieces[undo.capturedPieceId].row = undo.capturedRow;
  }

  // 恢复棋盘
  state.qiPan[undo.fromCol][undo.fromRow] = undo.pieceId;
  state.qiPan[undo.toCol][undo.toRow] = undo.capturedPieceId;

  // 恢复棋子位置
  piece.col = undo.fromCol;
  piece.row = undo.fromRow;
}

// ======================== 杀手走法 ========================

/** 每层保存 2 个杀手走法 */
const killerMoves: (Move | null)[][] = Array.from({ length: 20 }, () => [null, null]);

/** 记录杀手走法 */
function recordKiller(depth: number, move: Move): void {
  const killers = killerMoves[depth];
  if (killers[0] && killers[0].pieceId === move.pieceId &&
      killers[0].toCol === move.toCol && killers[0].toRow === move.toRow) {
    return; // 已存在
  }
  killers[1] = killers[0];
  killers[0] = move;
}

/** 检查是否是杀手走法 */
function isKillerMove(depth: number, move: Move): boolean {
  const killers = killerMoves[depth];
  for (const k of killers) {
    if (k && k.pieceId === move.pieceId && k.toCol === move.toCol && k.toRow === move.toRow) {
      return true;
    }
  }
  return false;
}

// ======================== Minimax 搜索 ========================

/**
 * 绝杀分数（远大于任何子力分）
 *
 * 语义：己方视角下，+MATE_SCORE 表示「必胜（绝杀/困毙/吃将）」，
 * -MATE_SCORE 表示「必败（己方被绝杀/困毙）」，二者均不可被任何评估分超过，
 * 因此绝杀着法永远排在最前、不会被剪枝误丢。
 */
const MATE_SCORE = 1000000;

/** 一步绝杀的实际返回值（在 MATE_SCORE 内预留 ply 偏移量，使更快的绝杀更优） */
const MATE_IN_1 = MATE_SCORE - 1;

/**
 * 指定一方是否已无任何合法走法（绝杀前提：被将军；困毙前提：未被将军）
 * 与 minimax/quiescence 内的合法性过滤完全同口径。
 */
function hasNoLegalMove(state: GameState): boolean {
  const moves = generatePseudoMoves(state);
  for (const move of moves) {
    const undo = applyMove(state, move.pieceId, move.toCol, move.toRow);
    const moverSide = state.sideTag === RED_SIDE ? BLACK_SIDE : RED_SIDE;
    const illegal = isSideInCheck(state, moverSide);
    unapplyMove(state, undo);
    if (!illegal) return false;
  }
  return true;
}

/**
 * 根节点「一步终局」扫描：在进入迭代加深之前，先把能立刻结束对局的着法找出来。
 *
 * 为什么必须单独扫一遍，而不能指望 minimax 自己发现：
 * minimax 的绝杀分只有在该分支被实际展开到叶子时才产生，而 alpha-beta 剪枝
 * 会因为兄弟分支先返回高分而提前 cut 掉这条分支 —— 残局中「唯一取胜着法」
 * 恰恰是最容易被剪掉的那条（它前面的着法往往是 MVV-LVA 分数更高的假着法）。
 * 于是表现为「AI 明明有一步绝杀却去退将/动自己的帅」。
 *
 * 这里在根节点穷举全部着法（数量在百量级，开销可忽略），用与引擎一致的
 * 终局口径判定：吃将即胜、对方绝杀（被将军且无合法着法）即胜、
 * 对方困毙（未被将军且无合法着法）亦判负（中国象棋困毙与将死同判负）。
 * 命中即立刻返回，绝杀着法因此永远排在第一位且不可能被剪掉。
 */
function findImmediateWin(state: GameState, moves: Move[]): Move | null {
  // 优先吃将：直接结束对局，且不吃自己的将
  for (const move of moves) {
    const target = state.qiPan[move.toCol][move.toRow];
    if (target !== 0 && target !== 16) continue;
    const undo = applyMove(state, move.pieceId, move.toCol, move.toRow);
    unapplyMove(state, undo);
    return move;
  }
  // 其次找绝杀 / 困毙
  for (const move of moves) {
    const undo = applyMove(state, move.pieceId, move.toCol, move.toRow);
    // 走这步之后 state.sideTag 已切到对方：对方无合法着法即为绝杀/困毙
    if (hasNoLegalMove(state)) {
      unapplyMove(state, undo);
      return move;
    }
    unapplyMove(state, undo);
  }
  return null;
}

/**
 * 静态搜索（Quiescence Search）
 * - 未被将军：stand-pat + 只搜索吃子走法
 * - 被将军：必须搜索所有应将走法（否则绝杀不可见），无应将 = 绝杀
 *
 * 生成器版本：分片跑满时 `yield SearchYieldSignal` 原地挂起（栈帧/棋盘原样保留），
 * 由驱动循环让出主线程后 next() 恢复。逻辑与不分片时逐句相同。
 */
function* quiescence(
  state: GameState,
  alpha: number,
  beta: number,
  isMaximizing: boolean,
  qDepth: number,
  ply: number,
  session: SearchSession
): SearchGen {
  {
    const check = checkSearch(session);
    if (check === 'send') yield SearchYieldSignal;
    if (check === 'abort') return 0;
  }

  const inCheck = isSideInCheck(state, state.sideTag);

  if (!inCheck) {
    // stand-pat：不被将军时才允许"站着不动"
    const standPat = evaluate(state, state.sideTag);
    if (isMaximizing) {
      if (standPat >= beta) return beta;
      if (standPat > alpha) alpha = standPat;
    } else {
      if (standPat <= alpha) return alpha;
      if (standPat < beta) beta = standPat;
    }
    if (qDepth <= 0) return isMaximizing ? alpha : beta;
  } else if (qDepth <= -6) {
    // 兜底：将军链过深（防止长将循环），直接返回静态评估
    return evaluate(state, state.sideTag);
  }

  const moves = generatePseudoMoves(state);
  let legalCount = 0;

  for (const move of moves) {
    {
      const check = checkSearch(session);
      if (check === 'send') yield SearchYieldSignal;
      if (check === 'abort') break;
    }
    // 未被将军时只搜索吃子走法；被将军时搜索全部走法（应将）
    if (!inCheck && state.qiPan[move.toCol][move.toRow] === -1) continue;

    const undo = applyMove(state, move.pieceId, move.toCol, move.toRow);

    // 合法性：走棋后自己的将不能被攻击
    const moverSide = state.sideTag === RED_SIDE ? BLACK_SIDE : RED_SIDE;
    if (isSideInCheck(state, moverSide)) {
      unapplyMove(state, undo);
      continue;
    }
    legalCount++;

    // 分片挂起发生在子树深处：`yield*` 让挂起信号穿透到驱动循环，
    // try/finally 保证无论正常返回、提前 return(0) 还是异常，本层落子都被撤销。
    let score: number;
    try {
      score = yield* quiescence(state, alpha, beta, !isMaximizing, qDepth - 1, ply + 1, session);
    } finally {
      unapplyMove(state, undo);
    }

    if (isMaximizing) {
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    } else {
      if (score <= alpha) return alpha;
      if (score < beta) beta = score;
    }
  }

  // 被将军且无任何合法应将 = 被绝杀（越快绝杀分数越高）
  if (inCheck && legalCount === 0) {
    return isMaximizing ? -MATE_SCORE + ply : MATE_SCORE - ply;
  }

  return isMaximizing ? alpha : beta;
}

/**
 * Minimax + Alpha-Beta 剪枝（带超时中断、将军延伸、终局检测）
 * @param ply 距根节点的层数（用于绝杀分数：越快绝杀越好）
 * @param ext 本路径已用的将军延伸次数（上限 2，防止将军链爆炸）
 *
 * 生成器版本：分片跑满时 `yield SearchYieldSignal` 原地挂起，驱动循环让出主线程后恢复。
 */
function* minimax(
  state: GameState,
  depth: number,
  alpha: number,
  beta: number,
  isMaximizing: boolean,
  ply: number,
  ext: number,
  session: SearchSession
): SearchGen {
  // 超时/分片检查：超时立即返回中立分（结果会被上层丢弃）；分片跑满则挂起让出主线程
  {
    const check = checkSearch(session);
    if (check === 'send') yield SearchYieldSignal;
    if (check === 'abort') return 0;
  }

  // 叶子节点：进入静态搜索
  if (depth <= 0) {
    return yield* quiescence(state, alpha, beta, isMaximizing, 4, ply, session);
  }

  const moves = generatePseudoMoves(state);

  // 无任何伪合法走法：被将死或困毙（中国象棋困毙亦判负）
  if (moves.length === 0) {
    return isMaximizing ? -MATE_SCORE + ply : MATE_SCORE - ply;
  }

  // 走法排序：吃子 > 杀手走法 > 其他
  const sortedMoves = moves.map(m => ({
    ...m,
    sortScore: m.score + (isKillerMove(depth, m) ? 5000 : 0),
  })).sort((a, b) => b.sortScore - a.sortScore);

  let bestScore = isMaximizing ? -Infinity : Infinity;
  let legalCount = 0;

  for (const move of sortedMoves) {
    {
      const check = checkSearch(session);
      if (check === 'send') yield SearchYieldSignal;
      if (check === 'abort') break;
    }

    const undo = applyMove(state, move.pieceId, move.toCol, move.toRow);

    // 合法性：走棋后自己的将不能被攻击（applyMove 后 sideTag 已切到对方）
    const moverSide = state.sideTag === RED_SIDE ? BLACK_SIDE : RED_SIDE;
    if (isSideInCheck(state, moverSide)) {
      unapplyMove(state, undo);
      continue;
    }
    legalCount++;

    // 将军延伸：这步棋将军了对手 → 延伸 1 层（战术序列看得更深）
    const givesCheck = isSideInCheck(state, state.sideTag);
    const extension = givesCheck && ext < 2 ? 1 : 0;

    // 分片挂起发生在子树深处：`yield*` 让挂起信号穿透到驱动循环，
    // try/finally 保证无论正常返回、提前 return(0) 还是异常，本层落子都被撤销。
    let score: number;
    try {
      score = yield* minimax(
        state, depth - 1 + extension, alpha, beta, !isMaximizing, ply + 1, ext + extension, session
      );
    } finally {
      unapplyMove(state, undo);
    }

    if (session.aborted) break;

    if (isMaximizing) {
      if (score > bestScore) bestScore = score;
      if (score > alpha) alpha = score;
    } else {
      if (score < bestScore) bestScore = score;
      if (score < beta) beta = score;
    }

    if (alpha >= beta) {
      // 记录杀手走法
      recordKiller(depth, move);
      break;
    }
  }

  // 有伪合法走法但全部不合法（送将）= 被将死或困毙
  if (legalCount === 0) {
    return isMaximizing ? -MATE_SCORE + ply : MATE_SCORE - ply;
  }

  return bestScore;
}

// ======================== 对外接口 ========================

export interface AIMoveResult {
  pieceId: number;
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
  score: number;
}

/** 各难度时间预算（毫秒）—— 硬性中断保证不会超时卡死 */
const TIME_BUDGET: Record<string, number> = {
  easy: 500,
  medium: 1200,
  hard: 2500,
};

/** 各难度最大搜索深度（JS 环境下深度 4 已接近性能极限，靠强化评估函数保证棋力） */
const MAX_DEPTH: Record<string, number> = {
  easy: 2,
  medium: 3,
  hard: 4,
};

/**
 * 迭代加深搜索（带时间预算 + 硬性超时中断 + 分片让出）
 * 保证：无论搜索多慢，时间一到立即中断，必定返回已完成的最新结果
 *
 * 主线程友好：搜索按约 SEND_SLICE_MS 一段切片执行，每片跑满就 await 一次宏任务让出，
 * 让触摸事件、动画帧、音频桥接消息有机会被处理。分片只切"什么时候返回事件循环"，
 * 不改搜索结果——被让出打断的根走法会在让出后从头重试，且时间预算不因让出而缩水。
 * 因此同一局面在同一预算下的择着与让出间隔无关（有基准脚本比对择着一致性）。
 *
 * @param pureBest 纯最佳模式（提示）：跳过根节点多样化随机与反循环惩罚
 */
export async function searchWithTimeBudget(
  state: GameState,
  maxDepth: number,
  timeBudget: number,
  pureBest: boolean
): Promise<AIMoveResult | null> {
  const isMaximizing = state.sideTag === RED_SIDE;
  let moves = generatePseudoMoves(state);
  if (moves.length === 0) return null;

  // 长将长捉超限时的择着偏好（方案 10 娱乐向改造）：
  // 超限只提示不判负，AI 仍应优先变招——根节点剔除会继续长将/长捉的着法，
  // 避免把自己拖进僵局（最终由自然限招/互长将互长捉判和收场）
  if (state.ruleState?.banActive && state.ruleState.banSide === state.sideTag) {
    const legal = moves.filter(m => !isMoveBanned(state, m.pieceId, m.toCol, m.toRow));
    // 全部着法被标红在规则上不可达（引擎 banMoves 仅覆盖将/捉着，必有变招着存在）；
    // 防御性兜底：若过滤后为空则退回原列表
    if (legal.length > 0) moves = legal;
  }

  const session = createSession(timeBudget, pureBest);
  activeSearch = session;

  let bestMove: AIMoveResult | null = null;

  // 清空杀手走法
  for (let d = 0; d < 20; d++) {
    killerMoves[d] = [null, null];
  }

  // 检测当前是否处于循环中（用于动态提高随机性）  // 注意：当前局面在出现时已记录过 1 次，计数 >= 2 才是真正发生重复
  const currentHash = state.zobristHash;
  const currentRepetitionCount = historyHashCount.get(currentHash) || 0;
  const isInRepetition = currentRepetitionCount >= 2;

  // 检测最近 4 步是否构成完整往返循环：[红 A→B, 黑 C→D, 红 B→A, 黑 D→C] → 局面回到 4 步前
  const recentHistory = state.moveHistory.slice(-20); // 只看最近 20 步
  const hasRecentCycle = !session.pureBest && detectRecentCycle(state.moveHistory);

  // 反循环机制（多样化随机、重复走法惩罚）仅在出现真实重复征兆时激活：
  // 当前局面已重复（>= 2 次）或最近走法形成 2-周期往返循环。
  // 正常局面下 AI 走确定性的客观最优着法，不受任何随机/惩罚干扰
  const antiLoopActive = !session.pureBest && (isInRepetition || hasRecentCycle);

  // 统计历史走法频率（用于根节点过滤高频重复走法，仅反循环激活时使用）
  const moveFrequency = new Map<string, number>();
  for (const m of recentHistory) {
    const key = `${m.pieceId}-${m.fromCol}-${m.fromRow}-${m.toCol}-${m.toRow}`;
    moveFrequency.set(key, (moveFrequency.get(key) || 0) + 1);
  }

  // 根节点走法评估结果（用于多样化选择）
  interface RootMoveEval {
    move: AIMoveResult;
    score: number;
    isRepetitive: boolean; // 是否为重复走法
  }
  const rootMoveEvals: RootMoveEval[] = [];

  // 一步终局优先：吃将 / 绝杀 / 困毙若有，直接返回，不再进入迭代加深。
  // 这是「绝杀着法永远排第一、绝不会被剪枝掉」的最强保证。
  const immediateWin = findImmediateWin(state, moves);
  if (immediateWin) {
    activeSearch = null;
    return {
      pieceId: immediateWin.pieceId,
      fromCol: immediateWin.fromCol,
      fromRow: immediateWin.fromRow,
      toCol: immediateWin.toCol,
      toRow: immediateWin.toRow,
      score: isMaximizing ? MATE_IN_1 : -MATE_IN_1,
    };
  }

  // 迭代加深
  for (let depth = 1; depth <= maxDepth; depth++) {
    if (searchSpent(session) > session.deadline) break;

    let currentBest: AIMoveResult | null = null;
    let currentBestScore = isMaximizing ? -Infinity : Infinity;
    let currentBestCapturedValue = 0; // 当前最优走法的吃子价值（等分 tie-break 用）
    let alpha = -Infinity;
    // 注意：beta 必须为可变变量 —— 执黑（minimizing）时每找到一个更优走法需收紧 beta，
    // 否则黑方所有根走法都以全窗口搜索，有效深度远低于红方（红黑不对称缺陷）
    let beta = Infinity;

    // 用下标循环（而不是 for...of）：分片让出后要**重试同一个根走法**，
    // 而 for...of 的迭代器无法回退。
    for (let i = 0; i < moves.length; i++) {
      if (session.aborted) break;
      const move = moves[i];

      // 吃子价值（等分 tie-break 用：评分完全相同时优先吃子、优先吃价值大的子）
      const capturedId = state.qiPan[move.toCol][move.toRow];
      const capturedValue = capturedId !== -1 ? PIECE_VALUES[capturedId] : 0;

      const undo = applyMove(state, move.pieceId, move.toCol, move.toRow);

      // 合法性：走棋后自己的将不能被攻击（applyMove 后 sideTag 已切到对方）
      const moverSide = state.sideTag === RED_SIDE ? BLACK_SIDE : RED_SIDE;
      if (!isSideInCheck(state, moverSide)) {
        // 根节点反循环惩罚：仅在检测到真实重复征兆（antiLoopActive）时启用。
        // 正常局面下不施加任何惩罚，AI 走确定性的客观最优着法；
        // 纯最佳模式（提示）同样跳过所有根节点惩罚
        let rootPenalty = 0;
        let isRepetitiveMove = false; // 是否为重复走法（多样化硬过滤用）
        if (session.pureBest) {
          // 提示通道的规则责任（确定性，非随机）：
          // 同一棋子连续第 3 个回合将军构成"长将"，继续循环会触发连杀判负 ——
          // 引导判负的走法不是客观最优解，必须扣分规避
          const givesCheck = isSideInCheck(state, state.sideTag);
          if (givesCheck) {
            const h = state.moveHistory;
            const n = h.length;
            if (n >= 4 && h[n - 3].pieceId === move.pieceId && h[n - 1].pieceId === move.pieceId) {
              rootPenalty += 200;
            }
          }
        } else if (antiLoopActive) {
          // 禁止长将：最近 4 步为 [敌走, 我方同子走, 敌走, 我方同子走] 且当前再将军，
          // 即同一棋子连续第 3 个回合将军，长将嫌疑 → 大幅扣分
          const givesCheck = isSideInCheck(state, state.sideTag);
          if (givesCheck) {
            const h = state.moveHistory;
            const n = h.length;
            const isThirdConsecutiveCheck =
              n >= 4 &&
              h[n - 3].pieceId === move.pieceId &&
              h[n - 1].pieceId === move.pieceId;
            if (isThirdConsecutiveCheck) {
              rootPenalty += 200;
            }
          }

          // 高频重复走法（同一走法近期出现 >= 2 次）
          const moveKey = `${move.pieceId}-${move.fromCol}-${move.fromRow}-${move.toCol}-${move.toRow}`;
          const frequency = moveFrequency.get(moveKey) || 0;
          if (frequency >= 2) {
            // 频率越高惩罚越大（第 2 次 -50，第 3 次 -100，第 4 次及以上 -150）
            rootPenalty += Math.min(50 * (frequency - 1), 150);
            isRepetitiveMove = true;
          }

          // 位置互换死循环：该棋子最近两步已互为反向（A→B 然后 B→A），
          // 当前走法又是上一步的反向（继续 A→B），即正在形成 2-周期循环 → 超大惩罚
          const pieceHistory = recentHistory.filter(m => m.pieceId === move.pieceId);
          if (pieceHistory.length >= 2) {
            const lastMove = pieceHistory[pieceHistory.length - 1];
            const prevMove = pieceHistory[pieceHistory.length - 2];
            const isReverseOf = (m1: typeof lastMove, m2: typeof lastMove) =>
              m1.fromCol === m2.toCol && m1.fromRow === m2.toRow &&
              m1.toCol === m2.fromCol && m1.toRow === m2.fromRow;
            if (isReverseOf(prevMove, lastMove) &&
                move.fromCol === lastMove.toCol && move.fromRow === lastMove.toRow &&
                move.toCol === lastMove.fromCol && move.toRow === lastMove.fromRow) {
              isRepetitiveMove = true;
              rootPenalty += 500;
            }
          }
        }

        // depth=1 也走 minimax → 进入静态搜索，绝杀-in-1 才能被发现
        //
        // 驱动循环：minimax 是生成器，`next()` 跑到下一个分片边界或跑完。
        // 分片跑满时它 yield 出 SearchYieldSignal 挂起（栈帧、局部变量、棋盘全部原样保留），
        // 这里 await 让出主线程一次，再 next() **从挂起的下一句继续**——
        // 不重放、不重算、不重试，因此遍历顺序、剪枝与节点数与不分片时完全一致。
        //
        // 两套时间各司其职（都不可省）：
        //  - sliceStart / yieldBegin 用**墙钟**：保证单次连续阻塞 ≈ SEND_SLICE_MS，
        //    触摸才不会被顶住超过一帧；
        //  - searchSpent() 用**纯搜索时间**推进 deadline：让出等待（RN 上约一帧）
        //    不算进预算，否则同样的 timeBudget 在真机上会比桌面少搜大量节点 = 棋力下降。
        //    扣掉让出后，搜索的"有效算力/预算"比值与不分片版本完全一致。
        let score = 0;
        const gen = minimax(state, depth - 1, alpha, beta, !isMaximizing, 1, 0, session);
        try {
          for (;;) {
            const step = gen.next();
            if (step.done) {
              score = step.value;
              break;
            }
            // 让出前先盖时间戳：此刻起到 await 恢复之间是纯等待，不计入预算
            session.yieldBegin = Date.now();
            await yieldToEventLoop();
            enterSearchSlice(session);
            session.yields++;
            __searchStats.yields = session.yields;
          }
        } finally {
          // 无论正常返回、被中断还是抛异常，本层落子都必须撤销。
          // 先 gen.return() 让生成器内部的 try/finally 逐层撤销更深层的落子，再撤根走法；
          // 顺序不能反，否则内部 unapply 会作用在已被撤销的棋盘上。
          gen.return(0);
          unapplyMove(state, undo);
        }

        // 应用根节点惩罚
        score -= rootPenalty;

        if (!session.aborted) {
          // 注意：applyMove 后 piece.col/row 已变为目标位，from 坐标必须取 move 中保存的原值
          const result: AIMoveResult = {
            pieceId: move.pieceId,
            fromCol: move.fromCol,
            fromRow: move.fromRow,
            toCol: move.toCol,
            toRow: move.toRow,
            score,
          };

          // 记录根节点走法评分（用于多样化选择，仅反循环激活时有意义）
          if (antiLoopActive && depth === maxDepth) {
            rootMoveEvals.push({ move: result, score, isRepetitive: isRepetitiveMove });
          }

          if (isMaximizing) {
            // 等分 tie-break：评分完全相同时，优先吃子、优先吃价值大的子（确定性，非随机）
            if (score > currentBestScore ||
                (score === currentBestScore && capturedValue > currentBestCapturedValue)) {
              currentBestScore = score;
              currentBest = result;
              currentBestCapturedValue = capturedValue;
            }
            if (score > alpha) alpha = score;
          } else {
            if (score < currentBestScore ||
                (score === currentBestScore && capturedValue > currentBestCapturedValue)) {
              currentBestScore = score;
              currentBest = result;
              currentBestCapturedValue = capturedValue;
            }
            // 收紧 beta：与红方收紧 alpha 对称，保证黑方获得同等的剪枝效率与搜索深度
            if (score < beta) beta = score;
          }
        }
      } else {
        // 【根因修复】非法根走法（走完后己方被将 = 送将）同样必须撤销本次落子。
        //
        // 修复前 unapplyMove 只写在 `if (!isSideInCheck(...))` 的内部，送将着法（每个中局
        // 都有若干个）走到这里就直接跳出分支，落子永久留在搜索用的局面副本上：
        //   · 走子方停在落点，它的起点格已被清空且永不复原 → 棋盘与 pieces 不自洽；
        //   · 被吃子被置 `alive=false, col/row=-1`，但它原来的格子在 qiPan 上**仍是它**
        //     （applyMove 只清走子方的起点格，从不清被吃子的原格）→ 棋盘上多出一枚
        //     「已死亡却仍登记在盘上、坐标为 -1」的僵尸子。
        // 泄漏随后被后续根走法走到那格时捕获成「alive=true + col/row=-1 的悬空活子」，
        // 再被 evaluate/getPositionBonus（PAWN_POSITION_BONUS[-1][col]）或 applyMove 的
        // ZOBRIST_TABLE[id][-1][row] 以 -1 下标读表 →
        // TypeError: Cannot read properties of undefined (reading '-1')（线上红屏）。
        //
        // 附带影响（比崩溃更隐蔽）：被污染的棋盘让 AI 后续根走法在错误局面上评估，棋力下降。
        // minimax/quiescence 的非法着法分支一直都有 unapplyMove，根节点这里此前是唯一的缺口。
        unapplyMove(state, undo);
      }
    }

    // 只有完整跑完一层（未被中断），才接受该层结果
    if (!session.aborted && currentBest) {
      bestMove = currentBest;
    } else if (session.aborted) {
      break;
    }
  }

  // 根节点候选多样化：仅在反循环机制激活时（antiLoopActive）从近优解中随机选择，  // 帮助 AI 跳出后期重复走法的死循环；正常局面下走确定性的客观最优着法
  if (antiLoopActive && rootMoveEvals.length > 0) {
    // 按分数降序排序
    rootMoveEvals.sort((a, b) => isMaximizing ? b.score - a.score : a.score - b.score);

    // 优先选择非重复走法（硬过滤）
    const nonRepetitive = rootMoveEvals.filter(e => !e.isRepetitive);
    const candidatePool = nonRepetitive.length > 0 ? nonRepetitive : rootMoveEvals;

    const bestScore = candidatePool[0].score;

    // 根据循环严重程度动态调整候选范围（越严重，范围越大）
    let candidateRange = 60; // 检测到 2-周期往返循环：放宽到 60 分
    if (currentRepetitionCount >= 3) {
      candidateRange = 200; // 严重循环：放宽到 200 分
    } else if (currentRepetitionCount >= 2) {
      candidateRange = 100; // 局面已重复：放宽到 100 分
    }

    const candidates = candidatePool.filter(e =>
      isMaximizing ? (bestScore - e.score) <= candidateRange : (e.score - bestScore) <= candidateRange
    );

    if (candidates.length > 0) {
      // 从候选中随机选择（使用加权随机，分数越高的候选被选中概率越大）
      const weights = candidates.map(e => {
        const scoreDiff = isMaximizing ? (bestScore - e.score) : (e.score - bestScore);
        return Math.max(1, candidateRange - scoreDiff); // 分差越小权重越大
      });
      const totalWeight = weights.reduce((sum, w) => sum + w, 0);
      let randomValue = Math.random() * totalWeight;

      for (let i = 0; i < candidates.length; i++) {
        randomValue -= weights[i];
        if (randomValue <= 0) {
          bestMove = candidates[i].move;
          break;
        }
      }

      // 兜底：如果加权随机失败，直接随机选
      if (!bestMove) {
        const randomIndex = Math.floor(Math.random() * candidates.length);
        bestMove = candidates[randomIndex].move;
      }
    }
  }

  // 兜底：若因极端情况没有任何结果，返回第一个合法走法，保证 AI 必定落子
  if (!bestMove) {
    for (const move of moves) {
      const undo = applyMove(state, move.pieceId, move.toCol, move.toRow);
      const moverSide = state.sideTag === RED_SIDE ? BLACK_SIDE : RED_SIDE;
      const legal = !isSideInCheck(state, moverSide);
      const result: AIMoveResult = {
        pieceId: move.pieceId,
        fromCol: move.fromCol,
        fromRow: move.fromRow,
        toCol: move.toCol,
        toRow: move.toRow,
        score: 0,
      };
      unapplyMove(state, undo);
      if (legal) {
        bestMove = result;
        break;
      }
    }
  }

  // 会话结束即失活：避免之后的一次 abortSearch 误伤已经跑完的这次搜索
  activeSearch = null;
  return bestMove;
}

/**
 * 检测最近走法是否形成 2-周期往返循环
 * 最近 4 步为 [红 A→B, 黑 C→D, 红 B→A, 黑 D→C]（双方各自走回原位）→ 局面回到 4 步前
 */
function detectRecentCycle(moveHistory: MoveRecord[]): boolean {
  const n = moveHistory.length;
  if (n < 4) return false;
  const isReverse = (m1: MoveRecord, m2: MoveRecord) =>
    m1.pieceId === m2.pieceId &&
    m1.fromCol === m2.toCol && m1.fromRow === m2.toRow &&
    m1.toCol === m2.fromCol && m1.toRow === m2.fromRow;
  // 红方前后两步互为反向，黑方前后两步互为反向 → 完整往返循环
  return (
    isReverse(moveHistory[n - 4], moveHistory[n - 2]) &&
    isReverse(moveHistory[n - 3], moveHistory[n - 1])
  );
}

/**
 * 异步获取 AI 走法
 */
export async function getBestMoveAsync(
  state: GameState,
  difficulty: 'easy' | 'medium' | 'hard'
): Promise<AIMoveResult | null> {
  // 防御性取消正在进行的提示预计算：避免与 AI 搜索争抢算力
  // （两次搜索各自持有独立会话，不会再有共享 deadline 被覆盖的问题）
  cancelHintPonder();
  // 让出主线程，确保 UI 更新（"AI思考中"提示），同时给被取消的预计算留出收尾时间
  await new Promise<void>(resolve => setTimeout(resolve, 50));
  const maxDepth = MAX_DEPTH[difficulty] || 4;
  const timeBudget = TIME_BUDGET[difficulty] || 2000;
  // 让出主线程并分片执行：残局闯关固定走本地 AI，hard 预算长达 2.5s，
  // 若全程同步阻塞会冻结 JS 线程，导致走子音效的音频桥接消息无法送达、AI 落子无声；
  // 分片后搜索期间音频/UI/触摸保持响应（搜索逻辑与结果不受影响）。
  // 在私有副本上搜索：让出期间调用方（React state）不会被改写成搜索树的中间局面
  return searchWithTimeBudget(cloneForSearch(state), maxDepth, timeBudget, false);
}

// ======================== 提示预计算（后台思考 / Ponder） ========================

/**
 * 预计算条目：以局面指纹（Zobrist 哈希 + 步数 + 走棋方）标识。
 * 玩家思考期间，提示搜索在后台分片运行；点击"提示"时通常直接命中结果，即时展示。
 */
interface PonderEntry {
  hash: number;
  historyLen: number;
  sideTag: boolean;
  done: boolean;
  result: AIMoveResult | null;
  promise: Promise<AIMoveResult | null>;
}

let ponderEntry: PonderEntry | null = null;

/** 中止当前搜索（若有）。搜索会在下一次节点轮询（≤512 节点）时看到中断标志并退出 */
export function abortSearch(): void {
  if (activeSearch) activeSearch.aborted = true;
}

/**
 * 取消提示预计算（玩家走棋/悔棋/重开等局面变更前调用）。
 * 已中止的搜索不会写入缓存（条目已清空，收尾时引用比对失败）。
 */
export function cancelHintPonder(): void {
  if (ponderEntry && !ponderEntry.done) {
    abortSearch();
  }
  ponderEntry = null;
}

/** 判断预计算条目是否与给定局面一致（防止过期结果被误用） */
function ponderMatches(entry: PonderEntry, state: GameState): boolean {
  return (
    entry.hash === state.zobristHash &&
    entry.historyLen === state.moveHistory.length &&
    entry.sideTag === state.sideTag
  );
}

/**
 * 【P2：让提示预计算只在"闲时"跑，绝不与玩家交互抢主线程】
 *
 * 原本 precomputeHint 在每次落子后 250ms 就硬启动一个 hard/2500ms 的搜索。
 * 修完 P0（让出回到宏任务）之后触摸不再被饿死，但搜索期间仍会占满 JS 线程
 * （实测 99.2% 占空比），棋盘拿不到干净的一帧，观感上仍是"点了没反应"。
 * 所以再加一层：预计算推迟到**没有任何触摸/交互在途**时才启动。
 *
 * 触摸提示窗口 HINT_TOUCH_GRACE_MS：玩家刚碰过棋盘后的一小段时间内不启动预计算，
 * 免得"点一下棋子 → 预计算立刻抢占 → 这一下又变卡"。
 *
 * 注意：闲时窗口只由"有没有人碰过棋盘"决定，不依赖任何平台 API，
 * 因此在 Node/Jest 下与真机表现完全一致，搜索行为不受运行环境影响。
 */
const HINT_TOUCH_GRACE_MS = 1200;

/**
 * 最后一次交互（触摸）的时间戳。
 *
 * 初值是**模块加载时刻**而不是 0：用户报的现象之一是"第一次进入棋盘后立即点棋子"。
 * 进棋盘那一刻预计算还没跑，但页面刚挂载时往往正在做首帧布局、图片解码、
 * 走子动画起步——玩家正要上手点第一下。此时直接启动 hard/2500ms 会抢在前面。
 * 用加载时刻做初值，等于给"刚进入"也套上同一段静默期。
 */
let lastTouchAt = Date.now();
/** 是否正处于触摸交互的活跃期（用于跨 await 边界兜底，见 hintInteractiveGuard） */
let touchInteractionActive = false;

/**
 * 由 UI 层在棋盘收到触摸时调用：记录交互活跃期，阻止预计算抢占；
 * 并中止**已经在跑**的预计算（玩家的意图优先于后台算力）。
 */
export function noteBoardInteraction(): void {
  lastTouchAt = Date.now();
  touchInteractionActive = true;
  // 玩家开始操作了 → 立刻中止后台预计算，把主线程让回来
  if (ponderEntry && !ponderEntry.done) {
    abortSearch();
  }
}

/** 由 UI 层在触摸结束后调用：开一个宽限期，期间不重启预计算 */
export function endBoardInteraction(): void {
  touchInteractionActive = false;
  lastTouchAt = Date.now();
}

/** 当前是否处于"不要启动预计算"的窗口（触摸活跃期或宽限期内） */
function isHintBusyWindow(): boolean {
  return touchInteractionActive || Date.now() - lastTouchAt < HINT_TOUCH_GRACE_MS;
}

/** 跨 await 边界兜底：这段时间里玩家碰过棋盘，就放弃本次预计算 */
function hintInteractiveGuard(entry: PonderEntry): boolean {
  return ponderEntry !== entry || isHintBusyWindow();
}

/**
 * 让出到"闲时"：若玩家正在交互/刚交互过，等待到宽限期结束；
 * 等待本身同样用宏任务让出，绝不阻塞事件循环。
 */
async function waitForIdleHintWindow(entry: PonderEntry): Promise<boolean> {
  while (isHintBusyWindow()) {
    if (ponderEntry !== entry) return false; // 局面已变 → 放弃
    await new Promise<void>(resolve => setTimeout(resolve, 120));
  }
  return ponderEntry === entry;
}

/**
 * 提示搜索（纯最佳模式）：hard 深度与时间预算、完全确定性。
 *
 * 让出方式与 AI 对弈搜索完全相同：固定 12ms 分片（SEND_SLICE_MS），
 * 每片跑满就把搜索挂起、让出主线程，然后从挂起点继续（不会重放已算过的子树）。
 * 因此最长连续阻塞约等于一个分片（十几毫秒），而不是「一整棵根走法子树」
 * ——旧实现只在根走法之间检查让出间隔，实测中局单次阻塞可达约 125ms。
 *
 * 搜索期间每个分片都会经由 checkSearch 看到 session.aborted（noteBoardInteraction
 * 在触摸瞬间置位），因此"玩家碰了棋盘"最迟一个分片内就会让出主线程；
 * 但分片之间要真正把线程还回宏任务队列，需要下一次 await 让出，所以整体收敛
 * 在十几毫秒量级（而不是旧实现里那种"整个搜索期间触摸排不进来"）。
 */
async function runHintSearch(state: GameState): Promise<AIMoveResult | null> {
  // 同样在私有副本上搜索：提示预计算在后台与玩家操作并行，更不能改写 live state
  return await searchWithTimeBudget(cloneForSearch(state), MAX_DEPTH.hard, TIME_BUDGET.hard, true);
}

/**
 * 后台预计算提示走法。调用时机：玩家回合开始前
 * （开局玩家先手、AI 走棋完成、悔棋后、载入存档后轮到玩家）。
 * 同一局面重复调用直接忽略；局面不同则取消旧计算并启动新计算。
 */
export function precomputeHint(state: GameState): void {
  if (state.gameStatus !== 'playing') return;
  if (ponderEntry && ponderMatches(ponderEntry, state)) return; // 该局面已在计算/已完成
  cancelHintPonder();
  const entry: PonderEntry = {
    hash: state.zobristHash,
    historyLen: state.moveHistory.length,
    sideTag: state.sideTag,
    done: false,
    result: null,
    promise: Promise.resolve(null),
  };
  ponderEntry = entry;
  entry.promise = (async () => {
    // 延迟启动：让走棋动画/音效/UI 先完成渲染，避免争抢主线程造成动画卡顿
    await new Promise<void>(resolve => setTimeout(resolve, 250));
    // 延迟期间局面已变化（玩家快速走棋/悔棋/重开等）→ 放弃本次预计算
    if (hintInteractiveGuard(entry)) return null;
    // P2：玩家仍在操作/刚操作过 → 继续等到闲时窗口再启动，绝不与交互抢线程
    if (!(await waitForIdleHintWindow(entry))) return null;
    if (hintInteractiveGuard(entry)) return null;
    const result = await runHintSearch(state);
    // 搜索期间被取消（条目已替换/清空，或玩家触碰了棋盘）→ 结果不入缓存
    if (ponderEntry === entry && !touchInteractionActive) {
      entry.done = true;
      entry.result = result;
    }
    return result;
  })();
}

/**
 * 获取提示走法（纯最佳模式）
 * 与 AI 对弈思考的区别：
 * - 完全确定性：同一局面永远返回同一走法，无任何随机多样化
 * - 不考虑对局历史：不施加重复局面/长将/长捉等惩罚，只评估客观最优
 * - 固定使用最高难度（hard）的搜索深度与时间预算，保证提示质量
 *
 * 速度优化：优先命中后台预计算结果（玩家思考期间已完成 → 即时返回；
 * 仍在计算 → 等待同一搜索完成，比重新发起更快）。未命中才现场搜索。
 */
export async function getHintMoveAsync(
  state: GameState
): Promise<AIMoveResult | null> {
  // 命中预计算：结果与现场搜索完全一致（同一搜索核心、同一预算、同一确定性逻辑）
  if (ponderEntry && ponderMatches(ponderEntry, state)) {
    if (ponderEntry.done) return ponderEntry.result;
    return ponderEntry.promise;
  }
  // 未命中：取消过期预计算，现场发起搜索
  cancelHintPonder();
  // 让出主线程，确保 UI 先渲染（选中态清理等）
  await new Promise<void>(resolve => setTimeout(resolve, 50));
  return runHintSearch(state);
}
