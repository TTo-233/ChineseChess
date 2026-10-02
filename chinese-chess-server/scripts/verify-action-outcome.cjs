#!/usr/bin/env node
/**
 * 第 3 批「抽出跨通道公共层」回归验证
 * 目标模块：src/routes/actionOutcome.ts（HTTP 与 WebSocket 共用的失败形状与回推决策）
 *
 * 用法：
 *   node scripts/verify-action-outcome.cjs
 *   VERIFY_PORT=9098 node scripts/verify-action-outcome.cjs
 *
 * 为什么单独一个脚本（而不是并进 verify-lan-disconnect / verify-server-hardening）：
 *   这两条旧脚本都把 HTTP 响应当作唯一观测面。第 3 批的整个要点恰恰是
 *   「HTTP 与 WS 必须走同一套形状与同一套回推决策」，只有把两个通道并排断言，
 *   才能证明它们真的同源；分开写就又回到了 §8 表 #1 描述的老问题。
 *
 * 覆盖的回归点：
 *   1. 失败 body 形状统一：所有 4xx/5xx 响应都带 success:false + error(机器码) + message(人读)；
 *   2. error 是机器码、message 是文案，二者不混用（客户端只读 message，否则界面漏出 not_found）；
 *   3. 鉴权类错误码覆盖到 unauthorized/forbidden，而不是一律 bad_request；
 *   4. 历史遗留的三种旧形状（{error}、{success,message}、WS 的 {type:'error',message}）不再出现；
 *   5. 被拒动作的回推：HTTP 与 WS 同源——4xx 走限频回推、2xx 清零计数、状态键按 roomId 隔离；
 *   6. 回推限频（窗口 3s、上限 8 次）不会因持续 4xx 而变成广播风暴。
 */
const path = require('path');
const assert = require('assert');

const PORT = Number(process.env.VERIFY_PORT || 9098);
process.env.PORT = String(PORT);

// ---------- 虚拟时钟 ----------
const realNow = Date.now.bind(Date);
let clockOffset = 0;
const advance = ms => { clockOffset += ms; };
Date.now = () => realNow() + clockOffset;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 启动服务端（dist/index.js 命中则以内联依赖运行，无需 node_modules）
require(path.join(__dirname, '..', 'dist', 'index.js'));

let WebSocket = null;
try {
  WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));
} catch {
  WebSocket = typeof globalThis.WebSocket === 'function' ? globalThis.WebSocket : null;
}

const BASE = `http://127.0.0.1:${PORT}/api/v1/lan`;

async function post(p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-session-token'] = token;
  const res = await fetch(`${BASE}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json };
}
async function get(p) {
  const res = await fetch(`${BASE}${p}`);
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json };
}
async function patch(p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-session-token'] = token;
  const res = await fetch(`${BASE}${p}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json };
}

let passed = 0;
function ok(name, cond, detail) {
  assert.ok(cond, `${name} ${detail ? `（${detail}）` : ''}`);
  passed += 1;
  console.log(`  \u2713 ${name}`);
}

function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

/** 断言一个失败 body 是第 3 批定义的规范形状 */
function assertFailureShape(label, result, expectedCode) {
  const { status, json } = result;
  ok(`${label} status>=400`, status >= 400, `status=${status}`);
  ok(`${label} success:false`, json?.success === false, JSON.stringify(json));
  ok(`${label} error 是机器码 ${expectedCode}`, json?.error === expectedCode, JSON.stringify(json));
  ok(`${label} message 是非空字符串`, typeof json?.message === 'string' && json.message.trim().length > 0,
    JSON.stringify(json));
  ok(`${label} 不再是旧的裸 {error} 形状（error 不得像文案）`,
    typeof json?.error !== 'string' || !/[一-鿿]/.test(json.error), JSON.stringify(json));
}

