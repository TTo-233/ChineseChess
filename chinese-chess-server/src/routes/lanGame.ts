import express from 'express';
import type { Response } from 'express';

// 长将长捉规则引擎（服务端权威裁决，方案 P0）：与客户端共享同一份源码，
// 由 client/utils/chess/ruleEngine.bundle.ts 经 esbuild 编译为 ../ruleEngine.cjs
import ruleEngine from '../ruleEngine.cjs';

const router = express.Router();

// 活跃打点中间件：任何带身份（playerId，Body 或 Query）的 HTTP 请求都刷新成员在线时间。
// 等待清扫器据此按「真实活跃」判定——WS 半死不活（如代理静默断连）但 HTTP 轮询/动作
// 正常的客户端不再被误踢出房间（否则踢人重置会在公示倒数中途清空选边与公示状态）
router.use((req, _res, next) => {
  const match = req.path.match(/^\/rooms\/([^/]+)/);
  const playerId = (req.body?.playerId ?? req.query.playerId) as string | undefined;
  if (match && playerId) {
    const room = rooms.get(match[1]);
    const player = room?.players.find(p => p.id === playerId);
    if (player) player.lastWsAt = Date.now();
  }
  next();
});

// 断线等待超时（毫秒）
const DISCONNECT_TIMEOUT = 60000; // 60秒
// 心跳判定为断线的时间（毫秒）
const HEARTBEAT_TIMEOUT = 10000; // 10秒无心跳视为断线
// 后台标签页保护：浏览器会节流隐藏页面的定时器（Chrome 最长约 1 分钟触发一次，甚至冻结页面），
// 若仍按 HEARTBEAT_TIMEOUT 判定连接死活，切后台即被误判为断线并最终判负。
// 客户端在心跳中上报 hidden 标记：只要最近仍有心跳且连续后台时长未超上限，就暂不判定断线。
// 后台心跳宽容窗口（覆盖分钟级节流；超过则视为真失联）
export const HIDDEN_HEARTBEAT_GRACE = 90000;
// 单次连续后台的保护上限（超过后恢复常规判负，避免对局被无限挂起）
export const HIDDEN_MAX_DURATION = 180000;
// 后台连接的 WS 空闲上限（避免被 30s 空闲清扫提前断开）
export const HIDDEN_SOCKET_IDLE_TIMEOUT = 90000;

// 后台标签页宽容判定：客户端处于后台（hidden）、最近仍有心跳、且连续后台时长未超上限时，
// 不把该玩家判定为断线（浏览器定时器节流导致心跳间隔被拉长是正常现象，而非真断线）。
export function isHiddenTolerated(player: Player, now: number): boolean {
  if (!player || !player.hidden) return false;
  if (!player.hiddenSince || now - player.hiddenSince > HIDDEN_MAX_DURATION) return false;
  return now - (player.lastHeartbeat || 0) <= HIDDEN_HEARTBEAT_GRACE;
}

// 悔棋请求有效期（毫秒），超时未响应自动取消
const UNDO_REQUEST_TTL = 30000;
// 悔棋结果通知保留时间（毫秒），请求方轮询看到后过期清除
const UNDO_RESULT_TTL = 15000;
// 悔棋/求和请求被对方连续拒绝达到该次数后，本局禁止该玩家再发起协商
const MAX_NEGOTIATION_REFUSALS = 2;
// 观战者心跳超时（毫秒）：超过该时间未刷新则视为离开，自动移出观战列表
const SPECTATOR_TTL = 20000;
// emoji 表情消息：展示有效期（毫秒）与单房间保留上限（轮询侧读取，过期自动清理）
const EMOJI_TTL = 6000;
const EMOJI_MAX = 20;
// 房间垃圾回收：等待中房间与对局中房间的最大存活时间
const WAITING_ROOM_TTL = 30 * 60 * 1000; // 30分钟无人加入的等待房间
const ACTIVE_ROOM_TTL = 2 * 60 * 60 * 1000; // 2小时无活动的对局房间
const GC_INTERVAL = 60 * 1000; // 每分钟检查一次
// 开局倒计时（毫秒）：执棋公示后由服务端锚定的统一开局时刻，两端以此绝对时间倒数，天然一致
const START_COUNTDOWN_MS = 3000;
// 开局时刻容差（毫秒）：上传方在 gameStartAt 前最多提前该时长请求开局仍被接受（抵消网络往返）
const START_TOLERANCE_MS = 500;

// 房间数据存储（内存中）
interface Player {
  id: string;
  name: string;
  side: 'red' | 'black' | null; // null = 未分配
  sidePreference: 'red' | 'black' | null; // 准备阶段玩家选择的执棋意向（双方相同时随机分配）
  ready: boolean;
  connected: boolean;
  lastHeartbeat: number; // 最后一次心跳时间
  lastWsAt: number; // 最后一次活跃时间（WS 连接/消息/pong 或任何带 playerId 的 HTTP 请求）：等待阶段清扫失活成员的依据
  undoRefusals: number; // 本局悔棋请求被对方连续拒绝的次数（同意清零；≥2 时本局禁止再发起悔棋）
  drawRefusals: number; // 本局求和请求被对方连续拒绝的次数（同意清零；≥2 时本局禁止再发起求和）
  hidden?: boolean; // 客户端上报的页面可见性：true=标签页处于后台（浏览器会节流定时器）
  hiddenSince?: number; // 进入后台的时刻（0=不在后台）：用于限制单次连续后台的保护时长
}

export interface Room {
  id: string;
  name: string;
  password: string | null; // 房间密码（可选，加入时需校验）
  hostId: string;
  players: Player[];
  gameState: any;
  phase: 'waiting' | 'playing' | 'ended'; // waiting=等待准备, playing=对局中, ended=对局结束
  gameStartTime: number | null;
  winner: 'red' | 'black' | null;
  surrenderBy: string | null; // 认输玩家ID
  // 终局原因：供前端区分「绝杀/困毙」（播绝杀特效）与「认输/和棋/断线判负/超时判负」（仅普通文字结算）
  endReason: 'checkmate' | 'resign' | 'draw' | 'disconnect' | 'timeout' | 'leave' | null;
  settings: {
    turnTimeLimit: number; // 每轮限时（秒），0=不限时
    baseTimeSeconds: number; // 局时：基本用时（秒），0=不限时（不限时则加秒/读秒不生效）
    incrementSeconds: number; // 加秒：每走一步棋后补回的时间（秒，菲舍尔制）；与读秒互斥
    byoyomiSeconds: number; // 读秒：基本用时耗尽后每步的固定思考时长（秒）；0=关闭，与加秒互斥
    handicap: number[]; // 让子：开局时从红方移除的棋子 id（仅允许红方兵/车/马/炮：21~31）
  };
  // 局时时钟（毫秒）：基本用时剩余量。null=未启用（局时不限时）。
  // 语义为「lastMoveTime 时刻的钟面剩余」：当前走棋方的实时剩余 = clocks[side] - (now - lastMoveTime)
  clocks: { red: number; black: number } | null;
  lastMoveTime: number | null; // 上一步的时间（用于限时判定）
  disconnectedPlayerId: string | null; // 断线玩家ID
  disconnectTime: number | null; // 断线检测时间
  pendingUndo: { playerId: string; proposedState: any; requestTime: number } | null; // 待对方同意的悔棋请求
  undoResult: { playerId: string; agreed: boolean; reason: 'agreed' | 'refused' | 'timeout'; time: number } | null; // 悔棋处理结果（通知请求方）
  pendingDraw: { playerId: string; requestTime: number } | null; // 待响应的求和请求
  drawResult: { playerId: string; agreed: boolean; reason: 'agreed' | 'refused' | 'timeout'; time: number } | null; // 求和处理结果（通知请求方）
  sideReveal: { time: number; random: boolean; handicap?: boolean } | null; // 执棋结果公示信息（双方准备后生成；random=选边相同随机分配；handicap=让子直分公示，可回退）
  gameStartAt: number | null; // 服务端锚定的统一开局时刻（公示生成时设定，双端据此倒数；开局后清空）
  matchId: number; // 对局纪元：每次成功开局 +1（重赛不重置），客户端据此识别「新局」而非跨时钟比较时间戳
  spectators: { id: string; name: string; lastSeen: number }[]; // 观战者列表（旁观对局，不参与对局逻辑）
  emojiMessages: { id: string; playerId: string; emoji: string; time: number }[]; // 对局内 emoji 表情消息（短暂保留，轮询分发）
  clockPausedAt: number | null; // 悔棋/求和协商期间的棋钟暂停锚点（恢复时按暂停时长顺延 lastMoveTime）
  returnedToRoom?: Record<string, number>; // 结算后每位玩家「已返回房间」的时刻（playerId → 时间戳）；由 expireReturnedPlayers 按 TTL 兜底清理
  lastRejectionSyncAt?: number; // 被拒动作回推权威状态的限流锚点：同一房间 3 秒计数窗口的起点
  createdAt: number;
  lastActivity: number;
}

// 清理长时间未刷新心跳的观战者（惰性调用）。返回观战人数是否发生变化（用于触发广播）。
export function pruneSpectators(room: Room): boolean {
  const now = Date.now();
  const before = room.spectators.length;
  room.spectators = room.spectators.filter(s => now - s.lastSeen <= SPECTATOR_TTL);
  return room.spectators.length !== before;
}

export const rooms: Map<string, Room> = new Map();

// 实时广播器：由 WebSocket 模块注册（注册前为空操作）。
// 房间状态发生变化（走棋/认输/求和/悔棋/断线等）后调用，向该房间所有 WS 连接推送最新状态。
let roomBroadcaster: (room: Room) => void = () => {};
export function registerRoomBroadcaster(fn: (room: Room) => void): void {
  roomBroadcaster = fn;
}

// WebSocket 连接存活探针：由 battleWs 模块注入（避免 lanGame ↔ battleWs 循环依赖），
// 供等待阶段清扫「人不在房间页面」的残留成员（iOS 侧滑/杀进程等未走 /leave 的退出路径）
let socketLivenessProbe: (roomId: string, playerId: string) => boolean = () => true;
export function registerSocketLivenessProbe(fn: (roomId: string, playerId: string) => boolean): void {
  socketLivenessProbe = fn;
}

// 等待阶段成员离房判定宽限：无活跃 WS 且超过该时长未活动 → 视为已离开房间
// （覆盖杀进程/侧滑返回等未调 /leave 的路径；宽限需大于 WS 断线重连的最大退避间隔）
const WAITING_SWEEP_GRACE_MS = 30 * 1000;

// 被拒绝的动作回推权威状态（客户端只按 <400 收 state，被拒绝的动作会导致画面永久停在乐观更新后的样子）
// 加固：历史上前身是直接注入 dist 的补丁，现已归位到源码（改这里即可，改完在 chinese-chess-server/ 下跑 node build.js）。
//
// 被拒绝的动作必须把**权威状态**也回推给双方。
// 客户端应用服务端状态的唯一入口是 state 帧 / GET /rooms/:id/gameState，
// 而服务端原本只在 result.status < 400 时才广播（且广播的是当前 room 状态）；
// 于是「不是你的回合」「非法走法（含送将）」「对方的悔棋请求已被处理」这类拒绝
// 会让客户端毫无感知：落子的乐观更新留在盘上、悔棋按钮停在「等待对方同意」，
// 直到下一次成功动作才被顺带纠正。
//
// 这里在非 2xx 时补一次广播（room 未变，所以推过去的正是权威局面）。
// 限流：同一房间 3 秒内最多 8 次，避免被连续非法请求刷屏；
// 且只对 4xx 生效——5xx 属于服务端自身异常，不该顺手改写客户端对局画面。
let syncRejectionCount = 0;

