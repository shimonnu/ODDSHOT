"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, LoaderCircle, Sparkles, X } from "lucide-react";
import "./tutorial-spotlight.css";

export type TutorialSpotlightProps = {
  stepKey: string;
  target: string;
  title: string;
  description: string;
  step: number;
  total: number;
  onClose: () => void;
  onNext?: () => void;
  nextLabel?: string;
  hint?: string;
  busy?: boolean;
};

type Box = { left: number; top: number; width: number; height: number };
type Layout = { host: HTMLElement; hole: Box | null; card: Box; arrow: "up" | "down" | "left" | "right" | null; viewport: Box; screenWidth: number; screenHeight: number; compact: boolean };
const FOCUSABLE = "a[href],button,input:not([type=hidden]),select,textarea,[tabindex]";
const GAP = 34;
const EDGE = 12;

function isVisible(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none" && !element.closest("[hidden],[inert]");
}

function findTarget(name: string) {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>("[data-tour]")).filter(element => element.dataset.tour === name && isVisible(element));
  return candidates.find(element => element.closest("dialog[open]")) || candidates[0] || null;
}

function focusableWithin(element: HTMLElement | null) {
  if (!element) return [];
  const candidates = [element, ...Array.from(element.querySelectorAll<HTMLElement>(FOCUSABLE))];
  return candidates.filter(candidate => candidate.matches(FOCUSABLE) && candidate.tabIndex >= 0 && !candidate.matches(":disabled") && isVisible(candidate));
}

function clamp(value: number, min: number, max: number) { return Math.min(Math.max(value, min), Math.max(min, max)); }

function measureLayout(anchor: HTMLElement | null, host: HTMLElement, cardHeight: number): Layout {
  const visual = window.visualViewport;
  const viewport: Box = { left: visual?.offsetLeft || 0, top: visual?.offsetTop || 0, width: visual?.width || window.innerWidth, height: visual?.height || window.innerHeight };
  const right = viewport.left + viewport.width;
  const bottom = viewport.top + viewport.height;
  const width = Math.min(360, viewport.width - EDGE * 2);
  const compact = viewport.height < 500;
  const desiredHeight = Math.min(cardHeight || 260, viewport.height - EDGE * 2, compact ? Math.max(108, viewport.height * .4) : Infinity);
  const minimumHeight = compact ? 108 : 160;
  const base = { host, viewport, compact, screenWidth: window.innerWidth, screenHeight: window.innerHeight };
  if (!anchor) return { ...base, hole: null, card: { left: viewport.left + (viewport.width - width) / 2, top: viewport.top + Math.max(EDGE, (viewport.height - desiredHeight) / 2), width, height: desiredHeight }, arrow: null };

  let rect = anchor.getBoundingClientRect();
  if (compact && rect.height > viewport.height * .44) {
    const focused = document.activeElement instanceof HTMLElement && anchor.contains(document.activeElement) ? document.activeElement : focusableWithin(anchor)[0];
    if (focused && focused !== anchor) {
      const row = focused.parentElement;
      const rowRect = row?.getBoundingClientRect();
      // Keep the active input and its neighboring submit button available when
      // the software keyboard leaves room for only a small part of the form.
      rect = row && anchor.contains(row) && rowRect && rowRect.height <= 100 ? rowRect : focused.getBoundingClientRect();
    }
  }
  const left = clamp(rect.left - 7, viewport.left + 4, right - 4);
  const top = clamp(rect.top - 7, viewport.top + 4, bottom - 4);
  const hole: Box = { left, top, width: Math.max(0, Math.min(right - 4, rect.right + 7) - left), height: Math.max(0, Math.min(bottom - 4, rect.bottom + 7) - top) };
  const hRight = hole.left + hole.width;
  const hBottom = hole.top + hole.height;
  const below = bottom - EDGE - hBottom - GAP;
  const above = hole.top - viewport.top - EDGE - GAP;
  const cardLeft = clamp(hole.left + (hole.width - width) / 2, viewport.left + EDGE, right - width - EDGE);
  let card: Box;
  let arrow: Layout["arrow"];
  if (below >= desiredHeight) {
    card = { left: cardLeft, top: hBottom + GAP, width, height: desiredHeight }; arrow = "up";
  } else if (above >= desiredHeight) {
    card = { left: cardLeft, top: hole.top - GAP - desiredHeight, width, height: desiredHeight }; arrow = "down";
  } else if (right - EDGE - hRight - GAP >= width) {
    card = { left: hRight + GAP, top: clamp(hole.top + (hole.height - desiredHeight) / 2, viewport.top + EDGE, bottom - desiredHeight - EDGE), width, height: desiredHeight }; arrow = "left";
  } else if (hole.left - GAP - viewport.left - EDGE >= width) {
    card = { left: hole.left - GAP - width, top: clamp(hole.top + (hole.height - desiredHeight) / 2, viewport.top + EDGE, bottom - desiredHeight - EDGE), width, height: desiredHeight }; arrow = "right";
  } else if (Math.max(above, below) >= minimumHeight) {
    const height = Math.min(desiredHeight, Math.max(above, below));
    const useBelow = below >= above;
    card = { left: cardLeft, top: useBelow ? hBottom + GAP : hole.top - GAP - height, width, height }; arrow = useBelow ? "up" : "down";
  } else {
    // A tall section can fill a phone screen. Keep a useful visible section and
    // reserve the lower part for the guide, including its permanent exit.
    const height = Math.min(desiredHeight, Math.max(minimumHeight, viewport.height * .42));
    card = { left: viewport.left + (viewport.width - width) / 2, top: bottom - height - EDGE, width, height };
    hole.height = Math.max(0, Math.min(hole.height, card.top - GAP - hole.top));
    arrow = hole.height > 0 ? "up" : null;
  }
  return { ...base, hole: hole.width > 0 && hole.height > 0 ? hole : null, card, arrow };
}

