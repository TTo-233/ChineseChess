/**
 * 皮卡鱼 Pikafish 在线引擎池服务（Worker 线程 · 分道调度）
 *
 * 背景：皮卡鱼 WASM 搜索会完全阻塞所在线程的事件循环。若放在主线程，
 * 搜索期间 HTTP 服务无法响应；单实例串行排队则让并发请求延迟线性累加。
 * 因此每个引擎实例运行在独立的 worker_threads 线程中，获得真正的并行能力。
 *
 * 分道（Lane）设计：
 * - light 道：入门 + 进阶（浅搜索、快响应），4 个实例；
 * - heavy 道：大师（深搜索、耗时长），1 个实例。
 * 两条道各自维护独立队列与实例，深搜索不会挤占浅搜索，互不阻塞。
 * 配比偏向 light：大师档深度 12 单次搜索约 3~8s，是长尾请求，真正需要并发的
 * 是入门/进阶这类秒回的请求；4:1 在"多台设备同时点提示/对局"时明显更跟手。
 *
 * 调度策略：
 * - 请求按难度路由到对应道；道内优先分配空闲实例，无空闲则按
 *   「优先级降序 + 先来先服务」排队；
 * - 每任务安全超时：先发 stop 中止，宽限期后仍无响应则重启该实例补位；
 * - 实例崩溃/退出自动重建，维持池规模；
 * - 进程退出时优雅关闭所有 Worker。
 */
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ */
/* 类型与难度配置                                                      */
/* ------------------------------------------------------------------ */

export interface PikafishMoveResult {
  /** UCI 格式着法，如 b2e2 */
  uci: string;
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
  /** 实际完成的搜索深度 */
  depth: number;
  /** 搜索耗时（毫秒，不含排队） */
  timeMs: number;
  /** MultiPV 候选（仅入门档返回） */
  candidates?: string[];
}

export interface OnlineDifficultyConfig {
  multiPV: number;
  depth?: number;
  movetime?: number;
  /** 为 true 时从候选着法中随机挑选（入门档） */
  randomPick?: boolean;
}

/** 引擎实例分道：light=入门/进阶（浅搜），heavy=大师（深搜） */
export type DifficultyLane = 'light' | 'heavy';

/**
 * 服务端联网难度（皮卡鱼）：按需求重分布——
 * - 入门：深度 4 + MultiPV 2，从候选中随机，明显可被击败；
 * - 进阶：深度 8，稳定有一定强度；
 * - 大师：深度 12，不再追求过高深度，兼顾强度与响应速度；
 * - 提示：深度 8 + MultiPV 1，纯最佳确定性搜索（交互式「提示」专用，同一局面结果恒定）。
 */
export const ONLINE_DIFFICULTY: Record<'easy' | 'medium' | 'hard' | 'hint', OnlineDifficultyConfig> = {
  easy: { multiPV: 2, depth: 4, randomPick: true },
  medium: { multiPV: 1, depth: 8, randomPick: false },
  hard: { multiPV: 1, depth: 12, randomPick: false },
  hint: { multiPV: 1, depth: 8, randomPick: false },
};

/** 难度 → 分道映射：入门/进阶走 light，大师/提示走 heavy */
export const DIFFICULTY_LANE: Record<'easy' | 'medium' | 'hard' | 'hint', DifficultyLane> = {
  easy: 'light',
  medium: 'light',
  hard: 'heavy',
  hint: 'heavy',
};

/** UCI 着法（如 b2e2）→ 内部坐标（col=文件序号，row=9-行号） */
export function uciToInternal(uci: string): { fromCol: number; fromRow: number; toCol: number; toRow: number } | null {
  const m = /^([a-i])(\d)([a-i])(\d)/.exec(uci);
  if (!m) return null;
  return {
    fromCol: m[1].charCodeAt(0) - 97,
    fromRow: 9 - Number(m[2]),
    toCol: m[3].charCodeAt(0) - 97,
    toRow: 9 - Number(m[4]),
  };
}

/* ------------------------------------------------------------------ */
/* 引擎池实现（分道）                                                  */
/* ------------------------------------------------------------------ */

/** 池内单个 Worker 引擎的运行时状态 */
interface PoolWorker {
  id: number;
  lane: DifficultyLane;
  worker: Worker;
  ready: boolean;
  busy: boolean;
  currentJobId: string | null;
  /** 是否已失效（崩溃/退出，等待重建） */
  dead: boolean;
}

