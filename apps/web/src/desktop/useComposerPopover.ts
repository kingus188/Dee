import { useLayoutEffect, useState } from "react";
import type { CSSProperties, RefObject } from "react";

export function useComposerPopover(open: boolean, root: RefObject<HTMLDivElement | null>, maxWidth: number) {
  const [placement, setPlacement] = useState<CSSProperties>();
  useLayoutEffect(() => {
    if (!open) return;
    const composer = root.current?.closest(".input-box-wrapper");
    if (!composer) return;
    const place = () => {
      const rect = composer.getBoundingClientRect();
      setPlacement({ position: "fixed", left: "auto", width: Math.min(maxWidth, rect.width * 2 / 3), right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.top + 12, maxHeight: Math.max(0, Math.min(380, rect.top - 24)) });
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    observer?.observe(composer);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { observer?.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, root, maxWidth]);
  return placement;
}
