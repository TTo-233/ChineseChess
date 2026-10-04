import { getOnlineWsUrl } from '@/utils/serverConfig';
import {
  ACTION_ACK_TIMEOUT_MS,
  BattleActionNotSentError,
  BattleActionRejectedError,
  BattleActionTimeoutError,
  battleAckMessage,
  type BattleActionType,
  type BattleAckFrame,
} from '@/utils/battleProtocol';

/**
 * 在线对局 WebSocket 客户端封装
 *
 * 能力：
 * - 自动连接与指数退避重连（断线重连）
 * - 应用层心跳（每 2s 发送 { type: 'heartbeat', hidden }），驱动服务端逻辑断线检测
 * - 可见性感知：后台标签页会被浏览器节流（定时器最长约 1 分钟一次甚至冻结），
 *   进入后台立即上报 hidden=true 让服务端宽容判定，回到前台立即补发心跳并即时重连，
 *   消除「切后台被误判断线」与「回前台后仍处于断线判定」两个缺口
 * - 统一分发服务端推送（welcome/state）、动作回执（ack）与错误帧（error）
 * - send() 返回是否成功发出，失败时由调用方走 HTTP 兜底
 * - request(): 发送动作并**等待服务端裁决**（回执 / 拒绝 / 超时三类失败语义，
 *   帧未发出时抛 BattleActionNotSentError 供调用方回退 HTTP）
 *
 * 依赖 React Native / Web 内置 WebSocket（无需第三方库）。
 */

// WebSocket readyState 常量（兼容 RN 与 Web，避免依赖静态属性差异）
const WS_CONNECTING = 0;
const WS_OPEN = 1;

/**
 * 致命错误的性质，决定页面如何呈现：
 * - `'session'`：服务端判定本次会话已终结（房间不存在/本人被移出/观战席位不完整）。
 *   重连永远得不到不同结果，页面应切终态 UI 并给出返回大厅入口。
 * - `'network'`：连接彻底建立不起来且自动重连已用尽（长时间离线）。会话**可能仍然有效**，
 *   页面不可切终态（否则会误报"房间已关闭"并停掉心跳/轮询），只应提示用户；
 *   待其回到前台或手动重试时经 `resume()` 会重新开始自动重连。
 */
export type BattleFatalKind = 'session' | 'network';

export interface BattleSocketHandlers {
  /** 收到服务端状态推送（welcome / state），data 为 GameStatePayload 结构 */
  onState: (data: Record<string, unknown>) => void;
  /**
   * 动作被服务端拒绝（ack 的 status >= 400）。
   *
   * 【I-1 / C-10】服务端在 `status < 400` 时广播 state；4xx 被拒动作**也会**补推一次
   * 权威状态，但受按房间计数的限流约束（同一房间 3 秒内最多 8 次，见
   * `chinese-chess-server/src/routes/lanGame.ts` 的 `shouldSyncRejection` 与
   * `chinese-chess-server/src/routes/battleWs.ts:284-297`），超限的拒绝不会推送。
   * 所以本回执仍必须消费：页面据此回退本地乐观更新 + 向用户提示原因，
   * 否则界面会静默卡住（例：悔棋被 400 拒绝后按钮仍停在「等待对方同意」）。
   *
   * 注意：经 request() 发出的动作已经会以 Promise 拒绝的方式暴露失败，
   * 调用方若已处理，无需再依赖本回调；本回调面向即发即忘的动作
   * 以及需要全局统一兜底的场景。
   */
  onActionRejected?: (info: {
    action: BattleActionType | null;
    status: number;
    message: string;
    body: Record<string, unknown>;
  }) => void;
  /** 收到动作回执（原始帧）。除非要自行解析回执，否则优先使用 request() / onActionRejected */
  onAck?: (msg: BattleAckFrame) => void;
  /** 连接状态变化（true=已连接，false=断开/重连中） */
  onStatusChange?: (connected: boolean) => void;
  /**
   * 成功（重）连接。与 onStatusChange(true) 的区别：本回调给出**本次连接之前是否断过**，
   * 供调用方区分「首次连上」与「断线恢复」（后者需要重新拉取一次权威状态）。
   */
  onReconnected?: (info: { attempt: number }) => void;
  /** 收到致命错误（房间不存在/玩家不在房间/自动重连用尽），调用方应停止重连；按 kind 决定是否切终态 */
  onFatalError?: (message: string, kind: BattleFatalKind) => void;
  /**
   * 【P2】断线期间缓存的动作帧因队列容量上限被丢弃。
   *
   * 必须上抛而不是静默丢弃：这些是用户的真实操作意图，凭空消失会让页面与
   * 服务端状态静默分叉（客户端以为走了、服务端没收到）。
   */
  onFramesDropped?: (count: number) => void;
  /**
   * 收到非致命错误帧（除白名单致命文案外的所有 message）。
   *
   * 此前这些帧被静默丢弃：服务端用 `{ type: 'error', message }` 表达
   * 「观战者无法执行该操作」「未知消息类型」等协议级失败，丢掉后表现为无反馈。
   */
  onError?: (message: string) => void;
}

