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
- `src/neural/Home.jsx`：光球、水母、触须场景与三层交互（模块内条目 >15 条折叠为「更多」跳内页，概念网络的「更多」跳概念内页）；图例即过滤开关（点击隐藏/显示某类节点，会话内记忆不落盘），选中节点时图谱聚焦其邻域（非邻接降透明）；`Analysis.jsx` 分析栏（含「未链接提及」：他篇正文以纯文本提到本篇标题时列出位置，一键全部转 `[[双链]]`，已有 `[[ ]]` 段不动）；`pages.jsx` 七个内页（作品库 / 方法库 / 创作台 / 选题池 / 阅读区 / 档案区 / 概念网络，概念内页点击概念回到工作台图谱选中）。方法库列表按二级分类分组，支持笔记拖拽归类（分类间 + 拖到顶栏导航跨模块移动，纯 state 更新无刷新）与分类增删改（删除非空分类时内容移入「未分类」，手动空分类存 `-folders-v1`）；阅读区有同构的左侧分类目录（`reading.folder` 字段，手动空分类存 `-read-folders-v1`）。概念网络内页的卡片可展开编辑定义与关键词（存 `-concept-extras-v1`），页头「开始复习」进入闪卡，复习分「概念卡 / 段落卡」两类（段落卡来自编辑器选中文本「存为闪卡」，存 `-para-cards-v1` / `-para-review-v1`）。创作台有「闪念箱」抽屉（随手记想法按天分组，一键转草稿 / 方法笔记，「今日笔记」按日期建/开草稿，存 `-inbox-v1`）。
- `src/neural/CommandPalette.jsx`：全局命令面板，Cmd/Ctrl+K 呼出：全文搜索并打开内容、新建各模块内容、模块与概念网络跳转、导入 / 导出 / 切回示例。
- `src/neural/wiki.jsx`：[[双链与块引用（`[[笔记#小节]]`）共用工具——编辑器补全（`useWikiComplete`）、正文渲染跳转（`resolveTarget` / `scrollToAnchor`）、全库小节索引（`headingMap`），创作台与方法库编辑器共享，AI 双链建议也复用。
- `src/neural/conceptStore.js`：概念扩展信息与复习进度的本地存储（`conceptExtras` / `conceptReview` / `gradeConcept`），以及编辑器存入的段落闪卡（`paraCards` / `paraReview` / `gradePara`），两类卡共用同一条 Leitner 调度曲线。
- `src/neural/Intro.jsx`：开屏动画（关键帧序列：深空星云淡入 → 细小星点从中心向外扩散成星野 → 能量核心球体浮现（几何网格纹路 + 流动蓝色光带 + 三圈细轨道环异速旋转）→ 球体脉冲一次、光环同步扩散成波纹 → 画面渐暗 → DeepNotes 发光字样浮现 → 淡出进入主界面；高 DPR 锐利渲染，主体约 4.6s）。桌面版每次启动播放，网页同一标签页刷新不重播（sessionStorage `neural-splash-seen`）；`prefers-reduced-motion` 或点击/按键直接跳过。
- `src/neural/ArticleView.jsx`：`renderMarkdown` 是全部阅读视图共用的渲染管线——先保护代码段，再按顺序处理：公式摘出进 KaTeX（`$…$` 行内、`$$…$$` 与 `\[…\]` 展示、`\(…\)` 行内，化学式 `\ce{}` 经 `katex/contrib/mhchem`，CSS+字体全本地随包，坏公式回退原文不崩）、脚注（`[^key]` 引用 + 行首定义 → 编号上标 + 文末定义区）、标注块（`> [!note]` 等转加粗标题）、`![[图片.png|宽度]]` 嵌入图（`data-asset`，桌面版经 `vault:asset` 读知识库文件回填，网页版显示占位）、`[[双链]]`、`==高亮==`；Live Preview 镜像层里 dataURL 粘贴图永不显示 base64 源码，直接渲染 `.lm-img` 缩略图。
- `scripts/import-notes.mjs`：笔记导入；`scripts/verify.mjs`：自检。
- `src/neural/importer.js`：软件内知识库导入（目录选择器 + 解析，规则与命令行导入一致；`parseVault(files, target)` 的 target 可指定全部内容归入某个模块，默认 'auto' 按文件夹名分类，未识别的一律作为方法笔记）。导入不设数量上限：文章 / 笔记 / 阅读 / 档案 / 标签 / 概念全部无上限（概念按出现次数排序，命令行 `--max-works` / `--max-notes` 仍可手动限量）。`pickMdFiles()` 供「导入选定内容」挑多个 .md 文件（不带目录，target 强制归类）；阅读区 frontmatter 的 `folder` 字段（分类）会读回 `reading.folder`。
- `src/neural/docImport.js` + `pdfParse.js`：本地文件导入阅读区（PDF / HTML / Markdown / TXT，全离线解析，`pdfjs-dist` 动态 import 拆包）；`src/neural/images.js`：图片支持（`fileToDataUrl` 粘贴/插图压缩进正文、`resolveVaultImg` + `vault:asset` IPC 桌面版按文件名全库搜图回填、`useVaultImages` 全局监听 `.md-preview` 新图、PDF 导出前 `resolveAllInDoc` 等全部解析完，换库 `clearAssetCache`）。
- `src/neural/fileStore.js`：桌面版文件夹知识库（仅 Electron 可用）。导入时在原库旁新建「<原名> - Deep Notes」副本（`vault:prepare-copy` IPC，副本同时带走图片等资源文件，正文里的 `![[图片]]` 引用才能显示）；文件夹名称本身已带「 - Deep Notes」后缀时直接作为工作库使用、不再复制副本。之后编辑经全局 diff（main.jsx）防抖写回库里的 .md，删除的内容移入库的 `.trash`，普通导入的原知识库文件夹内容永不动；根目录路径存 localStorage（`-vault-root-v1`），导入归类方式存 `-vault-target-v1`。**非破坏性增量写盘**：写盘走主进程原子写入（临时文件 + rename，`vault:write`）、空内容拒绝覆盖已有文件（`rejectIncomplete`）、写盘失败自动重试一次再报错、同一文件先 trash 后 write 两个操作都执行（队列按「类型 + rel」入队）；删除 / 移动后自底向上清理空目录（`pruneUp`，跳过根目录与 `.` 开头目录），库里不留空文件夹。**每次打开软件自动同步**：已连接知识库时重新读取文件夹内容并比对（只比会写进文件的字段，忽略 updatedAt / capturedAt 等应用内字段；readings 含 `folder`），有变化才 adoptData 并提示，无变化静默；读到的文件数比上次基线（`-vault-files-v1`）骤减超三成视为「不完整读取」，跳过同步防止整库被清；选题池不落盘，按标题合并（已有优先，文件夹新增补入）；同步走 `adoptData(..., keepFolders)` 保留手动空分类。「导出当前内容」（About 弹窗入口，`exportFiles` / `printArticle`）：把正在看的那篇（文章全文 / 草稿 / 方法笔记 / 阅读 / 档案）导出为 Markdown（桌面版选目录写盘、网页版直接下载）或 PDF（隐藏 iframe 排版后调系统打印「另存为 PDF」）；「导出全部 Markdown」保留在 ⌘K 命令面板里，桌面版选目录逐文件写盘、网页版合并单个 .md 下载；frontmatter 带 `deepnotes-id` 保证再导入不重复，同名标题落盘时追加 id 短码消歧（每组第一条保持原名），readings 的 `folder`（阅读区分类）一并落盘，重导入不丢分类。
- `src/neural/ai.jsx`：AI 助手插件（服务商 / 模型 / 推理等级配置、OpenAI 兼容调用、文件增删改查工具协议、dock 内嵌对话与浮动面板）；`plugins.jsx` 的 `TocPanel` 大纲目录平时收进编辑区右缘竖线、悬停弹出；编辑器增强还提供格式栏「存为闪卡」（选中文字存段落卡）、「插图」按钮（选图片压缩成 dataURL 插入正文）与粘贴图片（截图直接粘进正文）、「AI 双链建议」按钮与「选中 AI 菜单」（选中正文浮出竖向菜单：润色就地替换选区，总结 / 解释 / 延伸 / 定义 / 研究送 AI 面板自动发送，底部小输入框可针对选区提问），AI 两项只在联网开关 + AI 插件启用时可用，未启用呈禁用态（菜单不弹）。
- `electron/main.cjs`、`electron/preload.cjs`、`electron-builder.json`：Electron 桌面版（由 electronizer 生成，生产模式加载 `dist/index.html`；`ai-fetch` IPC 为主进程转发 AI 请求；`vault:*` IPC 为文件夹知识库读写，写操作一律限制在所选根目录内，`preload.cjs` 暴露为 `window.deepnotes.vault`；`vault:prepare-copy` 建副本时连同图片/PDF 等资源文件一并拷走，`vault:asset` 只读返回库内图片 base64——直找路径、找不到按文件名全库搜、越界拒绝；`vault:write` / `vault:export` 为原子写入并拒绝空内容覆盖，`vault:write` / `vault:trash` 成功后自底向上清理空目录）。
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
- `seedReadings`：`id`、`title`、`author`、`source`、`date`（`YYYY-MM-DD`）、`body`（可选 `folder` 分类）
- `seedArchives`：`id`、`title`、`date`（`YYYY-MM-DD`）、`body`
- `concepts`：`[概念名, [关键词…]]`

## 规矩

- **发光的光球和七只水母是核心动效，不能删除、隐藏或改成静态图片。** 光球视频 `public/media/orb.mp4`、水母视频 `public/media/jellyfish.mp4`，逐帧动画在 `src/neural/Home.jsx` 的 `step()`。`npm run verify` 会检查它们还在。
- 动画循环必须保持「先排下一帧、再在 try 里执行本帧」的写法，时间差 `dt` 不能为负：否则某一帧出错就会让光球和水母停在隐形状态（刷新后消失）。
- 光球和水母的视频由 `paintVideo()` 逐帧画到 `<canvas class="vid">` 上显示，`<video class="vsrc">` 透明地留在原位负责播放。不要改回直接显示 `<video>`：有些内置 / 嵌入式浏览器解码正常却不合成视频画面，光球和水母会变成空白。
- `src/data/my-data.js` 含用户个人笔记，已在 `.gitignore`；不要提交、不要写进示例或文档。
- `src/data/sample.js` 与 `examples/vault/` 只能放虚构内容。
- 默认完全断网，数据不出本机。允许联网的出口只有两个插件：「沉浸式翻译」与「AI 助手」，且都必须在顶栏联网开关打开时才会访问各自的服务（AI 助手还需在插件管理里启用，API key 只存本机 localStorage，请求走 OpenAI 兼容协议，Electron 桌面版经主进程转发）；除此之外不要加入任何联网请求、统计脚本或 AI 调用，也不要改动联网开关的默认关闭状态。
- 保持「减少动态效果」支持（`prefers-reduced-motion`）和中英双语文案。

## 改完之后的验证

1. `npm run verify` 和 `npm run build` 通过。
2. `npm run dev` 打开页面，确认：开屏动画播放一次后淡出（刷新不重播）；首页光球和七只水母出现，全部模块条目与标签都停在底部问答坞上方、互不遮挡；点「作品库」水母触须伞状展开；点一篇内容右侧弹出分析栏；七个内页（作品库 / 方法库 / 创作台 / 选题池 / 阅读区 / 档案区 / 概念网络）正常；Cmd/Ctrl+K 命令面板能搜索并打开内容；浏览器控制台没有报错。
