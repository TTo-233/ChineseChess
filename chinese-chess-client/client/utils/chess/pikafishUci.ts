/**
 * 皮卡鱼 UCI 协议 —— **纯函数层**（零 IO、零原生依赖、可单测）
 *
 * 本文件只做三件事：
 *   1. 生成发给引擎的命令（position / go / stop ...）；
 *   2. 解析引擎回来的文本行（uciok / readyok / option / info / bestmove）；
 *   3. 在 UCI 坐标与项目内部坐标（col 0..8 / row 0..9）之间换算。
 *
 * 之所以把协议层做成纯函数：它要跑在三个地方（Web Worker、WebView、Android/iOS
 * 原生模块回调），但**逻辑必须只有一份**。任何"在 UI 线程解析 bestmove"的做法
 * 都会让三端行为漂移。
 *
 * ============================================================================
 * 【协议要点（与仓库服务端 worker 完全一致，服务端已跑通）】
 *
 * · 引擎只会说 **UCI**（皮卡鱼不支持 UCCI），坐标是 `a..i` + `0..9`。
 * · `position` 命令**必须**带前缀，且带 moves 时引擎只按 startFen+moves 重建局面，
 *   **完全忽略**同时给出的 fen —— 传错一个字节就会在「另一个局面」里搜索。
 * · 每次搜索前必须 `ucinewgame`（清置换表），否则同一局面两次搜索可能给出不同
 *   bestmove，提示就会「时灵时不灵」。
 * · 非法局面/着法会让引擎输出 `info string CRITICAL ERROR` 并**直接退出**，
 *   调用方必须能识别并重建实例，而不是等一个永远不会来的 bestmove。
 */

/** 内部坐标：col 0..8（a..i），row 0..9（row 0 是黑方底线） */
export interface InternalCoord {
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
}

export const BOARD_FILES = 'abcdefghi';
/** UCI 行号只有一位数（0..9） */
const UCI_MOVE_RE = /^([a-i])(\d)([a-i])(\d)$/;
/** 服务端 routes/ai.ts 用的是同一套正则校验上行 moves，这里保持一致 */
const UCI_MOVE_LIST_RE = /^[a-i]\d[a-i]\d$/;

export function isValidUciMove(uci: string): boolean {
  return UCI_MOVE_RE.test(uci);
}

export function isValidUciMoveList(moves: readonly string[]): boolean {
  return moves.every((m) => UCI_MOVE_LIST_RE.test(m));
}

/**
 * UCI 着法 → 内部坐标。
 *
 * 行号映射是 `row = 9 - rank`：UCI 的 rank 0 是**黑方底线**，而项目内部 row 0
 * 同样是黑方底线（见 types.ts 的 QIZI_INIT_POSITION，黑将初始在 [4,0]），
 * 所以是 9-rank 而不是 rank。服务端 pikafish.ts:86 用的同一套换算。
 *
 * @returns null 表示 UCI 格式非法（调用方必须当成引擎错误处理，不能"猜"一个落点）
 */
export function uciToInternal(uci: string): InternalCoord | null {
  const m = UCI_MOVE_RE.exec(uci);
  if (!m) return null;
  return {
    fromCol: m[1].charCodeAt(0) - 97,
    fromRow: 9 - Number(m[2]),
    toCol: m[3].charCodeAt(0) - 97,
    toRow: 9 - Number(m[4]),
  };
}

/** 内部坐标 → UCI 着法（自检与测试用；非法坐标返回 null 而不是拼一个错字符串） */
export function internalToUci(c: InternalCoord): string | null {
  const ok = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n <= max;
  if (!ok(c.fromCol, 8) || !ok(c.toCol, 8) || !ok(c.fromRow, 9) || !ok(c.toRow, 9)) return null;
  return (
    BOARD_FILES[c.fromCol] + String(9 - c.fromRow) + BOARD_FILES[c.toCol] + String(9 - c.toRow)
  );
}

