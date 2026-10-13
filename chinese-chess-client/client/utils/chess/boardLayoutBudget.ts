/**
 * 棋盘纵向高度预算（人机对战 / 残局闯关 / 在线对局 / 复盘 / 观战共用）。
 *
 * 2026-10 布局改造：被吃棋子摘要条与明细抽屉整体下线后，棋盘上方不再有
 * 「抽屉展开高度 + 摘要条悬浮区」这段必须常驻的预留，预算退化为一条直线约束：
 *
 *   棋盘高度 ≤ 宿主可用高度 - 棋盘上方流内占位 - 棋盘下方流内占位
 *
 * 上下占位只由真实渲染的元素决定（AI/对手名称角标行、dynamicGap、底部操作栏），
 * 其中底部栏高度由页面 onLayout 实测回报（不同模式、不同阶段的按钮数不同）。
 *
 * 历史背景（保留以便理解为何还需要「视口封顶」）：这些页面被 Screen 包在
 * KeyboardAwareScrollView 里，内容容器是 `flexGrow: 1`，允许内容超过视口。
 * 若直接用 onLayout 实测的宿主高度做预算，会形成正反馈
 * （宿主被撑大 → 棋盘反推更大 → 内容更高 → 宿主更大），宽屏下整页可滚动。
 * `capHostHeightToViewport` 把宿主高度限制在「视口内真正可用」以内，正反馈被打断。
 *
 * ## 【C-90】纵向基准从「宿主内居中」改为「屏幕 50% 居中」
 *
 * 原实现把内容在 **boardHost 区间内**垂直居中（paddingTop = (hostHeight - 内容高)/2）。
 * 但宿主底边是被底部操作栏 + dynamicGap 从视口底部截断的：
 * 宿主区间 [宿主顶, 视口底 - 底栏 - dynamicGap]，而屏幕中线是 视口高/2。
 * 二者中心天然对不齐，于是「宿主内居中」必然把棋盘整体上推。
 * 2026-10 实测（三档视口，棋盘中心 - 屏幕中线）：
 *   393×852 竖屏 → −23px；852×393 横屏 → −29px；1280×800 桌面 → −35px。
 *
 * 新口径：棋盘**本体**的中心对齐**物理屏幕中线**（不是宿主中线，也不是
 * 「角标行 + 棋盘」整块的中线）。实现上把「宿主顶到屏幕中线的距离」作为
 * 棋盘上方预留（centerTop），棋盘高度封顶为「中线以下到宿主底边」的距离：
 *
 *   centerTop = 视口高 / 2 - 宿主顶 - topFlowHeight      （可负 = 中线本身就在宿主顶之上）
 *   board ≤ 视口高 / 2 - (宿主顶 + centerTop + topFlowHeight)  -  bottomFlowHeight
 *        = 视口高 / 2 - topFlowHeight - bottomFlowHeight    —— 与宿主位置无关！
 *
 * 注意封顶式里 hostHeight 被消掉了：棋盘以屏幕中线为中心时，它的可用高度
 * 只取决于「中线上方要占的流内元素」与「中线下方要占的流内元素」，
 * 与宿主顶边的绝对位置无关（宿主顶只用来把棋盘摆到中线上）。
 * 因此 `hostHeight` 在新口径下**只用于保证不越出宿主**（见下方 hostHeight 的兜底说明），
 * 正常情况下不应成为封顶瓶颈——它只在宿主极矮时兜底。
 *
 * 代价（已与用户确认）：横屏/桌面上棋盘原本顶满宿主，再无下移余量，
 * 要真正居中就必须缩小——852×393 由 275px 缩到 217px，1280×800 由 670px 缩到 600px；
 * 竖屏纵向充裕，棋盘尺寸完全不受影响。
 */

import { BOARD_H_PADDING, type BoardStyle } from './boardStyles';

