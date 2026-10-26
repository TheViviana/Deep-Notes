// 主进程行为守护测试：electron/main.cjs 依赖 electron 运行时无法在 node 里执行，
// 但这些安全 / 健壮性修复必须钉死——用源码断言防止回归被悄悄删掉（与 verify.mjs 的核心动效检查同一思路）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

// __TEST_ROOT__ 由 scripts/run-tests.mjs 在打包时注入仓库根目录
// （打包后 import.meta.url 指向临时 bundle，不能用它定位仓库文件）
const src = readFileSync(join(__TEST_ROOT__, 'electron/main.cjs'), 'utf8');

test('readMd：iCloud 未下载占位（.原名.icloud）计入 unreadable，绝不静默跳过', () => {
  assert.match(src, /\\\.icloud\$\/i/);
  assert.match(src, /unreadable\.push/);
});

test('atomicWrite：fsync 落盘后才 rename，句柄 finally 关闭（含退出同步通道）', () => {
  assert.match(src, /await fh\.sync\(\)/);
  assert.match(src, /finally \{\s*await fh\.close\(\)/);
  assert.match(src, /fs\.fsyncSync\(fd\)/); // vault:flush-sync 的同步版
});

test('vault:move：目标已存在时拒绝覆盖（rename 不许静默顶掉别的文件），ENOENT 仍放行', () => {
  assert.match(src, /目标已存在，拒绝覆盖/);
  assert.match(src, /err\?\.code === 'ENOENT'/);
  // 幂等：源已移走（重试）时目标已在也视为成功，不再误报「目标已存在」
  assert.match(src, /srcExists/);
});

test('readMd：超过 1 小时的写入临时文件顺手清理', () => {
  assert.match(src, /\\\.tmp-/);
  assert.match(src, /60 \* 60 \* 1000/);
});

test('ai-fetch：域名先解析成 IP 查内网段（DNS rebinding），90 秒超时', () => {
  assert.match(src, /dns\.promises\.lookup/);
  assert.match(src, /AbortSignal\.timeout\(90_000\)/);
});

test('窗口：will-navigate 拦截 + openExternal 只放行 http(s)/mailto', () => {
  assert.match(src, /will-navigate/);
  assert.match(src, /\^\(https\?:\|mailto:\)/i);
  assert.match(src, /e\.preventDefault\(\)/);
});

// —— 文件恢复快照网（对标 Obsidian File Recovery）：本应用覆盖库内文件前，旧内容先进
// userData 的快照库（7 天 TTL、每文件 30 份、内容去重），快照失败绝不阻塞写盘 ——

test('写前快照：vault:write / vault:export / flush-sync 三条写盘路径覆盖前都先备份旧内容', () => {
  assert.match(src, /const crypto = require\('crypto'\)/);
  assert.match(src, /async function snapshotBeforeWrite/);
  assert.match(src, /function snapshotBeforeWriteSync/); // 退出同步通道用同步版
  assert.match(src, /await snapshotBeforeWrite\(root, full, body\)/); // vault:write
  assert.match(src, /await snapshotBeforeWrite\(root, full, f\.body\)/); // vault:export
  assert.match(src, /snapshotBeforeWriteSync\(op\.root, full, op\.body\)/); // flush-sync
  assert.match(src, /SNAP_TTL = 7 \* 24 \* 60 \* 60 \* 1000/); // 保留 7 天
  assert.match(src, /SNAP_KEEP = 30/); // 每文件最多 30 份（超出删最旧）
  assert.match(src, /内容去重/); // 与该文件最新一份快照相同就跳过
  assert.match(src, /catch \{\} \/\/ 快照是保底网/); // 快照自身故障不影响正常写盘
});

test('文件恢复 IPC：快照列表与读取都限制在快照目录内，读取拒绝符号链接越界', () => {
  assert.match(src, /ipcMain\.handle\('vault:snapshots'/);
  assert.match(src, /ipcMain\.handle\('vault:snapshot-read'/);
  assert.match(src, /inside\(base, full\)/);
  assert.match(src, /isSymlink\(full\)/);
  assert.match(src, /SNAP_LIST_MAX/);
  // preload 只暴露读取通道，不出写快照的口子
  const pre = readFileSync(join(__TEST_ROOT__, 'electron/preload.cjs'), 'utf8');
  assert.match(pre, /snapshots: root => ipcRenderer\.invoke\('vault:snapshots'/);
  assert.match(pre, /snapshotRead: \(root, file\) => ipcRenderer\.invoke\('vault:snapshot-read'/);
});

// —— 审计 v3 回归 ——

test('findAsset：符号链接与目录一律拒绝，命中必须落在授权根内（审计 A1）', () => {
  assert.match(src, /function assetOk\(p, roots\)/);
  assert.match(src, /isSymlink\(p\) \|\| !fs\.statSync\(p\)\.isFile\(\)/);
  assert.match(src, /roots\.some\(r => inside\(r, p\)\)/);
});

test('findAsset：原库回退先过白名单再纳入搜索；路径缓存有上限（审计 A2 / B4）', () => {
  assert.match(src, /rootAuthorized\(src\)/); // 回退原库必须是授权过的根
  assert.match(src, /ASSET_CACHE_MAX = 256/); // 按文件名全库搜的结果缓存设上限
  assert.match(src, /assetCacheSet/);
  assert.match(src, /工作库直找永远先于缓存/); // B4：源库旧缓存命中不能压过工作库后来放置的同名文件
});

test('写前快照：整棵树周期性清理、同毫秒文件名去重、同步通道内容去重（审计 B1/B3/B5/B2）', () => {
  assert.match(src, /SNAP_PRUNE_INTERVAL = 24 \* 60 \* 60 \* 1000/); // 每进程最多一天一次周期清理（不再用一次性布尔）
  assert.match(src, /snapLastPrune/);
  assert.match(src, /function uniqueSnapPath/); // 同毫秒多次写同一文件追加 -1/-2 后缀
  assert.match(src, /_\\d\{13,\}\(\?:-\\d\+\)\?\\\.md\$/); // 去重匹配带后缀的新文件名
  // 退出同步通道（B2）：同样内容去重 + 超限截断
  const syncBody = src.slice(src.indexOf('function snapshotBeforeWriteSync'));
  assert.match(syncBody, /names\[names\.length - 1\]/);
  assert.match(syncBody, /capSnapshots/);
});

// —— 写序号守卫（慢盘上的迟到旧写不得回滚已落盘的新内容）——

test('写序号守卫：vault:write 与退出同步通道都按序号拦截过期写', () => {
  assert.match(src, /const writeEpochs = new Map\(\)/);
  assert.match(src, /function writeGuard\(full, epoch\)/);
  assert.match(src, /const stale = writeGuard\(full, epoch\)/); // vault:write
  assert.match(src, /const stale = writeGuard\(full, op\?\.epoch\)/); // vault:flush-sync
  assert.match(src, /const guard = epoch \? \(\) => \(writeEpochs\.get\(path\.resolve\(full\)\) \|\| 0\) > epoch : null/);
  // rename 前最后一刻再过一次：写盘期间同步通道可能已用更新版本落盘
  assert.match(src, /if \(guard && guard\(\)\)/);
  // 过期写按成功返回：内容已有更新版本，渲染层不必重试也不必留底
  assert.match(src, /\{ ok: true, stale: true \}/);
  const pre = readFileSync(join(__TEST_ROOT__, 'electron/preload.cjs'), 'utf8');
  assert.match(pre, /write: \(root, rel, body, epoch\)/);
});

test('meta 退出同步写：只盖脏键，先把盘上值读回来合并（不许整对象覆盖回滚对面机器）', () => {
  assert.match(src, /Array\.isArray\(dirty\) && dirty\.length/);
  assert.match(src, /payload = \{\.\.\.disk\}/);
  assert.match(src, /e\.returnValue = \{ok: true, data: payload\}/); // 回传实际落盘值供渲染层对齐基线
  const pre = readFileSync(join(__TEST_ROOT__, 'electron/preload.cjs'), 'utf8');
  assert.match(pre, /metaWriteSync: \(root, data, dirty\)/);
});

test('符号链接：库内软链不读取、不入回收站（用户自建的库结构不被同步拆掉）', () => {
  assert.match(src, /e\.isSymbolicLink\(\)/);
  assert.match(src, /目标是符号链接，拒绝移入回收站/);
  assert.match(src, /目标是符号链接，拒绝写入/);
  // 退出同步通道同样口径：软链既不写也不 trash
  const syncBody = src.slice(src.indexOf("ipcMain.on('vault:flush-sync'"));
  assert.match(syncBody, /isSymlink\(full\)/);
});

test('vault:asset：超大图片 / PDF 拒读，不放任数百 MB 经 base64 走 IPC', () => {
  assert.match(src, /ASSET_MAX = 64 \* 1024 \* 1024/);
  assert.match(src, /文件过大/);
});
