/**
 * AI 调度器（纯本地）单测 —— 重点是**引擎来源标签**。
 *
 * ============================================================================
 * 为什么专门建这个文件（2026-10 审计：本模块此前**零测试覆盖**）
 *
 * aiDispatcher 是"编排器结果 → UI 角标"的最后那一跳，也是本次重构改动最频繁的接缝，
 * 但整个测试体系里没有任何一个 suite import 过它。后果很具体：
 * 把 resolveOfflineEngineLabel 硬编码成 'pikafish-local'（即重新引入
 * "把 TS 兜底着法虚报成皮卡鱼"的缺陷）**不会有任何测试失败**。
 *
 * 这里把标签契约固化成断言，其中第 (4)/(8) 条是本次修复的核心——
 * 它们专门覆盖"引擎在兜底搜索期间刚好启动完成"的时序竞态，那是旧实现
 *（用搜索**结束后**查到的全局状态来定标签）唯一会误报的窗口。
 */

// ---- 依赖全部 mock 掉：本文件只验证调度器自己的标签/兜底/取消逻辑 ----

const mockGetStatus = jest.fn();
jest.mock('../pikafish', () => ({
  getOfflineEngine: () => ({ getStatus: mockGetStatus }),
}));

const mockRequestOfflineMove = jest.fn();
const mockTakeOfflinePonder = jest.fn();
jest.mock('../offlineAiAdapter', () => ({
  requestOfflineMove: (...args: unknown[]) => mockRequestOfflineMove(...args),
  takeOfflinePonder: (...args: unknown[]) => mockTakeOfflinePonder(...args),
  OfflineSearchAbortedError: class OfflineSearchAbortedError extends Error {
    constructor(message = '搜索已取消') {
      super(message);
      this.name = 'OfflineSearchAbortedError';
    }
  },
}));

const mockGetBestMoveAsync = jest.fn();
const mockGetHintMoveAsync = jest.fn();
jest.mock('../AIEngine', () => ({
  getBestMoveAsync: (...args: unknown[]) => mockGetBestMoveAsync(...args),
  getHintMoveAsync: (...args: unknown[]) => mockGetHintMoveAsync(...args),
}));

// 出口守卫依赖的送将判定 + 落点合法性判定：默认放行，可按用例改写
const mockIsMoveKingSafe = jest.fn(() => true);
/**
 * 【2026-10 审计 D2】rejectMoverUnsafe 现在还会查 `getValidMoves` 落点合法性
 * （揭棋引擎与本仓库是**两套**实现，失配会把非法着法直接写进盘面）。
 * 这里默认返回一张全 true 的表，即「引擎给的着法都合法」。
 */
const mockGetValidMoves = jest.fn(() =>
  Array.from({ length: 9 }, () => new Array(10).fill(true))
);
jest.mock('../GameEngine', () => ({
  isMoveKingSafe: (...args: unknown[]) => mockIsMoveKingSafe(...args),
  getValidMoves: (...args: unknown[]) => mockGetValidMoves(...args),
}));

import { getBestMoveOffline, getHintMoveOffline } from '../aiDispatcher';
import type { GameState } from '../GameEngine';

/** requestOfflineMove / takeOfflinePonder 都被 mock，state 只作为透传参数 */
const state = {} as GameState;

/** 编排器盖章的搜索结果（正常由 requestOfflineMove 返回） */
const outcome = (engine: 'pikafish' | 'legacy', purpose: 'move' | 'hint' = 'move') => ({
  pieceId: 16,
  fromCol: 1,
  fromRow: 9,
  toCol: 1,
  toRow: 7,
  score: 0,
  engine,
  depth: 4,
  timeMs: 12,
  purpose,
});