/**
 * 注意：本文件只保留**纯函数** computeBoardLayoutBudget。
 * 原来同文件里的 useBoardLayoutBudget（Hook）已移到 useBoardLayoutBudget.ts，
 * 因为它 import useBoardStyle → boardStyleStore → AsyncStorage，
 * 会把 RN/AsyncStorage 拖进任何 import 这里的布局单测（2026-10 实测：
 * 布局单因此只能靠 mock 才能跑，布局回归断言极易被跳过）。
 * 纯函数留在无 React 依赖的文件里，任何测试都能直接引用。
 */

/**
 * 棋盘最小可用高度（极矮屏下的保底值，与历史实现一致）
 */
export const DEFAULT_MIN_BOARD_HEIGHT = 200;

/**
 * 宿主高度封顶：把 onLayout 实测的宿主高度限制在「视口内真正可用的高度」以内。
 *
 * @param viewportHeight   窗口总高度（useWindowDimensions 的 height）
 * @param measuredTop      宿主顶边相对页面内容顶边的距离（onLayout 的 layout.y，已含顶部安全区）
 * @param topInset         顶部安全区高度（Screen 已在内容之外施加，此处仅用于扣减可用空间）
 * @param bottomInset      底部安全区高度
 * @param belowHostHeight  宿主**之外**、同属本页面的固定高度（宿主内的下方占位由 bottomFlowHeight 负责）
 */
export function capHostHeightToViewport(
  measuredHeight: number,
  viewportHeight: number,
  measuredTop: number,
  topInset: number,
  bottomInset: number,
  belowHostHeight: number
): number {
  if (!(measuredHeight > 0)) return 0;
  const available = viewportHeight - topInset - measuredTop - bottomInset - belowHostHeight;
  // 极窄/极矮或测量异常时不返回负值；此时退回实测值，交由 computeBoardLayoutBudget
  // 的 minBoardHeight 保底逻辑处理（与既有行为一致）。
  if (!(available > 0)) return measuredHeight;
  return Math.min(measuredHeight, available);
}

export interface BoardLayoutBudgetInput {
  /** 内容宿主实测高度（已视口封顶）；0 表示尚未测得 */
  hostHeight: number;
  /** 屏幕宽度（棋盘宽度上限 = 屏宽 - 两侧留白，见 boardStyles 的 BOARD_H_PADDING） */
  screenWidth: number;
  /**
   * 棋盘**上方**、相对「棋盘宿主顶边」的流内占位高度（AI 标识/对手名称角标行及其 marginBottom；无则 0）。
   *
   * 配合 `viewportCenterY`（见下）换算成「棋盘中心到屏幕中线的上方预留」：
   * 棋盘顶边 = 屏幕中线 - centerTop - topFlowHeight。
   */
  topFlowHeight: number;
  /**
   * 棋盘**下方**、宿主之内的流内占位高度（我方名称角标行等；无则 0）。
   *
   * 它主要参与**垂直定位**（见 computeBoardLayoutBudget 的 paddingTop）。
   * 是否参与棋盘尺寸封顶由 belowHostSlack 决定：横向留白只由 boardStyles 的
   * BOARD_H_PADDING 一处定义，不该因为某个页面在棋盘下方多渲染一行角标，
   * 就顺带把棋盘按高度缩小、两侧留白被放大（【C-81】，见下方说明）。
   */
  bottomFlowHeight: number;
  /**
   * 棋盘宿主**正下方、宿主之外**确认为空的高度（当前各页即底部操作栏与棋盘之间的
   * dynamicGap = max(屏宽*3%, 8)）；默认为 0。
   *
   * 【C-81】2026-10 实机问题：在线对局棋盘两侧留白比人机对战宽。
   * 根因是在线对局多渲染了「我方名称角标行」（棋盘下方一行，占 bottomFlowHeight），
   * 它被计入纵向封顶 → 棋盘被按高度缩小 → 横向留白被顺带放大。
   *
   * 修法不是删掉这一行（它必须占位，否则会压到底栏），而是把「棋盘下方那段
   * 确实空着的间距」显式声明出来：下方内容可以借用这段空白，
   * 于是棋盘宽度重新只由「屏宽 - BOARD_H_PADDING」决定。
   *
   * 安全性：只有该页确实把这段间距留空时才可传，且借用量恰好等于封顶时的溢出量
   * （见 computeBoardLayoutBudget），因此最坏情况只是内容正好贴到底栏上沿，
   * 绝不会压到底栏或与之重叠。
   */
  belowHostSlack?: number;
  /** 棋盘最小高度保底（默认 DEFAULT_MIN_BOARD_HEIGHT） */
  minBoardHeight?: number;
  /**
   * 【C-90】棋盘宿主的顶边 Y（相对页面内容顶边，已含顶部安全区；即 onLayout 的 layout.y）。
   *
   * 传入后纵向基准由「宿主内居中」切换为「**屏幕 50% 居中**」：
   * 棋盘本体中心对齐 `viewportHeight / 2`，与底栏占掉的高度无关。
   * 不传（undefined）则退回旧的「宿主内居中」口径（见文件头【C-90】说明）。
   *
   * 需要一并传 `viewportHeight`（视口总高，useWindowDimensions 的 height）。
   */
  hostTopY?: number;
  /** 【C-90】视口总高（useWindowDimensions 的 height）；与 hostTopY 成对使用 */
  viewportHeight?: number;
}

