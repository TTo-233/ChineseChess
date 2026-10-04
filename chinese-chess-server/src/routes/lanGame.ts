import crypto from 'node:crypto';
import express from 'express';
import type { Request, Response } from 'express';

// 长将长捉规则引擎（服务端权威裁决，方案 P0）：与客户端共享同一份源码，
// 由 client/utils/chess/ruleEngine.bundle.ts 经 esbuild 编译为 ../ruleEngine.cjs
import ruleEngine from '../ruleEngine.cjs';

const router = express.Router();

// ============================================================================
// 【S-1 / §3.1】身份认证：sessionToken
//
// 改造前：playerId 全由客户端自报（createInitialState 之外的所有路由都以 body.playerId
// 定位成员），任何知道 roomId + playerId 的人都能替对方「重连」清零断线判负倒计时、
// 替对方「认输/求和/回房间」，甚至替对方走棋。
//
// 改造后：加入房间时由服务端签发 sessionToken（32 字节加密随机，base64url 编码），
// 它才是成员身份的唯一凭据；playerId 退化为**显示用标识**，不再参与任何鉴权。
// token 通过 `x-session-token` 头或 body.sessionToken 传递（WebSocket 用 URL query）。
//
// 三条刻意保留的边界，避免把它做成"看起来更安全"的假象：
//   1. 观战者不需要 token：观战没有任何写操作，身份只用于把观众从列表里摘掉。
//   2. GET 类只读路由（房间详情 / 局面 / 房间列表 / active）仍按 playerId 或不校验：
//      它们不产生副作用，读到的信息在"能猜到房间号"的前提下本来就无法保密。
//   3. POST /rooms/:id/join 的幂等重入仍按 playerId 匹配——因为这条路径的语义就是
//      "客户端会话丢失后凭 playerId 找回席位"，此时它手上必然没有可用 token。
//      残余风险是"拿到别人 playerId 的人可以顶掉对方昵称并把对方标记为在线"，
//      彻底消除需要客户端在退出房间时显式注销会话（属于下一步工作）。
// ============================================================================

// token 字节数：32 字节 = 256 bit，远超 128 bit 下限
const SESSION_TOKEN_BYTES = 32;