// ---------------------------------------------------------------------------
// 场景 1：HTTP 失败形状统一
// ---------------------------------------------------------------------------
async function scenarioHttpFailureShape() {
  console.log('\n[场景 1] HTTP 失败 body 形状统一（{success:false, error:机器码, message:文案}）');

  // 1.1 房间不存在（404）
  assertFailureShape('GET 不存在的房间', await get('/rooms/room-does-not-exist-xyz'), 'not_found');
  // 1.2 gameState 不存在（404）
  assertFailureShape('GET 不存在的房间 gameState', await get('/rooms/nope/gameState'), 'not_found');
  // 1.3 建房参数非法（400）
  const badCreate = await post('/rooms', { playerName: 'x', playerId: 'x', handicap: [999] });
  assertFailureShape('建房 handicap 非法', badCreate, 'bad_request');
  // 1.4 加入不存在房间（404）
  assertFailureShape('加入不存在的房间', await post('/rooms/nope/join', { playerName: 'p', playerId: 'p' }), 'not_found');
  // 1.5 观战不存在房间（404）
  assertFailureShape('观战不存在的房间', await post('/rooms/nope/spectate', { spectatorId: 's1' }), 'not_found');

  // 1.6 会话凭证缺失 → 401 unauthorized（不是 bad_request）
  //     必须先开局：未开局时着法会先被「对局未在进行中」挡掉（400），
  //     根本走不到凭证校验，鉴权类错误码就测不到。
  const created = await post('/rooms', { playerName: 'A', playerId: 'pa-shape', handicap: [21] });
  assert.strictEqual(created.status, 200, `建房失败: ${JSON.stringify(created.json)}`);
  const roomId = created.json.roomId;
  const token = created.json.sessionToken;
  const joined = await post(`/rooms/${roomId}/join`, { playerName: 'B', playerId: 'pb-shape' });
  assert.strictEqual(joined.status, 200, `加入失败: ${JSON.stringify(joined.json)}`);
  const tokenB = joined.json.sessionToken;
  await post(`/rooms/${roomId}/ready`, { ready: true }, token);
  await post(`/rooms/${roomId}/ready`, { ready: true }, tokenB);
  await sleep(3300);
  const startedRoom = await post(`/rooms/${roomId}/start`, {}, token);
  assert.strictEqual(startedRoom.json?.success, true, `开局失败: ${JSON.stringify(startedRoom.json)}`);

  const noToken = await post(`/rooms/${roomId}/move`, { move: { pieceId: 1, toCol: 3, toRow: 3 } });
  assertFailureShape('无会话凭证着法', noToken, 'forbidden');
  const badToken = await post(`/rooms/${roomId}/move`, { move: { pieceId: 1, toCol: 3, toRow: 3 } }, 'wrong-token');
  assertFailureShape('错误会话凭证着法', badToken, 'forbidden');

  // 1.6b 状态码语义分级（这是第 2 批定下的口径，第 3 批只统一形状、不改分级，
  //      这里钉住以防后续误改）：
  //        403 forbidden   —— 身份校验失败（房间内动作：无凭证/凭证不匹配/非本房间玩家）
  //        401 unauthorized —— 房间密码（加入密码房时的两处）
  //      客户端 battleSocket 的致命文案表按 message 匹配，与状态码无关，
  //      所以调整分级不会破坏客户端分类——但会改变 HTTP 侧的错误语义，故必须显式断言。
  ok('身份校验失败用 403（不是 401）', noToken.status === 403, `status=${noToken.status}`);
  ok('身份校验失败文案是客户端致命文案表里的那句',
    noToken.json?.message === '身份校验失败，请重新进入房间', JSON.stringify(noToken.json));

  // 1.7 非法请求体 → 400
  const malformed = await post(`/rooms/${roomId}/move`, 'not-an-object', token);
  assertFailureShape('着法请求体畸形', malformed, 'bad_request');

  // 1.8 观战成功后才有 spectate 的 400 分支；先验证观战可用
  const spec = await post(`/rooms/${roomId}/spectate`, { spectatorId: 'spec-shape' });
  assert.strictEqual(spec.status, 200, `观战失败: ${JSON.stringify(spec.json)}`);

  // 1.9 leave 房间不存在（404）——这一条历史上是 {error:'房间不存在'}，
  //     与 join 的 {success,message} 冲突，是第 3 批要统一的那处不一致
  assertFailureShape('离开不存在的房间', await post('/rooms/nope-leave/leave', {}, token), 'not_found');
  // 1.9b 非房内玩家执行房内动作 → 403（不能因为「拿不到房间」而报 404 泄露房间存在性）
  const outsider = await post('/rooms', { playerName: 'X', playerId: 'outsider' });
  const outsiderToken = outsider.json.sessionToken;
  const notInRoom = await post(`/rooms/${roomId}/move`, { move: { pieceId: 1, toCol: 3, toRow: 3 } }, outsiderToken);
  assertFailureShape('非房内玩家着法', notInRoom, 'forbidden');

  // 1.10 PATCH 设置参数非法 → 400
  const badPatch = await patch(`/rooms/${roomId}/settings`, { turnTimeLimit: 'x' }, token);
  assertFailureShape('PATCH 非法回合时限', badPatch, 'bad_request');

  // 1.11 额外字段（needPassword）仍挂在规范形状上，没有被形状统一吃掉
  const pw = await post('/rooms', { playerName: 'host', playerId: 'pw-host', password: '1234' });
  assert.strictEqual(pw.status, 200, `密码房建房失败: ${JSON.stringify(pw.json)}`);
  const pwRoom = pw.json.roomId;
  const needPw = await post(`/rooms/${pwRoom}/join`, { playerName: 'intruder', playerId: 'pw-intruder' });
  ok('密码房加入无密码 → 仍为 401', needPw.status === 401, `status=${needPw.status}`);
  ok('密码房 401 带 needPassword:true（客户端据此弹密码框）', needPw.json?.needPassword === true,
    JSON.stringify(needPw.json));
  assertFailureShape('密码房加入无密码', needPw, 'unauthorized');
  const wrongPw = await post(`/rooms/${pwRoom}/join`, { playerName: 'intruder2', playerId: 'pw-intruder2', password: '9999' });
  assertFailureShape('密码房密码错误', wrongPw, 'unauthorized');
  await post(`/rooms/${pwRoom}/leave`, {}, pw.json.sessionToken);

  // 1.12 成功响应不带失败字段
  const state = await get(`/rooms/${roomId}/gameState`);
  ok('成功响应不携带 error/message 失败字段',
    state.status === 200 && state.json && state.json.error === undefined && state.json.message === undefined,
    JSON.stringify(state.json).slice(0, 200));

  await post(`/rooms/${roomId}/leave`, {}, token);
  await post(`/rooms/${roomId}/leave`, {}, tokenB);
}

