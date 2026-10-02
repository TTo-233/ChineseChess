#!/usr/bin/env node
/**
 * 服务端加固回归验证（自包含：不 spawn 子进程，直接在本进程内 require dist/index.js）
 *
 * 用法：
 *   node scripts/verify-server-hardening.cjs
 *   VERIFY_PORT=9101 node scripts/verify-server-hardening.cjs
 *
 * 为什么存在这个脚本：
 *   dist/index.js 是现网部署产物，历史上只能靠 scripts/patch-dist.mjs 往产物里手打补丁。
 *   源码复原到 src/ 之后补丁会在源码层归位、patch-dist.mjs 将退役，因此必须有一个
 *   **留在仓库里的回归脚本**，防止这 6 条加固行为在将来被改回漏洞：
 *
 *   补丁一  长将长捉不拦截：超限不再拒绝落子、不再按违规次数判负（静态断言覆盖）。
 *   补丁二  畸形 FEN 行宽校验：行宽 ≠ 9 的 FEN 在进入 Pikafish WASM 之前被 400 拦下，
 *           否则 WASM 越界写内存、4 个 worker 一起崩。
 *   补丁三  初始局面上传收紧：完整局面上传（POST /rooms/:id/gameState，无 move）必须
 *           ① 仅限房内玩家；② 仅在本局尚无任何着法时。否则任何人只要知道 6 位房间号，
 *           就能匿名改写进行中的棋盘。
 *   补丁四  旧协议分支不再由请求体驱动终局：附加 {gameOver:true,winner:'red'} 不能伪造胜负。
 *   补丁五  被拒绝的动作回推权威状态（由 A2/A3 的隐含前提覆盖：拒绝后客户端仍能拿到权威局面）。
 *   补丁六  房间名「最小空缺优先」：销毁房间后其编号被复用，而不是只增不减。
 *
 * 断言清单（对应源码层六条加固）：
 *   A 新协议走子（服务端权威裁决）：合法着法 200 且 moveHistory +1；非法走法 400 且棋盘不变；
 *     非当前回合方走子 400。
 *   B 初始局面上传收紧：无着法时房内玩家上传 200；已有 1 手后同一玩家上传 403 且棋盘未回退；
 *     已有 1 手后伪造 gameOver/winner 被拒且 phase 仍为 playing；陌生人上传被拒。
 *   C 畸形 FEN 校验：合法 FEN 不返回 invalid_fen；行数/行宽非法的 FEN 返回 400 + invalid_fen。
 *   D 房间名最小空缺优先：连建 3 房（房间1/2/3）→ 销毁「房间1」→ 新建重新得到「房间1」，
 *     而不是「房间3」（旧实现 let n = rooms.size + 1 的结果）。D1 只是基准守卫，D3 才是判据。
 *   E 长将长捉不拦截：dist/index.js 全文不含 isMoveBanned（出现即说明拦截逻辑回到了产物里）。
 *
 * 实现要点：走子不硬编码 pieceId/目标格，而是先 GET gameState 拿服务端局面，再用同源的
 * 规则引擎（../ruleEngine.cjs）枚举一个合法着法/非法着法，避免「测错子」这类假阳性。
 */

const path = require('path');
const assert = require('assert');
const fs = require('fs');

const PORT = Number(process.env.VERIFY_PORT || 9101);
process.env.PORT = String(PORT);

// 启动服务端（dist/index.js 命中则以内联依赖运行，无需 node_modules）。
// Node 24 支持 require(ESM)；随后所有请求都在本进程内通过 HTTP 自测。
require(path.join(__dirname, '..', 'dist', 'index.js'));

// 与客户端同源的规则引擎：用来在测试里枚举合法/非法着法，而不是硬编码棋子 id。
const ruleEngine = require(path.join(__dirname, '..', 'ruleEngine.cjs'));

