// 任务清单测试：tasks.jsx 的源码扫描 / 切换，与 renderMarkdown 复选框渲染的序号口径一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import {toggleTaskInSource, collectTasks} from '../src/neural/tasks.jsx';
import {renderMarkdown} from '../src/neural/ArticleView.jsx';

test('toggleTaskInSource 基本切换与序号命中', () => {
  const body = '# 标题\n\n- [ ] 第一件事\n- 普通列表\n- [x] 第二件事\n\n1. [ ] 有序任务\n';
  const b1 = toggleTaskInSource(body, 0);
  assert.ok(b1.includes('- [x] 第一件事'), '第 0 个任务被勾选');
  const b2 = toggleTaskInSource(body, 1);
  assert.ok(b2.includes('- [ ] 第二件事'), '第 1 个任务（大写已完成）被取消勾选');
  const b3 = toggleTaskInSource(body, 2);
  assert.ok(b3.includes('1. [x] 有序任务'), '有序列表任务也能切换');
  // 连续切换回到原样
  assert.equal(toggleTaskInSource(b1, 0), body);
});

test('toggleTaskInSource 越界返回 null，大写 X 也认', () => {
  const body = '- [X] 大写完成\n';
  assert.equal(toggleTaskInSource(body, 1), null);
  assert.equal(toggleTaskInSource(body, -1), null);
  assert.equal(toggleTaskInSource('', 0), null);
  assert.equal(toggleTaskInSource(body, 0), '- [ ] 大写完成\n');
});

test('代码块里的任务标记不参与（围栏与缩进）', () => {
  const body = '- [ ] 真任务\n\n```\n- [ ] 代码里的假任务\n```\n\n    - [ ] 缩进代码里的假任务\n\n- [ ] 第二个真任务\n';
  // 只有 2 个真任务
  assert.equal(toggleTaskInSource(body, 2), null, '代码块里的任务不计数');
  const next = toggleTaskInSource(body, 1);
  assert.ok(next.includes('- [x] 第二个真任务'), '第 1 个命中的是代码块之后的真任务');
  assert.ok(next.includes('- [ ] 代码里的假任务'), '围栏代码内容不被改动');
  assert.ok(next.includes('    - [ ] 缩进代码里的假任务'), '缩进代码内容不被改动');
});

test('引用块里的任务与表格里的类任务文本', () => {
  const body = '> - [ ] 引用任务\n\n| 列 |\n| --- |\n| - [ ] 表格文本 |\n';
  const next = toggleTaskInSource(body, 0);
  assert.ok(next.includes('> - [x] 引用任务'), '引用块任务可切换（marked 也会渲染它的复选框）');
  assert.equal(toggleTaskInSource(body, 1), null, '表格里的 - [ ] 不是列表任务');
});

test('被定义列表吸收的行不算任务（与渲染管线口径一致）', () => {
  const body = '- [ ] 术语行\n: 定义内容\n\n- [ ] 正常任务\n';
  const next = toggleTaskInSource(body, 0);
  assert.ok(next.includes('- [x] 正常任务'), '第 0 个任务是未被吸收的那条');
  assert.ok(next.includes('- [ ] 术语行'), '被定义列表吸收的行不动');
});

test('collectTasks 与 toggleTaskInSource 序号口径一致', () => {
  const works = [{id: 'w1', title: '文章A', body: '- [ ] 甲\n- [x] 乙\n'}];
  const drafts = [{id: 'd1', title: '草稿A', body: '```\n- [ ] 假\n```\n- [ ] 丙\n'}];
  const tasks = collectTasks({works, drafts});
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks.map(t => [t.kind, t.id, t.text, t.checked, t.ti]), [
    ['works', 'w1', '甲', false, 0],
    ['works', 'w1', '乙', true, 1],
    ['drafts', 'd1', '丙', false, 0],
  ]);
  // 每条任务 toggle 后 checked 翻转、文本不变
  for (const t of tasks) {
    const src = (t.kind === 'works' ? works : drafts).find(x => x.id === t.id).body;
    const next = toggleTaskInSource(src, t.ti);
    const after = collectTasks({[t.kind]: [{id: t.id, title: '', body: next}]}).find(x => x.ti === t.ti);
    assert.equal(after.checked, !t.checked, `${t.text} 翻转`);
    assert.equal(after.text, t.text, `${t.text} 文本不变`);
  }
});

test('renderMarkdown 任务复选框：data-ti 递增、taskIndex 缺省时 disabled', () => {
  const html = renderMarkdown('- [ ] 甲\n- [x] 乙\n', {taskIndex: true});
  assert.ok(html.includes('class="md-task" data-ti="0"'), '第 0 个序号');
  assert.ok(html.includes('data-ti="1"'), '序号递增');
  assert.ok(/data-ti="1"[^>]*checked/.test(html), '已完成任务带 checked');
  assert.ok(!html.includes('disabled'), 'taskIndex=true 时不禁用');
  const ro = renderMarkdown('- [ ] 甲\n');
  assert.ok(ro.includes('class="md-task" data-ti="0" disabled'), '缺省只读渲染为 disabled');
  // 代码块里的任务标记不渲染复选框（marked 本来就不管），序号因此不被占用
  const mixed = renderMarkdown('- [ ] 真\n\n```\n- [ ] 假\n```\n\n- [ ] 真二\n', {taskIndex: true});
  assert.ok(/data-ti="1"[^>]*> 真二/.test(mixed), '代码块不占任务序号');
});
