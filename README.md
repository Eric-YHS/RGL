# 红绿灯实验交互站点（原型）

![CI](https://img.shields.io/github/actions/workflow/status/Eric-YHS/RGL/ci.yml?branch=main&logo=githubactions&logoColor=white&label=CI)
![License](https://img.shields.io/badge/license-MIT-green)

行人过街信号实验的浏览器交互站点：Three.js 渲染城市场景，被试在路线上按 `WALK` 键表达
「可以起步」的判断，实验过程与闯红灯记录可导出为 `xlsx`。纯前端项目，Vite + TypeScript，
无后端、无构建期框架。

## 本地运行

1. 安装 Node.js（建议 18+ / 20+，见 `package.json` 的 `engines`）。
2. 安装依赖：`npm install`
3. 启动开发服务器：`npm run dev`

其它脚本：

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发服务器 |
| `npm run build` | 产出 `dist/` |
| `npm run preview` | 本地预览构建结果 |
| `npm run typecheck` | `tsc --noEmit` 类型检查（CI 会跑） |

## 目录结构

```
index.html
src/main.ts                        # 入口：初始化实验与场景
src/experiment/{engine,logger,types,utils}.ts   # 实验流程、按键/事件记录、类型与工具
src/scene/{world3d,proceduralTextures}.ts       # Three.js 场景、光照/后处理与程序化贴图
public/models/                     # Kenney City Kit Commercial 模型（CC0）
public/textures/polyhaven/         # Poly Haven PBR 贴图（CC0），清单见 manifest.json
public/hdri/                       # 环境光照用 HDRI
LOOKDEV.md                         # 画面 look-dev 记录
task.md                            # 需求与实现任务清单
```

## 进入设置

打开统一链接后，系统会先让你选择呈现方式：
- 全呈现（显示小地图 + HUD 显示 1/5）
- 逐个呈现（隐藏小地图 + 雾中渐显）

## URL 参数

- `pid`：被试编号（可选，写入导出的 xlsx）

信号灯数量固定为：
- 练习：2 个
- 正式实验：5 个

示例：
- `/?pid=001`

## 示例短片

如需在练习说明页展示“示例短片同步播放”，请将视频文件放到：
- `public/demo.mp4`

该文件不入库（体积较大），缺失时练习页不展示短片。

## 数据导出

正式实验结束后可导出一个 `xlsx` 文件（包含两个 sheet）：
- `WALK 按键表`：所有按下 `WALK` 的记录
- `WALK 按键表`中包含“位置刻度(0-10)”列，用于记录按键时的路线位置（正式实验 5 个信号灯对应 0..10；信号灯位置为 2/4/6/8/10）
- `闯红灯表`：所有闯红灯的记录

## 部署

`npm run build` 后把 `dist/` 交给任意静态服务器即可（实验数据只在浏览器内产生并导出，
不依赖服务端）。实验现场建议固定浏览器版本并全屏运行。

## 资源与许可

- 代码（`src/`、`index.html`、配置文件）采用 [MIT 许可](LICENSE)。
- `public/models/kenney_city-kit-commercial/`：Kenney 的 City Kit Commercial (2.1)，CC0，
  见其 `License.txt`。
- `public/textures/polyhaven/`：Poly Haven 的 PBR 贴图，CC0，来源清单见
  `public/textures/polyhaven/SOURCES.md`。
- `public/hdri/`：`daytime.hdr`、`sunset.hdr` 的原始出处尚未在
  `public/hdri/SOURCES.md` 中登记；如需对外分发或写进论文附录，请先补全来源与许可。
- `public/demo.mp4`（若自行放置）版权自行确认。
