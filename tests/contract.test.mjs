// CLI 与应用内解析的契约测试：同一个知识库，命令行 import-notes.mjs 的产物
// 与 parseVault 的结果必须在 id / path / keep / 正文等字段上一致（两侧规则永不分叉）；
// 以及「连续两次解析结果逐位一致」——自动同步的判等靠它保证零写盘。
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, readdirSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseVault} from '../src/neural/importer.js';

// __TEST_ROOT__ 由 scripts/run-tests.mjs 在打包时注入仓库根目录
// （打包后 import.meta.url 指向临时 bundle，不能用它定位仓库文件）
const VAULT = join(__TEST_ROOT__, 'examples/vault');

// 把磁盘上的知识库变成 parseVault 可用的 File 桩（webkitRelativePath 第一段是库名）
function collect(dir, rel, out) {
  for (const e of readdirSync(dir, {withFileTypes: true})) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const r = rel ? rel + '/' + e.name : e.name;
    const full = join(dir, e.name);
    if (e.isDirectory()) collect(full, r, out);
    else if (/\.(md|markdown)$/i.test(e.name)) out.push({
      name: e.name, webkitRelativePath: 'vault/' + r, lastModified: 0,
      text: async () => readFileSync(full, 'utf8'),
    });
  }
  return out;
}

test('CLI 与应用内解析同一知识库：id / path / keep / 正文完全一致', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'deep-notes-contract-'));
  try {
    const out = join(tmp, 'data.js');
    execFileSync(process.execPath, [join(__TEST_ROOT__, 'scripts/import-notes.mjs'), '--vault', VAULT, '--out', out], {stdio: 'pipe'});
    const cli = await import(pathToFileURL(out).href);
    const app = await parseVault(collect(VAULT, '', []));

    // 方法笔记：path（压平规则）、id（deepnotes-id / 散列）、keep、正文逐条一致
    const cliNotes = new Map(cli.notes.map(n => [n.title, n]));
    assert.equal(cli.notes.length, app.notes.length);
    for (const n of app.notes) {
      const c = cliNotes.get(n.title);
      assert.ok(c, `CLI 缺少方法笔记：${n.title}`);
      assert.equal(c.path, n.path, `path 不一致：${n.title}`);
      assert.equal(c.id, n.id, `id 不一致：${n.title}`);
      assert.equal(c.body, n.body, `正文不一致：${n.title}`);
      assert.deepEqual(c.keep ?? {}, n.keep ?? {}, `keep 不一致：${n.title}`);
    }

    // 作品：CLI 的 posts + postContent（按 id 关联）与 parseVault 的 works 一致
    const cliPosts = new Map(cli.posts.map(p => [p.id, p]));
    const cliContent = new Map(cli.postContent.map(c => [c.id, c]));
    assert.equal(cli.posts.length, app.works.length);
    for (const w of app.works) {
      const p = cliPosts.get(w.id), c = cliContent.get(w.id);
      assert.ok(p && c, `CLI 缺少作品：${w.title}（${w.id}）`);
      assert.equal(p.title, w.title);
      assert.equal(c.body, w.body, `作品正文不一致：${w.title}`);
      assert.deepEqual(c.tags, w.tags, `作品标签不一致：${w.title}`);
      assert.equal(p.views, w.views);
      // 指标字段两侧同读：缺侧会让同一篇作品在命令行导入时有数据、应用内导入时全是 null
      assert.equal(p.follows, w.follows, `作品涨粉不一致：${w.title}`);
      assert.equal(p.shares, w.shares, `作品分享不一致：${w.title}`);
      assert.equal(p.impressions, w.impressions, `作品曝光不一致：${w.title}`);
      assert.equal(p.ctr, w.ctr, `作品点击率不一致：${w.title}`);
      assert.equal(p.duration, w.duration, `作品时长不一致：${w.title}`);
    }

    // 选题 / 草稿 / 档案：数量与关键字段一致
    assert.equal(cli.seedIdeas.length, app.ideas.length);
    assert.equal(cli.seedDrafts.length, app.drafts.length);
    assert.equal((cli.seedArchives || []).length, app.archives.length);
    const cliIdea = new Map(cli.seedIdeas.map(i => [i.title, i]));
    for (const i of app.ideas) {
      const c = cliIdea.get(i.title);
      assert.ok(c, `CLI 缺少选题：${i.title}`);
      assert.equal(c.id, i.id);
      assert.equal(c.priority, i.priority);
    }
    const cliDraft = new Map(cli.seedDrafts.map(d => [d.title, d]));
    for (const d of app.drafts) {
      const c = cliDraft.get(d.title);
      assert.ok(c, `CLI 缺少草稿：${d.title}`);
      assert.equal(c.id, d.id);
      assert.equal(c.body, d.body);
      assert.equal(c.source, d.source);
    }
    const cliArc = new Map((cli.seedArchives || []).map(a => [a.title, a]));
    for (const a of app.archives) {
      const c = cliArc.get(a.title);
      assert.ok(c, `CLI 缺少档案：${a.title}`);
      assert.equal(c.id, a.id);
      assert.equal(c.body, a.body);
    }

    // 概念词表：名字集合一致
    assert.deepEqual(new Set(cli.concepts.map(([n]) => n)), new Set(app.concepts.map(([n]) => n)));
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('连续两次解析结果逐位一致（自动同步判等通过 → 零写盘）', async () => {
  const files = collect(VAULT, '', []);
  const r1 = await parseVault(files);
  const r2 = await parseVault(files);
  assert.deepEqual(r2, r1); // 任何字段漂移（id / 排序 / keep）都会触发全库重写
});
