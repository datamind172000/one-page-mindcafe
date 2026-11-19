"use client";

const KEY = "mindcafe_first_touch_v1";
export type FirstTouch = Partial<Record<"utm_source" | "utm_medium" | "utm_campaign" | "utm_content" | "fbclid", string>>;
const FIELDS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "fbclid"] as const;
const MAX_LENGTH = 160;
const SAFE = /^[a-zA-Z0-9_.~%-]+$/;

export function readFirstTouch(): FirstTouch {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(FIELDS.flatMap((key) => {
      const candidate = (value as Record<string, unknown>)[key];
      return typeof candidate === "string" && candidate.length <= MAX_LENGTH && SAFE.test(candidate)
        ? [[key, candidate]] : [];
    })) as FirstTouch;
  } catch { return {}; }
}

export function captureFirstTouch(): void {
  try {
    if (localStorage.getItem(KEY) !== null) return;
    const url = new URL(window.location.href);
    const values: FirstTouch = {};
    for (const key of FIELDS) {
      const value = url.searchParams.get(key);
      if (value && value.length <= MAX_LENGTH && SAFE.test(value)) values[key] = value;
    }
    if (Object.keys(values).length) localStorage.setItem(KEY, JSON.stringify(values));
  } catch { /* storage unavailable */ }
}
