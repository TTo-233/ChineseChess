import {
  BUILTIN_ENDGAMES,
  ENDGAME_TIER_ORDER,
  getEndgameLevel,
  validateEndgameFen,
} from '../endgames';
import { createFromFen, cloneGameState, getValidMoves, makeMove, getWinnerSideTag } from '../GameEngine';
import { RED_SIDE } from '../types';

/** 8 个二面体对称（上下/左右翻转 + 换边），用于「镜像也算重复」的查重 */
function symmetryKeys(fen: string): string[] {
  const board = fen.trim().split(/\s+/)[0].split('/');
  const expand = (row: string) =>
    row.split('').flatMap((ch) => (ch >= '1' && ch <= '9' ? Array(Number(ch)).fill('.') : [ch])).join('');
  const grid = board.map(expand);
  const swap = (ch: string) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase());
  const out: string[] = [];
  for (const flipRows of [false, true]) {
    for (const flipCols of [false, true]) {
      for (const flipSides of [false, true]) {
        out.push(
          grid
            .map((row, r) => (flipRows ? grid[9 - r] : row))
            .map((row) =>
              row
                .split('')
                .map((ch, c) => {
                  const cell = flipCols ? row[8 - c] : ch;
                  return flipSides ? swap(cell) : cell;
                })
                .join('')
            )
            .join('/')
            .replace(/\.+/g, (m) => String(m.length))
        );
      }
    }
  }
  return out;
}

/**
 * 「子力签名」：两枚残局若**棋子种类和个数完全一致**（区分阵营），只摆法不同，
 * 玩家的解法体验高度重合，按「重复关卡」处理，必须在全库唯一。
 *
 * 例：原第 7「车封将门」与第 8「单车闷毙」同为「红帅+单车 / 黑将+双士」，
 * 只是车摆的位置不同；这类关卡会成组扎堆（原库一次留下 17 组、64 关）。
 */
