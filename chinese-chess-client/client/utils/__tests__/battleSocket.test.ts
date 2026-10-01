/**
 * 在线对局 WebSocket 客户端：心跳与可见性契约测试
 *
 * 对应「联机冒烟：后台 tab 心跳被浏览器节流误判断线」的客户端侧保证：
 * - 心跳始终携带 hidden 标记（服务端据此对后台标签页宽容判定）
 * - 可见性变化立即补发心跳，不等可能已被节流的定时器
 * - 回到前台立即重连，不等指数退避
 * - 房间不存在等致命错误必须回调 onFatalError（对局页据此切终态并刷新 UI）
 */
import { BattleSocket } from '../battleSocket';

jest.mock('@/utils/serverConfig', () => ({
  getOnlineWsUrl: jest.fn(async () => 'ws://test.local/api/v1/lan/ws'),
}));

interface HeartbeatFrame {
  type: string;
  hidden?: boolean;
}

/** 最小 WebSocket 替身：记录已发送帧，并可手动触发 open/message/close */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  // ---- 测试辅助 ----
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emit(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map(raw => JSON.parse(raw) as Record<string, unknown>);
  }

  heartbeats(): HeartbeatFrame[] {
    return this.frames().filter(f => f.type === 'heartbeat') as unknown as HeartbeatFrame[];
  }
}

/** 建立连接并返回「已打开」的替身连接 */
async function connectSocket(
  handlers: Partial<ConstructorParameters<typeof BattleSocket>[2]> = {},
  role: ConstructorParameters<typeof BattleSocket>[3] = 'player',
) {
  const socket = new BattleSocket(
    'room-1',
    role === 'spectator' ? 'spectator-1' : 'player-1',
    {
      onState: () => undefined,
      ...handlers,
    },
    role,
  );
  await socket.connect();
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.open();
  return { socket, ws };
}

let opened: BattleSocket | null = null;

