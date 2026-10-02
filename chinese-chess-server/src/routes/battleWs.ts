import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import {
  rooms,
  buildGameStatePayload,
  registerRoomBroadcaster,
  pruneSpectators,
  actReady,
  actSide,
  actStart,
  actMove,
  actSurrender,
  actRematch,
  actUndo,
  actUndoResponse,
  actDraw,
  actDrawResponse,
  actEmoji,
  actHeartbeat,
  registerSocketLivenessProbe,
  isHiddenTolerated,
  hasCompleteSeating,
  HIDDEN_SOCKET_IDLE_TIMEOUT,
} from './lanGame';
import type { Room, ActionResult } from './lanGame';

/**
 * 在线对局 WebSocket 通道
 *
 * 设计要点：
 * 1. 连接池：roomId -> Set<WebSocket>，每个连接附带 roomId/playerId/isAlive 元数据。
 * 2. 心跳（防假死）：
 *    - 应用层：客户端每 2s 发送 { type: 'heartbeat' }，服务端刷新 lastHeartbeat；
 *      lanGame 的 gameTickTimer 依据 HEARTBEAT_TIMEOUT 判定逻辑断线、DISCONNECT_TIMEOUT 判负。
 *    - 传输层：服务端每 PING_INTERVAL 主动 ping，未回 pong 的连接判定为假死并 terminate。
 * 3. 断线重连：客户端重连后重新建立 WS，服务端在 connection 时恢复 connected 并清除断线状态。
 */

// 服务端主动 ping 的间隔（传输层探活）
const PING_INTERVAL = 15000;
// 连接空闲超时：超过该时长未收到任何客户端消息（应用层心跳或 pong）即判定假死并终止。
// 客户端每 2s 发送一次应用层心跳，30s 容忍约 15 次丢失，足够宽松且能及时发现假死。
const SOCKET_IDLE_TIMEOUT = 30000;

// 连接角色：对局玩家（可执行动作）或观战者（只读，仅接收状态广播）
type SocketRole = 'player' | 'spectator';

interface BattleSocketMeta {
  roomId: string;
  role: SocketRole;
  // 玩家身份（role === 'player' 时存在）
  playerId?: string;
  // 观战者身份（role === 'spectator' 时存在）
  spectatorId?: string;
  // 最近一次收到客户端消息（心跳/动作/pong）的时间，用于假死判定
  lastActivity: number;
  // 最近一次心跳上报的页面可见性：后台标签页的连接放宽空闲上限
  hidden?: boolean;
}

// 连接池：房间 -> 该房间内所有活跃的 WebSocket 连接
const roomSockets = new Map<string, Set<WebSocket>>();
// 连接元数据（弱引用，连接被回收时自动清理）
const socketMeta = new WeakMap<WebSocket, BattleSocketMeta>();

function sendJson(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
    } catch {
      // 忽略发送失败（连接可能正在关闭）
    }
  }
}

// 向房间内所有活跃连接广播最新对局状态
function broadcastRoom(room: Room): void {
  const socks = roomSockets.get(room.id);
  if (!socks || socks.size === 0) return;
  const message = JSON.stringify({ type: 'state', data: buildGameStatePayload(room) });
  for (const ws of socks) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(message);
      } catch {
        // 忽略单个连接发送失败
      }
    }
  }
}

// 注册到 lanGame：HTTP 动作成功或服务端 tick 引发状态变化时，同样通过 WS 广播
registerRoomBroadcaster(broadcastRoom);

// 注册连接存活探针：lanGame 等待阶段清扫「人不在房间页面」的残留成员时，
// 以此判断玩家是否仍有活跃连接（有活跃连接的成员绝不清扫）
registerSocketLivenessProbe((roomId: string, playerId: string) => {
  const socks = roomSockets.get(roomId);
  if (!socks) return false;
  for (const ws of socks) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const meta = socketMeta.get(ws);
    if (meta && meta.playerId === playerId) return true;
  }
  return false;
});