// 对局动作的统一返回结构（供 HTTP 与 WebSocket 两种通道复用同一套核心逻辑）
export interface ActionResult {
  status: number;
  body: Record<string, unknown>;
}

// HTTP 通道统一响应：动作成功时向房间内所有 WebSocket 连接广播最新状态
function respondAction(res: Response, roomId: string, result: ActionResult): void {
  var rejected = result.status >= 400;
  if (result.status < 400) {
    syncRejectionCount = 0;
  }
  var roomForSync = rooms.get(roomId);
  if (rejected && result.status < 500 && roomForSync) {
    var nowSync = Date.now();
    var lastSyncAt = roomForSync.lastRejectionSyncAt || 0;
    if (nowSync - lastSyncAt >= 3000) {
      syncRejectionCount = 0;
    }
    if (syncRejectionCount < 8) {
      syncRejectionCount += 1;
      roomForSync.lastRejectionSyncAt = nowSync;
      roomBroadcaster(roomForSync);
    }
  }

  res.status(result.status).json(result.body);
}

// 生成房间ID：6位数字（100000-999999），确保与现有房间不重复
function generateRoomId(): string {
  let id = '';
  do {
    id = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(id));
  return id;
}

// 房间名最小空缺优先：自动房间名从 1 起找第一个未占用的编号，销毁房间后其编号可被复用
// 加固：历史上前身是直接注入 dist 的补丁，现已归位到源码（改这里即可，改完在 chinese-chess-server/ 下跑 node build.js）。
//
// 原实现的起点写死为 `rooms.size + 1`，只会单调递增：
// 同时存在「房间1」「房间3」时，下一个编号是「房间3」→ 被占用 → +1 →「房间4」，
// 于是即便「房间2」空着也永远排不到它；
// 销毁「房间1」后 size 从 3 变 2，起点仍是 3 → 又是「房间3」「房间4」……
// 空号只增不减，房间名也越涨越大（删掉「房间7」后新建得到的是「房间9」）。
// ⚠️ 不要用 `rooms.size` 做起点：它与"已占用编号"无关，这正是原实现的错误来源。
function defaultRoomName(): string {
  const usedNames = new Set([...rooms.values()].map(r => r.name));
  let n = 1;
  while (usedNames.has(`房间${n}`)) n += 1;
  return `房间${n}`;
}

// 房间垃圾回收：长期运行的互联网服务器需要清理无人使用的房间
const gcTimer = setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    const idle = now - room.lastActivity;
    const ttl = room.phase === 'waiting' ? WAITING_ROOM_TTL : ACTIVE_ROOM_TTL;
    if (idle > ttl) {
      rooms.delete(roomId);
      console.log(`[GC] 清理闲置房间 ${roomId}（${Math.round(idle / 60000)}分钟无活动）`);
    }
  }
}, GC_INTERVAL);
// 不阻止进程因其他原因退出
(gcTimer as unknown as { unref?: () => void }).unref?.();

// 悔棋/求和协商期间暂停棋钟：锚定暂停时刻，超时判负与客户端插值均以此冻结（幂等，连续请求不累加锚点）
function pauseClock(room: Room): void {
  if (room.phase === 'playing' && room.clocks && room.clockPausedAt === null) {
    room.clockPausedAt = Date.now();
  }
}

// 协商结束恢复棋钟：暂停时长顺延到 lastMoveTime，行棋方剩余时间与暂停前一致
function resumeClock(room: Room): void {
  if (room.clockPausedAt !== null) {
    if (room.lastMoveTime) room.lastMoveTime += Date.now() - room.clockPausedAt;
    room.clockPausedAt = null;
  }
}

// 清理过期悔棋请求（返回是否有变更，供实时广播判断）
function expirePendingUndo(room: Room): boolean {
  let changed = false;
  if (room.pendingUndo && Date.now() - room.pendingUndo.requestTime > UNDO_REQUEST_TTL) {
    room.undoResult = {
      playerId: room.pendingUndo.playerId,
      agreed: false,
      reason: 'timeout',
      time: Date.now(),
    };
    room.pendingUndo = null;
    resumeClock(room); // 协商超时结束，棋钟恢复
    changed = true;
  }
  if (room.undoResult && Date.now() - room.undoResult.time > UNDO_RESULT_TTL) {
    room.undoResult = null;
    changed = true;
  }
  return changed;
}

// 清理过期求和请求（返回是否有变更，供实时广播判断）
function expirePendingDraw(room: Room): boolean {
  let changed = false;
  if (room.pendingDraw && Date.now() - room.pendingDraw.requestTime > UNDO_REQUEST_TTL) {
    room.drawResult = {
      playerId: room.pendingDraw.playerId,
      agreed: false,
      reason: 'timeout',
      time: Date.now(),
    };
    room.pendingDraw = null;
    resumeClock(room); // 协商超时结束，棋钟恢复
    changed = true;
  }
  if (room.drawResult && Date.now() - room.drawResult.time > UNDO_RESULT_TTL) {
    room.drawResult = null;
    changed = true;
  }
  return changed;
}

// 清理过期/超量的 emoji 表情消息（惰性调用）
function pruneEmojis(room: Room): void {
  const now = Date.now();
  room.emojiMessages = room.emojiMessages
    .filter(m => now - m.time <= EMOJI_TTL)
    .slice(-EMOJI_MAX);
}

// 断线检测与判负（对局中）：心跳超时标记断线，断线超时判负。返回是否有状态变更。
function detectDisconnect(room: Room): boolean {
  if (room.phase !== 'playing') return false;
  let changed = false;
  const now = Date.now();
  for (const player of room.players) {
    // 后台标签页（浏览器节流心跳）在保护窗口内不判定断线；若已被标记则立即撤销等待
    if (isHiddenTolerated(player, now)) {
      if (!player.connected) {
        player.connected = true;
        changed = true;
      }
      if (room.disconnectedPlayerId === player.id) {
        room.disconnectedPlayerId = null;
        room.disconnectTime = null;
        changed = true;
      }
      continue;
    }
    if (now - player.lastHeartbeat > HEARTBEAT_TIMEOUT && player.connected) {
      player.connected = false;
      changed = true;
      if (!room.disconnectedPlayerId) {
        room.disconnectedPlayerId = player.id;
        room.disconnectTime = now;
      }
    }
  }
  if (room.disconnectedPlayerId && room.disconnectTime) {
    const disconnectedPlayer = room.players.find(p => p.id === room.disconnectedPlayerId);
    if (!disconnectedPlayer) {
      // 断线成员已不在房间（被移出/房间自愈）：等待状态无意义，直接清空
      room.disconnectedPlayerId = null;
      room.disconnectTime = null;
      changed = true;
    } else if (disconnectedPlayer.connected || isHiddenTolerated(disconnectedPlayer, now)) {
      // 玩家已回到对局（心跳/WS 重连恢复）：撤销断线等待。
      // 否则 disconnectTime 仍是旧值，60s 后即使玩家一直在线也会被按旧计时判负。
      room.disconnectedPlayerId = null;
      room.disconnectTime = null;
      changed = true;
    } else if (now - room.disconnectTime > DISCONNECT_TIMEOUT) {
      room.winner = disconnectedPlayer.side === 'red' ? 'black' : 'red';
      room.endReason = 'disconnect';
      room.phase = 'ended';
      room.clockPausedAt = null; // 终局清空暂停锚点，保持载荷干净
      room.lastActivity = now;
      changed = true;
    }
  }
  return changed;
}

// 局时超时判负（基本用时 + 加秒制 / 读秒制）：当前走棋方的实时剩余 = 钟面 - 已耗时，耗尽即判负。
// 读秒制下基本用时耗尽后，当前思考时段自动进入读秒，获得完整读秒时长（即剩余 = 钟面 - 已耗时 + 读秒）；
// 服务端权威判定（每秒 tick），客户端仅作倒计时展示；加秒已在上一步走棋时入账，此处只读
function detectClockTimeout(room: Room): boolean {
  if (room.phase !== 'playing' || !room.clocks || !room.gameState || !room.lastMoveTime) return false;
  if (room.clockPausedAt !== null) return false; // 悔棋/求和协商期间棋钟冻结，不做超时判负

  const sideTag = (room.gameState as { sideTag?: unknown }).sideTag;
  const current: 'red' | 'black' = (sideTag === true || sideTag === 'red') ? 'red' : 'black';
  const remaining = room.clocks[current] - (Date.now() - room.lastMoveTime);
  if (remaining > 0) return false;
  // 读秒制：基本用时耗尽≠判负，读秒时长内走棋仍有效（超时点 = 钟面 + 读秒时长）
  if (room.settings.byoyomiSeconds > 0 && remaining + room.settings.byoyomiSeconds * 1000 > 0) return false;
  room.clocks[current] = 0;
  room.winner = current === 'red' ? 'black' : 'red';
  room.endReason = 'timeout';
  room.phase = 'ended';
  room.clockPausedAt = null; // 终局清空暂停锚点，保持载荷干净
  room.lastActivity = Date.now();
  return true;
}

// 构建对局状态推送载荷（对所有玩家一致，客户端据此自行判定执棋方/轮到谁等视角信息）
export function buildGameStatePayload(room: Room): Record<string, unknown> {
  return {
    gameState: room.gameState,
    phase: room.phase,
    gameStartTime: room.gameStartTime,
    matchId: room.matchId, // 对局纪元：客户端识别新局，杜绝跨时钟时间戳比较
    sideReveal: room.sideReveal, // 执棋公示（含生成时间；客户端校正倒计时锚点）
    gameStartAt: room.gameStartAt, // 服务端锚定的统一开局时刻
    serverNow: Date.now(), // 服务端当前时间：客户端计算时钟偏移，所有跨端倒计时以此为准
    settings: room.settings, // 局时/加秒/步时/让子：客户端时钟展示与让子开局依据
    clocks: room.clocks, // 局时剩余（毫秒，lastMoveTime 时刻钟面）；null=未启用
    clockPausedAt: room.clockPausedAt, // 棋钟暂停锚点：非 null 时客户端以此时刻冻结时钟插值
    winner: room.winner,
    surrenderBy: room.surrenderBy,
    endReason: room.endReason,
    lastMoveTime: room.lastMoveTime,
    disconnectedPlayerId: room.disconnectedPlayerId,
    disconnectTime: room.disconnectTime,
    pendingUndo: room.pendingUndo
      ? { playerId: room.pendingUndo.playerId, requestTime: room.pendingUndo.requestTime }
      : null,
    undoResult: room.undoResult,
    pendingDraw: room.pendingDraw
      ? { playerId: room.pendingDraw.playerId, requestTime: room.pendingDraw.requestTime }
      : null,
    drawResult: room.drawResult,
    // 各玩家本局悔棋/求和被对方连续拒绝的次数（分开计数）：≥2 时客户端分别禁用对应入口
    undoRefusals: Object.fromEntries(room.players.map(p => [p.id, p.undoRefusals])),
    drawRefusals: Object.fromEntries(room.players.map(p => [p.id, p.drawRefusals])),
    players: room.players.map(p => ({ id: p.id, name: p.name, side: p.side, connected: p.connected })),
    // 结算后「已返回房间」记录（key=playerId，value=返回时刻）：
    // 客户端据此提示「对手已返回房间」，并据此不自动跟随房间重置（互不干扰）
    returnedToRoom: room.returnedToRoom || {},
    spectatorCount: room.spectators.length,
    emojiMessages: room.emojiMessages.map(m => ({ id: m.id, playerId: m.playerId, emoji: m.emoji, time: m.time })),
  };
}

