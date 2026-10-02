/**
 * @/utils/GameSave —— 人机对局存档（第 3 批 / §2.1 补测试）
 *
 * 这里最该被钉住的是 `isValidGameSave`：它是「历史版本/损坏的存档」与
 * 崩溃之间唯一的闸门。存档是用户自己写坏也能写坏的输入（迁移、降级、
 * 半截写入），闸门一旦放过一个残缺结构，加载页就会在 `pieces[i].col` 上炸掉。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
      setItem: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => {
        store.delete(key);
      }),
      clear: jest.fn(async () => {
        store.clear();
      }),
    },
  };
});

import {
  deleteSave,
  hasSave,
  loadGame,
  resolveFirstMover,
  saveGame,
  type GameSave,
} from '@/utils/GameSave';

const SAVE_KEY = 'chess_game_save';

/** 构造一个结构完整的存档，可按需打洞制造损坏档 */
function makeSave(overrides: Partial<GameSave> = {}): GameSave {
  return {
    gameState: {
      pieces: Array.from({ length: 32 }, (_, i) => ({
        id: i,
        col: i % 9,
        row: Math.floor(i / 9),
        alive: i < 30,
      })),
      sideTag: true,
      moveHistory: [],
      gameStatus: 'playing',
    } as unknown as GameSave['gameState'],
    difficulty: 'medium',
    playerSide: 'red',
    firstMover: 'player',
    moveCount: 0,
    capturedRed: 0,
    capturedBlack: 0,
    lastMove: null,
    isFlipped: false,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

/** 直接写入原始字符串，绕过 saveGame 制造损坏档 */
async function writeRaw(json: string) {
  await AsyncStorage.setItem(SAVE_KEY, json);
}

describe('GameSave', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('saveGame / loadGame 往返', () => {
    it('完整存档写入后能原样读回', async () => {
      const save = makeSave({ moveCount: 12, capturedRed: 2, isFlipped: true });
      await saveGame(save);
      const loaded = await loadGame();
      expect(loaded).not.toBeNull();
      expect(loaded!.moveCount).toBe(12);
      expect(loaded!.capturedRed).toBe(2);
      expect(loaded!.isFlipped).toBe(true);
      expect(loaded!.playerSide).toBe('red');
      expect(loaded!.gameState.pieces).toHaveLength(32);
    });

    it('没有任何存档时返回 null', async () => {
      await expect(loadGame()).resolves.toBeNull();
    });

    it('hasSave 反映存档是否存在', async () => {
      await expect(hasSave()).resolves.toBe(false);
      await saveGame(makeSave());
      await expect(hasSave()).resolves.toBe(true);
      await deleteSave();
      await expect(hasSave()).resolves.toBe(false);
    });

    it('deleteSave 之后再 load 为 null', async () => {
      await saveGame(makeSave());
      await deleteSave();
      await expect(loadGame()).resolves.toBeNull();
    });

    it('存档写入失败时不抛错（存不下也不能让退出流程崩掉）', async () => {
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('quota'));
      await expect(saveGame(makeSave())).resolves.toBeUndefined();
    });

    it('读取抛错时返回 null 而不是让退出流程崩掉', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('io'));
      await expect(loadGame()).resolves.toBeNull();
    });

    it('删除抛错时静默吞掉', async () => {
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('io'));
      await expect(deleteSave()).resolves.toBeUndefined();
    });
  });

  describe('损坏存档的闸门（isValidGameSave）', () => {
    it('非 JSON 文本被丢弃（不抛错），但坏档不会被自动清除', async () => {
      // 与"结构不完整"分开断言：JSON.parse 抛错会直接进 catch 分支，
      // 那条分支只返回 null、不清存储——这是既有行为，此处钉住避免被误改。
      await writeRaw('{ 坏掉的 json');
      await expect(loadGame()).resolves.toBeNull();
      await expect(AsyncStorage.getItem(SAVE_KEY)).resolves.toBe('{ 坏掉的 json');
    });

    it('结构不完整（JSON 合法但字段缺失）的坏档会被清除', async () => {
      const bad = makeSave() as unknown as Record<string, unknown>;
      delete bad.gameState;
      await writeRaw(JSON.stringify(bad));
      await expect(loadGame()).resolves.toBeNull();
      await expect(AsyncStorage.getItem(SAVE_KEY)).resolves.toBeNull();
    });

    it.each([
      ['null', () => 'null'],
      ['数组', () => '[]'],
      ['字符串', () => '"hello"'],
      ['数字', () => '42'],
    ])('顶层是 %s 时判为损坏', async (_label, makeRaw) => {
      await writeRaw(makeRaw());
      await expect(loadGame()).resolves.toBeNull();
    });

    it('缺 gameState 判为损坏', async () => {
      const bad = makeSave() as unknown as Record<string, unknown>;
      delete bad.gameState;
      await writeRaw(JSON.stringify(bad));
      await expect(loadGame()).resolves.toBeNull();
    });

    it('棋子数组长度不是 32 判为损坏', async () => {
      const bad = makeSave();
      (bad.gameState as unknown as { pieces: unknown[] }).pieces =
        bad.gameState.pieces.slice(0, 31);
      await writeRaw(JSON.stringify(bad));
      await expect(loadGame()).resolves.toBeNull();
    });

    it.each([
      ['id 非数字', { id: 'x' }],
      ['col 非数字', { col: null }],
      ['row 非数字', { row: {} }],
      ['alive 非布尔', { alive: 1 }],
    ])('棋子字段损坏（%s）判为损坏', async (_label, patch) => {
      const bad = makeSave();
      const pieces = (bad.gameState as unknown as { pieces: Record<string, unknown>[] }).pieces;
      pieces[7] = { ...pieces[7], ...patch };
      await writeRaw(JSON.stringify(bad));
      await expect(loadGame()).resolves.toBeNull();
    });

    it('棋子项为 null 判为损坏', async () => {
      const bad = makeSave();
      const pieces = (bad.gameState as unknown as { pieces: unknown[] }).pieces;
      pieces[0] = null;
      await writeRaw(JSON.stringify(bad));
      await expect(loadGame()).resolves.toBeNull();
    });

    it('sideTag 非布尔判为损坏', async () => {
      const bad = makeSave();
      (bad.gameState as unknown as { sideTag: unknown }).sideTag = 'red';
      await writeRaw(JSON.stringify(bad));
      await expect(loadGame()).resolves.toBeNull();
    });

    it('moveHistory 非数组判为损坏', async () => {
      const bad = makeSave();
      (bad.gameState as unknown as { moveHistory: unknown }).moveHistory = { length: 0 };
      await writeRaw(JSON.stringify(bad));
      await expect(loadGame()).resolves.toBeNull();
    });

    it('playerSide 为非法枚举值时判为损坏', async () => {
      const bad = makeSave();
      (bad as unknown as { playerSide: unknown }).playerSide = 'blue';
      await writeRaw(JSON.stringify(bad));
      await expect(loadGame()).resolves.toBeNull();
    });

    it('playerSide 缺失时判为损坏', async () => {
      const bad = makeSave();
      delete (bad as unknown as { playerSide?: unknown }).playerSide;
      await writeRaw(JSON.stringify(bad));
      await expect(loadGame()).resolves.toBeNull();
    });

    it('闸门只校验最小必需字段：缺失的可选字段不影响加载', async () => {
      // 旧版存档没有 firstMover / timestamp / lastMove / isFlipped，
      // 这些都不是运行时必需（先后手走 resolveFirstMover 兜底），不该被清掉。
      const legacy = {
        gameState: {
          pieces: Array.from({ length: 32 }, (_, i) => ({
            id: i,
            col: i % 9,
            row: Math.floor(i / 9),
            alive: true,
          })),
          sideTag: true,
          moveHistory: [],
          gameStatus: 'playing',
        },
        difficulty: 'easy',
        playerSide: 'red',
        moveCount: 4,
        capturedRed: 0,
        capturedBlack: 1,
      };
      await writeRaw(JSON.stringify(legacy));
      const loaded = await loadGame();
      expect(loaded).not.toBeNull();
      expect(loaded!.moveCount).toBe(4);
      expect(loaded!.firstMover).toBeUndefined();
    });
  });

  describe('resolveFirstMover（旧存档兼容）', () => {
    it('新存档直接用显式字段', () => {
      expect(resolveFirstMover(makeSave({ firstMover: 'ai' }))).toBe('ai');
      expect(resolveFirstMover(makeSave({ firstMover: 'player' }))).toBe('player');
    });

    it('旧存档无字段：红方=玩家先手', () => {
      const legacy = makeSave();
      (legacy as unknown as { firstMover?: string }).firstMover = undefined;
      expect(resolveFirstMover(legacy)).toBe('player');
    });

    it('旧存档无字段：黑方=AI 先手', () => {
      const legacy = makeSave({ playerSide: 'black' });
      (legacy as unknown as { firstMover?: string }).firstMover = undefined;
      expect(resolveFirstMover(legacy)).toBe('ai');
    });

    it('字段是其它值时也退回旧规则（而不是透传坏值）', () => {
      const bad = makeSave({ playerSide: 'black' });
      (bad as unknown as { firstMover: unknown }).firstMover = 'whatever';
      expect(resolveFirstMover(bad)).toBe('ai');
    });
  });
});