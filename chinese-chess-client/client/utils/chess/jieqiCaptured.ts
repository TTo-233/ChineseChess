/**
 * 揭棋 · 被吃棋子清单（棋盘角落实显用）
 *
 * ============================ 为什么单独一个模块 ============================
 * 1. 数据只来自 GameState（pieces[].alive === false），**不依赖任何引擎内部状态**，
 *    因此可以在纯函数里算清楚，UI 侧只负责画 —— 便于单测钉住规则。
 * 2. 揭棋的被吃子有「明/暗」两种显示口径（铁律 A）：
 *    - **暗子被吃**（吃子时该子背面朝上）→ 显示**背面图**，身份对双方都不可见
 *      （规则：吃暗子不获得任何新子，所以这里绝不能去猜它是什么棋）；
 *    - **明子被吃**（已被翻开或将帅）→ 显示**正面图**，且必须按
 *      `revealedType` 的**真实棋种**取图，绝不能按盘面 id 取 —— 揭棋的盘面 id
 *      恒等于棋位棋种，按 id 取会让「翻开的子」显示成棋位本来的棋子
 *      （这正是 pieceImages.getJieqiPieceImage 注释里记的那个老坑）。
 *
 * ============================ 分组口径 ============================
 * 同一张图的被吃子合并成一格，右上角用数字角标显示个数（沿用应用既有角标样式）：
 *   · 明子按「真实棋种在该方的代表 id」分组（车/马/炮/士/象/兵各成一格）；
 *   · 暗子按方分组（背面图只有红/黑两张，红暗子被吃 3 枚就是 1 格 × 3）。
 * 分组键直接用**图片资源对象**：同图即同格，象棋局面（revealedType 全空）
 * 顺带也按图合并（两个黑车 id 取同一张图），不会退化成「一个 id 一格」。
 */

import { representativeId, sideOfId } from './jieqi';
import { RED_SIDE, type GameState, type SideTag } from './types';
import { getFaceDownImage, getPieceImage } from './pieceImages';

/** 一格被吃棋子（同类合并后的展示单元） */
export interface JieqiCapturedGroup {
  /** 显示图：暗子=背面图，明子=真实棋种的正面图 */
  source: any;
  /** 该组被吃数量；>1 时才显示右上角数字角标 */
  count: number;
  /** true = 被吃时仍是暗子（显示背面图） */
  hidden: boolean;
  /** 被吃子所属阵营 */
  side: SideTag;
}

/** 暗子组的排序键：排在所有明子之后（明子按代表 id 升序，最直观） */
const HIDDEN_SORT_KEY = 99;

/**
 * 某一方**已损失**（被对方吃掉）的棋子清单，按展示顺序排好。
 *
 * @param state 当前局面（象棋局面同样可用：那时没有暗子，全是明子正面图）
 * @param side  损失方（红/黑）
 */
export function capturedPiecesOfSide(state: GameState, side: SideTag): JieqiCapturedGroup[] {
  // key = 图片资源对象（同一张图合并成一格）；附带记排序键，保证顺序稳定可测
  const groups = new Map<unknown, { group: JieqiCapturedGroup; sortKey: number }>();

  for (const piece of state.pieces) {
    if (!piece || piece.alive) continue;
    if (sideOfId(piece.id) !== side) continue;

    const hidden = state.hiddenMask?.[piece.id] === true;
    const revealed = state.revealedType?.[piece.id] ?? null;
    // 明子按真实棋种取代表 id；revealedType 为空（将帅等本来就是明子的子）按 id 取
    const rep = revealed ? representativeId(revealed, side) : null;
    const sortKey = hidden ? HIDDEN_SORT_KEY : (rep ?? piece.id);

    // 暗子身份不可见 ⇒ 只按方取背面图（红/黑两张），不去猜它是什么棋
    const source = hidden
      ? getFaceDownImage(side === RED_SIDE ? 16 : 0)
      : getPieceImage(rep ?? piece.id);
    if (!source) continue;

    const hit = groups.get(source);
    if (hit) {
      hit.group.count += 1;
    } else {
      groups.set(source, {
        group: { source, count: 1, hidden, side },
        sortKey,
      });
    }
  }

  return [...groups.values()]
    .sort((a, b) => a.sortKey - b.sortKey)
    .map((entry) => entry.group);
}