/** 排队/执行中的搜索任务 */
interface QueuedJob {
  jobId: string;
  fen: string;
  cfg: OnlineDifficultyConfig;
  lane: DifficultyLane;
  /** 优先级，越大越先被调度（默认 0；交互式提示可用 1 插队） */
  priority: number;
  /** 对局起始局面（可选）：与 moves 一起提供完整历史，使引擎感知重复局面规则 */
  startFen?: string;
  /** 起始局面之后的完整着法序列（UCI，可选） */
  moves?: string[];
  resolve: (result: PikafishMoveResult) => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
  /** 分发到实例后才开始计时 */
  startedAt: number | null;
  /** 安全超时定时器 */
  timer: NodeJS.Timeout | null;
}

/** 各道实例数量（可用环境变量覆盖） */
function resolveLaneSizes(): Record<DifficultyLane, number> {
  const clamp = (v: number, fallback: number) =>
    Number.isFinite(v) && v >= 1 && v <= 8 ? Math.floor(v) : fallback;
  const light = clamp(Number(process.env.PIKAFISH_LIGHT_WORKERS), 4);
  const heavy = clamp(Number(process.env.PIKAFISH_HEAVY_WORKERS), 1);
  return { light, heavy };
}

function resolveWorkerScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'ai/pikafishWorker.cjs'),
    path.resolve(process.cwd(), 'server/ai/pikafishWorker.cjs'),
    path.resolve(here, '../../ai/pikafishWorker.cjs'),
    path.resolve(here, '../ai/pikafishWorker.cjs'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`未找到 pikafishWorker.cjs，尝试过: ${candidates.join(' | ')}`);
}

/** 单任务安全超时：超过则发 stop 中止，避免异常局面长时间占用实例 */
const JOB_SAFETY_TIMEOUT_MS = Number(process.env.PIKAFISH_JOB_TIMEOUT_MS) > 0
  ? Number(process.env.PIKAFISH_JOB_TIMEOUT_MS)
  : 15000;
/** stop 之后仍无响应的宽限期，超过则强制重启该实例 */
const STOP_GRACE_MS = 3000;

class PikafishPool {
  private workers: PoolWorker[] = [];
  /** 各道独立队列 */
  private queueByLane: Record<DifficultyLane, QueuedJob[]> = { light: [], heavy: [] };
  private jobById = new Map<string, QueuedJob>();
  private laneSizes: Record<DifficultyLane, number>;
  private workerScript: string;
  private initPromise: Promise<void> | null = null;
  private shuttingDown = false;
  private nextJobSeq = 0;
  private nextWorkerId = 0;
  private shutdownRegistered = false;

  constructor() {
    this.laneSizes = resolveLaneSizes();
    this.workerScript = resolveWorkerScript();
  }

  /** 初始化：并行拉起两条道的实例并等待全部 ready（幂等） */
  ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.spawnPool().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  private async spawnPool(): Promise<void> {
    const lanes: DifficultyLane[] = ['light', 'heavy'];
    const pending: Promise<void>[] = [];
    for (const lane of lanes) {
      for (let i = 0; i < this.laneSizes[lane]; i++) {
        pending.push(this.spawnWorker(lane));
      }
    }
    this.registerShutdownHook();
    await Promise.all(pending);
    const readyCount = this.workers.filter((w) => w.ready && !w.dead).length;
    const total = this.laneSizes.light + this.laneSizes.heavy;
    console.log(
      `[Pikafish] 引擎池就绪 ${readyCount}/${total}（light=${this.laneSizes.light}，heavy=${this.laneSizes.heavy}）`,
    );
    if (readyCount === 0) throw new Error('皮卡鱼引擎池没有可用实例');
  }

  /** 拉起单个 Worker 并等待其 ready */
  private spawnWorker(lane: DifficultyLane): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const w: PoolWorker = {
        id: this.nextWorkerId++,
        lane,
        worker: new Worker(this.workerScript),
        ready: false,
        busy: false,
        currentJobId: null,
        dead: false,
      };
      this.workers.push(w);