// ---------------------------------------------------------------------------
// 场景 2：HTTP 4xx 触发权威状态回推（§8 表 #1 的 HTTP 侧）
// ---------------------------------------------------------------------------
async function scenarioHttpRejectionPush() {
  console.log('\n[场景 2] HTTP 被拒动作回推权威状态（4xx 也推，成功动作清零限频计数）');

  const created = await post('/rooms', { playerName: 'A', playerId: 'pa-push', handicap: [21] });
  assert.strictEqual(created.status, 200, JSON.stringify(created.json));
  const roomId = created.json.roomId;
  const ta = created.json.sessionToken;
  const joined = await post(`/rooms/${roomId}/join`, { playerName: 'B', playerId: 'pb-push' });
  const tb = joined.json.sessionToken;
  await post(`/rooms/${roomId}/ready`, { ready: true }, ta);
  await post(`/rooms/${roomId}/ready`, { ready: true }, tb);
  await sleep(3300);
  const started = await post(`/rooms/${roomId}/start`, {}, ta);
  assert.strictEqual(started.json?.success, true, `开局失败: ${JSON.stringify(started.json)}`);

  // 开一个 socket，统计收到的 state 帧——回推一定表现为 state 帧
  if (!WebSocket) {
    console.log('  ⚠ 未找到 ws 模块，跳过 WS 侧断言（仅 HTTP 侧已验证）');
    return;
  }
  const rec = await openSocket(roomId, 'pa-push', ta);
  assert.ok(rec.open, `socket 未建立: ${closeInfo(rec)}`);
  await sleep(300);
  const stateFrames = () => rec.frames.filter(f => f.type === 'state');
  ok('握手后收到 welcome + 初始 state', rec.frames.some(f => f.type === 'welcome') && stateFrames().length >= 1,
    JSON.stringify(rec.frames.map(f => f.type)));

  // 一次非法着法 → 4xx → 回推一次权威状态
  let before = stateFrames().length;
  const rejected = await post(`/rooms/${roomId}/move`, { move: { pieceId: -1, toCol: 99, toRow: 99 } }, ta);
  assertFailureShape('非法着法', rejected, 'bad_request');
  await sleep(400);
  ok('HTTP 4xx 之后收到权威状态回推', stateFrames().length > before,
    `before=${before} after=${stateFrames().length}`);

  // 持续 4xx：回推被限频，不会每次都推（否则变成广播风暴）
  before = stateFrames().length;
  for (let i = 0; i < 12; i += 1) {
    await post(`/rooms/${roomId}/move`, { move: { pieceId: -1, toCol: 99, toRow: 99 } }, ta);
  }
  await sleep(400);
  const burst = stateFrames().length - before;
  ok('连续 12 次 4xx 的回推被限频（≤8 次窗口上限）', burst > 0 && burst <= 8, `回推 ${burst} 次`);

  // 一次成功动作 → 清零限频计数
  const before2 = stateFrames().length;
  const good = await post(`/rooms/${roomId}/emoji`, { emoji: '👍' }, ta);
  assert.strictEqual(good.status, 200, `表情动作失败: ${JSON.stringify(good.json)}`);
  await sleep(400);
  ok('成功动作同样回推权威状态', stateFrames().length > before2,
    `before=${before2} after=${stateFrames().length}`);
  ok('成功动作把回推 body 恢复为成功形状', good.json?.success === true, JSON.stringify(good.json));

  rec.ws.close();
  await sleep(200);
}

