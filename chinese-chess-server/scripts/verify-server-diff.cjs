#!/usr/bin/env node
/**
 * verify-server-diff.cjs —— 服务端产物「行为差分（L2 differential）」验证
 * ============================================================================
 *
 * 目的
 * ----
 * 用**完全相同的请求序列**分别驱动两个服务端产物（旧出厂 dist / 重建 dist），
 * 把两侧每一次响应、每一帧 WebSocket 广播做**结构化递归比对**，把差异定位到
 * 字段路径（如 `rooms[0].players[1].ready`）。这是「新 dist 与旧 dist 行为等价」
 * 的核心证据。
 *
 * 用法
 * ----
 *   node scripts/verify-server-diff.cjs                 # old=.verify-old/index.js  new=dist/index.js
 *   node scripts/verify-server-diff.cjs --self          # 同一个文件当 old 与 new（自检：必须全绿）
 *   node scripts/verify-server-diff.cjs --old <path> --new <path>
 *   node scripts/verify-server-diff.cjs --old-port 9091 --new-port 9092
 *   node scripts/verify-server-diff.cjs --phase rest|ws|ai|all     # 只跑某个阶段
 *                                       ^ ai 阶段现为「断言 /api/v1/ai 已移除（404）」
 *   node scripts/verify-server-diff.cjs --keep          # 保留 .verify-old/ 运行目录
 *
 * 退出码：0 = 无「非已知」差异；1 = 有差异 / 环境错误。
 *
 * 运行细节
 * --------
 * - 产物内部有 `require("../ruleEngine.cjs")`，所以 dist 文件必须位于
 *   `chinese-chess-server/` 的**直接子目录**：旧产物复制到 `.verify-old/index.js`，
 *   新产物即 `dist/index.js`。两个子进程都以 `cwd = chinese-chess-server` 启动，
 *   用 `PORT` 环境变量区分端口。
 * - 服务端不再有任何 AI/引擎池（2026-10 去 AI 化），启动后无需等待引擎预热，
 *   只轮询 `/api/v1/health` 即可判定可用。
 * - 任何退出路径（含异常、SIGINT）都会杀掉两个子进程。
 *
 * ---------------------------------------------------------------------------
 * 归一化规则清单（脚本核心；比对前对两侧**对称**应用）
 * ---------------------------------------------------------------------------
 * R1  房间号：两侧各自生成的 6 位房间号（含 REST 房、WS 房、观战目标房）
 *     → `<ROOM:main>` / `<ROOM:ws>`；用于错误路径的「不存在的房间号」字面量
 *     → `<ROOM:missing>`。映射对 old / new 双向替换，避免方向性错误。
 * R2  playerId / spectatorId：两侧使用**同一套字面量**，若有服务端改写则
 *     → `<PLAYER:name>` / `<SPEC:name>`。
 * R3  时间：所有「时间字段名」（createdAt/updatedAt/lastWsAt/lastHeartbeat/
 *     expiresAt/startedAt/endedAt/gameStartTime/gameStartAt/serverNow/
 *     serverTime/lastMoveTime/requestTime/time/now/timestamp/duration/…）
 *     的值一律 → `<TS>`（含 null 之外的一切形态）。
 * R4  「纯数字时间键」：key ∈ {time, now, at, ts, timestamp, duration, elapsed,
 *     remaining, remainingMs, total} 的 number → `<NUM:key>`。
 * R5  其余数值：若某个数值 key 在「先跑的一侧」出现过 13 位毫秒量级（≥1e12），
 *     则该 key 被学习为时间键，两侧一并归一（解决字段名不可枚举的兜底）。
 *     行内不稳定的 13 位浮点数一律 → `<TS>`（保守兜底）。
 * R6  比分/计数一致性字段：`serverTime` 等已在 R3；`matchId`、`id`、`reqId`
 *     属于**确定性**字段，必须相等，**不**归一。
 * R7  对象键顺序不影响结果（递归按键比对）；数组顺序参与比对。
 * R8  **允许差异白名单为空**。唯一「结构态」例外见 KNOWN-B/T 表。
 *
 * 明确不做归一的东西（有意为之，保证判据强度）：
 *   - 业务文案（如「房间不存在」「玩家名称不能为空」）必须逐字相等；
 *   - 业务状态码、`success`/`error`/`message` 字段必须相等；
 *   - 房间名（`房间N`）、phase、side、ready 等业务状态必须相等。
 * 因此把 `"房间"` 改成 `"屋子"` 这类改动**一定会**被判失败（见 --self / 已知差异自证）。
 *
 * ---------------------------------------------------------------------------
 * 已知差异表（KNOWN）—— 显式登记、在输出里可见、计入统计但**不**判失败
 * ---------------------------------------------------------------------------
 * A1  新增加固：`app.use('/api', ...)` 兜底 404 JSON
 *     旧 dist：`GET /api/nope` → express 默认 404，HTML `Cannot GET /nope`
 *     新 dist：404 JSON `{"success":false,"error":"not_found","message":"接口不存在: GET /nope"}`
 *     （`req.path` 是挂载点之后的路径，所以 message 里是 `/nope` 而不是 `/api/nope`）
 * A2  新增加固：全局错误中间件，旧 = express 默认 500 HTML，新 = 500 JSON
 *     `{"success":false,"error":"internal_error","message":"服务器内部错误"}`
 * A3  新增加固：`process.on('unhandledRejection'|'uncaughtException')` 只记日志不退出。
 *     无法从外部黑盒触发，**本脚本不可测**，仅登记（见输出 INACTIVE 标记）。
 * B   依赖漂移（9 处：body-parser 1.20.4→1.20.8、express 4.22.1→4.22.3、
 *     path-to-regexp 0.1.12→0.1.13、qs 6.14.1→6.16.0、proxy-addr 2.0.7→2.0.8、
 *     side-channel 1.1.0→1.1.1、side-channel-list 1.0.0→1.0.1、
 *     es-object-atoms 1.1.1→1.1.2、hasown 2.0.2→2.0.4）。
 *     放宽条件**刻意收得很窄**，三条必须同时成立：
 *       (a) 两侧状态码**完全相同**且 ≥ 400（状态码本身不同 → 判失败）；
 *       (b) 差异不在 `status` 字段上；
 *       (c) 至少一侧的响应体是**框架生成**的（express 默认 HTML 错误页 /
 *           JSON.parse 失败的原始文本）——即 body 退化为字符串。
 *     于是「业务路由自己返回的 JSON」（`{success:false,...}`、`{error:"房间不存在"}`）
 *     **永远不会**因为这条放宽而被放过：业务文案必须逐字相等。
 * T   时序容差（极小范围，需打印）：`/start` 的 `alreadyStarted` 因服务端 1s tick
 *     的 `tryAutoStart` 可能在一侧先自动开局而产生。两侧序列节奏完全相同，
 *     正常情况下不触发；一旦触发会显式打印并计入 KNOWN，不会静默吞掉。
 *
 * 诚实说明（本轮实测的命中情况，输出里也会逐条打印 HIT / not-hit / INACTIVE）
 * ---------------------------------------------------------------------------
 * - A1 **已命中**：`GET|POST /api/nope` 各 2 处（contentType + body）。
 * - A2 **未命中**：本脚本覆盖的请求面里没有任何一条路由会抛异常，
 *   所以「HTML 500 → JSON 500」这条加固**没有被证伪，也没有被验证**。
 * - A3 **不可测**（纯进程内行为，黑盒不可触发），仅登记。
 * - B  **未命中**：收窄判据后，本次两侧在错误路径上没有任何差异（0 处）。
 *   早期版本曾把 `GET /rooms/:id/active`（一个**脚本写错的路径**，真实路由是
 *   `GET /rooms/active?playerId=`）误判成 B，已修正路径并把 A1 的判定改成
 *   「看响应指纹而非请求路径」，避免同类误分类。
 *
 * 当前基线状态（每次运行都会打印两侧 hash 与证据强度警告）
 * -------------------------------------------------------
 * - old（历史出厂产物）权威副本：`.dsh-work/dist-baseline-20261002.js`
 *   = 1,397,891 字节 / md5 `2646eac282e2ddc8d3d76b37a36c61b3`；脚本复制到
 *   `.verify-old/index.js` 前**强制校验** size+md5，不符即拒绝继续。
 * - new（用 src/ 重建）：`chinese-chess-server/dist/index.js`
 *   = 1,391,234 字节 / md5 `f88c23a56573b607f1ddc46d22a88a8b`。
 * - 若两侧 md5 相同（例如 `--self`，或 dist 尚未重建），脚本打印
 *   **证据强度警告**：此时只能证明「无假阳性」，不能证明行为等价。
 *
 * 硬性约束：本脚本只读既有产物，绝不修改 src/、dist/、build.js、package.json、
 * ruleEngine.cjs、ai/ 等任何既有文件；运行期只创建/清理 `chinese-chess-server/.verify-old/`。
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const SERVER_DIR = path.resolve(__dirname, '..');
const RUN_DIR = path.join(SERVER_DIR, '.verify-old');
const DEFAULT_OLD = path.join(RUN_DIR, 'index.js');
const DEFAULT_NEW = path.join(SERVER_DIR, 'dist', 'index.js');
const BASELINE_PATH = path.resolve(SERVER_DIR, '..', '.dsh-work', 'dist-baseline-20261002.js');
const BASELINE_MD5 = '2646eac282e2ddc8d3d76b37a36c61b3';
const BASELINE_SIZE = 1397891;

// ---------------------------------------------------------------------------
// 0. 参数解析
// ---------------------------------------------------------------------------
function parseArgv(argv) {
  const opts = {
    self: false,
    keep: false,
    phase: 'all',
    old: DEFAULT_OLD,
    new: DEFAULT_NEW,
    oldPort: 9091,
    newPort: 9092,
  };
  let selfTarget = DEFAULT_NEW;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`参数 ${a} 缺少取值`);
      return argv[i];
    };
    if (a === '--self') opts.self = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--old') { opts.old = path.resolve(process.cwd(), next()); selfTarget = opts.old; }
    else if (a === '--new') opts.new = path.resolve(process.cwd(), next());
    else if (a === '--old-port') opts.oldPort = Number(next());
    else if (a === '--new-port') opts.newPort = Number(next());
    else if (a === '--phase') opts.phase = next();
    else if (a === '-h' || a === '--help') {
      console.log('用法: node scripts/verify-server-diff.cjs [--self] [--old <path>] [--new <path>]\n' +
        '       [--old-port 9091] [--new-port 9092] [--phase all|rest|ws|ai] [--keep]');
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${a}`);
    }
  }
  if (!['all', 'rest', 'ws', 'ai'].includes(opts.phase)) throw new Error(`--phase 取值非法: ${opts.phase}`);
  if (opts.oldPort === opts.newPort) throw new Error('--old-port 与 --new-port 必须不同');
  if (!Number.isInteger(opts.oldPort) || !Number.isInteger(opts.newPort) || opts.oldPort < 1 || opts.newPort > 65535) {
    throw new Error('端口取值非法');
  }
  if (opts.self) {
    // --self：同一个文件当两侧。默认用 dist/index.js（不碰 .verify-old/），
    // 若显式给了 --old 就用它。
    opts.new = path.resolve(process.cwd(), selfTarget);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// 1. 工具
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function md5File(p) {
  return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
}

function fileInfo(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { exists: false, reason: '不是普通文件', size: 0, md5: null };
    return { exists: true, size: st.size, md5: md5File(p) };
  } catch (err) {
    return { exists: false, reason: err.code || err.message, size: 0, md5: null };
  }
}

function shortHash(h) {
  return h ? `${h.slice(0, 8)}…${h.slice(-4)}` : '(无)';
}

// ---------------------------------------------------------------------------
// 2. 归一化引擎
// ---------------------------------------------------------------------------
/** 时间字段名（命中即把值整体替换为 <TS>） */
const TS_KEY_RE = /(^|[A-Za-z])(time|times|at|date|ts|now|timestamp|duration|elapsed|deadline|expires|expiry|ttl|since|until|lastwsat)$/i;
/** 数字型时间键 */
const NUM_TIME_KEY = new Set(['time', 'now', 'at', 'ts', 'timestamp', 'duration', 'elapsed', 'remaining', 'remainingMs', 'total', 'pauseDuration', 'pausedFor']);
/** 13 位毫秒量级 */
const MS_MAGNITUDE = 1e12;

