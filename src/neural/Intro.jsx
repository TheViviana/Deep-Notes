import React, {useEffect, useRef, useState} from 'react';

// 开屏动画（关键帧序列）：光斑亮起 → 展开为横向线条 → 线条撑开成界面主题底色 →
// 星野淡入 → 粒子从四周汇聚成球 → 球体加速旋转 → 粒子炸开 → 白光铺满 → 淡出进入主界面。
// 渲染要点：高 DPR（≤3）逐像素绘制，每帧整幅清屏；粒子只有锐利亮核 + 细短拖尾，
// 无大光晕、无糊化，星野是小而实的星点，全程清晰。
// 桌面版每次启动都会播放；网页版同一标签页刷新不重播（sessionStorage 记忆）。
// prefers-reduced-motion、点击或按任意键都会直接跳过。
const KEY = 'neural-splash-seen';
const T_SPOT = 560;               // 光斑亮起
const T_LINE = T_SPOT + 620;      // 展开为横向线条
const T_THEME = T_LINE + 760;     // 线条撑开成界面主题底色
const T_STARS = T_THEME + 680;    // 星野淡入
const T_GATHER = T_STARS + 1460;  // 粒子汇聚成球
const T_BURST0 = T_GATHER + 1120; // 旋转蓄势结束，炸开开始
const BURST = 640;                // 炸开时长
const T_FLOOD = T_BURST0 + 240;   // 白光从中心铺开
const T_WHITE = T_FLOOD + 680;    // 白光铺满全屏
const FADE = 620;                 // 白幕淡出，露出界面
const VOID = '#070808';           // 开场虚空
const APP = '#0d0e0e';            // 界面主题底色
const WHITE = '255,255,255', SILVER = '226,232,246', GREY = '201,212,224';
const COLORS = [WHITE, SILVER, GREY];
const N = 260;                    // 粒子数量
const clamp01 = v => Math.min(Math.max(v, 0), 1);
const easeOutQuart = p => 1 - Math.pow(1 - p, 4);
const easeOutCubic = p => 1 - Math.pow(1 - p, 3);
const easeInCubic = p => p * p * p;
const easeInOutCubic = p => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
const easeInOutQuint = p => p < .5 ? 16 * p ** 5 : 1 - Math.pow(-2 * p + 2, 5) / 2;

