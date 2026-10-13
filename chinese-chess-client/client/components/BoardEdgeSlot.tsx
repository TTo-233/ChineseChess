/**
 * 棋盘「角位带」：棋盘上下各一条，角位内容放在带的两端
 *
 * ============================ 为什么要有这个组件 ============================
 * 揭棋的「被吃棋子」要求右上（我方损失）与左下（对方损失）显示棋子；
 * 在线对战要求上左（对手名角标）与下右（我方名角标）显示药丸。
 * 二者是**同一个问题**：棋盘上下有角位内容，且它们分处两端、各自独立。
 *
 * 2026-10 前四轮实机反馈把这块的结构试遍了，每次只解决一半：
 *   1. 棋盘内绝对定位的角位 → 压在盘面棋子上；
 *   2. 把被吃棋子塞进「AI 药丸那一行」内部 → 那行固定 height:26 被撑破 → 压盘面；
 *   3. 被吃棋子另起一行排 AI 药丸行**上方** → AI 行不再被顶，但被吃棋子离棋盘隔了一整行；
 *   4. 被吃棋子另起一行排 AI 药丸行**下方** → AI 行被顶离棋盘（"名称标签被顶起来"）。
 * 根因都是**把角位内容塞进了「一行里只放药丸」的那一行**，改坏了那一行的布局契约 ——
 * 内容一多就撑高，行一高就把另一端/棋盘顶走。
 *
 * 本组件的解法：把「带」和「槽」拆成两层 ——
 *   · **带**（本组件）：定位与留白只由带决定，**与放什么内容无关**；
 *   · **槽**（props start/end）：两端的角位内容，各自独立、互不侵占。
 * 于是「药丸」与「被吃棋子」都只是槽里的普通内容，谁也改不坏对方。
 *
 * ============================ 两条硬约束（都是实机反馈逼出来的）===========================
 *
 * **约束 1：起端内容必须直接挂在带上，不能再套一层 View。**
 * 药丸用 `maxWidth: '86%'` 限宽，而百分比是相对**直接父容器**解析的：
 * 一旦套了槽 View，86% 就变成「槽宽的 86%」，而槽宽又由药丸自身撑开 ⇒ 86% < 药丸宽度
 * ⇒ 药丸必然被截断（2026-10 实机：「揭棋引擎（进阶）」显示成「揭棋引擎（...」）。
 * 直接挂载 ⇒ 86% 相对带宽，即原本的意图。
 *
 * **约束 2：内容贴棋盘那一侧对齐（上带贴下、下带贴上）。**
 * 带的高度 = max(minHeight, 最高内容)。若用 `alignItems:'center'`，
 * 矮内容（药丸 26）在更高的带里居中 ⇒ 它到棋盘的距离被撑大
 * （实机：「有吃子时药丸与棋盘的间隙会变大」）。
 * 改成贴棋盘一侧对齐后：药丸底边恒等于带底边 ⇒ 与棋盘的距离**恒为 gap**，与吃子无关；
 * 而更高的被吃棋子往远离棋盘的方向生长，永远不压向棋盘。
 *
 * ============================ 为什么用 marginLeft:'auto' 而不是各占一半（B 方案）===========================
 * 两端各占一半（A）在窄屏上会把药丸与被吃棋子挤到一起；B 让左端自然贴左、
 * 右端自然贴右，中间空白自适应，正是预期观感。
 * B 的唯一风险是右端过宽时把左端压扁 —— 但揭棋一组**最多 6 张图**：
 * 同一棋种被吃多子合并成一个角标（jieqiCaptured.ts 按图片分组），
 * 而单方只可能有 che/ma/pao/shi/xiang/zu 六种（jieqi.ts 的 HIDDEN_MULTISET_BY_SIDE，
 * 黑方无兵、红方无卒），将帅仅 1 枚必然不合并。
 *
 * **但「最多 6 张」不等于「一定放得下」**（2026-10 实测核对）：
 * 按最宽文案「深算引擎（极限）」（约 144px 的药丸）与 6 张图估算：
 *   屏宽 430 ⇒ 富余 40px；393 ⇒ 富余 21px；375 ⇒ 富余 9px；
 *   360 ⇒ 刚好 0；320 ⇒ **短缺 22px**。
 * 320/360 这类超窄屏（以及横屏的小高度场景）放不下时，RN flex 会压缩左端
 * （药丸有 flexShrink:1 作为安全阀，见 screens/game 的 styles.aiNameChip），
 * 药丸文案会再次被截断。因此：
 *   · 不要把「6 张图一定不挤」当成不变式来依赖；
 *   · 若后续要让药丸在超窄屏也**必然**完整，可行的做法是把末端改为
 *     可横向滚动的「战利品条」，或对角标整体缩放 —— 二者都要另开一轮实机核对，
 *     不要顺手改这里的定位。
 * **角位内容种类变多时必须重新核对这条上界**，别默认它一直成立。
 */

