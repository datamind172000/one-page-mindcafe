// Sends one approved WhatsApp template message through MSG91 — the same
// bulk-send endpoint and secrets the login-code hook (auth-send-sms) uses.
// Never throws: a WhatsApp problem must never break the order email or the
// order update that triggered it; the outcome is returned and logged.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type WhatsAppResult = { ok: true } | { ok: false; reason: string };

/** Normalises any Indian number to MSG91's "91XXXXXXXXXX" form, or null. */
export function toWhatsAppNumber(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  const last10 = digits.slice(-10);
  return /^[6-9]\d{9}$/.test(last10) ? `91${last10}` : null;
}

/** Session time as customers read it, e.g. "14 Nov, 5:30 pm" — always IST,
 *  since edge functions run in UTC. */
export function formatSessionTime(iso: string | null): string {
  if (!iso) return "to be scheduled";
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Booking's WhatsApp number and first name — guest phone, then profile/
// login phone. Same order of preference as orders, minus the address.
export async function resolveAppointmentWhatsApp(
  sb: SupabaseClient,
  appointment: { user_id: string | null; guest_phone?: string | null; guest_name?: string | null },
): Promise<{ to: string | null; name: string }> {
  let profilePhone: string | null = null;
  let authPhone: string | null = null;
  let fullName = appointment.guest_name ?? "";
  if (appointment.user_id) {
    const [{ data: profile }, { data: authUser }] = await Promise.all([
      sb.from("profiles").select("phone, full_name").eq("id", appointment.user_id).maybeSingle(),
      sb.auth.admin.getUserById(appointment.user_id),
    ]);
    profilePhone = profile?.phone ?? null;
    authPhone = authUser?.user?.phone ?? null;
    fullName = profile?.full_name || fullName;
  }
  const to = toWhatsAppNumber(appointment.guest_phone) ?? toWhatsAppNumber(profilePhone) ?? toWhatsAppNumber(authPhone);
  return { to, name: fullName.trim().split(/\s+/)[0] || "there" };
}

export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  bodyValues: string[],
): Promise<WhatsAppResult> {
  const authKey = Deno.env.get("MSG91_AUTH_KEY");
  const integratedNumber = Deno.env.get("MSG91_WHATSAPP_INTEGRATED_NUMBER");
  const namespace = Deno.env.get("MSG91_WHATSAPP_TEMPLATE_NAMESPACE");
  if (!authKey || !integratedNumber || !namespace) return { ok: false, reason: "MSG91 WhatsApp secrets not configured" };

  const components: Record<string, { type: "text"; value: string }> = {};
  bodyValues.forEach((value, index) => {
    components[`body_${index + 1}`] = { type: "text", value: value || "-" };
  });

  try {
    const res = await fetch("https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/", {
      method: "POST",
      headers: { authkey: authKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        integrated_number: integratedNumber,
        content_type: "template",
        payload: {
          messaging_product: "whatsapp",
          type: "template",
          template: {
            name: templateName,
            language: { code: "en", policy: "deterministic" },
            namespace,
            to_and_components: [{ to: [to], components }],
          },
        },
      }),
    });
    const text = await res.text();
    // MSG91 can answer 200 with a per-recipient failure in the body, so the
    // body is logged either way.
    console.log("WhatsApp send", templateName, res.status, text);
    return res.ok ? { ok: true } : { ok: false, reason: `HTTP ${res.status}: ${text.slice(0, 300)}` };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}