// 星野一次成型：透明底上只有星点（少量带细十字光芒），铺在主题底色之上。预渲染成离屏画布，
// 每帧按淡入透明度覆盖一次；星点小而实，不带光晕，保证清晰。
function makeStars(w, h, dpr) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  const n = Math.round(w * h / 9000);
  for (let i = 0; i < n; i++) {
    const x = Math.random() * w, y = Math.random() * h;
    const r = .35 + Math.random() * .8, a = .1 + Math.random() * .34;
    const col = Math.random() < .6 ? SILVER : GREY;
    g.fillStyle = `rgba(${col},${a})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    if (Math.random() < .06) { // 少数亮星带细十字光芒
      const l = 2.5 + Math.random() * 2.5;
      g.strokeStyle = `rgba(${col},${a * .55})`;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(x - l, y); g.lineTo(x + l, y); g.stroke();
      g.beginPath(); g.moveTo(x, y - l); g.lineTo(x, y + l); g.stroke();
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
    const failsafe = setTimeout(finish, T_WHITE + FADE + 1200); // 兜底：任何异常都不能卡住黑幕

    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let w = window.innerWidth, h = window.innerHeight, stars = null;
    const resize = () => {
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = makeStars(w, h, dpr);
    };
    resize();
    window.addEventListener('resize', resize);

    // 粒子：斐波那契球面目标（点距均匀、球体轮廓清晰）+ 屏幕边缘出生 + 错峰 + 弧线切入
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
        start, jit: Math.random() * 380, c: COLORS[i % COLORS.length],
        s: .7 + Math.random() * .8, tw: Math.random() * Math.PI * 2,
        sp: 14 + Math.random() * 30,                    // 弧线切入幅度（收敛克制）
        cw: i % 2 ? 1 : -1,
        bv: 2.2 + Math.random() * 2.6,                  // 炸开速度系数
        px: null, py: null,                             // 上一帧位置（画短拖尾用）
      });
    }

    const step = now => {
      const t = now - t0;
      const cx = w / 2, cy = h / 2;
      const pSpot = clamp01(t / T_SPOT);
      const pLine = clamp01((t - T_SPOT) / (T_LINE - T_SPOT));
      const pTheme = clamp01((t - T_LINE) / (T_THEME - T_LINE));
      const pStars = clamp01((t - T_THEME) / (T_STARS - T_THEME));
      const pSpin = clamp01((t - T_GATHER) / (T_BURST0 - T_GATHER));
      const pBurst = clamp01((t - T_BURST0) / BURST);
      const pWhite = clamp01((t - T_FLOOD) / (T_WHITE - T_FLOOD));

      // 背景：主题铺满前是虚空，铺满后是界面底色 + 星野
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.fillStyle = pTheme >= 1 ? APP : VOID;
      ctx.fillRect(0, 0, w, h);
      if (pTheme >= 1 && stars && pStars > 0) {
        ctx.globalAlpha = pStars;
        ctx.drawImage(stars, 0, 0, w, h);
        ctx.globalAlpha = 1;
      }

      // 光斑 → 横向线条 → 线条撑开成主题底色（铺满前一直存在）
      if (pTheme < 1) {
        if (pTheme > 0) { // 线条纵向撑开：上下软边的一带主题色，越撑越高直至盖满
          const bh = easeInOutCubic(pTheme) * h * 2.4;
          const g = ctx.createLinearGradient(0, cy - bh / 2, 0, cy + bh / 2);
          g.addColorStop(0, 'rgba(13,14,14,0)');
          g.addColorStop(.3, APP);
          g.addColorStop(.7, APP);
          g.addColorStop(1, 'rgba(13,14,14,0)');
          ctx.fillStyle = g;
          ctx.fillRect(0, cy - bh / 2, w, bh);
        }
        // 光斑：中心亮核 + 小光晕，线条出现后作为线中点继续亮着，随主题撑开淡去
        const spotA = easeOutCubic(pSpot) * (1 - pTheme * .65);
        if (spotA > .02) {
          const hr = 30;
          const hg = ctx.createRadialGradient(cx, cy, 0, cx, cy, hr);
          hg.addColorStop(0, `rgba(${SILVER},${spotA * .32})`);
          hg.addColorStop(1, `rgba(${SILVER},0)`);
          ctx.fillStyle = hg;
          ctx.fillRect(cx - hr, cy - hr, hr * 2, hr * 2);
          ctx.fillStyle = `rgba(${WHITE},${spotA * .95})`;
          ctx.beginPath(); ctx.arc(cx, cy, 2.1, 0, Math.PI * 2); ctx.fill();
        }
        // 横向线条：中点最亮、两端渐隐（透镜光斑质感），主题撑开时同步淡去
        if (pLine > 0) {
          const half = Math.min(w, h) * .21 * easeOutQuart(pLine);
          const la = (1 - pTheme);
          if (la > .02) {
            const lg = ctx.createLinearGradient(cx - half, cy, cx + half, cy);
            lg.addColorStop(0, `rgba(${SILVER},0)`);
            lg.addColorStop(.5, `rgba(${WHITE},${.92 * la})`);
            lg.addColorStop(1, `rgba(${SILVER},0)`);
            ctx.strokeStyle = lg;
            ctx.lineWidth = 1.25;
            ctx.beginPath(); ctx.moveTo(cx - half, cy); ctx.lineTo(cx + half, cy); ctx.stroke();
            ctx.globalAlpha = .12 * la;
            ctx.lineWidth = 6;
            ctx.beginPath(); ctx.moveTo(cx - half, cy); ctx.lineTo(cx + half, cy); ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
      }

      // 粒子（星野出现后开始汇聚）：汇聚 → 旋转 → 炸开
      if (t > T_STARS - 400 && pWhite < 1) {
        const R = Math.min(w, h) * .155;
        const spin = t / 5200 + easeInCubic(pSpin) * 2.6; // 旋转蓄势：越转越快
        const cos = Math.cos(spin), sin = Math.sin(spin);
        ctx.globalCompositeOperation = 'lighter';
        for (const d of parts) {
          const pa = clamp01((t - T_STARS - d.jit) / (T_GATHER - T_STARS - 420)); // 汇聚进度（错峰）
          const eo = easeOutCubic(pa);
          const x3 = d.dir[0] * cos - d.dir[2] * sin;
          const z3 = d.dir[0] * sin + d.dir[2] * cos;
          const y3 = d.dir[1];
          // 汇聚：起点 → 球面；炸开：沿当前球面方向向外飞散
          const rf = R * (1 + easeOutCubic(pBurst) * d.bv);
          const tx = cx + x3 * rf, ty = cy + y3 * rf;
          let x = d.start[0] + (tx - d.start[0]) * eo;
          let yy = d.start[1] + (ty - d.start[1]) * eo;
          // 弧线切入：飞行中段沿垂直方向偏出一条小弧，越接近目标越收直
          if (pa > 0 && pa < 1 && pSpin <= 0) {
            const dx = x - cx, dy = yy - cy, dist = Math.hypot(dx, dy) || 1;
            const bow = Math.sin(pa * Math.PI) * d.sp;
            x += -dy / dist * bow * d.cw;
            yy += dx / dist * bow * d.cw;
          }
          // 细短拖尾：上一位置 → 当前位置，运动时自然拉成光迹，到位后自动消失
          if (d.px != null) {
            const mv = Math.hypot(x - d.px, yy - d.py);
            if (mv > .6) {
              ctx.strokeStyle = `rgba(${d.c},${Math.min(.18 + mv * .025, .5) * (1 - pBurst)})`;
              ctx.lineWidth = 1;
              ctx.beginPath(); ctx.moveTo(d.px, d.py); ctx.lineTo(x, yy); ctx.stroke();
            }
          }
          d.px = x; d.py = yy;
          // 锐利光点：微光晕 + 亮核两层，近侧更大更亮、微微闪烁；炸开时渐隐
          const depth = 1 + z3 * .3;
          const size = (1.5 + d.s * 1.05) * depth;
          let a = (.3 + .7 * eo) * (.7 + .3 * z3) * (1 - pBurst);
          a *= .85 + .15 * Math.sin(now / 300 + d.tw);
          if (a <= .03) continue;
          ctx.fillStyle = `rgba(${d.c},${a * .2})`;
          ctx.beginPath(); ctx.arc(x, yy, size * 2, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = `rgba(${d.c},${Math.min(a, 1)})`;
          ctx.beginPath(); ctx.arc(x, yy, size, 0, Math.PI * 2); ctx.fill();
        }
        // 球心的一点呼吸微光（旋转期的「心脏」），炸开后熄灭
        if (pBurst < 1) {
          const coreA = (.2 + .25 * pSpin) * (1 - pBurst) * clamp01((t - T_STARS) / 600);
          const coreR = 3 + 3 * pSpin;
          ctx.fillStyle = `rgba(${WHITE},${coreA})`;
          ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
      }

      // 白光铺满：白盘从中心扩张盖过粒子，前缘一道亮环
      if (pWhite > 0) {
        const maxR = Math.hypot(w, h) / 2 + 40;
        const pr = easeInOutQuint(pWhite) * maxR * 1.02;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(cx, cy, pr, 0, Math.PI * 2); ctx.fill();
        if (pWhite < .92) {
          ctx.strokeStyle = `rgba(${WHITE},${(1 - pWhite / .92) * .85})`;
          ctx.lineWidth = 1.5 + 3.5 * (1 - pWhite);
          ctx.beginPath(); ctx.arc(cx, cy, pr * 1.03, 0, Math.PI * 2); ctx.stroke();
        }
      }

      // 铺满后整体淡出，露出底下的应用
      if (t >= T_WHITE && !fading) {
        fading = true;
        setFade(true);
        setTimeout(finish, FADE + 80);
      }
    };
    // 与核心动效同一套防中断写法：先排下一帧，再在 try 里执行本帧；出错直接放行进入应用
    const frame = now => { raf = requestAnimationFrame(frame); try { step(now); } catch { finish(); } };
    raf = requestAnimationFrame(frame);

    // 点击或按任意键跳过：直接跳到白光铺满淡出
    const skip = () => { if (!fading) t0 = performance.now() - T_WHITE; };
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