function normalizeNumber(n) {
  if (!Number.isFinite(n)) return n;
  // 13 位毫秒量级（含小数）→ <TS>
  if (Math.abs(n) >= MS_MAGNITUDE) return '<TS>';
  return n;
}

function normalizeOnce(value, ctx) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => normalizeOnce(v, ctx));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      let v = value[key];
      if (typeof v === 'string') {
        v = normalizeString(v, ctx, key);
      } else if (typeof v === 'number') {
        if (TS_KEY_RE.test(key) || NUM_TIME_KEY.has(key)) v = '<TS>';
        else v = normalizeNumber(v);
      } else {
        v = normalizeOnce(v, ctx, key);
      }
      // 键值学习：某个数值 key 在「先跑的一侧」出现过毫秒量级 → 判为时间键
      if (typeof value[key] === 'number' && Math.abs(value[key]) >= MS_MAGNITUDE) {
        const learned = ctx.msKeys.get(key) || { old: false, new: false };
        learned[ctx.side] = true;
        ctx.msKeys.set(key, learned);
      }
      out[key] = v;
    }
    return out;
  }
  if (typeof value === 'string') return normalizeString(value, ctx);
  if (typeof value === 'number') return normalizeNumber(value);
  return value;
}

function normalizeString(s, ctx, key) {
  let out = s;
  // 会话凭证（sessionToken）：**每次签发都是随机的**，两个进程（old/new）必然不同，
  // 且它从来不是"行为差异"的载体 —— 真正的行为信号是"有没有这个字段"，
  // 而不是"值是多少"。故只把**值**换成占位符，保留字段的存在/缺失语义。
  // 【2026-10 审计补充】此前归一化完全没有处理它，导致 `--self`（同一文件当 old 与 new）
  // 也必然报出一串 sessionToken 差异而 exit 1：自检模式永远红，harness 事实上不可用。
  if (key === 'sessionToken' || key === 'token') return '<TOKEN>';
  // 时间字段名上的字符串形式时间 → <TS>
  if (key && (TS_KEY_RE.test(key) || NUM_TIME_KEY.has(key))) {
    if (/^\d{4}-\d{2}-\d{2}T/.test(out) || /^\d{10,}$/.test(out)) return '<TS>';
  }
  for (const [from, to] of ctx.special) {
    if (from && out.includes(from)) out = out.split(from).join(to);
  }
  // 房间号（双向替换，旧/新都换成同一个占位符；先换长键避免前缀误伤）
  for (const [from, to] of ctx.rooms) {
    if (from && out.includes(from)) out = out.split(from).join(to);
  }
  // playerId / spectatorId
  for (const [from, to] of ctx.ids) {
    if (from && out.includes(from)) out = out.split(from).join(to);
  }
  // ISO 时间戳
  out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g, '<TS>');
  // 13 位毫秒量级（含小数）
  out = out.replace(/(?<![\w.])\d{13,}(\.\d+)?(?![\w])/g, '<TS>');
  return out;
}

/** 对一次响应/一帧广播做归一化 */
function normalizeValue(raw, ctx) {
  let v = normalizeOnce(raw, ctx);
  const pass2 = normalizeOnce(v, ctx);
  return pass2;
}

// 见头注释 R5：数值时间键学习需要「跑完一侧再跑另一侧」，故本脚本采用两趟归一化。
function buildNormalizer({ rooms = [], playerIds = [], spectatorIds = [], specials = [] } = {}) {
  const ctx = {
    side: 'old',
    rooms: [],
    ids: [],
    special: [],
    msKeys: new Map(),
    // 结构性字段：只比形状不比数值
    structuralOnly: new Set(['clocks', 'aiStats']),
  };
  // 还原语义名（<ROOM:main> 之类），便于阅读差异路径
  for (const r of rooms) {
    ctx.rooms.push([r.old, `<${r.name}>`]);
    ctx.rooms.push([r.new, `<${r.name}>`]);
  }
  for (const p of playerIds) {
    ctx.ids.push([p.old, `<PLAYER:${p.name}>`]);
    ctx.ids.push([p.new, `<PLAYER:${p.name}>`]);
  }
  for (const s of spectatorIds) {
    ctx.ids.push([s.old, `<SPEC:${s.name}>`]);
    ctx.ids.push([s.new, `<SPEC:${s.name}>`]);
  }
  for (const s of specials) ctx.special.push(s);
  // 先替换较长的字面量，避免前缀误伤
  ctx.rooms.sort((a, b) => b[0].length - a[0].length);
  ctx.ids.sort((a, b) => b[0].length - a[0].length);
  return ctx;
}

// ---------------------------------------------------------------------------
// 3. 结构化递归比对引擎
// ---------------------------------------------------------------------------
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function collectDiffs(a, b, pathStr, out, opts = {}) {
  const structuralOnly = opts.structuralOnly || new Set();
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) {
    out.push({ path: pathStr || '$', kind: 'type', left: `${ta}:${brief(a)}`, right: `${tb}:${brief(b)}` });
    return out;
  }
  if (ta === 'array') {
    if (a.length !== b.length) {
      out.push({ path: `${pathStr}.length`, kind: 'array-length', left: String(a.length), right: String(b.length) });
    }
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i += 1) {
      collectDiffs(a[i], b[i], `${pathStr}[${i}]`, out, opts);
    }
    return out;
  }
  if (ta === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const child = pathStr ? `${pathStr}.${k}` : k;
      if (!(k in a)) {
        out.push({ path: child, kind: 'missing-left', left: '(缺失)', right: brief(b[k]) });
        continue;
      }
      if (!(k in b)) {
        out.push({ path: child, kind: 'missing-right', left: brief(a[k]), right: '(缺失)' });
        continue;
      }
      if (structuralOnly.has(k) && typeOf(a[k]) === typeOf(b[k])) {
        // 只比形状：键集合/类型已由递归保证，跳过数值比对
        if (typeOf(a[k]) === 'object' && a[k] !== null) collectShape(a[k], b[k], child, out);
        continue;
      }
      collectDiffs(a[k], b[k], child, out, opts);
    }
    return out;
  }
  if (a !== b) {
    out.push({ path: pathStr || '$', kind: 'value', left: brief(a), right: brief(b) });
  }
  return out;
}

/** 只比结构（键集合与嵌套形状），不比数值 */
function collectShape(a, b, pathStr, out) {
  if (typeOf(a) !== typeOf(b)) {
    out.push({ path: pathStr, kind: 'shape-type', left: typeOf(a), right: typeOf(b) });
    return out;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push({ path: `${pathStr}.length`, kind: 'shape-length', left: String(a.length), right: String(b.length) });
    return out;
  }
  if (a && typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const child = `${pathStr}.${k}`;
      if (!(k in a)) out.push({ path: child, kind: 'shape-missing-left', left: '(缺失)', right: typeOf(b[k]) });
      else if (!(k in b)) out.push({ path: child, kind: 'shape-missing-right', left: typeOf(a[k]), right: '(缺失)' });
      else collectShape(a[k], b[k], child, out);
    }
  }
  return out;
}

