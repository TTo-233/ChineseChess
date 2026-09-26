/**
 * 弹窗系统 Design Tokens（Design Tokens for overlays）
 *
 * 全应用所有浮层（Modal / Dialog / 轻提示条）必须消费本文件的 token，
 * 不允许在各自屏幕里再写 `rgba(0,0,0,0.45)`、`borderRadius: 20`、`width:'85%'` 这类
 * 散落的遮罩色、圆角与宽度约束——重构前项目里同时存在 4 档遮罩色、4 档圆角、
 * 4 种宽度写法和 5 套按钮类名，现统一收敛到此处。
 *
 * 注意：颜色/圆角/尺寸 token 定义在 TS 中（React Native 的 StyleSheet 数值
 * 无法消费 CSS 变量），字号字阶仍以 `@/utils/typography` 的 FONT 为唯一来源。
 */

/** 浮层配色 */
export const COLORS = {
  /** 标准暗色遮罩：绝大多数弹窗使用 */
  modalOverlay: 'rgba(0, 0, 0, 0.5)',
  /** 浅色遮罩：lanBattle 等需要「棋盘仍可辨认」的场景使用 */
  modalOverlayLight: 'rgba(245, 240, 232, 0.92)',
  /** 弹窗卡片底色（宣纸色） */
  modalCard: '#FFF8F0',
  /** 主操作按钮底色（赭石金） */
  modalPrimary: '#8B6914',
  /** 危险操作按钮底色 */
  modalDanger: '#C62828',
  /** 成功/同意操作按钮底色 */
  modalSuccess: '#2E7D32',
  /** 卡片主文字 */
  modalText: '#3E2723',
  /** 卡片次要文字（说明、提示） */
  modalTextMuted: '#5D4037',
  /** 更弱的说明文字（hint、脚注） */
  modalTextLight: '#8D6E63',
  /** 卡片描边 */
  modalBorder: '#D7CCC8',
  /** 次操作按钮的浅底色 */
  modalSecondaryBg: '#F5F0E8',
  /** 轻提示条（GameNotice）底色 */
  noticeBg: 'rgba(0, 0, 0, 0.65)',
  /** 轻提示条文字色 */
  noticeText: '#FFFFFF',
} as const;

/** 浮层圆角 */
export const RADIUS = {
  /** 弹窗卡片圆角（统一 16，替代 20/16/10） */
  modalCard: 16,
  /** 弹窗按钮圆角（统一 8，替代 12/10/8） */
  modalButton: 8,
  /** 轻提示条圆角 */
  notice: 12,
} as const;

/** 浮层尺寸 */
export const SIZES = {
  /** 弹窗卡片统一最大宽度（统一 360，替代 85% / 80% / 420） */
  modalMaxWidth: 360,
  /** 弹窗卡片统一最小宽度 */
  modalMinWidth: 280,
  /** 浮层最大高度（内容过长时内部滚动） */
  modalMaxHeight: '88%',
  /** 卡片内边距（统一 24，替代各处 20/24/32） */
  modalPadding: 24,
} as const;

/**
 * Android 层级 token：棋盘内部/之上的浮层必须同时设置 zIndex 与 elevation，
 * 否则在 Android 上会沉到棋盘之下被遮挡（棋盘容器自身设了 elevation）。
 * `collapsable={false}` 同样必须保留，防止 Android release 视图扁平化。
 */
export const Z_INDEX = {
  /** 抽屉/次级浮层（如被吃棋子抽屉、表情下拉） */
  drawer: 50,
  /** 轻提示条 / 通用弹窗层 */
  overlay: 100,
  /** 结算遮罩等强交互层 */
  terminal: 100,
} as const;

/** 与 Z_INDEX 配套的 Android elevation（与层级一一对应） */
export const ELEVATION = {
  drawer: 50,
  overlay: 100,
  terminal: 100,
} as const;

/** 轻提示条默认停留时长（毫秒） */
export const NOTICE_DURATION_MS = 3000;

/** 类型导出 */
export type ModalVariant = 'dark' | 'light';
export type ModalCloseBtnType = 'icon' | 'text';
export type ModalButtonVariant = 'primary' | 'secondary' | 'danger' | 'success';