function sameLayout(previous: Layout | null, next: Layout) {
  if (!previous || previous.host !== next.host || previous.arrow !== next.arrow || previous.compact !== next.compact || !!previous.hole !== !!next.hole) return false;
  const numbers = (layout: Layout) => [layout.card.left, layout.card.top, layout.card.width, layout.card.height, layout.hole?.left || 0, layout.hole?.top || 0, layout.hole?.width || 0, layout.hole?.height || 0, layout.viewport.left, layout.viewport.top, layout.viewport.width, layout.viewport.height, layout.screenWidth, layout.screenHeight];
  return numbers(previous).every((value, index) => Math.abs(value - numbers(next)[index]) < .5);
}

export function TutorialSpotlight({ stepKey, target, title, description, step, total, onClose, onNext, nextLabel = "次へ", hint, busy = false }: TutorialSpotlightProps) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  const descriptionId = useId();
  const titleId = useId();
  const announcementId = useId();

  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      // Native dialog cleanup may run after this portal unmounts.
      queueMicrotask(() => {
        if (document.querySelector(".tutorial-spotlight")) return;
        const openDialog = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]")).at(-1);
        if (previousFocus?.isConnected && !previousFocus.closest("[inert]") && (!openDialog || openDialog.contains(previousFocus))) previousFocus.focus({ preventScroll: true });
        else if (openDialog) (focusableWithin(openDialog)[0] || openDialog).focus({ preventScroll: true });
      });
    };
  }, []);

  useEffect(() => {
    let frame = 0;
    let disposed = false;
    let decorated: HTMLElement | null = null;
    let previousDescription: string | null = null;
    let previousTabIndex: string | null = null;
    let addedTabIndex = false;
    let focusedAnchor: HTMLElement | null = null;
    let observedCard: HTMLElement | null = null;
    let host: HTMLElement = document.body;
    const resizeObserver = new ResizeObserver(() => schedule());

    function restoreAnchor() {
      if (!decorated) return;
      const describedBy = (decorated.getAttribute("aria-describedby") || "").split(/\s+/).filter(id => id && id !== descriptionId);
      if (describedBy.length) decorated.setAttribute("aria-describedby", describedBy.join(" "));
      else if (previousDescription === null) decorated.removeAttribute("aria-describedby");
      else decorated.setAttribute("aria-describedby", previousDescription);
      if (addedTabIndex) {
        if (previousTabIndex === null) decorated.removeAttribute("tabindex");
        else decorated.setAttribute("tabindex", previousTabIndex);
      }
      resizeObserver.unobserve(decorated);
      decorated = null;
      addedTabIndex = false;
    }

    function measure() {
      frame = 0;
      if (disposed) return;
      const anchor = findTarget(target);
      host = anchor?.closest<HTMLDialogElement>("dialog[open]") || Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]")).at(-1) || document.body;
      if (anchor !== decorated) {
        restoreAnchor();
        anchorRef.current = anchor;
        if (anchor) {
          decorated = anchor;
          previousDescription = anchor.getAttribute("aria-describedby");
          anchor.setAttribute("aria-describedby", [...new Set([...(previousDescription || "").split(/\s+/).filter(Boolean), descriptionId])].join(" "));
          previousTabIndex = anchor.getAttribute("tabindex");
          if (!focusableWithin(anchor).length) { anchor.setAttribute("tabindex", "-1"); addedTabIndex = true; }
          resizeObserver.observe(anchor);
          anchor.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        }
      }
      if (cardRef.current !== observedCard) {
        if (observedCard) resizeObserver.unobserve(observedCard);
        observedCard = cardRef.current;
        if (observedCard) resizeObserver.observe(observedCard);
      }
      const cardStyle = cardRef.current ? window.getComputedStyle(cardRef.current) : null;
      const naturalHeight = cardRef.current && cardStyle ? Array.from(cardRef.current.children).reduce((height, child) => height + (child as HTMLElement).scrollHeight, 0) + parseFloat(cardStyle.paddingTop) + parseFloat(cardStyle.paddingBottom) + parseFloat(cardStyle.rowGap) * (cardRef.current.children.length - 1) : 260;
      const next = measureLayout(anchor, host, naturalHeight);
      setLayout(previous => sameLayout(previous, next) ? previous : next);
      if (anchor && anchor !== focusedAnchor) {
        focusedAnchor = anchor;
        const focusTarget = focusableWithin(anchor)[0] || anchor;
        if (!anchor.contains(document.activeElement)) focusTarget.focus({ preventScroll: true });
      }
    }
    function schedule() { if (!frame && !disposed) frame = window.requestAnimationFrame(measure); }
    function allowedElements() { return [...focusableWithin(anchorRef.current), ...focusableWithin(cardRef.current)]; }
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const elements = allowedElements();
      if (!elements.length) return;
      const index = elements.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); elements.at(-1)?.focus(); }
      else if (!event.shiftKey && (index < 0 || index === elements.length - 1)) { event.preventDefault(); elements[0].focus(); }
    }
    function focusin(event: FocusEvent) {
      const focused = event.target;
      if (!(focused instanceof HTMLElement)) return;
      if (anchorRef.current?.contains(focused)) { schedule(); return; }
      if (cardRef.current?.contains(focused)) return;
      const candidate = allowedElements()[0] || anchorRef.current;
      candidate?.focus({ preventScroll: true });
    }
    function cancel(event: Event) { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); }
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden", "data-tour"] });
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusin, true);
    document.addEventListener("cancel", cancel, true);
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    schedule();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      restoreAnchor();
      anchorRef.current = null;
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusin, true);
      document.removeEventListener("cancel", cancel, true);
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [stepKey, target, descriptionId]);

  if (!layout) return null;
  const { hole, card, screenWidth, screenHeight } = layout;
  const scrims: Box[] = hole ? [
    { left: 0, top: 0, width: screenWidth, height: hole.top },
    { left: 0, top: hole.top + hole.height, width: screenWidth, height: Math.max(0, screenHeight - hole.top - hole.height) },
    { left: 0, top: hole.top, width: hole.left, height: hole.height },
    { left: hole.left + hole.width, top: hole.top, width: Math.max(0, screenWidth - hole.left - hole.width), height: hole.height },
  ] : [{ left: 0, top: 0, width: screenWidth, height: screenHeight }];
  const arrowStyle: CSSProperties = hole && layout.arrow ? layout.arrow === "up" || layout.arrow === "down" ? { left: clamp(hole.left + hole.width / 2 - 14, card.left + 20, card.left + card.width - 48), top: layout.arrow === "up" ? hole.top + hole.height + 1 : hole.top - 35 } : { left: layout.arrow === "left" ? hole.left + hole.width + 1 : hole.left - 35, top: clamp(hole.top + hole.height / 2 - 14, card.top + 14, card.top + card.height - 42) } : {};
  const progress = Math.min(100, Math.max(0, step / Math.max(1, total) * 100));

  return createPortal(<div className="tutorial-spotlight" data-tutorial-step={stepKey}>
    {scrims.map((box, index) => <div key={index} className="tutorial-scrim" style={box} aria-hidden="true" onPointerDown={event => event.preventDefault()} />)}
    {hole && <div className="tutorial-focus-ring" style={hole} aria-hidden="true" />}
    {hole && layout.arrow && <svg className={`tutorial-pointer ${layout.arrow}`} style={arrowStyle} width="28" height="34" viewBox="0 0 28 34" aria-hidden="true"><path d="M14 30V5M5 14l9-9 9 9" /></svg>}
    <section ref={cardRef} className={`tutorial-card${layout.compact ? " compact" : ""}`} style={{ left: card.left, top: card.top, width: card.width, maxHeight: card.height }} aria-labelledby={titleId} aria-describedby={descriptionId}>
      <div className="tutorial-card-head"><span><Sparkles size={14} aria-hidden="true" />使い方ガイド <b>{step} / {total}</b></span><button className="tutorial-close" type="button" onClick={onClose} aria-label="チュートリアルを終了"><X size={17} aria-hidden="true" /><span>終了</span></button></div>
      <div className="tutorial-card-body"><h2 id={titleId}>{title}</h2><p id={descriptionId}>{description}</p>{hint && <p className="tutorial-hint">{hint}</p>}</div>
      {(!layout.compact || onNext) && <div className="tutorial-card-footer"><div className="tutorial-progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>{onNext ? <button className="tutorial-next" type="button" onClick={onNext} disabled={busy}>{nextLabel}<ArrowRight size={17} aria-hidden="true" /></button> : <span className="tutorial-action-hint">{busy ? <><LoaderCircle size={15} className="tutorial-busy" aria-hidden="true" />採点を待っています</> : <>光っているところを操作<ArrowRight size={15} aria-hidden="true" /></>}</span>}</div>}
    </section>
    <span id={announcementId} className="sr-only" role="status" aria-live="polite" aria-atomic="true">{step} / {total}。{title}。{description}</span>
  </div>, layout.host);
}