const BASE = `http://127.0.0.1:${PORT}/api/v1/lan`;
const AI_BASE = `http://127.0.0.1:${PORT}/api/v1/ai`;
const DIST_PATH = path.join(__dirname, '..', 'dist', 'index.js');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
async function postAi(body) {
  const res = await fetch(`${AI_BASE}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json };
}

const roomState = async roomId => (await get(`/rooms/${roomId}/gameState`)).json;
const heartbeat = (roomId, playerId) => post(`/rooms/${roomId}/heartbeat`, { playerId, hidden: false });

let passed = 0;
function ok(name, cond, detail) {
  assert.ok(cond, `${name} ${detail ? `（${detail}）` : ''}`);
  passed += 1;
  console.log(`  \u2713 ${name}`);
}

/** 房间是否已无成员（用于确认销毁房间确实释放了编号） */
const leaveAll = async (roomId, playerIds) => {
  for (const pid of playerIds) await post(`/rooms/${roomId}/leave`, { playerId: pid });
};

/**
 * 建一个已进入对局的让子房（让子房双方准备后自动分配阵营，省去选边流程）。
 * @returns {Promise<{roomId: string, pa: string, pb: string, hostSide: 'red'|'black'}>}
 */
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
  const host = state.players.find(p => p.id === pa);
  assert.ok(host, `房主不在房间成员里: ${JSON.stringify(state.players)}`);
  return { roomId, pa, pb, hostSide: host.side };
}

/**
 * 在服务端返回的局面里枚举一个「当前走子方」的合法着法。
 * 不硬编码 pieceId/目标格：pieceId 29 其实是 (4,6) 的红兵，而 (7,7) 的红炮是 26，
 * 一次性草稿 exploit-test5.ps1 就是在这一点上测错了对象。
 * ⚠️ 棋子归属：**0..15 为黑方，16..31 为红方**（ruleEngine.cjs 的 sideOfPiece：id<=15 ? BLACK : RED）。
 * @returns {{pieceId:number,toCol:number,toRow:number,sideTag:boolean}}
 */
function findLegalMoveForSide(gameState, side) {
  // 红方 = 16..31（九宫在下、行号大），黑方 = 0..15
  const ids = side === 'red' ? Array.from({ length: 16 }, (_, i) => i + 16) : [...Array(16).keys()];
  for (const pieceId of ids) {
    const piece = gameState.pieces[pieceId];
    if (!piece || !piece.alive) continue;
    const valid = ruleEngine.getValidMoves(gameState, pieceId);
    for (let col = 0; col < 9; col++) {
      for (let row = 0; row < 10; row++) {
        if (valid && valid[col] && valid[col][row]) {
          return { pieceId, toCol: col, toRow: row, sideTag: gameState.sideTag };
        }
      }
    }
  }
  return null;
}

/** 找一个同 pieceId 但明显非法的目标格（规则引擎判定为 false 的格子） */
function findIllegalTarget(gameState, pieceId) {
  const valid = ruleEngine.getValidMoves(gameState, pieceId);
  for (let col = 0; col < 9; col++) {
    for (let row = 0; row < 10; row++) {
      if (!(valid && valid[col] && valid[col][row])) return { toCol: col, toRow: row };
    }
  }
  return null;
}

/**
 * A. 新协议走子：服务端权威裁决
 * 客户端只发 {playerId, move}，服务端用规则引擎校验并执行（拒绝时 400 且棋盘不变）。
 */
async function scenarioAuthorityMoves() {
  console.log('\n[A] 新协议走子：服务端权威裁决');
  const { roomId, pa, pb, hostSide } = await setupPlayingRoom('mv');

  // 让子房开局后 room.gameState 仍是 null（等待客户端上传初始局面）。
  // 这里直接上传一份规则引擎生成的初始局面，作为新协议走子的棋盘基准。
  const initial = ruleEngine.createInitialState(true);
  const upload = await post(`/rooms/${roomId}/gameState`, { playerId: pa, gameState: initial });
  ok('A0 让子房无着法时可上传初始局面（旧协议分支仍保留唯一合法用途）',
    upload.status === 200, `status=${upload.status} body=${JSON.stringify(upload.json)}`);

  // A1 合法着法：从服务端局面枚举，不硬编码
  const before = await roomState(roomId);
  const beforeMoves = Array.isArray(before.gameState?.moveHistory) ? before.gameState.moveHistory.length : 0;
  const legal = findLegalMoveForSide(before.gameState, hostSide);
  assert.ok(legal, '规则引擎在当前局面上枚举不到任何合法着法，测试基准有误');
  const mover = hostSide; // 开局走子方 = sideTag 对应的红方（让子房房主恒为红）
  const mv = await post(`/rooms/${roomId}/gameState`, {
    playerId: mover === 'red' ? pa : pb,
    move: { pieceId: legal.pieceId, toCol: legal.toCol, toRow: legal.toRow },
  });
  ok('A1 合法着法被服务端接受（200）', mv.status === 200,
    `status=${mv.status} body=${JSON.stringify(mv.json)} move=${JSON.stringify(legal)}`);
  const after = await roomState(roomId);
  const afterMoves = Array.isArray(after.gameState?.moveHistory) ? after.gameState.moveHistory.length : 0;
  ok('A1b 合法着法后 moveHistory 长度 +1', afterMoves === beforeMoves + 1,
    `before=${beforeMoves} after=${afterMoves}`);

  // A2 非法着法：同一个 pieceId 配一个规则引擎判定为非法的目标格
  const illegal = findIllegalTarget(after.gameState, legal.pieceId);
  assert.ok(illegal, '找不到非法目标格，测试基准有误');
  const bad = await post(`/rooms/${roomId}/gameState`, {
    playerId: mover === 'red' ? pa : pb,
    move: { pieceId: legal.pieceId, ...illegal },
  });
  ok('A2 非法着法被服务端拒绝（400）', bad.status === 400,
    `status=${bad.status} body=${JSON.stringify(bad.json)}`);
  const after2 = await roomState(roomId);
  const after2Moves = Array.isArray(after2.gameState?.moveHistory) ? after2.gameState.moveHistory.length : 0;
  ok('A2b 非法着法后 moveHistory 长度不变（局面未被污染）', after2Moves === afterMoves,
    `expected=${afterMoves} actual=${after2Moves}`);

  // A3 回合错误：现在轮到另一方走子，让「上一手走子方」再走一手 → 必须 400。
  // sideTag=true 表示轮到红方，false 表示轮到黑方（ruleEngine 的 RED_SIDE=true）。
  const playerOfSide = { red: pa, black: pb };
  // 当前回合方 = sideTag 所指的那一方；上一手走子方 = 另一方（= mover）
  const isRedTurn = after2.gameState.sideTag === true || after2.gameState.sideTag === 'red';
  const turnSide = isRedTurn ? 'red' : 'black';
  assert.notStrictEqual(turnSide, mover, '局面 sideTag 未翻转，测试基准有误');
  const otherLegal = findLegalMoveForSide(after2.gameState, turnSide);
  assert.ok(otherLegal, `${turnSide} 在当前局面上枚举不到合法着法，测试基准有误`);
  const wrongTurn = await post(`/rooms/${roomId}/gameState`, {
    playerId: playerOfSide[turnSide],
    move: { pieceId: legal.pieceId, toCol: legal.toCol, toRow: legal.toRow },
  });
  ok('A3 非当前回合方走子被拒绝（400）', wrongTurn.status === 400,
    `status=${wrongTurn.status} body=${JSON.stringify(wrongTurn.json)}`);
  // 顺带确认：属于当前回合的那一方可正常走子（排除「服务端一律拒绝」的假阳性）
  const rightTurn = await post(`/rooms/${roomId}/gameState`, {
    playerId: playerOfSide[turnSide],
    move: { pieceId: otherLegal.pieceId, toCol: otherLegal.toCol, toRow: otherLegal.toRow },
  });
  ok('A3b 当前回合方走子成功（200，排除一律拒绝的假阳性）', rightTurn.status === 200,
    `status=${rightTurn.status} body=${JSON.stringify(rightTurn.json)}`);
  // A3c 两笔请求（一拒一成）后着法历史恰好 +1：被拒的 400 没有落子
  const after3 = await roomState(roomId);
  const after3Moves = Array.isArray(after3.gameState?.moveHistory) ? after3.gameState.moveHistory.length : 0;
  ok('A3c 被拒的越权着法未落子（着法历史恰好 +1）', after3Moves === after2Moves + 1,
    `expected=${after2Moves + 1} actual=${after3Moves}`);

  // 收尾：销毁本场景房间，避免占用编号干扰 D 场景的「最小空缺优先」基准
  await leaveAll(roomId, [pa, pb]);
}

/**
 * B. 初始局面上传收紧（补丁三/四）：两个方向都要测
 *   1. 尚无着法 + 房内玩家 → 允许；
 *   2. 已有着法 / 陌生人 / 伪造终局 → 拒绝，且服务端棋盘与终局状态不被污染。
 */
async function scenarioInitialUploadHardening() {
  console.log('\n[B] 初始局面上传收紧（补丁三/四）');
  const { roomId, pa, pb } = await setupPlayingRoom('up');

  // B1 房间内玩家、尚无任何着法 → 允许上传初始局面
  const initial = ruleEngine.createInitialState(true);
  const allow = await post(`/rooms/${roomId}/gameState`, { playerId: pa, gameState: initial });
  ok('B1 尚无着法时房内玩家上传完整局面被允许（200）', allow.status === 200,
    `status=${allow.status} body=${JSON.stringify(allow.json)}`);
  const stored = await roomState(roomId);
  ok('B1b 服务端局面确实等于上传的初始局面', stored.gameState?.qiPan?.[4]?.[6] === 29,
    `qiPan[4][6]=${JSON.stringify(stored.gameState?.qiPan?.[4]?.[6])}`);

  // 先制造一手真实着法（新协议），使「本局已产生着法」成立
  const redMove = findLegalMoveForSide(stored.gameState, 'red');
  assert.ok(redMove, '枚举不到红方合法着法，测试基准有误');
  const made = await post(`/rooms/${roomId}/gameState`, {
    playerId: pa, move: { pieceId: redMove.pieceId, toCol: redMove.toCol, toRow: redMove.toRow },
  });
  assert.strictEqual(made.status, 200, `基准着法失败: ${JSON.stringify(made.json)}`);
  const afterMove = await roomState(roomId);
  const movesAfterFirst = afterMove.gameState.moveHistory.length;
  assert.strictEqual(movesAfterFirst, 1, `基准着法后 moveHistory 应为 1，实为 ${movesAfterFirst}`);
  const boardAfterFirst = JSON.stringify(afterMove.gameState.qiPan);

  // B2 已有 1 手着法后，同一房内玩家再上传完整局面 → 403，且棋盘/着法历史未被回退
  const replay = await post(`/rooms/${roomId}/gameState`, { playerId: pa, gameState: initial });
  ok('B2 已有 1 手着法后再上传完整局面被拒绝（403）', replay.status === 403,
    `status=${replay.status} body=${JSON.stringify(replay.json)}`);
  const afterReplay = await roomState(roomId);
  ok('B2b 被拒的上传没有回退棋盘', JSON.stringify(afterReplay.gameState.qiPan) === boardAfterFirst);
  ok('B2c 被拒的上传没有回退 moveHistory',
    afterReplay.gameState.moveHistory.length === movesAfterFirst,
    `expected=${movesAfterFirst} actual=${afterReplay.gameState.moveHistory.length}`);

  // B3 已有 1 手着法后，伪造 {gameOver:true, winner:'red'} → 被拒，且房间未终局
  const forged = { ...ruleEngine.cloneGameState(afterReplay.gameState), gameStatus: 'red_win', gameOver: true, winner: 'red' };
  const spoof = await post(`/rooms/${roomId}/gameState`, { playerId: pa, gameState: forged, gameOver: true, winner: 'red' });
  ok('B3 伪造 gameOver/winner 的完整局面上传被拒绝（4xx）', spoof.status >= 400 && spoof.status < 500,
    `status=${spoof.status} body=${JSON.stringify(spoof.json)}`);
  const afterSpoof = await roomState(roomId);
  ok('B3b 伪造终局未生效：phase 仍为 playing', afterSpoof.phase === 'playing',
    `phase=${afterSpoof.phase}`);
  ok('B3c 伪造终局未生效：winner 仍为空', afterSpoof.winner === null || afterSpoof.winner === undefined,
    `winner=${JSON.stringify(afterSpoof.winner)}`);
  ok('B3d 伪造终局未改写棋盘', JSON.stringify(afterSpoof.gameState.qiPan) === boardAfterFirst);

  // B4 陌生人（不在房间成员列表里）上传完整局面 → 被拒，局面不变
  const stranger = await post(`/rooms/${roomId}/gameState`, { playerId: 'intruder-not-in-room', gameState: initial });
  ok('B4 陌生人上传完整局面被拒绝（4xx）', stranger.status >= 400 && stranger.status < 500,
    `status=${stranger.status} body=${JSON.stringify(stranger.json)}`);
  const afterStranger = await roomState(roomId);
  ok('B4b 陌生人的上传没有改写局面', JSON.stringify(afterStranger.gameState.qiPan) === boardAfterFirst);

  // 收尾：销毁本场景房间，避免占用编号干扰 D 场景的「最小空缺优先」基准
  await leaveAll(roomId, [pa, pb]);
}

/**
 * B5. 补丁四的独立证据：旧协议分支不得由请求体驱动终局。
 *
 * B3 的房间已有 1 手着法，伪造终局会被「已有着法」这道闸先拦下，因此 B3 无法区分
 * 补丁四在不在。这里专门造一个**尚无任何着法**的房间：此时 uploader 校验与着法计数闸
 * 都会放行，若 `if (gameOver && winner)` 块还在（src/routes/lanGame.ts:1112），
 * 它就会读请求体的 `gameOver`/`winner` 把房间置为 ended/red——而上传的局面本身是初始局面、
 * 绝不可能是终局。断言「房间仍未终局」即可直接证明该块已被删除。
 */
async function scenarioFirstUploadCannotForgeEnd() {
  console.log('\n[B5] 首次上传完整局面不得由请求体伪造终局（补丁四）');
  const { roomId, pa, pb } = await setupPlayingRoom('go');
  try {
    const initial = ruleEngine.createInitialState(true);
    const spoof = await post(`/rooms/${roomId}/gameState`, {
      playerId: pa,
      gameState: initial,
      gameOver: true,
      winner: 'red',
    });
    // 状态本身是合法初始局面：加固实现会忽略多余字段并存下（200）。
    // 此处只要求服务端正常受理——真正的断言是房间不得因此终局。
    ok('B5 首次上传携带伪造 gameOver/winner 仍被正常受理（200）',
      spoof.status === 200, `status=${spoof.status} body=${JSON.stringify(spoof.json)}`);
    const after = await roomState(roomId);
    ok('B5b 伪造终局未生效：phase 仍为 playing（旧实现会变 ended）', after.phase === 'playing',
      `phase=${after.phase} body=${JSON.stringify(after)}`);
    ok('B5c 伪造终局未生效：winner 仍为空（旧实现会变 red）',
      after.winner === null || after.winner === undefined,
      `winner=${JSON.stringify(after.winner)}`);
    ok('B5d 伪造终局未生效：endReason 未被写成 checkmate',
      after.endReason !== 'checkmate', `endReason=${JSON.stringify(after.endReason)}`);
  } finally {
    await leaveAll(roomId, [pa, pb]);
  }
}

/**
 * C. 畸形 FEN 校验（补丁二）
 * 行宽 ≠ 9 或行数 ≠ 10 的 FEN 必须在进入 Pikafish WASM 之前被 400 invalid_fen 拦下。
 */
async function scenarioMalformedFen() {
  console.log('\n[C] 畸形 FEN 行宽校验（补丁二）');
  const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w';

  // C1 合法 FEN：只断言「没有被 invalid_fen 拒绝」。
  // 引擎/WASM 在本机缺失时可能返回 5xx（engine_error），那属于环境问题而非本补丁的失效；
  // 因此这里既接受 200（开局库命中或引擎算完），也接受不含 invalid_fen 的 5xx。
  const good = await postAi({ fen: START_FEN, difficulty: 'easy', clientId: `verify-fen-${Date.now()}` });
  const goodErr = good.json?.error;
  ok('C1 合法 FEN 未被 invalid_fen 拒绝', goodErr !== 'invalid_fen',
    `status=${good.status} body=${JSON.stringify(good.json)}`);
  if (good.status === 200) {
    console.log(`    · 合法 FEN 返回 200（engine=${good.json?.engine}）`);
  } else {
    console.log(`    · 合法 FEN 返回 ${good.status} error=${goodErr}（引擎不可用的环境降级，仅断言未命中 invalid_fen）`);
  }

  // C1b 中局合法 FEN：从开局库里取一条非初始局面的真实记录（棋盘上已有吃子、空行宽度各异），
  //     确认形状校验不会误伤真实局面——只靠 C1 的初始局面无法排除「校验器把中局当畸形」。
  let midFen = null;
  try {
    const book = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ai', 'openingBook.json'), 'utf8'));
    midFen = Object.keys(book).find(k => k !== START_FEN);
  } catch (err) {
    console.log(`    · 跳过 C1b：读取开局库失败 ${err && err.message}`);
  }
  if (midFen) {
    const mid = await postAi({ fen: midFen, difficulty: 'easy', clientId: `verify-fen-mid-${Date.now()}` });
    ok('C1b 中局合法 FEN 未被 invalid_fen 拒绝', mid.json?.error !== 'invalid_fen',
      `fen=${midFen} status=${mid.status} body=${JSON.stringify(mid.json)}`);
    console.log(`    · 中局 FEN 返回 ${mid.status}（engine=${mid.json?.engine}）`);
  }

  // C2 行数非法：只有 9 行
  const tooFewRows = START_FEN.split('/').slice(0, 9).join('/') + ' w';
  const badRows = await postAi({ fen: tooFewRows, difficulty: 'easy' });
  ok('C2 只有 9 行的畸形 FEN 被 400 invalid_fen 拒绝',
    badRows.status === 400 && badRows.json?.error === 'invalid_fen',
    `status=${badRows.status} body=${JSON.stringify(badRows.json)}`);

  // C3 行宽非法：最后一行只有 8 列
  const narrowRow = START_FEN.replace(/RNBAKABNR w$/, 'RNBAKABN w');
  const badWidth = await postAi({ fen: narrowRow, difficulty: 'easy' });
  ok('C3 行宽为 8 的畸形 FEN 被 400 invalid_fen 拒绝',
    badWidth.status === 400 && badWidth.json?.error === 'invalid_fen',
    `status=${badWidth.status} body=${JSON.stringify(badWidth.json)}`);
}

/**
 * D. 房间名最小空缺优先（补丁六）
 * 新实现从 n=1 起找第一个未占用编号；旧实现 `let n = rooms.size + 1`。
 * 断言写法能区分两者：销毁「房间1」后新建，新实现得「房间1」，旧实现得「房间4」。
 */
async function scenarioRoomNameMinGap() {
  console.log('\n[D] 房间名最小空缺优先（补丁六）');
  const ids = ['dp-1', 'dp-2', 'dp-3'];
  const names = [];
  const roomIds = [];
  for (let i = 0; i < 3; i += 1) {
    const created = await post('/rooms', { playerName: `D${i + 1}`, playerId: ids[i] });
    assert.strictEqual(created.status, 200, `建房失败: ${JSON.stringify(created.json)}`);
    roomIds.push(created.json.roomId);
    names.push(created.json.room.name);
  }
  const num = name => Number(String(name).replace(/^[^0-9]*/, ''));
  const n1 = num(names[0]);
  const n2 = num(names[1]);
  const n3 = num(names[2]);
  // D1 是「基准成立」的守卫断言，不是回归探测器：它只要求三个房间拿到连续且互不相同的编号。
  // 单独用它无法区分新旧实现（旧实现从这里开始同样是连续的 1、2、3 号，要到销毁+重建才分叉），
  // 真正的判据是 D3；它存在的意义是排除「三个房间同名同号」这种会让 D3 假通过的退化场景。
  ok('D1 基准成立：三个房间拿到连续且互不相同的编号',
    Number.isInteger(n1) && Number.isInteger(n2) && Number.isInteger(n3) &&
    n2 === n1 + 1 && n3 === n1 + 2,
    `names=${JSON.stringify(names)}`);

  // 释放编号最小的那个房间（其成员全部离场 → 房间销毁）
  await leaveAll(roomIds[0], [ids[0]]);
  const reap = await get(`/rooms/${roomIds[0]}/gameState`);
  ok('D2 空房间确实被销毁（房间号已释放）', reap.status === 404,
    `status=${reap.status} body=${JSON.stringify(reap.json)}`);

  const created = await post('/rooms', { playerName: 'D-new', playerId: 'dp-new' });
  assert.strictEqual(created.status, 200, `建房失败: ${JSON.stringify(created.json)}`);
  const reused = created.json.room.name;
  const nNew = num(reused);
  // D3 是补丁六的真正判据：新房必须复用被释放的【最小空缺编号】。
  //   旧实现（let n = rooms.size + 1）：销毁「房间1」后 size 由 3 变 2 → 新房得到「房间3」。
  //   同时要求「新名 == 被释放的那个名字」且「不与仍在用的房间重名」，
  //   避免「所有房间都取同一个名字」这类退化实现让 D3 假通过。
  const nameTaken = names.slice(1).includes(reused);
  ok('D3 新房房名复用被释放的最小空缺编号（旧实现会得到「房间3」）',
    nNew === n1 && reused === names[0] && !nameTaken,
    `期望复用【${names[0]}】(${n1})，实际得到【${reused}】(${nNew})；` +
    `其余在用房名=${JSON.stringify(names.slice(1))}，全部房名=${JSON.stringify([...names, reused])}`);
}

/**
 * E. 长将长捉不拦截（补丁一）——静态断言
 * 补丁语义：删掉服务端对禁着的二次拦截与「连续 3 次判负」。
 * dist 里一旦重新出现 isMoveBanned 调用，说明拦截逻辑回到了产物里。
 */
function scenarioNoBanInterception() {
  console.log('\n[E] 长将长捉不拦截（补丁一，静态断言）');
  const src = fs.readFileSync(DIST_PATH, 'utf8');
  ok('E1 dist/index.js 不含 isMoveBanned（长将长捉拦截逻辑又回到了产物里）',
    !src.includes('isMoveBanned'),
    '产物里重新出现了 isMoveBanned：服务端会再次拒绝客户端能走的着法（400「禁着，请变招」）');
  ok('E2 dist/index.js 不含已废弃的违规判负计数（recordBanViolation）',
    !src.includes('recordBanViolation'));
}

async function main() {
  // 等 HTTP server 开始监听（require 是同步的，listen 回调在本轮事件循环之后）
  await sleep(600);

  await scenarioAuthorityMoves();
  await scenarioInitialUploadHardening();
  await scenarioFirstUploadCannotForgeEnd();
  await scenarioMalformedFen();
  await scenarioRoomNameMinGap();
  scenarioNoBanInterception();

  console.log(`\n全部通过：${passed} 项断言`);
  process.exit(0);
}

main().catch(err => {
  console.error('\n\u274C 验证失败：');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
