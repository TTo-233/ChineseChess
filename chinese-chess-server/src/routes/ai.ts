/**
 * AI 联网着法路由
 *
 * 处理顺序：
 * 1. 先查开局库——命中直接返回（零 CPU 搜索，不受限流约束）；
 * 2. 未命中走每用户限流：同一客户端同时只允许 1 个在途引擎请求；
 * 3. 通过限流后按难度分道调度皮卡鱼引擎池（入门/进阶→light，大师→heavy）。
 */
import { Router, type Request, type Response } from 'express';
import {
  getPikafishMove,
  getPikafishStats,
  ONLINE_DIFFICULTY,
  DIFFICULTY_LANE,
} from '../services/pikafish';
import { lookupBookMove, getBookSize } from '../services/openingBook';

const aiRouter: Router = Router();

type Difficulty = 'easy' | 'medium' | 'hard' | 'hint';

/** 每用户并发上限：同一客户端同时只允许 1 个在途引擎请求 */
const MAX_INFLIGHT_PER_CLIENT = 1;
/** 在途请求的客户端集合（以持久化玩家 ID 作为客户端标识） */
const inflightClients = new Set<string>();
/** clientId -> 持占到期时间戳；用于给 inflightClients 兜底过期，防止"幽灵持占"永久挡住重试 */
const inflightExpiries = new Map<string, number>();
/**
 * 持占租约时长：应大于引擎 job 安全超时（JOB_SAFETY_TIMEOUT_MS，默认 15s），
 * 这样正常路径下总是由 finally 先释放，定时器只兜底异常/重启导致的泄漏。
 * 取默认值而非引用 JOB_SAFETY_TIMEOUT_MS：本行早于该常量的定义位置（esbuild 打包后同模块顺序已变）。
 */
const INFLIGHT_LEASE_MS = 20_000;

/**
 * POST /ai/move
 * body: { fen: string, difficulty: 'easy' | 'medium' | 'hard' | 'hint', priority?: number, clientId?: string,
 *         startFen?: string, moves?: string[] }
 * - priority：调度优先级，越大越先被调度（可选，默认 0；交互式提示建议传 1）
 * - clientId：客户端标识，用于限制每用户同时仅 1 个在途引擎请求（可选）
 * - difficulty='hint'：交互式「提示」专用，深度 8 纯最佳确定性搜索，同一局面结果恒定
 * - startFen + moves：对局起始局面 + 完整着法历史（UCI 数组，可选）。提供后引擎能
 *   感知本局真实重复局面（长将/长捉/不变循环），搜索中主动规避违规循环；
 *   二者需同时提供且着法奇偶与 fen 走棋方一致，否则忽略历史仅按 fen 搜索。
 * 返回:
 * - 开局库命中：{ success: true, engine: 'book', move, uci, timeMs }
 * - 引擎计算：{ success: true, engine: 'pikafish', difficulty, move, uci, depth, timeMs, candidates? }
 * - 被限流：{ success: false, error: 'busy', message }
 */

/** 读取 FEN 的走棋方标记（末尾 token），缺省按红方 'w' */
function parseSideToken(fenStr: string): 'w' | 'b' {
  const token = fenStr.trim().split(/\s+/).pop();
  return token === 'b' ? 'b' : 'w';
}

// 畸形 FEN 行宽校验（在进入 Pikafish WASM 之前拦截，避免越界写内存打崩 worker 池）：行宽异常会让 Pikafish WASM 越界写内存并打崩整个 worker 池。
// 加固：历史上前身是直接注入 dist 的补丁，现已归位到源码（改这里即可，改完在 chinese-chess-server/ 下跑 node build.js）。
const FEN_ROWS = 10, FEN_COLS = 9;
const isFenBoardShapeValid = function (fenStr: string): boolean {
  var parts = String(fenStr).trim().split(/\s+/);
  var rows = parts[0] ? parts[0].split('/') : [];
  if (rows.length !== FEN_ROWS) return false;
  for (var r = 0; r < rows.length; r++) {
    var width = 0;
    for (var i = 0; i < rows[r].length; i++) {
      var ch = rows[r][i];
      if (ch >= '0' && ch <= '9') {
        if (ch === '0') return false;
        width += Number(ch);
      } else if (/[a-z]/i.test(ch)) {
        width += 1;
      } else {
        return false;
      }
      if (width > FEN_COLS) return false;
    }
    if (width !== FEN_COLS) return false;
  }
  return true;
};

/** UCI 着法格式校验：如 b2e2 */
const UCI_RE = /^[a-i][0-9][a-i][0-9]$/;