// 刷新玩家的 WS 存活时间戳（连接建立/收到消息/pong 时调用）：
// 作为等待阶段成员清扫的活跃度依据（等待阶段无对局心跳，WS 活动是唯一在线证明）
function touchPlayerWs(roomId: string, playerId: string | undefined): void {
  if (!playerId) return;
  const room = rooms.get(roomId);
  const player = room?.players.find(p => p.id === playerId);
  if (player) player.lastWsAt = Date.now();
}

// 判断某玩家在房间内是否仍有其他活跃连接（用于重连抖动时避免误判断线）
function playerHasActiveSocket(roomId: string, playerId: string, exclude: WebSocket): boolean {
  const socks = roomSockets.get(roomId);
  if (!socks) return false;
  for (const ws of socks) {
    if (ws === exclude) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;
    const meta = socketMeta.get(ws);
    if (meta && meta.playerId === playerId) return true;
  }
  return false;
}

// 判断某观战者在房间内是否仍有其他活跃连接（用于重连抖动时避免误移除）
function spectatorHasActiveSocket(roomId: string, spectatorId: string, exclude: WebSocket): boolean {
  const socks = roomSockets.get(roomId);
  if (!socks) return false;
  for (const ws of socks) {
    if (ws === exclude) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;
    const meta = socketMeta.get(ws);
    if (meta && meta.role === 'spectator' && meta.spectatorId === spectatorId) return true;
  }
  return false;
}

// 连接关闭/终止时的清理：移出连接池；玩家走断线判定，观战者从观众列表移除
function handleDisconnect(ws: WebSocket): void {
  const meta = socketMeta.get(ws);
  if (!meta) return;
  const { roomId, role, playerId, spectatorId } = meta;

  const socks = roomSockets.get(roomId);
  if (socks) {
    socks.delete(ws);
    if (socks.size === 0) roomSockets.delete(roomId);
  }
  socketMeta.delete(ws);

  const room = rooms.get(roomId);
  if (!room) return;

  // 观战者：从观众列表移除并广播人数变化（重连抖动时若仍有活跃连接则跳过）
  if (role === 'spectator') {
    if (!spectatorId) return;
    if (spectatorHasActiveSocket(roomId, spectatorId, ws)) return;
    const before = room.spectators.length;
    room.spectators = room.spectators.filter(s => s.id !== spectatorId);
    if (room.spectators.length !== before) {
      room.lastActivity = Date.now();
      broadcastRoom(room); // 观众离场，实时同步人数
    }
    return;
  }

  // 玩家：该玩家仍有其他活跃连接（如重连抖动）则不标记断线
  if (!playerId) return;
  if (playerHasActiveSocket(roomId, playerId, ws)) return;

  const player = room.players.find(p => p.id === playerId);
  if (player && player.connected) {
    // 后台标签页的连接被节流/回收不代表玩家离开：保护窗口内不标记断线、不启动判负倒计时，
    // 连接会在客户端回到前台时自愈（重连 + 显式 reconnect），保护窗口结束后仍按常规判负
    if (isHiddenTolerated(player, Date.now())) return;
    player.connected = false;
    // 对局中才启动断线判负计时
    if (room.phase === 'playing' && room.disconnectedPlayerId !== playerId) {
      room.disconnectedPlayerId = playerId;
      room.disconnectTime = Date.now();
    }
    room.lastActivity = Date.now();
    broadcastRoom(room); // 立即通知对方连接状态变化
  }
}

