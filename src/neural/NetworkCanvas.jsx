import React, {useEffect, useRef} from 'react';
import {KINDS} from './graph';
import {T} from './theme';

const P = T.canvas;
const ADD = P.additive ? 'lighter' : 'source-over';

// —— 预渲染精灵：辉光 / 球体 / 脉冲的径向渐变每帧重建上千次是 GPU 光栅化的主要负担，
// 改成按颜色 + 半径缓存的小画布，每帧只 drawImage，视觉完全一致，图大时帧率不再崩。 ——
const mkSprite = size => { const c = document.createElement('canvas'); c.width = c.height = size; return c; };
const glowSprites = new Map();
function glowOf(color, r) {
  const R = Math.max(4, Math.round(r * 5));
  const key = color + '|' + R;
  if (!glowSprites.has(key)) {
    const c = mkSprite(R * 2), x = c.getContext('2d');
    const g = x.createRadialGradient(R, R, 0, R, R, R);
    g.addColorStop(0, color + P.glow); g.addColorStop(1, color + '00');
    x.fillStyle = g; x.fillRect(0, 0, R * 2, R * 2);
    glowSprites.set(key, c);
  }
  return glowSprites.get(key);
}
const ballSprites = new Map();
function ballOf(color, r) {
  const R = Math.max(1, Math.round(r * 2) / 2);
  const key = color + '|' + R;
  if (!ballSprites.has(key)) {
    const s = Math.ceil(R * 2) + 2, c = mkSprite(s), x = c.getContext('2d'), m = s / 2;
    const g = x.createRadialGradient(m - R * .35, m - R * .35, 0, m, m, R);
    g.addColorStop(0, P.light); g.addColorStop(.45, color); g.addColorStop(1, color + 'aa');
    x.fillStyle = g; x.beginPath(); x.arc(m, m, R, 0, 7); x.fill();
    ballSprites.set(key, c);
  }
  return ballSprites.get(key);
}
const pulseSprites = new Map();
function pulseOf(c) {
  if (!pulseSprites.has(c)) {
    const s = mkSprite(12), x = s.getContext('2d');
    const g = x.createRadialGradient(6, 6, 0, 6, 6, 6);
    g.addColorStop(0, `rgba(${c},1)`); g.addColorStop(1, `rgba(${c},0)`);
    x.fillStyle = g; x.fillRect(0, 0, 12, 12);
    pulseSprites.set(c, s);
  }
  return pulseSprites.get(c);
}

