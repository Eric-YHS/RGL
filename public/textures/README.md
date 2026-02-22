# PBR 贴图（public/textures）

本目录用于存放 **PBR 材质贴图**（Albedo/Diffuse、Normal、Roughness、AO 等），用于把当前场景升级为更写实的材质表现。

## 已包含（Poly Haven，1K）

路径：`public/textures/polyhaven/`

- `asphalt_05/`：路面
- `concrete_pavement/`：人行道/路面边缘
- `concrete_tile_facade/`：建筑立面

每套贴图均包含：
- `*_diff_1k.jpg`（颜色贴图，建议按 **sRGB** 处理）
- `*_nor_gl_1k.png`（法线贴图 OpenGL，按 **Linear** 处理）
- `*_arm_1k.jpg`（ARM 复合贴图：**R=AO, G=Roughness, B=Metalness**，按 **Linear** 处理）
- `*_rough_1k.jpg`（粗糙度贴图，按 **Linear** 处理）
- `*_ao_1k.jpg`（AO 贴图，按 **Linear** 处理；在 Three.js 中通常需要 `uv2`）

清单见：`public/textures/polyhaven/manifest.json`

## Three.js 使用要点（写实但不抢戏）

1. **色彩空间**
   - Albedo/Diffuse：sRGB
   - Normal/Roughness/AO：Linear（不要做 sRGB 转换）
2. **重复与各向异性**
   - 地面通常需要 `RepeatWrapping` + 合理 `repeat`
   - 给地面/路面贴图设置较高 `anisotropy`（斜角视角更清晰）
3. **强度克制**
   - `normalScale` 不要太大（写实常用 0.4–1.0 范围内微调）
   - `roughness` 与 `roughnessMap` 一起调（避免“过亮塑料”或“过灰粉笔”）

## 版权与溯源

这些贴图来自 Poly Haven 的公开下载源（通过其 Public API 获取直链）。Poly Haven 的资源通常以 **CC0** 提供。
建议你在论文/材料归档中补充每个资源的原始页面链接与版本信息，以便长期溯源。

已记录本项目使用的贴图 ID：`public/textures/polyhaven/SOURCES.md`
