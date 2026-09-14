# HDRI 使用说明（public/hdri）

本目录包含两张 HDRI（Radiance `.hdr`）：

- `daytime.hdr`
- `sunset.hdr`

## 推荐用法（Three.js）

在 Three.js 里通常将 HDRI 用作 **环境光/反射（IBL）**：

1. 用 `RGBELoader` 加载 `.hdr`
2. 用 `PMREMGenerator` 生成预过滤环境贴图
3. 设置 `scene.environment = pmremTexture`

本项目当前实现：`World3D.setupEnvironment()` 会把 HDRI **同时设置为**：

- `scene.background = hdriTexture`（更写实的天空背景）
- `scene.environment = pmremTexture`（更真实的反射/环境光）

如果你更偏“可控/不抢戏”，可以把背景改回纯色或程序天空，只保留 `scene.environment`。

## 溯源与协议

如果这些 HDRI 来自 Poly Haven，则其资源通常为 **CC0**（可商用、可修改、无需署名）。
建议你补充原始下载链接，方便之后做论文/材料归档与溯源（见 `public/hdri/SOURCES.md`）。
