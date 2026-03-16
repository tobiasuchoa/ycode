'use client';

import { useEffect, useRef } from 'react';

interface CustomCodeInjectorProps {
  html: string;
}

/**
 * Injects custom HTML/script code after React hydration.
 * Renders an empty container on SSR to avoid hydration mismatches,
 * then injects and executes scripts via useEffect on the client.
 */
export default function CustomCodeInjector({ html }: CustomCodeInjectorProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.innerHTML = html;

    const scripts = container.querySelectorAll('script');
    scripts.forEach((original) => {
      const script = document.createElement('script');
      Array.from(original.attributes).forEach((attr) => {
        script.setAttribute(attr.name, attr.value);
      });
      if (original.textContent) {
        script.textContent = original.textContent;
      }
      original.replaceWith(script);
    });
  }, [html]);

  return <div ref={containerRef} />;
}
