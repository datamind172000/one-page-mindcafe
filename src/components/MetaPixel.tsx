"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Script from "next/script";

// This is the existing MindCafe Pixel. Never initialise a second dataset.
export const META_PIXEL_ID = "1667702978300497";

// Explicit allowlist. Unknown and health-related paths are denied by default.
// Product pages can be added only after confirming their URL/content is safe.
const ALLOWED_PATHS = new Set(["/", "/feelz", "/cart", "/checkout"]);
const ALLOWED_PREFIXES = ["/products/"];

function allowedPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return ALLOWED_PATHS.has(path) ||
    ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix) && path.length > prefix.length);
}

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
  }
}

export function MetaPixel() {
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  const lastTrackedPath = useRef<string | null>(null);
  const previousPath = useRef(pathname);
  const allowed = allowedPath(pathname);

  // A loaded third-party Pixel cannot reliably be unloaded from an SPA.
  // Force a document navigation across the allowlist boundary to prevent
  // the existing instance from persisting onto sensitive routes.
  useEffect(() => {
    if (previousPath.current !== pathname) {
      const crossedBoundary = allowedPath(previousPath.current) !== allowed;
      previousPath.current = pathname;
      if (crossedBoundary) {
        window.location.replace(window.location.href);
        return;
      }
    }
  }, [pathname, allowed]);

  useEffect(() => {
    if (!allowed || !ready || !window.fbq) return;
    // Never send query strings: they may contain order identifiers, UTMs,
    // tokens, or personal/health information. The Pixel derives its
    // document URL automatically, so only fire on a query-free URL.
    if (window.location.search || window.location.hash) return;
    if (lastTrackedPath.current === pathname) return;
    window.fbq("trackSingle", META_PIXEL_ID, "PageView");
    lastTrackedPath.current = pathname;
  }, [allowed, pathname, ready]);

  if (!allowed) return null;

  return (
    <>
      <Script id="meta-pixel" strategy="afterInteractive" onReady={() => setReady(true)}>
        {`
          !function(f,b,e,v,n,t,s)
          {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
          n.callMethod.apply(n,arguments):n.queue.push(arguments)};
          if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
          n.queue=[];t=b.createElement(e);t.async=!0;
          t.src=v;s=b.getElementsByTagName(e)[0];
          s.parentNode.insertBefore(t,s)}(window,document,'script',
          'https://connect.facebook.net/en_US/fbevents.js');
          fbq('set', 'autoConfig', false, '1667702978300497');
          fbq('init', '1667702978300497');
        `}
      </Script>
    </>
  );
}
