/**
 * 揭棋 · 被吃棋子显示的**纯几何/占位**计算（无 React、无 RN 依赖）
 *
 * ============================ 为什么单独一个文件 ============================
 * 这几个函数决定「被吃棋子显示会不会挤歪棋盘」，必须能被布局单测直接引用；
 * 而它们的实现细节（棋子图、角标）依赖 RN 组件。若把函数放在组件文件里，
 * 布局测试就得连 AsyncStorage 一起 mock 才能跑（RN 依赖链会一路拖到 boardStyleStore），
 * 布局回归断言因此很容易被跳过或干脆不写。故：**几何与占位留在纯模块，画法留在组件**。
 *
 * ============================ 位置：角位带 + 两端槽位 ============================
 *   [ 上带：上左 = AI 引擎药丸 ............ 上右 = 我方损失(右上) ]
 *   [ 棋盘 ]
 *   [ 下带：下左 = 对方损失(左下) .......... 下右 = （在线对战才有）我方名角标 ]
 *
 * 结构见 components/BoardEdgeSlot.tsx（带与槽拆开，定位全交给带）。
 * 2026-10 四轮实机反馈否掉了前三种排法，根因都是把角位内容塞进了
 * 「一行里只放药丸」的那一行、从而改坏了它的布局契约：
 *  1. 棋盘内绝对定位角位 → 压在盘面棋子上；
 *  2. 并进 AI 药丸行 → 那行固定 height:26 被撑破 → 压盘面；
 *  3. 另起一行排 AI 药丸行**上方** → 被吃棋子离棋盘隔了一整行，顶部留大片空白；
 *  4. 另起一行排 AI 药丸行**下方** → AI 药丸行被顶离棋盘（"名称标签被顶起来"）。
 *
 * ============================ 上下对称的算术（改任何一处都要重算）===========================
 * 记 P = 棋子边长（capturedPieceSize），G = CAPTURED_ROW_GAP = 角位带的 gap。
 *   上带：max(AI_ROW_MIN_HEIGHT, P)  ← 含 AI 药丸行的高度；加 gap G
 *   下带：P                           ← 只有被吃棋子；加 gap G
 * **注意上下并不相等**（上带多承载了 AI 药丸行），这是结构本身决定的、与被吃棋子无关。
 * 对称的是**带与棋盘之间的留白**：两者都是 G，故棋盘上下留白严格相等。
 *
 * 也就是说：被吃棋子这一项，上下都恰好是 `P + G`（AI 药丸行的高度是额外叠加的），
 * 因此 AI 标识行的高度变化**不会**传导成上下不对称 —— 这正是把定位交给带之后
 * 才成立的性质，此前把被吃棋子塞进药丸行时它是被算进同一行的。
 *
 * ============================ 药丸与棋盘的间隙恒为 G（2026-10 实机修复）===========================
 * 实机报障：「有吃子时，药丸还是会同步增加与棋盘的间隙」。根因：带用
 * `alignItems:'center'`，带被更高的被吃棋子撑到 P 后，矮的药丸（26）在带里垂直居中，
 * 于是它到棋盘的距离被撑大。
 * 现在带上带用 `flex-end`、下带用 `flex-start`（内容贴棋盘一侧对齐，见 BoardEdgeSlot）：
 *   · 矮的 AI 药丸的下边（上带）/ 上边（下带）恒等于带边 ⇒ 与棋盘的距离**恒为 G**，
 *     与有没有吃子、吃了几颗都无关；
 *   · 更高的被吃棋子朝**远离棋盘**的方向生长（上带向上、下带向下），永不压向棋盘。
 * 故 `capturedTopFlowDelta` / `capturedRowReservedHeight` 的算式无需改动 ——
 * 它们描述的正是带的高度，而带的高度确实随 P 增长（那部分空白出现在带的外侧，
 * 不在药丸与棋盘之间）。
 *
 * ============================ 语义 ============================
 *   · 我方损失（我的子被对方吃掉）→ 上带**右端**（右上）
 *   · 对方损失（对方的子被我吃掉）→ 下带**左端**（左下）
 */

import { BOARD_H_PADDING } from './boardStyles';

