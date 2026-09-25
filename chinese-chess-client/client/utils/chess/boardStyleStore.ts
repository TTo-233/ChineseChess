/**
 * 棋盘样式选择持久化 Store
 *
 * - 用户在首页「设置」中选择的棋盘样式通过 AsyncStorage 持久化；
 * - 任意页面（对局/复盘/观战/摆棋）通过 useBoardStyle() 订阅当前样式，
 *   样式变更时所有已挂载棋盘组件同步刷新。
 */

import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BOARD_STYLES,
  DEFAULT_BOARD_STYLE_ID,
  getBoardStyle,
  type BoardStyle,
  type BoardStyleId,
} from '@/utils/chess/boardStyles';

const STORAGE_KEY = 'board_style_id_v1';

let currentId: BoardStyleId = DEFAULT_BOARD_STYLE_ID;
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
        const valid = BOARD_STYLES.some((s) => s.id === stored);
        if (valid && stored !== currentId) {
          currentId = stored as BoardStyleId;
          emit();
        }
      })
      .catch(() => {
        // 读取失败保持默认样式，不影响使用
      });
  }
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): BoardStyleId {
  return currentId;
}

/** 订阅当前棋盘样式（组件级 Hook） */
export function useBoardStyle(): BoardStyle {
  const id = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getBoardStyle(id);
}

/** 当前样式 id（非 Hook 场景读取） */
export function getBoardStyleId(): BoardStyleId {
  return currentId;
}

/** 切换并持久化棋盘样式 */
export async function setBoardStyleId(id: BoardStyleId): Promise<void> {
  if (!BOARD_STYLES.some((s) => s.id === id)) return;
  currentId = id;
  emit();
  try {
    await AsyncStorage.setItem(STORAGE_KEY, id);
  } catch {
    // 持久化失败时本次会话内仍生效
  }
}
