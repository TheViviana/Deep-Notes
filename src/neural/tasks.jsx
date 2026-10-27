// 任务清单：GFM `- [ ]` / `- [x]` 任务的源码扫描、切换与全库汇总面板。
// 扫描规则与 ArticleView renderMarkdown 的代码段切分严格一致（围栏 / 缩进代码块不算任务），
// 保证预览里第 n 个复选框（data-ti）与源码里第 n 个任务标记一一对应。
import React, {useMemo, useState} from 'react';
import {Icon} from './icons';
import {Modal} from './Modal.jsx';

// 任务行：允许 > 引用前缀（marked 会把引用块里的任务列表也渲染成复选框），有序 / 无序列表均可
const TASK_RE = /^(\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[)( |x|X)(\]\s*)/;

// 逐行扫描正文，返回代码块之外的任务行：{line（行号）, checked, text（标记后的文字）}
// 围栏（``` / ~~~，0-3 空格缩进）与「空行后 4 空格 / tab 起」的缩进代码块整段跳过；
// 脚注定义与续行（渲染管线 proc() 会把它们从正文摘掉，marked 不会渲染其中的复选框）同样跳过；
// 被定义列表吸收的「任务行 + 下一行 : 定义」不算任务（marked 不会给它渲染复选框，跳过保持序号一致）。
function scanLines(body) {
  const lines = String(body || '').split('\n');
  const hits = [];
  let fence = null, inIndent = false, inFootnote = false, prevBlank = true, prevList = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const fm = ln.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) { // 围栏代码块内：直到同种标记的闭合围栏
      const close = ln.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence) fence = null;
      continue;
    }
    if (inFootnote) { // 脚注续行：≥2 空格 / tab 开头或空行延续（与 renderMarkdown 的脚注吸收一致）
      if (ln.length === 0 || /^(?:[ \t]{2,}|\t)/.test(ln)) continue;
      inFootnote = false; // 落回普通文本，继续向下判定
    }
    if (inIndent) { // 缩进代码块内：缩进行或空行延续
      if (/^( {4}|\t)/.test(ln) || !ln.trim()) continue;
      inIndent = false; // 当前行落回普通文本，继续向下判定
    }
    if (fm) { fence = fm[1][0]; prevBlank = false; prevList = false; continue; } // 顶栏围栏打断列表上下文：marked 会把栏后空行 + 4 空格缩进判为代码块
    if (/^[ \t]*\[\^([^\]\s]+)\]:[ \t]*(.*)$/.test(ln)) { inFootnote = true; prevBlank = false; continue; } // 脚注定义行：proc() 吸收，marked 见不到
    if (prevBlank && !prevList && /^( {4}|\t)\S/.test(ln)) { inIndent = true; prevBlank = false; continue; }
    const m = ln.match(TASK_RE);
    if (m && !/^[ \t]*: /.test(lines[i + 1] || '')) hits.push({line: i, checked: m[2].toLowerCase() === 'x', text: ln.slice(m[0].length).trim()});
    prevBlank = !ln.trim();
    if (ln.trim()) prevList = /^ {0,3}([-+*]|\d+[.)])\s/.test(ln);
  }
  return hits;
}

// 把正文里第 n 个（0 起）任务标记的勾选状态翻转；n 越界返回 null
export function toggleTaskInSource(body, n) {
  const src = String(body ?? '');
  const hits = scanLines(src);
  if (!Number.isInteger(n) || n < 0 || n >= hits.length) return null;
  const lines = src.split('\n');
  const h = hits[n];
  lines[h.line] = lines[h.line].replace(TASK_RE, (_, pre, mark, post) => pre + (mark === ' ' ? 'x' : ' ') + post);
  return lines.join('\n');
}

// 汇总全库任务：ti 是「该条目正文内」的任务序号，与 toggleTaskInSource 口径一致
export function collectTasks({works = [], notes = [], drafts = [], readings = [], archives = []} = {}) {
  const out = [];
  const push = (kind, it) => scanLines(it.body).forEach((h, ti) =>
    out.push({kind, id: it.id, title: it.title || '未命名', text: h.text, checked: h.checked, ti}));
  for (const it of works) push('works', it);
  for (const it of notes) push('notes', it);
  for (const it of drafts) push('drafts', it);
  for (const it of readings) push('readings', it);
  for (const it of archives) push('archives', it);
  return out;
}

const KIND_META = {
  works: {zh: '作品', en: 'Works', gid: 'post'},
  notes: {zh: '方法笔记', en: 'Notes', gid: 'note'},
  drafts: {zh: '草稿', en: 'Drafts', gid: 'draft'},
  readings: {zh: '阅读', en: 'Readings', gid: 'reading'},
  archives: {zh: '档案', en: 'Archives', gid: 'archive'},
};

// 全库任务汇总面板：⌘K / 关于弹窗打开；勾选就地回写正文（走全局 diff 写盘），点标题跳到原文
export function TasksModal({works, notes, drafts, readings, archives, onClose, onToggle, onJump}) {
  const [filter, setFilter] = useState('open'); // all | open | done
  const tasks = useMemo(() => collectTasks({works, notes, drafts, readings, archives}), [works, notes, drafts, readings, archives]);
  const doneCount = tasks.filter(t => t.checked).length;
  const shown = tasks.filter(t => filter === 'all' || (filter === 'done') === t.checked);
  const groups = useMemo(() => {
    const map = new Map();
    for (const t of shown) { if (!map.has(t.kind)) map.set(t.kind, []); map.get(t.kind).push(t); }
    return [...map.entries()];
  }, [shown]);
  return <Modal title="任务清单" en="Task list" onClose={onClose} wide>
    <div className="about tasks-modal">
      <div className="tasks-head">
        <div className="seg" role="group" aria-label="筛选任务">
          {[['open', '待办', 'Open'], ['done', '已完成', 'Done'], ['all', '全部', 'All']].map(([k, zh, en]) =>
            <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>{zh}<em>{en}</em></button>)}
        </div>
        <span className="quiet">{doneCount}/{tasks.length} 已完成 <em>done</em></span>
      </div>
      {!tasks.length && <p className="quiet">正文里还没有任务。用 <code>- [ ] 待办事项</code> 的写法在任何内容里添加，预览模式可以直接勾选。<em>Add tasks with - [ ] in any document.</em></p>}
      {groups.map(([kind, list]) => {
        const meta = KIND_META[kind] || {zh: kind, en: '', gid: kind};
        return <div key={kind} className="snap-group tasks-group">
          <div className="tasks-kind">{meta.zh} <em>{meta.en}</em><b>{list.length}</b></div>
          {list.map(t => <div key={`${kind}:${t.id}:${t.ti}`} className={`snap-row task-row${t.checked ? ' done' : ''}`}>
            <input type="checkbox" checked={t.checked} aria-label={t.checked ? '标为未完成' : '标为完成'}
              onChange={() => onToggle(t.kind, t.id, t.ti)}/>
            <button className="task-text" title="跳到原文 · Open source" onClick={() => onJump(`${meta.gid}:${t.id}`)}>{t.text || '（空任务）'}</button>
            <button className="task-src" title={`打开《${t.title}》`} onClick={() => onJump(`${meta.gid}:${t.id}`)}>{t.title}</button>
          </div>)}
        </div>;
      })}
    </div>
  </Modal>;
}
