// 通用弹窗容器：焦点圈定（Tab 循环）、Esc 关闭、点遮罩关闭、关闭后焦点还原。
// 此前内联在 main.jsx，现独立出来供主组件与 mainModals 共用。
import React, {useEffect, useRef} from 'react';
import {Icon} from './icons';

export function Modal({title, en, onClose, children, wide}) {
  const ref = useRef(null), closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const before = document.activeElement;
    ref.current?.focus({preventScroll: true});
    const key = e => {
      // 图片 / 视频灯箱打开时 Esc 归灯箱：先关放大层，再按一次才关弹窗
      if (document.getElementById('image-lightbox') || document.getElementById('video-lightbox')) return;
      if (e.key === 'Escape' && !e.isComposing) closeRef.current();
      if (e.key === 'Tab') {
        const list = [...ref.current.querySelectorAll('button,input,textarea,select,a[href]')].filter(n => !n.disabled);
        const first = list[0], last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); if (before?.isConnected) before.focus({preventScroll: true}); };
  }, []);
  return <div className="veil" onClick={onClose}>
    <section ref={ref} tabIndex={-1} className={`modal glass ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
      <header><h2>{title} <em>{en}</em></h2><button className="icon-btn" onClick={onClose} aria-label="关闭弹窗"><Icon name="close" size={16}/></button></header>
      {children}
    </section>
  </div>;
}
