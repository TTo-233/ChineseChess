import {
  BUILTIN_ENDGAMES,
  ENDGAME_TIER_ORDER,
  getEndgameLevel,
  validateEndgameFen,
  type EndgameTier,
} from '../endgames';

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
            .slice()
            .map((row, r) => (flipRows ? grid[9 - r] : row))
            .map((row, r) =>
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

describe('BUILTIN_ENDGAMES 共 100 关', () => {
  it('关卡总数为 100', () => {
    expect(BUILTIN_ENDGAMES).toHaveLength(100);
  });

  it('id 全表唯一，且原有 30 关（id 1,2,3,31..57）保持不变', () => {
    const ids = BUILTIN_ENDGAMES.map((l) => l.id);
    expect(new Set(ids).size).toBe(100);
    // 前 30 关是原开源库数据，其 id 与顺序都不应被改动
    const originalIds = [1, 2, 3, ...Array.from({ length: 27 }, (_, i) => i + 31)];
    expect(ids.slice(0, 30)).toEqual(originalIds);
  });

  it('原库 30 关仍与原始 FEN 一致（第 1 关 钓鱼马、第 15 关 困毙）', () => {
    expect(BUILTIN_ENDGAMES[0].name).toBe('钓鱼马');
    expect(BUILTIN_ENDGAMES[0].fen).toBe('2b1ka3/4aP3/4b1N2/9/9/7R1/9/6r1B/2ppA2n1/2BAK4');
    // 原库 id 顺序为 1,2,3,31..57；下标 i>=3 对应 id 28+i，故 id=45（困毙）在下标 17
    expect(BUILTIN_ENDGAMES[17].id).toBe(45);
    expect(BUILTIN_ENDGAMES[17].name).toBe('困毙');
    expect(BUILTIN_ENDGAMES[17].fen).toBe('4ra3/4a4/1P1k3N1/9/9/9/9/9/9/4K4');
    // 原库末关（id=57 掀棋盘）仍在下标 29
    expect(BUILTIN_ENDGAMES[29].id).toBe(57);
    expect(BUILTIN_ENDGAMES[29].name).toBe('掀棋盘');
  });

  it('新增关卡编号从 58 起连续递增', () => {
    const newIds = BUILTIN_ENDGAMES.slice(30).map((l) => l.id);
    expect(newIds[0]).toBe(58);
    for (let i = 1; i < newIds.length; i++) {
      expect(newIds[i]).toBe(newIds[i - 1] + 1);
    }
  });
});

describe('分档（tier）', () => {
  it('全部 100 关的 tier 都是合法分档', () => {
    const valid = new Set<string>(ENDGAME_TIER_ORDER);
    for (const level of BUILTIN_ENDGAMES) {
      expect(valid.has(level.tier)).toBe(true);
    }
  });

  it('新增 70 关按 入门→进阶→经典→其他 分档连续排列', () => {
    const order = ENDGAME_TIER_ORDER as readonly string[];
    const tiers = BUILTIN_ENDGAMES.slice(30).map((l) => l.tier);
    const rank = (t: string) => order.indexOf(t);
    for (let i = 1; i < tiers.length; i++) {
      expect(rank(tiers[i])).toBeGreaterThanOrEqual(rank(tiers[i - 1]));
    }
  });

  it('各档都有关卡，且原库 30 关计入经典档', () => {
    for (const tier of ENDGAME_TIER_ORDER) {
      expect(BUILTIN_ENDGAMES.filter((l) => l.tier === tier).length).toBeGreaterThan(0);
    }
    expect(BUILTIN_ENDGAMES.slice(0, 30).every((l) => l.tier === '经典')).toBe(true);
    expect(BUILTIN_ENDGAMES.slice(30).filter((l) => l.tier as EndgameTier === '入门').length).toBe(16);
    expect(BUILTIN_ENDGAMES.slice(30).filter((l) => l.tier === '进阶').length).toBe(20);
    expect(BUILTIN_ENDGAMES.slice(30).filter((l) => l.tier === '经典').length).toBe(26);
    expect(BUILTIN_ENDGAMES.slice(30).filter((l) => l.tier === '其他').length).toBe(8);
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
    // 同一关自身的 8 个对称形态之间会互相命中（例如掀棋盘本身左右对称），
    // 因此必须按「关」为单位比较，而不是逐个 key 写入同一张表。
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
});

describe('getEndgameLevel', () => {
  it('按数组下标返回关卡（第 N 关 = 下标 + 1）', () => {
    expect(getEndgameLevel(0)?.id).toBe(1);
    expect(getEndgameLevel(17)?.id).toBe(45);
    expect(getEndgameLevel(29)?.id).toBe(57);
    expect(getEndgameLevel(30)?.id).toBe(58);
    expect(getEndgameLevel(99)?.id).toBe(127);
  });

  it('越界返回 null', () => {
    expect(getEndgameLevel(-1)).toBeNull();
    expect(getEndgameLevel(100)).toBeNull();
    expect(getEndgameLevel(1000)).toBeNull();
  });
});