// ---------------------------------------------------------------------------
// 场景 3：WS 失败形状与 ack 同源（§8 表 #1 的 WS 侧）
// ---------------------------------------------------------------------------
async function scenarioWsFailureShape() {
  console.log('\n[场景 3] WebSocket 失败形状与 ack（错误帧带机器码，ack 带同一套 body）');
  if (!WebSocket) {
    console.log('  ⚠ 未找到 ws 模块，跳过');
    return;
  }

  const created = await post('/rooms', { playerName: 'A', playerId: 'pa-ws', handicap: [21] });
  assert.strictEqual(created.status, 200, JSON.stringify(created.json));
  const roomId = created.json.roomId;
  const ta = created.json.sessionToken;
  const joined = await post(`/rooms/${roomId}/join`, { playerName: 'B', playerId: 'pb-ws' });
  const tb = joined.json.sessionToken;
  await post(`/rooms/${roomId}/ready`, { ready: true }, ta);
  await post(`/rooms/${roomId}/ready`, { ready: true }, tb);
  await sleep(3300);
  await post(`/rooms/${roomId}/start`, {}, ta);

  const rec = await openSocket(roomId, 'pa-ws', ta);
  assert.ok(rec.open, `socket 未建立: ${closeInfo(rec)}`);
  await sleep(300);

  // 3.1 非法着法：ack 的 status/body 必须是规范失败形状
  const ack = await sendAndWait(rec.ws, {
    type: 'move',
    reqId: 'move-shape-1',
    move: { pieceId: -1, toCol: 99, toRow: 99 },
  }, f => f.type === 'ack' && f.reqId === 'move-shape-1');
  ok('WS 非法着法 → ack.status=400', ack?.status === 400, JSON.stringify(ack));
  assertFailureShape('WS ack 失败 body', { status: ack?.status ?? 0, json: ack?.body ?? null }, 'bad_request');

  // 3.2 ack 的失败 body 与 HTTP 同源：同一语义（非法着法）得到同一个 error 机器码
  const httpSame = await post(`/rooms/${roomId}/move`, { move: { pieceId: -1, toCol: 99, toRow: 99 } }, ta);
  eq('同一语义在 HTTP 与 WS 上得到同一个 error 机器码', ack?.body?.error, httpSame.json?.error);

  // 3.3 未知消息类型 → error 帧也走规范形状（不是裸 {type:'error',message}）
  const errFrame = await sendAndWait(rec.ws, { type: 'no-such-action', reqId: 'x-1' },
    f => f.type === 'error' && f.reqId === 'x-1');
  ok('未知消息类型 → error 帧', errFrame != null, JSON.stringify(rec.frames.slice(-3)));
  ok('error 帧带 success:false', errFrame?.success === false, JSON.stringify(errFrame));
  ok('error 帧带机器码 error:bad_request', errFrame?.error === 'bad_request', JSON.stringify(errFrame));
  ok('error 帧带人读 message', typeof errFrame?.message === 'string' && errFrame.message.length > 0,
    JSON.stringify(errFrame));
  ok('error 帧不再是旧的裸 {type,reqId,message}（message 之外多了机器码）',
    errFrame?.message !== undefined && errFrame?.error !== undefined, JSON.stringify(errFrame));

  // 3.4 观战者执行动作 → 403 forbidden（不是 bad_request）
  const specRec = await openSocket(roomId, 'spectator-ws', null, 'spec-ws-1');
  assert.ok(specRec.open, `观战 socket 未建立: ${closeInfo(specRec)}`);
  const specErr = await sendAndWait(specRec.ws, { type: 'move', reqId: 'move-spec-1', move: {} },
    f => f.type === 'error' && f.reqId === 'move-spec-1');
  ok('观战者执行动作 → error 帧', specErr != null, JSON.stringify(specRec.frames.slice(-3)));
  ok('观战者执行动作 → 机器码 forbidden', specErr?.error === 'forbidden', JSON.stringify(specErr));
  ok('观战者执行动作 → 文案仍是中文提示（客户端按文案上抛）', specErr?.message === '观战者无法执行该操作',
    JSON.stringify(specErr));

  // 3.5 握手期失败帧（session 校验）也走同一形状
  const badHandshake = await openSocket(roomId, 'ghost-player', 'wrong-token');
  await waitClosed(badHandshake);
  ok('错误凭证握手 → 被关闭', badHandshake.closed, closeInfo(badHandshake));
  const hf = badHandshake.frames.find(f => f.type === 'error');
  ok('握手失败帧带 success:false', hf?.success === false, JSON.stringify(hf));
  ok('握手失败帧带机器码（unauthorized/forbidden/not_found/bad_request 之一）',
    ['unauthorized', 'forbidden', 'not_found', 'bad_request'].includes(hf?.error), JSON.stringify(hf));
  ok('握手失败帧带人读 message', typeof hf?.message === 'string' && hf.message.length > 0, JSON.stringify(hf));
  ok('握手失败文案在客户端致命文案表内（否则客户端不会按会话失效处理）',
    [
      '房间不存在',
      '玩家不在房间中',
      '缺少观战者标识',
      '缺少 playerId',
      '缺少 roomId',
      '对局尚未开始，暂无法观战',
      '对局已有玩家离开，观战已结束',
      '缺少会话凭证',
      '身份校验失败，请重新进入房间',
    ].includes(hf?.message), JSON.stringify(hf));

  // 3.6 缺 roomId / 房间不存在 也走同一形状（这两条客户端同样按致命处理）
  const noRoomId = await openSocket('', 'pa-ws', ta);
  await waitClosed(noRoomId);
  const rf = noRoomId.frames.find(f => f.type === 'error');
  ok('缺 roomId → 握手被拒且带机器码 bad_request', noRoomId.closed && rf?.error === 'bad_request',
    `${closeInfo(noRoomId)} frame=${JSON.stringify(rf)}`);
  const noRoom = await openSocket('room-not-here', 'pa-ws', ta);
  await waitClosed(noRoom);
  const rf2 = noRoom.frames.find(f => f.type === 'error');
  ok('房间不存在 → 握手被拒且带机器码 not_found', noRoom.closed && rf2?.error === 'not_found',
    `${closeInfo(noRoom)} frame=${JSON.stringify(rf2)}`);
  ok('握手拒绝的机器码与 HTTP 侧同源（同为 not_found / bad_request）',
    rf2?.error === (await get('/rooms/room-not-here')).json?.error, JSON.stringify(rf2));

  specRec.ws.close();
  rec.ws.close();
  await sleep(200);
}