/** 一次搜索的完整参数（已由难度档位翻译好） */
export interface UciSearchSpec {
  /** 起始局面 FEN（棋盘段 + 走棋方） */
  startFen: string;
  /** 起始局面之后的完整着法序列；非空时引擎只按 startFen+moves 重建 */
  moves: string[];
  multiPV: number;
  depth: number;
  /** 墙钟兜底上限（毫秒） */
  movetimeMs: number;
  /** 从候选中随机挑（仅 easy 档） */
  randomPick: boolean;
  /**
   * 根节点着法白名单（UCI）。
   *
   * 为什么需要：项目规则引擎与皮卡鱼的棋规并不完全一致（例如禁着/长将长捉）。
   * 把「本地判为合法的根着法」交给引擎的 searchmoves，可以让引擎只在允许的
   * 分支里搜索，从源头减少「引擎给出本地规则会拒绝的着法」。
   */
  searchmoves?: string[];
}

/** 搜索结果 */
export interface UciSearchResult {
  /** 最终采用���着法（randomPick 时可能是候选之一） */
  uci: string;
  /** 实际完成的深度 */
  depth: number;
  /** 各候选（仅 multiPV>1 且引擎给出了多条时存在） */
  candidates: string[];
  /** 引擎内部搜索耗时（毫秒，来自 info time） */
  timeMs: number;
}

/** 引擎输出的解析结果（累积多条 info 行后得到） */
export interface UciInfoState {
  depth: number;
  /** 当前最深一层的多候选首着：multipv 序号 → 着法 */
  candidatesByPv: Map<number, string>;
  /** candidatesByPv 所属的深度 */
  candidateDepth: number;
  timeMs: number;
}

export function createUciInfoState(): UciInfoState {
  return { depth: 0, candidatesByPv: new Map(), candidateDepth: 0, timeMs: 0 };
}

/** 每次新搜索前重置累积状态 */
export function resetUciInfoState(): UciInfoState {
  return createUciInfoState();
}

const INFO_DEPTH_RE = /info depth (\d+)/;
const INFO_TIME_RE = /\btime (\d+)/;
const INFO_MULTIPV_RE = /\bmultipv (\d+)/;
/** pv 行里取第一着：形如 `pv b2e2 b7e7 ...` */
const INFO_PV_RE = /\bpv\s+([a-i]\d[a-i]\d)/;

/**
 * 累积一条引擎输出行。
 *
 * @returns true 表示这行是 `bestmove`（搜索结束），false 表示还需要继续等
 */
export function consumeEngineLine(line: string, state: UciInfoState): boolean {
  const s = line.trim();
  if (!s) return false;

  if (s.startsWith('bestmove')) {
    // bestmove (none) 也是结束信号，由上层解析具体着法
    return true;
  }

  if (!s.startsWith('info')) return false;

  const depthMatch = INFO_DEPTH_RE.exec(s);
  if (depthMatch) {
    const d = Number(depthMatch[1]);
    if (d > state.depth) state.depth = d;
  }

  const timeMatch = INFO_TIME_RE.exec(s);
  if (timeMatch) state.timeMs = Number(timeMatch[1]);

  // 只在同一层内替换候选；出现更深一层就清空重来（与浅层候选混用会选到过期着法）
  const multiPvMatch = INFO_MULTIPV_RE.exec(s);
  const pvMatch = INFO_PV_RE.exec(s);
  if (multiPvMatch && pvMatch) {
    const d = depthMatch ? Number(depthMatch[1]) : state.depth;
    const pvIdx = Number(multiPvMatch[1]);
    if (d > state.candidateDepth) {
      state.candidatesByPv.clear();
      state.candidateDepth = d;
    }
    if (d === state.candidateDepth) {
      state.candidatesByPv.set(pvIdx, pvMatch[1]);
    }
  }
  return false;
}

/** 从 bestmove 行取出着法；`bestmove (none)` / 无法识别时返回 null */
export function parseBestmove(line: string): string | null {
  const s = line.trim();
  const m = /^bestmove\s+([a-i]\d[a-i]\d)/.exec(s);
  return m ? m[1] : null;
}

/** 引擎是否报告了致命错误（非法局面/着法会让它直接退出，必须重建实例） */
export function isCriticalErrorLine(line: string): boolean {
  return /CRITICAL ERROR/i.test(line);
}

/** 引擎是否宣布自己即将退出（`quit` 之后不会再有输出） */
export function isQuitLine(line: string): boolean {
  return /^quit\s*$/i.test(line.trim());
}