/** 兜底 TS AI 的着法 */
const tsMove = {
  pieceId: 16,
  fromCol: 1,
  fromRow: 9,
  toCol: 1,
  toRow: 7,
  score: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetStatus.mockReturnValue({ source: 'pikafish', capabilities: null, reason: null });
  mockIsMoveKingSafe.mockReturnValue(true);
  mockGetValidMoves.mockImplementation(() =>
    Array.from({ length: 9 }, () => new Array(10).fill(true))
  );
});

describe('aiDispatcher 引擎来源标签（纯本地）', () => {
  it('(1) 真引擎服务的着法 → pikafish-local', async () => {
    mockRequestOfflineMove.mockResolvedValue(outcome('pikafish'));
    const r = await getBestMoveOffline(state, 'medium');
    expect(r?.engine).toBe('pikafish-local');
  });

  it('(2) 兜底着法且引擎仍在启动/重试 → pikafish-starting（会自动升级）', async () => {
    mockRequestOfflineMove.mockResolvedValue(outcome('legacy'));
    mockGetStatus.mockReturnValue({ source: 'starting', capabilities: null, reason: 'booting' });
    const r = await getBestMoveOffline(state, 'medium');
    expect(r?.engine).toBe('pikafish-starting');
  });

  it('(3) 兜底着法且引擎已判永久不可用 → legacy（本局一直兜底）', async () => {
    mockRequestOfflineMove.mockResolvedValue(outcome('legacy'));
    mockGetStatus.mockReturnValue({ source: 'legacy', capabilities: null, reason: '永久不可用' });
    const r = await getBestMoveOffline(state, 'medium');
    expect(r?.engine).toBe('legacy');
  });

  /**
   * (4) 竞态回归（2026-10 审计 P1 核心断言）
   *
   * 旧实现：标签 = 搜索**结束后**查一次 getStatus()。
   * 兜底 TS 搜索可能持续 0.5~2.5s，期间引擎完全可能刚好启动完成 ——
   * 此时查到的状态是 'pikafish'，于是**明明由 TS 算出的着法**被标成
   * 'pikafish-local'（绿点 + "皮卡鱼（难度）"），虚报棋力来源一个量级。
   *
   * 新实现：标签由编排器为**那一步**盖的章（servedBy）决定，与搜索后的状态无关。
   * 本用例正是构造那个窗口：servedBy='legacy' 而状态已变成 'pikafish'。
   */
  it('(4) 兜底着法 + 引擎此刻已就绪 → 仍不得标成 pikafish-local（竞态回归）', async () => {
    mockRequestOfflineMove.mockResolvedValue(outcome('legacy'));
    // 引擎"在兜底搜索期间刚好启动完成"：搜索结束后查到的状态是 pikafish
    mockGetStatus.mockReturnValue({ source: 'pikafish', capabilities: { banner: 'x' }, reason: null });

    const r = await getBestMoveOffline(state, 'medium');
    // 这一步实际是兜底算的 → 绝不能给绿灯
    expect(r?.engine).not.toBe('pikafish-local');
    expect(r?.engine).toBe('pikafish-starting');
  });

  it('(5) requestOfflineMove 抛非取消错误 → 回退 TS 兜底，标 legacy', async () => {
    mockRequestOfflineMove.mockRejectedValue(new Error('引擎炸了'));
    mockGetBestMoveAsync.mockResolvedValue(tsMove);
    const r = await getBestMoveOffline(state, 'medium');
    expect(mockGetBestMoveAsync).toHaveBeenCalled();
    expect(r?.engine).toBe('legacy');
  });

  it('(6) 取消（OfflineSearchAbortedError）→ 返回 null，不产生着法、不降级兜底', async () => {
    const { OfflineSearchAbortedError } = jest.requireMock('../offlineAiAdapter');
    mockRequestOfflineMove.mockRejectedValue(new OfflineSearchAbortedError());
    const r = await getBestMoveOffline(state, 'medium');
    expect(r).toBeNull();
    // 取消意味着"用户悔棋/重开/离场了"，不该让兜底 AI 白算一步
    expect(mockGetBestMoveAsync).not.toHaveBeenCalled();
  });

  it('(7) 着法被出口守卫拒收（送将）→ 返回 null，不落子', async () => {
    mockRequestOfflineMove.mockResolvedValue(outcome('pikafish'));
    mockIsMoveKingSafe.mockReturnValue(false); // 守卫判定为送将
    const r = await getBestMoveOffline(state, 'medium');
    expect(r).toBeNull();
  });

  it('(8) 兜底着法被守卫拒收 → 也不回退兜底（避免同一个坏着法再来一次）', async () => {
    mockRequestOfflineMove.mockRejectedValue(new Error('引擎炸了'));
    mockGetBestMoveAsync.mockResolvedValue(tsMove);
    mockIsMoveKingSafe.mockReturnValue(false);
    const r = await getBestMoveOffline(state, 'medium');
    expect(r).toBeNull();
  });

  /**
   * 【2026-10 审计 D2】着法**不送将**但**落点不在合法着法表**里时也必须拒收。
   *
   * 背景：揭棋引擎（Pikafish `jieqi_old`）与本仓库是两套实现，两者对
   * 「已翻开的士/象是否仍受九宫河界限制」等边界的认知可能不同。一旦失配，
   * 引擎给的落点会被 `screens/game/index.tsx` 的 makeMove 直接落子（它不校验），
   * 盘面进入**无法靠对方补救**的非法状态。
   */
  it('(11) 落点不在合法着法表 → 引擎着法被拒收（即便不送将），不把非法着法交给界面', async () => {
    mockRequestOfflineMove.mockResolvedValue(outcome('pikafish'));
    mockIsMoveKingSafe.mockReturnValue(true); // 不送将
    // 全 false：引擎着法与兜底着法的落点 (1,7) 都非法 ⇒ 最终只能是 null。
    // 这正是「两套规则实现失配」时的真实情形：连兜底 AI 也走不到那个点。
    mockGetValidMoves.mockReturnValue(Array.from({ length: 9 }, () => new Array(10).fill(false)));
    mockGetBestMoveAsync.mockResolvedValue(tsMove);

    const r = await getBestMoveOffline(state, 'medium');
    expect(r).toBeNull();
  });

  it('(12) 落点合法 → 放行（守住 D2 的闸不会误杀正常着法）', async () => {
    mockRequestOfflineMove.mockResolvedValue(outcome('pikafish'));
    const legal = Array.from({ length: 9 }, () => new Array(10).fill(false));
    legal[1][7] = true; // outcome() 的落点正是 (1,7)
    mockGetValidMoves.mockReturnValue(legal);

    const r = await getBestMoveOffline(state, 'medium');
    expect(r?.toCol).toBe(1);
    expect(r?.toRow).toBe(7);
  });
});

describe('aiDispatcher 提示路径（ponder 命中）', () => {
  it('(9) 命中预计算 → 用预计算自带的引擎章，而非此刻重查状态', async () => {
    mockTakeOfflinePonder.mockReturnValue(
      Promise.resolve(outcome('legacy', 'hint'))
    );
    // 预计算在引擎升级**之后**才被取用 —— 重查状态会得到 pikafish
    mockGetStatus.mockReturnValue({ source: 'pikafish', capabilities: null, reason: null });

    const r = await getHintMoveOffline(state);
    // 仍必须如实反映"这步是兜底算的"
    expect(r?.engine).toBe('pikafish-starting');
  });

  it('(10) 未命中预计算 → 落到现场搜索', async () => {
    mockTakeOfflinePonder.mockReturnValue(null);
    mockRequestOfflineMove.mockResolvedValue(outcome('pikafish', 'hint'));
    const r = await getHintMoveOffline(state);
    expect(r?.engine).toBe('pikafish-local');
    expect(mockRequestOfflineMove).toHaveBeenCalled();
  });
});