const HEARTBEAT_INTERVAL_MIN = 2000;
const HEARTBEAT_INTERVAL_MAX = 8000;
const MAX_RECONNECT_DELAY = 8000;
// 心跳补发阈值：定时器被节流（后台标签页）或页面从休眠恢复后，间隔明显超过该值时立即补发一次。
// 【P3】跟随当前心跳周期取值（2s 周期时保持 2500ms 的原有语义）。
const HEARTBEAT_STALE_RATIO = 1.25;

/**
 * 【P1】单次建连的握手等待上限。
 *
 * 此前 `new WebSocket(url)` 之后没有任何超时：实测握手耗时 961ms～11075ms（p50 1249ms），
 * 连接最坏情况下要挂 11s 才触发 onclose，而这段时间里 UI 完全无反馈（既不重连也不报错）。
 * 因此这里给每次建连加一个 10s 闸门：超时即主动 close() 并转入 scheduleReconnect，
 * 让「建连卡住」表现为一轮正常的退避重试，而不是静默挂起。
 *
 * 取 10s 而非 8s：分位最坏值 11.1s 意味着 8s 闸门会误伤「只是慢」而非「已失败」的连接。
 */
const CONNECT_TIMEOUT = 10000;

// 连接角色：对局玩家（可执行动作）或观战者（只读，仅接收状态推送）
export type BattleSocketRole = 'player' | 'spectator';

// 客户端会经 WebSocket 发出的动作类型集合（与 battleProtocol 的 BattleActionType 同源）。
// 用于 handleAck 从 reqId 前缀反查动作类型时做白名单校验，避免把畸形 reqId 当成合法类型。
const BATTLE_ACTION_TYPES = new Set<BattleActionType>([
  'move',
  'surrender',
  'undo',
  'undoResponse',
  'draw',
  'drawResponse',
  'emoji',
]);

// 服务端返回的致命错误（重连无意义，应停止并提示/退出）
//
// ⚠️ 契约来源：服务端 `type: "error"` 帧**只有 message，没有任何错误码**
// （`chinese-chess-server/src/routes/battleWs.ts:320-351` 的握手阶段拒绝分支，
// 【I-1】原注释引的是已废弃的 dist/index.js 行号），因此这里只能按文案匹配。
// 下列每一条都对应服务端一处 `sendJson(...)` 后紧跟 `ws.close()` 的
// **握手阶段拒绝**分支——每次重连都会得到同样结果，必须停止重连。
//
// '缺少 roomId' / '缺少 playerId' 曾经漏在白名单外（症状：服务端关连接 → 客户端
// onclose → scheduleReconnect → 再次被拒 → ……形成无限重连循环，仅受 8s 退避限速）。
const FATAL_ERROR_MESSAGES = [
  '房间不存在',
  '玩家不在房间中',
  '缺少观战者标识',
  '缺少 playerId',
  '缺少 roomId',
  '对局尚未开始，暂无法观战',
  // 席位不完整（一方已离场）时服务端拒绝观战：席位只会在再次开局后恢复，
  // 在此之前的每次重连都会被同样的错误拒绝，属于重连无意义的终态
  '对局已有玩家离开，观战已结束',
  // 【S-1 / §3.1】会话凭证缺失/失效（服务端在玩家握手时校验 sessionToken）。
  // 两者都是"重连多少次都会被同样拒绝"的终态：不加入白名单会形成无限重连循环。
  '缺少会话凭证',
  '身份校验失败，请重新进入房间',
];

// 自动重连次数上限。
//
// 服务端"断线宽容"窗口只有 90s（最长 180s），而退避序列 1+2+4+8×3 ≈ 31s 就足以
// 覆盖大部分瞬时故障；无限自动重连只会在长时间离线时空转（每 8s 一轮）却无法
// 恢复 UI 的任何有效状态。上限用尽后停止自动重连并上抛 retryable 的 fatal，
// 由页面提示用户，待其回到前台/手动重试时经 resume() 重新开始。
const MAX_RECONNECT_ATTEMPTS = 6;