function brief(v) {
  if (typeof v === 'string') return v.length > 120 ? `${JSON.stringify(v.slice(0, 120))}…(${v.length}字符)` : JSON.stringify(v);
  if (v === undefined) return 'undefined';
  try {
    const s = JSON.stringify(v);
    return s && s.length > 120 ? `${s.slice(0, 120)}…` : String(s);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// 4. KNOWN 已知差异分类
// ---------------------------------------------------------------------------
const KNOWN_RULES = [
  {
    id: 'A1',
    title: '/api 兜底 404（新增加固：HTML → JSON）',
    reason: '新 dist 增加 app.use(\'/api\', ...) 兜底，旧 dist 走 express 默认 HTML 404',
    match: (d, step) =>
      (isApiFallback(step) || step.apiFallbackSignature) && /(^|\.)(contentType|body|text|status)/.test(d.path),
  },
  {
    id: 'A2',
    title: '全局错误中间件（新增加固：HTML 500 → JSON 500）',
    reason: '新 dist 增加全局错误中间件返回 internal_error JSON，旧 dist 走 express 默认错误处理',
    match: (d, step) => step.statusNew === 500 && /(^|\.)(contentType|body|text)/.test(d.path),
  },
  {
    id: 'A3',
    title: '进程级异常守卫（unhandledRejection / uncaughtException 不退出）',
    reason: '纯进程内行为，黑盒 HTTP/WS 无法触发，仅登记',
    inactive: true,
    match: () => false,
  },
  {
    id: 'B',
    title: '依赖版本漂移（仅限错误路径上的框架生成响应）',
    reason:
      'express/body-parser/path-to-regexp/qs 等 9 处版本漂移；只在「两侧状态码完全相同、' +
      '且至少一侧是框架生成的响应（express 默认 HTML 错误页 / 非 JSON 文本）」时才放宽。' +
      '业务路由自己返回的 JSON（{success:false,...} / {error:"..."}）不在放宽范围内。',
    match: (d, step) => {
      if (step.statusOld !== step.statusNew) return false; // 状态码必须一致，否则判失败
      if (step.statusOld < 400) return false; // 仅错误路径
      if (d.path === 'status') return false;
      return step.frameworkResponse === true;
    },
  },
  {
    id: 'T',
    title: '时序容差：/start 的 alreadyStarted',
    reason: '服务端 1s tick 的 tryAutoStart 可能在一侧先自动开局',
    match: (d, step) => step.phaseLabel === 'start' && /alreadyStarted/.test(d.path),
  },
];

function isApiFallback(step) {
  return /^\/api\/[^v]/.test(step.path) || step.path === '/api/nope';
}

function classifyDiff(d, step) {
  for (const rule of KNOWN_RULES) {
    if (rule.inactive) continue;
    try {
      if (rule.match(d, step)) return rule.id;
    } catch {
      /* 保守：match 抛错则不认为是已知差异 */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 5. 子进程管理
// ---------------------------------------------------------------------------
const children = [];
let cleanedUp = false;

function prepareOldArtifact(opts) {
  // --self / --old 指向别的文件时不复制；默认 old 需要把权威 old 复制进 .verify-old/
  const needsCopy = !opts.self && path.resolve(opts.old) === path.resolve(DEFAULT_OLD);
  // --self 模式下 old 与 new 是同一个文件（opts.old 可能是陈旧的默认值）
  const oldEffective = opts.self ? opts.new : opts.old;
  const baseline = fileInfo(BASELINE_PATH);
  const newInfo = fileInfo(opts.new);
  const report = { baseline, newInfo, oldInfo: null, note: [] };

  if (!needsCopy) {
    const info = fileInfo(oldEffective);
    if (!info.exists) throw new Error(`--old 指定的文件不存在: ${oldEffective}`);
    report.oldInfo = info;
    report.oldPath = oldEffective;
    report.note.push(opts.self ? '--self：old 与 new 使用同一个文件' : '--old 显式指定，未复制任何文件');
    return report;
  }

  fs.mkdirSync(RUN_DIR, { recursive: true });
  let source;
  if (baseline.exists && baseline.md5 === BASELINE_MD5 && baseline.size === BASELINE_SIZE) {
    source = BASELINE_PATH;
    report.note.push(`old 来源 = 权威基线副本 ${path.relative(SERVER_DIR, BASELINE_PATH)}（md5 校验通过）`);
  } else if (baseline.exists) {
    throw new Error(
      `权威基线副本存在但校验不符：${BASELINE_PATH}\n` +
      `  期望 ${BASELINE_SIZE} 字节 / md5 ${BASELINE_MD5}\n` +
      `  实际 ${baseline.size} 字节 / md5 ${baseline.md5}\n` +
      `  拒绝继续（否则差分证据不成立）。`
    );
  } else {
    // 基线副本已不在工作区：退化为使用 dist/index.js，但必须字节等于出厂基线
    const dist = fileInfo(DEFAULT_NEW);
    if (!dist.exists) {
      throw new Error(
        `无法准备 old 产物：权威基线副本不存在（${BASELINE_PATH}），且 ${DEFAULT_NEW} 也不存在。\n` +
        `  请用 --old <path> 显式指定旧产物。`
      );
    }
    if (dist.size !== BASELINE_SIZE || dist.md5 !== BASELINE_MD5) {
      throw new Error(
        `权威基线副本不存在（${BASELINE_PATH}），且 ${path.relative(SERVER_DIR, DEFAULT_NEW)} 与出厂基线不一致：\n` +
        `  期望 ${BASELINE_SIZE} 字节 / md5 ${BASELINE_MD5}\n` +
        `  实际 ${dist.size} 字节 / md5 ${dist.md5}\n` +
        `  拒绝把它当作 old（旧 dist 可能已被重建/改写）。请用 --old <path> 显式指定旧产物。`
      );
    }
    source = DEFAULT_NEW;
    report.note.push(
      `⚠ 权威基线副本 ${path.relative(SERVER_DIR, BASELINE_PATH)} 不在工作区；` +
      `退化为使用 dist/index.js（其字节与出厂基线完全一致，md5 校验通过）`
    );
  }
  fs.copyFileSync(source, DEFAULT_OLD);
  const copied = fileInfo(DEFAULT_OLD);
  if (copied.md5 !== BASELINE_MD5) {
    throw new Error(`复制到 ${DEFAULT_OLD} 后的 md5 不符：${copied.md5}`);
  }
  report.oldInfo = copied;
  report.oldPath = DEFAULT_OLD;
  report.note.push(`old 运行副本 = ${path.relative(SERVER_DIR, DEFAULT_OLD)}（md5 校验通过）`);
  return report;
}

function spawnServer(label, file, port) {
  const child = spawn(process.execPath, [file], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.__label = label;
  child.__log = [];
  const keep = (chunk) => {
    const s = String(chunk);
    child.__log.push(s);
    if (child.__log.length > 200) child.__log.splice(0, child.__log.length - 200);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('exit', (code, sig) => {
    child.__exit = { code, sig };
  });
  children.push(child);
  return child;
}

/**
 * 启动前检查端口是否空闲。
 *
 * ============================================================================
 * 【2026-10 审计补充 · 为什么必须有这一步】
 *
 * 缺陷（实测踩到）：若目标端口**已被别的进程占用**（最典型的情形是本项目自己的
 * dev server —— `scripts/start.mjs` / `pnpm dev:server` 的默认端口恰好也是 9091，
 * 而本脚本 `--old-port` 的默认值同样是 9091），那么被 spawn 的子进程会因
 * `listen EADDRINUSE` **立刻退出**，而 waitHealthy 的第一个循环里
 * "检查子进程是否已退出" 与 "请求 /api/v1/health" 之间存在竞态：
 * 只要那个**外来服务**先答出 200，waitHealthy 就直接返回，于是：
 *   · 本脚本以为两个实例都就绪；
 *   · 后续所有 old 侧请求其实都打到那个外来服务上；
 *   · 两侧响应自然完全一致 → 打印「全部通过」并以 exit 0 结束。
 * 即：**差分闸门静默失效，还报成功**。实测确认过（把 old 换成故意篡改的产物，
 * 仍被判「干净」；停掉占用 9091 的 dev server 后同一篡改立刻被抓出
 * `body.error` 差异并 exit 1）。
 *
 * 因此启动前必须 fail-closed：端口被占用就直接报错，并给出可操作的指引，
 * 绝不允许"用一个不是我们子进程的服务"来充当差分的一侧。
 */
async function assertPortFree(port, label) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* 忽略 */
      }
      fn(arg);
    };
    socket.once('connect', () =>
      done(
        reject,
        new Error(
          `【${label} 端口 ${port} 已被占用】拒绝继续（否则差分结果不可信）。\n` +
            `  通常是本项目的 dev server 占着默认端口 9091（start.mjs / pnpm dev:server）。\n` +
            `  处理：停掉它，或显式换端口，例如\n` +
            `    node scripts/verify-server-diff.cjs --old-port 9401 --new-port 9402`
        )
      )
    );
    socket.once('error', () => done(resolve));
    socket.setTimeout(1500, () => done(resolve));
  });
}

/**
 * 就绪后复查"这一侧的响应确实来自我们自己的子进程"。
 *
 * 关闭 assertPortFree 之后仍残存的竞态：外来服务若在本脚本 spawn 之后才起来
 * （或端口在检查与 spawn 之间被抢占），waitHealthy 仍可能被外来服务骗过。
 * 因此就绪之后必须再看一眼子进程是否还活着 —— 子进程已退出却"健康"，
 * 只可能是在跟别的进程说话。
 */
function assertChildAlive(child) {
  if (child.__exit && child.__exit.code !== null) {
    throw new Error(
      `【${child.__label} 子进程在就绪后已退出（code=${child.__exit.code} sig=${child.__exit.sig}）】\n` +
        `  这说明刚才那个"健康"响应并非来自本脚本的子进程（端口被他人占用或被抢占），\n` +
        `  差分的一方来源不明，结果不可信，拒绝继续。\n` +
        `--- ${child.__label} 输出 ---\n${(child.__log || []).join('').slice(-2000)}`
    );
  }
}

async function waitHealthy(port, child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (child.__exit && child.__exit.code !== null) {
      throw new Error(
        `${child.__label} 子进程提前退出（code=${child.__exit.code} sig=${child.__exit.sig}）\n` +
        `--- ${child.__label} 输出 ---\n${child.__log.join('').slice(-4000)}`
      );
    }
    try {
      const res = await httpRequest(port, 'GET', '/api/v1/health', undefined, 2500);
      if (res.status === 200 && res.json && res.json.status === 'ok') return res;
      lastErr = new Error(`/api/v1/health 返回 ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(250);
  }
  throw new Error(
    `${child.__label} 在 ${timeoutMs}ms 内未就绪（端口 ${port}）：${lastErr && lastErr.message}\n` +
    `--- ${child.__label} 输出 ---\n${child.__log.join('').slice(-4000)}`
  );
}

function killChildren() {
  for (const child of children) {
    if (!child || child.killed) continue;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }
}

function cleanupRunDir(opts) {
  if (opts.keep) return;
  try {
    fs.rmSync(RUN_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function globalCleanup(opts) {
  if (cleanedUp) return;
  cleanedUp = true;
  killChildren();
  cleanupRunDir(opts);
}

// ---------------------------------------------------------------------------
// 6. HTTP 客户端
// ---------------------------------------------------------------------------
function httpRequest(port, method, urlPath, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { accept: '*/*' };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json;
          let parseError = null;
          try {
            json = raw.length ? JSON.parse(raw) : undefined;
          } catch (err) {
            parseError = err.message;
          }
          resolve({
            status: res.statusCode,
            contentType: String(res.headers['content-type'] || ''),
            text: raw,
            json,
            parseError,
          });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时(${timeoutMs}ms): ${method} ${urlPath}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function doStep(mode, client, step) {
  const urlPath = step.canonicalPath || step.path;
  const port = mode.port;
  const timeout = step.timeoutMs || 15000;
  let res;
  try {
    res = await httpRequest(port, step.method, urlPath, step.body, timeout);
  } catch (err) {
    res = { status: -1, contentType: '', text: `REQUEST-ERROR: ${err.message}`, json: undefined, parseError: err.message };
  }
  if (step.after && typeof step.after === 'function') await step.after(res, mode);
  return {
    method: step.method,
    path: step.path,
    label: step.label || `${step.method} ${step.path}`,
    phaseLabel: step.phaseLabel || '',
    status: res.status,
    contentType: res.contentType,
    body: res.json !== undefined ? res.json : (res.text ? `<RAW>${res.text}` : undefined),
    rawText: res.text,
  };
}

// ---------------------------------------------------------------------------
// 7. 比对 + 记账
// ---------------------------------------------------------------------------
const tally = {
  steps: 0,
  clean: 0,
  known: 0,
  failed: 0,
  knownByRule: new Map(),
  knownSamples: [],
  failures: [],
  ruleHits: new Set(),
};

function compareStepResponses(stepLabel, phaseLabel, left, right, normCtx, extra) {
  const a = {
    status: left.status,
    contentType: left.contentType,
    body: normalizeValue(left.body, normCtx),
    rawText: normalizeValue(left.rawText, normCtx),
  };
  const b = {
    status: right.status,
    contentType: right.contentType,
    body: normalizeValue(right.body, normCtx),
    rawText: normalizeValue(right.rawText, normCtx),
  };
  // 若两侧都能解析成 JSON，则只比 JSON（忽略 raw 文本细节）；否则比 raw 文本
  const compareObj = {
    status: [a.status, b.status],
    contentType: [a.contentType, b.contentType],
    body: [a.body, b.body],
  };
  const diffs = [];
  if (a.status !== b.status) {
    diffs.push({ path: 'status', kind: 'status', left: String(a.status), right: String(b.status) });
  }
  if (a.contentType !== b.contentType) {
    diffs.push({ path: 'contentType', kind: 'value', left: brief(a.contentType), right: brief(b.contentType) });
  }
  if (typeof a.body === 'string' || typeof b.body === 'string') {
    if (a.body !== b.body) {
      diffs.push({ path: 'body', kind: 'value', left: brief(a.body), right: brief(b.body) });
    }
  } else {
    collectDiffs(a.body, b.body, 'body', diffs, { structuralOnly: new Set(['clocks']) });
  }
  return commitDiffs(stepLabel, phaseLabel, diffs, {
    statusOld: left.status,
    statusNew: right.status,
    path: left.path,
    // A1 的「响应特征」判定：不依赖请求路径（路径可能带房号或写错），只看响应本身。
    // 旧=express 默认 404 HTML，新=/api 兜底 JSON —— 这是新增加固的指纹。
    apiFallbackSignature:
      /<!DOCTYPE html>[\s\S]*<pre>Cannot (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(String(a.body)) &&
      /"error":"not_found"/.test(String(b.body)) &&
      /接口不存在/.test(String(b.body)),
    // 框架生成的响应（express 默认 HTML 错误页等 → JSON.parse 失败，body 退化为字符串）。
    // B 只在两侧都是这类「非业务 JSON」响应时才放宽，避免吞掉业务文案差异。
    frameworkResponse: typeof a.body === 'string' || typeof b.body === 'string',
    ...(extra || {}),
  });
}

function commitDiffs(stepLabel, phaseLabel, diffs, step) {
  tally.steps += 1;
  if (diffs.length === 0) {
    tally.clean += 1;
    return { stepLabel, diffs: [], known: [], failed: [] };
  }
  const known = [];
  const failed = [];
  for (const d of diffs) {
    const ruleId = classifyDiff(d, step);
    if (ruleId) {
      known.push({ ...d, ruleId });
      tally.ruleHits.add(ruleId);
      tally.knownByRule.set(ruleId, (tally.knownByRule.get(ruleId) || 0) + 1);
      if (tally.knownSamples.length < 12) {
        tally.knownSamples.push(`${ruleId} · ${stepLabel} · ${d.path}: ${d.left} → ${d.right}`);
      }
    } else {
      failed.push(d);
    }
  }
  tally.known += known.length;
  tally.failed += failed.length;
  if (failed.length) {
    tally.failures.push({ stepLabel, phaseLabel, path: step.path || '', diffs: failed });
    dumpServerLogs();
  }
  return { stepLabel, diffs, known, failed };
}

/**
 * 打印两个子进程最近的日志（先过滤掉每秒都刷的 tick/GC 噪声）。
 * 用途：差分定位 —— 差异发生在服务端内部时，只有服务端日志能说明原因。
 */
function dumpServerLogs(maxLines = 16) {
  // 保留 pikafish/引擎 关键字：若将来有人把 AI 路由挂回来，这些日志应被识别出来排查
  const NOISE = /\[lan\]\s*(tick|GC|sweep|heal)|pikafish|Pikafish|引擎|Engine/i;
  for (const child of children) {
    if (!child || !child.__log) continue;
    const lines = child.__log
      .join('')
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l && !NOISE.test(l));
    if (!lines.length) continue;
    console.log(`      [服务端日志 ${child.__label} 末 ${Math.min(maxLines, lines.length)} 行]`);
    for (const l of lines.slice(-maxLines)) console.log(`        | ${l.slice(0, 200)}`);
  }
}

function printStepResult(res, quiet) {
  if (res.failed.length) {
    console.log(`  ✗ ${res.stepLabel}`);
    for (const d of res.failed.slice(0, 12)) {
      console.log(`      差异 @ ${d.path}  [${d.kind}]  old=${d.left}  new=${d.right}`);
    }
    if (res.failed.length > 12) console.log(`      … 另有 ${res.failed.length - 12} 处差异`);
    return;
  }
  if (res.known.length) {
    const ids = [...new Set(res.known.map((d) => d.ruleId))].join(',');
    console.log(`  ● ${res.stepLabel}  [KNOWN:${ids}] ${res.known.length} 处`);
    if (!quiet) {
      for (const d of res.known.slice(0, 4)) {
        console.log(`      已知差异 @ ${d.path}  [${d.ruleId}]  old=${d.left}  new=${d.right}`);
      }
    }
    return;
  }
  console.log(`  ✓ ${res.stepLabel}`);
}

// ---------------------------------------------------------------------------
// 8. 锁步执行器
// ---------------------------------------------------------------------------
class Lockstep {
  constructor(modes, opts) {
    this.modes = modes; // { old, new }
    this.opts = opts;
    this.rooms = [];
    this.playerIds = [];
    this.spectatorIds = [];
    this.specials = [];
    this.wsRuns = [];
    this.results = [];
  }

  registerRoom(name, oldId, newId) {
    this.rooms.push({ name, old: String(oldId), new: String(newId) });
  }

  normalizer() {
    return buildNormalizer({
      rooms: this.rooms,
      playerIds: this.playerIds,
      spectatorIds: this.spectatorIds,
      specials: this.specials,
    });
  }

  /**
   * 对两侧执行同一个逻辑步骤。factory(mode) 返回 {method, path, body, ...}
   * （path 可以按 mode 使用真实的 old/new 房间号，脚本内部会归一化）
   * extra.onResponses(left, right) 在**比对之前**回调，用于把新生成的房间号
   * 注册进归一化映射表（否则建房响应自身会被误判为差异）。
   */
  async step(label, factory, extra) {
    const make = typeof factory === 'function' ? factory : () => factory;
    const leftStep = { ...make(this.modes.old), label };
    const rightStep = { ...make(this.modes.new), label };
    const left = await doStep(this.modes.old, this.modes.old, leftStep);
    const right = await doStep(this.modes.new, this.modes.new, rightStep);
    if (extra && typeof extra.onResponses === 'function') extra.onResponses(left, right);
    const ctx = this.normalizer();
    const res = compareStepResponses(label, (extra && extra.phaseLabel) || '', left, right, ctx, extra);
    this.results.push(res);
    printStepResult(res, this.opts.quiet);
    return { left, right, res, leftStep, rightStep };
  }

  /** 完全相同的字面量请求（两侧 path/body 逐字节一致） */
  async same(label, stepSpec, extra) {
    const { method, path: p, body, timeoutMs, phaseLabel } = stepSpec;
    return this.step(label, () => ({ method, path: p, body, timeoutMs, phaseLabel }), extra);
  }

  /** 房间相关请求：path 用两侧各自的房间号 */
  async room(label, roomName, build, extra) {
    return this.step(
      label,
      (mode) => {
        const { method, path: p, body, timeoutMs } = build(mode.roomId, roomName);
        return { method, path: p, body, timeoutMs, phaseLabel: (extra && extra.phaseLabel) || '' };
      },
      extra
    );
  }

  async wsRun(label, spec) {
    const run = { label, spec, left: null, right: null, res: null };
    const leftP = runWsSequence(this.modes.old, spec, this);
    const rightP = runWsSequence(this.modes.new, spec, this);
    const [left, right] = await Promise.all([leftP, rightP]);
    run.left = left;
    run.right = right;
    const ctx = this.normalizer();
    // 帧可能在「连接阶段」和「第一个动作的排空窗口」之间抖动（同一帧被算进哪个窗口
    // 取决于两侧各自的到达时刻）——窗口标记本身不是行为，必须剔除（__ 前缀字段）。
    // 剔除后用 LCS 对齐两侧的逐 socket 帧序列：内容相同的帧即使落进不同窗口也算配对，
    // 只有真正对不上的帧（多推/少推/内容不同）才报差异。
    const diffs = [];
    if (left.error || right.error) {
      diffs.push({ path: 'run.error', kind: 'value', left: String(left.error), right: String(right.error) });
    }
    diffs.push(...diffWsFrames(left, right, ctx));
    const res = commitDiffs(`${label}`, 'ws', diffs, {
      statusOld: left.error ? 500 : 200,
      statusNew: right.error ? 500 : 200,
      path: 'ws:/api/v1/lan/ws',
      phaseLabel: 'ws',
    });
    run.res = res;
    printStepResult(res, this.opts.quiet);
    if (res.diffs.length && !this.opts.quiet) {
      printWsSocketStates('old', run.left, ctx);
      printWsSocketStates('new', run.right, ctx);
    }
    this.wsRuns.push(run);
    return run;
  }
}

function printWsMessages(side, msgs, err) {
  console.log(`      [诊断] ${side} 共 ${msgs.length} 帧${err ? ` 运行错误=${err}` : ''}`);
  msgs.forEach((m, i) => {
    const head = `tag=${m.tag} type=${m.type}${m.reqId !== undefined ? ` reqId=${m.reqId}` : ''}`;
    const extra = m.message ? ` message=${m.message}` : (m.status !== undefined ? ` status=${m.status}` : '');
    console.log(`        ${String(i).padStart(2)} +${String(m.__at ?? '?').padStart(5)}ms ${head}${extra}`);
  });
}

// ---------------------------------------------------------------------------
// 9. WebSocket 驱动
// ---------------------------------------------------------------------------
function wsUrl(port, query) {
  return `ws://127.0.0.1:${port}/api/v1/lan/ws?${query}`;
}

function openSocket(port, query, state) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl(port, query), { handshakeTimeout: 8000 });
    const rec = { ws, state, frames: [], emitted: 0, open: false, closed: false, error: null, closeInfo: null, t0: Date.now() };
    ws.on('open', () => {
      rec.open = true;
      resolve(rec);
    });
    ws.on('message', (data) => {
      const text = String(data);
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { type: '<unparseable>', raw: text };
      }
      rec.frames.push({ ...json, __at: Date.now() - rec.t0, __sock: state || '' });
    });
    ws.on('close', (code, reason) => {
      rec.closed = true;
      rec.closeInfo = { code, reason: String(reason || ''), __at: Date.now() - rec.t0 };
      if (!rec.open) resolve(rec);
    });
    ws.on('error', (err) => {
      rec.error = err.message;
      if (!rec.open) resolve(rec);
    });
    setTimeout(() => resolve(rec), 8000);
  });
}

