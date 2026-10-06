#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""棋盘背景图标准处理流程（build）.

把设计稿（原图，通常是带透明边的 RGBA PNG）转成客户端直接可用的棋盘资源：
索引色 PNG（colour type 3）+ tRNS alpha 表。

为什么是索引色 PNG
------------------
棋盘图四周有一圈**透明边**，棋盘要「浮」在 App 背景上
（见 utils/chess/boardStyles.ts 与 classic 棋盘本身的形态）。
JPEG 没有 alpha 通道，一旦存成 JPG，透明边就必须被压成某个实色，
线上就会出现一圈黑边/色边。因此棋盘资源一律保持 PNG。

为什么 8 位索引色
----------------
24 位无损 PNG 实测 5.8MB，索引色后 815KB（-86%），肉眼无差别。

为什么必须用 FASTOCTREE（RGBA 四维聚类）
---------------------------------------
本流程最大的坑：透明边被渲染成实色（黑晕）。
- 若只在**不透明像素**上做 k-means，再对每簇 alpha 取平均，
  全透明像素会被并进 alpha≈215 的簇 → 透明边以 84% 不透明度渲染 → 黑晕。
- 若直接对 RGB 做 Floyd–Steinberg 抖动，同理会把透明像素分配到
  alpha≈255 的簇 → 黑晕。
FASTOCTREE 在 **R,G,B,A 四维**聚类，alpha 参与距离计算，
全透明像素**结构上不可能**与可见像素共用一个调色板项，从根上杜绝黑晕。

为什么不抖动
------------
试过 numpy 版 Floyd–Steinberg：渐变断层确实消失，但木纹上出现明显斑驳噪点，
花梨木 PSNR 从 34dB 掉到 17dB。真机按实际显示尺寸看不出断层，放大裁切图上的
「banding」是最近邻放大的假象。故默认不抖动（`--dither` 可开启，但不推荐）。

用法
----
    # 处理单张：源图 -> assets/boards/
    python scripts/board_assets.py build --style huali --blacktop raw.png

    # 批量（源图放在 assets/boards/_source/）
    python scripts/board_assets.py build --all

    # 只校验已发布资源（不依赖 Pillow，可进 CI）
    node scripts/verify-board-assets.mjs