beforeEach(() => {
  FakeWebSocket.instances = [];
  (global as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  jest.useFakeTimers();
});

afterEach(() => {
  opened?.close();
  opened = null;
  jest.useRealTimers();
});

describe('BattleSocket 心跳与可见性', () => {
  it('连接建立后立即发送一次带 hidden 标记的心跳', async () => {
    const { socket, ws } = await connectSocket();
    opened = socket;
    expect(ws.heartbeats()).toHaveLength(1);
    expect(ws.heartbeats()[0]).toEqual({ type: 'heartbeat', hidden: false });
  });

  it('心跳按 2s 周期持续发送（前台）', async () => {
    const { socket, ws } = await connectSocket();
    opened = socket;
    jest.advanceTimersByTime(2000);
    jest.advanceTimersByTime(2000);
    expect(ws.heartbeats()).toHaveLength(3);
    expect(ws.heartbeats().every(h => h.hidden === false)).toBe(true);
  });

  it('进入后台立即上报 hidden=true（不等被节流的定时器）', async () => {
    const { socket, ws } = await connectSocket();
    opened = socket;
    const before = ws.heartbeats().length;
    socket.setHidden(true);
    expect(ws.heartbeats()).toHaveLength(before + 1);
    expect(ws.heartbeats()[ws.heartbeats().length - 1]).toEqual({ type: 'heartbeat', hidden: true });
  });

  it('回到前台立即补发 hidden=false 心跳（清除服务端后台标记）', async () => {
    const { socket, ws } = await connectSocket();
    opened = socket;
    socket.setHidden(true);
    socket.setHidden(false);
    expect(ws.heartbeats()[ws.heartbeats().length - 1]).toEqual({ type: 'heartbeat', hidden: false });
  });

  it('回到前台时连接已断开 → 立即重连，不等待退避', async () => {
    const { socket, ws } = await connectSocket();
    opened = socket;
    socket.setHidden(true); // 先进入后台
    ws.close(); // 后台期间连接被服务端回收：进入退避等待
    expect(FakeWebSocket.instances).toHaveLength(1);
    socket.setHidden(false); // 回到前台
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('heartbeatNow 可即时补发心跳', async () => {
    const { socket, ws } = await connectSocket();
    opened = socket;
    const before = ws.heartbeats().length;
    socket.heartbeatNow();
    expect(ws.heartbeats()).toHaveLength(before + 1);
  });

  it('收到「房间不存在」致命错误 → 回调 onFatalError 并停止重连', async () => {
    const onFatalError = jest.fn();
    const { socket, ws } = await connectSocket({ onFatalError });
    opened = socket;
    ws.emit({ type: 'error', message: '房间不存在' });
    // 第二个参数是性质：'session' = 会话已终结（页面切终态）；'network' = 仅连接失败（页面不切终态）
    expect(onFatalError).toHaveBeenCalledWith('房间不存在', 'session');
    ws.close();
    jest.advanceTimersByTime(30000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('收到「玩家不在房间中」致命错误同样回调（对局页据此切终态 UI）', async () => {
    const onFatalError = jest.fn();
    const { socket, ws } = await connectSocket({ onFatalError });
    opened = socket;
    ws.emit({ type: 'error', message: '玩家不在房间中' });
    expect(onFatalError).toHaveBeenCalledWith('玩家不在房间中', 'session');
  });

  it('收到「对局已有玩家离开」致命错误 → 停止重连（观战不会陷入无限重连）', async () => {
    const onFatalError = jest.fn();
    const { socket, ws } = await connectSocket({ onFatalError }, 'spectator');
    opened = socket;
    ws.emit({ type: 'error', message: '对局已有玩家离开，观战已结束' });
    expect(onFatalError).toHaveBeenCalledWith('对局已有玩家离开，观战已结束', 'session');
    ws.close();
    jest.advanceTimersByTime(30000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  // 握手阶段的两条拒绝此前漏在致命白名单外：服务端 sendJson 后立即 ws.close()，
  // 客户端于是走 onclose → scheduleReconnect → 再次被拒，形成无限重连循环。
  it.each(['缺少 playerId', '缺少 roomId'])('握手阶段拒绝「%s」→ 视为致命，不再重连', async message => {
    const onFatalError = jest.fn();
    const { socket, ws } = await connectSocket({ onFatalError });
    opened = socket;
    ws.emit({ type: 'error', message });
    expect(onFatalError).toHaveBeenCalledWith(message, 'session');
    ws.close();
    jest.advanceTimersByTime(30000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('自动重连用尽 → 以 kind=network 上抛，且停止自动重连（页面据此只提示不切终态）', async () => {
    const onFatalError = jest.fn();
    const { socket, ws: first } = await connectSocket({ onFatalError });
    opened = socket;
    let ws = first;
    // 每次退避都失败：新建的连接从不 open，因此重连计数不会清零
    for (let i = 0; i < 8; i += 1) {
      ws.close();
      jest.advanceTimersByTime(8000);
      ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    }
    expect(onFatalError).toHaveBeenCalled();
    const last = onFatalError.mock.calls[onFatalError.mock.calls.length - 1] as [string, string];
    expect(last[1]).toBe('network');
    expect(last[0]).toContain('网络');
    // 用尽后停止自动重连：再等下去也不会创建新连接
    const settled = FakeWebSocket.instances.length;
    jest.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances).toHaveLength(settled);
  });

  it('重连用尽后回到前台（setHidden(false)）可重新开始自动重连', async () => {
    const onFatalError = jest.fn();
    const { socket, ws: first } = await connectSocket({ onFatalError });
    opened = socket;
    let ws = first;
    for (let i = 0; i < 8; i += 1) {
      ws.close();
      jest.advanceTimersByTime(8000);
      ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    }
    const exhausted = FakeWebSocket.instances.length;
    socket.setHidden(true);
    socket.setHidden(false); // 回到前台 → resume() 清零退避计数并立即重连
    expect(FakeWebSocket.instances.length).toBe(exhausted + 1);
  });

  it('welcome/state 推送经 onState 分发（状态刷新通道正常）', async () => {
    const onState = jest.fn();
    const { socket, ws } = await connectSocket({ onState });
    opened = socket;
    ws.emit({ type: 'welcome', data: { phase: 'playing' } });
    expect(onState).toHaveBeenCalledWith({ phase: 'playing' });
  });
});
