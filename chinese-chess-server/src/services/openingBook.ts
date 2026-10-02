/**
 * 开局库服务
 *
 * 加载由 scripts/generateOpeningBook.cjs 预生成的开局库（openingBook.json），
 * 运行期优先查库：命中则直接返回推荐着法（零 CPU 搜索），未命中再交给皮卡鱼引擎池。
 *
 * 键为客户端 toFenString 生成的局面串（仅「棋子布局 + 走子方」两段），
 * 开局库由引擎自举生成、天然只覆盖开局阶段，因此命中即代表仍处于开局。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { uciToInternal } from './pikafish';

export interface BookMove {
  uci: string;
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
}

let book: Record<string, string> | null = null;
let loadFailed = false;

function resolveBookFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'ai/openingBook.json'),
    path.resolve(process.cwd(), 'server/ai/openingBook.json'),
    path.resolve(here, '../../ai/openingBook.json'),
    path.resolve(here, '../ai/openingBook.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

/** 归一化局面键：仅保留「棋子布局 + 走子方」前两段，兼容携带更多字段的 FEN */
function normalizeKey(fen: string): string {
  return fen.trim().split(/\s+/).slice(0, 2).join(' ');
}

/** 预加载开局库（启动时调用，失败不影响主流程） */
export function loadOpeningBook(): number {
  if (book || loadFailed) return book ? Object.keys(book).length : 0;
  try {
    const file = resolveBookFile();
    const raw = fs.readFileSync(file, 'utf8');
    book = JSON.parse(raw) as Record<string, string>;
    console.log(`[开局库] 已加载 ${Object.keys(book).length} 条 ← ${file}`);
    return Object.keys(book).length;
  } catch (err) {
    loadFailed = true;
    console.warn('[开局库] 加载失败，将全部走引擎:', (err as Error).message);
    return 0;
  }
}

/**
 * 查询开局库
 * @returns 命中返回着法；未命中返回 null（调用方转引擎）
 */
export function lookupBookMove(fen: string): BookMove | null {
  if (!book && !loadFailed) loadOpeningBook();
  if (!book) return null;
  const uci = book[normalizeKey(fen)];
  if (!uci) return null;
  const internal = uciToInternal(uci);
  if (!internal) return null;
  return { uci, ...internal };
}

/** 开局库条目数（用于观测） */
export function getBookSize(): number {
  return book ? Object.keys(book).length : 0;
}
