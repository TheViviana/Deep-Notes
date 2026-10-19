# AGENTS.md

写给在这个仓库里工作的 AI 智能体（Codex、Kimi、Cursor、Claude Code 等）。

## 来源与声明

- 本仓库（TheViviana/Deep-Notes）创建自 [luoluo-121/neural-creator-dashboard](https://github.com/luoluo-121/neural-creator-dashboard)（v0.2.0，原「创作神经网络看板」），原项目的 LICENSE（PolyForm Noncommercial 1.0.0）与 NOTICE.md 必须原样保留，再分发不得删除或改动。
- 本仓库相对原项目的全部修改代码由 **Trae CN**（AI 编程助手，模型 GLM）多轮对话编写。
- 详细的功能说明、安装方式与使用许可见仓库 `README.md`；面向使用者的教程见 `docs/使用教程.md`。

## 项目

Deep Notes（深度笔记）：原「创作神经网络看板」（neural-creator-dashboard v0.2.0）的修改版，React 19 + Vite 7 的纯前端页面，把作品、方法笔记、选题、草稿推导成一张神经网络图谱。默认断网、默认不调用 AI，用户数据只在本地。

## 命令

| 命令 | 作用 |
|---|---|
| `npm install` | 安装依赖（需要 Node.js 20.19+ 或 22.12+） |
| `npm run dev` | 开发服务器，默认 http://127.0.0.1:5173/ |
| `npm run build` | 构建静态文件到 `dist/` |
| `npm run import -- --vault <笔记文件夹>` | 把 Markdown / Obsidian 笔记导入成 `src/data/my-data.js` 并切换过去；`--help` 查看选项，`--reset` 切回示例 |
| `npm run verify` | 检查 skill 格式、导入脚本和当前数据结构 |
| `npm test` | 运行单元测试（`tests/`，经 esbuild 打包后跑 node:test） |
| `npm run electron:dev` | Electron 开发模式（同时起 Vite 和桌面壳，支持热更新） |
| `npm run electron:dist:mac` | 先 `npm run build` 再打包 macOS 应用，产物在 `electron-dist/`（已 gitignore，不进仓库） |

## 结构

- `index.html`：页面入口，加载 `src/neural/main.jsx`。
- `src/neural/theme.js`、`neural.css` 顶部的 CSS 变量：配色（只有一套银灰配色）。
- `src/config.js`：品牌、头像、页脚、localStorage 前缀。
- `src/data/index.js`：数据入口，只有一行 `export * from './sample.js'` 或 `'./my-data.js'`。
- `src/data/sample.js`：虚构示例数据，也是数据字段的权威说明。
- `src/neural/graph.js`：图谱推导（目录归属、双链、选题来源、话题、概念提及、双向共振）、布局和本地检索。
- `src/neural/Home.jsx`：光球、水母、触须场景与三层交互（模块内条目 >15 条折叠为「更多」跳内页）；`Analysis.jsx` 分析栏；`pages.jsx` 五个内页（作品库 / 方法库 / 创作台 / 选题池 / 阅读区）。
- `scripts/import-notes.mjs`：笔记导入；`scripts/verify.mjs`：自检。
- `src/neural/importer.js`：软件内知识库导入（目录选择器 + 解析，规则与命令行导入一致；`parseVault(files, target)` 的 target 可指定全部内容归入某个模块，默认 'auto' 按文件夹名分类，未识别的一律作为方法笔记）。
- `src/neural/fileStore.js`：桌面版文件夹知识库（仅 Electron 可用）。导入时在原库旁新建「<原名> - Deep Notes」副本（`vault:prepare-copy` IPC），之后编辑经全局 diff（main.jsx）防抖写回副本里的 .md，删除的内容移入副本 `.trash`，原知识库文件夹内容永不动；根目录路径存 localStorage（`-vault-root-v1`）。
- `src/neural/ai.jsx`：AI 助手插件（服务商 / 模型 / 推理等级配置、OpenAI 兼容调用、文件增删改查工具协议、dock 内嵌对话与浮动面板）；`plugins.jsx` 的 `TocPanel` 大纲目录平时收进编辑区右缘竖线、悬停弹出。
- `electron/main.cjs`、`electron/preload.cjs`、`electron-builder.json`：Electron 桌面版（由 electronizer 生成，生产模式加载 `dist/index.html`；`ai-fetch` IPC 为主进程转发 AI 请求；`vault:*` IPC 为文件夹知识库读写，写操作一律限制在所选根目录内，`preload.cjs` 暴露为 `window.deepnotes.vault`）。
- `skills/neural-creator-dashboard/SKILL.md`：通用 Agent Skill，可用 `npx skills add` 安装到各家智能体。
- `examples/vault/`：虚构的示例笔记库，演示导入格式。
- `docs/使用教程.md`：面向使用者的完整功能教程（安装、三视图、插件、AI 助手、数据与隐私）。
- `tests/`：单元测试（图谱推导 / 知识库导入 / Markdown 渲染 / 示例数据完整性），`npm test` 运行。

## 数据字段（`src/data/*.js` 的导出）

- `snapshot`：`account`、`followers`、`capturedAt`、`publishedFrom`、`publishedTo`、`source`
- `posts`：`id`、`title`、`date`（`YYYY-MM-DD HH:mm`）、`views`（数字，缺失写 0）、`likes`、`comments`、`saves`、`shares`、`follows`、`impressions`、`ctr`、`duration`（缺失写 `null`）
- `postContent`：与 `posts` 按 `title` 对应，`body`、`tags`、`media`（`images` / `video`）
- `notes`：`id`、`title`、`path`（形如 `05-方法库 methods/<子目录>/<文件名>.md`）、`body`
- `seedIdeas`：`id`（数字）、`title`、`platform`、`priority`（高 / 中 / 低）、`status`（待写 / 待扩展 / 已转草稿）、`note`
- `seedDrafts`：`id`、`title`、`body`、`source`（来源选题 id 或 `null`）
- `seedReadings`：`id`、`title`、`author`、`source`、`date`（`YYYY-MM-DD`）、`body`
- `concepts`：`[概念名, [关键词…]]`

## 规矩

- **发光的光球和六只水母是核心动效，不能删除、隐藏或改成静态图片。** 光球视频 `public/media/orb.mp4`、水母视频 `public/media/jellyfish.mp4`，逐帧动画在 `src/neural/Home.jsx` 的 `step()`。`npm run verify` 会检查它们还在。
- 动画循环必须保持「先排下一帧、再在 try 里执行本帧」的写法，时间差 `dt` 不能为负：否则某一帧出错就会让光球和水母停在隐形状态（刷新后消失）。
- 光球和水母的视频由 `paintVideo()` 逐帧画到 `<canvas class="vid">` 上显示，`<video class="vsrc">` 透明地留在原位负责播放。不要改回直接显示 `<video>`：有些内置 / 嵌入式浏览器解码正常却不合成视频画面，光球和水母会变成空白。
- `src/data/my-data.js` 含用户个人笔记，已在 `.gitignore`；不要提交、不要写进示例或文档。
- `src/data/sample.js` 与 `examples/vault/` 只能放虚构内容。
- 默认完全断网，数据不出本机。允许联网的出口只有两个插件：「沉浸式翻译」与「AI 助手」，且都必须在顶栏联网开关打开时才会访问各自的服务（AI 助手还需在插件管理里启用，API key 只存本机 localStorage，请求走 OpenAI 兼容协议，Electron 桌面版经主进程转发）；除此之外不要加入任何联网请求、统计脚本或 AI 调用，也不要改动联网开关的默认关闭状态。
- 保持「减少动态效果」支持（`prefers-reduced-motion`）和中英双语文案。

## 改完之后的验证

1. `npm run verify` 和 `npm run build` 通过。
2. `npm run dev` 打开页面，确认：首页光球和六只水母出现；点「作品库」水母触须伞状展开；点一篇内容右侧弹出分析栏；五个内页（作品库 / 方法库 / 创作台 / 选题池 / 阅读区）正常；浏览器控制台没有报错。
