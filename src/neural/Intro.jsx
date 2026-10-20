import React, {useEffect, useRef, useState} from 'react';

// 开屏动画：黑幕星野上，粒子拖着光迹从屏幕四周沿弧线汇聚成球 → 球体加速收缩成一个奇点
// （中心点亮、两圈准备脉冲向外散开）→ 爆发：起爆闪光 + 放射光条 + 双重冲击环 + 火花，
// 像一次「宇宙爆炸」逐渐把整个界面染成白色，再淡出露出应用。
// 桌面版每次启动都会播放；网页版同一标签页刷新不重播（sessionStorage 记忆）。
// prefers-reduced-motion、点击或按任意键都会直接跳过。
const KEY = 'neural-splash-seen';
const T1 = 1700;      // 粒子从四周汇聚成球
const T2 = T1 + 620;  // 球收缩成一个点（奇点点亮 + 准备脉冲）
const T3 = T2 + 900;  // 点爆发，白色铺满全屏
const FADE = 640;     // 白幕淡出，露出界面
const N = 300;        // 粒子数量
const COLORS = ['#ffffff', '#f6e7c8', '#c9d4e0']; // 白 / 香槟 / 银灰
const RAY_COLORS = ['255,255,255', '246,231,200', '201,212,224'];

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

// 星野垫底：极淡的深空色晕 + 一片大小/亮度随机的星，少数带十字光芒，预渲染成离屏画布。
function makeStars(w, h, dpr) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  for (const [x, y, r, rgb] of [[w * .24, h * .3, Math.max(w, h) * .42, '44,60,112'], [w * .78, h * .7, Math.max(w, h) * .38, '86,56,102']]) {
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `rgba(${rgb},.13)`);
    rg.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = rg;
    g.fillRect(0, 0, w, h);
  }
  const n = Math.round(w * h / 8600);
  for (let i = 0; i < n; i++) {
    const x = Math.random() * w, y = Math.random() * h;
    const r = .5 + Math.random() * 1.1, a = .14 + Math.random() * .5;
    g.fillStyle = `rgba(235,240,255,${a})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    if (Math.random() < .07) {
      g.strokeStyle = `rgba(235,240,255,${a * .45})`;
      g.lineWidth = .6;
      const L = 3.5 + Math.random() * 5;
      g.beginPath(); g.moveTo(x - L, y); g.lineTo(x + L, y); g.moveTo(x, y - L); g.lineTo(x, y + L); g.stroke();
    }
  }
  return c;
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
    let stars = null;
    const resize = () => {
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = makeStars(w, h, dpr);
    };
    resize();
    window.addEventListener('resize', resize);

    // 粒子：斐波那契球面目标 + 屏幕边缘出生 + 每颗带错峰、大小抖动、螺旋切入方向与爆发速度
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
        sp: 26 + Math.random() * 84,                    // 螺旋切入的弧线幅度
        cw: i % 2 ? 1 : -1,                             // 顺 / 逆时针，弧线互相穿插
        bs: Math.random(),                              // 爆发火花速度
      });
    }
    // 爆发放射光条：26 条长短不一、方向带抖动的光线
    const rays = Array.from({length: 26}, (_, i) => ({
      ang: golden * i * 7 % (Math.PI * 2) + Math.random() * .22,
      t0: .1 + Math.random() * .32, t1: .5 + Math.random() * .55,
      wd: .8 + Math.random() * 1.9, a: .45 + Math.random() * .55,
      c: RAY_COLORS[i % RAY_COLORS.length],
    }));

    const easeOut = p => 1 - Math.pow(1 - p, 3);
    const easeIn = p => p * p * p;
    const sp = getSprites();

    const step = now => {
      const t = now - t0;
      const cx = w / 2, cy = h / 2;
      // 拖尾：半透明覆盖代替清屏，每颗粒子都留下一道渐隐的光迹；
      // 星野每帧以低透明度轻描一次，恰好抵消拖尾衰减，保持亮度稳定。
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(4,5,10,.32)';
      ctx.fillRect(0, 0, w, h);
      if (stars) { ctx.globalAlpha = .3; ctx.drawImage(stars, 0, 0, w, h); ctx.globalAlpha = 1; }

      const pb = Math.min(Math.max((t - T1) / (T2 - T1), 0), 1); // 收缩进度
      const pc = Math.min(Math.max((t - T2) / (T3 - T2), 0), 1); // 爆发进度
      const R = Math.min(w, h) * 0.17;
      // 自转：收缩时加速，攒足势能再炸开
      const spin = t / 4200 + pb * pb * 2.6;
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
          let x = d.start[0] + (cx + x3 * rf - d.start[0]) * eo;
          let yy = d.start[1] + (cy + y3 * rf - d.start[1]) * eo;
          // 螺旋切入：飞行中段沿垂直方向偏出一条弧线，越接近目标越收直
          if (pa > 0 && pa < 1 && pb <= 0) {
            const dx = x - cx, dy = yy - cy, dist = Math.hypot(dx, dy) || 1;
            const bow = Math.sin(pa * Math.PI) * d.sp;
            x += -dy / dist * bow * d.cw;
            yy += dx / dist * bow * d.cw;
          }
          const depth = 1 + z3 * .28;
          const size = 9 * d.s * depth * (1 - pb * .45);
          let a = (.3 + .7 * eo) * (.72 + .28 * z3);
          a *= .8 + .2 * Math.sin(now / 240 + d.tw);
          a *= 1 - pb * .25;
          if (a <= 0.02) continue;
          ctx.globalAlpha = Math.min(a, 1);
          ctx.drawImage(sp[d.c], x - size, yy - size, size * 2, size * 2);
        }
        ctx.globalAlpha = 1;

        // 汇聚辉光 → 奇点核心：目标位置全程只点一颗小子弹标光，收缩时才胀大变亮，
        // 避免球体保持阶段被大片辉光糊住
        const coreA = .2 + .3 * Math.min(Math.max(t / T1, 0), 1) + pb * .5;
        const coreR = 24 + 130 * easeIn(pb) + 80 * pb;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
        g.addColorStop(0, `rgba(255,252,240,${Math.min(coreA, .95)})`);
        g.addColorStop(.4, `rgba(214,222,240,${coreA * .45})`);
        g.addColorStop(1, 'rgba(214,222,240,0)');
        ctx.fillStyle = g;
        ctx.fillRect(cx - coreR * 1.6, cy - coreR * 1.6, coreR * 3.2, coreR * 3.2);
        // 奇点本体 + 两圈准备脉冲：爆发前像心跳一样往外送
        if (pb > 0) {
          ctx.globalCompositeOperation = 'lighter';
          const k = 9 + 17 * pb;
          ctx.fillStyle = `rgba(255,255,255,${.7 * pb})`;
          ctx.beginPath(); ctx.arc(cx, cy, k, 0, Math.PI * 2); ctx.fill();
          for (let r = 0; r < 2; r++) {
            const u = ((t - T1) / 340 + r * .5) % 1;
            ctx.strokeStyle = `rgba(230,240,255,${(1 - u) * .45 * pb})`;
            ctx.lineWidth = 1.4;
            ctx.beginPath(); ctx.arc(cx, cy, k + u * (64 + r * 36), 0, Math.PI * 2); ctx.stroke();
          }
          ctx.globalCompositeOperation = 'source-over';
        }
      }

      // 爆发：起爆闪光 + 放射光条 + 双重冲击环 + 火花，白盘从中心扩张到铺满全屏
      if (pc > 0) {
        const maxR = Math.hypot(w, h) / 2 + 60;
        const pr = easeOut(pc) * 1.35;
        ctx.globalCompositeOperation = 'lighter';
        const flash = Math.max(0, 1 - pc * 8); // 头 120ms 全屏一闪
        if (flash > 0) { ctx.fillStyle = `rgba(255,253,246,${flash * .8})`; ctx.fillRect(0, 0, w, h); }
        if (pc < .6) { // 放射光条：随冲击波推出，先长后隐
          const la = (1 - pc / .6) * .5;
          ctx.lineCap = 'round';
          for (const ray of rays) {
            const r0 = pr * maxR * ray.t0, r1 = pr * maxR * ray.t1;
            if (r1 <= r0) continue;
            ctx.strokeStyle = `rgba(${ray.c},${la * ray.a})`;
            ctx.lineWidth = ray.wd;
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(ray.ang) * r0, cy + Math.sin(ray.ang) * r0);
            ctx.lineTo(cx + Math.cos(ray.ang) * r1, cy + Math.sin(ray.ang) * r1);
            ctx.stroke();
          }
        }
        if (pc < .55) { // 火花：奇点喷出的碎光，沿粒子原方向抛出
          const sa = 1 - pc / .55;
          for (let i = 0; i < parts.length; i += 3) {
            const d = parts[i];
            const dd = pr * maxR * (.22 + d.bs * .5);
            const size = 5 * d.s * (1 - pc * .6);
            ctx.globalAlpha = Math.min(sa * .85, 1);
            ctx.drawImage(sp[d.c], cx + d.dir[0] * dd - size, cy + d.dir[1] * dd - size, size * 2, size * 2);
          }
          ctx.globalAlpha = 1;
        }
        // 白盘本体（不透明，负责最终铺满）+ 外缘渐隐
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(cx, cy, pr * .78, 0, Math.PI * 2); ctx.fill();
        const g2 = ctx.createRadialGradient(cx, cy, pr * .6, cx, cy, pr * 1.12);
        g2.addColorStop(0, 'rgba(255,255,255,.95)');
        g2.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g2;
        ctx.fillRect(0, 0, w, h);
        // 冲击环：一道亮环跑在最前，一道余波跟在后面
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = `rgba(255,255,255,${.85 * (1 - pc * .55)})`;
        ctx.lineWidth = 2 + 9 * (1 - pc);
        ctx.beginPath(); ctx.arc(cx, cy, pr * .8, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = `rgba(230,240,255,${.3 * (1 - pc)})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(cx, cy, pr * 1.04, 0, Math.PI * 2); ctx.stroke();
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