/**
 * 角位带与棋盘边缘之间的留白。上下两条带用同一个值 ⇒ 棋盘上下留白严格相等。
 *
 * 这个值同时是「上下留白相等」的唯一保证，改它必须上下一起改。
 */
export const CAPTURED_ROW_GAP = 4;

/** AI 标识行（角位带起端那行）的 minHeight（screens/game/index.tsx 的 styles.aiNameRow） */
export const AI_ROW_MIN_HEIGHT = 26;

/**
 * 被吃棋子边长（与 ChessBoard 逐行同源）。
 *
 * boardContentWidth 的文件头记录了「多方口径必须一致」的原因：角标行、被吃棋子行、
 * 盘面棋子都要落在同一个棋盘本体宽度上，否则宽屏下行与盘面会错位。
 *
 * @param maxBoardHeight 棋盘最大可用高度；纵向受限时棋子随之等比缩小。
 *   **与 capturedRowReservedHeight 不同**（那里刻意忽略它，见该函数注释）。
 */
export function capturedPieceSize(
  screenWidth: number,
  boardStyle: { pieceDiameter: number; scaleBaseWidth: number; scaleBaseHeight: number },
  maxBoardHeight: number | undefined
): number {
  const widthScale = (screenWidth - BOARD_H_PADDING) / boardStyle.scaleBaseWidth;
  const scale =
    maxBoardHeight && maxBoardHeight > 0
      ? Math.min(widthScale, maxBoardHeight / boardStyle.scaleBaseHeight)
      : widthScale;
  // 0.72 是「不抢盘面视线」与「角标数字仍可读」之间的取值：这一行是补充信息，
  // 比盘面棋子略小才不会喧宾夺主；再小角标里的数字就糊了。
  return Math.max(Math.floor(boardStyle.pieceDiameter * scale * 0.72), 12);
}

/**
 * 被吃棋子槽内容在纵向预算里要预留的高度（上下两端通用，见文件头的算术）。
 *
 * **刻意只按宽度换算**（不看 maxBoardHeight）：预留高度若依赖棋盘实际尺寸，
 * 就与 maxBoardHeight 形成循环依赖（棋盘尺寸受预留高度影响 → 预留高度又依赖棋盘尺寸），
 * 会让预算求解抖动。按宽度约束下的尺寸预留时：宽度受限（竖屏手机，绝大多数情况）
 * 就是精确值；纵向受限时棋盘实际更小，预留略大 —— 最多多留一点空白，不会重叠。
 *
 * 上带比这个数多出的部分（AI 标识行本身的高度）由页面另行叠加，见 capturedTopFlowDelta。
 *
 * @param hasContent 该槽是否真的有棋子（无棋子时组件返回 null，不占位）
 */
export function capturedRowReservedHeight(
  screenWidth: number,
  boardStyle: { pieceDiameter: number; scaleBaseWidth: number; scaleBaseHeight: number },
  hasContent: boolean
): number {
  if (!hasContent) return 0;
  return capturedPieceSize(screenWidth, boardStyle, 0) + CAPTURED_ROW_GAP;
}

/**
 * 上带因挂载「我方损失」而额外长高多少（喂给 topFlowHeight）。
 *
 * 上带的自然高度是 `max(AI_ROW_MIN_HEIGHT, P)`（AI 药丸行与被吃棋子取高的那个），
 * 而 AI 标识行在不挂被吃棋子时是 `AI_ROW_MIN_HEIGHT`，
 * 故增量 = max(26, P) - 26。P ≤ 26 时增量为 0 —— 象棋/极窄屏下逐像素不变。
 *
 * 注意这**只**是上带的增量；下带没有 AI 行，故下带就是 P + G（见 capturedRowReservedHeight）。
 */
export function capturedTopFlowDelta(
  screenWidth: number,
  boardStyle: { pieceDiameter: number; scaleBaseWidth: number; scaleBaseHeight: number },
  hasContent: boolean
): number {
  if (!hasContent) return 0;
  return Math.max(AI_ROW_MIN_HEIGHT, capturedPieceSize(screenWidth, boardStyle, 0)) - AI_ROW_MIN_HEIGHT;
}