/** 引擎支持的 UCI 选项名集合（解析 option name X type ... 得到） */
export function parseOptionName(line: string): string | null {
  const m = /^option\s+name\s+(\S+)/.exec(line.trim());
  return m ? m[1] : null;
}

/** 引擎是否已握手完成（收到过 uciok） */
export function isUciOkLine(line: string): boolean {
  return line.trim() === 'uciok';
}

/** 引擎是否已就绪（收到过 readyok，可以下发搜索） */
export function isReadyOkLine(line: string): boolean {
  return line.trim() === 'readyok';
}

/**
 * 引擎启动横幅，形如 `Pikafish dev-20240226-98b20a33 by the Pikafish developers`。
 * 用于判断引擎确实起来了（而不是我们在等一个永远不会来的 readyok）。
 */
export function isBannerLine(line: string): boolean {
  return /\bPikafish\b/i.test(line) && /developers/i.test(line);
}

/* -------------------------------------------------------------------------- */
/* 命令构造                                                                    */
/* -------------------------------------------------------------------------- */

/** 设置一个选项；无值表示布尔开关 */
export function buildSetOption(name: string, value?: string | number | boolean): string {
  return value === undefined
    ? `setoption name ${name}`
    : `setoption name ${name} value ${value}`;
}

/**
 * 设置局面。
 *
 * ⚠️ 关键：带 moves 时**不要**同时塞 fen —— 皮卡鱼在有 moves 的情况下会完全忽略
 * fen，只按 startFen+moves 重建。传一个与之不一致的 fen 不会报错，只会让你
 * 在「另一个局面」里拿到一个看似合法的着法（这正是历史上「引擎返回对方着法」
 * 那类诡异 bug 的根源）。
 */
export function buildPosition(startFen: string, moves: readonly string[]): string {
  if (moves.length === 0) return `position fen ${startFen}`;
  return `position fen ${startFen} moves ${moves.join(' ')}`;
}

/** 开始搜索 */
export function buildGo(spec: UciSearchSpec): string {
  const searchmoves = spec.searchmoves?.length ? spec.searchmoves.join(' ') : null;
  // 同时给 depth 与 movetime：depth 收敛即结束；慢设备上由 movetime 兜底截断。
  return [
    'go',
    `depth ${spec.depth}`,
    `movetime ${spec.movetimeMs}`,
    searchmoves ? `searchmoves ${searchmoves}` : null,
  ]
    .filter(Boolean)
    .join(' ');
}

/** 中止当前搜索 */
export const CMD_STOP = 'stop';
/** 清空置换表/历史启发（必须在下一次 position 之前发） */
export const CMD_UCINEW_GAME = 'ucinewgame';
/** 握手 */
export const CMD_UCI = 'uci';
export const CMD_ISREADY = 'isready';
/** 退出引擎 */
export const CMD_QUIT = 'quit';

/** 完整的一次搜索命令序列（顺序敏感：ucinewgame → MultiPV → position → go） */
export function buildSearchCommands(spec: UciSearchSpec): string[] {
  return [CMD_UCINEW_GAME, buildSetOption('MultiPV', spec.multiPV), buildPosition(spec.startFen, spec.moves), buildGo(spec)];
}

/**
 * 从累积状态里挑出最终着法。
 *
 * easy 档（randomPick）在多候选里随机挑一条；其余档位取 pv 序号 1（即主变首着）。
 * 没有候选时返回 null —— 交给上层报「引擎没有给出可用着法」，
 * 绝不在这里凭空造一个落点。
 *
 * @param rand 注入随机源，便于测试可复现
 */
export function chooseUci(
  state: UciInfoState,
  randomPick: boolean,
  rand: () => number = Math.random
): { uci: string; candidates: string[] } | null {
  const candidates = Array.from(state.candidatesByPv.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, uci]) => uci)
    .filter((uci) => UCI_MOVE_RE.test(uci));
  if (candidates.length === 0) return null;
  if (randomPick && candidates.length > 1) {
    const picked = candidates[Math.floor(rand() * candidates.length)];
    return { uci: picked, candidates };
  }
  return { uci: candidates[0], candidates };
}
