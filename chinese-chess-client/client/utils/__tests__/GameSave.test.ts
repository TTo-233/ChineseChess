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
  canResumeJieqi,
  saveJieqiGame,
  loadJieqiGame,
  deleteJieqiSave,
  hasJieqiSave,
  type GameSave,
  type JieqiSaveIdentity,
} from '@/utils/GameSave';

const SAVE_KEY = 'chess_game_save';
const JIEQI_SAVE_KEY = 'chess_jieqi_save';

/** 一份合法的揭棋身份表：32 格棋种 + 种子 */
function makeIdentity(overrides: Partial<JieqiSaveIdentity> = {}): JieqiSaveIdentity {
  return {
    hiddenType: Array.from({ length: 32 }, (_, i) => (i === 0 || i === 16 ? null : 'che')),
    seed: 12345,
    ...overrides,
  };
}

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

/** 构造一局揭棋的存档（variant='jieqi'），身份表默认合法 */
function makeJieqiSave(overrides: Partial<GameSave> = {}): GameSave {
  const save = makeSave(overrides);
  (save.gameState as unknown as { variant: string }).variant = 'jieqi';
  // overrides 已在 makeSave 里生效；这里只在调用方没显式给身份表时补一份合法的，
  // 否则会覆盖掉「故意打洞制造损坏档」的入参。
  if (!('jieqiIdentity' in overrides)) save.jieqiIdentity = makeIdentity();
  return save;
}

