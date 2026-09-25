/**
 * 吃子 / 将军特效触发 Hook（人机、残局、联机对局共用）
 *
 * 将军节流策略（无迷你版，将军与吃子特效始终保持一致大小）：
 * - 距上次将军特效 ≥4 秒才播放全尺寸"将军"特效
 * - 冷却期内再次将军：静默跳过（局面状态栏仍有将军提示，不缺失反馈）
 *
 * 吃子：每次吃子均播放（吃子+将军同时发生时将军优先）。
 * 终局（绝杀/困毙等）不播放，由绝杀特效接管。
 */
import { useCallback, useRef, useState } from 'react';
import type { MoveEffect, MoveEffectKind } from '@/components/MoveEffectOverlay';

/**
 * 吃子 / 将军图片特效总开关。
 *
 * 已启用（true）：使用金色书法字 + 水墨圆环的透明底 PNG 素材
 * （effect_chi.png / effect_jiangjun.png）。置为 false 可整体停用图片特效
 * （特效不再渲染、也不产生特效延时；将军语音等音效不受影响仍正常播放）。
 */
const MOVE_EFFECT_ENABLED: boolean = true;

// 将军特效冷却：距上次 ≥4 秒才再次播放（始终全尺寸，无迷你版）
const CHECK_COOLDOWN_MS = 4000;

export function useMoveEffect() {
  const [moveEffect, setMoveEffect] = useState<MoveEffect | null>(null);
  const seqRef = useRef(0);
  const lastCheckAtRef = useRef(0);

  /**
   * @param captured 被吃棋子 id（-1 表示未吃子）
   * @param isCheck  本步是否形成将军
   * @param isGameOver 本步是否终局（终局由绝杀特效接管）
   * @returns 实际播放的特效类型；未播放（静默/节流跳过/终局）返回 null。
   *          调用方可据此延时后续动作（如推迟 AI 落子至特效播完，避免特效被打断）。
   */
  const triggerMoveEffect = useCallback((captured: number, isCheck: boolean, isGameOver: boolean): MoveEffectKind | null => {
    if (!MOVE_EFFECT_ENABLED) return null;
    if (isGameOver) return null;

    if (isCheck) {
      const now = Date.now();
      const elapsed = now - lastCheckAtRef.current;
      if (elapsed >= CHECK_COOLDOWN_MS) {
        lastCheckAtRef.current = now;
        seqRef.current += 1;
        setMoveEffect({ kind: 'check', seq: seqRef.current });
        return 'check';
      }
      return null;
    }

    if (captured !== -1) {
      seqRef.current += 1;
      setMoveEffect({ kind: 'capture', seq: seqRef.current });
      return 'capture';
    }
    return null;
  }, []);

  return { moveEffect, triggerMoveEffect };
}
