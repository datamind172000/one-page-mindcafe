"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import Script from "next/script";

export const META_PIXEL_ID = "1667702978300497";

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
  }
}

// Initialize the existing Meta Pixel exactly once. PageView is emitted by
// the effect only after the base script is ready, including on direct loads.
// This avoids racing the initial event with Next.js route hydration.
export function MetaPixel() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [scriptReady, setScriptReady] = useState(false);
  const lastTrackedUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!scriptReady || !window.fbq) return;

    // Read the live browser URL when the event fires. Meta's browser Pixel
    // derives its page URL (dl) from the document at tracking time.
    const url = window.location.href;
    if (lastTrackedUrl.current === url) return;

    window.fbq("track", "PageView");
    lastTrackedUrl.current = url;
  }, [scriptReady, pathname, searchParams]);

  return (
    <>
      <Script
        id="meta-pixel"
        strategy="afterInteractive"
        onReady={() => setScriptReady(true)}
      >
        {`
          !function(f,b,e,v,n,t,s)
          {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
          n.callMethod.apply(n,arguments):n.queue.push(arguments)};
          if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
          n.queue=[];t=b.createElement(e);t.async=!0;
          t.src=v;s=b.getElementsByTagName(e)[0];
          s.parentNode.insertBefore(t,s)}(window,document,'script',
          'https://connect.facebook.net/en_US/fbevents.js');
          fbq('init', '${META_PIXEL_ID}');
        `}
      </Script>
      <noscript>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          height="1"
          width="1"
          style={{ display: "none" }}
          src={`https://www.facebook.com/tr?id=${META_PIXEL_ID}&ev=PageView&noscript=1`}
          alt=""
        />
      </noscript>
    </>
  );
}