/**
 * 【P2】离线发送队列容量上限。
 *
 * 此前 `sendRaw()` 在 `readyState !== OPEN` 时直接丢帧，`request()` 随即抛
 * `BattleActionNotSentError`，页面回退到 HTTP POST —— 实测那是一条完整的
 * 额外往返（本机到服务端 health p50 734ms），等于断线瞬间把一次走子变成两次网络请求。
 * 这里改为：连接不可用时把帧**短暂缓存**，连上后按序补发（服务端对 reqId 幂等由上层保证，
 * 这里只保证顺序与不丢帧）。
 *
 * 上限取 10：够吸收一次断线窗口内的连发动作，又不会在长时间离线时把陈旧意图
 * 攒成一大串"复活后连环执行"。超出即丢弃最旧的，并把丢弃数暴露给调用方。
 */
const SEND_QUEUE_MAX = 10;

/**
 * 【P3】心跳周期按实测 RTT 自适应的档位边界。
 *
 * 实测客户端→服务端往返：p50 ≈ 595ms（Cloudflare 边缘）、p90 ≈ 860ms、最坏 1.7s+。
 * 而原实现固定 2s 心跳 + 服务端 `HEARTBEAT_TIMEOUT = 10000`：
 * 在这种延迟下，2s 一次心跳只是徒增往返；而真正的问题是服务端的判负阈值
 * 太贴近延迟上限，一次抖动就可能把对手误判为断线并判负（= 网络不好就"逃跑"）。
 *
 * 分档：RTT < 150ms 保持 2s（局域网/国内节点，不丢包，不需要放宽）；
 * RTT ≥ 150ms 放宽到 8s，并配合服务端 `HEARTBEAT_TIMEOUT` 同步放宽到 30s。
 */
const HEARTBEAT_RTT_TIER_MS = 150;

/**
 * 【P2】入队帧的总等待上限（毫秒）。
 *
 * 覆盖全部 6 次退避重连（1+2+4+8+8+8 = 31s）后再留 9s 余量。
 * 到点仍未补发即按"结果未知"收尾：宁可让页面回退到权威状态，也不能让按钮
 * 无限期停在"请求发出中"。
 */
const SEND_QUEUE_MAX_WAIT_MS = 40000;

/**
 * 【P5】回执超时按 RTT 标定：`RTT × 4 + 2s`，再夹在 [ACTION_ACK_TIMEOUT_MS, 上限] 之间。
 *
 * 固定 5s 的问题实测很清楚：ack 往返 p50 457ms、p90 1763ms，固定 5s 在
 * RTT≈600ms 的链路上只覆盖 8 个 RTT，一次跨洋抖动就被误报为超时，
 * 页面于是把"服务端正在裁决"当成失败并回退本地局面。
 */
const ACK_TIMEOUT_RTT_FACTOR = 4;
const ACK_TIMEOUT_BASE_MS = 2000;
const ACTION_ACK_TIMEOUT_MAX_MS = 15000;

export class BattleSocket {
  private ws: WebSocket | null = null;
  private url = '';
  private readonly roomId: string;
  private readonly identityId: string;
  private readonly role: BattleSocketRole;
  // 【S-1 / §3.1】玩家连接的会话凭证（role='spectator' 时为 null：观战者是只读连接，
  // 不参与任何状态变更，因此服务端不要求它出示 token）。
  // connect() 每轮重连都会重读，以便页面恢复后能带上刷新过的 token。
  private readonly getSessionToken: (() => string | null) | null;
  private readonly handlers: BattleSocketHandlers;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private reqCounter = 0;
  // 页面是否处于后台（浏览器/系统节流场景）：随心跳上报服务端，用于后台宽容判定
  private hidden = false;
  // 最近一次心跳成功发出的时刻：可见性未变化时据此避免重复补发
  private lastHeartbeatAt = 0;
  // 已建立过一次连接：用于区分「首次连上」与「断线恢复」
  private hasConnectedOnce = false;
  /**
   * 自动重连次数已用尽（区别于主动 close）。
   *
   * 用尽的瞬间 `closedByUser` 会被置真以停止一切后台行为，但**这次关闭不是用户意图**：
   * 页面恢复活跃时必须能重新开始重连，否则用户只能靠刷新页面自救。
   * 因此单独记录该状态，供 resume() 判断"可以重新唤醒"。
   */
  private exhausted = false;
  /**
   * 在途的 request() 请求：reqId → 收尾回调。
   *
   * 必须显式收尾而不能只等回执：连接断开时回执永远不会到，而 Promise 悬空会
   * 让页面停在「请求发出中」（例：悔棋按钮卡在「等待对方同意」）。
   * 因此 close() / 致命错误 / 超时三处都要把在途请求按失败收尾。
   */
  private readonly pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();

