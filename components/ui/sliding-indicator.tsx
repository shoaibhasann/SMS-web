"use client";

import { useEffect, useRef } from "react";

/**
 * Slides a highlight behind the pressed (aria-pressed="true") button of its parent group.
 * Render it as the group's first child, with the classes of the pressed button's highlight.
 * Until the first placement the pressed button keeps its own highlight, so server HTML and the
 * first paint never flash; app/globals.css hands the highlight over once the group is "ready".
 */
export function SlidingIndicator({ className }: { className: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const indicator = ref.current;
    const group = indicator?.parentElement;
    if (!indicator || !group) return;
    let placed = "";
    const place = (animate: boolean) => {
      const active = [...group.children].find((child): child is HTMLElement => child instanceof HTMLElement && child.getAttribute("aria-pressed") === "true");
      const next = active ? `${active.offsetWidth}:${active.offsetHeight}:${active.offsetLeft}:${active.offsetTop}` : "";
      if (next === placed) return; // a resize that moved nothing must not cut a running slide short
      placed = next;
      if (!animate || !active) delete indicator.dataset.ready;
      if (!active) return;
      indicator.style.width = `${active.offsetWidth}px`;
      indicator.style.height = `${active.offsetHeight}px`;
      indicator.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
      if (indicator.dataset.ready === undefined) {
        indicator.getBoundingClientRect(); // commit the jump before transitions turn on
        indicator.dataset.ready = "";
      }
    };
    const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => place(false));
    const pressed = new MutationObserver(() => {
      for (const child of group.children) resized?.observe(child);
      place(true);
    });

    group.dataset.slider = ""; // positions the group before measuring
    place(false);
    group.dataset.slider = "ready";
    resized?.observe(group);
    for (const child of group.children) resized?.observe(child);
    pressed.observe(group, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-pressed"] });
    return () => {
      pressed.disconnect();
      resized?.disconnect();
      delete group.dataset.slider;
    };
  }, []);

  return <span ref={ref} aria-hidden="true" data-sliding-indicator=""
    className={`pointer-events-none absolute left-0 top-0 -z-10 opacity-0 data-ready:opacity-100 motion-safe:data-ready:transition-[transform,width,height] motion-safe:data-ready:duration-300 motion-safe:data-ready:ease-[cubic-bezier(.2,.8,.2,1)] ${className}`} />;
}
