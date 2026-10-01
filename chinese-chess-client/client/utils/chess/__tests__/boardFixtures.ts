/**
 * 测试用棋盘构造器 —— **专门用来避免 FEN 行列写反的坑**。
 *
 * ============================================================================
 * 【本仓 FEN = 标准「行优先」写法】
 *
 * `GameEngine.ts:590-653 createFromFen` 的解析是：
 *
 *     for (const c of boardStr) {
 *       if (c === '/') { row++; col = 0; continue; }   // '/' 换行（row）
 *       if (c >= '0' && c <= '9') { … col++; }          // 段内推进列（col）
 *       qiPan[col][row] = idx;                          // 落子
 *     }
 *
 * 于是 `'4k4/…'` = **第 0 行（row 0，黑方底线）**，段内第 j 个字符 = 第 j 列，
 * 与 `'rnbakabnr/9/1c5c1/p1p1p1p1p/…'` 这套常见写法完全一致，
 * 也与 `toFenString` 的输出互为逆运算（ruleEngineParity.test.ts 已在用）。
 *
 * ⚠️ **两个反直觉之处（都实际踩中过）**：
 *
 * 1. **一段覆盖 10 格 ≠ 一段 10 个字符**。数字是"连续空格的数量"，
 *    所以有子的一行 `'4k5'` 只有 4 个字符却覆盖 10 格。曾误以为"段长必须等于 10"，
 *    据此把整个 fixture 改成列优先，结果 FEN 段长 10（`'91'` 空列 + 子）导致
 *    `createFromFen` 层层越界（`col` 涨到 9 → `qiPan[9]` undefined →
 *    `TypeError: Cannot set properties of undefined`）。
 * 2. **数字必须逐位写**：`parseInt(c)` 是逐字符累加，10 个空格要写成 `'9' + '1'`，
 *    写成 `'10'` 只会填 1 格。
 *
 * 结论：本文件用**坐标**接口（col/row）生成 FEN，从根上避免手写。
 */

export type FenChar = 'k' | 'a' | 'b' | 'n' | 'r' | 'c' | 'p' | 'K' | 'A' | 'B' | 'N' | 'R' | 'C' | 'P';

const BOARD_COLS = 9;
const BOARD_ROWS = 10;

/** 构建器：`board('b').at(4, 0, 'k').at(4, 8, 'R').at(4, 9, 'K').toString()` */
export class BoardBuilder {
  /** grid[row][col] —— row 0 在"上"（黑方底线），row 9 在"下"（红方底线） */
  private readonly grid: (FenChar | undefined)[][];

  constructor(private readonly side: 'w' | 'b') {
    this.grid = Array.from({ length: BOARD_ROWS }, () => Array.from({ length: BOARD_COLS }, () => undefined));
  }

  /** 放一枚子。col = 0..8（左→右），row = 0..9（**row 0 是黑方底线即上方**，row 9 是红方底线） */
  at(col: number, row: number, ch: FenChar): this {
    if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || col >= BOARD_COLS || row < 0 || row >= BOARD_ROWS) {
      throw new Error(`棋盘坐标越界：(${col},${row})；合法范围 col 0..8 / row 0..9`);
    }
    if (this.grid[row][col]) {
      throw new Error(`坐标 (${col},${row}) 已放置棋子 ${this.grid[row][col]}`);
    }
    this.grid[row][col] = ch;
    return this;
  }

  /** 一次放多枚：`atAll([[4,8,'R'],[4,9,'K']])` */
  atAll(items: [number, number, FenChar][]): this {
    for (const [col, row, ch] of items) this.at(col, row, ch);
    return this;
  }

  toString(): string {
    const rows: string[] = [];
    for (let row = 0; row < BOARD_ROWS; row++) {
      let segment = '';
      let empty = 0;
      const flushEmpty = () => {
        // 连续空格必须逐位写：本仓是 `parseInt(c)` 逐字符填格，'10' 只会填 1 格
        while (empty > 0) {
          const chunk = Math.min(empty, 9);
          segment += String(chunk);
          empty -= chunk;
        }
        empty = 0;
      };
      for (let col = 0; col < BOARD_COLS; col++) {
        const ch = this.grid[row][col];
        if (ch) {
          flushEmpty();
          segment += ch;
        } else {
          empty += 1;
        }
      }
      flushEmpty();
      const squares = countSquares(segment);
      if (squares !== BOARD_COLS) {
        throw new Error(`FEN 第 ${row} 行 "${segment}" 覆盖 ${squares} 格，应为 ${BOARD_COLS}`);
      }
      rows.push(segment);
    }
    if (rows.length !== BOARD_ROWS) {
      throw new Error(`FEN 行数 ${rows.length}，应为 ${BOARD_ROWS}`);
    }
    return `${rows.join('/')} ${this.side}`;
  }
}

export function board(side: 'w' | 'b'): BoardBuilder {
  return new BoardBuilder(side);
}

/** 简写：`fen('b', [[4,0,'k'],[4,8,'R'],[4,9,'K']])` */
export function fen(side: 'w' | 'b', items: [number, number, FenChar][]): string {
  return board(side).atAll(items).toString();
}

/**
 * 一段 FEN 覆盖多少格：数字串表示若干空格（逐位累加，与 createFromFen 的
 * `parseInt(c)` 口径一致），其余字符各占 1 格。
 */
function countSquares(segment: string): number {
  let n = 0;
  for (const c of segment) {
    if (c >= '0' && c <= '9') n += parseInt(c, 10);
    else n += 1;
  }
  return n;
}
