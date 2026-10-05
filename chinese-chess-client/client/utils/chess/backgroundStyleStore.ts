/**
 * 对局界面整屏背景选择持久化 Store
 *
 * 结构与 `boardStyleStore.ts`（棋盘样式）逐项对齐：`useSyncExternalStore` + AsyncStorage。
 * - 用户在首页「样式设置」弹窗的「背景」页中选择的背景通过 AsyncStorage 持久化；
 * - 任意页面（对局/联机/观战/复盘）通过 `useBackgroundStyle()` 订阅当前背景，
 *   选择变更时所有已挂载的 `GameBackground` 同步刷新。
 */

import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BACKGROUND_STYLES,
  DEFAULT_BACKGROUND_STYLE_ID,
  getBackgroundStyle,
  type BackgroundStyle,
  type BackgroundStyleId,
} from '@/utils/chess/backgroundStyles';

const STORAGE_KEY = 'background_style_id_v1';

let currentId: BackgroundStyleId = DEFAULT_BACKGROUND_STYLE_ID;
let loaded = false;

const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // 首次订阅时触发异步加载（仅一次）
  if (!loaded) {
    loaded = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        const valid = BACKGROUND_STYLES.some((s) => s.id === stored);
        if (valid && stored !== currentId) {
          currentId = stored as BackgroundStyleId;
          emit();
        }
      })
      .catch(() => {
        // 读取失败保持默认背景，不影响使用
      });
  }
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): BackgroundStyleId {
  return currentId;
}

/** 订阅当前背景（组件级 Hook） */
export function useBackgroundStyle(): BackgroundStyle {
  const id = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getBackgroundStyle(id);
}

/** 当前背景 id（非 Hook 场景读取） */
export function getBackgroundStyleId(): BackgroundStyleId {
  return currentId;
}

/** 切换并持久化背景 */
export async function setBackgroundStyleId(id: BackgroundStyleId): Promise<void> {
  if (!BACKGROUND_STYLES.some((s) => s.id === id)) return;
  currentId = id;
  emit();
  try {
    await AsyncStorage.setItem(STORAGE_KEY, id);
  } catch {
    // 持久化失败时本次会话内仍生效
  }
}

/** 测试用：重置内部状态（生产代码不应调用） */
export function __resetBackgroundStyleStoreForTest(): void {
  currentId = DEFAULT_BACKGROUND_STYLE_ID;
  loaded = false;
  listeners.clear();
}
