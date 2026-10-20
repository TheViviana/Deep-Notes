import React, {useEffect, useRef, useState} from 'react';

// 开屏动画：黑幕上粒子从屏幕四周汇聚成球 → 收缩成一个奇点 → 爆发放大发白，
// 像一次「宇宙爆炸」逐渐把整个界面染成白色，再淡出露出应用。
// 桌面版每次启动都会播放；网页版同一标签页刷新不重播（sessionStorage 记忆）。
// prefers-reduced-motion、点击或按任意键都会直接跳过。
const KEY = 'neural-splash-seen';
const T1 = 1700;      // 粒子从四周汇聚成球
const T2 = T1 + 550;  // 球收缩成一个点
const T3 = T2 + 850;  // 点爆发，白色铺满全屏
const FADE = 620;     // 白幕淡出，露出界面
const N = 240;        // 粒子数量
const COLORS = ['#ffffff', '#f6e7c8', '#c9d4e0']; // 白 / 香槟 / 银灰

// 粒子光点按颜色预渲染成精灵，避免每帧创建渐变（与图谱网络画布同一套性能策略）。
let sprites = null;
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}
function getSprites() {
  if (sprites) return sprites;
  const r = 22;
  sprites = COLORS.map(color => {
    const c = document.createElement('canvas');
    c.width = c.height = r * 2;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, rgba(color, 1));
    grad.addColorStop(.3, rgba(color, .85));
    grad.addColorStop(1, rgba(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, r * 2, r * 2);
    return c;
  });
  return sprites;
}

export function Intro() {
  // 已看过（网页刷新）或系统要求减少动态效果：直接不播
  const [done, setDone] = useState(() => {
    try { if (sessionStorage.getItem(KEY)) return true; } catch {}
    try { if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true; } catch {}
    return false;
  });
  const [fade, setFade] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (done) { try { sessionStorage.setItem(KEY, '1'); } catch {} return; }
    const canvas = ref.current;
    const ctx = canvas.getContext('2d');
    let raf = 0, t0 = performance.now(), dead = false, fading = false;
    const finish = () => {
      if (dead) return;
      dead = true;
      cancelAnimationFrame(raf);
      try { sessionStorage.setItem(KEY, '1'); } catch {}
      setDone(true);
    };
    const failsafe = setTimeout(finish, T3 + FADE + 1200); // 兜底：任何异常都不能卡住黑幕

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = window.innerWidth, h = window.innerHeight;
    const resize = () => {
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    // 粒子：斐波那契球面目标 + 屏幕边缘出生 + 每颗带一点错峰与大小抖动
    const golden = Math.PI * (3 - Math.sqrt(5));
    const parts = [];
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const rr = Math.sqrt(Math.max(0, 1 - y * y));
      const th = golden * i;
      const side = Math.floor(Math.random() * 4), m = Math.random();
      const start = side === 0 ? [m * w, -30] : side === 1 ? [w + 30, m * h] : side === 2 ? [m * w, h + 30] : [-30, m * h];
      parts.push({
        dir: [Math.cos(th) * rr, y, Math.sin(th) * rr], // 球面单位方向（x, y, z）
        start, jit: Math.random() * 450, c: i % COLORS.length,
        s: .55 + Math.random() * .9, tw: Math.random() * Math.PI * 2,
      });
    }

    const easeOut = p => 1 - Math.pow(1 - p, 3);
    const easeIn = p => p * p * p;
    const sp = getSprites();

    const step = now => {
      const t = now - t0;
      const cx = w / 2, cy = h / 2;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#04050a';
      ctx.fillRect(0, 0, w, h);

      const pb = Math.min(Math.max((t - T1) / (T2 - T1), 0), 1); // 收缩进度
      const pc = Math.min(Math.max((t - T2) / (T3 - T2), 0), 1); // 爆发进度
      const R = Math.min(w, h) * 0.17;
      const spin = t / 4000;
      const cos = Math.cos(spin), sin = Math.sin(spin);

      if (pc < 1) {
        for (const d of parts) {
          const pa = Math.min(Math.max((t - d.jit) / (T1 - 200), 0), 1); // 汇聚进度（错峰）
          const eo = easeOut(pa);
          const x3 = d.dir[0] * cos - d.dir[2] * sin;
          const z3 = d.dir[0] * sin + d.dir[2] * cos;
          const y3 = d.dir[1];
          // 汇聚：起点 → 球面；收缩：球面 → 中心奇点
          const rf = R * (1 - easeIn(pb));
          const x = d.start[0] + (cx + x3 * rf - d.start[0]) * eo;
          const yy = d.start[1] + (cy + y3 * rf - d.start[1]) * eo;
          const depth = 1 + z3 * .28;
          const size = 9 * d.s * depth * (1 - pb * .4);
          let a = (.3 + .7 * eo) * (.72 + .28 * z3);
          a *= .82 + .18 * Math.sin(now / 260 + d.tw);
          if (a <= 0.02) continue;
          ctx.globalAlpha = Math.min(a, 1);
          ctx.drawImage(sp[d.c], x - size, yy - size, size * 2, size * 2);
        }
        ctx.globalAlpha = 1;
        // 奇点核心光：收缩时在中心先亮起来
        if (pb > 0) {
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 30 + 90 * pb);
          g.addColorStop(0, `rgba(255,255,255,${.9 * pb})`);
          g.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = g;
          ctx.fillRect(cx - 130, cy - 130, 260, 260);
        }
      }

      // 爆发：白盘从中心扩张到铺满全屏，边缘带一道亮环
      if (pc > 0) {
        const pr = easeOut(pc) * (Math.hypot(w, h) / 2 + 60) * 1.35;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(cx, cy, pr * .78, 0, Math.PI * 2); ctx.fill();
        const g = ctx.createRadialGradient(cx, cy, pr * .6, cx, cy, pr * 1.12);
        g.addColorStop(0, 'rgba(255,255,255,.95)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = `rgba(255,255,255,${.9 * (1 - pc * .6)})`;
        ctx.lineWidth = 2 + 10 * (1 - pc);
        ctx.beginPath(); ctx.arc(cx, cy, pr * .8, 0, Math.PI * 2); ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
      }

      // 白幕铺满后整体淡出，露出底下的应用
      if (t >= T3 && !fading) {
        fading = true;
        setFade(true);
        setTimeout(finish, FADE + 80);
      }
    };
    // 与核心动效同一套防中断写法：先排下一帧，再在 try 里执行本帧；出错直接放行进入应用
    const frame = now => { raf = requestAnimationFrame(frame); try { step(now); } catch { finish(); } };
    raf = requestAnimationFrame(frame);

    // 点击或按任意键跳过：直接跳到白幕淡出
    const skip = () => { if (!fading) t0 = performance.now() - T3; };
    window.addEventListener('pointerdown', skip);
    window.addEventListener('keydown', skip);
    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      clearTimeout(failsafe);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointerdown', skip);
      window.removeEventListener('keydown', skip);
    };
  }, [done]);

  if (done) return null;
  return <canvas ref={ref} className={`intro-veil${fade ? ' fade' : ''}`} aria-hidden="true"/>;
}