export interface BoardLayoutBudgetResult {
  /** 传给 ChessBoard 的棋盘最大高度；宿主未测得时为 undefined（此时棋盘只受宽度约束） */
  maxBoardHeight: number | undefined;
  /**
   * boardContainer 的顶部留白：棋盘顶边相对「宿主顶边 + topFlowHeight」的偏移。
   * 宿主未测得时为 0。
   */
  paddingTop: number;
}

/**
 * 求解棋盘高度预算与垂直定位留白。
 *
 * ## 【C-90】屏幕 50% 居中（hostTopY + viewportHeight 均传入时）
 *
 * 记屏幕中线 c = viewportHeight / 2，宿主顶边 y0 = hostTopY，棋盘中心 = c。
 * 棋盘顶边 = c - board/2，其相对宿主的偏移为
 *   topOffset = c - board/2 - y0
 * 棋盘上方流内占位 topFlowHeight 位于宿主观测顶边与棋盘顶边之间，因此
 * 角标行仍落在棋盘正上方（不参与居中计算，只是被顶下去一段）。
 *
 * 不越出宿主底边（= y0 + hostHeight）要求
 *   c + board/2 ≤ y0 + hostHeight  ⇒  board ≤ 2*(y0 + hostHeight - c)
 * 这是「宿主封顶」；它在宿主底边低于屏幕中线时才生效（极矮屏）。
 *
 * 而中线以下要容纳下方流内占位 bottomFlowHeight：
 *   board/2 ≥ bottomFlowHeight  ⇒  board ≥ 2 * bottomFlowHeight
 * 上面的 topFlowHeight/bottomFlowHeight 通过「棋盘中心两侧各占多少」进入：
 *   board ≤ 2 * (c - topFlowHeight - bottomFlowHeight)
 *   board ≤ 2 * (y0 + hostHeight - c - bottomFlowHeight)
 * 两者取小即新口径的封顶。宿主顶边 y0 只影响 paddingTop（把棋盘摆到中线），
 * 不影响上面第一式的封顶——所以「棋盘多大」与「底栏占多高」彻底解耦。
 *
 * ## 旧口径（不传 hostTopY）：宿主内居中
 *
 * 设棋盘顶边距宿主顶为 topOffset，则棋盘顶边 = topOffset + topFlowHeight。
 * 内容不越界要求 topOffset + (topFlowHeight + board + bottomFlowHeight) ≤ hostHeight，
 * 即 topOffset ≤ hostHeight - topFlowHeight - board - bottomFlowHeight。
 * 取 topOffset = max((hostHeight - 内容高)/2, 0)（垂直居中）代入，解出
 *   board ≤ hostHeight - topFlowHeight - bottomFlowHeight（无需二分，直接线性求解）。
 *
 * 【C-81】belowHostSlack > 0 时，上式的封顶改为「只封顶上方占位」：
 *   board ≤ hostHeight + belowHostSlack - topFlowHeight
 * 即下方的行可以借用棋盘下方那段确实空着的间距（当前即底栏上边距 dynamicGap），
 * 横向宽度重新只由 BOARD_H_PADDING 决定，人机对战与在线对局的留白因此一致。
 *
 * 注意【C-81】的口径**只对旧算法有意义**：新口径下棋盘以屏幕中线为中心，
 * 它与底栏上边距之间天然隔着「中线到宿主底边」这一段，不再存在
 * 「下方那一行把棋盘缩小、进而放大横向留白」的传导链；
 * belowHostSlack 在新口径下仍然原样传给旧分支（兼容未传 hostTopY 的调用方）。
 */