// 处理客户端消息：心跳刷新或对局动作分发
function handleMessage(ws: WebSocket, raw: unknown): void {
  const meta = socketMeta.get(ws);
  if (!meta) return;
  // 收到任何客户端消息即视为活跃（假死判定依据）
  meta.lastActivity = Date.now();
  const { roomId, role, playerId, spectatorId } = meta;
  touchPlayerWs(roomId, playerId);
  const room = rooms.get(roomId);
  if (!room) return;

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }

  const type = typeof msg.type === 'string' ? msg.type : '';
  const reqId = msg.reqId;

  // 应用层心跳：玩家刷新 lastHeartbeat（驱动逻辑断线检测）；观战者刷新 lastSeen 保持在观众计数中。高频不广播
  if (type === 'heartbeat') {
    // 记录本条连接的可见性：后台标签页的连接不应被 30s 空闲清扫提前回收
    if (typeof msg.hidden === 'boolean') meta.hidden = msg.hidden;
    if (role === 'spectator') {
      if (spectatorId) {
        pruneSpectators(room);
        const existing = room.spectators.find(s => s.id === spectatorId);
        if (existing) existing.lastSeen = Date.now();
      }
    } else {
      actHeartbeat(roomId, { playerId, hidden: typeof msg.hidden === 'boolean' ? msg.hidden : undefined });
    }
    return;
  }

  // 观战者为只读连接：不允许执行任何对局动作
  if (role === 'spectator') {
    sendJson(ws, { type: 'error', reqId, message: '观战者无法执行该操作' });
    return;
  }

  // 对局动作分发：playerId 一律取连接认证时的身份，防止消息体冒充
  let result: ActionResult | null = null;
  switch (type) {
    case 'ready':
      result = actReady(roomId, { playerId, ready: msg.ready });
      break;
    case 'side':
      result = actSide(roomId, { playerId, side: msg.side });
      break;
    case 'start':
      result = actStart(roomId, { playerId });
      break;
    case 'move':
      // 新协议（发着法，服务端权威裁决）与旧协议（完整状态，初始局面上传）双兼
      result = actMove(roomId, {
        playerId,
        move: msg.move,
        gameState: msg.gameState,
        gameOver: msg.gameOver,
        winner: msg.winner,
      });
      break;
    case 'surrender':
      result = actSurrender(roomId, { playerId });
      break;
    case 'rematch':
      result = actRematch(roomId, { playerId });
      break;
    case 'undo':
      result = actUndo(roomId, { playerId, proposedState: msg.proposedState });
      break;
    case 'undoResponse':
      result = actUndoResponse(roomId, { playerId, agreed: msg.agreed });
      break;
    case 'draw':
      result = actDraw(roomId, { playerId });
      break;
    case 'drawResponse':
      result = actDrawResponse(roomId, { playerId, agreed: msg.agreed });
      break;
    case 'emoji':
      result = actEmoji(roomId, { playerId, emoji: msg.emoji, id: msg.id });
      break;
    default:
      sendJson(ws, { type: 'error', reqId, message: '未知消息类型' });
      return;
  }

  if (result.status < 400) {
    // 动作成功：实时广播最新状态给房间内所有连接（含操作者自身）
    broadcastRoom(room);
  }
  sendJson(ws, { type: 'ack', reqId, status: result.status, body: result.body });
}

