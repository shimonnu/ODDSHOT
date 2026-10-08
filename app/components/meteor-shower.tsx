"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import "./meteor-shower.css";

const SPRITE = "/images/bearded-meteor.png";
const METEORS = Array.from({ length: 30 }, (_, index) => ({
  id: index,
  style: {
    "--meteor-x": `${index % 2 ? (index * 23) % 72 : 0}vw`,
    "--meteor-y": `${index % 2 ? 0 : (index * 17) % 78}vh`,
    "--meteor-size": `${230 + (index * 61) % 230}px`,
    "--meteor-delay": `${index * .17}s`,
    "--meteor-duration": `${3.1 + (index % 6) * .23}s`,
  } as CSSProperties,
}));

function BeardedManIcon() {
  return <svg viewBox="0 0 32 32" width="27" height="27" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M8 12V9a8 8 0 0 1 16 0v3M6 12h21M9 8h14" />
    <path d="M7 15v5c0 6 4 10 9 10s9-4 9-10v-5" />
    <path d="M8 15h6v4H9l-1-4Zm10 0h6l-1 4h-5v-4ZM14 16h4" fill="currentColor" strokeWidth="1" />
    <path d="m16 21-4 2 4 1 4-1-4-2ZM9 22l3 5h8l3-5M14 27h4" />
  </svg>;
}

export function MeteorShower() {
  const [playing, setPlaying] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const preloaded = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(media.matches);
    function change() { setReducedMotion(media.matches); setPlaying(false); }
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => setPlaying(false), reducedMotion ? 1800 : 10500);
    function escape(event: KeyboardEvent) { if (event.key === "Escape") setPlaying(false); }
    function hide() { if (document.visibilityState === "hidden") setPlaying(false); }
    window.addEventListener("keydown", escape);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", escape);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [playing, reducedMotion]);

  function preload() {
    if (preloaded.current) return;
    preloaded.current = new window.Image();
    preloaded.current.src = SPRITE;
  }

  return <>
    <button type="button" className={`meteor-button ${playing ? "playing" : ""}`} aria-label={playing ? "髭男の流星を止める" : "髭男の流星を流す"} aria-pressed={playing} title={playing ? "もう一度押すと止まります" : "髭男の流星シャワー"} onPointerEnter={preload} onFocus={preload} onClick={() => { preload(); setPlaying(previous => !previous); }}><BeardedManIcon /></button>
    <span className="sr-only" role="status" aria-live="polite">{playing ? reducedMotion ? "髭男の流星がふんわり光ります。" : "髭男の流星が流れています。もう一度ボタンを押すか、Escapeキーで止められます。" : ""}</span>
    {playing && createPortal(<div className={`meteor-shower ${reducedMotion ? "gentle" : ""}`} aria-hidden="true">
      {(reducedMotion ? METEORS.slice(0, 3) : METEORS).map(meteor => <span key={meteor.id} className="meteor-flight" style={meteor.style}>
        <img src={SPRITE} alt="" width="1876" height="838" draggable={false} decoding="async" />
      </span>)}
    </div>, document.body)}
  </>;
}
