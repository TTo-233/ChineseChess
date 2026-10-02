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

/**
 * 动作请求与回执的契约（第 3 批补测）。
 *
 * 抽出这一组的原因是第 3 批把失败 body 统一成
 * `{ success:false, error:<机器码>, message:<文案> }`：`error` 从"可能是人读的文案"
 * 变成机器码之后，客户端展示路径**只能读 message**。如果哪条路径又去读 error，
 * 用户看到的就是 `not_found` 这种裸机器码，而不是中文提示——这类回归肉眼很难发现，
 * 因为服务端确实返回了"一个错误字段"。
 */
describe('BattleSocket 请求与回执', () => {
  /** 发一个动作，返回它发出的帧 */
  function sendAction(ws: FakeWebSocket, type: string, payload: Record<string, unknown> = {}) {
    const before = ws.frames().length;
    ws.send(JSON.stringify({ type, reqId: `${type}-1`, ...payload }));
    return ws.frames()[before];
  }

  it('request 发出带 reqId 的帧（reqId 前缀即动作类型）', async () => {
    const { socket, ws } = await connectSocket();
    opened = socket;
    void socket.request('undo', { proposedState: {} }).catch(() => undefined);
    expect(ws.frames().some(f => f.type === 'undo' && f.reqId === 'undo-1')).toBe(true);
  });

  it('ack 2xx 走 onAck，且不触发 onActionRejected', async () => {
    const onAck = jest.fn();
    const onActionRejected = jest.fn();
    const { socket, ws } = await connectSocket({ onAck, onActionRejected });
    opened = socket;
    ws.emit({ type: 'ack', reqId: 'unknown-9', status: 200, body: { success: true } });
    expect(onAck).toHaveBeenCalledWith({ reqId: 'unknown-9', status: 200, body: { success: true } });
    expect(onActionRejected).not.toHaveBeenCalled();
  });

  it('ack 4xx 且 reqId 匹配在途请求 → 走 Promise 拒绝，不再重复触发 onActionRejected', async () => {
    const onActionRejected = jest.fn();
    const { socket, ws } = await connectSocket({ onActionRejected });
    opened = socket;
    const promise = socket.request('undo', { proposedState: {} }).catch((e: Error) => e);
    sendAction(ws, 'undo'); // 让 reqId 计数对齐到 undo-1
    ws.emit({
      type: 'ack',
      reqId: 'undo-1',
      status: 400,
      body: { success: false, error: 'bad_request', message: '当前局面不允许悔棋' },
    });
    const err = await promise;
    expect((err as Error).message).toBe('当前局面不允许悔棋');
    expect(onActionRejected).not.toHaveBeenCalled();
  });

  it('ack 4xx 且 reqId 匹配在途请求 → 动作类型与状态码被填进错误（页面据此精确回退）', async () => {
    const { socket, ws } = await connectSocket();
    opened = socket;
    const promise = socket.request('move', { move: { pieceId: 1, toCol: 2, toRow: 3 } }).catch(
      (e: Error) => e
    );
    ws.emit({
      type: 'ack',
      reqId: 'move-1',
      status: 400,
      body: { success: false, error: 'bad_request', message: '着法非法' },
    });
    const err = await promise;
    expect(err).toMatchObject({ name: 'BattleActionRejectedError', action: 'move', status: 400 });
  });

  it('ack 4xx 且无匹配在途请求（即发即忘动作）→ 走 onActionRejected 兜底', async () => {
    const onActionRejected = jest.fn();
    const { socket, ws } = await connectSocket({ onActionRejected });
    opened = socket;
    ws.emit({
      type: 'ack',
      reqId: 'emoji-7',
      status: 429,
      body: { success: false, error: 'rate_limited', message: '操作过于频繁，请稍后重试' },
    });
    expect(onActionRejected).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'emoji',
        status: 429,
        message: '操作过于频繁，请稍后重试',
      })
    );
  });

  it('ack 4xx 无 reqId → 动作为 null，页面按通用失败处理', async () => {
    const onActionRejected = jest.fn();
    const { socket, ws } = await connectSocket({ onActionRejected });
    opened = socket;
    ws.emit({ type: 'ack', status: 400, body: { success: false, message: '请求被拒绝' } });
    expect(onActionRejected).toHaveBeenCalledWith(
      expect.objectContaining({ action: null, status: 400, message: '请求被拒绝' })
    );
  });

  describe('失败文案提取只读 message（第 3 批统一形状后的回归防线）', () => {
    it.each([
      [400, '着法非法'],
      [403, '你没有权限执行该操作'],
      [404, '房间已不存在'],
      [429, '操作过于频繁，请稍后重试'],
      [500, '服务端故障，请稍后重试'],
    ])('优先展示服务端 message 而非机器码（status=%s）', async (status, message) => {
      const onActionRejected = jest.fn();
      const { socket, ws } = await connectSocket({ onActionRejected });
      opened = socket;
      ws.emit({
        type: 'ack',
        reqId: 'emoji-1',
        status,
        body: { success: false, error: 'some_machine_code', message },
      });
      expect(onActionRejected.mock.calls[0][0].message).toBe(message);
    });

    it('message 缺失时按状态码回退到通用文案', async () => {
      const onActionRejected = jest.fn();
      const { socket, ws } = await connectSocket({ onActionRejected });
      opened = socket;
      ws.emit({ type: 'ack', reqId: 'emoji-1', status: 404, body: { success: false, error: 'not_found' } });
      expect(onActionRejected.mock.calls[0][0].message).toBe('房间已不存在');
    });

    it('message 为空串或纯空白时同样回退（不把空白展示给用户）', async () => {
      const onActionRejected = jest.fn();
      const { socket, ws } = await connectSocket({ onActionRejected });
      opened = socket;
      ws.emit({ type: 'ack', reqId: 'emoji-1', status: 400, body: { message: '   ' } });
      expect(onActionRejected.mock.calls[0][0].message).toBe('操作被服务端拒绝');
    });

    it('error 字段是机器码时绝不当作文案展示（裸 not_found 不能漏到界面）', async () => {
      const onActionRejected = jest.fn();
      const { socket, ws } = await connectSocket({ onActionRejected });
      opened = socket;
      ws.emit({
        type: 'ack',
        reqId: 'emoji-1',
        status: 404,
        body: { success: false, error: 'not_found' },
      });
      const shown = onActionRejected.mock.calls[0][0].message as string;
      expect(shown).toBe('房间已不存在');
      expect(shown).not.toBe('not_found');
    });
  });

  describe('非致命 error 帧', () => {
    it('「观战者无法执行该操作」不上抛致命，只走 onError（否则观战会被踢下线）', async () => {
      const onFatalError = jest.fn();
      const onError = jest.fn();
      const { socket, ws } = await connectSocket({ onFatalError, onError }, 'spectator');
      opened = socket;
      ws.emit({
        type: 'error',
        reqId: 'move-1',
        success: false,
        error: 'forbidden',
        message: '观战者无法执行该操作',
      });
      expect(onFatalError).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith('观战者无法执行该操作');
    });

    it('「未知消息类型」同样只走 onError', async () => {
      const onFatalError = jest.fn();
      const onError = jest.fn();
      const { socket, ws } = await connectSocket({ onFatalError, onError });
      opened = socket;
      ws.emit({
        type: 'error',
        reqId: 'x-1',
        success: false,
        error: 'bad_request',
        message: '未知消息类型',
      });
      expect(onFatalError).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith('未知消息类型');
    });

    it('error 帧缺 message 时用兜底文案，不返回 undefined', async () => {
      const onError = jest.fn();
      const { socket, ws } = await connectSocket({ onError });
      opened = socket;
      ws.emit({ type: 'error' });
      expect(onError).toHaveBeenCalledWith('连接错误');
    });
  });

  describe('帧的健壮性', () => {
    it('非法 JSON 被丢弃，不影响后续正常帧', async () => {
      const onState = jest.fn();
      const { socket, ws } = await connectSocket({ onState });
      opened = socket;
      ws.onmessage?.({ data: '{not json' });
      ws.emit({ type: 'state', data: { phase: 'playing' } });
      expect(onState).toHaveBeenCalledWith({ phase: 'playing' });
    });

    it('空 data 被丢弃', async () => {
      const onState = jest.fn();
      const { socket, ws } = await connectSocket({ onState });
      opened = socket;
      ws.onmessage?.({ data: '' });
      expect(onState).not.toHaveBeenCalled();
    });

    it('ack 缺 body 时按空对象处理，不抛错', async () => {
      const onAck = jest.fn();
      const { socket, ws } = await connectSocket({ onAck });
      opened = socket;
      ws.emit({ type: 'ack', status: 400 });
      expect(onAck).toHaveBeenCalledWith({ reqId: undefined, status: 400, body: {} });
    });

    it('ack 的 status 类型异常时归一为 0（视为非 4xx，不误报拒绝）', async () => {
      const onAck = jest.fn();
      const onActionRejected = jest.fn();
      const { socket, ws } = await connectSocket({ onAck, onActionRejected });
      opened = socket;
      ws.emit({ type: 'ack', status: 'nope', body: {} });
      expect(onAck).toHaveBeenCalledWith({ reqId: undefined, status: 0, body: {} });
      expect(onActionRejected).not.toHaveBeenCalled();
    });

    it('普通断连不立刻拒绝在途请求，而是等回执超时（断连时动作可能已生效，不能谎报未送达）', async () => {
      const { socket, ws } = await connectSocket();
      opened = socket;
      const promise = socket.request('draw').catch((e: Error) => e);
      ws.close();
      jest.advanceTimersByTime(1000);
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(5000);
      const err = await promise;
      expect(err).toMatchObject({ name: 'BattleActionTimeoutError', action: 'draw' });
    });

    it('主动 close 时在途请求被立即按失败收尾（用户已退出，不再等待）', async () => {
      const { socket } = await connectSocket();
      opened = socket;
      const promise = socket.request('draw').catch((e: Error) => e);
      socket.close();
      const err = await promise;
      expect((err as Error).message).toBe('连接已关闭');
    });

    it('未连接时 request 抛 BattleActionNotSentError（页面据此回退 HTTP）', async () => {
      const { socket } = await connectSocket();
      opened = socket;
      socket.close();
      await expect(socket.request('draw')).rejects.toMatchObject({
        name: 'BattleActionNotSentError',
      });
    });

    it('请求超过回执超时窗口 → BattleActionTimeoutError（结果未知不能盲目重试）', async () => {
      const { socket } = await connectSocket();
      opened = socket;
      const promise = socket.request('surrender').catch((e: Error) => e);
      jest.advanceTimersByTime(10000);
      const err = await promise;
      expect(err).toMatchObject({ name: 'BattleActionTimeoutError', action: 'surrender' });
    });
  });

  describe('连接查询', () => {
    it('isConnected 随 open/close 变化', async () => {
      const { socket, ws } = await connectSocket();
      opened = socket;
      expect(socket.isConnected).toBe(true);
      socket.close();
      expect(socket.isConnected).toBe(false);
      expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    });

    it('close 之后再 setHidden 不会重连（用户主动退出）', async () => {
      const { socket } = await connectSocket();
      socket.close();
      socket.setHidden(true);
      socket.setHidden(false);
      jest.advanceTimersByTime(60000);
      expect(FakeWebSocket.instances).toHaveLength(1);
    });
  });
});