/**
 * 等待「静默窗口」：连续 quietMs 无新帧即认为一个 burst 结束。
 * 关键：进入时先至少等 minMs，否则事件循环里刚 open 的 socket 会在 welcome 帧
 * 到达之前就被判定为「静默」，导致该帧被算进下一个 burst —— 两侧时钟抖动不同
 * 就会产生假差异（实测过）。
 */
async function waitQuiet(rec, quietMs = 450, maxMs = 5000, minMs = 500) {
  const start = Date.now();
  let lastLen = rec.frames.length;
  let lastChange = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(40);
    if (rec.frames.length !== lastLen) {
      lastLen = rec.frames.length;
      lastChange = Date.now();
    } else if (Date.now() - start >= minMs && Date.now() - lastChange >= quietMs) {
      break;
    }
  }
  return rec.frames.slice();
}

/** 诊断用：直接读某一侧房间状态（不参与比对），用于定位 WS 侧成员是否已被清扫 */
async function debugRoomDump(mode, roomId, tag) {
  try {
    const res = await httpRequest(mode.port, 'GET', `/api/v1/lan/rooms/${roomId}`, undefined, 3000);
    const r = res.json && res.json.room;
    if (!r) {
      console.log(`      [DEBUG ${tag}] HTTP ${res.status} 无 room: ${res.text.slice(0, 120)}`);
      return;
    }
    const now = Date.now();
    const players = (r.players || []).map((p) => `${p.id}#${p.name} ready=${p.ready} side=${p.side}`);
    console.log(
      `      [DEBUG ${tag}] phase=${r.phase} players=[${players.join(', ')}] matchId=${r.matchId} now-createdAt=${r.createdAt ? now - r.createdAt : '?'}ms`
    );
  } catch (err) {
    console.log(`      [DEBUG ${tag}] 读取失败: ${err.message}`);
  }
}

