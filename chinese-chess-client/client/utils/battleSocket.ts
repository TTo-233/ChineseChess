import { getOnlineWsUrl } from '@/utils/serverConfig';

/**
 * 在线对局 WebSocket 客户端封装
 *
 * 能力：
 * - 自动连接与指数退避重连（断线重连）
 * - 应用层心跳（每 2s 发送 { type: 'heartbeat', hidden }），驱动服务端逻辑断线检测
 * - 可见性感知：后台标签页会被浏览器节流（定时器最长约 1 分钟一次甚至冻结），
 *   进入后台立即上报 hidden=true 让服务端宽容判定，回到前台立即补发心跳并即时重连，
 *   消除「切后台被误判断线」与「回前台后仍处于断线判定」两个缺口
 * - 统一分发服务端推送（welcome/state）与动作回执（ack）
 * - send() 返回是否成功发出，失败时由调用方走 HTTP 兜底
 *
 * 依赖 React Native / Web 内置 WebSocket（无需第三方库）。
 */

// WebSocket readyState 常量（兼容 RN 与 Web，避免依赖静态属性差异）
const WS_CONNECTING = 0;
const WS_OPEN = 1;

export interface BattleSocketHandlers {
  /** 收到服务端状态推送（welcome / state），data 为 buildGameStatePayload 结构 */
  onState: (data: Record<string, unknown>) => void;
  /** 收到动作回执 */
  onAck?: (msg: { reqId?: string; status: number; body: Record<string, unknown> }) => void;
  /** 连接状态变化（true=已连接，false=断开/重连中） */
  onStatusChange?: (connected: boolean) => void;
  /** 收到致命错误（房间不存在/玩家不在房间），调用方应停止重连并退出 */
  onFatalError?: (message: string) => void;
}

const HEARTBEAT_INTERVAL = 2000;
const MAX_RECONNECT_DELAY = 8000;
// 心跳补发阈值：定时器被节流（后台标签页）或页面从休眠恢复后，间隔明显超过该值时立即补发一次
const HEARTBEAT_STALE_MS = HEARTBEAT_INTERVAL + 500;

// 连接角色：对局玩家（可执行动作）或观战者（只读，仅接收状态推送）
export type BattleSocketRole = 'player' | 'spectator';

// 服务端返回的致命错误（重连无意义，应停止并提示/退出）
const FATAL_ERROR_MESSAGES = [
  '房间不存在',
  '玩家不在房间中',
  '缺少观战者标识',
  '对局尚未开始，暂无法观战',
];

export class BattleSocket {
  private ws: WebSocket | null = null;
  private url = '';
  private readonly roomId: string;
  private readonly identityId: string;
  private readonly role: BattleSocketRole;
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

  constructor(roomId: string, identityId: string, handlers: BattleSocketHandlers, role: BattleSocketRole = 'player') {
    this.roomId = roomId;
    this.identityId = identityId;
    this.role = role;
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
      this.url = `${base}?roomId=${room}&playerId=${encodeURIComponent(this.identityId)}`;
    }
    this.openSocket();
  }

  private openSocket(): void {
    if (this.closedByUser) return;
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.handlers.onStatusChange?.(true);
      this.startHeartbeat();
    };

    this.ws.onmessage = event => {
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
        this.handlers.onAck?.({
          reqId: msg.reqId as string | undefined,
          status: (msg.status as number) ?? 0,
          body: (msg.body as Record<string, unknown>) ?? {},
        });
      } else if (type === 'error') {
        const message = typeof msg.message === 'string' ? msg.message : '连接错误';
        // 房间不存在/玩家不在房间/无法观战等属致命错误，重连无意义
        if (FATAL_ERROR_MESSAGES.includes(message)) {
          this.closedByUser = true;
          this.stopHeartbeat();
          this.handlers.onFatalError?.(message);
          // 服务端已关闭连接：主动收尾，避免残留半开连接持续触发重连判定
          try {
            this.ws?.close();
          } catch {
            // 忽略
          }
        }
      }
    };

    this.ws.onclose = () => {
      this.stopHeartbeat();
      this.handlers.onStatusChange?.(false);
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // 错误后 onclose 会触发，重连统一在 onclose 处理
    };
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // 定时器在后台标签页会被浏览器节流（Chrome 最长约 1 分钟一次，甚至冻结）：
      // 每次触发都补发一次心跳，让服务端看到的最近心跳时间尽快刷新，避免 10s 心跳超时被误判断线。
      this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
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
    if (changed || Date.now() - this.lastHeartbeatAt >= HEARTBEAT_STALE_MS) this.sendHeartbeat();
    if (!hidden && changed) this.resume();
  }

  /** 立即补发一次心跳（页面重新可见/从休眠恢复等场景由调用方触发） */
  heartbeatNow(): void {
    this.sendHeartbeat();
  }

  /** 页面恢复活跃：跳过退避立即重连，并清零退避计数（后台被节流期间连接可能已被服务端回收） */
  resume(): void {
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
    // 指数退避：1s → 2s → 4s → 8s（封顶）
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, MAX_RECONNECT_DELAY);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private sendRaw(obj: Record<string, unknown>): boolean {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /** 发送对局动作；返回是否成功发出（false 时调用方应走 HTTP 兜底） */
  send(type: string, payload: Record<string, unknown> = {}): boolean {
    this.reqCounter += 1;
    return this.sendRaw({ type, reqId: `req-${this.reqCounter}`, ...payload });
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