import React, { memo } from 'react';
import { StyleSheet, View } from 'react-native';

/** 带在哪一侧 —— 决定 gap 落在 marginBottom（top）还是 marginTop（bottom） */
export type BoardEdgeSlotSide = 'top' | 'bottom';

export interface BoardEdgeSlotProps {
  /** 本带在棋盘上方还是下方 */
  side: BoardEdgeSlotSide;
  /** 起端内容（上左 / 下左） */
  start?: React.ReactNode;
  /** 末端内容（上右 / 下右） */
  end?: React.ReactNode;
  /** 与棋盘同宽的对齐行样式（boardAlignedRowStyle） */
  alignedRowStyle: { width: number; alignSelf: 'center' | 'stretch' };
  /**
   * 带与棋盘之间的留白。上带用 marginBottom、下带用 marginTop ——
   * 两条带传同一个值，棋盘上下留白就严格相等。
   */
  gap?: number;
  /**
   * 带的最小高度。传它是为了**保持既有观感**：角标行原本固定 26px，
   * 带上没内容时若塌成 0，棋盘就会整体上移。内容超过它时带自然长高。
   */
  minHeight?: number;
  paddingHorizontal?: number;
  testID?: string;
}

/**
 * 棋盘上下的一条角位带。
 *
 * 高度 = max(minHeight, 两端内容的自然高度)：内容为空时是 minHeight（通常 26），
 * 有内容且更高时由内容决定 —— 后者正是「被吃棋子行会变高」的机制，
 * 但**只影响这一条带自己**，不会改坏另一条带或别的角位。
 */
export const BoardEdgeSlot = memo(function BoardEdgeSlot({
  side,
  start,
  end,
  alignedRowStyle,
  gap = 0,
  minHeight = 0,
  paddingHorizontal = 0,
  testID,
}: BoardEdgeSlotProps) {
  const hasEnd = end !== undefined && end !== null && end !== false;

  // 上带贴下（贴近棋盘顶边）、下带贴上（贴近棋盘底边）——
  // 这正是「药丸与棋盘的间隙恒为 gap、不受吃子影响」的机制，见文件头约束 2。
  const alignToBoard = side === 'top' ? 'flex-end' : 'flex-start';

  return (
    <View
      testID={testID}
      style={[
        styles.band,
        {
          paddingHorizontal,
          minHeight,
          alignItems: alignToBoard,
          marginBottom: side === 'top' ? gap : 0,
          marginTop: side === 'bottom' ? gap : 0,
        },
        alignedRowStyle,
      ]}
    >
      {/* 起端直接挂载（不套槽 View）—— 否则药丸的 maxWidth:'86%' 会相对槽宽解析而截断，
          见文件头约束 1。 */}
      {start}
      {/* 末端必须包在 View 里：marginLeft:'auto' 需要一个可挂 auto 的元素。
          这层包装只影响末端（被吃棋子），起端的药丸不受影响。 */}
      {hasEnd ? <View style={styles.end}>{end}</View> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  band: {
    flexDirection: 'row',
  },
  // 末端容器：marginLeft:'auto' 是「推到右端」的全部机制。
  // 不设宽度/固定尺寸 —— 宽度完全由内容决定。
  end: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 'auto',
    flexShrink: 0,
  },
});