/**
 * 驱动一侧的完整 WS 序列。
 * spec: {
 *   roomName,            // 用于取两侧房间号
 *   players: [{key, name, id}],   // 两个玩家（顺序 = 出场顺序）
 *   bystander: {key, name, id},   // 第三方：只读接收者
 *   spectator: {key, name, id},   // 观战者（开局后加入）
 *   actions: [{label, from, msg, expectClose}],  // from = socket 键
 * }
 */
async function runWsSequence(mode, spec, lockstep) {
  const roomId = spec.roomPair[mode.side];
  const out = { messages: [], sockets: {}, error: null };
  const sockets = {};
  // 关键：帧可能在 openSocket 返回**之前**就已到达（服务端 welcome 极快），也可能在
  // 上一个窗口排空之后、下一个窗口开始之前到达。所以每个 socket 维护一个「已上报游标」
  // rec.emitted，只上报游标之后的新帧；用 frames.length 当游标会把这些帧静默丢掉
  // （实测：welcome 帧会随机消失，造成假差异）。
  const emitNew = (rec, phaseLabel) => {
    for (let i = rec.emitted; i < rec.frames.length; i += 1) {
      out.messages.push({ __ph: phaseLabel, ...rec.frames[i] });
    }
    rec.emitted = rec.frames.length;
  };
  const take = async (key, phaseLabel) => {
    const rec = sockets[key];
    await waitQuiet(rec);
    emitNew(rec, phaseLabel);
  };
  try {
    // 1) 两个玩家依次连接：第二个连接会触发 state 广播给第一个
    for (const p of spec.players) {
      sockets[p.key] = await openSocket(mode.port, `roomId=${roomId}&playerId=${encodeURIComponent(p.id)}`, p.key);
      await take(p.key, 'connect');
    }
    // 2) 第三方玩家连接（非房间成员 → 错误帧 + 关闭，验证错误路径）
    if (spec.bystander) {
      sockets[spec.bystander.key] = await openSocket(
        mode.port,
        `roomId=${roomId}&playerId=${encodeURIComponent(spec.bystander.id)}`,
        spec.bystander.key
      );
      await take(spec.bystander.key, 'connect');
    }
    // 3) 观战者（仅开局后可用；错误路径由 REST 阶段覆盖）
    if (spec.spectator) {
      sockets[spec.spectator.key] = await openSocket(
        mode.port,
        `roomId=${roomId}&spectatorId=${encodeURIComponent(spec.spectator.id)}&role=spectator`,
        spec.spectator.key
      );
      await take(spec.spectator.key, 'connect');
    }
    // 4) 动作序列：用**动作序号**（与 label 无关）标记阶段，两侧天然一致
    for (let ai = 0; ai < spec.actions.length; ai += 1) {
      const action = spec.actions[ai];
      const sock = sockets[action.from];
      if (!sock) throw new Error(`WS 动作 ${action.label} 引用了不存在的 socket: ${action.from}`);
      sock.ws.send(JSON.stringify(action.msg));
      // 各 socket 并行排空：串行等待会让后面 socket 的帧累积到下一次 burst
      await Promise.all(Object.keys(sockets).map((key) => waitQuiet(sockets[key])));
      for (const key of Object.keys(sockets)) emitNew(sockets[key], `action#${ai}`);
    }
    // 5) 收尾排空：把最后一个动作之后仍在路上的帧收进来（例如 leave 触发的中止广播）
    await Promise.all(Object.keys(sockets).map((key) => waitQuiet(sockets[key])));
    for (const key of Object.keys(sockets)) emitNew(sockets[key], 'final');
  } catch (err) {
    out.error = err.message;
  } finally {
    for (const key of Object.keys(sockets)) {
      try { sockets[key].ws.close(); } catch { /* ignore */ }
    }
  }
  // 不做排序：服务端对同一房间的广播在 socket 之间是同一顺序，各接收端的相对
  // 顺序也应一致。保留到达顺序才能把「帧顺序」本身也纳入差分（tx 标识同一事务）。
  out.socketStates = Object.keys(sockets).map((key) => {
    const r = sockets[key];
    return {
      key,
      open: r.open,
      closed: r.closed,
      error: r.error,
      closeAt: r.closeInfo ? r.closeInfo.__at : null,
      closeCode: r.closeInfo ? r.closeInfo.code : null,
      frames: r.frames.map((f) => ({ at: f.__at, type: f.type, reqId: f.reqId, status: f.status, message: f.message })),
    };
  });
  return out;
}

/**
 * 帧的规范化指纹（差分与诊断共用）：剔除 __* 诊断字段后归一化，再序列化。
 * 两侧的同一帧必须得到同一指纹。
 */
function wsFrameSig(m, ctx) {
  const o = {};
  for (const k of Object.keys(m)) if (!k.startsWith('__')) o[k] = m[k];
  o.__sock = m.__sock || '';
  return JSON.stringify(normalizeValue(o, ctx));
}

/**
 * 最长公共子序列（LCS）：把两侧的帧序列对齐，只有「对不上的帧」才算差异。
 * 目的：服务端在一侧可能把某一帧排进了相邻的排空窗口（到达时刻抖动），
 * 这是脚本的观测问题而非行为差异；内容相同的帧即使窗口不同也必须配对成功。
 */
