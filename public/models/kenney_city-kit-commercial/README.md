# Kenney City Kit Commercial（2.1）

已整理的 GLB 模型与贴图：

- 模型：`*.glb`
- 贴图：`Textures/colormap.png`

注意：这些 `.glb` 会引用相对路径 `Textures/colormap.png`，因此请保持目录结构不变。

## 协议

本资源包自带 `License.txt`，协议为 **CC0 1.0**（可商用、可修改、无需署名；署名 Kenney 非强制但建议）。

## Three.js 接入建议（不改风格但显著变好看）

1. **近景/中景**：使用 `building-*.glb`、`building-skyscraper-*.glb`
2. **远景/雾后**：使用 `low-detail-building-*.glb`（适合做 LOD）
3. **建筑底部细节**：用 `detail-awning* / detail-overhang* / detail-parasol*` 少量点缀，会立刻增加“商业街”气质

模型清单见：`manifest.json`