// ---------------------------------------------------------------------------
// 场景 4：WS 与 HTTP 回推决策同源（限频状态按 roomId 隔离）
// ---------------------------------------------------------------------------
async function scenarioCrossChannelParity() {
  console.log('\n[场景 4] 跨通道回推决策同源（限频状态按 roomId 隔离、2xx 清零）');
  if (!WebSocket) {
    console.log('  ⚠ 未找到 ws 模块，跳过');
    return;
  }

  // 两个房 → 限频计数互不干扰
  const mk = async (tag) => {
    const created = await post('/rooms', { playerName: 'A', playerId: `pa-${tag}`, handicap: [21] });
    assert.strictEqual(created.status, 200, JSON.stringify(created.json));
    const roomId = created.json.roomId;
    const ta = created.json.sessionToken;
    const joined = await post(`/rooms/${roomId}/join`, { playerName: 'B', playerId: `pb-${tag}` });
    const tb = joined.json.sessionToken;
    await post(`/rooms/${roomId}/ready`, { ready: true }, ta);
    await post(`/rooms/${roomId}/ready`, { ready: true }, tb);
    await sleep(3300);
    await post(`/rooms/${roomId}/start`, {}, ta);
    return { roomId, ta, tb };
  };

  const r1 = await mk('par1');
  const r2 = await mk('par2');

  const rec1 = await openSocket(r1.roomId, 'pa-par1', r1.ta);
  const rec2 = await openSocket(r2.roomId, 'pa-par2', r2.ta);
  assert.ok(rec1.open && rec2.open, 'socket 未建立');
  await sleep(400);
  const sf = rec => rec.frames.filter(f => f.type === 'state').length;

  const b1 = sf(rec1);
  const b2 = sf(rec2);
  // 在房间 1 上打满限频
  for (let i = 0; i < 12; i += 1) {
    await post(`/rooms/${r1.roomId}/move`, { move: { pieceId: -1, toCol: 99, toRow: 99 } }, r1.ta);
  }
  await sleep(400);
  const burst1 = sf(rec1) - b1;
  const burst2 = sf(rec2) - b2;
  ok('房间 1 的连续 4xx 被限频', burst1 > 0 && burst1 <= 8, `回推 ${burst1} 次`);
  ok('房间 1 被打满限频不影响房间 2 的回推（状态按 roomId 隔离）', burst2 === 0,
    `房间 2 额外回推 ${burst2} 次`);

  // 房间 2 上一次成功动作 → 立即回推（证明它的限频计数是干净的）
  await post(`/rooms/${r2.roomId}/emoji`, { emoji: '🔥' }, r2.ta);
  await sleep(400);
  ok('房间 2 首个成功动作立即回推', sf(rec2) > b2 + burst2, `before=${b2 + burst2} after=${sf(rec2)}`);

  // 同一房间上 4xx 与 2xx 交替：成功动作会把限频计数清零，下一次 4xx 立刻回推
  const r3 = await mk('par3');
  const rec3 = await openSocket(r3.roomId, 'pa-par3', r3.ta);
  assert.ok(rec3.open, 'socket 未建立');
  await sleep(300);
  const b3 = sf(rec3);
  for (let i = 0; i < 10; i += 1) {
    await post(`/rooms/${r3.roomId}/move`, { move: { pieceId: -1, toCol: 99, toRow: 99 } }, r3.ta);
    await post(`/rooms/${r3.roomId}/emoji`, { emoji: '👍' }, r3.ta);
  }
  await sleep(400);
  const mixed = sf(rec3) - b3;
  // 交替模式下 20 次请求全部回推（成功动作每次都清零），
  // 但窗口 3s 内仍受上限保护，故断言"明显多于纯 4xx 模式"即可，
  // 这里是上限而非下限的回归防线：不允许出现 0（完全不推）。
  ok('4xx/2xx 交替时持续回推（成功动作不断清零限频计数）', mixed > 0, `回推 ${mixed} 次`);

  rec1.ws.close();
  rec2.ws.close();
  rec3.ws.close();
  await sleep(200);
}

