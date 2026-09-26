/**
 * 棋盘本体宽度换算
 *
 * 背景：人机 / 在线对局 / 观战等模式都在棋盘上下各有一行「名称角标行」（对手名、AI 引擎名、
 * 准备状态等）。这些角标行此前把宽度硬编码为 `screenWidth`，在宽屏（横屏、平板、桌面浏览器）
 * 上棋盘会因纵向布局预算被压缩并水平居中，角标行却仍铺满整屏，于是药丸被推到屏幕最左/最右，
 * 与棋盘边缘脱节。
 *
 * ChessBoard 的实际渲染宽度与本文件口径完全一致（见 components/ChessBoard.tsx）：
 *   boardWidth = screenWidth - 16
 *   widthScale = boardWidth / boardStyle.scaleBaseWidth
 *   scale      = maxBoardHeight > 0 ? min(widthScale, maxBoardHeight / boardStyle.scaleBaseHeight) : widthScale
 *   渲染宽度   = boardStyle.imgWidth * scale
 * 因此角标行改用「棋盘本体宽度」并保持居中，即可与棋盘左右边缘精确对齐。
 */

/** 棋盘水平留白：与 ChessBoard 内部 `boardWidth = screenWidth - 16` 的固定留白保持一致 */
const BOARD_H_PADDING = 16;

/**
 * 棋盘本体宽度（与 ChessBoard 渲染结果一致的预测值）。
 *
 * @param screenWidth   窗口宽度
 * @param boardStyle    当前棋盘样式（几何参数随样式变化）
 * @param maxBoardHeight 父级下发的纵向高度上限；未就绪（0/undefined）时退化为纯按宽度缩放
 */
export function boardContentWidth(
  screenWidth: number,
  boardStyle: { imgWidth: number; scaleBaseWidth: number; scaleBaseHeight: number },
  maxBoardHeight: number
): number {
  if (!(screenWidth > 0)) return 0;
  const widthScale = (screenWidth - BOARD_H_PADDING) / boardStyle.scaleBaseWidth;
  const heightLimited = maxBoardHeight > 0;
  const scale = heightLimited
    ? Math.min(widthScale, maxBoardHeight / boardStyle.scaleBaseHeight)
    : widthScale;
  return boardStyle.imgWidth * scale;
}

/**
 * 与棋盘左右边缘对齐的行样式：宽度取棋盘本体宽度并保持水平居中，
 * 使该行左右边缘与棋盘左右边缘重合。
 *
 * 适用对象：棋盘上下方的名称角标行，以及棋盘下方的底部操作栏/控制区。
 *
 * 保留「显式数值宽度」（而非依赖 stretch）的原因：部分 Android 设备的 Yoga
 * 对百分比/stretch 处理不可靠，角标行内部依赖 flex 等分与 marginLeft:'auto' 右对齐、
 * 底部栏内部依赖按钮 flex:1 等分，必须拿到确定的可用宽度。
 */
export function boardAlignedRowStyle(
  screenWidth: number,
  boardStyle: { imgWidth: number; scaleBaseWidth: number; scaleBaseHeight: number },
  maxBoardHeight: number
): { width: number; alignSelf: 'center' | 'stretch' } {
  const width = boardContentWidth(screenWidth, boardStyle, maxBoardHeight);
  // 棋盘宽度尚未确定时（screenWidth 异常）退回整屏，避免出现零宽行
  if (!(width > 0) || width > screenWidth) {
    return { width: screenWidth, alignSelf: 'stretch' };
  }
  return { width, alignSelf: 'center' };
}