// 房主变更统一处理：让子设置仅对原房主有效——原房主退出/被清扫导致房主易主时，
// 让子自动取消，避免新房主在不知情的情况下以让子开局
// （留存/新房主的客户端轮询房间详情与对局状态负载会同步到 handicap=[]）
function transferHost(room: Room): void {
  room.hostId = room.players[0].id;
  if (room.settings.handicap.length > 0) {
    room.settings.handicap = [];
  }
  revertHandicapReveal(room); // 让子随原房主退出失效，恢复常规选边流程
}

// 让子直分：存在让子且双方就绪时跳过选边——服务端直接公示（房主执红先行、另一方执黑），
// 并锚定统一开局时刻；handicap 标记用于让子取消/房主易主时回退公示
function applyHandicapAutoReveal(room: Room): boolean {
  if (room.phase !== 'waiting' || room.sideReveal) return false;
  if (room.settings.handicap.length === 0) return false;
  if (room.players.length !== 2 || !room.players.every(p => p.ready)) return false;
  const host = room.players.find(p => p.id === room.hostId);
  const guest = room.players.find(p => p.id !== room.hostId);
  if (!host || !guest) return false;
  host.side = 'red';
  guest.side = 'black';
  room.sideReveal = { time: Date.now(), random: false, handicap: true };
  room.gameStartAt = room.sideReveal.time + START_COUNTDOWN_MS;
  room.lastActivity = Date.now();
  return true;
}

// 回退让子直分公示：让子被清空或原房主退出后，房间恢复常规选边流程
function revertHandicapReveal(room: Room): void {
  if (!room.sideReveal?.handicap) return;
  room.sideReveal = null;
  room.gameStartAt = null;
  room.players.forEach(p => {
    p.side = null;
    p.sidePreference = null;
  });
}

// 等待阶段成员清扫：无活跃 WebSocket 且超过宽限未活动的成员视为已离开（杀进程/iOS 侧滑等未走 /leave），
// 处理方式与 /leave 一致——移除成员、房主离开则转移、房间无人则销毁，避免大厅出现错误的回连提醒
function sweepWaitingRoom(room: Room): boolean {
  if (room.phase !== 'waiting') return false;
  const now = Date.now();
  const stale = room.players.filter(
    p => !socketLivenessProbe(room.id, p.id) && now - p.lastWsAt > WAITING_SWEEP_GRACE_MS
  );
  if (stale.length === 0) return false;

  for (const p of stale) {
    const wasHost = room.hostId === p.id;
    room.players = room.players.filter(x => x.id !== p.id);
    if (wasHost && room.players.length > 0) {
      transferHost(room);
    }
  }
  room.lastActivity = now;
  if (room.players.length === 0) {
    rooms.delete(room.id);
  } else {
    // 与 /leave 一致的清理：重置剩余玩家的准备与选边、清空公示与统一定时。
    // 否则在公示倒数期间清扫死连成员，会让留存者卡在「公示仍在但开局必失败」的死状态
    // （/start 被拒、客户端中止路径又因公示非空而不触发，永久无法走子且无操作按钮）
    room.players.forEach(p => {
      p.ready = false;
      p.sidePreference = null;
      p.side = null;
    });
    room.sideReveal = null;
    room.gameStartAt = null;
  }
  return true;
}

// 结算阶段滞留自愈：对局结束后双方可能未走 /leave 就直接关页面/杀进程（Web 端卸载兜底 /leave
// 被门控，原生端也可能未触发），此时房间永远滞留 ended——大厅列表不展示 ended 房间，对他人
// 形同「房间消失」（AI 陪练房即因此从大厅隐身）。ended 滞留超过宽限且活跃成员 ≤1 时（活跃 =
// 有存活 WS 或 lastWsAt 新鲜；停留在结算界面的客户端会持续轮询打点，天然保持活跃）：
// 移除非活跃成员、必要时转移房主、重置回等待阶段（actRematch 幂等），房间重新出现在大厅可加入；
// 留存一方的客户端轮询发现 waiting 后会自动跟随回准备界面（resetForRematch）。
// 双方均在线则不干预（重赛/退出由玩家自行决定）；全部失联则销毁房间释放内存。
const ENDED_STALE_GRACE_MS = 10 * 1000;
const endedSinceMap = new Map<string, number>();

function healStaleEndedRoom(room: Room): boolean {
  if (room.phase !== 'ended') {
    endedSinceMap.delete(room.id);
    return false;
  }
  // 对方主动离场所致的终局不参与自愈：该局的输赢已由「离场即弃局」裁定，
  // 留下的一方需要停留在结算页决定去留；若被下面「活跃人数 ≤1 就重置为等待中」的逻辑接管，
  // 结算浮层会在 ENDED_STALE_GRACE_MS（10s）后被静默清空，胜方连结果都来不及看。
  // 这类房间的收口交给 ACTIVE_ROOM_TTL（2h）GC，或由玩家主动点「返回房间/退出房间」。
  if (room.endReason === 'leave') {
    endedSinceMap.delete(room.id);
    return false;
  }
  const now = Date.now();
  const since = endedSinceMap.get(room.id);
  if (since === undefined) {
    endedSinceMap.set(room.id, now); // 首次进入 ended：开始计时
    return false;
  }
  if (now - since < ENDED_STALE_GRACE_MS) return false;

  const active = room.players.filter(
    p => socketLivenessProbe(room.id, p.id) || now - p.lastWsAt <= ENDED_STALE_GRACE_MS || isHiddenTolerated(p, now)
  );
  if (active.length > 1) return false; // 双方均在线（结算界面正常浏览/重赛决策中），不干预

  const activeIds = new Set(active.map(p => p.id));
  room.players = room.players.filter(p => activeIds.has(p.id));
  room.lastActivity = now;
  endedSinceMap.delete(room.id);
  if (room.players.length === 0) {
    rooms.delete(room.id);
    return true;
  }
  if (!room.players.some(p => p.id === room.hostId)) {
    transferHost(room); // 房主易主：让子自动取消
  }
  actRematch(room.id, {}); // ended → waiting：重置准备/选边/公示，大厅立即可见
  return true;
}

export function hasCompleteSeating(room: Room): boolean {
  // 观战席位校验：棋盘需要红黑双方都在席才能呈现完整对局。
  // 一方离场后房间仍会短暂停留在 ended（等 healStaleEndedRoom 收口），
  // 此时放行观战只会看到「红方/黑方」空占位，必须直接拒绝。
  const sides = new Set(
    room.players.map(p => p.side).filter(s => s === 'red' || s === 'black')
  );
  return sides.has('red') && sides.has('black');
}

export function settleAbandonedPlayingRoom(room: Room, leaverId?: string | null): boolean {
  // 对局中离场结算：一方在 playing 阶段离开（主动返回退出、断连后被移出等）必须立即裁定本局，
  // 否则房间会以「单人 playing」形态滞留，派生出一整串错误状态：
  //   1) 留下的玩家在状态负载里查不到对手 → 前端退化成「等待对手加入」的空席位；
  //   2) 房中已无第二个玩家，detectDisconnect 找不到可判断线的对象，DISCONNECT_TIMEOUT
  //      倒计时对留下的一方空转，棋钟继续走并可能在超时后把留下的一方判负；
  //   3) 房间卡在 playing，既不进 sweepWaitingRoom 也不进 healStaleEndedRoom，
  //      只能等 ACTIVE_ROOM_TTL(2h) 被 GC 回收，期间任何人都能进「空局」观战。
  // 语义取「离场即弃局」：判对方获胜。endReason 用 'leave' 而非 'resign'，
  // 前端据此给出「对手离开了对局」而不是误报「对手选择了认输」。
  // leaverId 为空表示兜底路径（席位被动缺失、来源不可考），结算口径与显式离场一致。
  if (room.phase !== 'playing') return false;
  if (leaverId && !room.players.some(p => p.id === leaverId)) return false;
  const remaining = leaverId ? room.players.filter(p => p.id !== leaverId) : room.players;
  if (remaining.length === 0) {
    rooms.delete(room.id);
    return true;
  }
  if (remaining.length >= 2) return false;
  const leaver = leaverId ? room.players.find(p => p.id === leaverId) : null;
  const survivor = remaining[0];
  // 胜负以离场者阵营为准；离场者阵营缺失时按在场者阵营取反
  const leaverSide = leaver && leaver.side ? leaver.side : survivor.side === 'red' ? 'black' : 'red';
  room.phase = 'ended';
  room.winner = leaverSide === 'red' ? 'black' : 'red';
  room.endReason = 'leave';
  // 离场不是认输：surrenderBy 保持为空，避免结算文案把「离开」说成「认输」
  room.surrenderBy = null;
  room.clockPausedAt = null;
  room.disconnectedPlayerId = null;
  room.disconnectTime = null;
  room.pendingUndo = null;
  room.undoResult = null;
  room.pendingDraw = null;
  room.drawResult = null;
  room.lastActivity = Date.now();
  return true;
}

// 统一定时自动开局：公示锚定的开局时刻（gameStartAt）到点后由服务端权威开局。
// 不依赖上传方客户端的 /start 成功——上传方请求失败/延迟时，对端客户端会永远卡在
// 公示阶段（无法走子、无操作按钮）；由每秒 tick 驱动，到点后最多延迟 1 个 tick 生效
function tryAutoStart(room: Room): boolean {
  if (room.phase !== 'waiting') return false;
  if (!room.sideReveal || !room.gameStartAt) return false;
  if (Date.now() < room.gameStartAt) return false;
  if (room.players.length < 2) return false;
  if (!room.players.every(p => p.ready)) return false;
  const sides = room.players.map(p => p.side);
  if (!sides.includes('red') || !sides.includes('black')) return false;

  room.phase = 'playing';
  room.matchId += 1; // 对局纪元 +1：客户端据此识别新局（与 actStart 同一套语义）
  room.gameStartTime = Date.now();
  room.gameStartAt = null; // 开局时刻已消费（sideReveal 保留，与 actStart 一致，重赛/离开时统一清理）
  room.lastMoveTime = Date.now();
  room.lastActivity = Date.now();
  // 局时时钟初始化（基本用时+加秒制；局时为 0 表示不限时，不启用时钟）
  room.clocks = room.settings.baseTimeSeconds > 0
    ? { red: room.settings.baseTimeSeconds * 1000, black: room.settings.baseTimeSeconds * 1000 }
    : null;
  // 心跳基线对齐到开局时刻（与 actStart 同理，防止开局瞬间被误判断线）
  room.players.forEach((p) => { p.lastHeartbeat = Date.now(); });
  return true;
}