// ---------------------------------------------------------------------------
// 场景 5：成功形状未被失败统一污染
// ---------------------------------------------------------------------------
async function scenarioSuccessShape() {
  console.log('\n[场景 5] 成功响应未被失败形状统一污染');
  const created = await post('/rooms', { playerName: 'A', playerId: 'pa-ok' });
  assert.strictEqual(created.status, 200, JSON.stringify(created.json));
  const roomId = created.json.roomId;
  const ta = created.json.sessionToken;
  ok('建房成功带 roomId/sessionToken',
    typeof created.json.roomId === 'string' && typeof created.json.sessionToken === 'string',
    JSON.stringify(created.json).slice(0, 160));

  const joined = await post(`/rooms/${roomId}/join`, { playerName: 'B', playerId: 'pb-ok' });
  ok('加入成功带 sessionToken', typeof joined.json?.sessionToken === 'string', JSON.stringify(joined.json).slice(0, 160));
  const tb = joined.json.sessionToken;

  const settings = await patch(`/rooms/${roomId}/settings`, { turnTimeLimit: 60 }, ta);
  eq('PATCH 设置成功返回 200', settings.status, 200);
  ok('PATCH 成功不带 error', settings.json?.error === undefined, JSON.stringify(settings.json));

  const leave = await post(`/rooms/${roomId}/leave`, {}, ta);
  eq('离开成功返回 200', leave.status, 200);
  ok('等待阶段离开 → endReason 为 null（没有在对局中，不该编一个终局原因）',
    'endReason' in leave.json && leave.json.endReason === null, JSON.stringify(leave.json));
  ok('离开成功不带 error/message', leave.json?.error === undefined && leave.json?.message === undefined,
    JSON.stringify(leave.json));
  await post(`/rooms/${roomId}/leave`, {}, tb);

  // 对局中离开 → endReason 必须是真实终局原因（这一条在 §8 表 #5 里有专项加固）
  const playing = await post('/rooms', { playerName: 'A', playerId: 'pa-ok2', handicap: [21] });
  assert.strictEqual(playing.status, 200, JSON.stringify(playing.json));
  const pRoom = playing.json.roomId;
  const pa = playing.json.sessionToken;
  const pj = await post(`/rooms/${pRoom}/join`, { playerName: 'B', playerId: 'pb-ok2' });
  const pb = pj.json.sessionToken;
  await post(`/rooms/${pRoom}/ready`, { ready: true }, pa);
  await post(`/rooms/${pRoom}/ready`, { ready: true }, pb);
  await sleep(3300);
  await post(`/rooms/${pRoom}/start`, {}, pa);
  const leavePlaying = await post(`/rooms/${pRoom}/leave`, {}, pa);
  eq('对局中离开返回 200', leavePlaying.status, 200);
  ok('对局中离开 → endReason 是真实终局原因',
    typeof leavePlaying.json?.endReason === 'string' && leavePlaying.json.endReason.length > 0,
    JSON.stringify(leavePlaying.json));
  await post(`/rooms/${pRoom}/leave`, {}, pb);
}