  // 【P1】本次建连的握手闸门：到点即视为握手失败（close → onclose → 退避重连）
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 本次 openSocket() 创建的那一个连接：只有它能触发 connectTimer 的收尾，避免误杀新连接 */
  private connecting: WebSocket | null = null;
  // 【P2】连接不可用期间的待发帧队列（按入队顺序补发）
  private sendQueue: string[] = [];
  /** 因队列溢出被丢弃的帧数：连上后据此提示，避免"动作凭空消失" */
  private droppedFrames = 0;
  // 【P3】当前心跳周期（ms）：随实测 RTT 在 [MIN, MAX] 之间取值
  private heartbeatInterval = HEARTBEAT_INTERVAL_MIN;
  // 【P3】最近一次实测 RTT（ms）：ack 往返时间的滑动平均估计
  private rttEstimate = 0;
  /** reqId → 发出时刻：ack 回来即得 RTT，并据此决定该请求的等待上限 */
  private readonly rttStartedAt = new Map<string, number>();
  /** reqId → 回执超时定时器（入队期间为 null，定时器在补发时才建） */
  private readonly pendingTimers = new Map<string, ReturnType<typeof setTimeout> | null>();
  /** reqId → 入队等待的总闸门定时器（直发时为 null） */
  private readonly pendingDeadlines = new Map<string, ReturnType<typeof setTimeout> | null>();

  constructor(
    roomId: string,
    identityId: string,
    handlers: BattleSocketHandlers,
    role: BattleSocketRole = 'player',
    // 【S-1 / §3.1】玩家角色必须提供会话凭证读取器；观战角色传 null 即可。
    getSessionToken: (() => string | null) | null = null,
  ) {
    this.roomId = roomId;
    this.identityId = identityId;
    this.role = role;
    this.getSessionToken = getSessionToken;
    this.handlers = handlers;
  }

  /** 建立连接（异步解析服务器地址后打开） */
  async connect(): Promise<void> {
    this.closedByUser = false;
    const base = await getOnlineWsUrl();
    const room = encodeURIComponent(this.roomId);
    if (this.role === 'spectator') {
      this.url = `${base}?roomId=${room}&spectatorId=${encodeURIComponent(this.identityId)}&role=spectator`;
    } else {
      // 【S-1 / §3.1】玩家连接必须带 sessionToken：服务端校验它与 URL 里的 playerId
      // 指向同一个成员，否则任何知道 roomId + playerId 的人都能建立"合法"玩家连接，
      // 复位对方的在线状态以抵消断线判负，并在消息通道里以对方身份走棋/认输/同意悔棋。
      // ⚠️ token 走 query 会被反向代理与服务器访问日志记录——这是协议层遗留形态，
      // 彻底解法是握手后首帧认证（见 §3.1 的后续建议），本轮只先堵住越权。
      const token = this.getSessionToken?.() ?? '';
      this.url =
        `${base}?roomId=${room}&playerId=${encodeURIComponent(this.identityId)}` +
        `&sessionToken=${encodeURIComponent(token)}`;
    }
    this.openSocket();
  }

  private openSocket(): void {
    if (this.closedByUser) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    // 【P1】记住"正在握手的那个连接"：只有它能在超时时被关闭，
    // 否则一次迟到的 close 会误杀下一轮已经建好的连接。
    this.connecting = ws;
    this.connectTimer = setTimeout(() => {
      if (this.connecting !== ws || ws.readyState === WS_OPEN) return;
      this.connectTimer = null;
      this.connecting = null;
      // 握手未完成即视为本轮失败：close 触发 onclose，由其统一进入退避重连
      try {
        ws.close();
      } catch {
        // 忽略
      }
    }, CONNECT_TIMEOUT);

    ws.onopen = () => {
      if (this.ws === ws) {
        this.clearConnectTimer();
        this.reconnectAttempts = 0;
        this.hasConnectedOnce = true;
        this.handlers.onStatusChange?.(true);
        this.handlers.onReconnected?.({ attempt: this.reconnectAttempts });
        this.startHeartbeat();
        // 【P2】连接可用后把离线期缓存的帧按入队顺序补发
        this.flushSendQueue();
      }
    };

    ws.onmessage = event => {
      const text = typeof event.data === 'string' ? event.data : '';
      if (!text) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      const type = msg.type;
      if (type === 'welcome' || type === 'state') {
        const data = msg.data as Record<string, unknown> | undefined;
        if (data) this.handlers.onState(data);
      } else if (type === 'ack') {
        const reqId = typeof msg.reqId === 'string' ? msg.reqId : undefined;
        // 【P3】ack 往返是唯一可靠的 RTT 采样源（服务端不回应显式 ping 帧）
        if (reqId) this.sampleRtt(reqId);
        this.handleAck({
          reqId,
          status: typeof msg.status === 'number' ? msg.status : 0,
          body: (msg.body as Record<string, unknown>) ?? {},
        });
      } else if (type === 'error') {
        const message = typeof msg.message === 'string' ? msg.message : '连接错误';
        // 房间不存在/玩家不在房间/缺少标识/无法观战等属致命错误，重连无意义
        if (FATAL_ERROR_MESSAGES.includes(message)) {
          // 服务端已关闭连接：主动收尾，避免残留半开连接持续触发重连判定
          this.fatal(message, 'session');
        } else {
          // 非致命错误帧此前被静默丢弃（「观战者无法执行该操作」「未知消息类型」等）：
          // 它们是协议级失败的唯一信号，必须上抛，否则表现为「点了没反应」
          this.handlers.onError?.(message);
        }
      }
    };

    ws.onclose = () => {
      this.clearConnectTimer();
      if (this.connecting === ws) this.connecting = null;
      this.stopHeartbeat();
      this.handlers.onStatusChange?.(false);
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // 错误后 onclose 会触发，重连统一在 onclose 处理
    };
  }