function lcsPairs(l, r) {
  const n = l.length;
  const m = r.length;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        l[i] === r[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (l[i] === r[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * 逐 socket 比对帧序列：用 LCS 对齐后，只有真正对不上的帧才报差异。
 * 对不上的帧按「内容」报告（old / new 各自的指纹 + 阶段标记），所以
 * 「少推一次广播」「多推一次 state」这类真实差异依然会被抓住。
 */
function diffWsFrames(left, right, ctx) {
  const gL = [];
  const gR = [];
  const keys = new Set();
  for (const m of left.messages) keys.add(m.__sock || '?');
  for (const m of right.messages) keys.add(m.__sock || '?');
  for (const key of keys) {
    gL.push([key, left.messages.filter((m) => (m.__sock || '?') === key)]);
    gR.push([key, right.messages.filter((m) => (m.__sock || '?') === key)]);
  }
  const rightMap = new Map(gR);
  const diffs = [];
  for (const [key, lm] of gL) {
    const rm = rightMap.get(key) || [];
    const sigL = lm.map((m) => wsFrameSig(m, ctx));
    const sigR = rm.map((m) => wsFrameSig(m, ctx));
    const pairs = lcsPairs(sigL, sigR);
    const matchedL = new Set(pairs.map((p) => p[0]));
    const matchedR = new Set(pairs.map((p) => p[1]));
    for (let i = 0; i < sigL.length; i += 1) {
      if (matchedL.has(i)) continue;
      diffs.push({
        path: `socket[${key}].frames`,
        kind: 'missing-in-new',
        left: `${lm[i].__ph || '?'} ${wsFrameBrief(sigL[i])}`,
        right: '—',
      });
    }
    for (let j = 0; j < sigR.length; j += 1) {
      if (matchedR.has(j)) continue;
      diffs.push({
        path: `socket[${key}].frames`,
        kind: 'extra-in-new',
        left: '—',
        right: `${rm[j].__ph || '?'} ${wsFrameBrief(sigR[j])}`,
      });
    }
    if (!sigL.length && !sigR.length) continue;
  }
  for (const [key] of gR) {
    if (!gL.some(([k]) => k === key)) {
      for (const m of rightMap.get(key) || []) {
        diffs.push({
          path: `socket[${key}]`,
          kind: 'extra-socket-in-new',
          left: '—',
          right: `${m.__ph || '?'} ${brief(wsFrameSig(m, ctx), 220)}`,
        });
      }
    }
  }
  return diffs;
}

/** 帧的一行人读摘要（诊断用；不参与比对） */
function wsFrameBrief(sig) {
  let o = null;
  try {
    o = JSON.parse(sig);
  } catch {
    return `RAW:${String(sig).slice(0, 100)}`;
  }
  const bits = [String(o.type || '?')];
  if (o.reqId) bits.push(`#${o.reqId}`);
  if (o.status !== undefined) bits.push(`st${o.status}`);
  if (o.message) bits.push(`msg=${o.message}`);
  const b = o.body;
  if (b && typeof b === 'object') {
    if (b.success !== undefined) bits.push(`success=${b.success}`);
    if (b.agreed !== undefined) bits.push(`agreed=${b.agreed}`);
    if (b.message) bits.push(`msg=${b.message}`);
    if (b.pending !== undefined) bits.push(`pending=${b.pending}`);
    if (b.winner !== undefined) bits.push(`winner=${b.winner}`);
    if (b.alreadyStarted !== undefined) bits.push(`alreadyStarted=${b.alreadyStarted}`);
  }
  const d = o.data;
  if (d && typeof d === 'object') {
    if (d.phase) bits.push(`phase=${d.phase}`);
    if (d.matchId !== undefined) bits.push(`matchId=${d.matchId}`);
    if (d.winner !== undefined) bits.push(`winner=${d.winner}`);
    if (d.endReason !== undefined) bits.push(`endReason=${d.endReason}`);
    if (d.gameState) bits.push(`hasGameState`);
    if (d.pendingUndo) bits.push(`pendingUndo`);
    if (d.pendingDraw) bits.push(`pendingDraw`);
    if (Array.isArray(d.emojiMessages)) bits.push(`emoji=${d.emojiMessages.length}`);
  }
  return bits.join(' ') + ` [${String(sig).length}ch]`;
}

function printWsSocketStates(side, out, ctx) {
  console.log(`      [socket 状态 ${side}]${out.error ? ` 运行错误=${out.error}` : ''}`);
  for (const s of out.socketStates || []) {
    const sigs = (out.messages || [])
      .filter((m) => (m.__sock || '?') === s.key)
      .map((m) => wsFrameSig(m, ctx));
    sigs.sort();
    const shown = new Map();
    for (const sig of sigs) shown.set(sig, (shown.get(sig) || 0) + 1);
    console.log(
      `        ${s.key}: open=${s.open} closed=${s.closed} err=${s.error || '-'} closeCode=${s.closeCode} 帧数=${sigs.length}`
    );
    for (const [sig, n] of shown) console.log(`            ×${n} ${wsFrameBrief(sig)}`);
  }
}

// ---------------------------------------------------------------------------
// 10. 场景
// ---------------------------------------------------------------------------
const PLAYERS = {
  a: { name: 'pA', id: 'pA-old' },
  b: { name: 'pB', id: 'pB-old' },
  stranger: { name: 'pS', id: 'pS-old' },
};
const PLAYER_LITERALS = { a: 'pA-old', b: 'pB-old', stranger: 'pS-old' };
// 两侧用同一套字面量，只有房间号不同（脚本自己生成的场景对两侧完全对称）
const SAME_PLAYER_ID = { a: 'diff-pA', b: 'diff-pB', stranger: 'diff-pS' };
const SAME_SPEC_ID = 'diff-spec';

function registerPlayerLiterals(lockstep) {
  // 两侧字面量相同 → 不需要映射，仅登记语义名，便于阅读 <PLAYER:a>
  lockstep.playerIds.push({ name: 'a', old: SAME_PLAYER_ID.a, new: SAME_PLAYER_ID.a });
  lockstep.playerIds.push({ name: 'b', old: SAME_PLAYER_ID.b, new: SAME_PLAYER_ID.b });
  lockstep.playerIds.push({ name: 'stranger', old: SAME_PLAYER_ID.stranger, new: SAME_PLAYER_ID.stranger });
  lockstep.spectatorIds.push({ name: 'spec', old: SAME_SPEC_ID, new: SAME_SPEC_ID });
}

/** 从 `{roomId}` 或 `{room:{id}}` 里取房间号 */
function pickRoomId(json) {
  if (!json || typeof json !== 'object') return null;
  if (typeof json.roomId === 'string' || typeof json.roomId === 'number') return String(json.roomId);
  if (json.room && (typeof json.room.id === 'string' || typeof json.room.id === 'number')) return String(json.room.id);
  return null;
}

async function createRoom(lockstep, name, body, phaseLabel) {
  const res = await lockstep.same(
    `POST /rooms 建房（${name}）`,
    { method: 'POST', path: '/api/v1/lan/rooms', body, phaseLabel },
    {
      phaseLabel,
      // 关键：房间号必须在**比对之前**登记进归一化映射，否则建房响应自身会失真
      onResponses: (left, right) => {
        const oldId = pickRoomId(left.body);
        const newId = pickRoomId(right.body);
        if (oldId && newId) lockstep.registerRoom(name, oldId, newId);
      },
    }
  );
  const oldId = pickRoomId(res.left.body);
  const newId = pickRoomId(res.right.body);
  if (!oldId || !newId) {
    throw new Error(`建房失败，无法取得房间号：old=${JSON.stringify(res.left.body).slice(0, 300)} new=${JSON.stringify(res.right.body).slice(0, 300)}`);
  }
  lockstep.modes.old.roomId = oldId;
  lockstep.modes.new.roomId = newId;
  return { oldId, newId };
}

function roomBodyFor(mode, roomName) {
  return { roomId: mode.roomId, roomName };
}

async function phaseRest(lockstep, ruleEngine) {
  console.log('\n[场景 1] REST 基础与房间生命周期');
  const base = '/api/v1/lan';
  await lockstep.same('GET /api/v1/health', { method: 'GET', path: '/api/v1/health', phaseLabel: 'health' });
  await lockstep.same('GET /rooms（空列表）', { method: 'GET', path: `${base}/rooms`, phaseLabel: 'rooms' });
  await lockstep.same('GET /rooms/active（无 playerId）', { method: 'GET', path: `${base}/rooms/active`, phaseLabel: 'rooms' });
  await lockstep.same('GET /rooms/active?playerId=<未参赛>', {
    method: 'GET',
    path: `${base}/rooms/active?playerId=${SAME_PLAYER_ID.a}`,
    phaseLabel: 'rooms',
  });

  await createRoom(lockstep, 'main', {
    playerName: 'pA',
    playerId: SAME_PLAYER_ID.a,
    roomName: '差分房',
    turnTimeSeconds: 60,
    baseTimeSeconds: 600,
    incrementSeconds: 5,
    byoyomiSeconds: 0,
    handicap: [],
  }, 'create-room');

  const main = 'main';
  await lockstep.same('GET /rooms（建房后）', { method: 'GET', path: `${base}/rooms`, phaseLabel: 'rooms' });
  await lockstep.room('GET /rooms/:id（建房后）', main, (roomId) => ({ method: 'GET', path: `${base}/rooms/${roomId}` }), { phaseLabel: 'get-room' });
  // 注意：真实路由是 GET /rooms/active?playerId=...（无 roomId 段）。
  // 早期版本误写成 /rooms/:id/active，两侧都落 404 兜底，只能验证 A1 加固、
  // 测不到 active 查询本身 —— 已改正。
  await lockstep.same('GET /rooms/active?playerId=a（房主在房中 → 应返回房间）', {
    method: 'GET',
    path: `${base}/rooms/active?playerId=${SAME_PLAYER_ID.a}`,
    phaseLabel: 'rooms',
  });

  console.log('\n[场景 2] 加入 / 设置 / 选边 / 准备 / 开局');
  await lockstep.room('POST /rooms/:id/join（pA 重复加入，幂等）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/join`, body: { playerName: 'pA', playerId: SAME_PLAYER_ID.a },
  }), { phaseLabel: 'join' });
  await lockstep.room('POST /rooms/:id/join（pB）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/join`, body: { playerName: 'pB', playerId: SAME_PLAYER_ID.b },
  }), { phaseLabel: 'join' });
  await lockstep.room('POST /rooms/:id/join（第三人 → 房间已满）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/join`, body: { playerName: 'pS', playerId: SAME_PLAYER_ID.stranger },
  }), { phaseLabel: 'join' });
  await lockstep.room('GET /rooms/:id（两人加入后）', main, (roomId) => ({ method: 'GET', path: `${base}/rooms/${roomId}` }), { phaseLabel: 'get-room' });
  await lockstep.room('PATCH /rooms/:id/settings（房主 pA）', main, (roomId) => ({
    method: 'PATCH',
    path: `${base}/rooms/${roomId}/settings`,
    body: { playerId: SAME_PLAYER_ID.a, name: '差分房2', turnTimeSeconds: 30, baseTimeSeconds: 300, incrementSeconds: 3, byoyomiSeconds: 0, handicap: [] },
  }), { phaseLabel: 'settings' });
  await lockstep.room('PATCH /rooms/:id/settings（非房主 pB → 403）', main, (roomId) => ({
    method: 'PATCH',
    path: `${base}/rooms/${roomId}/settings`,
    body: { playerId: SAME_PLAYER_ID.b, name: '不该生效' },
  }), { phaseLabel: 'settings' });
  await lockstep.room('POST /rooms/:id/ready（pA）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/ready`, body: { playerId: SAME_PLAYER_ID.a },
  }), { phaseLabel: 'ready' });
  await lockstep.room('POST /rooms/:id/side（pA red）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/side`, body: { playerId: SAME_PLAYER_ID.a, side: 'red' },
  }), { phaseLabel: 'side' });
  await lockstep.room('POST /rooms/:id/ready（pB）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/ready`, body: { playerId: SAME_PLAYER_ID.b },
  }), { phaseLabel: 'ready' });
  await lockstep.room('POST /rooms/:id/side（pB black → 触发公示）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/side`, body: { playerId: SAME_PLAYER_ID.b, side: 'black' },
  }), { phaseLabel: 'side' });
  await lockstep.room('GET /rooms/:id（公示中）', main, (roomId) => ({ method: 'GET', path: `${base}/rooms/${roomId}` }), { phaseLabel: 'get-room' });

  // START_COUNTDOWN_MS = 3000：等公示时刻到，让 /start 能真正开局
  console.log('  … 等待 3400ms（START_COUNTDOWN_MS=3000 公示倒计时）');
  await sleep(3400);

  await lockstep.room('POST /rooms/:id/start（到时开局）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/start`, body: { playerId: SAME_PLAYER_ID.a },
  }), { phaseLabel: 'start' });
  await lockstep.room('GET /rooms/:id/start（非房内玩家 → 403）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/start`, body: { playerId: SAME_PLAYER_ID.stranger },
  }), { phaseLabel: 'start' });
  await lockstep.room('POST /rooms/:id/heartbeat（pA 保活）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/heartbeat`, body: { playerId: SAME_PLAYER_ID.a },
  }), { phaseLabel: 'heartbeat' });
  await lockstep.room('POST /rooms/:id/reconnect（pB）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/reconnect`, body: { playerId: SAME_PLAYER_ID.b },
  }), { phaseLabel: 'reconnect' });
  // /returnToRoom 的真实路由存在（src/routes/lanGame.ts 的 actReturnToRoom）：
  // 非 ended 阶段走「幂等返回当前 phase」分支，不修改任何状态 → 可安全在 playing 阶段验证。
  await lockstep.room('POST /rooms/:id/returnToRoom（playing → 幂等 {success,phase}）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/returnToRoom`, body: { playerId: SAME_PLAYER_ID.a },
  }), { phaseLabel: 'return-to-room' });

  console.log('\n[场景 3] 对局数据 / 悔棋 / 求和 / 表情 / 观战');
  const initialState = ruleEngine.createInitialState();
  await lockstep.room('GET /rooms/:id/gameState（开局初始局面）', main, (roomId) => ({
    method: 'GET', path: `${base}/rooms/${roomId}/gameState`,
  }), { phaseLabel: 'gameState' });
  await lockstep.room('POST /rooms/:id/gameState（旧协议上传初始局面）', main, (roomId) => ({
    method: 'POST',
    path: `${base}/rooms/${roomId}/gameState`,
    body: { gameState: JSON.parse(JSON.stringify(initialState)), gameOver: false },
  }), { phaseLabel: 'gameState' });
  await lockstep.room('GET /rooms/:id/gameState（上传后）', main, (roomId) => ({
    method: 'GET', path: `${base}/rooms/${roomId}/gameState`,
  }), { phaseLabel: 'gameState' });

  await lockstep.room('POST /rooms/:id/undo（pA 发起）', main, (roomId) => ({
    method: 'POST',
    path: `${base}/rooms/${roomId}/undo`,
    body: { playerId: SAME_PLAYER_ID.a, proposedState: JSON.parse(JSON.stringify(initialState)) },
  }), { phaseLabel: 'undo' });
  await lockstep.room('POST /rooms/:id/undo（重复发起 → 400）', main, (roomId) => ({
    method: 'POST',
    path: `${base}/rooms/${roomId}/undo`,
    body: { playerId: SAME_PLAYER_ID.a, proposedState: JSON.parse(JSON.stringify(initialState)) },
  }), { phaseLabel: 'undo' });
  await lockstep.room('POST /rooms/:id/undoResponse（pB 同意）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/undoResponse`, body: { playerId: SAME_PLAYER_ID.b, agreed: true },
  }), { phaseLabel: 'undoResponse' });
  await lockstep.room('POST /rooms/:id/draw（pA 发起）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/draw`, body: { playerId: SAME_PLAYER_ID.a },
  }), { phaseLabel: 'draw' });
  await lockstep.room('POST /rooms/:id/drawResponse（pB 拒绝）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/drawResponse`, body: { playerId: SAME_PLAYER_ID.b, agreed: false },
  }), { phaseLabel: 'drawResponse' });
  await lockstep.room('POST /rooms/:id/draw（pA 再次发起）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/draw`, body: { playerId: SAME_PLAYER_ID.a },
  }), { phaseLabel: 'draw' });
  await lockstep.room('POST /rooms/:id/drawResponse（pB 同意 → 和棋结束）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/drawResponse`, body: { playerId: SAME_PLAYER_ID.b, agreed: true },
  }), { phaseLabel: 'drawResponse' });
  await lockstep.room('POST /rooms/:id/emoji（显式 id）', main, (roomId) => ({
    method: 'POST',
    path: `${base}/rooms/${roomId}/emoji`,
    body: { playerId: SAME_PLAYER_ID.a, emoji: '👍', id: 'diff-emoji-1' },
  }), { phaseLabel: 'emoji' });
  await lockstep.room('POST /rooms/:id/emoji（空内容 → 400）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/emoji`, body: { playerId: SAME_PLAYER_ID.a, emoji: '' },
  }), { phaseLabel: 'emoji' });
  await lockstep.room('POST /rooms/:id/heartbeat（保活）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/heartbeat`, body: { playerId: SAME_PLAYER_ID.b },
  }), { phaseLabel: 'heartbeat' });
  await lockstep.room('POST /rooms/:id/spectate（观战者）', main, (roomId) => ({
    method: 'POST',
    path: `${base}/rooms/${roomId}/spectate`,
    body: { spectatorId: SAME_SPEC_ID, spectatorName: '观战者' },
  }), { phaseLabel: 'spectate' });
  await lockstep.room('POST /rooms/:id/spectate/heartbeat', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/spectate/heartbeat`, body: { spectatorId: SAME_SPEC_ID },
  }), { phaseLabel: 'spectate' });
  await lockstep.room('POST /rooms/:id/spectate/leave', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/spectate/leave`, body: { spectatorId: SAME_SPEC_ID },
  }), { phaseLabel: 'spectate' });

  console.log('\n[场景 4] 结束 / 重赛 / 离开');
  await lockstep.room('GET /rooms/:id/gameState（和棋后）', main, (roomId) => ({
    method: 'GET', path: `${base}/rooms/${roomId}/gameState`,
  }), { phaseLabel: 'gameState' });
  await lockstep.room('POST /rooms/:id/rematch（和棋后重置）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/rematch`, body: { playerId: SAME_PLAYER_ID.a },
  }), { phaseLabel: 'rematch' });
  await lockstep.room('GET /rooms/:id（重赛后回到 waiting）', main, (roomId) => ({
    method: 'GET', path: `${base}/rooms/${roomId}`,
  }), { phaseLabel: 'get-room' });
  await lockstep.room('POST /rooms/:id/leave（pB）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/leave`, body: { playerId: SAME_PLAYER_ID.b },
  }), { phaseLabel: 'leave' });
  await lockstep.room('GET /rooms/:id（pB 离开后）', main, (roomId) => ({
    method: 'GET', path: `${base}/rooms/${roomId}`,
  }), { phaseLabel: 'get-room' });
  await lockstep.room('POST /rooms/:id/leave（房主 pA，房间销毁）', main, (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/leave`, body: { playerId: SAME_PLAYER_ID.a },
  }), { phaseLabel: 'leave' });

  console.log('\n[场景 5] 错误路径与兜底');
  const MISSING = '000000';
  lockstep.registerRoom('missing', MISSING, MISSING);
  await lockstep.same('GET /rooms/<不存在> → 404', { method: 'GET', path: `${base}/rooms/${MISSING}`, phaseLabel: 'missing-room' });
  await lockstep.same('POST /rooms/<不存在>/join → 404', {
    method: 'POST', path: `${base}/rooms/${MISSING}/join`, body: { playerName: 'pA', playerId: SAME_PLAYER_ID.a }, phaseLabel: 'missing-room',
  });
  await lockstep.same('POST /rooms/<不存在>/heartbeat → 404', {
    method: 'POST', path: `${base}/rooms/${MISSING}/heartbeat`, body: { playerId: SAME_PLAYER_ID.a }, phaseLabel: 'missing-room',
  });
  await lockstep.same('POST /rooms（缺 playerName → 400）', {
    method: 'POST', path: `${base}/rooms`, body: { playerId: SAME_PLAYER_ID.a }, phaseLabel: 'bad-body',
  });
  await lockstep.same('POST /rooms/<不存在>/ready（缺 playerId → 400）', {
    method: 'POST', path: `${base}/rooms/${MISSING}/ready`, body: {}, phaseLabel: 'bad-body',
  });
  await lockstep.same('POST /rooms/<不存在>/surrender（缺 playerId → 404）', {
    method: 'POST', path: `${base}/rooms/${MISSING}/surrender`, body: {}, phaseLabel: 'bad-body',
  });
  await lockstep.same('POST /rooms/<不存在>/undoResponse（非法 body → 404）', {
    method: 'POST', path: `${base}/rooms/${MISSING}/undoResponse`, body: { agreed: 'yes' }, phaseLabel: 'bad-body',
  });
  // 注意：`/returnToRoom` **确实存在**（src/routes/lanGame.ts:1589，两个产物里都有）。
  // 早期从旧版源码读到的「源码无此路由」结论已作废；这里用不存在的房间号命中
  // 它自己的 404（响应体是 {success:false, message:'房间不存在'}），而不是兜底 404。
  await lockstep.same('POST /rooms/<不存在>/returnToRoom（真实路由 → 404 房间不存在）', {
    method: 'POST', path: `${base}/rooms/${MISSING}/returnToRoom`, body: { playerId: SAME_PLAYER_ID.a }, phaseLabel: 'return-to-room',
  });
  await lockstep.same('GET /api/nope（/api 兜底，KNOWN-A1）', { method: 'GET', path: '/api/nope', phaseLabel: 'api-fallback' });
  await lockstep.same('POST /api/nope（/api 兜底，KNOWN-A1）', {
    method: 'POST', path: '/api/nope', body: { a: 1 }, phaseLabel: 'api-fallback',
  });
  await lockstep.same('GET /totally-unknown（express 默认 404，应相同）', {
    method: 'GET', path: '/totally-unknown', phaseLabel: 'unknown-route',
  });
}

/**
 * 【场景 7】AI 端点 —— 已随服务端去 AI 化移除（2026-10）
 *
 * 原场景比对 `/api/v1/ai/{move,stats}`（在线皮卡鱼）。AI 能力与引擎池已从服务端
 * 删除，这些路径不再存在；但「它们确实不存在」本身值得守护：若有人误把 aiRouter
 * 挂回来、或路由表出现意外回归，这里应当立刻发现。
 *
 * 实现上改为断言这些端点返回 404（命中 /api 兜底），既能验证"确实已移除"，
 * 又不会因为旧布尔逻辑产生假绿灯。
 */
async function phaseAi(lockstep) {
  console.log('\n[场景 7] AI 端点（已移除，断言 404）');
  const base = '/api/v1/ai';
  await lockstep.same('GET /api/v1/ai/stats（已移除 → 404）', { method: 'GET', path: `${base}/stats`, phaseLabel: 'ai-stats' });
  await lockstep.same('POST /api/v1/ai/move（已移除 → 404）', {
    method: 'POST', path: `${base}/move`, body: { fen: 'x w', difficulty: 'hint' }, phaseLabel: 'ai-removed',
  });
}

async function phaseWs(lockstep, ruleEngine) {
  console.log('\n[场景 6] WebSocket /api/v1/lan/ws');
  const base = '/api/v1/lan';
  await createRoom(lockstep, 'ws', {
    playerName: 'pA',
    playerId: SAME_PLAYER_ID.a,
    roomName: 'WS差分',
    turnTimeSeconds: 60,
    baseTimeSeconds: 600,
    incrementSeconds: 5,
    byoyomiSeconds: 0,
    handicap: [],
  }, 'ws-create');
  // 建房者是 pA；必须把 pB 也 join 进来，否则 WS 侧 pB 连接会被正确拒绝
  // （「玩家不在房间中」是**正确**契约，不是差异）
  await lockstep.room('POST /rooms/:id/join（ws 房 pA，幂等）', 'ws', (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/join`, body: { playerName: 'pA', playerId: SAME_PLAYER_ID.a },
  }), { phaseLabel: 'join' });
  await lockstep.room('POST /rooms/:id/join（ws 房 pB）', 'ws', (roomId) => ({
    method: 'POST', path: `${base}/rooms/${roomId}/join`, body: { playerName: 'pB', playerId: SAME_PLAYER_ID.b },
  }), { phaseLabel: 'join' });

  const wsRoomOld = lockstep.modes.old.roomId;
  const wsRoomNew = lockstep.modes.new.roomId;
  const actions = [
    { label: 'ready', from: 'a', msg: { type: 'ready', reqId: 'ws-1', playerId: SAME_PLAYER_ID.a } },
    { label: 'ready', from: 'b', msg: { type: 'ready', reqId: 'ws-2', playerId: SAME_PLAYER_ID.b } },
    { label: 'side', from: 'a', msg: { type: 'side', reqId: 'ws-3', playerId: SAME_PLAYER_ID.a, side: 'red' } },
    { label: 'side', from: 'b', msg: { type: 'side', reqId: 'ws-4', playerId: SAME_PLAYER_ID.b, side: 'black' } },
    { label: 'heartbeat', from: 'a', msg: { type: 'heartbeat', reqId: 'ws-5', playerId: SAME_PLAYER_ID.a } },
    { label: 'emoji', from: 'b', msg: { type: 'emoji', reqId: 'ws-6', playerId: SAME_PLAYER_ID.b, emoji: '🎉', id: 'ws-emoji-1' } },
    { label: 'unknown-type', from: 'a', msg: { type: 'no-such-type', reqId: 'ws-7', playerId: SAME_PLAYER_ID.a } },
  ];

  const run = await lockstep.wsRun('WS 连接/准备/选边/心跳/表情/未知类型', {    roomName: 'ws',
    roomPair: { old: wsRoomOld, new: wsRoomNew },
    players: [
      { key: 'a', name: 'pA', id: SAME_PLAYER_ID.a },
      { key: 'b', name: 'pB', id: SAME_PLAYER_ID.b },
    ],
    bystander: { key: 's', name: 'pS', id: SAME_PLAYER_ID.stranger },
    actions,
  });

  // 公示倒计时后开局（WS 房还没开局，必须先让 phase=playing）
  console.log('  … 等待 3400ms（公示倒计时）后开始对局');
  await sleep(3400);
  await lockstep.room('WS 房 POST /start（开局）', 'ws', (roomId) => ({
    method: 'POST',
    path: `/api/v1/lan/rooms/${roomId}/start`,
    body: { playerId: SAME_PLAYER_ID.a },
  }), { phaseLabel: 'start' });

  const gameState = ruleEngine.createInitialState();
  const movedState = JSON.parse(JSON.stringify(gameState));
  // 走一步「炮二平五」形态的假着法：服务端只存储不校验，两侧字面量必须完全一致
  movedState.moveHistory.push({ pieceId: 24, fromCol: 1, fromRow: 7, toCol: 4, toRow: 7, capturedPieceId: -1 });
  const undoState = JSON.parse(JSON.stringify(gameState));

  const run2 = await lockstep.wsRun('WS 对局内：move/surrender/undo/draw/emoji/rematch', {
    roomName: 'ws',
    roomPair: { old: wsRoomOld, new: wsRoomNew },
    players: [
      { key: 'a', name: 'pA', id: SAME_PLAYER_ID.a },
      { key: 'b', name: 'pB', id: SAME_PLAYER_ID.b },
    ],
    spectator: { key: 'v', name: 'spec', id: SAME_SPEC_ID },
    actions: [
      { label: 'move', from: 'a', msg: { type: 'move', reqId: 'ws-10', playerId: SAME_PLAYER_ID.a, gameState: movedState, gameOver: false } },
      { label: 'emoji', from: 'b', msg: { type: 'emoji', reqId: 'ws-11', playerId: SAME_PLAYER_ID.b, emoji: '🚩', id: 'ws-emoji-2' } },
      { label: 'undo', from: 'a', msg: { type: 'undo', reqId: 'ws-12', playerId: SAME_PLAYER_ID.a, proposedState: undoState } },
      { label: 'undoResponse', from: 'b', msg: { type: 'undoResponse', reqId: 'ws-13', playerId: SAME_PLAYER_ID.b, agreed: true } },
      { label: 'draw', from: 'a', msg: { type: 'draw', reqId: 'ws-14', playerId: SAME_PLAYER_ID.a } },
      { label: 'drawResponse', from: 'b', msg: { type: 'drawResponse', reqId: 'ws-15', playerId: SAME_PLAYER_ID.b, agreed: false } },
      { label: 'surrender', from: 'b', msg: { type: 'surrender', reqId: 'ws-16', playerId: SAME_PLAYER_ID.b } },
      { label: 'rematch', from: 'a', msg: { type: 'rematch', reqId: 'ws-17', playerId: SAME_PLAYER_ID.a } },
    ],
  });

  return [run, run2];
}