// 服务端对局心跳（每秒）：惰性清理 + 断线检测。此前这些逻辑只在客户端轮询 GET gameState 时触发，
// 改为 WebSocket 后客户端不再轮询，故由服务端定时驱动，并在状态变化时主动广播。
const gameTickTimer = setInterval(() => {
  for (const room of rooms.values()) {
    let changed = false;
    if (sweepWaitingRoom(room)) changed = true; // 等待阶段：清扫未走 /leave 的死连接成员
    if (!rooms.has(room.id)) continue; // 房间已因无人被销毁
    if (healStaleEndedRoom(room)) changed = true; // 结算阶段：滞留自愈（成员未走 /leave 的幽灵房间）
    if (!rooms.has(room.id)) continue; // 自愈可能已销毁全失联房间
    // 对局不变量兜底：playing 相位必须红黑双方都在席。
    // 正常路径由 /leave 立即结算，这里覆盖的是改座位遗留的异常态（如旧版本房间已滞留），
    // 防止单人 playing 无限滞留（空局可被观战、留下的一方被空转的断线倒计时牵连）。
    if (settleAbandonedPlayingRoom(room)) {
      if (!rooms.has(room.id)) continue;
      changed = true;
    }
    // 结算后的「返回房间」10s 兜底：客户端未按时补齐时按超时自动补齐并可能触发房间重置
    if (expireReturnedPlayers(room, Date.now())) changed = true;
    if (tryAutoStart(room)) changed = true; // 统一定时到点：服务端权威自动开局
    if (expirePendingUndo(room)) changed = true;
    if (expirePendingDraw(room)) changed = true;
    if (pruneSpectators(room)) changed = true;
    pruneEmojis(room);
    if (detectDisconnect(room)) changed = true;
    if (detectClockTimeout(room)) changed = true; // 局时耗尽：超时判负
    if (changed) roomBroadcaster(room);
  }
}, 1000);
(gameTickTimer as unknown as { unref?: () => void }).unref?.();

// 局时/加秒/读秒参数解析：局时 0=不限时（此时加秒与读秒均强制为 0）；局时上限 3600 秒，
// 加秒上限 60 秒，读秒上限 120 秒；加秒与读秒互斥（基本用时的两种补充制度，不能同时启用）
function parseClockSettings(baseTimeSeconds: unknown, incrementSeconds: unknown, byoyomiSeconds: unknown):
  { baseTimeSeconds: number; incrementSeconds: number; byoyomiSeconds: number } | { error: string } {
  const rawBase = Number(baseTimeSeconds);
  const base = Number.isFinite(rawBase) && rawBase > 0 ? Math.min(Math.round(rawBase), 3600) : 0;
  const rawInc = Number(incrementSeconds);
  let inc = Number.isFinite(rawInc) && rawInc > 0 ? Math.round(rawInc) : 0;
  if (inc > 60) return { error: '加秒需在 0~60 秒之间' };
  const rawByo = Number(byoyomiSeconds);
  let byo = Number.isFinite(rawByo) && rawByo > 0 ? Math.round(rawByo) : 0;
  if (byo > 120) return { error: '读秒需在 0~120 秒之间' };
  if (inc > 0 && byo > 0) return { error: '加秒与读秒只能二选一' };
  if (base === 0) { inc = 0; byo = 0; } // 不限时时加秒/读秒无意义
  return { baseTimeSeconds: base, incrementSeconds: inc, byoyomiSeconds: byo };
}

// 让子参数解析：仅允许红方兵/车/马/炮（棋子 id 21~31，不含仕/相/帅），去重
// 数量天然有界：去重后且必须落在 11 个合法 id 内，最多 11 枚，无需额外长度校验
const HANDICAP_ALLOWED_IDS = new Set([21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
function parseHandicap(handicap: unknown): { ids: number[] } | { error: string } {
  if (handicap === undefined || handicap === null) return { ids: [] };
  if (!Array.isArray(handicap)) return { error: '让子格式不正确' };
  const ids = [...new Set(handicap.map(v => Number(v)).filter(v => Number.isInteger(v)))];
  if (ids.some(id => !HANDICAP_ALLOWED_IDS.has(id))) {
    return { error: '让子仅支持红方兵、车、马、炮' };
  }
  return { ids: ids.sort((a, b) => a - b) };
}

// 创建房间
router.post('/rooms', (req, res) => {
  const { playerName, playerId, turnTimeSeconds, roomName, password, baseTimeSeconds, incrementSeconds, byoyomiSeconds, handicap } = req.body;

  if (!playerName) {
    return res.status(400).json({ error: '玩家名称不能为空' });
  }

  const trimmedPassword = typeof password === 'string' ? password.trim() : '';
  const trimmedRoomName = typeof roomName === 'string' ? roomName.trim() : '';
  if (trimmedRoomName.length > 5) {
    return res.status(400).json({ error: '房间名最长 5 个字符' });
  }
  if (trimmedPassword && !/^\d{1,6}$/.test(trimmedPassword)) {
    return res.status(400).json({ error: '密码需为 6 位以内纯数字' });
  }
  // 每轮限时（秒）：非法/缺省视为 0（不限时），上限 3600 秒
  const rawTurnSeconds = Number(turnTimeSeconds);
  const turnTimeLimit = Number.isFinite(rawTurnSeconds) && rawTurnSeconds > 0
    ? Math.min(Math.round(rawTurnSeconds), 3600)
    : 0;
  const clockSettings = parseClockSettings(baseTimeSeconds, incrementSeconds, byoyomiSeconds);
  if ('error' in clockSettings) {
    return res.status(400).json({ error: clockSettings.error });
  }
  const handicapIds = parseHandicap(handicap);
  if ('error' in handicapIds) {
    return res.status(400).json({ error: handicapIds.error });
  }
  const roomId = generateRoomId();
  const room: Room = {
    id: roomId,
    name: trimmedRoomName || defaultRoomName(),
    password: trimmedPassword || null,
    hostId: playerId || 'host',
    players: [
      {
        id: playerId || 'host',
        name: playerName,
        side: null,
        sidePreference: null,
        ready: false,
        connected: true,
        lastHeartbeat: Date.now(),
        lastWsAt: Date.now(),
        undoRefusals: 0,
        drawRefusals: 0,
      },
    ],
    gameState: null,
    phase: 'waiting',
    gameStartTime: null,
    winner: null,
    surrenderBy: null,
    endReason: null,
    settings: {
      turnTimeLimit, // 每轮限时（秒），0=不限时
      baseTimeSeconds: clockSettings.baseTimeSeconds,
      incrementSeconds: clockSettings.incrementSeconds,
      byoyomiSeconds: clockSettings.byoyomiSeconds,
      handicap: handicapIds.ids,
    },
    clocks: null, // 开局时按局时初始化
    lastMoveTime: null,
    clockPausedAt: null, // 悔棋/求和协商期间的棋钟暂停锚点
    disconnectedPlayerId: null,
    disconnectTime: null,
    pendingUndo: null,
    undoResult: null,
    pendingDraw: null,
    drawResult: null,
    sideReveal: null,
    gameStartAt: null,
    matchId: 0,
    // 结算后每位玩家独立的「已返回房间」记录（playerId → 返回时刻）。
    // 双方互不干扰：本端返回不自动把对手拉回房间，对手端据此自行决定；
    // 记录供客户端提示「对手已返回房间」，并由 expireReturnedPlayers 按 10s 兜底清理。
    returnedToRoom: {},
    spectators: [],
    emojiMessages: [],
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };

  rooms.set(roomId, room);

  res.json({ roomId, room });
});

// 获取房间列表（等待中可加入的房间 + 对战中房间，前端展示对局状态）
router.get('/rooms', (_req, res) => {
  const roomList = Array.from(rooms.values())
    .filter(room => room.phase === 'waiting' || room.phase === 'playing')
    .map(room => {
      pruneSpectators(room); // 先清理失效观战者，保证人数准确
      return {
        id: room.id,
        name: room.name,
        hostName: room.players[0]?.name,
        playerCount: room.players.length,
        phase: room.phase, // waiting=等待中, playing=对战中
        hasPassword: !!room.password,
        turnTimeLimit: room.settings.turnTimeLimit, // 每轮限时（秒），0=不限时
        baseTimeSeconds: room.settings.baseTimeSeconds, // 局时（秒），0=不限时
        incrementSeconds: room.settings.incrementSeconds, // 加秒（秒）
        byoyomiSeconds: room.settings.byoyomiSeconds, // 读秒（秒），0=关闭
        handicapCount: room.settings.handicap.length, // 让子枚数（>0 展示「让子」标签）
        handicap: room.settings.handicap, // 让出的棋子 id（大厅标签展示让子明细：车/马/炮/兵）
        spectatable: room.phase === 'playing', // 对战中的房间可观战
        spectatorCount: room.spectators.length, // 当前观战人数
        createdAt: room.createdAt,
      };
    })
    // 等待中的排前面，同状态按创建时间倒序
    .sort((a, b) => {
      if (a.phase !== b.phase) return a.phase === 'waiting' ? -1 : 1;
      return b.createdAt - a.createdAt;
    });

  res.json({ rooms: roomList });
});

// 查询玩家当前所属的活跃房间（断线重连入口：大厅据此提示「回到对局」）。
// 注意路由顺序：必须定义在 GET /rooms/:roomId 之前，否则 active 会被当作 roomId 匹配。
router.get('/rooms/active', (req, res) => {
  const playerId = typeof req.query.playerId === 'string' ? req.query.playerId : '';
  if (!playerId) {
    return res.json({ room: null });
  }
  // 玩家可能滞留多个未结束房间（如未离开旧房又建新房）：对局中的房间优先，其余取最近活跃，
  // 保证重连入口始终指向玩家真正在玩/最新操作的那个房间
  let candidate: Room | null = null;
  for (const room of rooms.values()) {
    if (room.phase === 'ended') continue; // 已终局的房间不提供重连（可重新建房/加入）
    if (!room.players.some(p => p.id === playerId)) continue;
    if (
      !candidate ||
      (room.phase === 'playing' && candidate.phase !== 'playing') ||
      (room.phase === candidate.phase && room.lastActivity > candidate.lastActivity)
    ) {
      candidate = room;
    }
  }
  if (candidate) {
    const room = candidate;
    const me = room.players.find(p => p.id === playerId)!;
    const opponent = room.players.find(p => p.id !== playerId);
    return res.json({
      room: {
        id: room.id,
        name: room.name,
        phase: room.phase, // waiting=准备阶段, playing=对局中
        hasPassword: !!room.password,
        mySide: me.side, // red/black/null（未分配）
        disconnected: !me.connected, // 服务端视角我当前是否处于断线状态
        opponentName: opponent?.name ?? null,
        opponentConnected: opponent ? opponent.connected : null,
        serverNow: Date.now(),
      },
    });
  }
  return res.json({ room: null });
});

// 加入房间
router.post('/rooms/:roomId/join', (req, res) => {
  const { roomId } = req.params;
  const { playerName, playerId, password } = req.body;

  if (!playerName) {
    return res.status(400).json({ success: false, message: '玩家名称不能为空' });
  }

  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ success: false, message: '房间不存在或已关闭' });
  }

  // 幂等加入：同一玩家重复加入直接返回成功（断线重连/刷新场景，无需再校验密码）
  const existing = room.players.find(p => p.id === playerId);
  if (existing) {
    existing.name = playerName;
    existing.connected = true;
    existing.lastHeartbeat = Date.now();
    return res.json({ success: true, room, player: existing });
  }

  if (room.players.length >= 2) {
    return res.status(400).json({ success: false, message: '房间已满' });
  }

  if (room.phase !== 'waiting') {
    return res.status(400).json({ success: false, message: '该房间对局已开始' });
  }

  // 密码校验（房间设有密码时）
  if (room.password) {
    const inputPassword = typeof password === 'string' ? password.trim() : '';
    if (!inputPassword) {
      return res.status(401).json({ success: false, message: '该房间需要密码', needPassword: true });
    }
    if (inputPassword !== room.password) {
      return res.status(401).json({ success: false, message: '房间密码错误', needPassword: true });
    }
  }

  const player: Player = {
    id: playerId || 'guest',
    name: playerName,
    side: null,
    sidePreference: null,
    ready: false,
    connected: true,
    lastHeartbeat: Date.now(),
    lastWsAt: Date.now(),
    undoRefusals: 0,
    drawRefusals: 0,
  };

  room.players.push(player);
  room.lastActivity = Date.now();

  res.json({ success: true, room, player });
});