// 将 WebSocket 服务挂载到 HTTP 服务器
export function attachBattleWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/api/v1/lan/ws' });

  wss.on('connection', (ws, req) => {
    let roomId = '';
    let playerId = '';
    let spectatorId = '';
    let role: SocketRole = 'player';
    try {
      const url = new URL(req.url || '', 'http://localhost');
      roomId = url.searchParams.get('roomId') || '';
      playerId = url.searchParams.get('playerId') || '';
      spectatorId = url.searchParams.get('spectatorId') || '';
      role = url.searchParams.get('role') === 'spectator' ? 'spectator' : 'player';
    } catch {
      // 忽略解析失败，后续按缺失处理
    }

    if (!roomId) {
      sendJson(ws, { type: 'error', message: '缺少 roomId' });
      ws.close();
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      sendJson(ws, { type: 'error', message: '房间不存在' });
      ws.close();
      return;
    }

    if (role === 'spectator') {
      // 观战者连接：仅对战中/已结束的房间可旁观（与 HTTP /spectate 保持一致）
      if (!spectatorId) {
        sendJson(ws, { type: 'error', message: '缺少观战者标识' });
        ws.close();
        return;
      }
      if (room.phase === 'waiting') {
        sendJson(ws, { type: 'error', message: '对局尚未开始，暂无法观战' });
        ws.close();
        return;
      }

      // 与 HTTP /spectate 同一准入口径：席位不完整时拒绝，避免观战者进入「空局」
      if (!hasCompleteSeating(room)) {
        sendJson(ws, { type: 'error', message: '对局已有玩家离开，观战已结束' });
        ws.close();
        return;
      }
      // 注册到连接池 + 观众列表（幂等 upsert，重连时续期）
      if (!roomSockets.has(roomId)) roomSockets.set(roomId, new Set());
      roomSockets.get(roomId)!.add(ws);
      socketMeta.set(ws, { roomId, role, spectatorId, lastActivity: Date.now() });

      pruneSpectators(room);
      const existing = room.spectators.find(s => s.id === spectatorId);
      if (existing) {
        existing.lastSeen = Date.now();
      } else {
        room.spectators.push({ id: spectatorId, name: '观众', lastSeen: Date.now() });
      }
      room.lastActivity = Date.now();

      // 下发初始状态快照，随后广播观众人数变化
      sendJson(ws, { type: 'welcome', data: buildGameStatePayload(room) });
      broadcastRoom(room);
    } else {
      // 玩家连接
      if (!playerId) {
        sendJson(ws, { type: 'error', message: '缺少 playerId' });
        ws.close();
        return;
      }
      const player = room.players.find(p => p.id === playerId);
      if (!player) {
        sendJson(ws, { type: 'error', message: '玩家不在房间中' });
        ws.close();
        return;
      }

      // 注册到连接池
      if (!roomSockets.has(roomId)) roomSockets.set(roomId, new Set());
      roomSockets.get(roomId)!.add(ws);
      socketMeta.set(ws, { roomId, role, playerId, lastActivity: Date.now() });

      // 恢复连接层在线标记：仅表示 socket 上线，不清除断线等待记录 ——
      // 「重连成功」以玩家显式调用 POST /rooms/:id/reconnect（真正回到对局页面）为准，
      // 避免 App 在后台 socket 自动重连时对端的断线倒计时被误取消
      player.connected = true;
      player.lastHeartbeat = Date.now();
      player.lastWsAt = Date.now();
      // 新连接建立：清掉上一次的后台标记（随后客户端心跳会按真实可见性重新上报）
      player.hidden = false;
      player.hiddenSince = 0;
      room.lastActivity = Date.now();

      // 下发初始状态快照，随后广播连接状态变化
      sendJson(ws, { type: 'welcome', data: buildGameStatePayload(room) });
      broadcastRoom(room);
    }

    ws.on('pong', () => {
      const m = socketMeta.get(ws);
      if (m) m.lastActivity = Date.now();
      touchPlayerWs(m?.roomId ?? '', m?.playerId);
    });

    ws.on('message', raw => handleMessage(ws, raw));
    ws.on('close', () => handleDisconnect(ws));
    ws.on('error', () => handleDisconnect(ws));
  });

  // 传输层探活：定期 ping（pong 会刷新 lastActivity）；
  // 对长时间未收到任何客户端消息的连接判定为假死并终止，防止连接池泄漏。
  const pingTimer = setInterval(() => {
    const now = Date.now();
    for (const [roomId, socks] of roomSockets) {
      for (const ws of Array.from(socks)) {
        const meta = socketMeta.get(ws);
        if (!meta) {
          socks.delete(ws);
          continue;
        }
        // 后台标签页的连接没有活跃消息不代表离线：放宽空闲上限，避免切后台即被清扫断开（进而误判断线）
        const idleLimit = meta.hidden ? HIDDEN_SOCKET_IDLE_TIMEOUT : SOCKET_IDLE_TIMEOUT;
        if (now - meta.lastActivity > idleLimit) {
          // 超过空闲阈值 → 判定假死，终止并走断线清理
          try {
            ws.terminate();
          } catch {
            // 忽略
          }
          handleDisconnect(ws);
          continue;
        }
        try {
          ws.ping();
        } catch {
          // 忽略
        }
      }
      if (socks.size === 0) roomSockets.delete(roomId);
    }
  }, PING_INTERVAL);
  pingTimer.unref?.();

  wss.on('close', () => {
    clearInterval(pingTimer);
  });
}