function materialSignature(fen: string, colorBlind = false): string {
  const board = fen.trim().split(/\s+/)[0].split('/');
  const counts: Record<string, number> = {};
  for (const row of board) {
    for (const ch of row) {
      if (ch >= '1' && ch <= '9') continue;
      // colorBlind：红黑同种棋子（如红车与黑车）视为同一种，用于更严的查重口径
      const key = colorBlind ? ch.toLowerCase() : ch;
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return Object.keys(counts)
    .sort()
    .map((k) => `${k}x${counts[k]}`)
    .join(' ');
}

/** 查重：签名相同即为重复，返回冲突描述 */
function findDuplicateBySignature(colorBlind: boolean): string[] {
  const owner = new Map<string, number>();
  const dups: string[] = [];
  BUILTIN_ENDGAMES.forEach((level, i) => {
    const sig = materialSignature(level.fen, colorBlind);
    const prev = owner.get(sig);
    if (prev !== undefined) {
      const a = BUILTIN_ENDGAMES[prev];
      dups.push(`第${i + 1}关 ${level.name} 与 第${prev + 1}关 ${a.name} 子力相同（${sig}）`);
    } else {
      owner.set(sig, i);
    }
  });
  return dups;
}

describe('BUILTIN_ENDGAMES 共 100 关', () => {
  it('关卡总数为 100', () => {
    expect(BUILTIN_ENDGAMES).toHaveLength(100);
  });

  it('id 全表唯一', () => {
    const ids = BUILTIN_ENDGAMES.map((l) => l.id);
    expect(new Set(ids).size).toBe(100);
  });

  it('id 与闯关序号不再对应，进度须按数组下标存', () => {
    expect(BUILTIN_ENDGAMES.map((l) => l.id)).not.toEqual(BUILTIN_ENDGAMES.map((_, i) => i + 1));
  });
});

describe('难度排序与分档', () => {
  it('四档各 25 关，且按 入门→进阶→经典→其他 连续排成四段', () => {
    const order = ENDGAME_TIER_ORDER as readonly string[];
    expect(BUILTIN_ENDGAMES.map((l) => l.tier)).toEqual(order.flatMap((t) => Array(25).fill(t)));
  });

  it('全部 100 关的 tier 都是合法分档', () => {
    const valid = new Set<string>(ENDGAME_TIER_ORDER);
    for (const level of BUILTIN_ENDGAMES) {
      expect(valid.has(level.tier)).toBe(true);
    }
  });

  it('各档关数均为 25', () => {
    for (const tier of ENDGAME_TIER_ORDER) {
      expect(BUILTIN_ENDGAMES.filter((l) => l.tier === tier)).toHaveLength(25);
    }
  });

  it('分档边界：入门档以一步杀开篇，其他档以最难残局收尾', () => {
    expect(BUILTIN_ENDGAMES[0].name).toBe('单车直取');
    expect(BUILTIN_ENDGAMES[99].name).toBe('侧面虎(高钓马)');
  });

  it('各档边界与编号：入门档开篇是最简残局，其他档收尾是最难残局', () => {
    // id 为本仓库自增编号（2001 = 第 1 关），与闯关序号不对应；排序只看数组下标。
    expect(BUILTIN_ENDGAMES[0].id).toBe(2001);
    expect(BUILTIN_ENDGAMES[99].id).toBe(2100);
    // 第 1 关是全库子力最少的之一（帅+车 vs 孤将，一步杀）；第 100 关是公认最难的「侧面虎(高钓马)」
    const pieces = (fen: string) => fen.split(' ')[0].split('/').join('').replace(/[^a-z]/gi, '').length;
    const easiest = Math.min(...BUILTIN_ENDGAMES.map((l) => pieces(l.fen)));
    expect(pieces(BUILTIN_ENDGAMES[0].fen)).toBe(easiest);
  });
});

describe('关卡内容', () => {
  it('所有 100 关的 FEN 都通过 validateEndgameFen', () => {
    const bad = BUILTIN_ENDGAMES.map((l, i) => `${i + 1} ${l.name}: ${validateEndgameFen(l.fen)}`).filter(
      (s) => !s.endsWith('null')
    );
    expect(bad).toEqual([]);
  });

  it('关名与解说均非空', () => {
    for (const level of BUILTIN_ENDGAMES) {
      expect(level.name.trim().length).toBeGreaterThan(0);
      expect(level.comment.trim().length).toBeGreaterThan(0);
    }
  });

  it('关名全表唯一', () => {
    const names = BUILTIN_ENDGAMES.map((l) => l.name);
    expect(new Set(names).size).toBe(100);
  });

  it('100 关互不重复，且镜像/换边后也不重复', () => {
    // 同一关自身的 8 个对称形态之间会互相命中，因此按「关」为单位比较
    const keysOf = new Map<number, Set<string>>();
    BUILTIN_ENDGAMES.forEach((level, i) => keysOf.set(i, new Set(symmetryKeys(level.fen))));

    const owner = new Map<string, number>();
    const dups: string[] = [];
    BUILTIN_ENDGAMES.forEach((level, i) => {
      for (const key of keysOf.get(i)!) {
        const prev = owner.get(key);
        if (prev !== undefined) dups.push(`${level.name}(第${i + 1}关) 与 ${BUILTIN_ENDGAMES[prev].name}(第${prev + 1}关) 对称重复`);
        else owner.set(key, i);
      }
    });
    expect(dups).toEqual([]);
  });

  it('已剔除的「掀棋盘」不再出现（它红方全部着法都立刻判和，无法通关）', () => {
    expect(BUILTIN_ENDGAMES.some((l) => l.name === '掀棋盘')).toBe(false);
  });
});

describe('子力查重（同类问题的回归闸门）', () => {
  it('子力签名（区分阵营）全库唯一：不得有「棋子种类和个数一致、只是摆法不同」的关卡', () => {
    // 历史问题：第 7「车封将门」与第 8「单车闷毙」同为「红帅+单车 / 黑将+双士」，
    // 全库一度有 17 组这样的「同子力不同摆法」关卡（共 64 关）。这里逐组钉死。
    expect(findDuplicateBySignature(false)).toEqual([]);
  });

  it('子力签名（忽略阵营，红黑同种棋子等价）同样全库唯一', () => {
    // 更严一档的口径：红车与黑车视为同一种子。用于防止「换边重摆」型重复。
    expect(findDuplicateBySignature(true)).toEqual([]);
  });

  it('签名口径确实能抓住已知的同子力样例（防止断言自身失效）', () => {
    // 两个真实存在过的重复样例：车封将门 / 单车闷毙
    const a = materialSignature('5a3/2R6/3k1a3/9/9/9/9/9/4K4/9');
    const b = materialSignature('9/R3ak3/5a3/9/9/9/9/9/4K4/9');
    expect(a).toBe(b);
    // 签名只认「棋子种类 + 个数」，与摆法无关：同一批棋子的不同摆法签名必然相同
    expect(materialSignature('3k5/9/9/9/2P6/9/9/9/4K4/9')).toBe(
      materialSignature('3k5/9/2P6/9/9/9/9/9/9/4K4')
    );
    // 子力真的不同，签名才不同
    expect(materialSignature('3k5/9/9/9/2P6/9/9/9/4K4/9')).not.toBe(
      materialSignature('3k5/9/9/9/2N6/9/9/9/4K4/9')
    );
  });
});

describe('每关都真的可赢（防坏关卡回归）', () => {
  it('不存在「红方全部合法着法都立刻终局且红不赢」的关卡', () => {
    // 原「掀棋盘」正是这类：8 个着法全部 no_attacking 判和，玩家无论如何都过不了。
    // 对全库做同款枚举，防止再混入无解残局。
    const broken: string[] = [];
    BUILTIN_ENDGAMES.forEach((level, i) => {
      const state = createFromFen(level.fen.trim());
      const probe = cloneGameState(state);
      probe.sideTag = RED_SIDE;
      let moves = 0;
      let alive = 0;
      let winNow = 0;
      for (let c = 0; c < 9; c++) {
        for (let r = 0; r < 10; r++) {
          const id = probe.qiPan[c][r];
          if (id < 0 || id < 16) continue;
          const movesGrid = getValidMoves(probe, id);
          for (let tc = 0; tc < 9; tc++) {
            for (let tr = 0; tr < 10; tr++) {
              if (!movesGrid[tc][tr]) continue;
              moves++;
              const res = makeMove(state, id, tc, tr);
              if (getWinnerSideTag(res.newState) === RED_SIDE) winNow++;
              else if (!res.isGameOver) alive++;
            }
          }
        }
      }
      if (moves > 0 && alive === 0 && winNow === 0) broken.push(`第${i + 1}关 ${level.name}`);
    });
    expect(broken).toEqual([]);
  });
});

describe('getEndgameLevel', () => {
  it('按数组下标返回关卡（第 N 关 = 下标 + 1）', () => {
    expect(getEndgameLevel(0)?.name).toBe('单车直取');
    expect(getEndgameLevel(99)?.name).toBe('侧面虎(高钓马)');
  });

  it('越界返回 null', () => {
    expect(getEndgameLevel(-1)).toBeNull();
    expect(getEndgameLevel(100)).toBeNull();
    expect(getEndgameLevel(1000)).toBeNull();
  });
});