aiRouter.post('/move', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const fen = typeof body.fen === 'string' ? body.fen.trim() : '';
  const difficulty = (body.difficulty as Difficulty) || 'medium';
  const priority = Number.isFinite(Number(body.priority)) ? Number(body.priority) : 0;
  const clientId = typeof body.clientId === 'string' && body.clientId.trim() ? body.clientId.trim() : null;

  if (!fen) {
    res.status(400).json({ success: false, error: 'invalid_fen', message: '缺少 fen 参数' });
    return;
  }
  if (!isFenBoardShapeValid(fen)) {
    // 畸形 FEN 行宽校验（在进入 Pikafish WASM 之前拦截，避免越界写内存打崩 worker 池）
    // 加固：历史上前身是直接注入 dist 的补丁，现已归位到源码（改这里即可，改完在 chinese-chess-server/ 下跑 node build.js）。
    res.status(400).json({ success: false, error: 'invalid_fen', message: 'fen 板面行宽非法' });
    return;
  }
  if (!ONLINE_DIFFICULTY[difficulty]) {
    res.status(400).json({ success: false, error: 'invalid_difficulty', message: 'difficulty 仅支持 easy/medium/hard/hint' });
    return;
  }

  // 解析并校验对局历史（可选）：合法则透传给引擎，非法则忽略（不影响正常搜索）
  let startFen: string | undefined;
  let moves: string[] | undefined;
  const rawStartFen = typeof body.startFen === 'string' ? body.startFen.trim() : '';
  const rawMoves = Array.isArray(body.moves) ? body.moves : null;
  if (rawStartFen && rawStartFen.includes('/') && rawStartFen.length <= 200 && rawMoves) {
    const cleanMoves: string[] = [];
    let valid = rawMoves.length <= 512;
    if (valid) {
      for (const mv of rawMoves) {
        if (typeof mv !== 'string' || !UCI_RE.test(mv)) { valid = false; break; }
        cleanMoves.push(mv);
      }
    }
    // 着法奇偶必须与 fen 走棋方一致，否则历史与局面不匹配，弃用
    if (valid) {
      const startSide = parseSideToken(rawStartFen);
      const flips = cleanMoves.length % 2 === 1;
      const expectedSide = flips ? (startSide === 'w' ? 'b' : 'w') : startSide;
      if (parseSideToken(fen) !== expectedSide) valid = false;
    }
    if (valid) {
      startFen = rawStartFen;
      moves = cleanMoves;
    }
  }

  // 1. 开局库优先：命中直接返回，不消耗引擎、不计入限流
  const bookMove = lookupBookMove(fen);
  if (bookMove) {
    res.json({
      success: true,
      engine: 'book',
      difficulty,
      move: {
        fromCol: bookMove.fromCol,
        fromRow: bookMove.fromRow,
        toCol: bookMove.toCol,
        toRow: bookMove.toRow,
      },
      uci: bookMove.uci,
      depth: 0,
      timeMs: 0,
    });
    return;
  }

  // 2. 每用户限流：已有在途引擎请求则拒绝
  if (clientId && inflightClients.has(clientId)) {
    res.status(429).json({
      success: false,
      error: 'busy',
      message: '您已有一个 AI 请求正在计算中，请稍候',
    });
    return;
  }
  if (clientId) {
    inflightClients.add(clientId);
    // 兜底过期：客户端可能在超时/断网后放弃等待，而引擎计算仍会继续跑完。
    // 若此时进程重启或异常路径未走到 finally，槽位会永久泄漏并挡住该 clientId 的所有后续请求。
    // 这里为每个持占记录到期时间，到点后允许重新占用，避免"幽灵持占"造成永久 429。
    // 正常路径下 finally 总先释放（远早于租约到期），定时器只兜底异常。
    const leaseUntil = Date.now() + INFLIGHT_LEASE_MS;
    inflightExpiries.set(clientId, leaseUntil);
    const leaseTimer = setTimeout(() => {
      // 仅当本次持占仍未被释放且已到期时才清理，避免误删后来者的持占
      if (inflightExpiries.get(clientId) === leaseUntil) {
        inflightClients.delete(clientId);
        inflightExpiries.delete(clientId);
      }
    }, INFLIGHT_LEASE_MS);
    if (typeof leaseTimer?.unref === 'function') leaseTimer.unref();
  }

  // 3. 分道调度引擎池
  const startedAt = Date.now();
  try {
    const cfg = ONLINE_DIFFICULTY[difficulty];
    const lane = DIFFICULTY_LANE[difficulty];
    const result = await getPikafishMove(fen, cfg, lane, { priority, startFen, moves });
    res.json({
      success: true,
      engine: 'pikafish',
      difficulty,
      move: {
        fromCol: result.fromCol,
        fromRow: result.fromRow,
        toCol: result.toCol,
        toRow: result.toRow,
      },
      uci: result.uci,
      depth: result.depth,
      timeMs: Date.now() - startedAt,
      candidates: result.candidates,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: 'engine_error',
      message: err instanceof Error ? err.message : '皮卡鱼计算失败',
    });
  } finally {
    if (clientId) {
      inflightClients.delete(clientId);
      inflightExpiries.delete(clientId);
    }
  }
});

/**
 * GET /ai/stats
 * 返回引擎池运行状态（分道）与开局库规模，便于观测健康度
 */
aiRouter.get('/stats', (_req: Request, res: Response) => {
  res.json({ success: true, ...getPikafishStats(), openingBook: getBookSize(), inflightClients: inflightClients.size });
});

export default aiRouter;
