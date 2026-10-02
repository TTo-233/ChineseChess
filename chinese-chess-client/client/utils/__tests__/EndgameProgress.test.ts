/**
 * @/utils/EndgameProgress —— 残局闯关进度 / 局内存档 / 自定义残局（第 3 批 / §2.1 补测试）
 *
 * 三块存储各自有一处"会被下次读到"的逻辑，所以重点不是 IO 往返，而是：
 *   - 解锁只能顺序推进（不能跳关），且不越界（最后一关不再解锁不存在的关）；
 *   - 皇冠评级取**历史最少**提示次数（重打一次不该把金冠刷成铜冠）；
 *   - 删自定义残局必须同步清掉它的评级记录（否则数据里留死引用）；
 *   - 损坏的局内存档要挡住（棋子数组不合法会让对局页崩）。
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
  addCustomEndgame,
  builtinLevelToLaunch,
  consumePendingFocusCustomTab,
  deleteCustomEndgame,
  deleteEndgameBattle,
  getCrownTier,
  getCustomCrownTier,
  isLevelUnlocked,
  loadCustomEndgames,
  loadEndgameBattle,
  loadProgress,
  markCustomCompleted,
  markLevelCompleted,
  markPendingFocusCustomTab,
  saveEndgameBattle,
  updateCustomEndgame,
  type EndgameBattleSave,
  type EndgameProgressData,
} from '@/utils/EndgameProgress';
import { BUILTIN_ENDGAMES } from '@/utils/chess/endgames';

const PROGRESS_KEY = 'endgame_progress';
const SAVE_KEY = 'endgame_battle_save';
const CUSTOM_KEY = 'endgame_custom_levels';

function makeBattleSave(overrides: Partial<EndgameBattleSave> = {}): EndgameBattleSave {
  return {
    levelIndex: 0,
    customId: '',
    name: '测试关',
    fen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w',
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
    } as unknown as EndgameBattleSave['gameState'],
    moveCount: 3,
    capturedRed: 1,
    capturedBlack: 0,
    lastMove: null,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe('EndgameProgress', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // 消费掉上一个用例可能留下的聚焦标记，保证标记用例从干净状态开始
    consumePendingFocusCustomTab();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('loadProgress', () => {
    it('无记录时返回初始进度（仅第 1 关可玩）', async () => {
      await expect(loadProgress()).resolves.toEqual({
        highestUnlocked: 0,
        completed: [],
        bestUndoUsed: {},
        customBestUndoUsed: {},
      });
    });

    it('旧版记录缺评级字段时补空对象', async () => {
      await AsyncStorage.setItem(
        PROGRESS_KEY,
        JSON.stringify({ highestUnlocked: 3, completed: [0, 1, 2] })
      );
      const progress = await loadProgress();
      expect(progress.highestUnlocked).toBe(3);
      expect(progress.bestUndoUsed).toEqual({});
      expect(progress.customBestUndoUsed).toEqual({});
    });

    it('JSON 损坏时退回初始进度', async () => {
      await AsyncStorage.setItem(PROGRESS_KEY, '{oops');
      await expect(loadProgress()).resolves.toMatchObject({ highestUnlocked: 0, completed: [] });
    });

    it('字段类型不对（highestUnlocked 非数字）时退回初始进度', async () => {
      await AsyncStorage.setItem(
        PROGRESS_KEY,
        JSON.stringify({ highestUnlocked: '3', completed: [] })
      );
      await expect(loadProgress()).resolves.toMatchObject({ highestUnlocked: 0 });
    });
  });

  describe('markLevelCompleted（顺序解锁）', () => {
    it('首次通过第 1 关后解锁第 2 关', async () => {
      const progress = await markLevelCompleted(0);
      expect(progress.completed).toContain(0);
      expect(progress.highestUnlocked).toBe(1);
      expect(isLevelUnlocked(0, progress)).toBe(true);
      expect(isLevelUnlocked(1, progress)).toBe(true);
      expect(isLevelUnlocked(2, progress)).toBe(false);
    });

    it('重复通过同一关不会重复记录，也不会回退解锁进度', async () => {
      await markLevelCompleted(0);
      await markLevelCompleted(0);
      const progress = await loadProgress();
      expect(progress.completed.filter((n) => n === 0)).toHaveLength(1);
      expect(progress.highestUnlocked).toBe(1);
    });

    it('标第 5 关通过会把已解锁最高关推到第 6 关（inclusive 上界）', async () => {
      // 口径说明：highestUnlocked 是"已解锁最高关"，isLevelUnlocked 用的是 <=，
      // 所以标第 N 关通过后第 0..N+1 关都可玩（防止"通关后新关卡打不开"）。
      // 这里钉住的是这个 inclusive 契约本身，而不是假设它排他。
      const progress = await markLevelCompleted(4);
      expect(progress.completed).toContain(4);
      expect(progress.highestUnlocked).toBe(5);
      expect(isLevelUnlocked(4, progress)).toBe(true);
      expect(isLevelUnlocked(5, progress)).toBe(true);
      expect(isLevelUnlocked(6, progress)).toBe(false);
    });

    it('未通过的关仍不可玩（最高关之上不可玩）', async () => {
      const progress = await markLevelCompleted(0);
      expect(isLevelUnlocked(0, progress)).toBe(true);
      expect(isLevelUnlocked(1, progress)).toBe(true);
      expect(isLevelUnlocked(2, progress)).toBe(false);
    });

    it('解锁进度只增不减（重打前面的关不会退关）', async () => {
      await markLevelCompleted(3);
      const progress = await markLevelCompleted(0);
      expect(progress.highestUnlocked).toBeGreaterThanOrEqual(4);
    });

    it(`最后一关通过后不再解锁不存在的第 ${BUILTIN_ENDGAMES.length} 关`, async () => {
      const last = BUILTIN_ENDGAMES.length - 1;
      const progress = await markLevelCompleted(last);
      expect(progress.completed).toContain(last);
      expect(progress.highestUnlocked).toBeLessThan(BUILTIN_ENDGAMES.length);
    });

    it('进度落盘后能被新一次读取拿到', async () => {
      await markLevelCompleted(1, 2);
      const progress = await loadProgress();
      expect(progress.completed).toContain(1);
      expect(progress.bestUndoUsed['1']).toBe(2);
    });
  });

  describe('皇冠评级（提示次数取历史最少）', () => {
    it('未通过的关返回 null', async () => {
      const progress = await loadProgress();
      expect(getCrownTier(progress, 0)).toBeNull();
    });

    it.each([
      [0, 'gold'],
      [1, 'silver'],
      [2, 'bronze'],
      [7, 'bronze'],
    ])('%s 次提示 → %s', async (used, expected) => {
      const progress: EndgameProgressData = {
        highestUnlocked: 0,
        completed: [0],
        bestUndoUsed: { '0': used },
        customBestUndoUsed: {},
      };
      expect(getCrownTier(progress, 0)).toBe(expected);
    });

    it('旧版无评级记录的已通关按铜冠', () => {
      const progress: EndgameProgressData = {
        highestUnlocked: 0,
        completed: [0],
        bestUndoUsed: {},
        customBestUndoUsed: {},
      };
      expect(getCrownTier(progress, 0)).toBe('bronze');
    });

    it('重打一次用了更多提示不会把金冠刷掉', async () => {
      await markLevelCompleted(0, 0); // 金冠
      const progress = await markLevelCompleted(0, 3); // 重打用了 3 次
      expect(progress.bestUndoUsed['0']).toBe(0);
      expect(getCrownTier(progress, 0)).toBe('gold');
    });

    it('重打一次用了更少提示会把铜冠刷成金冠', async () => {
      await markLevelCompleted(0, 3);
      const progress = await markLevelCompleted(0, 0);
      expect(progress.bestUndoUsed['0']).toBe(0);
      expect(getCrownTier(progress, 0)).toBe('gold');
    });

    it('不传 hintUsed 时不动已有评级', async () => {
      await markLevelCompleted(0, 1);
      const progress = await markLevelCompleted(0);
      expect(progress.bestUndoUsed['0']).toBe(1);
    });
  });

  describe('自定义残局评级', () => {
    it('未通关返回 null', async () => {
      const progress = await loadProgress();
      expect(getCustomCrownTier(progress, 'custom_1')).toBeNull();
    });

    it.each([
      [0, 'gold'],
      [1, 'silver'],
      [5, 'bronze'],
    ])('%s 次提示 → %s', async (used, expected) => {
      const progress = await markCustomCompleted('custom_1', used);
      expect(getCustomCrownTier(progress, 'custom_1')).toBe(expected);
    });

    it('取历史最少提示次数', async () => {
      await markCustomCompleted('custom_1', 2);
      const progress = await markCustomCompleted('custom_1', 0);
      expect(getCustomCrownTier(progress, 'custom_1')).toBe('gold');
    });

    it('自定义评级不影响内置关解锁进度', async () => {
      const progress = await markCustomCompleted('custom_1', 0);
      expect(progress.highestUnlocked).toBe(0);
      expect(progress.completed).toEqual([]);
    });
  });

  describe('残局局内存档', () => {
    it('存档写入后能读回', async () => {
      await saveEndgameBattle(makeBattleSave({ levelIndex: 2, moveCount: 9 }));
      const loaded = await loadEndgameBattle();
      expect(loaded).not.toBeNull();
      expect(loaded!.levelIndex).toBe(2);
      expect(loaded!.moveCount).toBe(9);
    });

    it('没有存档时返回 null', async () => {
      await expect(loadEndgameBattle()).resolves.toBeNull();
    });

    it('deleteEndgameBattle 后读回 null', async () => {
      await saveEndgameBattle(makeBattleSave());
      await deleteEndgameBattle();
      await expect(loadEndgameBattle()).resolves.toBeNull();
    });

    it('关卡下标越界（内置关不存在）判为无效但保留存档', async () => {
      await saveEndgameBattle(makeBattleSave({ levelIndex: BUILTIN_ENDGAMES.length + 5 }));
      await expect(loadEndgameBattle()).resolves.toBeNull();
      await expect(AsyncStorage.getItem(SAVE_KEY)).resolves.not.toBeNull();
    });

    it('自定义关（levelIndex=-1）不走内置关校验', async () => {
      await saveEndgameBattle(makeBattleSave({ levelIndex: -1, customId: 'custom_9' }));
      const loaded = await loadEndgameBattle();
      expect(loaded).not.toBeNull();
      expect(loaded!.customId).toBe('custom_9');
    });

    it('局面棋子数组不合法时清除坏档并返回 null', async () => {
      const bad = makeBattleSave();
      (bad.gameState as unknown as { pieces: unknown[] }).pieces = [];
      await saveEndgameBattle(bad);
      await expect(loadEndgameBattle()).resolves.toBeNull();
      await expect(AsyncStorage.getItem(SAVE_KEY)).resolves.toBeNull();
    });

    it('缺 gameState 时返回 null', async () => {
      const bad = makeBattleSave() as unknown as Record<string, unknown>;
      delete bad.gameState;
      await AsyncStorage.setItem(SAVE_KEY, JSON.stringify(bad));
      await expect(loadEndgameBattle()).resolves.toBeNull();
    });

    it('JSON 损坏时返回 null 且不抛', async () => {
      await AsyncStorage.setItem(SAVE_KEY, 'not json');
      await expect(loadEndgameBattle()).resolves.toBeNull();
    });

    it('写入失败时静默吞掉（不打断退出流程）', async () => {
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('quota'));
      await expect(saveEndgameBattle(makeBattleSave())).resolves.toBeUndefined();
    });
  });

  describe('自定义残局列表', () => {
    it('初始为空', async () => {
      await expect(loadCustomEndgames()).resolves.toEqual([]);
    });

    it('新增会生成 id 与 createdAt 并落盘', async () => {
      const entry = await addCustomEndgame({
        name: '我的残局',
        comment: '练习',
        fen: BUILTIN_ENDGAMES[0].fen,
      });
      expect(entry.id).toMatch(/^custom_\d+_\d+$/);
      expect(typeof entry.createdAt).toBe('number');
      const list = await loadCustomEndgames();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('我的残局');
    });

    it('多次新增互不覆盖', async () => {
      await addCustomEndgame({ name: 'A', comment: '', fen: BUILTIN_ENDGAMES[0].fen });
      await addCustomEndgame({ name: 'B', comment: '', fen: BUILTIN_ENDGAMES[1].fen });
      const list = await loadCustomEndgames();
      expect(list.map((e) => e.name)).toEqual(['A', 'B']);
    });

    it('更新保留原 id 与 createdAt', async () => {
      const entry = await addCustomEndgame({
        name: '原名',
        comment: '原说明',
        fen: BUILTIN_ENDGAMES[0].fen,
      });
      const ok = await updateCustomEndgame(entry.id, {
        name: '新名',
        comment: '新说明',
        fen: BUILTIN_ENDGAMES[2].fen,
      });
      expect(ok).toBe(true);
      const list = await loadCustomEndgames();
      expect(list[0].id).toBe(entry.id);
      expect(list[0].createdAt).toBe(entry.createdAt);
      expect(list[0].name).toBe('新名');
      expect(list[0].comment).toBe('新说明');
    });

    it('更新不存在的 id 返回 false', async () => {
      await expect(
        updateCustomEndgame('custom_nope', { name: 'x', comment: '', fen: BUILTIN_ENDGAMES[0].fen })
      ).resolves.toBe(false);
    });

    it('删除后列表中不再有该项', async () => {
      const entry = await addCustomEndgame({
        name: '待删',
        comment: '',
        fen: BUILTIN_ENDGAMES[0].fen,
      });
      await deleteCustomEndgame(entry.id);
      await expect(loadCustomEndgames()).resolves.toEqual([]);
    });

    it('删除自定义残局会同步清掉它的皇冠评级（不留死引用）', async () => {
      const entry = await addCustomEndgame({
        name: '要评级的',
        comment: '',
        fen: BUILTIN_ENDGAMES[0].fen,
      });
      await markCustomCompleted(entry.id, 0);
      expect(getCustomCrownTier(await loadProgress(), entry.id)).toBe('gold');

      await deleteCustomEndgame(entry.id);
      const progress = await loadProgress();
      expect(getCustomCrownTier(progress, entry.id)).toBeNull();
      expect(entry.id in (progress.customBestUndoUsed ?? {})).toBe(false);
    });

    it('删除其它残局不影响这一项的评级', async () => {
      const keep = await addCustomEndgame({ name: '保留', comment: '', fen: BUILTIN_ENDGAMES[0].fen });
      const drop = await addCustomEndgame({ name: '删除', comment: '', fen: BUILTIN_ENDGAMES[1].fen });
      await markCustomCompleted(keep.id, 1);
      await markCustomCompleted(drop.id, 0);

      await deleteCustomEndgame(drop.id);
      const progress = await loadProgress();
      expect(getCustomCrownTier(progress, keep.id)).toBe('silver');
      expect(getCustomCrownTier(progress, drop.id)).toBeNull();
    });

    it('存储内容不是数组时退回空列表', async () => {
      await AsyncStorage.setItem(CUSTOM_KEY, JSON.stringify({ nope: true }));
      await expect(loadCustomEndgames()).resolves.toEqual([]);
    });
  });

  describe('选关页自定义标签聚焦标记（一次性信号）', () => {
    it('置位后可被消费一次，第二次为 false', () => {
      markPendingFocusCustomTab();
      expect(consumePendingFocusCustomTab()).toBe(true);
      expect(consumePendingFocusCustomTab()).toBe(false);
    });

    it('未置位时消费返回 false', () => {
      expect(consumePendingFocusCustomTab()).toBe(false);
    });
  });

  describe('builtinLevelToLaunch', () => {
    it('把内置关转成对局页参数（内置关 customId 为空串）', () => {
      const level = BUILTIN_ENDGAMES[0];
      expect(builtinLevelToLaunch(0, level)).toEqual({
        levelIndex: 0,
        customId: '',
        name: level.name,
        comment: level.comment,
        fen: level.fen,
        continueBattle: false,
      });
    });

    it('continueBattle 透传', () => {
      expect(builtinLevelToLaunch(1, BUILTIN_ENDGAMES[1], true).continueBattle).toBe(true);
    });
  });
});