/** 直接写入原始字符串，绕过 saveGame 制造损坏档（默认写人机键） */
async function writeRaw(json: string, key: string = SAVE_KEY) {
  await AsyncStorage.setItem(key, json);
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

  /**
   * 揭棋续局（2026-10）：身份表随存档落盘。
   *
   * 这里钉的是「续局能不能还原出当初那盘棋」这条契约：
   * 身份表写进去要能原样读回，坏的要被闸门挡住（而不是读出一盘身份全丢的假棋局）。
   */
  describe('揭棋身份表随存档落盘（揭棋专用键）', () => {
    it('身份表写入后能原样读回（含棋种与种子）', async () => {
      const hiddenType = Array.from({ length: 32 }, (_, i) => {
        if (i === 0 || i === 16) return null; // 将帅位无暗子
        return (['che', 'ma', 'pao', 'shi', 'xiang', 'zu', 'bing'] as const)[i % 7];
      });
      const identity = makeIdentity({ hiddenType, seed: 987654 });
      await saveJieqiGame(makeJieqiSave({ jieqiIdentity: identity, moveCount: 8 }));

      const loaded = await loadJieqiGame();
      expect(loaded).not.toBeNull();
      expect(loaded!.jieqiIdentity).toEqual(identity);
      expect(loaded!.jieqiIdentity!.hiddenType).toHaveLength(32);
      // 将帅位（0 / 16）无暗子，其余按 i % 7 轮转
      expect(loaded!.jieqiIdentity!.hiddenType[0]).toBeNull();
      expect(loaded!.jieqiIdentity!.hiddenType[16]).toBeNull();
      expect(loaded!.jieqiIdentity!.hiddenType[1]).toBe('ma');
      expect(loaded!.jieqiIdentity!.seed).toBe(987654);
    });

    it('存档落在揭棋专用键上，不写人机键', async () => {
      await saveJieqiGame(makeJieqiSave());
      await expect(AsyncStorage.getItem(JIEQI_SAVE_KEY)).resolves.toBeTruthy();
      await expect(AsyncStorage.getItem(SAVE_KEY)).resolves.toBeNull();
    });

    it('象棋存档不带身份表（字段为 undefined）', async () => {
      await saveGame(makeSave());
      const loaded = await loadGame();
      expect(loaded!.jieqiIdentity).toBeUndefined();
    });

    it.each([
      ['长度不是 32', makeIdentity({ hiddenType: new Array(31).fill('che') as never })],
      ['含非法棋种', makeIdentity({ hiddenType: Array.from({ length: 32 }, () => 'nope') as never })],
      ['seed 非数字', makeIdentity({ seed: 'x' as never })],
      ['不是对象', 'not-an-object' as never],
    ])('身份表损坏（%s）时整档判为损坏并清除', async (_label, identity) => {
      const bad = makeJieqiSave({ jieqiIdentity: identity });
      await writeRaw(JSON.stringify(bad), JIEQI_SAVE_KEY);
      await expect(loadJieqiGame()).resolves.toBeNull();
      // 坏档必须被清掉：留在存储里会让每次进对局页都反复读到它
      await expect(AsyncStorage.getItem(JIEQI_SAVE_KEY)).resolves.toBeNull();
    });

    it('身份表整项缺失不判为损坏（旧版揭棋档仍可读出，只是不可续）', async () => {
      // 2026-10 之前存的揭棋局没有本字段。那种档结构仍合法，
      // 应当能 load 出来（调用方据 canResumeJieqi 决定续不续），而不是被清掉。
      const legacy = makeJieqiSave();
      delete legacy.jieqiIdentity;
      await writeRaw(JSON.stringify(legacy), JIEQI_SAVE_KEY);
      const loaded = await loadJieqiGame();
      expect(loaded).not.toBeNull();
      expect(loaded!.jieqiIdentity).toBeUndefined();
    });
  });

  /**
   * 两个玩法各占一个键：存/删一边绝不能动到另一边。
   * 这正是拆键的目的——此前共用一个键时，在象棋里存一局就把揭棋那局冲掉了。
   */
  describe('揭棋键与人机键互不干扰', () => {
    it('两边同时各存一局，互不被覆盖', async () => {
      await saveGame(makeSave({ moveCount: 3 }));
      await saveJieqiGame(makeJieqiSave({ moveCount: 7 }));

      const xiangqi = await loadGame();
      const jieqi = await loadJieqiGame();
      expect(xiangqi!.moveCount).toBe(3);
      expect(jieqi!.moveCount).toBe(7);
    });

    it('在象棋里存一局不会清掉揭棋档', async () => {
      await saveJieqiGame(makeJieqiSave());
      await saveGame(makeSave());
      // 关键：揭棋档仍在（旧版共用键时这一句会失败）
      await expect(loadJieqiGame()).resolves.not.toBeNull();
    });

    it('在揭棋里存一局不会清掉象棋档', async () => {
      await saveGame(makeSave());
      await saveJieqiGame(makeJieqiSave());
      await expect(loadGame()).resolves.not.toBeNull();
    });

    it('删揭棋档不动象棋档', async () => {
      await saveGame(makeSave({ moveCount: 5 }));
      await saveJieqiGame(makeJieqiSave());
      await deleteJieqiSave();
      await expect(loadJieqiGame()).resolves.toBeNull();
      await expect(loadGame()).resolves.not.toBeNull();
    });

    it('删象棋档不动揭棋档', async () => {
      await saveGame(makeSave());
      await saveJieqiGame(makeJieqiSave({ moveCount: 9 }));
      await deleteSave();
      await expect(loadGame()).resolves.toBeNull();
      expect((await loadJieqiGame())!.moveCount).toBe(9);
    });

    it('hasSave 只看人机键，hasJieqiSave 只看揭棋键', async () => {
      await expect(hasSave()).resolves.toBe(false);
      await expect(hasJieqiSave()).resolves.toBe(false);

      await saveJieqiGame(makeJieqiSave());
      // 揭棋档不该让首页/人机设置页显示"有未完成的棋局"
      await expect(hasSave()).resolves.toBe(false);
      await expect(hasJieqiSave()).resolves.toBe(true);

      await saveGame(makeSave());
      await expect(hasSave()).resolves.toBe(true);
    });

    it('揭棋档坏了只清揭棋键，人机档不受牵连', async () => {
      await saveGame(makeSave({ moveCount: 4 }));
      const broken = makeJieqiSave({ jieqiIdentity: 'garbage' as never });
      await writeRaw(JSON.stringify(broken), JIEQI_SAVE_KEY);

      await expect(loadJieqiGame()).resolves.toBeNull();
      await expect(AsyncStorage.getItem(JIEQI_SAVE_KEY)).resolves.toBeNull();
      // 读揭棋档失败不该连坐清掉人机档
      await expect(AsyncStorage.getItem(SAVE_KEY)).resolves.toBeTruthy();
      expect((await loadGame())!.moveCount).toBe(4);
    });
  });

  describe('canResumeJieqi（能否作为揭棋续局载入）', () => {
    it('揭棋 + 身份表齐全 → 可续', () => {
      expect(canResumeJieqi(makeJieqiSave())).toBe(true);
    });

    it('揭棋但缺身份表（旧档）→ 不可续', () => {
      const legacy = makeJieqiSave();
      delete legacy.jieqiIdentity;
      expect(canResumeJieqi(legacy)).toBe(false);
    });

    it('象棋档 → 不可续（即便带了身份表也不能当揭棋续）', () => {
      // 人机对战与揭棋共用存档键：象棋档绝不能被揭棋设置页当成可续局。
      const xiangqi = makeSave({ jieqiIdentity: makeIdentity() });
      expect(canResumeJieqi(xiangqi)).toBe(false);
    });
  });
});