// 获取房间详情（含玩家选边/准备状态与执棋公示信息；不返回密码明文）
router.get('/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);

  if (!room) {
    return res.status(404).json({ error: '房间不存在' });
  }

  res.json({
    room: {
      id: room.id,
      name: room.name,
      hasPassword: !!room.password,
      // 房间密码：休闲房间场景，返回明文便于房主在设置弹窗中查看/修改
      password: room.password,
      hostId: room.hostId,
      phase: room.phase,
      settings: room.settings,
      sideReveal: room.sideReveal,
      gameStartAt: room.gameStartAt, // 服务端锚定的统一开局时刻
      matchId: room.matchId, // 对局纪元
      serverNow: Date.now(), // 服务端当前时间（客户端时钟校正）
      createdAt: room.createdAt,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        side: p.side,
        sidePreference: p.sidePreference,
        ready: p.ready,
        connected: p.connected,
      })),
      // 结算后「已返回房间」记录（key=playerId，value=返回时刻）：
      // 客户端 2s 轮询据此判断对手是否已返回房间，并据此不自动跟随房间重置
      returnedToRoom: room.returnedToRoom || {},
      // 等待阶段表情消息（TTL 内）：客户端 2s 轮询详情时同步，作为 WS 之外的接收兜底通道
      emojiMessages: room.emojiMessages.map(m => ({ id: m.id, playerId: m.playerId, emoji: m.emoji, time: m.time })),
    },
  });
});

// 修改房间信息与设置（仅房主、仅等待阶段；对局开始后锁定）
router.patch('/rooms/:roomId/settings', (req, res) => {
  const { roomId } = req.params;
  const { playerId, name, password, turnTimeSeconds, baseTimeSeconds, incrementSeconds, byoyomiSeconds, handicap } = req.body;

  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: '房间不存在' });
  }
  if (room.phase !== 'waiting') {
    return res.status(400).json({ error: '对局已开始，无法修改房间设置' });
  }
  if (room.players[0]?.id !== playerId) {
    return res.status(403).json({ error: '仅房主可修改房间设置' });
  }

  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed || trimmed.length > 5) {
      return res.status(400).json({ error: '房间名需为 1~5 个字符' });
    }
    room.name = trimmed;
  }
  if (password !== undefined) {
    // 空串/null 表示清除密码
    const pwd = String(password ?? '').trim();
    if (pwd && !/^\d{1,6}$/.test(pwd)) {
      return res.status(400).json({ error: '密码需为 6 位以内纯数字' });
    }
    room.password = pwd || null;
  }
  if (turnTimeSeconds !== undefined) {
    const secs = Number(turnTimeSeconds);
    if (!Number.isFinite(secs) || secs < 0 || secs > 3600) {
      return res.status(400).json({ error: '限时需在 0~3600 秒之间（0=不限时）' });
    }
    room.settings.turnTimeLimit = Math.round(secs);
  }
  if (baseTimeSeconds !== undefined || incrementSeconds !== undefined || byoyomiSeconds !== undefined) {
    // 未提供的维度沿用现值一并校验（不限时会把加秒/读秒归 0；加秒与读秒互斥）
    const parsed = parseClockSettings(
      baseTimeSeconds !== undefined ? baseTimeSeconds : room.settings.baseTimeSeconds,
      incrementSeconds !== undefined ? incrementSeconds : room.settings.incrementSeconds,
      byoyomiSeconds !== undefined ? byoyomiSeconds : room.settings.byoyomiSeconds,
    );
    if ('error' in parsed) {
      return res.status(400).json({ error: parsed.error });
    }
    room.settings.baseTimeSeconds = parsed.baseTimeSeconds;
    room.settings.incrementSeconds = parsed.incrementSeconds;
    room.settings.byoyomiSeconds = parsed.byoyomiSeconds;
  }
  if (handicap !== undefined) {
    const parsed = parseHandicap(handicap);
    if ('error' in parsed) {
      return res.status(400).json({ error: parsed.error });
    }
    room.settings.handicap = parsed.ids;
  }

  // 让子变更联动：新增让子且双方已就绪 → 跳过选边直接公示；清空让子 → 回退让子直分公示恢复选边
  if (room.settings.handicap.length > 0) {
    applyHandicapAutoReveal(room);
  } else {
    revertHandicapReveal(room);
  }

  res.json({
    success: true,
    room: {
      id: room.id,
      name: room.name,
      hasPassword: !!room.password,
      password: room.password,
      settings: room.settings,
    },
    sideReveal: room.sideReveal,
    gameStartAt: room.gameStartAt,
    serverNow: Date.now(),
  });
});

// 选择执棋方（双方均准备后开启；双方选定并公示前可自由更改）
// 选边核心逻辑（HTTP 与 WebSocket 共用）
export function actSide(roomId: string, body: Record<string, unknown>): ActionResult {
  const { playerId, side } = body as { playerId?: string; side?: string };

  const room = rooms.get(roomId);
  if (!room) {
    return { status: 404, body: { success: false, message: '房间不存在' } };
  }

  if (room.phase !== 'waiting') {
    return { status: 400, body: { success: false, message: '对局已开始' } };
  }

  // 让子房间跳过选边（双方就绪时服务端已直分公示：房主执红先行）
  if (room.settings.handicap.length > 0) {
    return { status: 400, body: { success: false, message: '让子对局由房主执红先行，无需选边' } };
  }

  if (side !== 'red' && side !== 'black') {
    return { status: 400, body: { success: false, message: '执棋方只能是 red 或 black' } };
  }

  const player = room.players.find(p => p.id === playerId);
  if (!player) {
    return { status: 404, body: { success: false, message: '玩家不在房间中' } };
  }

  // 选边环节在双方均准备后才开启
  if (room.players.length < 2 || !room.players.every(p => p.ready)) {
    return { status: 400, body: { success: false, message: '双方均准备后才能选边' } };
  }

  // 执棋结果已公示（双方均已选边）后锁定，不可再改
  if (room.sideReveal) {
    return { status: 400, body: { success: false, message: '执棋结果已公示，不能更改' } };
  }

  player.sidePreference = side;
  room.lastActivity = Date.now();

  // 双方均已选边 → 分配阵营并生成公示信息，同时锚定统一开局时刻（双端据此倒数，天然一致）
  if (room.players.every(p => p.sidePreference)) {
    const random = assignSides(room);
    room.sideReveal = { time: Date.now(), random };
    room.gameStartAt = room.sideReveal.time + START_COUNTDOWN_MS;
    return {
      status: 200,
      body: {
        success: true,
        sideAssigned: true,
        sideReveal: room.sideReveal,
        gameStartAt: room.gameStartAt,
        serverNow: Date.now(), // 上传方立即校正时钟偏移，无需等待下轮轮询
        players: room.players.map(p => ({ id: p.id, name: p.name, side: p.side, sidePreference: p.sidePreference })),
      },
    };
  }

  return { status: 200, body: { success: true, sideAssigned: false, sidePreference: player.sidePreference } };
}

router.post('/rooms/:roomId/side', (req, res) => {
  respondAction(res, req.params.roomId, actSide(req.params.roomId, req.body));
});

// 分配执棋方：双方意向不同（一红一黑）按意愿分配；意向相同或缺失则随机分配
function assignSides(room: Room): boolean {
  const [a, b] = room.players;
  const pa = a.sidePreference;
  const pb = b.sidePreference;
  if (pa && pb && pa !== pb) {
    a.side = pa;
    b.side = pb;
    return false;
  }
  const aRed = Math.random() < 0.5;
  a.side = aRed ? 'red' : 'black';
  b.side = aRed ? 'black' : 'red';
  return true;
}

// 玩家准备/取消准备（ready 缺省为 true 以兼容旧客户端；双方均准备后开启选边环节，
// 选边通过 /side 提交，双方选完自动分配公示；公示前取消准备会清空双方选边意向）
// 准备核心逻辑（HTTP 与 WebSocket 共用）
export function actReady(roomId: string, body: Record<string, unknown>): ActionResult {
  const { playerId } = body as { playerId?: string };
  const ready = (body as { ready?: boolean }).ready !== false; // 仅显式传 false 视为取消准备

  const room = rooms.get(roomId);
  if (!room) {
    return { status: 404, body: { success: false, message: '房间不存在' } };
  }

  if (room.phase !== 'waiting') {
    return { status: 400, body: { success: false, message: '对局已开始' } };
  }

  const player = room.players.find(p => p.id === playerId);
  if (!player) {
    return { status: 404, body: { success: false, message: '玩家不在房间中' } };
  }

  if (!ready) {
    // 选边已公示（开局倒数中）：不允许取消准备。公示一旦发出即锁定，
    // 避免与统一定时（gameStartAt）产生「一方取消、另一方仍倒数进局」的状态分叉
    if (room.sideReveal) {
      return { status: 400, body: { success: false, message: '选边已公示，无法取消准备' } };
    }
    // 公示前取消准备：双方已提交的选边意向随之失效，回到准备阶段重新确认
    room.players.forEach(p => {
      p.sidePreference = null;
      p.side = null;
    });
    room.gameStartAt = null;
  }
  player.ready = ready;
  room.lastActivity = Date.now();

  const bothReady = room.players.length === 2 && room.players.every(p => p.ready);
  // 让子房间双方就绪：跳过选边直接公示（房主执红先行）；触发方凭响应即刻开始公示倒数并担任上传方
  const autoRevealed = ready && bothReady && applyHandicapAutoReveal(room);

  return {
    status: 200,
    body: {
      success: true,
      bothReady, // 双方均准备 → 前端进入选边环节（让子房间除外：直接公示）
      autoRevealed,
      sideReveal: room.sideReveal,
      gameStartAt: room.gameStartAt,
      serverNow: Date.now(),
      players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready, side: p.side, sidePreference: p.sidePreference })),
    },
  };
}

router.post('/rooms/:roomId/ready', (req, res) => {
  respondAction(res, req.params.roomId, actReady(req.params.roomId, req.body));
});

