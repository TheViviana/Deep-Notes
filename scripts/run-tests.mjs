#!/usr/bin/env node
// 测试运行器：源码里 JSX 与 import.meta.env 不能被 node 直接执行，
// 先用 esbuild（vite 自带依赖）把 tests/all.mjs 打成 node 可跑的 ESM，再执行 node:test。
import {build} from 'esbuild';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'deep-notes-tests-'));
const out = join(dir, 'all.mjs');
try {
  await build({
    entryPoints: [join(ROOT, 'tests/all.mjs')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'transform',
    define: {'import.meta.env': '{"BASE_URL":"/"}'},
    // KaTeX 的 CSS 引用 woff/woff2/ttf 字体，node 测试环境不需要真字体
    loader: {'.css': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty'},
    logLevel: 'warning'
  });
  const r = spawnSync(process.execPath, [out], {stdio: 'inherit'});
  process.exitCode = r.status ?? 1;
} catch (e) {
  console.error('测试打包失败：', e.message);
  process.exitCode = 1;
} finally {
  rmSync(dir, {recursive: true, force: true});
}
