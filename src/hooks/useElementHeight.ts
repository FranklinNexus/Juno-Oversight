"use client";

import { useCallback, useEffect, useState } from "react";

/** Observes an element's content height; returns a callback ref + height. */
export function useElementHeight(): {
  ref: (node: HTMLElement | null) => void;
  height: number;
} {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [height, setHeight] = useState(0);

  const ref = useCallback((el: HTMLElement | null) => {
    setNode(el);
  }, []);

  useEffect(() => {
    if (!node) return;

    const measure = () => {
      setHeight(Math.floor(node.getBoundingClientRect().height));
    };

    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);

  return { ref, height };
}