// 开始对局（双方准备后，前端倒计时结束后调用）
// 开局核心逻辑（HTTP 与 WebSocket 共用）
export function actStart(roomId: string, body: Record<string, unknown>): ActionResult {
  const { playerId } = body as { playerId?: string };

  const room = rooms.get(roomId);
  if (!room) {
    return { status: 404, body: { success: false, message: '房间不存在' } };
  }

  // 校验：仅房间内玩家可开局
  if (!room.players.some(p => p.id === playerId)) {
    return { status: 403, body: { success: false, message: '仅房间内玩家可开始对局' } };
  }

  // 幂等：对局已开始（统一定时自动开局生效后上传方的 /start 才到达、或重复提交）→
  // 视为成功确认并返回当前纪元，调用方按正常开局流程继续，不得视为失败
  if (room.phase === 'playing') {
    return { status: 200, body: { success: true, gameStartTime: room.gameStartTime, matchId: room.matchId, alreadyStarted: true } };
  }

  // 校验：双方就位、均已准备且阵营分配完整，防止提前开局导致无阵营/缺人
  if (room.players.length < 2) {
    return { status: 400, body: { success: false, message: '玩家未齐，无法开局' } };
  }
  if (!room.players.every(p => p.ready)) {
    return { status: 400, body: { success: false, message: '尚有玩家未准备，无法开局' } };
  }
  const sides = room.players.map(p => p.side);
  if (!sides.includes('red') || !sides.includes('black')) {
    return { status: 400, body: { success: false, message: '阵营未分配完整，无法开局' } };
  }
  // 校验：公示必须仍然有效（倒计时窗口内被取消后 sideReveal/gameStartAt 已清空，残留的开局请求一律拒绝）
  if (!room.sideReveal || !room.gameStartAt) {
    return { status: 400, body: { success: false, message: '开局已取消，无法开始对局' } };
  }
  // 校验：必须到达服务端锚定的统一开局时刻（留少量容差抵消网络往返）
  if (Date.now() < room.gameStartAt - START_TOLERANCE_MS) {
    return { status: 400, body: { success: false, message: '开局时刻未到，请稍候' } };
  }

  room.phase = 'playing';
  room.matchId += 1; // 对局纪元 +1：客户端据此识别新局，重赛后的旧快照（旧 matchId）一律忽略
  room.gameStartTime = Date.now();
  room.gameStartAt = null; // 开局时刻已消费
  room.lastMoveTime = Date.now();
  room.lastActivity = Date.now();
  // 局时时钟初始化（基本用时+加秒制；局时为 0 表示不限时，不启用时钟）
  room.clocks = room.settings.baseTimeSeconds > 0
    ? { red: room.settings.baseTimeSeconds * 1000, black: room.settings.baseTimeSeconds * 1000 }
    : null;
  // 心跳基线对齐到开局时刻：等待阶段没有心跳流动，若沿用加入时刻的旧基线，
  // 开局瞬间的心跳超时检测会把双方误判为断线
  room.players.forEach((p) => { p.lastHeartbeat = Date.now(); });

  return { status: 200, body: { success: true, gameStartTime: room.gameStartTime, matchId: room.matchId } };
}

router.post('/rooms/:roomId/start', (req, res) => {
  respondAction(res, req.params.roomId, actStart(req.params.roomId, req.body));
});

// 走棋核心逻辑（HTTP 与 WebSocket 共用）
export function actMove(roomId: string, body: Record<string, unknown>): ActionResult {
  const room = rooms.get(roomId);
  if (!room) {
    return { status: 404, body: { error: '房间不存在' } };
  }

  // ---- 新协议：服务端权威走子裁决（方案 P0，客户端只发着法 {playerId, move}） ----
  if (body && body.move && typeof body.move === 'object') {
    const { playerId, move } = body as { playerId?: string; move: { pieceId: number; toCol: number; toRow: number } };
    if (room.phase !== 'playing' || !room.gameState) {
      return { status: 400, body: { success: false, message: '对局未在进行中' } };
    }
    const player = room.players.find(p => p.id === playerId);
    if (!player || !player.side) {
      return { status: 400, body: { success: false, message: '玩家不在房间中或未分配阵营' } };
    }
    const mySide = player.side;
    const state = room.gameState;
    const stateSideIsRed = state.sideTag === true || state.sideTag === 'red';
    if (stateSideIsRed !== (mySide === 'red')) {
      return { status: 400, body: { success: false, message: '不是你的回合' } };
    }
    const { pieceId, toCol, toRow } = move;
    if (!Number.isInteger(pieceId) || !Number.isInteger(toCol) || !Number.isInteger(toRow)) {
      return { status: 400, body: { success: false, message: '着法格式错误' } };
    }
    // 走法合法性校验（含王安全过滤），杜绝客户端伪造着法
    const valid = ruleEngine.getValidMoves(state, pieceId);
    if (!valid[toCol] || !valid[toCol][toRow]) {
      return { status: 400, body: { success: false, message: '非法走法' } };
    }
    // 服务端权威裁决：与客户端同一规则引擎执行走子（含长将长捉判定与终局）
    // 长将长捉超限不再拦截落子、不再按违规次数判负（方案 10 娱乐向改造）：
    // banMoves 仅用于客户端棋盘标红提示；双方僵持不下由自然限招/互长将互长捉判和收场。
    // 加固：历史上前身是直接注入 dist 的补丁，现已归位到源码（改这里即可，改完在 chinese-chess-server/ 下跑 node build.js）。
    const result = ruleEngine.makeMove(state, pieceId, toCol, toRow);
    if (room.clocks && room.lastMoveTime) {
      const elapsed = (room.clockPausedAt ?? Date.now()) - room.lastMoveTime;
      room.clocks[mySide] = Math.max(0, room.clocks[mySide] - elapsed) + room.settings.incrementSeconds * 1000;
    }
    room.gameState = result.newState;
    room.lastMoveTime = Date.now();
    room.clockPausedAt = null;
    room.lastActivity = Date.now();
    room.pendingUndo = null;
    room.pendingDraw = null;
    if (result.isGameOver) {
      room.phase = 'ended';
      if (result.newState.gameStatus === 'draw') {
        room.winner = null;
        room.endReason = 'draw';
      } else {
        room.winner = result.newState.gameStatus === 'red_win' ? 'red' : 'black';
        room.endReason = 'checkmate';
      }
    }
    return { status: 200, body: { success: true } };
  }

  // ---- 旧协议（初始局面上传/兼容）：客户端上传完整状态，直接存储 ----
  const { gameState, gameOver, winner } = body as {
    gameState?: Record<string, unknown>;
    gameOver?: boolean;
    winner?: 'red' | 'black' | 'draw' | null;
  };

  // 局时扣时（加秒制/读秒制）：走棋方 = 新局面 sideTag 的另一方；从其时钟扣除本步耗时。
  // 加秒制（菲舍尔）：扣时后补回加秒；读秒制：仅扣时（基本用时耗尽进入读秒后，走棋即自动获得下一完整读秒时段，无需补偿）。
  // 读秒制下本步耗时若溢出基本用时，溢出部分视为消耗了本步的读秒时段，钟面归 0 即可
  // 以 moveHistory 增长判定「真实走棋」，初始局面上传/失败重传（步数不变）不扣时
  const prevMoveCount = Array.isArray((room.gameState as { moveHistory?: unknown[] } | null)?.moveHistory)
    ? (room.gameState as { moveHistory: unknown[] }).moveHistory.length
    : 0;
  const nextMoveCount = Array.isArray((gameState as { moveHistory?: unknown[] } | undefined)?.moveHistory)
    ? (gameState as { moveHistory: unknown[] }).moveHistory.length
    : 0;
  // 初始局面上传收紧：仅房内玩家、且仅在本局尚未产生任何着法时可上传（防匿名改写棋盘/伪造胜负）。
  // 理由：该分支是「旧协议完整局面上传」，唯一合法用途是建立初始局面；
  // 若不加这道校验，任何人仅凭房间号就能越过规则引擎直接改写对局棋盘并伪造胜负。
  // 约束「本局尚无着法」而非「阶段为 waiting」：waiting 阶段 room.gameState 本就为 null，
  // 而在线对局在选边公示结束前就可能已把 phase 置为 playing，此时客户端上传的正是第一个局面，
  // 若改判 phase 会把唯一合法上传路径一起拒掉、导致对局永远没有棋盘。
  // 加固：历史上前身是直接注入 dist 的补丁，现已归位到源码（改这里即可，改完在 chinese-chess-server/ 下跑 node build.js）。
  var uploader = room.players && room.players.find(function (p) { return p.id === (body.playerId as string); });
  if (!uploader) {
    return { status: 403, body: { success: false, error: 'forbidden', message: '仅房间内玩家可上传初始局面' } };
  }
  if (prevMoveCount !== 0 || nextMoveCount !== 0) {
    return { status: 403, body: { success: false, error: 'forbidden', message: '本局已产生着法，不接受完整局面上传' } };
  }
  if (room.clocks && nextMoveCount > prevMoveCount && room.lastMoveTime) {
    const nextSideTag = (gameState as { sideTag?: unknown }).sideTag;
    // sideTag 为引擎布尔值（RED_SIDE=true）；兼容字符串形式
    const mover: 'red' | 'black' = (nextSideTag === true || nextSideTag === 'red') ? 'black' : 'red';
    // 协商暂停期间抵达的走棋：耗时冻结在暂停时刻，请求方不为协商耗时买单
    const elapsed = (room.clockPausedAt ?? Date.now()) - room.lastMoveTime;
    room.clocks[mover] = Math.max(0, room.clocks[mover] - elapsed) + room.settings.incrementSeconds * 1000;
    // 注：读秒制时 incrementSeconds 恒为 0（互斥校验保证），上式天然退化为纯扣时，无需分支
  }

  room.gameState = gameState as Room['gameState'];
  room.lastMoveTime = Date.now();
  room.clockPausedAt = null; // 走棋开启新计时段，棋钟随协商失效自然恢复（无需顺延）
  room.lastActivity = Date.now();
  // 新的走棋使待处理的悔棋/求和请求失效
  room.pendingUndo = null;
  room.pendingDraw = null;
  return { status: 200, body: { success: true } };
}

router.post('/rooms/:roomId/gameState', (req, res) => {
  respondAction(res, req.params.roomId, actMove(req.params.roomId, req.body));
});

// 获取游戏状态（HTTP 轮询通道：大厅/观战/兜底仍使用；对局中客户端主要由 WebSocket 推送）
router.get('/rooms/:roomId/gameState', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);

  if (!room) {
    return res.status(404).json({ error: '房间不存在' });
  }

  // 惰性清理与断线检测（与 gameTickTimer 幂等，双保险）
  expirePendingUndo(room);
  expirePendingDraw(room);
  pruneSpectators(room);
  pruneEmojis(room);
  detectDisconnect(room);

  res.json(buildGameStatePayload(room));
});

// 进入观战：仅对战中的房间可旁观（注册观战者并返回当前局面快照）
router.post('/rooms/:roomId/spectate', (req, res) => {
  const { roomId } = req.params;
  const { spectatorId, spectatorName } = req.body;
  const room = rooms.get(roomId);

  if (!room) {
    return res.status(404).json({ success: false, message: '房间不存在' });
  }
  if (!spectatorId) {
    return res.status(400).json({ success: false, message: '缺少观战者标识' });
  }
  if (room.phase === 'waiting') {
    return res.status(400).json({ success: false, message: '对局尚未开始，暂无法观战' });
  }
  // 席位不完整（一方已离场）时不再放行：否则观战者会进入一个只有单边棋子的「空局」，
  // 名称角标只能落到「红方/黑方」占位文本上。提示按「对局已终止」表述，避免观战者误判为网络问题。
  if (!hasCompleteSeating(room)) {
    return res.status(400).json({ success: false, message: '对局已有玩家离开，观战已结束' });
  }

  pruneSpectators(room);
  const name = (typeof spectatorName === 'string' && spectatorName.trim()) ? spectatorName.trim().slice(0, 16) : '观众';
  const existing = room.spectators.find(s => s.id === spectatorId);
  if (existing) {
    existing.lastSeen = Date.now();
    existing.name = name;
  } else {
    room.spectators.push({ id: spectatorId, name, lastSeen: Date.now() });
  }

  res.json({
    success: true,
    roomId,
    roomName: room.name,
    phase: room.phase,
    gameState: room.gameState,
    settings: room.settings,
    gameStartTime: room.gameStartTime,
    winner: room.winner,
    surrenderBy: room.surrenderBy,
    spectatorCount: room.spectators.length,
    players: room.players.map(p => ({ id: p.id, name: p.name, side: p.side, connected: p.connected })),
  });
});

