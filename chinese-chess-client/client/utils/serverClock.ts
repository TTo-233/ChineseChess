/**
 * 服务端时间抽象（第 3 批 / §8 表 #7）
 *
 * ## 为什么需要它
 *
 * 对局载荷里的时间戳（`lastMoveTime` / `gameStartTime` / `disconnectTime` /
 * `sideReveal.time` / `clockPausedAt` / `gameStartAt`）全部由**服务端**打点，
 * 而本机 `Date.now()` 来自设备时钟。两台设备时钟不一致是常态（手动校时、系统漂移），
 * 于是「本机时间 − 服务端时间戳」会算出一个偏移任意大小的差：
 *
 * - 本机偏快 → 差值巨大 → 棋钟直接跑成负数、局时显示为 0、断线倒计时瞬间归零
 *   （用户看到「对方已断线」闪一下）；步时守卫也会误判（甚至替用户走随机棋）；
 * - 本机偏慢 → 差值为负 → `Math.max(0, ...)` 把倒计时拉回满值，倒计时长时间不归零。
 *
 * 两种表现都是「服务端其实还在正常计时」。审计在客户端找到 4 处裸 `Date.now()`
 * 直接减服务端时间戳（`useBattleStateSync` 的断线倒计时与局时、`lanBattle` 的步时与公示守卫），
 * 根因是它们各自手写 `Date.now() + serverTimeOffsetRef.current`，改一处漏一处。
 *
 * ## 约定
 *
 * **凡是与服务端时间戳做比较，一律走本模块**；本机私有的计时（防抖、节流、
 * 动画时长、AI 搜索截止、本地存档时间戳）继续用裸 `Date.now()`，那些场景
 * 两端本就不共享时刻，不需要校正——把它一并校正只会引入新的偏移。
 *
 * 偏移量 = `服务端 serverNow − 收到该负载时的本机 Date.now()`，
 * 在 `applyServerNow` 处单点写入。
 */

/** 可变的偏移量容器。约定上与页面内的 `serverTimeOffsetRef` 是同一个对象。 */
export interface ServerTimeOffsetRef {
  current: number;
}

/**
 * 服务端坐标系下的当前时刻（毫秒）。
 *
 * 用法：`serverNow(ref)`，而不是把偏移量手动加到别处——
 * 这样「忘记校正」会退化成编译期可见的类型问题，而不是一次静默的算错。
 */
export function serverNow(offsetRef: ServerTimeOffsetRef | null | undefined): number {
  return Date.now() + (offsetRef?.current ?? 0);
}

/**
 * 用载荷里的 `serverNow` 字段校正偏移量。载荷缺失或非法时保持原值
 * （一次坏负载不该把已有偏移清零，否则已显示的倒计时会跳变）。
 */
export function applyServerNow(
  offsetRef: ServerTimeOffsetRef | null | undefined,
  serverNowMs: unknown,
): void {
  if (!offsetRef) return;
  if (typeof serverNowMs === 'number' && Number.isFinite(serverNowMs)) {
    offsetRef.current = serverNowMs - Date.now();
  }
}

/**
 * 两个服务端时间戳之间的间隔（毫秒），已消除设备时钟差。
 *
 * 用于「局时多久」「走了几步」「断线多久」这类只关心**差值**的计算：
 * 偏移量在相减时会自动抵消，所以两端即使来自不同的网络包也不会有误差，
 * 且不必关心哪个包的 `serverNow` 更新。
 */
export function serverElapsedMs(
  offsetRef: ServerTimeOffsetRef | null | undefined,
  sinceServerMs: number | null | undefined,
  fallbackMs = 0,
): number {
  if (typeof sinceServerMs !== 'number' || !Number.isFinite(sinceServerMs)) return fallbackMs;
  return serverNow(offsetRef) - sinceServerMs;
}

/**
 * 服务端时间轴上的剩余秒数：`totalSec −（服务端现在 − 服务端起点）`。
 *
 * 负数按 0 处理（倒计时到点即止）。`totalSec`/`startMs` 都接受 null，
 * 缺失时返回 `totalSec`（即「刚开始」），与页面既有兜底一致。
 */
export function serverRemainingSec(
  offsetRef: ServerTimeOffsetRef | null | undefined,
  totalSec: number,
  startMs: number | null | undefined,
): number {
  if (typeof startMs !== 'number' || !Number.isFinite(startMs)) return Math.max(0, totalSec);
  const elapsedSec = (serverNow(offsetRef) - startMs) / 1000;
  return Math.max(0, Math.floor(totalSec - elapsedSec));
}