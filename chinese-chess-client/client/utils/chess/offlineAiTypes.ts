/**
 * 离线 AI 相关类型（单独成文件以避免 offlineAiAdapter ↔ offlineEngine 循环依赖）
 */

import type { AIMoveResult } from './AIEngine';

/** 搜索用途（与 offlineEngine 的 SearchPurpose 同义，此处仅用于结果标注） */
export type AIMovePurpose = 'move' | 'hint' | 'ponder';

/** 一次离线请求的结果，附带来源与引擎信息供 UI 展示 */
export interface AIMoveSearchOutcome extends AIMoveResult {
  /**
   * 实际算出这一步的引擎（**必须**如实反映，不能硬编码）。
   * 'pikafish'=皮卡鱼；'legacy'=兜底 TS AI（引擎不可用/着法两次被拒时）。
   * 两者棋力差一个量级，UI 需据此提示，避免把兜底当成正式档位。
   */
  engine: 'pikafish' | 'legacy';
  /** 引擎完成深度（兜底引擎为 0） */
  depth: number;
  /** 引擎侧耗时（毫秒） */
  timeMs: number;
  /** 用途回显 */
  purpose: AIMovePurpose;
}
