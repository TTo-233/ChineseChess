#!/usr/bin/env node
/**
 * 联机断线恢复回归验证（无需安装依赖，直接驱动 dist/index.js 这个唯一可运行主体）
 *
 * 用法：
 *   node scripts/verify-lan-disconnect.cjs
 *   VERIFY_PORT=9099 node scripts/verify-lan-disconnect.cjs
 *
 * 验证目标（对应「联机冒烟：断线恢复类问题」）：
 *   1. 后台标签页心跳被浏览器节流（心跳间隔被拉长到分钟级）→ 不再被误判断线；
 *   2. 后台保护窗口结束后仍要恢复常规判负 → 对局不会被无限挂起；
 *   3. 玩家回到前台（心跳/重连恢复）→ 立即撤销断线等待，不会按旧计时被误判负；
 *   4. 断线判负 / 对局结束后，仍在后台的玩家不会被立刻移出房间（房间不销毁），
 *      回来的客户端才能收到终局状态并刷新 UI。
 *
 * 实现要点：把 Date.now() 换成可推进的虚拟时钟（定时器仍按真实时间运行），
 * 从而在不等待数分钟的情况下模拟「浏览器后台节流 + 服务端 1s tick」的真实时序。
 */

const path = require('path');
const assert = require('assert');

const PORT = Number(process.env.VERIFY_PORT || 9099);
process.env.PORT = String(PORT);

// ---------- 虚拟时钟 ----------
const realNow = Date.now.bind(Date);
let clockOffset = 0;
/** 推进虚拟时间：模拟一段时间内没有心跳（浏览器节流）/ 一段时间自然流逝 */
const advance = ms => { clockOffset += ms; };
Date.now = () => realNow() + clockOffset;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** 等待服务端若干次 gameTick（真实 1s 一次），确保虚拟时间推进后逻辑已被执行 */
const ticks = async (n = 2) => { await sleep(n * 1000 + 250); };

// 启动服务端（dist/index.js 命中则以内联依赖运行，无需 node_modules）
require(path.join(__dirname, '..', 'dist', 'index.js'));

const BASE = `http://127.0.0.1:${PORT}/api/v1/lan`;

