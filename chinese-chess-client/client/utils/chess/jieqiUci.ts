/**
 * jieqiUci —— 揭棋着法（UCI 4 字符 + 揭晓后缀）编解码（纯函数层）
 *
 * ============================================================================
 * 【依据：源码级核实】
 *
 * `jieqi_old` 的 `src/uci.cpp` `position()` 实测分支：token.size() == 4 / 5 / 6
 *   · 4 字符：纯移动，无揭晓
 *   · 5 字符：第 5 位 = **自身**暗子揭晓的棋种
 *   · 6 字符：第 5 位 = 自身揭晓，第 6 位 = **被吃**暗子的棋种
 *
 * 另有一条重要事实（源码 `uci.cpp` 的 `UCI::move()`）：**引擎输出的 bestmove
 * 永远是 4 字符**，不会带揭晓后缀。后缀只出现在「喂给引擎的 position/history」里，
 * 由**界面（我们）**告知引擎「这步翻开了什么」。
 *
 * ⚠️ 因此解码时**不能**指望从 bestmove 读出身份：身份由本地 `identity` 决定。
 */

/** 揭棋棋种 */
export type { JieqiPieceType } from './types';

/** 棋种 ↔ FEN 字符（大写=红，小写=黑） */
const TYPE_TO_CHAR: Record<string, string> = {
  R: 'che', N: 'ma', C: 'pao', A: 'shi', B: 'xiang', P: 'bing',
  r: 'che', n: 'ma', c: 'pao', a: 'shi', b: 'xiang', p: 'zu',
};
const CHAR_TO_TYPE: Record<string, string> = {
  R: 'che', N: 'ma', C: 'pao', A: 'shi', B: 'xiang', P: 'bing',
  r: 'che', n: 'ma', c: 'pao', a: 'shi', b: 'xiang', p: 'zu',
};

/** 一手揭棋着法（含两个揭晓位） */
export interface JieqiMove {
  /** 4 字符坐标部分，如 "h0g2" */
  uci: string;
  /** 自身暗子揭晓后的棋种；null = 无揭晓（未翻暗子或走明子） */
  movedReveal: string | null;
  /** 被吃暗子的棋种；null = 未吃暗子 */
  capturedReveal: string | null;
}

/** 4 字符坐标着法：形如 h0g2（无捕获组，避免 lint 的未用捕获组告警） */
const BASE_MOVE_RE = /^[a-i]\d[a-i]\d$/;
const REVEAL_CHARS = new Set(['R', 'N', 'C', 'A', 'B', 'P', 'r', 'n', 'c', 'a', 'b', 'p']);

/** 纯 4 字符着法（与象棋口径一致，可复用现有正则在外部校验） */
export function isValidJieqiBaseMove(s: string): boolean {
  return BASE_MOVE_RE.test(s);
}

/**
 * 解析带揭晓后缀的着法（4/5/6 字符）。
 *
 * @returns null 表示格式非法（调用方必须按「非法着法」处理，绝不能猜落点）
 */
export function parseJieqiMove(token: string): JieqiMove | null {
  if (!token || token.length < 4 || token.length > 6) return null;

  const base = token.slice(0, 4);
  if (!BASE_MOVE_RE.test(base)) return null;

  const suffix = token.slice(4);
  let movedReveal: string | null = null;
  let capturedReveal: string | null = null;

  for (let i = 0; i < suffix.length; i++) {
    const ch = suffix[i];
    if (!REVEAL_CHARS.has(ch)) return null;
    const type = CHAR_TO_TYPE[ch];
    if (i === 0) movedReveal = type;
    else capturedReveal = type;
  }
  // 6 字符时第 6 位是被吃子；若只有 5 字符则第 5 位是自身。
  // 但引擎允许「只有被吃没有自身」——由调用方按局面判断，解析层保持原样。
  return { uci: base, movedReveal, capturedReveal };
}

/**
 * 组装着法字符串（喂给引擎的 position/history）。
 *
 * @param base        4 字符坐标
 * @param movedReveal 自身揭晓棋种（大写=红/小写=黑 的 FEN 字符），无则 null
 * @param capturedReveal 被吃暗子棋种，无则 null
 */