      let settled = false;
      w.worker.on('message', (msg: any) => {
        if (msg?.type === 'ready') {
          w.ready = true;
          if (!settled) { settled = true; resolve(); }
          this.tryDispatch(lane);
        } else if (msg?.type === 'result') {
          this.handleResult(w, msg);
        }
      });
      w.worker.on('error', (err) => {
        console.error(`[Pikafish] Worker#${w.id}(${lane}) 错误:`, (err as Error)?.message || err);
        if (!settled) { settled = true; reject(err); }
        this.handleWorkerFailure(w);
      });
      w.worker.on('exit', () => {
        if (!this.shuttingDown && !w.dead) {
          console.warn(`[Pikafish] Worker#${w.id}(${lane}) 意外退出，准备重建`);
          this.handleWorkerFailure(w);
        }
      });
    });
  }

  /** 实例失效：拒绝其当前任务，从池中移除并重建一个同道实例 */
  private handleWorkerFailure(w: PoolWorker) {
    if (w.dead) return;
    w.dead = true;
    w.ready = false;
    if (w.currentJobId) {
      const job = this.jobById.get(w.currentJobId);
      if (job) {
        this.jobById.delete(w.currentJobId);
        if (job.timer) clearTimeout(job.timer);
        job.reject(new Error('皮卡鱼引擎实例异常，请重试'));
      }
      w.currentJobId = null;
    }
    this.workers = this.workers.filter((x) => x !== w);
    try { w.worker.terminate(); } catch { /* 忽略 */ }
    if (!this.shuttingDown) {
      this.spawnWorker(w.lane).then(() => this.tryDispatch(w.lane)).catch(() => undefined);
    }
  }

  /**
   * 计算一步最佳着法（分道调度入口）
   * @param lane 目标道（由难度决定）
   * @param priority 优先级，越大越先被调度
   */
  async search(
    fen: string,
    cfg: OnlineDifficultyConfig,
    lane: DifficultyLane,
    priority = 0,
    startFen?: string,
    moves?: string[],
  ): Promise<PikafishMoveResult> {
    await this.ensureInit();
    if (this.shuttingDown) throw new Error('皮卡鱼引擎池正在关闭');

    const jobId = `job_${Date.now()}_${this.nextJobSeq++}`;
    return new Promise<PikafishMoveResult>((resolve, reject) => {
      const job: QueuedJob = {
        jobId, fen, cfg, lane, priority, startFen, moves, resolve, reject,
        enqueuedAt: Date.now(), startedAt: null, timer: null,
      };
      this.jobById.set(jobId, job);
      this.queueByLane[lane].push(job);
      this.tryDispatch(lane);
    });
  }

  /** 道内调度：把队列任务分配给空闲实例 */
  private tryDispatch(lane: DifficultyLane) {
    if (this.shuttingDown) return;
    for (const w of this.workers) {
      if (w.lane !== lane || w.busy || !w.ready || w.dead) continue;
      const job = this.pickNextJob(lane);
      if (!job) break;
      this.assign(w, job);
    }
  }

  /** 道内选取下一个任务：优先级降序，其次先来先服务 */
  private pickNextJob(lane: DifficultyLane): QueuedJob | null {
    const queue = this.queueByLane[lane];
    if (queue.length === 0) return null;
    let bestIdx = 0;
    for (let i = 1; i < queue.length; i++) {
      const a = queue[i];
      const b = queue[bestIdx];
      if (a.priority > b.priority || (a.priority === b.priority && a.enqueuedAt < b.enqueuedAt)) {
        bestIdx = i;
      }
    }
    return queue[bestIdx];
  }

  private assign(w: PoolWorker, job: QueuedJob) {
    const queue = this.queueByLane[job.lane];
    const idx = queue.indexOf(job);
    if (idx >= 0) queue.splice(idx, 1);
    w.busy = true;
    w.currentJobId = job.jobId;
    job.startedAt = Date.now();
    job.timer = setTimeout(() => this.onJobTimeout(w, job), JOB_SAFETY_TIMEOUT_MS);
    w.worker.postMessage({
      type: 'search',
      jobId: job.jobId,
      fen: job.fen,
      multiPV: job.cfg.multiPV,
      depth: job.cfg.depth,
      movetime: job.cfg.movetime,
      startFen: job.startFen,
      moves: job.moves,
    });
  }

  private onJobTimeout(w: PoolWorker, job: QueuedJob) {
    if (!this.jobById.has(job.jobId)) return;
    this.jobById.delete(job.jobId);
    const queue = this.queueByLane[job.lane];
    const idx = queue.indexOf(job);
    if (idx >= 0) queue.splice(idx, 1);
    job.reject(new Error('皮卡鱼计算超时'));
    try { w.worker.postMessage({ type: 'stop', jobId: job.jobId }); } catch { /* 忽略 */ }
    // 宽限期后仍占用则强制重启补位
    setTimeout(() => {
      if (!this.shuttingDown && !w.dead && w.busy && w.currentJobId === job.jobId) {
        console.warn(`[Pikafish] Worker#${w.id} stop 后无响应，强制重启`);
        this.handleWorkerFailure(w);
      }
    }, STOP_GRACE_MS);
  }

  private handleResult(
    w: PoolWorker,
    msg: { jobId: string; uci: string; depth: number; candidates?: string[] },
  ) {
    w.busy = false;
    w.currentJobId = null;
    const job = this.jobById.get(msg.jobId);
    if (!job) {
      // 已超时/取消的任务，仅释放实例
      this.tryDispatch(w.lane);
      return;
    }
    this.jobById.delete(msg.jobId);
    if (job.timer) clearTimeout(job.timer);

    let chosen = msg.uci;
    let candidates: string[] | undefined;
    if (job.cfg.randomPick && msg.candidates && msg.candidates.length > 1) {
      candidates = msg.candidates;
      chosen = candidates[Math.floor(Math.random() * candidates.length)];
    }
    const internal = uciToInternal(chosen);
    if (!internal) {
      job.reject(new Error(`无法解析皮卡鱼着法: ${chosen}`));
    } else {
      job.resolve({
        uci: chosen,
        ...internal,
        depth: msg.depth,
        timeMs: job.startedAt ? Date.now() - job.startedAt : 0,
        candidates,
      });
    }
    this.tryDispatch(w.lane);
  }

  /** 池运行状态（分道） */
  stats() {
    const byLane = (lane: DifficultyLane) => {
      const laneWorkers = this.workers.filter((w) => w.lane === lane && !w.dead);
      return {
        instances: laneWorkers.length,
        busy: laneWorkers.filter((w) => w.busy).length,
        idle: laneWorkers.filter((w) => w.ready && !w.busy).length,
        queued: this.queueByLane[lane].length,
      };
    };
    return {
      lanes: { light: byLane('light'), heavy: byLane('heavy') },
      ready: this.workers.filter((w) => w.ready && !w.dead).length,
      busy: this.workers.filter((w) => w.busy && !w.dead).length,
      queued: this.queueByLane.light.length + this.queueByLane.heavy.length,
    };
  }

  private registerShutdownHook() {
    if (this.shutdownRegistered) return;
    this.shutdownRegistered = true;
    const shutdown = () => { void this.shutdown(); };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    process.once('beforeExit', shutdown);
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const job of this.jobById.values()) {
      if (job.timer) clearTimeout(job.timer);
      job.reject(new Error('服务关闭，皮卡鱼引擎池已停止'));
    }
    this.jobById.clear();
    this.queueByLane = { light: [], heavy: [] };
    await Promise.all(this.workers.map((w) => w.worker.terminate().catch(() => undefined)));
    this.workers = [];
    console.log('[Pikafish] 引擎池已关闭');
  }
}

