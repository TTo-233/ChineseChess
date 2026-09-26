/**
 * 统一弹窗组件出口
 *
 * 全应用浮层统一走这三个基础组件 + Design Tokens（`@/constants/modal`）：
 * - `AppModal`：基础全屏弹窗（遮罩 + 卡片壳子），设置/表单/说明类场景
 * - `AppDialog`：确认/提示弹窗（标题 + 正文 + 1~2 按钮）
 * - `GameNotice`：对局内低干扰提示条（棋盘中央，3s 自动消失，替代 `Alert.alert`）
 * - `ModalButton`：统一按钮变体（primary / secondary / danger / success）
 */
export { default as AppModal } from './AppModal';
export type { AppModalProps } from './AppModal';

export { default as AppDialog } from './AppDialog';
export type { AppDialogProps } from './AppDialog';

export { default as GameNotice } from './GameNotice';
export type { GameNoticeItem, GameNoticeProps } from './GameNotice';

export { ModalButton, modalButtonRowStyle, modalBodyGapStyle } from './ModalButton';
export type { ModalButtonProps } from './ModalButton';
