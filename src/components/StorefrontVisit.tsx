"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getStorefrontCampaign, storefrontTrackingEnabled } from "@/lib/storefrontCampaign";

const VISITOR_KEY = "mindcafe_storefront_visitor";
const VALID_VISITOR = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function StorefrontVisit() {
  const pathname = usePathname();
  const lastPage = useRef<string | null>(null);

  useEffect(() => {
    const path = pathname?.replace(/\/$/, "");
    if (!path || !/^\/feelz(?:\/(?:extrovert|focus|joy|rest))?$/.test(path) ||
      !storefrontTrackingEnabled()) return;
    const currentUrl = pathname + window.location.search;
    if (lastPage.current === currentUrl) return;
    lastPage.current = currentUrl;
    try {
      const current = localStorage.getItem(VISITOR_KEY);
      const visitor = current && VALID_VISITOR.test(current) ? current : crypto.randomUUID();
      if (current !== visitor) localStorage.setItem(VISITOR_KEY, visitor);
      const sb = createClient();
      void sb.rpc("record_feelz_page", {
        p_event: crypto.randomUUID(),
        p_visitor: visitor,
        p_product: path !== "/feelz",
        p_campaign: getStorefrontCampaign(),
      }).then(({ error }) => {
        if (error) void sb.rpc("record_storefront_visit", { p_visitor: visitor }).then(() => undefined);
      }, () => undefined);
    } catch {
      // Shopping stays available when browser storage is disabled.
    }
  }, [pathname]);

  return null;
}