  /** 关闭握手闸门（连上或连接关闭时调用） */
  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // 定时器在后台标签页会被浏览器节流（Chrome 最长约 1 分钟一次，甚至冻结）：
      // 每次触发都补发一次心跳，让服务端看到的最近心跳时间尽快刷新，避免心跳超时被误判断线。
      this.sendHeartbeat();
    }, this.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 【P3】按 ack 往返实测 RTT 更新心跳周期。
   *
   * 用指数滑动平均（α=0.3）而不是最后一次采样：单次 RTT 抖动很大（实测 448ms～1763ms），
   * 直接采纳末值会让心跳周期跟着抖，在"放宽"与"收紧"之间来回跳。
   *
   * 只有跨过档位边界才重建定时器，避免每收到一个 ack 就重建一次 setInterval。
   */
  private sampleRtt(reqId: string): void {
    const startedAt = this.rttStartedAt.get(reqId);
    if (startedAt === undefined) return;
    const sample = Date.now() - startedAt;
    this.rttStartedAt.delete(reqId);
    this.rttEstimate = this.rttEstimate === 0 ? sample : Math.round(this.rttEstimate * 0.7 + sample * 0.3);
    const next = this.rttEstimate >= HEARTBEAT_RTT_TIER_MS ? HEARTBEAT_INTERVAL_MAX : HEARTBEAT_INTERVAL_MIN;
    if (next === this.heartbeatInterval) return;
    this.heartbeatInterval = next;
    // 已在连接的连接上即时换挡；正在重连的则由下次 onopen 的 startHeartbeat 生效
    if (this.isConnected) this.startHeartbeat();
  }

  /** 【P3】当前实测 RTT（ms），未采样过时返回 0；供页面按 RTT 标定其他时间常数 */
  get rttMs(): number {
    return this.rttEstimate;
  }

  /** 【P3】当前生效的心跳周期（ms），供页面同步超时阈值 */
  get heartbeatIntervalMs(): number {
    return this.heartbeatInterval;
  }

  /** 发送一次应用层心跳（带可见性标记）；未连接时不发送，返回是否已发出 */
  private sendHeartbeat(): boolean {
    const sent = this.sendRaw({ type: 'heartbeat', hidden: this.hidden });
    if (sent) this.lastHeartbeatAt = Date.now();
    return sent;
  }

  /**
   * 上报页面可见性并立即补发心跳。
   * - hidden=true：进入后台，趁定时器尚未被节流立刻把「我在后台」送达服务端，服务端据此宽容判定；
   * - hidden=false：回到前台，立即以「已在线」身份补发心跳，并即时重连（服务端若已进入断线等待，
   *   心跳/重连会立即撤销等待倒计时，避免回前台后仍被判负）。
   */
  setHidden(hidden: boolean): void {
    const changed = this.hidden !== hidden;
    this.hidden = hidden;
    // 可见性变化必须立即送达服务端；未变化时仅在距上次心跳已超过补发阈值时才补发，避免无谓的重复帧
    if (changed || Date.now() - this.lastHeartbeatAt >= this.heartbeatInterval * HEARTBEAT_STALE_RATIO) {
      this.sendHeartbeat();
    }
    if (!hidden && changed) this.resume();
  }

  /** 立即补发一次心跳（页面重新可见/从休眠恢复等场景由调用方触发） */
  heartbeatNow(): void {
    this.sendHeartbeat();
  }

  /**
   * 页面恢复活跃：跳过退避立即重连，并清零退避计数（后台被节流期间连接可能已被服务端回收）。
   *
   * 若此前自动重连已用尽（长时间离线），这里同时唤醒它——用户重新聚焦页面就是最明确的
   * "再试一次"信号，此时若因内部标记继续拒绝重连，用户将只能刷新页面自救。
   */
  resume(): void {
    // 用尽后的唤醒：撤销"停止一切"标记，重新开始一轮自动重连
    if (this.exhausted && this.closedByUser) {
      this.closedByUser = false;
      this.exhausted = false;
    }
    if (this.closedByUser) return;
    this.reconnectAttempts = 0;
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.sendHeartbeat();
      return;
    }
    // 已有连接正在建立：等待其 onopen 即可，避免并发创建重复连接
    if (this.ws && this.ws.readyState === WS_CONNECTING && !this.reconnectTimer) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.openSocket();
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    if (this.reconnectTimer) return;
    // 自动重连次数用尽：停止重连并上抛（kind='network'，页面只提示不切终态）。
    // 会话可能仍然有效——长时间离线时不该让页面误判为"房间已关闭"。
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.fatal('网络连接失败，请检查网络后重试', 'network');
      return;
    }
    // 指数退避：1s → 2s → 4s → 8s（封顶）
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, MAX_RECONNECT_DELAY);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  /**
   * 统一的致命错误收尾：停止一切自动行为、把在途请求按失败收尾、关闭半开连接。
   *
   * 三处调用（致命 error 帧 / 自动重连用尽 / 主动 close）都必须走这里，避免出现
   * "重连定时器还在跑"或"Promise 悬空让按钮卡在请求中"的残留。
   */
  private fatal(message: string, kind: BattleFatalKind): void {
    this.closedByUser = true;
    // 只有"重连用尽"才是可重新唤醒的：致命 error 帧代表会话已终结，唤醒也无意义
    if (kind === 'network') this.exhausted = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // 会话已终结或在途请求永远等不到回执：按失败收尾，否则页面会停在"请求发出中"
    this.rejectPending(new Error(`连接已终止：${message}`));
    this.handlers.onFatalError?.(message, kind);
    try {
      this.ws?.close();
    } catch {
      // 忽略
    }
  }

  /**
   * 发送一帧。
   *
   * 【P2】连接不可用时不再直接丢帧，而是入队等待重连后补发。返回 false 仅表示
   * "此刻没能发出去"，调用方据此决定是排队还是回退 HTTP。
   *
   * 心跳帧永不排队（`type === 'heartbeat'`）：过期的在线声明比没有更有害——
   * 断线 30s 后补发一条心跳只会让服务端把一次真实的断线又续上。
   */
  private sendRaw(obj: Record<string, unknown>): boolean {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
        return true;
      } catch {
        return false;
      }
    }
    if (obj.type !== 'heartbeat' && !this.closedByUser) this.enqueue(obj);
    return false;
  }

  /** 【P2】入队一帧待补发；队列已满时丢弃最旧的一帧并计数。返回是否入队成功 */
  private enqueue(obj: Record<string, unknown>): boolean {
    if (this.sendQueue.length >= SEND_QUEUE_MAX) {
      this.sendQueue.shift();
      this.droppedFrames += 1;
    }
    this.sendQueue.push(JSON.stringify(obj));
    return true;
  }

  /**
   * 【P2】连接建立后按入队顺序补发缓存帧。
   *
   * 补发的是**意图**而非结果：页面在断线期间已经做了乐观更新，重连后服务端会补推
   * 权威状态，落差由 useBattleStateSync 的乐观守卫按 historyLen 收敛。
   * 因此这里不需要去重或回滚——先交给服务端裁决才是诚实的做法。
   *
   * 补发的动作帧此刻才开始计等待上限（此前 armQueueDeadline 挂的是总闸门），
   * 否则退避重连耗掉的几十秒会把补发后的回执一起判超时。
   */
  private flushSendQueue(): void {
    if (this.sendQueue.length === 0) return;
    const queued = this.sendQueue;
    this.sendQueue = [];
    const dropped = this.droppedFrames;
    this.droppedFrames = 0;
    for (let i = 0; i < queued.length; i += 1) {
      const frame = queued[i];
      try {
        this.ws?.send(frame);
      } catch {
        // 补发中途再次断开：剩余帧退回队首，交给下一轮重连
        this.sendQueue.unshift(...queued.slice(i));
        break;
      }
      // 该帧对应的 request() 此前只在等总闸门，现在补上按 RTT 标定的回执超时
      const reqId = this.reqIdOf(frame);
      const waiter = reqId ? this.pending.get(reqId) : undefined;
      if (reqId && waiter) {
        this.clearRequestTimers(reqId);
        this.armAckTimer(reqId, waiter);
      }
    }
    if (dropped > 0) this.handlers.onFramesDropped?.(dropped);
  }

  /** 从已序列化的帧里取回 reqId（取不到返回 null，非动作帧不参与在途计时） */
  private reqIdOf(frame: string): string | null {
    try {
      const parsed = JSON.parse(frame) as Record<string, unknown>;
      return typeof parsed.reqId === 'string' ? parsed.reqId : null;
    } catch {
      return null;
    }
  }

  /**
   * 处理动作回执：先给在途的 request() 收尾，再统一上抛拒绝信息。
   *
   * 顺序很重要：request() 的调用方（页面）已经会针对自己发出的动作做精确回退，
   * 而 onActionRejected 是面向 send() 即发即忘动作与全局兜底的通用钩子。
   */
  private handleAck(ack: BattleAckFrame): void {
    this.handlers.onAck?.(ack);
    const waiter = ack.reqId ? this.pending.get(ack.reqId) : undefined;
    if (ack.reqId) this.clearRequestTimers(ack.reqId);
    if (ack.status < 400) {
      // 成功路径：服务端会另行广播 state，这里只需给等待者解绑并 resolve
      if (waiter && ack.reqId) this.pending.delete(ack.reqId);
      waiter?.resolve();
      return;
    }
    const message = battleAckMessage(ack.status, ack.body);
    if (waiter) {
      if (ack.reqId) this.pending.delete(ack.reqId);
      // 由 request() 的 Promise 拒绝承担提示与回退，不再重复触发 onActionRejected
      waiter.reject(new BattleActionRejectedError(this.actionOf(ack.reqId!) ?? 'move', ack.status, message));
      return;
    }
    this.handlers.onActionRejected?.({
      action: ack.reqId ? this.actionOf(ack.reqId) : null,
      status: ack.status,
      message,
      body: ack.body,
    });
  }

  /**
   * 由 reqId 反查动作类型（reqId 形如 `move-3`）。
   *
   * 反查失败返回 null：reqId 由客户端生成，理论上必然可解析；返回 null 而非抛错，
   * 是为了让一个格式异常的 reqId 不至于把整帧处理打断。
   */
  private actionOf(reqId: string): BattleActionType | null {
    const sep = reqId.lastIndexOf('-');
    if (sep <= 0) return null;
    const type = reqId.slice(0, sep) as BattleActionType;
    return BATTLE_ACTION_TYPES.has(type) ? type : null;
  }

  /**
   * 把所有在途请求按失败收尾（致命错误/自动重连用尽/主动关闭时调用）。
   *
   * **普通断连不走这里**：onclose 只停心跳并进入退避重连，在途请求继续等到
   * `ACTION_ACK_TIMEOUT_MS` 超时。理由是断连时帧可能已经送达服务端并生效
   * （重连后会补推权威状态），此时立刻 reject 会把"结果未知"谎报成"未送达"，
   * 页面据此提示重试就可能重复执行一次已经生效的着法。超时（结果未知）才是诚实的信号。
   */
  private rejectPending(error: Error): void {
    if (this.pending.size === 0) return;
    const waiters = [...this.pending.entries()];
    this.pending.clear();
    for (const [reqId, waiter] of waiters) {
      this.clearRequestTimers(reqId);
      waiter.reject(error);
    }
    this.sendQueue = [];
    this.droppedFrames = 0;
  }

  /**
   * 发送动作并等待服务端裁决（ack）。
   *
   * 【C-52】原还有一个 send(type, payload) 只发不等、返回 boolean 的薄封装，
   * 全仓无任何调用者（页面只用 request()），已删除。留着它有两个害处：
   * 它看起来仍是正常的公开 API，但它发出的 reqId 是 `req-<n>`，actionOf() 取到
   * `'req'` 不在 BATTLE_ACTION_TYPES 白名单里 → 断线重连后这个在途请求永远等不到
   * 裁决，只能等超时；而且它无法区分「服务端接受」与「服务端拒绝」。
   * 需要知道裁决结果的动作（走子/悔棋/求和/认输）一律用本方法。
   *
   * 三类失败以不同错误抛出，调用方据此决定后续动作（见 battleProtocol/index.ts）：
   * - BattleActionNotSentError：连接不可用 → 回退 HTTP；
   * - BattleActionRejectedError：服务端拒绝 → 回退本地乐观更新 + 提示，**不要**回退 HTTP；
   * - BattleActionTimeoutError：回执超时 → 同上，结果未知不能盲目重试。
   *
   * 【P2】连接不可用但连接并未被用户关闭时，帧**入队**而不是直接判失败：
   * 返回值语义因此从「此刻已发出」变为「已交付给传输层（直发或排队）」，
   * 调用方不会再回退 HTTP——否则同一次走子会既排队又发 HTTP，造成重复执行。
   * 入队期间的等待上限由 SEND_QUEUE_MAX_WAIT_MS 兜底，超时按"结果未知"抛超时错误。
   *
   * 【P5】等待上限按实测 RTT 标定：在 RTT≈600ms 的链路上固定 5s 只能覆盖 8 个 RTT，
   * 一次跨洋抖动就会把"服务端正在裁决"误报为超时。改为 max(5s, RTT×4+2s)，上限 15s。
   */
  async request(type: BattleActionType, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.reqCounter += 1;
    // reqId 前缀即动作类型（`move-3`）：handleAck 据此在无入参映射的情况下反查动作，
    // 以便把 BattleActionRejectedError 的 action 字段填对，供页面分派回退逻辑
    const reqId = `${type}-${this.reqCounter}`;
    const delivered = this.sendActionFrame({ type, reqId, ...payload });
    // 只有「用户已主动关闭」才让调用方回退 HTTP：此时排队也无从投递
    if (!delivered) throw new BattleActionNotSentError(type);

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          this.clearRequestTimers(reqId);
          resolve({});
        },
        reject: (error: Error) => {
          this.clearRequestTimers(reqId);
          reject(error);
        },
      };
      this.pending.set(reqId, waiter);
      if (delivered === 'sent') this.armAckTimer(reqId, waiter);
      // delivered === 'queued'：计时从补发那一刻才开始，否则退避重连的耗时会被算进裁决等待
      else this.armQueueDeadline(reqId, waiter);
    });
  }

  /** 直发一帧动作；不可用时入队并返回 'queued'；已关闭返回 false */
  private sendActionFrame(obj: Record<string, unknown>): 'sent' | 'queued' | false {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
        return 'sent';
      } catch {
        return this.enqueue(obj) ? 'queued' : false;
      }
    }
    if (this.closedByUser) return false;
    return this.enqueue(obj) ? 'queued' : false;
  }

  /** 【P5】按实测 RTT 计算本次请求的等待上限 */
  private ackTimeoutMs(): number {
    const scaled = this.rttEstimate * ACK_TIMEOUT_RTT_FACTOR + ACK_TIMEOUT_BASE_MS;
    return Math.min(Math.max(scaled, ACTION_ACK_TIMEOUT_MS), ACTION_ACK_TIMEOUT_MAX_MS);
  }

  /** 帧真正发出后开始计时：RTT 采样 + 回执超时 */
  private armAckTimer(reqId: string, waiter: { reject: (error: Error) => void }): void {
    this.rttStartedAt.set(reqId, Date.now());
    const timer = setTimeout(() => {
      if (!this.pending.delete(reqId)) return;
      this.rttStartedAt.delete(reqId);
      const action = this.actionOf(reqId) ?? ('move' as BattleActionType);
      waiter.reject(new BattleActionTimeoutError(action));
    }, this.ackTimeoutMs());
    this.pendingTimers.set(reqId, timer);
    this.pendingDeadlines.set(reqId, null);
  }

  /** 【P2】入队期间的总闸门：退避重连全部失败时按"结果未知"收尾，而不是无限等待 */
  private armQueueDeadline(reqId: string, waiter: { reject: (error: Error) => void }): void {
    this.pendingTimers.set(reqId, null);
    const deadline = setTimeout(() => {
      if (!this.pending.delete(reqId)) return;
      this.pendingDeadlines.delete(reqId);
      const action = this.actionOf(reqId) ?? ('move' as BattleActionType);
      waiter.reject(new BattleActionTimeoutError(action));
    }, SEND_QUEUE_MAX_WAIT_MS);
    this.pendingDeadlines.set(reqId, deadline);
  }

  /** 取消某个在途请求的全部定时器（ack 到达、致命收尾、队列丢弃时调用） */
  private clearRequestTimers(reqId: string): void {
    const timer = this.pendingTimers.get(reqId);
    if (timer) clearTimeout(timer);
    this.pendingTimers.delete(reqId);
    const deadline = this.pendingDeadlines.get(reqId);
    if (deadline) clearTimeout(deadline);
    this.pendingDeadlines.delete(reqId);
    this.rttStartedAt.delete(reqId);
  }

  /** 当前是否已连接 */
  get isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WS_OPEN;
  }

  /** 主动关闭（退出对局时调用），停止重连与心跳 */
  close(): void {
    this.closedByUser = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // 在途请求不会再有回执：按失败收尾，避免页面停在「请求发出中」
    this.rejectPending(new Error('连接已关闭'));
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // 忽略
      }
      this.ws = null;
    }
    this.handlers.onStatusChange?.(false);
  }
}