// 观战心跳：观战页定期调用以保持在场并刷新人数
router.post('/rooms/:roomId/spectate/heartbeat', (req, res) => {
  const { roomId } = req.params;
  const { spectatorId } = req.body;
  const room = rooms.get(roomId);

  if (!room) {
    return res.status(404).json({ success: false, message: '房间不存在' });
  }
  pruneSpectators(room);
  const existing = room.spectators.find(s => s.id === spectatorId);
  if (existing) {
    existing.lastSeen = Date.now();
  }
  res.json({ success: true, phase: room.phase, spectatorCount: room.spectators.length });
});

// 退出观战
router.post('/rooms/:roomId/spectate/leave', (req, res) => {
  const { roomId } = req.params;
  const { spectatorId } = req.body;
  const room = rooms.get(roomId);

  if (!room) {
    return res.status(404).json({ success: false, message: '房间不存在' });
  }
  room.spectators = room.spectators.filter(s => s.id !== spectatorId);
  res.json({ success: true, spectatorCount: room.spectators.length });
});

// 认输核心逻辑（HTTP 与 WebSocket 共用）
export function actSurrender(roomId: string, body: Record<string, unknown>): ActionResult {
  const { playerId } = body as { playerId?: string };

  const room = rooms.get(roomId);
  if (!room) {
    return { status: 404, body: { success: false, message: '房间不存在' } };
  }

  if (room.phase !== 'playing') {
    return { status: 400, body: { success: false, message: '对局未在进行中' } };
  }

  const player = room.players.find(p => p.id === playerId);
  if (!player) {
    return { status: 404, body: { success: false, message: '玩家不在房间中' } };
  }

  // 认输方为输家，对方为赢家
  const winnerSide = player.side === 'red' ? 'black' : 'red';
  room.winner = winnerSide as 'red' | 'black';
  room.surrenderBy = playerId as string;
  room.endReason = 'resign';
  room.phase = 'ended';
  room.clockPausedAt = null; // 终局清空暂停锚点，保持载荷干净
  room.lastActivity = Date.now();

  const duration = room.gameStartTime ? Date.now() - room.gameStartTime : 0;
  const moveCount = room.gameState?.moveHistory?.length || 0;

  return {
    status: 200,
    body: { success: true, winner: winnerSide, surrenderBy: playerId, duration, moveCount },
  };
}

router.post('/rooms/:roomId/surrender', (req, res) => {
  respondAction(res, req.params.roomId, actSurrender(req.params.roomId, req.body));
});

// 重新对局核心逻辑（重置房间状态；HTTP 与 WebSocket 共用）
export function actRematch(roomId: string, _body: Record<string, unknown>): ActionResult {
  const room = rooms.get(roomId);
  if (!room) {
    return { status: 404, body: { success: false, message: '房间不存在' } };
  }

  // 幂等：仅在结算阶段执行重置。房间已回到等待/对局中（对方已先发起重赛、或本端
  // 重复点击/延迟重试）时直接确认成功——否则二次重置会清掉对方已提交的准备状态，
  // 表现为「准备跳回」；重赛落到公示倒数窗口还会清掉公示导致开局失败
  if (room.phase !== 'ended') {
    return { status: 200, body: { success: true } };
  }

  // 重置房间状态
  room.phase = 'waiting';
  room.gameState = null;
  room.gameStartTime = null;
  room.gameStartAt = null;
  room.clocks = null; // 时钟随下一局开局重新初始化
  // matchId 保持不变：客户端据此识别「上一局旧快照」（matchId 不增即旧局），替代跨时钟时间戳比较
  room.lastMoveTime = null;
  room.clockPausedAt = null; // 重开一局清空暂停锚点
  room.winner = null;
  room.surrenderBy = null;
  room.endReason = null;
  room.disconnectedPlayerId = null;
  room.disconnectTime = null;
  room.pendingUndo = null;
  room.undoResult = null;
  room.pendingDraw = null;
  room.drawResult = null;
  room.sideReveal = null;
  room.emojiMessages = [];
  room.returnedToRoom = {};
  room.players.forEach(p => {
    p.ready = false;
    p.side = null;
    p.sidePreference = null;
    p.connected = true;
    p.lastHeartbeat = Date.now();
    p.undoRefusals = 0; // 新一局重置悔棋被拒计数
    p.drawRefusals = 0; // 新一局重置求和被拒计数
  });
  room.lastActivity = Date.now();

  return { status: 200, body: { success: true } };
}

router.post('/rooms/:roomId/rematch', (req, res) => {
  respondAction(res, req.params.roomId, actRematch(req.params.roomId, req.body));
});

// 请求悔棋核心逻辑（HTTP 与 WebSocket 共用）
export /**
 * 结算后的「返回房间」：把房间重置回等待中，供返回者自行准备。
 *
 * 与 /rematch 的区别在「谁被重置」：两者都是房间级重置，但 /rematch 是发起者单方面决定
 * 把对手一起拽回（用户反馈的 BUG）。本动作把决定权交给双方——重置后房间即为 waiting，
 * 但对手端不会自动跟随（客户端仅在自己也点击过返回、或 10s 兜底到期时才切换），
 * 因此对手仍停留在结算页自行决定去留，互不干扰。
 *
 * returnedToRoom 记录每位玩家已返回的时刻，客户端据此判断「对手是否已回房间」，
 * 并作为 10s 兜底倒计时的时间基准（由 expireReturnedPlayers 定期清理）。
 */
function actReturnToRoom(roomId: string, body: Record<string, unknown>): ActionResult {
  const { playerId } = body as { playerId?: string };
  const room = rooms.get(roomId);
  if (!room) {
    return { status: 404, body: { success: false, message: '房间不存在' } };
  }
  const player = room.players.find(p => p.id === playerId);
  if (!player) {
    return { status: 404, body: { success: false, message: '玩家不在房间中' } };
  }
  if (room.phase !== 'ended') {
    // 房间已不在结算阶段（重复点击，或对手已重置）：幂等返回当前状态
    return { status: 200, body: { success: true, phase: room.phase } };
  }
  if (!room.returnedToRoom) room.returnedToRoom = {};
  // 房间回到等待中：返回者可立即自行准备/选边；对手端不自动跟随（见上方注释）
  actRematch(roomId, {});
  // 必须在 actRematch 之后写：actRematch 会清空 returnedToRoom
  room.returnedToRoom[playerId!] = Date.now();
  return { status: 200, body: { success: true, phase: room.phase } };
}
/**
 * 「返回房间」记录清理：
 *   · 离席玩家的记录（覆盖 /leave、healStaleEndedRoom 等摘除成员的路径）——必须立即清理，
 *     否则留下的人会一直看到「对手已返回房间」；
 *   · 超过 TTL 的旧记录——兜底清理，避免无限增长。
 *
 * TTL 必须**大于**客户端的结算兜底倒计时（RETURN_ROOM_FALLBACK_SECONDS = 10s），且要留出
 * 轮询/WS 传达的余量：若服务端与客户端的 10s 几乎同时到点，记录会先被清掉，对手端就永远
 * 看不到「对手已返回房间」提示（实测双方倒计时同步时该提示一闪即逝）。取 30s。
 */
var RETURNED_GRACE_MS = 30 * 1e3;
function expireReturnedPlayers(room: Room, now: number): boolean {
  if (!room.returnedToRoom) return false;
  const ids = Object.keys(room.returnedToRoom);
  if (ids.length === 0) return false;
  const seated = new Set(room.players.map(p => p.id));
  let changed = false;
  ids.forEach(id => {
    if (!seated.has(id) || now - room.returnedToRoom![id] >= RETURNED_GRACE_MS) {
      delete room.returnedToRoom![id];
      changed = true;
    }
  });
  if (changed) room.lastActivity = now;
  return changed;
}
router.post('/rooms/:roomId/returnToRoom', (req, res) => {
  respondAction(res, req.params.roomId, actReturnToRoom(req.params.roomId, req.body));
});
export function actUndo(roomId: string, body: Record<string, unknown>): ActionResult {
  const { playerId, proposedState } = body as { playerId?: string; proposedState?: Room['gameState'] };

  const room = rooms.get(roomId);
  if (!room) {
    return { status: 404, body: { success: false, message: '房间不存在' } };
  }

  if (room.phase !== 'playing') {
    return { status: 400, body: { success: false, message: '对局未在进行中' } };
  }

  const player = room.players.find(p => p.id === playerId);
  if (!player) {
    return { status: 404, body: { success: false, message: '玩家不在房间中' } };
  }

  if (!proposedState) {
    return { status: 400, body: { success: false, message: '缺少悔棋目标局面' } };
  }

  if (room.pendingUndo) {
    return { status: 400, body: { success: false, message: '已有待处理的悔棋请求' } };
  }

  // 悔棋请求连续被对方拒绝 2 次后，本局禁止再发起悔棋
  if (player.undoRefusals >= MAX_NEGOTIATION_REFUSALS) {
    return { status: 400, body: { success: false, message: '对方已连续拒绝 2 次，本局不能再发起悔棋' } };
  }

  room.pendingUndo = { playerId: playerId as string, proposedState, requestTime: Date.now() };
  room.undoResult = null;
  pauseClock(room); // 悔棋协商期间暂停棋钟
  room.lastActivity = Date.now();

  return {
    status: 200,
    body: { success: true, message: '悔棋请求已发送，等待对方同意', pending: true },
  };
}

router.post('/rooms/:roomId/undo', (req, res) => {
  respondAction(res, req.params.roomId, actUndo(req.params.roomId, req.body));
});

// 同意/拒绝悔棋核心逻辑（仅对方玩家可响应；HTTP 与 WebSocket 共用）
export function actUndoResponse(roomId: string, body: Record<string, unknown>): ActionResult {
  const { playerId, agreed } = body as { playerId?: string; agreed?: boolean };

  const room = rooms.get(roomId);
  if (!room) {
    return { status: 404, body: { success: false, message: '房间不存在' } };
  }

  if (!room.pendingUndo) {
    return { status: 400, body: { success: false, message: '没有待处理的悔棋请求' } };
  }

  if (room.pendingUndo.playerId === playerId) {
    return { status: 400, body: { success: false, message: '不能响应自己的悔棋请求' } };
  }

  // 鉴权：仅房间内对方玩家可响应，防止观众或任意 ID 冒充同意
  const undoResponder = room.players.find(p => p.id === playerId);
  if (!undoResponder) {
    return { status: 403, body: { success: false, message: '仅房间内玩家可响应悔棋请求' } };
  }

  const requesterId = room.pendingUndo.playerId;
  resumeClock(room); // 协商结束，棋钟恢复（同意时随后以当前时刻重新计时）
  // 悔棋结果计入发起方的悔棋连续被拒计数：拒绝 +1，同意清零（重开一局时统一重置）
  const undoRequester = room.players.find(p => p.id === requesterId);
  if (undoRequester) {
    undoRequester.undoRefusals = agreed ? 0 : undoRequester.undoRefusals + 1;
  }
  if (agreed) {
    // 应用悔棋后的局面，双方客户端通过 WebSocket/轮询同步
    room.gameState = room.pendingUndo.proposedState;
    room.lastMoveTime = Date.now();
  }

  room.undoResult = {
    playerId: requesterId,
    agreed: !!agreed,
    reason: agreed ? 'agreed' : 'refused',
    time: Date.now(),
  };
  room.pendingUndo = null;
  room.lastActivity = Date.now();

  return { status: 200, body: { success: true, agreed: !!agreed } };
}