"""

from __future__ import annotations

import argparse
import os
import sys

try:
    import numpy as np
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit("需要 Pillow 与 numpy：pip install Pillow numpy")

HERE = os.path.dirname(os.path.abspath(__file__))
CLIENT = os.path.dirname(HERE)
BOARDS = os.path.join(CLIENT, "assets", "boards")
SOURCE = os.path.join(BOARDS, "_source")

N_COLORS = 256
# 每簇 alpha 的多数规则阈值：多数透明 -> 0，多数不透明 -> 255，否则取中位数。
CLEAR_MAJORITY = 0.6
OPAQUE_MAJORITY = 0.6

STYLES = ("huali", "xuanmo", "classic")


def encode_indexed(ref: "Image.Image") -> "Image.Image":
    """RGBA 图 -> 索引色 PNG（PIL.Image），alpha 表正确。

    这是整个流程的核心，原理见模块 docstring。
    """
    idx = np.asarray(
        ref.quantize(colors=N_COLORS, method=Image.Quantize.FASTOCTREE,
                     dither=Image.Dither.NONE)
    ).astype(np.int32)

    src = np.asarray(ref).astype(np.float64)
    flat_idx = idx.ravel()
    flat_src = src.reshape(-1, 4)

    palette = np.zeros((N_COLORS, 3))
    alpha_table = np.zeros(N_COLORS)
    for i in np.unique(flat_idx):
        vals = flat_src[flat_idx == i]
        palette[i] = vals[:, :3].mean(axis=0)
        a = vals[:, 3]
        clear = float((a == 0).mean())
        opaque = float((a == 255).mean())
        if clear > CLEAR_MAJORITY:
            alpha_table[i] = 0
        elif opaque > OPAQUE_MAJORITY:
            alpha_table[i] = 255
        else:
            alpha_table[i] = float(np.median(a))

    out = Image.fromarray(idx.astype(np.uint8), mode="P")
    out.putpalette([int(round(v)) for v in palette.reshape(-1).clip(0, 255)])
    out.info["transparency"] = bytes(
        int(round(v)) for v in alpha_table.clip(0, 255))
    return out


def measure(ref: "Image.Image", got: "Image.Image"):
    """返回 (clear_alpha_max_err, rgb_mad, psnr)。用于把关与报告。"""
    r = np.asarray(ref).astype(np.float64)
    g = np.asarray(got.convert("RGBA")).astype(np.float64)
    opaque = r[..., 3] == 255
    clear = r[..., 3] == 0
    clear_err = float(np.abs(r[..., 3] - g[..., 3])[clear].max()) if clear.any() else 0.0
    rgb_mad = float(np.abs(r[..., :3] - g[..., :3])[opaque].mean())
    mse = ((r[..., :3] - g[..., :3]) ** 2)[opaque].mean()
    psnr = 10 * np.log10(255.0 ** 2 / max(mse, 1e-9))
    return clear_err, rgb_mad, psnr


def build_one(src_path: str, dst_path: str, allow_clear_err: float = 8.0):
    ref = Image.open(src_path).convert("RGBA")
    before = os.path.getsize(src_path)
    out = encode_indexed(ref)

    tmp = dst_path + ".tmp.png"
    out.save(tmp, "PNG", optimize=True, bits=8)
    # 回读校验：确保磁盘上的文件仍然 alpha 正确
    chk = Image.open(tmp)
    clear_err, rgb_mad, psnr = measure(ref, chk)
    if clear_err > allow_clear_err:
        os.remove(tmp)
        raise SystemExit(
            f"[FAIL] {os.path.basename(dst_path)} 透明边 alpha 误差 {clear_err:.0f}"
            f" 超过阈值 {allow_clear_err}，已中止（防止黑晕上线）")
    os.replace(tmp, dst_path)
    after = os.path.getsize(dst_path)
    print(f"  [OK] {os.path.basename(dst_path):<28} "
          f"{before:>8} -> {after:>7} B ({(after - before) / before * 100:+5.0f}%)  "
          f"clearAlphaErr={clear_err:.0f}  rgbMAD={rgb_mad:.2f}  PSNR={psnr:.1f}dB")
    return before, after


def cmd_build(args):
    jobs = []
    if args.all:
        for style in STYLES:
            for orient in ("blacktop", "redtop"):
                src = os.path.join(SOURCE, f"{style}_{orient}.png")
                if os.path.exists(src):
                    jobs.append((src, os.path.join(BOARDS, f"board_{style}_{orient}.png")))
        if not jobs:
            sys.exit(f"没有找到源图，请放到 {SOURCE}/（命名 board_<style>_<orient>.png）")
    else:
        style = args.style
        orient = "blacktop" if args.blacktop else "redtop"
        jobs.append((args.src, os.path.join(BOARDS, f"board_{style}_{orient}.png")))

    print("处理棋盘资源（索引色 PNG + tRNS alpha）")
    tb = ta = 0
    for src, dst in jobs:
        if not os.path.exists(src):
            sys.exit(f"源图不存在：{src}")
        b, a = build_one(src, dst)
        tb += b
        ta += a
    if len(jobs) > 1:
        print(f"  合计 {tb} -> {ta} 字节（{(ta - tb) / tb * 100:+.0f}%）")
    print("提示：若新增/改名了资源，请同步 utils/chess/boardStyles.ts 的 require() 路径。")


def main():
    ap = argparse.ArgumentParser(description="棋盘背景图标准处理流程")
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="生成索引色棋盘资源")
    b.add_argument("--src", help="单张源图路径")
    b.add_argument("--style", choices=STYLES, help="样式 id")
    b.add_argument("--blacktop", action="store_true", help="黑方在下（否则红方在下）")
    b.add_argument("--all", action="store_true", help="批量处理 _source/ 下全部源图")
    b.set_defaults(func=cmd_build)

    args = ap.parse_args()
    if args.cmd == "build" and not args.all and not args.src:
        sys.exit("需要 --src 或 --all")
    args.func(args)


if __name__ == "__main__":
    main()
