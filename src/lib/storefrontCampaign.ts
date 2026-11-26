import { createClient } from "@/lib/supabase/client";
import { readGuestSessionId } from "@/lib/guestSession";

const keys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "campaign_id", "adset_id", "ad_id"] as const;
const storageKey = "mindcafe_feelz_campaign";
const lifetime = 7 * 24 * 60 * 60 * 1000;

export function storefrontTrackingEnabled() {
  const host = window.location.hostname;
  return host === "www.mindcafe.app" || host === "mindcafe.app" ||
    host === process.env.NEXT_PUBLIC_STOREFRONT_FUNNEL_TEST_HOST;
}

export function getStorefrontCampaign() {
  const query = new URLSearchParams(window.location.search);
  const tagged: Record<string, string> = {};
  for (const key of keys) {
    const value = query.get(key)?.trim();
    const valid = key.endsWith("_id") ? /^\d{1,24}$/ : /^[\p{L}\p{N} _./+%-]{1,100}$/u;
    if (value && valid.test(value)) tagged[key] = value;
  }
  if (Object.keys(tagged).length) {
    try { localStorage.setItem(storageKey, JSON.stringify({ expires: Date.now() + lifetime, tags: tagged })); } catch {}
    return tagged;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (saved?.expires > Date.now()) return saved.tags as Record<string, string>;
    const host = document.referrer ? new URL(document.referrer).hostname : "";
    const matches = (domain: string) => host === domain || host.endsWith("." + domain);
    const source = matches("facebook.com") ? "facebook" : matches("instagram.com") ? "instagram" : null;
    if (source) {
      const tags = { utm_source: source, utm_medium: "referral" };
      localStorage.setItem(storageKey, JSON.stringify({ expires: Date.now() + lifetime, tags }));
      return tags;
    }
  } catch {}
  return {};
}

export async function recordStorefrontCart(cart: string, checkout: boolean) {
  if (!storefrontTrackingEnabled()) return;
  try {
    await createClient().rpc("record_feelz_cart_campaign", {
      p_cart: cart,
      p_guest: readGuestSessionId(),
      p_campaign: getStorefrontCampaign(),
      p_checkout: checkout,
    });
  } catch {
    // Reporting failure must never prevent shopping.
  }
}