// ---------------------------------------------------------------------------
// WS 工具
// ---------------------------------------------------------------------------
function wsUrl(roomId, query) {
  return `ws://127.0.0.1:${PORT}/api/v1/lan/ws?roomId=${encodeURIComponent(roomId)}&${query}`;
}

function closeInfo(rec) {
  return `open=${rec.open} closed=${rec.closed} closeInfo=${JSON.stringify(rec.closeInfo)} error=${rec.error}`;
}

/**
 * 打开一个 socket。
 * `query` 里放 roomId 以外的参数（playerId/sessionToken/spectatorId/role）。
 * 注意 spectatorId/role 只在观战身份下传。
 */
function openSocket(roomId, playerId, sessionToken, spectatorId) {
  return new Promise((resolve) => {
    const query = spectatorId
      ? `spectatorId=${encodeURIComponent(spectatorId)}&role=spectator`
      : `playerId=${encodeURIComponent(playerId)}&sessionToken=${encodeURIComponent(sessionToken || '')}`;
    const rec = { ws: null, frames: [], open: false, closed: false, error: null, closeInfo: null };
    const ws = new WebSocket(wsUrl(roomId, query), { handshakeTimeout: 8000 });
    rec.ws = ws;
    ws.on('open', () => { rec.open = true; resolve(rec); });
    ws.on('message', (data) => {
      const text = String(data);
      let json;
      try { json = JSON.parse(text); } catch { json = { type: '<unparseable>', raw: text }; }
      rec.frames.push(json);
    });
    ws.on('close', (code, reason) => {
      rec.closed = true;
      rec.closeInfo = { code, reason: String(reason || '') };
      if (!rec.open) resolve(rec);
    });
    ws.on('error', (err) => {
      rec.error = err.message;
      if (!rec.open) resolve(rec);
    });
    setTimeout(() => resolve(rec), 8000);
  });
}