// 背景神经网络：从光球蔓延出的全部笔记、话题与概念；双向连接以金色脉冲往返传递。
export function NetworkCanvas({graph, layout, live, reduced}) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current, ctx = canvas.getContext('2d');
    let raf, W = 0, H = 0, dpr = 1, drew = false;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      if (reduced && drew) draw(performance.now()); // 静态模式：尺寸变化后补画一帧
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(canvas);

    // 按与创作空间的链接层数决定蔓延顺序。
    const depth = new Map([['core', 0]]), q = ['core'];
    while (q.length) {
      const id = q.shift();
      for (const l of graph.links) {
        const o = l.a === id ? l.b : l.b === id ? l.a : null;
        if (o && !depth.has(o)) { depth.set(o, depth.get(id) + 1); q.push(o); }
      }
    }
    const nodes = graph.nodes.filter(n => n.kind !== 'core').map((n, i) => ({
      n, p: layout[n.id], d: depth.get(n.id) ?? 4, seed: (i * 9301 + 49297) % 233280 / 233280,
      r: n.kind === 'folder' ? 3.2 : n.kind === 'tag' ? 1.6 : n.kind === 'concept' ? 2.4 : n.kind === 'ghost' ? 2 : 2.2 + Math.min(n.deg, 14) * .22
    }));
    const byId = new Map(nodes.map(x => [x.n.id, x]));
    // 邻接表：选中节点「聚焦」时只点亮它与直连邻居（含双向、单链、提及等全部连接类型）
    const adj = new Map();
    for (const l of graph.links) {
      if (!adj.has(l.a)) adj.set(l.a, new Set());
      if (!adj.has(l.b)) adj.set(l.b, new Set());
      adj.get(l.a).add(l.b); adj.get(l.b).add(l.a);
    }
    const links = graph.links.filter(l => byId.has(l.a) && byId.has(l.b)).map((l, i) => ({l, A: byId.get(l.a), B: byId.get(l.b), seed: (i * 7919 % 997) / 997}));
    const sparks = Array.from({length: 90}, (_, i) => ({a: i / 90 * Math.PI * 2 + Math.sin(i * 12.9) * .3, v: .35 + (i * 37 % 100) / 100, s: 1 + (i * 13 % 7) / 3}));

    const draw = now => {
      const L = live.current;
      const t = Math.max(0, (now - L.t0) / 1000);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const cx = L.orb.x, cy = L.orb.y;
      const sc = (L.orb.s / 440) * Math.min(W * .37 / 380, H * .36 / 300) * (L.stage === 'hub' ? 1 : .55);
      const hover = L.hover;
      // 过滤：图例里关掉的类型整个不画（连线两端都隐藏才整条隐藏）
      const off = L.filter && L.filter.size ? L.filter : null;
      // 聚焦：选中一篇内容时，只点亮它与直连邻居，其余节点大幅淡出
      const focusSel = L.stage === 'note' && L.sel && byId.has(L.sel) ? L.sel : null;
      let hl = null;
      if (focusSel) hl = new Set([focusSel, ...(adj.get(focusSel) || [])]);
      else if (hover) {
        hl = new Set(graph.nodes.filter(n => n.kind === hover).map(n => n.id));
        if (hl) for (const l of graph.links) { if (hl.has(l.a) && l.kind !== 'contain') hl.add(l.b); }
      }
      const grow = reduced ? 1 : Math.min(1, Math.max(0, (t - .35) / 2.2));
      const prog = x => reduced ? 1 : Math.min(1, Math.max(0, (t - .4 - x.d * .32 - x.seed * .35) / .9));
      const pos = x => {
        const p = prog(x), e = 1 - Math.pow(1 - p, 3);
        const sway = reduced || L.paused ? 0 : Math.sin(t * .5 + x.seed * 6.28) * 3;
        return [cx + x.p[0] * sc * e + sway, cy + x.p[1] * sc * e + Math.cos(t * .4 + x.seed * 9) * (reduced || L.paused ? 0 : 2.5), p];
      };
      for (const x of nodes) x.s = pos(x);

      // 光球点亮时的粒子迸发
      if (!reduced && t < 2.2) {
        const k = t / 2.2;
        ctx.globalCompositeOperation = ADD;
        for (const s of sparks) {
          const d = (40 + s.v * 420) * (1 - Math.pow(1 - k, 2.4)) * (L.orb.s / 440);
          const a = Math.max(0, 1 - k) * .9;
          const x = cx + Math.cos(s.a) * d, y = cy + Math.sin(s.a) * d;
          const g = ctx.createLinearGradient(cx + Math.cos(s.a) * d * .6, cy + Math.sin(s.a) * d * .6, x, y);
          g.addColorStop(0, `rgba(${P.spark[0]},0)`); g.addColorStop(1, `rgba(${P.spark[1]},${a})`);
          ctx.strokeStyle = g; ctx.lineWidth = s.s;
          ctx.beginPath(); ctx.moveTo(cx + Math.cos(s.a) * d * .6, cy + Math.sin(s.a) * d * .6); ctx.lineTo(x, y); ctx.stroke();
          ctx.fillStyle = `rgba(${P.spark[2]},${a})`; ctx.beginPath(); ctx.arc(x, y, s.s * .9, 0, 7); ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
      }

      // 连线
      for (const k of links) {
        if (off && (off.has(k.A.n.kind) || off.has(k.B.n.kind))) continue;
        const [x1, y1, p1] = k.A.s, [x2, y2, p2] = k.B.s;
        const p = Math.min(p1, p2) * grow;
        if (p <= .02) continue;
        const on = !hl || (hl.has(k.l.a) && hl.has(k.l.b));
        let a = (k.l.both ? .32 : k.l.kind === 'wiki' ? .3 : k.l.kind === 'contain' ? .16 : .11) * p * (on ? 1 : .25) * (hl && on ? 2.2 : 1);
        ctx.strokeStyle = k.l.both ? `rgba(${P.mutual},${a})` : k.l.kind === 'wiki' ? `rgba(${P.wiki},${a})` : `rgba(${P.link},${a})`;
        ctx.lineWidth = k.l.both ? .6 + Math.min(k.l.w, 6) * .22 : .7;
        ctx.beginPath(); ctx.moveTo(x1, y1);
        if (k.l.both) { const mx = (x1 + x2) / 2 + (y2 - y1) * .12, my = (y1 + y2) / 2 - (x2 - x1) * .12; ctx.quadraticCurveTo(mx, my, x2, y2); }
        else ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      // 神经脉冲：单向连接只朝出链方向，双向连接往返传递。
      if (!reduced && !L.paused && grow > .6) {
        ctx.globalCompositeOperation = ADD;
        for (const k of links) {
          if (k.l.kind === 'contain' || k.l.kind === 'tag') continue;
          if (off && (off.has(k.A.n.kind) || off.has(k.B.n.kind))) continue;
          const on = !hl || (hl.has(k.l.a) && hl.has(k.l.b));
          const speed = k.l.both ? .16 : .12;
          const lanes = k.l.both ? [0, 1] : [0];
          for (const lane of lanes) {
            const u = ((t * speed + k.seed + lane * .5) % 1);
            const fwd = lane === 0 ? (k.l.s === k.l.a) : !(k.l.s === k.l.a);
            const [x1, y1] = fwd ? k.A.s : k.B.s, [x2, y2] = fwd ? k.B.s : k.A.s;
            let x = x1 + (x2 - x1) * u, y = y1 + (y2 - y1) * u;
            if (k.l.both) { const mx = (k.A.s[0] + k.B.s[0]) / 2 + (k.B.s[1] - k.A.s[1]) * .12, my = (k.A.s[1] + k.B.s[1]) / 2 - (k.B.s[0] - k.A.s[0]) * .12; const uu = fwd ? u : 1 - u; x = (1 - uu) ** 2 * k.A.s[0] + 2 * (1 - uu) * uu * mx + uu * uu * k.B.s[0]; y = (1 - uu) ** 2 * k.A.s[1] + 2 * (1 - uu) * uu * my + uu * uu * k.B.s[1]; }
            const a = Math.sin(u * Math.PI) * (on ? .95 : .2);
            const c = k.l.both ? (lane ? P.mutualIn : P.mutual) : P.pulseOne;
            ctx.globalAlpha = a;
            ctx.drawImage(pulseOf(c), x - 6, y - 6);
          }
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      // 节点
      for (const x of nodes) {
        if (off && off.has(x.n.kind)) continue;
        const [px, py, p] = x.s;
        if (p <= 0) continue;
        const on = !hl || hl.has(x.n.id);
        const color = KINDS[x.n.kind].color;
        const a = p * (on ? 1 : .22);
        const r = x.r * (hl && on ? 1.35 : 1);
        ctx.globalAlpha = a;
        ctx.globalCompositeOperation = ADD;
        const gl = glowOf(color, r), gw = gl.width / 2;
        ctx.drawImage(gl, px - gw, py - gw);
        ctx.globalCompositeOperation = 'source-over';
        if (x.n.kind === 'ghost') { ctx.setLineDash([2, 2]); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(px, py, r + 1, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
        else { const b = ballOf(color, r), bw = b.width / 2; ctx.drawImage(b, px - bw, py - bw); }
        if (L.stage === 'hub' && p > .9 && (hl ? on && x.n.kind !== 'tag' : x.n.kind === 'concept')) {
          ctx.globalAlpha = a * (hl ? .9 : .42);
          ctx.fillStyle = P.label; ctx.font = `${hl ? 11 : 10}px -apple-system, "PingFang SC", sans-serif`;
          ctx.fillText((x.n.short || x.n.title).slice(0, 14), px + r + 5, py + 3.5);
        }
        ctx.globalAlpha = 1;
      }
    };
    // 窗口失焦（切到别的应用但未最小化）降到 ~15fps：后台窗口看不见，全速绘制纯属烧 CPU
    let blurred = false, lastDraw = 0;
    const onBlur = () => { blurred = true; };
    const onFocus = () => { blurred = false; lastDraw = 0; };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    // 每帧先排好下一帧再绘制：某一帧出错也不会让背景网络停住
    let warned = false;
    let lastChk = 0, lastSig = '';
    const frame = now => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return; // 窗口隐藏 / 最小化：整帧跳过
      if (blurred) { // 失焦降帧：脉冲相位按绝对时间推进，帧率变疏、速度不变
        if (now - lastDraw < 66) return;
        lastDraw = now;
      }
      if (reduced) {
        // 减少动态效果：只画一帧静态画面，之后每 160ms 比对一次状态签名（舞台 / 选中 / 悬停 / 光球 / 过滤），变了才重画
        if (now - lastChk < 160) return;
        lastChk = now;
        const L = live.current;
        const sig = `${L.stage}|${L.sel}|${L.hover}|${L.orb.x}|${L.orb.y}|${L.orb.s}|${L.filter ? [...L.filter].join() : ''}`;
        if (drew && sig === lastSig) return;
        lastSig = sig;
      }
      try { draw(now); drew = true; } catch (err) { if (!warned) { warned = true; console.error(err); } }
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('blur', onBlur); window.removeEventListener('focus', onFocus); };
  }, [graph, layout, live, reduced]);
  return <canvas ref={ref} className="network-canvas" aria-hidden="true"/>;
}