export function computeBoardLayoutBudget(
  input: BoardLayoutBudgetInput,
  boardStyle: BoardStyle
): BoardLayoutBudgetResult {
  const { hostHeight, screenWidth, topFlowHeight, bottomFlowHeight } = input;
  const belowHostSlack = input.belowHostSlack ?? 0;
  const minBoardHeight = input.minBoardHeight ?? DEFAULT_MIN_BOARD_HEIGHT;

  if (!(hostHeight > 0)) {
    return { maxBoardHeight: undefined, paddingTop: 0 };
  }

  // 宽度约束：棋盘宽度 = 屏宽 - 两侧留白，按当前样式的基准高度换算成可用高度上限
  const widthScale = Math.max(screenWidth - BOARD_H_PADDING, 0) / boardStyle.scaleBaseWidth;
  const widthBoardHeight = widthScale * boardStyle.scaleBaseHeight;

  // 【C-90】屏幕 50% 居中：宿主顶边与视口高都测得时才启用，否则退回旧的宿主内居中
  const hostTopY = input.hostTopY;
  const viewportHeight = input.viewportHeight;
  const useViewportCenter =
    hostTopY !== undefined && viewportHeight !== undefined && viewportHeight > 0;

  if (useViewportCenter) {
    const centerY = viewportHeight / 2;
    const hostBottomY = hostTopY + hostHeight;
    // 封顶 A：中线以上要留给上方流内占位、中线以下要留给下方流内占位
    //   board/2 ≤ centerY - topFlowHeight   且   board/2 ≥ bottomFlowHeight
    // 两边再留一半给下方占位，合起来：board ≤ 2*(centerY - topFlowHeight - bottomFlowHeight)
    //   —— 与宿主顶边、底栏高度都无关，这正是【C-90】想要的解耦。
    const flowBudgetCenter = 2 * (centerY - topFlowHeight - bottomFlowHeight);
    // 封顶 B：棋盘下沿不得越出宿主底边（仅当宿主底边低于屏幕中线时才成为瓶颈）
    const flowBudgetHost = 2 * (hostBottomY - centerY - bottomFlowHeight);
    const flowBudget = Math.min(flowBudgetCenter, flowBudgetHost);

    // 纵向约束 + 保底：极端矮屏下宁可溢出也要保住 minBoardHeight（否则棋盘小到无法落子）
    const board = Math.max(Math.min(widthBoardHeight, flowBudget), minBoardHeight);

    // 垂直定位：把棋盘顶边摆到 centerY - board/2 - topFlowHeight 处
    // （负值合法：宿主顶边本身就可能在屏幕中线之上，此时棋盘顶边在宿主顶之上方留白）
    const paddingTop = centerY - board / 2 - topFlowHeight - hostTopY;
    return { maxBoardHeight: board, paddingTop };
  }

  // 纵向约束 + 保底：极端矮屏下宁可溢出也要保住 minBoardHeight（否则棋盘小到无法落子）
  const flowBudget = hostHeight + belowHostSlack - topFlowHeight - bottomFlowHeight;
  const board = Math.max(Math.min(widthBoardHeight, flowBudget), minBoardHeight);

  // 垂直定位留白：内容在宿主内垂直居中（内容高于宿主时为 0，由下方溢出承载）
  const contentHeight = topFlowHeight + board + bottomFlowHeight;
  const paddingTop = Math.max((hostHeight - contentHeight) / 2, 0);

  return { maxBoardHeight: board, paddingTop };
}