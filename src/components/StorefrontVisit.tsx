"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const VISITOR_KEY = "mindcafe_storefront_visitor";
const VALID_VISITOR = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function StorefrontVisit() {
  const pathname = usePathname();

  useEffect(() => {
    const hostname = window.location.hostname;
    const testHost = process.env.NEXT_PUBLIC_STOREFRONT_FUNNEL_TEST_HOST;
    if (hostname !== "www.mindcafe.app" && hostname !== "mindcafe.app" && hostname !== testHost) return;

    try {
      const current = localStorage.getItem(VISITOR_KEY);
      const visitor = current && VALID_VISITOR.test(current) ? current : crypto.randomUUID();
      if (current !== visitor) localStorage.setItem(VISITOR_KEY, visitor);
      void createClient().rpc("record_storefront_visit", { p_visitor: visitor }).then(
        () => undefined,
        () => undefined,
      );
    } catch {
      // Shopping stays available when browser storage is disabled.
    }
  }, [pathname]);

  return null;
}