// 签发新 token。房间创建与新成员加入时各签发一次。
function issueSessionToken(): string {
  return crypto.randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

// 常量时间比较，避免 token 被逐字节爆破（时序侧信道）。
// 先比长度是因为 timingSafeEqual 要求两个 Buffer 等长，长度本身不是秘密。
function tokenEquals(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// 从请求里取 token：头优先，其次 body（客户端早期实现走 body），最后 query（WS 专用）。
function readSessionToken(req: Request): string {
  const header = req.headers['x-session-token'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (typeof fromHeader === 'string' && fromHeader) return fromHeader;
  const fromBody = req.body?.sessionToken;
  if (typeof fromBody === 'string' && fromBody) return fromBody;
  const fromQuery = req.query.sessionToken;
  return typeof fromQuery === 'string' ? fromQuery : '';
}

// 按 token 定位房间成员。
// 导出供 battleWs.ts 复用（WS 握手同样必须校验 token，见 S-1 / §3.1）
export function findPlayerByToken(room: Room, token: string): Player | null {
  if (!token) return null;
  return room.players.find(p => tokenEquals(p.sessionToken, token)) ?? null;
}

// 鉴权失败的统一响应形状（第 3 批：全端只此一种失败形状，见 ./actionOutcome 的 failBody）
function FORBIDDEN(message = '身份校验失败，请重新进入房间'): ActionResult {
  return actionFailure(403, message, {}, 'forbidden');
}

// 玩家对象对外下发前剔除 token：任何把 room 整体 json 出去的路由都必须过这一层，
// 否则 token 会随房间负载泄给同房间的**对方**（房主能 GET 到 members 就算失败）。
function stripPlayerToken(player: Player): Omit<Player, 'sessionToken'> {
  const { sessionToken: _secret, ...rest } = player;
  return rest;
}

// 房间对象对外下发前剔除成员 token：只浅拷贝一层并替换 players 数组，
// 其余字段（settings/gameState/clocks 等）都是共享引用，且不含任何凭据。
function stripRoomTokens(room: Room): Omit<Room, 'players' | 'stateHistory'> & { players: Array<Omit<Player, 'sessionToken'>> } {
  const { players, stateHistory: _history, ...rest } = room;
  return { ...rest, players: players.map(stripPlayerToken) };
}

// 活跃打点中间件：任何带身份的 HTTP 请求都刷新成员在线时间。
// 等待清扫器据此按「真实活跃」判定——WS 半死不活（如代理静默断连）但 HTTP 轮询/动作
// 正常的客户端不再被误踢出房间（否则踢人重置会在公示倒数中途清空选边与公示状态）
// 【S-1】身份口径改为 sessionToken：未持 token 的请求本来会在下游被 403 拒掉，
// 但它们的 playerId 会让打点虚增成员在线时间，反而削弱「等待阶段清扫失活成员」这条加固。
router.use((req, _res, next) => {
  const match = req.path.match(/^\/rooms\/([^/]+)/);
  const token = readSessionToken(req);
  if (match && token) {
    const room = rooms.get(match[1]);
    const player = room ? findPlayerByToken(room, token) : null;
    if (player) player.lastWsAt = Date.now();
  }
  next();
});

// 断线等待超时（毫秒）
const DISCONNECT_TIMEOUT = 60000; // 60秒
/**
 * 心跳判定为断线的时间（毫秒）
 *
 * 【P3】此前固定 10s，是按 20~80ms 的局域网/国内链路标定的。
 * 实测客户端→服务端经 Cloudflare 的往返 p50 595ms、p90 860ms、最坏 1.7s+，
 * 10s 门槛只有约 12 个 RTT 的余量：一次跨洋抖动或两次连续超时就会把对手
 * 误判为断线，随后走判负流程——在象棋里这等于「网络不好就逃跑」。
 * 因此放宽到 30s：判定为"真断线"慢 20s，对休闲棋局完全可以接受。
 *
 * 客户端心跳周期同步放宽为 8s（见 battleSocket.ts 的 HEARTBEAT_INTERVAL_MAX），
 * 保证"最多漏两次心跳才判断线"，两侧比例一致。
 */
const HEARTBEAT_TIMEOUT = 30000; // 30秒无心跳视为断线
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
// 开局时刻容差（毫秒）：客户端在 gameStartAt 前最多提前该时长请求开局仍被接受（抵消网络往返）
const START_TOLERANCE_MS = 500;
// 【S-2 / §3.2】悔棋快照栈上限：单局对局步数正常在 60~150 手之间，
// 200 意味着「整局任何时刻都可以悔棋」且内存有硬上界（单份 GameState 约 10~20 KB，
// 200 份 ≈ 2~4 MB/房间；房间本身受 ACTIVE_ROOM_TTL(2h) 回收，不构成长期占用）。
// 超出即丢弃最早的一份（此时悔棋只能退到 200 步之内，与"本来也退不了那么远"一致）。
const STATE_HISTORY_MAX = 200;

// 房间数据存储（内存中）
interface Player {
  id: string;
  name: string;
  side: 'red' | 'black' | null; // null = 未分配
  sidePreference: 'red' | 'black' | null; // 准备阶段玩家选择的执棋意向（双方相同时随机分配）
  ready: boolean;
  connected: boolean;
  lastHeartbeat: number; // 最后一次心跳时间
  lastWsAt: number; // 最后一次活跃时间（WS 连接/消息/pong 或任何带 sessionToken 的 HTTP 请求）：等待阶段清扫失活成员的依据
  undoRefusals: number; // 本局悔棋请求被对方连续拒绝的次数（同意清零；≥2 时本局禁止再发起悔棋）
  drawRefusals: number; // 本局求和请求被对方连续拒绝的次数（同意清零；≥2 时本局禁止再发起求和）
  hidden?: boolean; // 客户端上报的页面可见性：true=标签页处于后台（浏览器会节流定时器）
  hiddenSince?: number; // 进入后台的时刻（0=不在后台）：用于限制单次连续后台的保护时长
  // 【S-1 / §3.1】成员身份的唯一凭据（base64url 编码的 32 字节加密随机数）。
  // ⚠️ 绝不随任何房间/玩家负载下发：见 stripPlayerToken。凡是 json 整个 room 的地方都要过那层。
  sessionToken: string;
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
  // 待对方同意的悔棋请求。
  // 【悔棋深度】depth = 本次悔棋**实际回退的手数**（1 或 2），在「发起请求的那一刻」
  // 由服务端按当前局面的走子归属算出并锁定（见 resolveUndoDepth），对方同意时原样执行。
  // 语义：
  //   - 2 = 退自己的上一手 + 对方再上一手，撤回「双方各一步」，回到自己走棋前（轮到自己）；
  //   - 1 = 只撤自己刚走的那一手（我方已走、对方尚未回应的那一步窗口），回到该走之前（仍轮到自己）。
  // 必须在请求时锁定而不是同意时再算：协商期间对方一旦落子，actMove 会清掉 pendingUndo，
  // 但若「同意」与对方落子竞态，先到先处理——若在同意时按新局面重算，深度会与发起方的意图不符。
  pendingUndo: { playerId: string; requestTime: number; depth: 1 | 2 } | null; // 待对方同意的悔棋请求
  // 【S-2 / §3.2】悔棋快照栈：每次**合法走子落盘之前**把当前权威局面压入。
  // 元素类型沿用 gameState 的 any（规则引擎的 GameState 类型没有跨端导出，见 ruleEngine.bundle.ts）。
  // 栈顶 = 上一步落子之前的局面，悔棋同意时直接 pop 使用，客户端不再有权提交目标局面。
  // 生命周期：startPlayingRoom 初始化为 []，随房间一起被 GC 回收，不跨局残留。
  stateHistory: any[];
  undoResult: { playerId: string; agreed: boolean; reason: 'agreed' | 'refused' | 'timeout' | 'no_snapshot'; time: number } | null; // 悔棋处理结果（通知请求方）
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
  rejectionSyncCount?: number; // 同一计数窗口内已回推的次数（上限 8）；【S-2】从模块级全局移到这里
  // 【P4】下一次广播必须走**全量**载荷（含完整 moveHistory）而不是增量载荷。
  // 悔棋会把 gameState 换成更短的快照（历史被截断 1~2 手，取决于 pendingUndo.depth），
  // 增量载荷只带 moveCount/lastMove，客户端的棋谱会与真实历史静默分叉；置位后由
  // buildGameStatePayload 的调用方消费并清零。
  fullSyncPending?: boolean;
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
  // 广播器可能被重新注册（测试里注入替身），公共层必须同步拿到新的那一个
  registerRoomAccess(id => rooms.get(id), r => roomBroadcaster(r as Room));
}

// 【第 3 批】把房间查找接到跨通道公共层：模块加载时先接一次（此时 broadcaster 还是空操作，
// 之后由上面的 registerRoomBroadcaster 覆盖成真正的 WS 广播）。
registerRoomAccess(id => rooms.get(id), r => roomBroadcaster(r as Room));

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
// 被拒绝的动作必须把**权威状态**也回推给双方。客户端应用服务端状态的唯一入口是
// state 帧 / GET /rooms/:id/gameState，而服务端原本只在 result.status < 400 时才广播：
// 于是「不是你的回合」「非法走法（含送将）」「对方的悔棋请求已被处理」这类拒绝会让客户端毫无感知
// （落子的乐观更新留在盘上、悔棋按钮停在「等待对方同意」），直到下一次成功动作才被顺带纠正。
//
// 本轮（第 3 批）把这段判定连同 HTTP/WS 两份重复实现一并抽到 ./actionOutcome 的
// `settleActionOutcome`：限流判据、计数锚点、广播时机只剩一份实现。

// 【第 3 批】跨通道动作结算与失败响应形状已抽出到 ./actionOutcome：
//   - `ActionResult` / `failBody` / `actionFailure` 是失败 body 的唯一构造入口；
//   - `settleActionOutcome` 是「动作执行 → 广播 → 4xx 限流回推」的唯一实现，
//     HTTP 的 `respondAction` 与 WS 的 `handleMessage` 都走它，口径无法再分叉（§8 表 #1）。
// 本文件仍保留 `rooms` / `roomBroadcaster` 的所有权，并把两者注入公共层（registerRoomAccess）。
export { ActionResult, failBody, actionFailure, shouldSyncRejection } from './actionOutcome';
import {
  ActionResult,
  actionFailure,
  failBody,
  registerRoomAccess,
  respondAction,
  type FailureCode,
} from './actionOutcome';

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

// 【第 3 批 / §8 #5】终局时清理「在途协商」字段的唯一实现。
//
// 为什么要单点：终局有六条路径（绝杀/困毙、认输、和棋、断线判负、时钟超时、离场弃局），
// 每条都要把 clockPausedAt 与 pendingUndo/undoResult/pendingDraw/drawResult 清干净——
// 漏一条，客户端就会在结算页上渲染出「等待对方同意悔棋/求和」的残留协商 UI
// （useBattleStateSync 的协商分支只认 pending*/result 的存在，不看 phase）。
// 历史上 actRematch 与 settleAbandonedPlayingRoom 清全套、actDrawResponse 只清 pendingUndo，
// 于是「求和同意结束」与「认输结束」表现不同：同一个语义两种画面。
//
// 关于「在途提示会不会被清掉」：清空后客户端的协商分支靠
// `else if (!pendingDraw && pendingDrawRef.current)` 同样会解除「求和中/悔棋中」的等待态
// （useBattleStateSync 的判据是 pending 或 result 任一存在），
// 而 result 本来也会被 expirePendingUndo/expirePendingDraw 在 15s 后清掉——
// 提前清只是把「等 15 秒才消失」变成「立刻消失」，不会把等待态卡死。
function clearEndedNegotiations(room: Room): void {
  room.clockPausedAt = null;
  room.pendingUndo = null;
  room.undoResult = null;
  room.pendingDraw = null;
  room.drawResult = null;
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
      // 【第 3 批 / §8 #5】终局字段清理统一走 clearEndedNegotiations
      clearEndedNegotiations(room);
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
  // 【第 3 批 / §8 #5】终局字段清理统一走 clearEndedNegotiations
  clearEndedNegotiations(room);
  room.lastActivity = Date.now();
  return true;
}

/**
 * 构建对局状态推送载荷（对所有玩家一致，客户端据此自行判定执棋方/轮到谁等视角信息）
 *
 * 【P4】载荷瘦身：此前直接推 `room.gameState` 全量，实测 JSON 字节随步数线性膨胀——
 *   初始局面 1643 B；30 步时 moveHistory 占 31.0%、ruleState 占 47.1%（其中绝大多数是
 *   `ruleState.positionKeys`：每手追加一个完整局面指纹串），qiPan+pieces 只占 20.4%。
 *   而 `broadcastRoom` 会把这一整份复制给房内**每一个** socket。
 *
 * 瘦身后：
 * - `ruleState` 只发客户端真正用到的字段（notice / ban* 展示），剔除 positionKeys
 *   （仅服务端用于重复局面判和）、两侧计数器等内部量；
 * - `moveHistory` 改为 `moveCount` + `lastMove`：客户端只需要"最新一手"来做动画与提示，
 *   完整历史仅在**重连补推**时需要（见 buildFullGameStatePayload）。
 *
 * ⚠️ 这是**增量**载荷，不含完整历史，因此只能用于服务端→客户端的单向推送。
 * 任何需要客户端重建棋谱的路径（首次进入、重连、悔棋后本地规则重算）必须走
 * buildFullGameStatePayload——这是本设计唯一的正确性风险点，改动时务必保持这条边界。
 *
 * 30 步局面的载荷由 7691 B 降到约 1.8 KB（约 4.3×）。
 */
export function buildGameStatePayload(room: Room): Record<string, unknown> {
  const history = room.gameState?.moveHistory || [];
  const lastMove = history.length > 0 ? history[history.length - 1] : null;
  return {
    gameState: slimGameState(room.gameState),
    moveCount: history.length,
    lastMove,
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
    // 【悔棋深度】depth 必须下发：对方据此说明「撤销 N 手」，发起方据此对齐本地口径
    pendingUndo: room.pendingUndo
      ? { playerId: room.pendingUndo.playerId, requestTime: room.pendingUndo.requestTime, depth: room.pendingUndo.depth }
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

/**
 * 【P4】把 gameState 裁到客户端真正需要的部分。
 *
 * 剔除的三类字段及其唯一用途（**都在服务端继续完整保留**）：
 * - `moveHistory`：客户端只用最新一手做动画/提示；完整历史仅重连时需要，由
 *   buildFullGameStatePayload 单独下发。
 * - `ruleState.positionKeys`：每手追加一个完整局面指纹串，仅用于重复局面判和
 *   （RuleEngine.ts 的 repetition 计数），30 步时占 3177 B / 41%。
 * - `ruleState.red/black` 计数与 `banChaseTargets`：客户端只用 `notice`/`banActive`/
 *   `banSide`/`banMoves`/`banReason` 展示长将长捉提示，从不读这些计数。
 */
function slimGameState(gameState: any): Record<string, unknown> {
  if (!gameState || typeof gameState !== 'object') return {};
  const { moveHistory: _moveHistory, ruleState, ...rest } = gameState;
  if (!ruleState || typeof ruleState !== 'object') return rest;
  const {
    positionKeys: _positionKeys,
    red: _red,
    black: _black,
    banChaseTargets: _banChaseTargets,
    ...ruleRest
  } = ruleState;
  return { ...rest, ruleState: ruleRest };
}

/**
 * 【P4】重连/首帧的全量载荷。
 *
 * 断线重连后客户端要重建完整棋谱（悔棋需要 moveHistory，规则引擎重算需要完整历史），
 * 因此 welcome 帧与 `/gameState` 的**首拉**走这里，之后的增量推送才用瘦身版。
 * 体积只在每次重连付一次，可以接受。
 *
 * ⚠️ 这里**直接回传 room.gameState 引用**（未拷贝），故仅在序列化当下安全；
 * 任何持有该载荷并延后使用的调用方都会看到后续修改，不得缓存。
 */
export function buildFullGameStatePayload(room: Room): Record<string, unknown> {
  const base = buildGameStatePayload(room);
  const history = room.gameState?.moveHistory || [];
  const lastMove = history.length > 0 ? history[history.length - 1] : null;
  return {
    ...base,
    gameState: room.gameState,
    moveCount: history.length,
    lastMove,
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
  // 服务端自愈路径（GC 主动收口，不是玩家发起的动作）：用留存玩家自己的 token 走同一份鉴权，
  // 保证 actRematch 只有被房间成员调用时才生效（【S-1 / §3.1】）
  actRematch(room.id, {}, room.players[0].sessionToken); // ended → waiting：重置准备/选边/公示，大厅立即可见
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
  // 【第 3 批 / §8 #5】终局字段清理统一走 clearEndedNegotiations
  clearEndedNegotiations(room);
  room.disconnectedPlayerId = null;
  room.disconnectTime = null;
  room.lastActivity = Date.now();
  return true;
}

// 开局的唯一落地入口（【S-8 / §3.8】）：服务端自己生成权威初始局面并初始化悔棋快照栈。
//
// 改造前这一步由客户端「上传初始局面」完成（旧协议分支 POST /gameState 带完整 gameState），
// 代价是权威局面的**第一来源在客户端**：伪造一个「我方绝杀对方」的 gameState 直接判胜。
// 现在客户端只负责发着法，初始局面（含让子）完全由服务端用**与客户端同源**的规则引擎构造，
// 两端不可能对开局位置产生分歧。
//
// actStart（客户端倒数结束后主动请求）与 tryAutoStart（服务端统一定时到点）共用本函数，
// 消除历史上两条开局路径校验口径不一致的问题（S-19）。
function startPlayingRoom(room: Room): void {
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
  // 权威初始局面：红先（createInitialState 默认 RED_SIDE），再按房间设置应用让子
  // （移除红方指定棋子）。ruleEngine 是 ruleEngine.bundle.ts 的 esbuild 产物，
  // 与客户端共享 GameEngine 同一份源码，两端算出的开局位置必然一致。
  room.gameState = ruleEngine.applyHandicap(ruleEngine.createInitialState(), room.settings.handicap);
  // 快照栈初始化为空：栈内保存的是「每手走子之前」的局面，开局这一手之前没有更早的局面。
  room.stateHistory = [];
}

// 统一定时自动开局：公示锚定的开局时刻（gameStartAt）到点后由服务端权威开局。
// 不依赖任一客户端的 /start 成功——请求失败/延迟时，对端客户端会永远卡在
// 公示阶段（无法走子、无操作按钮）；由每秒 tick 驱动，到点后最多延迟 1 个 tick 生效
function tryAutoStart(room: Room): boolean {
  if (room.phase !== 'waiting') return false;
  if (!room.sideReveal || !room.gameStartAt) return false;
  if (Date.now() < room.gameStartAt) return false;
  if (room.players.length < 2) return false;
  if (!room.players.every(p => p.ready)) return false;
  const sides = room.players.map(p => p.side);
  if (!sides.includes('red') || !sides.includes('black')) return false;

  // 【S-8】初始局面由服务端统一构造（与 actStart 同一入口，两条开局路径口径完全一致）
  startPlayingRoom(room);
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
    return res.status(400).json(failBody(400, '玩家名称不能为空'));
  }

  const trimmedPassword = typeof password === 'string' ? password.trim() : '';
  const trimmedRoomName = typeof roomName === 'string' ? roomName.trim() : '';
  if (trimmedRoomName.length > 5) {
    return res.status(400).json(failBody(400, '房间名最长 5 个字符'));
  }
  if (trimmedPassword && !/^\d{1,6}$/.test(trimmedPassword)) {
    return res.status(400).json(failBody(400, '密码需为 6 位以内纯数字'));
  }
  // 每轮限时（秒）：非法/缺省视为 0（不限时），上限 3600 秒
  const rawTurnSeconds = Number(turnTimeSeconds);
  const turnTimeLimit = Number.isFinite(rawTurnSeconds) && rawTurnSeconds > 0
    ? Math.min(Math.round(rawTurnSeconds), 3600)
    : 0;
  const clockSettings = parseClockSettings(baseTimeSeconds, incrementSeconds, byoyomiSeconds);
  if ('error' in clockSettings) {
    return res.status(400).json(failBody(400, clockSettings.error));
  }
  const handicapIds = parseHandicap(handicap);
  if ('error' in handicapIds) {
    return res.status(400).json(failBody(400, handicapIds.error));
  }
  const roomId = generateRoomId();
  // 【S-1 / §3.1】房主 token 在建房时签发，随响应单独下发（不放进 room 对象里）
  const hostSessionToken = issueSessionToken();
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
        sessionToken: hostSessionToken,
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
    stateHistory: [], // 【S-2】悔棋快照栈，开局时由 startPlayingRoom 重置
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };

  rooms.set(roomId, room);

  // ⚠️ room 一律剥掉 players[].sessionToken 后再下发：房主/成员能看到对方是谁，
  // 但绝不能看到对方的 token（否则任何一端都能冒充对方做一切事，等于没有鉴权）。
  res.json({ roomId, room: stripRoomTokens(room), sessionToken: hostSessionToken });
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
    return res.status(400).json(failBody(400, '玩家名称不能为空'));
  }

  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json(failBody(404, '房间不存在或已关闭'));
  }

  // 幂等加入：同一玩家重复加入直接返回成功（断线重连/刷新场景，无需再校验密码）
  //
  // 【S-1 / §3.1】这里**只能**按 playerId 匹配，因为这条路径的语义就是「客户端会话丢失
  // （清了缓存 / 换设备 / token 未持久化）后凭 playerId 找回席位」——此时它手上必然没有
  // 任何可用 token，按 token 匹配会把这条唯一的找回路径也堵死。
  // 因此这里会重新签发 token（旧 token 立即失效），代价是「拿到别人 playerId 的人可以
  // 顶掉对方昵称、把对方标记为在线、并使对方的旧 token 作废」。
  // 彻底消除它需要客户端在退出房间时显式注销会话并由服务端清理席位，属于下一步工作；
  // 在那之前，这个残留风险由 §3.1 的其余加固（所有写操作仍按 token 鉴权）兜住：
  // 顶掉昵称/标记在线不产生任何对局影响，真正的操作依然需要新 token，而新 token 只发给
  // 重新发起 join 的那一方（也就是发起顶替的那一方）。
  const existing = room.players.find(p => p.id === playerId);
  if (existing) {
    existing.name = playerName;
    existing.connected = true;
    existing.lastHeartbeat = Date.now();
    existing.sessionToken = issueSessionToken();
    return res.json({
      success: true,
      room: stripRoomTokens(room),
      player: stripPlayerToken(existing),
      sessionToken: existing.sessionToken,
    });
  }

  if (room.players.length >= 2) {
    return res.status(400).json(failBody(400, '房间已满'));
  }

  if (room.phase !== 'waiting') {
    return res.status(400).json(failBody(400, '该房间对局已开始'));
  }

  // 密码校验（房间设有密码时）
  if (room.password) {
    const inputPassword = typeof password === 'string' ? password.trim() : '';
    if (!inputPassword) {
      return res.status(401).json(failBody(401, '该房间需要密码', { needPassword: true }));
    }
    if (inputPassword !== room.password) {
      return res.status(401).json(failBody(401, '房间密码错误', { needPassword: true }));
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
    sessionToken: issueSessionToken(), // 【S-1】加入即签发
  };

  room.players.push(player);
  room.lastActivity = Date.now();

  res.json({
    success: true,
    room: stripRoomTokens(room),
    player: stripPlayerToken(player),
    sessionToken: player.sessionToken,
  });
});

// 获取房间详情（含玩家选边/准备状态与执棋公示信息；不返回密码明文）
router.get('/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);

  if (!room) {
    return res.status(404).json(failBody(404, '房间不存在'));
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
  const { name, password, turnTimeSeconds, baseTimeSeconds, incrementSeconds, byoyomiSeconds, handicap } = req.body;

  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json(failBody(404, '房间不存在'));
  }
  if (room.phase !== 'waiting') {
    return res.status(400).json(failBody(400, '对局已开始，无法修改房间设置'));
  }
  // 【S-1 + S-7】房主判定改用「持有 token 的成员 id === room.hostId」：
  // 原实现是 `room.players[0]?.id !== playerId`，既信任自报的 playerId，
  // 又把「数组第一个」等同于房主，与显式 hostId 字段形成双源真相
  // （/leave 用 filter 重建 players 数组会改变顺序，进而改变"房主是谁"）。
  const actor = findPlayerByToken(room, readSessionToken(req));
  if (!actor || actor.id !== room.hostId) {
    return res.status(403).json(failBody(403, '仅房主可修改房间设置'));
  }

  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed || trimmed.length > 5) {
      return res.status(400).json(failBody(400, '房间名需为 1~5 个字符'));
    }
    room.name = trimmed;
  }
  if (password !== undefined) {
    // 空串/null 表示清除密码
    const pwd = String(password ?? '').trim();
    if (pwd && !/^\d{1,6}$/.test(pwd)) {
      return res.status(400).json(failBody(400, '密码需为 6 位以内纯数字'));
    }
    room.password = pwd || null;
  }
  if (turnTimeSeconds !== undefined) {
    const secs = Number(turnTimeSeconds);
    if (!Number.isFinite(secs) || secs < 0 || secs > 3600) {
      return res.status(400).json(failBody(400, '限时需在 0~3600 秒之间（0=不限时）'));
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
      return res.status(400).json(failBody(400, parsed.error));
    }
    room.settings.baseTimeSeconds = parsed.baseTimeSeconds;
    room.settings.incrementSeconds = parsed.incrementSeconds;
    room.settings.byoyomiSeconds = parsed.byoyomiSeconds;
  }
  if (handicap !== undefined) {
    const parsed = parseHandicap(handicap);
    if ('error' in parsed) {
      return res.status(400).json(failBody(400, parsed.error));
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
export function actSide(roomId: string, body: Record<string, unknown>, sessionToken: string): ActionResult {
  const { side } = body as { side?: string };

  const room = rooms.get(roomId);
  if (!room) {
    return actionFailure(404, '房间不存在');
  }

  if (room.phase !== 'waiting') {
    return actionFailure(400, '对局已开始');
  }

  // 让子房间跳过选边（双方就绪时服务端已直分公示：房主执红先行）
  if (room.settings.handicap.length > 0) {
    return actionFailure(400, '让子对局由房主执红先行，无需选边');
  }

  if (side !== 'red' && side !== 'black') {
    return actionFailure(400, '执棋方只能是 red 或 black');
  }

  // 【S-1 / §3.1】按 sessionToken 定位成员
  const player = findPlayerByToken(room, sessionToken);
  if (!player) {
    return FORBIDDEN();
  }

  // 选边环节在双方均准备后才开启
  if (room.players.length < 2 || !room.players.every(p => p.ready)) {
    return actionFailure(400, '双方均准备后才能选边');
  }

  // 执棋结果已公示（双方均已选边）后锁定，不可再改
  if (room.sideReveal) {
    return actionFailure(400, '执棋结果已公示，不能更改');
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
  respondAction(res, req.params.roomId, actSide(req.params.roomId, req.body, readSessionToken(req)));
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
export function actReady(roomId: string, body: Record<string, unknown>, sessionToken: string): ActionResult {
  const ready = (body as { ready?: boolean }).ready !== false; // 仅显式传 false 视为取消准备

  const room = rooms.get(roomId);
  if (!room) {
    return actionFailure(404, '房间不存在');
  }

  if (room.phase !== 'waiting') {
    return actionFailure(400, '对局已开始');
  }

  // 【S-1 / §3.1】按 sessionToken 定位成员
  const player = findPlayerByToken(room, sessionToken);
  if (!player) {
    return FORBIDDEN();
  }

  if (!ready) {
    // 选边已公示（开局倒数中）：不允许取消准备。公示一旦发出即锁定，
    // 避免与统一定时（gameStartAt）产生「一方取消、另一方仍倒数进局」的状态分叉
    if (room.sideReveal) {
      return actionFailure(400, '选边已公示，无法取消准备');
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
  respondAction(res, req.params.roomId, actReady(req.params.roomId, req.body, readSessionToken(req)));
});

// 开始对局（双方准备后，前端倒计时结束后调用）
// 开局核心逻辑（HTTP 与 WebSocket 共用）
export function actStart(roomId: string, _body: Record<string, unknown>, sessionToken: string): ActionResult {
  const room = rooms.get(roomId);
  if (!room) {
    return actionFailure(404, '房间不存在');
  }

  // 幂等：对局已开始（统一定时自动开局生效后客户端的 /start 才到达、或重复提交）→
  // 视为成功确认并返回当前纪元，调用方按正常开局流程继续，不得视为失败。
  // 放在鉴权之前：这是幂等确认，不产生任何状态变更，无需身份。
  if (room.phase === 'playing') {
    return { status: 200, body: { success: true, gameStartTime: room.gameStartTime, matchId: room.matchId, alreadyStarted: true } };
  }

  // 【S-1 / §3.1】校验：持有 token 的房间成员才可开局
  if (!findPlayerByToken(room, sessionToken)) {
    return FORBIDDEN();
  }

  // 校验：双方就位、均已准备且阵营分配完整，防止提前开局导致无阵营/缺人
  if (room.players.length < 2) {
    return actionFailure(400, '玩家未齐，无法开局');
  }
  if (!room.players.every(p => p.ready)) {
    return actionFailure(400, '尚有玩家未准备，无法开局');
  }
  const sides = room.players.map(p => p.side);
  if (!sides.includes('red') || !sides.includes('black')) {
    return actionFailure(400, '阵营未分配完整，无法开局');
  }
  // 校验：公示必须仍然有效（倒计时窗口内被取消后 sideReveal/gameStartAt 已清空，残留的开局请求一律拒绝）
  if (!room.sideReveal || !room.gameStartAt) {
    return actionFailure(400, '开局已取消，无法开始对局');
  }
  // 校验：必须到达服务端锚定的统一开局时刻（留少量容差抵消网络往返）
  if (Date.now() < room.gameStartAt - START_TOLERANCE_MS) {
    return actionFailure(400, '开局时刻未到，请稍候');
  }

  // 【S-8】初始局面与悔棋快照栈一律由服务端构造（与 tryAutoStart 共用 startPlayingRoom）
  startPlayingRoom(room);

  return { status: 200, body: { success: true, gameStartTime: room.gameStartTime, matchId: room.matchId } };
}

router.post('/rooms/:roomId/start', (req, res) => {
  respondAction(res, req.params.roomId, actStart(req.params.roomId, req.body, readSessionToken(req)));
});

// 走棋核心逻辑（HTTP 与 WebSocket 共用）
export function actMove(roomId: string, body: Record<string, unknown>, sessionToken: string): ActionResult {
  const room = rooms.get(roomId);
  if (!room) {
    return actionFailure(404, '房间不存在');
  }

  // 【S-8 / §3.8】旧协议分支（客户端上传完整 gameState / gameOver / winner）已删除。
  //
  // 该分支曾是「初始局面上传」的唯一通道，但它让**权威局面的第一来源在客户端**：
  // 历史上只需 roomId + playerId 就能上传任意 gameState 并直接判胜（S-8）。
  // 现初始局面由 startPlayingRoom 在服务端用同一份规则引擎构造，客户端再无上传通道，
  // 因此这里只剩一种合法输入：{ move }。
  if (!body || !body.move || typeof body.move !== 'object') {
    return actionFailure(400, '仅接受 { move: { pieceId, toCol, toRow } }，不再支持完整局面上传');
  }

  const { move } = body as { move: { pieceId: number; toCol: number; toRow: number } };
  if (room.phase !== 'playing' || !room.gameState) {
    return actionFailure(400, '对局未在进行中');
  }
  // 【S-1 / §3.1】按 sessionToken 定位成员
  const player = findPlayerByToken(room, sessionToken);
  if (!player || !player.side) {
    return player ? actionFailure(400, '尚未分配阵营') : FORBIDDEN();
  }
  const mySide = player.side;
  const state = room.gameState;
  const stateSideIsRed = state.sideTag === true || state.sideTag === 'red';
  if (stateSideIsRed !== (mySide === 'red')) {
    return actionFailure(400, '不是你的回合');
  }
  const { pieceId, toCol, toRow } = move;
  if (!Number.isInteger(pieceId) || !Number.isInteger(toCol) || !Number.isInteger(toRow)) {
    return actionFailure(400, '着法格式错误');
  }
  // 落点越界必须在索引 qiPan 之前挡掉（onlineMoveGuard 只校验起点归属，落点越界会
  // 让 getValidMoves/引擎内部读 undefined）——与客户端 utils/chess/onlineMoveGuard.ts 同口径
  if (toCol < 0 || toCol > 8 || toRow < 0 || toRow > 9) {
    return actionFailure(400, '落点超出棋盘范围');
  }
  // 走法合法性校验（含王安全过滤），杜绝客户端伪造着法
  const valid = ruleEngine.getValidMoves(state, pieceId);
  if (!valid[toCol] || !valid[toCol][toRow]) {
    return actionFailure(400, '非法走法');
  }
  // 服务端权威裁决：与客户端同一规则引擎执行走子（含长将长捉判定与终局）
  // 长将长捉超限不再拦截落子、不再按违规次数判负（方案 10 娱乐向改造）：
  // banMoves 仅用于客户端棋盘标红提示；双方僵持不下由自然限招/互长将互长捉判和收场。
  // 加固：历史上前身是直接注入 dist 的补丁，现已归位到源码（改这里即可，改完在 chinese-chess-server/ 下跑 node build.js）。
  const result = ruleEngine.makeMove(state, pieceId, toCol, toRow);

  // 【S-2 / §3.2】走子前把当前局面压栈：悔棋时服务端回到自己的快照，
  // 不再采纳客户端上传的 proposedState（那是权威局面可被任意改写的根因）。
  // 存的是引用而非深拷贝：makeMove 返回全新状态、不改旧对象；旧状态此后只被读取
  // （走子判定/悔棋回退），不写入，因此无需深拷贝即可安全共享（cloneGameState 会连带
  // 深拷贝 ruleState，开 200 手的代价是每手多一次全量重放）。
  room.stateHistory.push(state);
  // 内存封顶：超出后丢弃最老的一份（对手此时已无法悔到那么久以前——
  // 悔棋一次只回退 1~2 手，且 undoRefusals 用尽后本局不能再发起）
  if (room.stateHistory.length > STATE_HISTORY_MAX) {
    room.stateHistory.splice(0, room.stateHistory.length - STATE_HISTORY_MAX);
  }

  if (room.clocks && room.lastMoveTime) {
    // 协商暂停期间抵达的走棋：耗时冻结在暂停时刻，请求方不为协商耗时买单
    const elapsed = (room.clockPausedAt ?? Date.now()) - room.lastMoveTime;
    // 加秒制（菲舍尔）：扣时后补回加秒；读秒制 incrementSeconds 恒为 0（parseClockSettings 互斥保证），天然退化为纯扣时
    room.clocks[mySide] = Math.max(0, room.clocks[mySide] - elapsed) + room.settings.incrementSeconds * 1000;
  }
  room.gameState = result.newState;
  room.lastMoveTime = Date.now();
  room.lastActivity = Date.now();
  if (result.isGameOver) {
    room.phase = 'ended';
    if (result.newState.gameStatus === 'draw') {
      room.winner = null;
      room.endReason = 'draw';
    } else {
      room.winner = result.newState.gameStatus === 'red_win' ? 'red' : 'black';
      room.endReason = 'checkmate';
    }
    // 【第 3 批 / §8 #5】终局字段清理统一走 clearEndedNegotiations
    clearEndedNegotiations(room);
  } else {
    // 未终局：新的一手让在途的悔棋/求和协商失效（对方已落子，暂停锚点不再有效）
    room.clockPausedAt = null;
    room.pendingUndo = null;
    room.pendingDraw = null;
  }
  return { status: 200, body: { success: true } };
}

router.post('/rooms/:roomId/move', (req, res) => {
  respondAction(res, req.params.roomId, actMove(req.params.roomId, req.body, readSessionToken(req)));
});

// 获取游戏状态（HTTP 轮询通道：大厅/观战/兜底仍使用；对局中客户端主要由 WebSocket 推送）
router.get('/rooms/:roomId/gameState', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);

  if (!room) {
    return res.status(404).json(failBody(404, '房间不存在'));
  }

  // 惰性清理与断线检测（与 gameTickTimer 幂等，双保险）
  expirePendingUndo(room);
  expirePendingDraw(room);
  pruneSpectators(room);
  pruneEmojis(room);
  detectDisconnect(room);

  // 【P4】HTTP 轮询走**全量**载荷：这条通道是 WS 断开时的唯一状态来源，
  // 且每次都是客户端重新进入对局页的首拉，必须带完整 moveHistory 以重建棋谱。
  // 它的开销由 P5 的「轮询间隔按 RTT 放大」压住（实测单次 ~722ms，1s 间隔本就会重叠）。
  res.json(buildFullGameStatePayload(room));
});

// 进入观战：仅对战中的房间可旁观（注册观战者并返回当前局面快照）
router.post('/rooms/:roomId/spectate', (req, res) => {
  const { roomId } = req.params;
  const { spectatorId, spectatorName } = req.body;
  const room = rooms.get(roomId);

  if (!room) {
    return res.status(404).json(failBody(404, '房间不存在'));
  }
  if (!spectatorId) {
    return res.status(400).json(failBody(400, '缺少观战者标识'));
  }
  if (room.phase === 'waiting') {
    return res.status(400).json(failBody(400, '对局尚未开始，暂无法观战'));
  }
  // 席位不完整（一方已离场）时不再放行：否则观战者会进入一个只有单边棋子的「空局」，
  // 名称角标只能落到「红方/黑方」占位文本上。提示按「对局已终止」表述，避免观战者误判为网络问题。
  if (!hasCompleteSeating(room)) {
    return res.status(400).json(failBody(400, '对局已有玩家离开，观战已结束'));
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
    return res.status(404).json(failBody(404, '房间不存在'));
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
    return res.status(404).json(failBody(404, '房间不存在'));
  }
  room.spectators = room.spectators.filter(s => s.id !== spectatorId);
  res.json({ success: true, spectatorCount: room.spectators.length });
});

// 认输核心逻辑（HTTP 与 WebSocket 共用）
export function actSurrender(roomId: string, _body: Record<string, unknown>, sessionToken: string): ActionResult {
  const room = rooms.get(roomId);
  if (!room) {
    return actionFailure(404, '房间不存在');
  }

  if (room.phase !== 'playing') {
    return actionFailure(400, '对局未在进行中');
  }

  // 【S-1 / §3.1】按 sessionToken 定位成员
  const player = findPlayerByToken(room, sessionToken);
  if (!player) {
    return FORBIDDEN();
  }

  // 认输方为输家，对方为赢家
  const winnerSide = player.side === 'red' ? 'black' : 'red';
  room.winner = winnerSide as 'red' | 'black';
  room.surrenderBy = player.id;
  room.endReason = 'resign';
  room.phase = 'ended';
  // 【第 3 批 / §8 #5】终局字段清理统一走 clearEndedNegotiations
  clearEndedNegotiations(room);
  room.lastActivity = Date.now();

  const duration = room.gameStartTime ? Date.now() - room.gameStartTime : 0;
  const moveCount = room.gameState?.moveHistory?.length || 0;

  return {
    status: 200,
    body: { success: true, winner: winnerSide, surrenderBy: player.id, duration, moveCount },
  };
}

router.post('/rooms/:roomId/surrender', (req, res) => {
  respondAction(res, req.params.roomId, actSurrender(req.params.roomId, req.body, readSessionToken(req)));
});

// 重新对局核心逻辑（重置房间状态；HTTP 与 WebSocket 共用）
//
// 【S-1 / §3.1】需要持有房间成员的 sessionToken：重置会把双方一起拽回准备阶段，
// 是状态变更动作，不能再是「知道房间号就能调用」。
export function actRematch(roomId: string, _body: Record<string, unknown>, sessionToken: string): ActionResult {
  const room = rooms.get(roomId);
  if (!room) {
    return actionFailure(404, '房间不存在');
  }

  if (!findPlayerByToken(room, sessionToken)) {
    return FORBIDDEN();
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
  // 【第 3 批 / §8 #5】暂停锚点与协商字段的清理由 clearEndedNegotiations 统一负责
  clearEndedNegotiations(room);
  room.winner = null;
  room.surrenderBy = null;
  room.endReason = null;
  room.disconnectedPlayerId = null;
  room.disconnectTime = null;
  room.sideReveal = null;
  room.emojiMessages = [];
  room.returnedToRoom = {};
  room.stateHistory = []; // 【S-2】上一局的快照栈不再有用途，随重置一并丢弃（否则内存按局累积）
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
  respondAction(res, req.params.roomId, actRematch(req.params.roomId, req.body, readSessionToken(req)));
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
function actReturnToRoom(roomId: string, _body: Record<string, unknown>, sessionToken: string): ActionResult {
  const room = rooms.get(roomId);
  if (!room) {
    return actionFailure(404, '房间不存在');
  }
  // 【S-1 / §3.1】按 sessionToken 定位成员
  const player = findPlayerByToken(room, sessionToken);
  if (!player) {
    return FORBIDDEN();
  }
  if (room.phase !== 'ended') {
    // 房间已不在结算阶段（重复点击，或对手已重置）：幂等返回当前状态
    return { status: 200, body: { success: true, phase: room.phase } };
  }
  if (!room.returnedToRoom) room.returnedToRoom = {};
  // 房间回到等待中：返回者可立即自行准备/选边；对手端不自动跟随（见上方注释）
  // actRematch 会做鉴权，这里传同一个 token（已在上方验证过是房间成员）
  actRematch(roomId, {}, sessionToken);
  // 必须在 actRematch 之后写：actRematch 会清空 returnedToRoom
  room.returnedToRoom[player.id] = Date.now();
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
// 【C-90 / §7.1 风格统一】原为 var（历史补丁遗留），本文件其余常量一律用 const
const RETURNED_GRACE_MS = 30 * 1e3;
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
  respondAction(res, req.params.roomId, actReturnToRoom(req.params.roomId, req.body, readSessionToken(req)));
});

/**
 * 计算本次悔棋应回退的手数（悔棋深度）。
 *
 * 【新增】此前悔棋一律按「退 2 手」处理（见下方 actUndoResponse 的历史注释），
 * 于是「我方刚走完、对方还没走」这个窗口完全无法悔棋：按 2 手退会连带撤掉
 * 对方更早的那一手（不是本窗口该撤的），而发起方的诉求其实只是「把刚走的那一手撤回」。
 *
 * 两种口径（以发起方能回退的最少手数为准，保证回退后仍轮到发起方）：
 * - **轮到发起方**（自己该走）：可退自己的上一手 + 对方应的那手 → 2 手（传统「悔一步」）；
 * - **对方该走**（发起方刚走完、对方尚未落子）：只退自己刚走的那一手 → 1 手。
 *
 * 返回 null 表示此刻无法悔棋（自己还没走过子，或快照栈为空）。
 */
function resolveUndoDepth(room: Room, player: { side: 'red' | 'black' | null }): 1 | 2 | null {
  if (!player.side) return null;
  const historyLen = room.stateHistory?.length ?? 0;
  if (historyLen === 0) return null;
  const sideTag = (room.gameState as { sideTag?: unknown }).sideTag;
  const currentSide: 'red' | 'black' = (sideTag === true || sideTag === 'red') ? 'red' : 'black';
  // 轮到发起方 → 退 2 手；轮到对方（我方刚走完）→ 退 1 手
  if (currentSide === player.side) {
    // 退 2 手需要栈里至少两个快照；只剩 1 个说明自己一手都没走过，无从悔起
    return historyLen >= 2 ? 2 : null;
  }
  return 1;
}

/**
 * 发起悔棋核心逻辑（HTTP 与 WebSocket 共用）。
 *
 * 【S-2 / §3.2】**不再接收 proposedState**：改造前客户端算好「回退两步」的局面一并上传，
 * 服务端在对方同意时直接 `room.gameState = room.pendingUndo.proposedState` 采纳，
 * 零合法性校验 —— 等于把权威局面交给客户端任意改写（可回退到「对手少子、自己多子」的伪造局面，
 * 也可据此凭空造出一个「已绝杀」的局面）。现在服务端用 actMove 自己维护的快照栈回退，
 * 客户端只表达意图（「我要悔棋」），不参与决定回到哪个局面。
 *
 * 【悔棋深度】回退手数由服务端在请求时按当前局面算出（resolveUndoDepth）并锁进 pendingUndo，
 * 对方同意时原样执行——客户端不再需要本地模拟退几步来推断能不能悔。
 */
export function actUndo(roomId: string, _body: Record<string, unknown>, sessionToken: string): ActionResult {
  const room = rooms.get(roomId);
  if (!room) {
    return actionFailure(404, '房间不存在');
  }

  if (room.phase !== 'playing') {
    return actionFailure(400, '对局未在进行中');
  }

  // 【S-1 / §3.1】按 sessionToken 定位成员
  const player = findPlayerByToken(room, sessionToken);
  if (!player) {
    return FORBIDDEN();
  }

  if (room.pendingUndo) {
    return actionFailure(400, '已有待处理的悔棋请求');
  }

  // 悔棋请求连续被对方拒绝 2 次后，本局禁止再发起悔棋
  if (player.undoRefusals >= MAX_NEGOTIATION_REFUSALS) {
    return actionFailure(400, '对方已连续拒绝 2 次，本局不能再发起悔棋');
  }

  // 【S-2】必须有可回退的快照：栈空说明本局还没走过子（或快照已被封顶丢弃）
  if (!room.stateHistory || room.stateHistory.length === 0) {
    return actionFailure(400, '没有可回退的着法');
  }

  // 【悔棋深度】按当前局面算出本次应退几手：轮到对方（我方刚走完）退 1 手，轮到自己退 2 手。
  // 算出 null 表示此刻退不动（如轮到自己但本局只走过一手）。
  const depth = resolveUndoDepth(room, player);
  if (depth === null) {
    return actionFailure(400, '没有可回退的着法');
  }

  room.pendingUndo = { playerId: player.id, requestTime: Date.now(), depth };
  room.undoResult = null;
  pauseClock(room); // 悔棋协商期间暂停棋钟
  room.lastActivity = Date.now();

  // depth 一并回给发起方：客户端据此提示「撤销 N 手」并在本地做即时反馈（乐观回退）；
  // 对方响应方则从 buildGameStatePayload 的 pendingUndo.depth 拿到同一口径，
  // 用来在弹窗上说明「对方请求悔棋（撤销 N 手）」，两端展示与实际回退一致。
  return {
    status: 200,
    body: {
      success: true,
      message: '悔棋请求已发送，等待对方同意',
      pending: true,
      depth,
    },
  };
}

router.post('/rooms/:roomId/undo', (req, res) => {
  respondAction(res, req.params.roomId, actUndo(req.params.roomId, req.body, readSessionToken(req)));
});

// 同意/拒绝悔棋核心逻辑（仅对方玩家可响应；HTTP 与 WebSocket 共用）
export function actUndoResponse(roomId: string, body: Record<string, unknown>, sessionToken: string): ActionResult {
  const { agreed } = body as { agreed?: boolean };

  const room = rooms.get(roomId);
  if (!room) {
    return actionFailure(404, '房间不存在');
  }

  // 【S-1 / §3.1】按 sessionToken 定位成员（鉴权先于任何业务判断，避免用错误码泄露协商状态）
  const responder = findPlayerByToken(room, sessionToken);
  if (!responder) {
    return FORBIDDEN('仅房间内玩家可响应悔棋请求');
  }

  if (!room.pendingUndo) {
    return actionFailure(400, '没有待处理的悔棋请求');
  }

  if (room.pendingUndo.playerId === responder.id) {
    return actionFailure(400, '不能响应自己的悔棋请求');
  }

  const requesterId = room.pendingUndo.playerId;
  resumeClock(room); // 协商结束，棋钟恢复（同意时随后以当前时刻重新计时）
  // 悔棋结果计入发起方的悔棋连续被拒计数：拒绝 +1，同意清零（重开一局时统一重置）
  const undoRequester = room.players.find(p => p.id === requesterId);
  if (undoRequester) {
    undoRequester.undoRefusals = agreed ? 0 : undoRequester.undoRefusals + 1;
  }
  if (agreed) {
    // 【S-2 / §3.2】回退到服务端自己的快照，不再采纳客户端上传的 proposedState。
    // 快照栈语义：stateHistory[k] = 走完 k 手后的局面（actMove 在执行前 push，
    // 故第 1 手前压入的是 0 手开局局面）。
    //
    // 【悔棋深度】UNDO_DEPTH 不再是常量，取发起请求时就锁定在 pendingUndo.depth 的值：
    //   - depth=2：撤回「双方各一步」，回到发起方走棋前（轮回到发起方）；
    //   - depth=1：只撤回发起方刚走的那一手（对方尚未落子的窗口），同样回到发起方回合。
    // 两种深度回退后 sideTag 都翻转回发起方，回退后仍然轮到发起方走子。
    const UNDO_DEPTH = room.pendingUndo.depth;
    if (!room.stateHistory || room.stateHistory.length < UNDO_DEPTH) {
      // 快照不足（例如栈已被封顶丢弃到头）：拒绝回退并把协商按"不可执行"处理，
      // 不改动任何局面；此处理论上不可达（actUndo 已按同一判据拒绝），保留为防御。
      room.undoResult = {
        playerId: requesterId,
        agreed: false,
        reason: 'no_snapshot',
        time: Date.now(),
      };
      room.pendingUndo = null;
      room.lastActivity = Date.now();
      return actionFailure(409, '已无可回退的着法');
    }
    const keep = room.stateHistory.length - UNDO_DEPTH;
    room.gameState = room.stateHistory[keep];
    room.stateHistory.length = keep; // 回退出的快照一并出栈，否则下一手会在错误位置压栈
    // 【P4】历史被截断，必须让下一次广播发全量载荷：
    // 增量载荷只带 moveCount/lastMove，客户端的本地棋谱会比服务端少（UNDO_DEPTH）手且无法察觉。
    room.fullSyncPending = true;
    room.lastMoveTime = Date.now();
    // 终局可能被回退掉（原本已判绝杀/困毙的局面不再成立）
    room.phase = 'playing';
    room.winner = null;
    room.endReason = null;
    room.surrenderBy = null;
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
  respondAction(res, req.params.roomId, actUndoResponse(req.params.roomId, req.body, readSessionToken(req)));
});

// 请求求和核心逻辑（HTTP 与 WebSocket 共用）
export function actDraw(roomId: string, _body: Record<string, unknown>, sessionToken: string): ActionResult {
  const room = rooms.get(roomId);
  if (!room) {
    return actionFailure(404, '房间不存在');
  }

  if (room.phase !== 'playing') {
    return actionFailure(400, '对局未在进行中');
  }

  // 【S-1 / §3.1】按 sessionToken 定位成员
  const player = findPlayerByToken(room, sessionToken);
  if (!player) {
    return FORBIDDEN();
  }

  if (room.pendingDraw) {
    return actionFailure(400, '已有待处理的求和请求');
  }

  // 求和请求连续被对方拒绝 2 次后，本局禁止再发起求和
  if (player.drawRefusals >= MAX_NEGOTIATION_REFUSALS) {
    return actionFailure(400, '对方已连续拒绝 2 次，本局不能再发起求和');
  }

  room.pendingDraw = { playerId: player.id, requestTime: Date.now() };
  room.drawResult = null;
  pauseClock(room); // 求和协商期间暂停棋钟
  room.lastActivity = Date.now();

  return {
    status: 200,
    body: { success: true, message: '求和请求已发送，等待对方同意', pending: true },
  };
}

router.post('/rooms/:roomId/draw', (req, res) => {
  respondAction(res, req.params.roomId, actDraw(req.params.roomId, req.body, readSessionToken(req)));
});

// 同意/拒绝求和核心逻辑（仅对方玩家可响应；同意则对局以和棋结束；HTTP 与 WebSocket 共用）
export function actDrawResponse(roomId: string, body: Record<string, unknown>, sessionToken: string): ActionResult {
  const { agreed } = body as { agreed?: boolean };

  const room = rooms.get(roomId);
  if (!room) {
    return actionFailure(404, '房间不存在');
  }

  // 【S-1 / §3.1】鉴权先于业务判断
  const responder = findPlayerByToken(room, sessionToken);
  if (!responder) {
    return FORBIDDEN('仅房间内玩家可响应求和请求');
  }

  if (!room.pendingDraw) {
    return actionFailure(400, '没有待处理的求和请求');
  }

  if (room.pendingDraw.playerId === responder.id) {
    return actionFailure(400, '不能响应自己的求和请求');
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
    // 【S-10 / 第 3 批 / §8 #5】求和终局与认输/判负对齐：暂停锚点与在途协商字段
    // 一并清空（原先这里只清 pendingUndo，残留 undoResult/drawResult →
    // 结算页上仍渲染出上一次「对方拒绝了悔棋请求」的横幅，与认输路径表现不一致）
    clearEndedNegotiations(room);
  }

  if (!agreed) {
    // 被拒时保留本次结果供 UI 提示（15s 内由 expirePendingDraw 自动过期）
    room.drawResult = {
      playerId: requesterId,
      agreed: false,
      reason: 'refused',
      time: Date.now(),
    };
  } else {
    // 同意即终局：结算横幅由载荷的 endReason/phase 呈现，协商字段按上面统一清空
    room.drawResult = null;
  }
  room.pendingDraw = null;
  room.lastActivity = Date.now();

  return { status: 200, body: { success: true, agreed: !!agreed } };
}

router.post('/rooms/:roomId/drawResponse', (req, res) => {
  respondAction(res, req.params.roomId, actDrawResponse(req.params.roomId, req.body, readSessionToken(req)));
});

// 发送 emoji 表情核心逻辑（对局内互动；HTTP 与 WebSocket 共用）
export function actEmoji(roomId: string, body: Record<string, unknown>, sessionToken: string): ActionResult {
  const { emoji, id } = body as { emoji?: string; id?: string };

  const room = rooms.get(roomId);
  if (!room) {
    return actionFailure(404, '房间不存在');
  }

  // 鉴权：仅房间内玩家可发送表情
  const player = findPlayerByToken(room, sessionToken);
  if (!player) {
    return FORBIDDEN('仅房间内玩家可发送表情');
  }

  if (!emoji || typeof emoji !== 'string') {
    return actionFailure(400, '表情内容不能为空');
  }

  pruneEmojis(room);

  const emojiText = emoji.slice(0, 8); // 防超长
  // 客户端生成唯一 id 用于去重（乐观展示 + 回显不重复）；缺省时服务端兜底生成
  const msgId = (typeof id === 'string' && id.trim())
    ? id.trim().slice(0, 64)
    : `${player.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  if (!room.emojiMessages.some(m => m.id === msgId)) {
    room.emojiMessages.push({ id: msgId, playerId: player.id, emoji: emojiText, time: Date.now() });
  }
  room.lastActivity = Date.now();

  return { status: 200, body: { success: true, emojiMessage: { id: msgId, playerId: player.id, emoji: emojiText } } };
}

router.post('/rooms/:roomId/emoji', (req, res) => {
  respondAction(res, req.params.roomId, actEmoji(req.params.roomId, req.body, readSessionToken(req)));
});

// 心跳核心逻辑（HTTP 与 WebSocket 共用）：刷新心跳并在断线恢复时清除断线状态
export function actHeartbeat(roomId: string, body: Record<string, unknown>, sessionToken: string): ActionResult {
  const { hidden } = body as { hidden?: boolean };

  const room = rooms.get(roomId);
  if (!room) {
    return actionFailure(404, '房间不存在');
  }

  // 【S-1 / §3.1】心跳必须凭 token 定位成员：否则任何知道 playerId 的人都能
  // 持续替对方上报心跳，维持 connected=true 规避断线判负（§3.9 的隐藏标记滥用同理）。
  // 心跳不返回 403 是为了不惊动非法调用方，这里静默丢弃即可（room.lastActivity 仍刷新）。
  const player = findPlayerByToken(room, sessionToken);
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
    if (room.disconnectedPlayerId === player.id) {
      room.disconnectedPlayerId = null;
      room.disconnectTime = null;
    }
  }
  room.lastActivity = Date.now();
  return { status: 200, body: { success: true } };
}

router.post('/rooms/:roomId/heartbeat', (req, res) => {
  respondAction(res, req.params.roomId, actHeartbeat(req.params.roomId, req.body, readSessionToken(req)));
});

// 重新连接（断线后真正回到对局页面时由客户端显式调用）——
// 这是唯一清除断线等待状态的入口：WS 连接/心跳恢复仅代表连接层上线，
// 不代表玩家已回到房间；玩家实际进入对局页并调用本接口才算重连成功
router.post('/rooms/:roomId/reconnect', (req, res) => {
  const { roomId } = req.params;
  const sessionToken = readSessionToken(req);

  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json(failBody(404, '房间不存在'));
  }

  // 【S-1 / §3.1】这是本次改造的核心入口：改造前只校验「playerId 是否在房内」，
  // 于是任何知道 roomId + playerId 的人都能替对方「重连」，把对方的断线判负倒计时清零。
  // 现在必须出示该玩家自己的 sessionToken——它只存在客户端本地与服务端内存里，
  // 房间负载、观战接口、WebSocket 握手都不下发（见 stripPlayerToken / 观战者无 token）。
  const player = findPlayerByToken(room, sessionToken);
  if (!player) {
    return res.status(403).json(failBody(403, '身份校验失败，请重新加入房间', {}, 'forbidden'));
  }

  // 恢复连接
  player.connected = true;
  player.lastHeartbeat = Date.now();
  // 显式重连即代表玩家回到前台对局：清除后台标记，恢复正常判定
  player.hidden = false;
  player.hiddenSince = 0;

  // 清除断线状态（若有）
  if (room.disconnectedPlayerId === player.id) {
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
  const sessionToken = readSessionToken(req);

  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json(failBody(404, '房间不存在'));
  }

  // 【S-1 / §3.1】离场同样必须凭 token：否则陌生人可用 playerId 把别人踢出房间，
  // 并触发 settleAbandonedPlayingRoom 直接判对方负。
  const player = findPlayerByToken(room, sessionToken);
  if (!player) {
    return res.status(403).json(failBody(403, '身份校验失败，请重新加入房间', {}, 'forbidden'));
  }
  const playerId = player.id;

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
      actRematch(roomId, {}, sessionToken);
    }
  }
  // 离场是一次权威状态变更：必须广播，让留下的玩家立刻收到终局，而不是等 2s 轮询才发现
  if (rooms.has(roomId)) roomBroadcaster(rooms.get(roomId)!);
  res.json({ success: true, endReason: settled ? 'leave' : room.endReason ?? null });
});

export default router;