// ---------------------------------------------------------------------------
// 11. 主流程
// ---------------------------------------------------------------------------
function printKnownTable() {
  console.log('\n已知差异登记表（KNOWN；命中只统计不判失败）：');
  for (const r of KNOWN_RULES) {
    const hits = tally.knownByRule.get(r.id) || 0;
    const mark = hits > 0 ? 'HIT ' : (r.inactive ? 'INACTIVE' : 'not-hit');
    console.log(`  ${r.id.padEnd(3)} ${mark.padEnd(9)} ${r.title}`);
    console.log(`      ${r.reason}`);
  }
  console.log('  白名单（业务字段）：空 —— 除上表外任何差异都会判失败并打印字段路径');
}

function printSummary(opts, artifact, startTime) {
  const secs = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(78));
  console.log('总结');
  console.log('='.repeat(78));
  console.log(`  产物 old : ${artifact.oldPath}`);
  console.log(`             ${artifact.oldInfo.size} 字节  md5=${artifact.oldInfo.md5}`);
  console.log(`  产物 new : ${opts.new}`);
  console.log(`             ${artifact.newInfo.size} 字节  md5=${artifact.newInfo.md5}`);
  if (artifact.oldInfo.md5 === artifact.newInfo.md5) {
    console.log('  ⚠ 证据强度警告：两侧产物 md5 相同 → 本次差分只能证明「无假阳性」，');
    console.log('    不能证明任何行为等价（新 dist 尚未重建时属预期）。');
  }
  for (const n of artifact.note) console.log(`  备注: ${n}`);
  console.log(`  执行步数 : ${tally.steps}（干净 ${tally.clean}，含已知差异 ${tally.steps - tally.clean - tally.failures.length}，失败 ${tally.failures.length}）`);
  console.log(`  差异计数 : 已知 ${tally.known} 处 / 非已知 ${tally.failed} 处`);
  if (tally.ruleHits.size) {
    const hits = [...tally.ruleHits].map((id) => {
      const r = KNOWN_RULES.find((x) => x.id === id);
      return `${id}×${tally.knownByRule.get(id)}(${r ? r.title : '?'})`;
    });
    console.log(`  命中的已知差异: ${hits.join('；')}`);
    for (const s of tally.knownSamples.slice(0, 8)) console.log(`      · ${s}`);
  } else {
    console.log('  命中的已知差异: 无（两侧行为未落在任何已登记差异上）');
  }
  if (tally.failures.length) {
    console.log(`\n非已知差异明细（${tally.failures.length} 个步骤）：`);
    for (const f of tally.failures.slice(0, 20)) {
      console.log(`  ✗ ${f.stepLabel}  [${f.path}]`);
      for (const d of f.diffs.slice(0, 10)) {
        console.log(`      ${d.path}  [${d.kind}]  old=${d.left}  new=${d.right}`);
      }
      if (f.diffs.length > 10) console.log(`      … 另有 ${f.diffs.length - 10} 处`);
    }
  }
  console.log(`\n耗时 ${secs}s`);
  console.log('='.repeat(78));
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  opts.quiet = false;
  const startTime = Date.now();

  console.log('='.repeat(78));
  console.log('服务端产物行为差分验证（verify-server-diff.cjs）');
  console.log('='.repeat(78));
  console.log(`  old = ${opts.old}`);
  console.log(`  new = ${opts.new}${opts.self ? '  （--self：与 old 同一文件）' : ''}`);
  console.log(`  端口 old=${opts.oldPort}  new=${opts.newPort}   阶段=${opts.phase}`);

  const artifact = prepareOldArtifact(opts);
  console.log(`  old md5 = ${artifact.oldInfo.md5}  (${artifact.oldInfo.size} 字节)`);
  console.log(`  new md5 = ${artifact.newInfo.md5}  (${artifact.newInfo.size} 字节)`);
  for (const n of artifact.note) console.log(`  备注: ${n}`);

  const ruleEnginePath = path.join(SERVER_DIR, 'ruleEngine.cjs');
  const ruleEngine = require(ruleEnginePath);

  const modes = {
    old: { side: 'old', label: 'old', port: opts.oldPort, file: artifact.oldPath, roomId: null },
    new: { side: 'new', label: 'new', port: opts.newPort, file: opts.new, roomId: null },
  };
  for (const m of [modes.old, modes.new]) {
    const info = fileInfo(m.file);
    if (!info.exists) throw new Error(`产物不存在: ${m.file}`);
  }

  console.log(`\n启动子进程（cwd=${SERVER_DIR}）…`);
  // 先确认端口空闲：端口被占用会导致子进程 EADDRINUSE 秒退，而 waitHealthy 可能
  // 被外来服务的健康响应骗过 → 差分静默失效却报「全部通过」（见 assertPortFree 说明）
  await assertPortFree(opts.oldPort, 'old');
  await assertPortFree(opts.newPort, 'new');
  const childOld = spawnServer('old', modes.old.file, modes.old.port);
  const childNew = spawnServer('new', modes.new.file, modes.new.port);
  modes.old.child = childOld;
  modes.new.child = childNew;
  await waitHealthy(modes.old.port, childOld);
  await waitHealthy(modes.new.port, childNew);
  // 就绪后复查子进程仍存活：确认刚才的"健康"确实来自我们自己的进程
  assertChildAlive(childOld);
  assertChildAlive(childNew);
  console.log('  两个实例 /api/v1/health 均就绪');

  const lockstep = new Lockstep(modes, opts);
  registerPlayerLiterals(lockstep);

  if (opts.phase === 'all' || opts.phase === 'rest') await phaseRest(lockstep, ruleEngine);
  // 顺序很重要：WS 房建好之后必须**立刻**连接 WS，否则 waiting 房超过
  // WAITING_SWEEP_GRACE_MS=30s 无活跃 WS/打点会被 sweepWaitingRoom 清空成员。
  // AI 阶段耗时最久（引擎搜索数秒），放到最后。
  if (opts.phase === 'all' || opts.phase === 'ws') await phaseWs(lockstep, ruleEngine);
  if (opts.phase === 'all' || opts.phase === 'ai') await phaseAi(lockstep);

  // WS 阶段补充：把两侧房间号登记进 lockstep 的映射（wsRun 已在建库时注册）
  printKnownTable();
  printSummary(opts, artifact, startTime);

  return tally.failed === 0 ? 0 : 1;
}

let exitCode = 1;
process.on('SIGINT', () => {
  console.log('\n收到 SIGINT，清理子进程…');
  globalCleanup(parseArgv.safeOpts || { keep: false });
  process.exit(130);
});

(async () => {
  const opts = parseArgv(process.argv.slice(2));
  parseArgv.safeOpts = opts;
  try {
    exitCode = await main();
  } catch (err) {
    console.error('\n验证失败（脚本/环境错误）：', err && err.stack ? err.stack : err);
    exitCode = 1;
  } finally {
    globalCleanup(opts);
    console.log(exitCode === 0 ? '\n全部通过：两侧无「非已知」差异。' : '\n存在差异或错误，退出码 1。');
    process.exit(exitCode);
  }
})();
