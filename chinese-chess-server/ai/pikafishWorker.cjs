'use strict';
/**
 * 皮卡鱼引擎 Worker 线程脚本（CommonJS）。
 *
 * 每个 Worker 承载一个独立的皮卡鱼 WASM 引擎实例，拥有独立事件循环与 OS 线程，
 * 使引擎搜索获得真正的 CPU 并行能力，且不会阻塞主线程的 HTTP 服务。
 *
 * 与主线程（池管理器）通过 worker_threads 消息通信：
 *   主线程 → Worker：
 *     { type: 'search', jobId, fen, multiPV, depth?, movetime?,
 *       startFen?, moves? }                                        发起一次搜索
 *       （startFen+moves 提供完整对局历史时优先使用，使引擎感知重复局面规则）
 *     { type: 'stop', jobId }                                      中止当前搜索
 *   Worker → 主线程：
 *     { type: 'ready' }                                            引擎初始化完成
 *     { type: 'result', jobId, uci, depth, candidates? }           搜索完成
 *     { type: 'error', jobId?, message }                           初始化/运行错误
 */
const { parentPort } = require('worker_threads');
const path = require('path');

if (!parentPort) {
  throw new Error('pikafishWorker.cjs 必须作为 worker_threads 子线程运行');
}
const port = parentPort;

// 引擎位于本脚本同级的 pikafish/ 子目录（server/ai/pikafish/pikafish.cjs）
const Pikafish = require('./pikafish/pikafish.cjs');

let engine = null;
let ready = false;
let currentJobId = null;
let finalDepth = 0;
let candidateByPv = new Map();
let candidateDepth = 0;

/** 解析引擎 stdout 流，采集深度 / 多候选 / 最终着法 */
function handleStdout(rawLine) {
  const line = String(rawLine).trim();
  if (!line) return;

  // 初始化就绪信号（uci + isready 后输出 readyok）
  if (line === 'readyok') {
    if (!ready) {
      ready = true;
      port.postMessage({ type: 'ready' });
    }
    return;
  }

  // 记录搜索深度
  const depthMatch = /info depth (\d+)/.exec(line);
  if (depthMatch) finalDepth = Math.max(finalDepth, Number(depthMatch[1]));

  // 收集多候选首着（multipv）
  const pvMatch = /info depth (\d+)[^\n]*?\bmultipv (\d+)[^\n]*?\bpv\s+([a-i]\d[a-i]\d)/.exec(line);
  if (pvMatch) {
    const d = Number(pvMatch[1]);
    const pvIdx = Number(pvMatch[2]);
    if (d >= candidateDepth) {
      if (d > candidateDepth) {
        candidateByPv.clear();
        candidateDepth = d;
      }
      candidateByPv.set(pvIdx, pvMatch[3]);
    }
  }

  // 搜索结束：bestmove
  const bestMatch = /^bestmove\s+([a-i]\d[a-i]\d)/.exec(line);
  if (bestMatch) {
    const jobId = currentJobId;
    currentJobId = null;
    const candidates = candidateByPv.size > 1 ? Array.from(candidateByPv.values()) : undefined;
    port.postMessage({
      type: 'result',
      jobId,
      uci: bestMatch[1],
      depth: finalDepth,
      candidates,
    });
  }
}

/** 加载并初始化引擎实例 */
async function init() {
  engine = await Pikafish({
    locateFile: (p) =>
      p === 'pikafish.data'
        ? path.join(__dirname, 'pikafish', 'data', p)
        : path.join(__dirname, 'pikafish', p),
    setStatus: () => undefined,
  });
  engine.read_stdout = handleStdout;
  engine.send_command('uci');
  engine.send_command('isready');
}

port.on('message', (msg) => {
  if (!engine) return;
  if (msg && msg.type === 'search') {
    currentJobId = msg.jobId;
    finalDepth = 0;
    candidateByPv.clear();
    candidateDepth = 0;
    // 关键确定性保障：每次搜索前清空置换表与历史启发（ucinewgame → Search::clear）。
    // 若不清空，上一局面残留的置换表/历史表会改变本局面的走法排序与剪枝路径，
    // 导致「同一局面 + 同一深度」在不同时刻/不同 Worker 上给出不同 bestmove（提示不一致的根因）。
    engine.send_command('ucinewgame');
    engine.send_command(`setoption name MultiPV value ${msg.multiPV || 1}`);
    // 优先使用「起始局面 + 完整着法历史」设置局面：
    // 引擎据此感知本局真实重复（长将/长捉/不变循环），搜索中会主动规避违规循环；
    // 仅传 FEN 时引擎无历史可查，无法识别实际对局中的重复局面。
    if (msg.startFen && Array.isArray(msg.moves) && msg.moves.length > 0) {
      engine.send_command(`position fen ${msg.startFen} moves ${msg.moves.join(' ')}`);
    } else {
      engine.send_command(`position fen ${msg.fen}`);
    }
    if (msg.movetime) engine.send_command(`go movetime ${msg.movetime}`);
    else engine.send_command(`go depth ${msg.depth || 8}`);
  } else if (msg && msg.type === 'stop') {
    // 中止当前搜索：引擎会尽快输出 bestmove（已搜到的最佳着法）
    engine.send_command('stop');
  }
});

init().catch((err) => {
  port.postMessage({ type: 'error', message: String((err && err.message) || err) });
});