router.post('/rooms/:roomId/undoResponse', (req, res) => {
  respondAction(res, req.params.roomId, actUndoResponse(req.params.roomId, req.body));
});

// 请求求和核心逻辑（HTTP 与 WebSocket 共用）
export function actDraw(roomId: string, body: Record<string, unknown>): ActionResult {
  const { playerId } = body as { playerId?: string };

  const room = rooms.get(roomId);
  if (!room) {
    return { status: 404, body: { success: false, message: '房间不存在' } };
  }

  if (room.phase !== 'playing') {
    return { status: 400, body: { success: false, message: '对局未在进行中' } };
  }

  const player = room.players.find(p => p.id === playerId);
  if (!player) {
    return { status: 404, body: { success: false, message: '玩家不在房间中' } };
  }

  if (room.pendingDraw) {
    return { status: 400, body: { success: false, message: '已有待处理的求和请求' } };
  }

  // 求和请求连续被对方拒绝 2 次后，本局禁止再发起求和
  if (player.drawRefusals >= MAX_NEGOTIATION_REFUSALS) {
    return { status: 400, body: { success: false, message: '对方已连续拒绝 2 次，本局不能再发起求和' } };
  }

  room.pendingDraw = { playerId: playerId as string, requestTime: Date.now() };
  room.drawResult = null;
  pauseClock(room); // 求和协商期间暂停棋钟
  room.lastActivity = Date.now();

  return {
    status: 200,
    body: { success: true, message: '求和请求已发送，等待对方同意', pending: true },
  };
}

router.post('/rooms/:roomId/draw', (req, res) => {
  respondAction(res, req.params.roomId, actDraw(req.params.roomId, req.body));
});

// 同意/拒绝求和核心逻辑（仅对方玩家可响应；同意则对局以和棋结束；HTTP 与 WebSocket 共用）
export function actDrawResponse(roomId: string, body: Record<string, unknown>): ActionResult {
  const { playerId, agreed } = body as { playerId?: string; agreed?: boolean };

  const room = rooms.get(roomId);
  if (!room) {
    return { status: 404, body: { success: false, message: '房间不存在' } };
  }

  if (!room.pendingDraw) {
    return { status: 400, body: { success: false, message: '没有待处理的求和请求' } };
  }

  if (room.pendingDraw.playerId === playerId) {
    return { status: 400, body: { success: false, message: '不能响应自己的求和请求' } };
  }

  // 鉴权：仅房间内对方玩家可响应，防止观众或任意 ID 冒充同意
  const drawResponder = room.players.find(p => p.id === playerId);
  if (!drawResponder) {
    return { status: 403, body: { success: false, message: '仅房间内玩家可响应求和请求' } };
  }

  const requesterId = room.pendingDraw.playerId;
  resumeClock(room); // 求和协商结束，棋钟恢复（同意时对局即终局，清锚点保持载荷干净）
  // 求和结果计入发起方的求和连续被拒计数：拒绝 +1，同意清零（重开一局时统一重置）
  const drawRequester = room.players.find(p => p.id === requesterId);
  if (drawRequester) {
    drawRequester.drawRefusals = agreed ? 0 : drawRequester.drawRefusals + 1;
  }
  if (agreed) {
    // 和棋结束：无胜负方，双方客户端通过 WebSocket/轮询同步结算
    room.winner = null;
    room.surrenderBy = null;
    room.endReason = 'draw';
    room.phase = 'ended';
  }

  room.drawResult = {
    playerId: requesterId,
    agreed: !!agreed,
    reason: agreed ? 'agreed' : 'refused',
    time: Date.now(),
  };
  room.pendingDraw = null;
  room.lastActivity = Date.now();

  return { status: 200, body: { success: true, agreed: !!agreed } };
}

router.post('/rooms/:roomId/drawResponse', (req, res) => {
  respondAction(res, req.params.roomId, actDrawResponse(req.params.roomId, req.body));
});

// 发送 emoji 表情核心逻辑（对局内互动；HTTP 与 WebSocket 共用）
export function actEmoji(roomId: string, body: Record<string, unknown>): ActionResult {
  const { playerId, emoji, id } = body as { playerId?: string; emoji?: string; id?: string };

  const room = rooms.get(roomId);
  if (!room) {
    return { status: 404, body: { success: false, message: '房间不存在' } };
  }

  // 鉴权：仅房间内玩家可发送表情
  const player = room.players.find(p => p.id === playerId);
  if (!player) {
    return { status: 403, body: { success: false, message: '仅房间内玩家可发送表情' } };
  }

  if (!emoji || typeof emoji !== 'string') {
    return { status: 400, body: { success: false, message: '表情内容不能为空' } };
  }

  pruneEmojis(room);

  const emojiText = emoji.slice(0, 8); // 防超长
  // 客户端生成唯一 id 用于去重（乐观展示 + 回显不重复）；缺省时服务端兜底生成
  const msgId = (typeof id === 'string' && id.trim())
    ? id.trim().slice(0, 64)
    : `${playerId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  if (!room.emojiMessages.some(m => m.id === msgId)) {
    room.emojiMessages.push({ id: msgId, playerId: playerId as string, emoji: emojiText, time: Date.now() });
  }
  room.lastActivity = Date.now();

  return { status: 200, body: { success: true, emojiMessage: { id: msgId, playerId, emoji: emojiText } } };
}

router.post('/rooms/:roomId/emoji', (req, res) => {
  respondAction(res, req.params.roomId, actEmoji(req.params.roomId, req.body));
});

// 心跳核心逻辑（HTTP 与 WebSocket 共用）：刷新心跳并在断线恢复时清除断线状态
export function actHeartbeat(roomId: string, body: Record<string, unknown>): ActionResult {
  const { playerId, hidden } = body as { playerId?: string; hidden?: boolean };

  const room = rooms.get(roomId);
  if (!room) {
    return { status: 404, body: { error: '房间不存在' } };
  }

  const player = room.players.find(p => p.id === playerId);
  if (player) {
    const now = Date.now();
    player.lastHeartbeat = now;
    // 可见性上报：后台标签页（浏览器节流定时器）由服务端宽容判定，避免切后台被误判断线。
    // hiddenSince 只在「进入后台」的那一刻记录，用于限制单次连续后台的保护时长。
    if (hidden === true) {
      if (!player.hidden) player.hiddenSince = now;
      player.hidden = true;
    } else if (hidden === false) {
      player.hidden = false;
      player.hiddenSince = 0;
    }
    if (!player.connected) {
      player.connected = true;
    }
    // 心跳恢复即视为回到对局：撤销断线等待，避免「已上线却仍按旧计时判负」
    if (room.disconnectedPlayerId === playerId) {
      room.disconnectedPlayerId = null;
      room.disconnectTime = null;
    }
  }
  room.lastActivity = Date.now();
  return { status: 200, body: { success: true } };
}

router.post('/rooms/:roomId/heartbeat', (req, res) => {
  respondAction(res, req.params.roomId, actHeartbeat(req.params.roomId, req.body));
});

// 重新连接（断线后真正回到对局页面时由客户端显式调用）——
// 这是唯一清除断线等待状态的入口：WS 连接/心跳恢复仅代表连接层上线，
// 不代表玩家已回到房间；玩家实际进入对局页并调用本接口才算重连成功
router.post('/rooms/:roomId/reconnect', (req, res) => {
  const { roomId } = req.params;
  const { playerId } = req.body;

  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ success: false, message: '房间不存在' });
  }

  const player = room.players.find(p => p.id === playerId);
  if (!player) {
    return res.status(404).json({ success: false, message: '玩家不在房间中' });
  }

  // 恢复连接
  player.connected = true;
  player.lastHeartbeat = Date.now();
  // 显式重连即代表玩家回到前台对局：清除后台标记，恢复正常判定
  player.hidden = false;
  player.hiddenSince = 0;

  // 清除断线状态（若有）
  if (room.disconnectedPlayerId === playerId) {
    room.disconnectedPlayerId = null;
    room.disconnectTime = null;
  }

  room.lastActivity = Date.now();

  // 无论此前是否处于断线等待都广播一次最新状态（幂等），让对端立即刷新并取消断线倒计时
  roomBroadcaster(room);

  res.json({
    success: true,
    gameState: room.gameState,
    phase: room.phase,
    players: room.players.map(p => ({ id: p.id, name: p.name, side: p.side, connected: p.connected })),
  });
});

// 离开房间
router.post('/rooms/:roomId/leave', (req, res) => {
  const { roomId } = req.params;
  const { playerId } = req.body;

  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: '房间不存在' });
  }

  const wasHost = room.hostId === playerId;
  // 对局中离场：先裁定本局，再摘除成员。
  // 顺序不能颠倒——settleAbandonedPlayingRoom 依赖离场者仍在席来读其阵营并区分「离场者/留下者」，
  // 也依赖人数关系判断是「1v0 直接销毁」还是「1v1 判对方胜」。
  const abandoned = settleAbandonedPlayingRoom(room, playerId);
  const settled = abandoned && rooms.has(roomId);
  room.players = room.players.filter(p => p.id !== playerId);
  // 离场者的返回记录必须清除：否则会残留到 10s 兜底清理
  if (room.returnedToRoom) delete room.returnedToRoom[playerId];
  room.lastActivity = Date.now();

  if (room.players.length === 0) {
    rooms.delete(roomId);
  } else {
    // 房主离开且房间仍有人留存：留存玩家自动继任房主（让子自动取消）
    // （典型场景：对局结束后原房主退回首页，另一方退回房间成为新房主）
    if (wasHost) {
      transferHost(room);
    }
    if (room.phase === 'waiting') {
      // 等待阶段有人离开：重置剩余玩家的准备与选边，与新对手重新确认
      room.players.forEach(p => {
        p.ready = false;
        p.sidePreference = null;
        p.side = null;
      });
      room.sideReveal = null;
      room.gameStartAt = null;
    } else if (room.phase === 'ended' && !settled) {
      // 结算态离场：按原语义把房间重置为等待中，供留下的人另起一局。
      // 但若是本次离场刚刚触发的结算（settled），必须停在 ended：
      // 立刻 rematch 会把 winner/endReason 冲掉，胜方将永远看不到「对手离开了对局」这一结果。
      // 该局不完整，是否再战由留下的人通过结算浮层自行决定。
      actRematch(roomId, {});
    }
  }
  // 离场是一次权威状态变更：必须广播，让留下的玩家立刻收到终局，而不是等 2s 轮询才发现
  if (rooms.has(roomId)) roomBroadcaster(rooms.get(roomId)!);
  res.json({ success: true, endReason: settled ? 'leave' : room.endReason ?? null });
});

export default router;