const pool = new PikafishPool();

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

export interface SearchOptions {
  /** 优先级，越大越先被调度（默认 0） */
  priority?: number;
  /** 对局起始局面（可选）：与 moves 一起提供完整历史，使引擎感知重复局面规则 */
  startFen?: string;
  /** 起始局面之后的完整着法序列（UCI，可选） */
  moves?: string[];
}

/**
 * 计算一步最佳着法（对外统一入口）
 * @param fen 客户端 toFenString 生成的局面
 * @param cfg 难度配置
 * @param lane 目标道（由难度映射）
 * @param opts 调度选项（优先级 / 对局历史）
 */
export async function getPikafishMove(
  fen: string,
  cfg: OnlineDifficultyConfig,
  lane: DifficultyLane,
  opts: SearchOptions = {},
): Promise<PikafishMoveResult> {
  return pool.search(fen, cfg, lane, opts.priority ?? 0, opts.startFen, opts.moves);
}

/** 服务启动预热：拉起引擎池，避免首个请求承担初始化耗时 */
export async function warmupPikafish(): Promise<void> {
  try {
    await pool.ensureInit();
  } catch (err) {
    console.error('[Pikafish] 引擎池启动失败:', err);
  }
}

/** 引擎池运行状态（分道） */
export function getPikafishStats() {
  return pool.stats();
}