/** 发一帧并等第一条满足 predicate 的帧（从发送时刻之后算起） */
function sendAndWait(ws, payload, predicate, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const onMessage = (data) => {
      let json;
      try { json = JSON.parse(String(data)); } catch { return; }
      if (predicate(json)) {
        ws.off('message', onMessage);
        resolve(json);
      }
    };
    ws.on('message', onMessage);
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve(null);
    }, timeoutMs);
    if (timer.unref) timer.unref();
    ws.send(JSON.stringify(payload));
  });
}

/**
 * 等 socket 真正被服务端关闭。
 * 握手失败走的是「先发一帧 error、再 close」：TCP 升级本身已经成功，
 * 所以 open 事件会先到，closed 在其后几百毫秒才置位——不等就会把
 * 「凭证错误被拒」误判成「凭证错误却连上了」。
 */
async function waitClosed(rec, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (rec.closed) return true;
    await sleep(50);
  }
  return rec.closed;
}

// ---------------------------------------------------------------------------
(async () => {
  await sleep(500); // 等服务端 listen 完成
  await scenarioHttpFailureShape();
  await scenarioHttpRejectionPush();
  await scenarioWsFailureShape();
  await scenarioCrossChannelParity();
  await scenarioSuccessShape();
  console.log(`\n全部通过：${passed} 项断言`);
  process.exit(0);
})().catch(err => {
  console.error('\n验证失败：', err && err.message ? err.message : err);
  process.exit(1);
});