async function post(p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
const roomState = async roomId => (await get(`/rooms/${roomId}/gameState`)).json;
const heartbeat = (roomId, playerId, hidden) => post(`/rooms/${roomId}/heartbeat`, { playerId, hidden });

/**
 * 分步推进虚拟时间，并在每一步为「前台玩家」补发心跳（模拟其正常的秒级心跳）。
 * 若一次性跳跃时间，前台玩家也会因心跳变陈旧而被判断线，干扰对被测玩家的观察。
 */
async function advanceWithForegroundHeartbeat(totalMs, roomId, foregroundIds, stepMs = 8_000) {
  let left = totalMs;
  while (left > 0) {
    const step = Math.min(stepMs, left);
    advance(step);
    left -= step;
    for (const pid of foregroundIds) await heartbeat(roomId, pid, false);
  }
}

let passed = 0;
function ok(name, cond, detail) {
  assert.ok(cond, `${name} ${detail ? `（${detail}）` : ''}`);
  passed += 1;
  console.log(`  \u2713 ${name}`);
}

/** 建一个已进入对局的让子房（让子房双方准备后自动分配阵营，省去选边流程） */
async function setupPlayingRoom(tag) {
  const pa = `pa-${tag}`;
  const pb = `pb-${tag}`;
  const created = await post('/rooms', { playerName: `A-${tag}`, playerId: pa, handicap: [21] });
  assert.strictEqual(created.status, 200, `建房失败: ${JSON.stringify(created.json)}`);
  const roomId = created.json.roomId;
  const joined = await post(`/rooms/${roomId}/join`, { playerName: `B-${tag}`, playerId: pb });
  assert.strictEqual(joined.status, 200, `加入失败: ${JSON.stringify(joined.json)}`);
  await post(`/rooms/${roomId}/ready`, { playerId: pa, ready: true });
  const ready = await post(`/rooms/${roomId}/ready`, { playerId: pb, ready: true });
  assert.ok(ready.json?.autoRevealed, `让子房未自动公示阵营: ${JSON.stringify(ready.json)}`);
  await sleep(3300); // 等 START_COUNTDOWN_MS（3s）走完
  const started = await post(`/rooms/${roomId}/start`, { playerId: pa });
  assert.strictEqual(started.json?.success, true, `开局失败: ${JSON.stringify(started.json)}`);
  const state = await roomState(roomId);
  assert.strictEqual(state.phase, 'playing', `未进入对局: ${JSON.stringify(state.phase)}`);
  return { roomId, pa, pb };
}

async function scenarioBackgroundThrottle() {
  console.log('\n[场景 1+2] 后台标签页心跳节流不误判 / 保护窗口到期后恢复常规判负');
  const { roomId, pa, pb } = await setupPlayingRoom('bg');

  // 进入后台并立刻上报（此时定时器尚未被节流，服务端拿到 hidden=true）
  await heartbeat(roomId, pa, true);
  // 模拟节流下的分钟级心跳：每次虚拟前进 60s，后台玩家只发一次心跳，前台对手照常心跳
  for (let i = 0; i < 2; i += 1) {
    await advanceWithForegroundHeartbeat(60_000, roomId, [pb]);
    await ticks(1);
    const st = await roomState(roomId);
    ok(`第 ${i + 1} 分钟后台心跳空档 → 仍在对局中`,
      st.phase === 'playing' && st.disconnectedPlayerId === null,
      `phase=${st.phase} disconnected=${st.disconnectedPlayerId}`);
    const me = st.players.find(p => p.id === pa);
    ok(`第 ${i + 1} 分钟后台心跳空档 → 未被标记断线`, me && me.connected === true, JSON.stringify(me));
    await heartbeat(roomId, pa, true);
  }

  // 超过后台保护上限（HIDDEN_MAX_DURATION=3 分钟）：恢复常规判负，避免对局被无限挂起
  await advanceWithForegroundHeartbeat(200_000, roomId, [pb]);
  await ticks(2);
  const marked = await roomState(roomId);
  ok('超过后台保护上限 → 判定为断线等待',
    marked.phase === 'playing' && marked.disconnectedPlayerId === pa,
    `phase=${marked.phase} disconnected=${marked.disconnectedPlayerId} players=${JSON.stringify(marked.players)}`);

  await advanceWithForegroundHeartbeat(70_000, roomId, [pb]);
  await ticks(2);
  const ended = await roomState(roomId);
  ok('断线等待超时 → 判负结束',
    ended.phase === 'ended' && ended.endReason === 'disconnect' && ended.winner === 'black',
    `phase=${ended.phase} reason=${ended.endReason} winner=${ended.winner}`);
}

async function scenarioReturnClearsCountdown() {
  console.log('\n[场景 3] 回到前台立即撤销断线等待，不按旧计时误判负');
  const { roomId, pa, pb } = await setupPlayingRoom('back');

  // 真断线：心跳停止超过 HEARTBEAT_TIMEOUT(10s)
  await advanceWithForegroundHeartbeat(20_000, roomId, [pb]);
  await ticks(2);
  const disconnected = await roomState(roomId);
  ok('心跳超时 → 进入断线等待', disconnected.disconnectedPlayerId === pa, `disconnected=${disconnected.disconnectedPlayerId}`);

  // 回到前台：客户端立即补发 hidden=false 的心跳
  await heartbeat(roomId, pa, false);
  const resumed = await roomState(roomId);
  ok('回前台心跳 → 立即撤销断线等待',
    resumed.disconnectedPlayerId === null && resumed.phase === 'playing',
    `phase=${resumed.phase} disconnected=${resumed.disconnectedPlayerId}`);

  // 超过原 DISCONNECT_TIMEOUT(60s)：若仍按旧 disconnectTime 计时，此处会被判负
  await advanceWithForegroundHeartbeat(120_000, roomId, [pb]);
  await ticks(2);
  const later = await roomState(roomId);
  ok('断线等待撤销后越过 60s → 仍在对局中（未被旧计时判负）',
    later.phase === 'playing' && later.winner === null,
    `phase=${later.phase} winner=${later.winner}`);
}

async function scenarioRoomKeptForHiddenPlayer() {
  console.log('\n[场景 4] 对局结束后后台玩家不被移出，房间不销毁（回来能收到终局状态）');
  const { roomId, pa, pb } = await setupPlayingRoom('keep');

  // pa 在后台（分钟级心跳保活），对手直接认输结束对局
  await heartbeat(roomId, pa, true);
  advance(5_000);
  const surrendered = await post(`/rooms/${roomId}/surrender`, { playerId: pb });
  ok('对手认输 → 对局结束', surrendered.json?.winner === 'red', JSON.stringify(surrendered.json));

  // 结束后的自愈窗口（ENDED_STALE_GRACE_MS=10s）到期：双方都没有活跃连接
  advance(15_000);
  await ticks(2);
  const room = await get(`/rooms/${roomId}`);
  ok('房间仍存在（未被销毁）', room.status === 200, `status=${room.status}`);
  const stillIn = (room.json?.room?.players ?? []).some(p => p.id === pa);
  ok('后台玩家仍在房间成员列表中（不会被误移出）', stillIn, JSON.stringify(room.json?.room?.players));
}

(async () => {
  await sleep(500); // 等服务端 listen 完成
  await scenarioBackgroundThrottle();
  await scenarioReturnClearsCountdown();
  await scenarioRoomKeptForHiddenPlayer();
  console.log(`\n全部通过：${passed} 项断言`);
  process.exit(0);
})().catch(err => {
  console.error('\n验证失败：', err && err.message ? err.message : err);
  process.exit(1);
});