export function buildJieqiMove(
  base: string,
  movedRevealChar: string | null,
  capturedRevealChar: string | null
): string {
  if (!BASE_MOVE_RE.test(base)) {
    throw new Error(`非法的揭棋坐标着法: ${base}`);
  }
  let out = base;
  if (movedRevealChar) {
    if (!REVEAL_CHARS.has(movedRevealChar)) {
      throw new Error(`非法的揭晓棋种字符: ${movedRevealChar}`);
    }
    out += movedRevealChar;
  }
  if (capturedRevealChar) {
    if (!REVEAL_CHARS.has(capturedRevealChar)) {
      throw new Error(`非法的被吃棋种字符: ${capturedRevealChar}`);
    }
    out += capturedRevealChar;
  }
  return out;
}

/** 棋种（che/ma/…）→ FEN 字符（按所属方） */
export function typeToChar(type: string, isRed: boolean): string | null {
  const pair: Record<string, [string, string]> = {
    che: ['R', 'r'], ma: ['N', 'n'], pao: ['C', 'c'],
    shi: ['A', 'a'], xiang: ['B', 'b'], bing: ['P', ''], zu: ['', 'p'],
  };
  const p = pair[type];
  if (!p) return null;
  return isRed ? p[0] || null : p[1] || null;
}

/** FEN 字符 → 棋种（che/ma/…） */
export function charToType(ch: string): string | null {
  return CHAR_TO_TYPE[ch] ?? null;
}

/**
 * 解析引擎输出的 bestmove 行。
 *
 * ⚠️ 源码事实：引擎 bestmove **恒为 4 字符**。这里做严格校验并剥离可能出现的
 * 异常后缀（若上游将来改为输出后缀，也不至于解析失败）。
 *
 * @returns 4 字符着法，或 null（非法）
 */
export function parseBestmove(line: string): string | null {
  const m = /^bestmove\s+(\S+)/.exec(line.trim());
  if (!m) return null;
  const mv = parseJieqiMove(m[1]);
  return mv ? mv.uci : null;
}

/**
 * 从 bestmove 提取搜索信息（depth / nps / multiPV 候选）。
 * 与现有 pikafishUci.ts 同构，但只识别 4 字符 PV。
 */
export interface JieqiInfoState {
  depth: number;
  timeMs: number;
  candidates: Map<number, string>;
  candidateDepth: number;
}

export function createInfoState(): JieqiInfoState {
  return { depth: 0, timeMs: 0, candidates: new Map(), candidateDepth: 0 };
}

const RE_DEPTH = /\bdepth (\d+)/;
const RE_TIME = /\btime (\d+)/;
const RE_MULTIPV = /\bmultipv (\d+)/;
const RE_PV = /\bpv\s+([a-i]\d[a-i]\d)/;

/**
 * 累积一条引擎输出行。返回 true 表示这是 bestmove（搜索结束）。
 */
export function consumeEngineLine(line: string, st: JieqiInfoState): boolean {
  const s = line.trim();
  if (!s) return false;
  if (s.startsWith('bestmove')) return true;
  if (!s.startsWith('info')) return false;

  const d = RE_DEPTH.exec(s);
  if (d) {
    const depth = Number(d[1]);
    if (depth > st.depth) st.depth = depth;
  }
  const t = RE_TIME.exec(s);
  if (t) st.timeMs = Number(t[1]);

  const mv = RE_MULTIPV.exec(s);
  const pv = RE_PV.exec(s);
  if (mv && pv) {
    const depth = d ? Number(d[1]) : st.depth;
    const idx = Number(mv[1]);
    if (depth > st.candidateDepth) {
      st.candidates.clear();
      st.candidateDepth = depth;
    }
    if (depth === st.candidateDepth) st.candidates.set(idx, pv[1]);
  }
  return false;
}

/**
 * 从候选里挑着法。easy 档随机挑，其余取 pv 1。
 *
 * @param rand 注入随机源，便于测试可复现
 */
export function chooseUci(
  st: JieqiInfoState,
  randomPick: boolean,
  rand: () => number = Math.random
): string | null {
  const list = [...st.candidates.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, uci]) => uci)
    .filter((u) => BASE_MOVE_RE.test(u));
  if (list.length === 0) return null;
  if (randomPick && list.length > 1) {
    return list[Math.floor(rand() * list.length)];
  }
  return list[0];
}

/** 引擎是否报告致命错误（非法局面/着法会让它退出，必须重建实例） */
export function isCriticalErrorLine(line: string): boolean {
  return /CRITICAL ERROR|Aborted\(|Assertion/i.test(line);
}
