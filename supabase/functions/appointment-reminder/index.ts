// Scheduled (Dashboard -> Edge Functions -> appointment-reminder -> Cron,
// same mechanism as cleanup-reservations), not event-triggered like
// appointment-notifier — there's no single write to react to for "this
// session is coming up soon", only the passage of time. Needs a much
// tighter schedule than the daily /api/cron-reminders Vercel cron (which
// is capped at once/day on Vercel's Hobby plan): run this one every
// 10-15 minutes so the 1-hour-before reminder actually lands within the
// hour, not once a day.
//
// "Threshold crossed" pattern, same shape as pickup-reminder/cart-reminder:
// once an appointment's scheduled_at comes within 24h (or 1h), it
// qualifies for that reminder exactly once — reminder_24h_sent_at /
// reminder_1h_sent_at are the dedup markers, set right after sending so
// a re-run (this function fires every few minutes) never double-emails
// the same appointment for the same reminder. Only 'confirmed' sessions
// get reminded — a still-'pending' one hasn't been accepted by the
// expert yet, and payment_status must already be 'paid' for any
// appointment to have reached 'confirmed' in the first place (see the
// prevent_unpaid_appointment_confirm DB trigger).
import { serviceRoleClient } from "../_shared/supabaseClients.ts";
import { sendEmail, renderEmail, SITE_URL } from "../_shared/email.ts";
import { jsonResponse } from "../_shared/cors.ts";
import { formatSessionTime, resolveAppointmentWhatsApp, sendWhatsAppTemplate } from "../_shared/whatsapp.ts";

type ReminderWindow = "24h" | "1h";

const WINDOWS: { key: ReminderWindow; hoursAhead: number; column: "reminder_24h_sent_at" | "reminder_1h_sent_at" }[] = [
  { key: "24h", hoursAhead: 24, column: "reminder_24h_sent_at" },
  { key: "1h", hoursAhead: 1, column: "reminder_1h_sent_at" },
];

type AppointmentRow = {
  id: string;
  user_id: string | null;
  guest_name: string | null;
  guest_phone: string | null;
  expert_id: string | null;
  therapy_category: string;
  scheduled_at: string;
  meet_link: string | null;
};

async function remindOne(
  sb: ReturnType<typeof serviceRoleClient>,
  appointment: AppointmentRow,
  window: ReminderWindow,
): Promise<boolean> {
  const categoryLabel = appointment.therapy_category.replace("-", " & ");
  const whenLine = `Scheduled for ${new Date(appointment.scheduled_at).toLocaleString("en-IN")}.`;
  const timeframe = window === "24h" ? "in about 24 hours" : "in about an hour";
  const meetLink = appointment.meet_link;
  const meetLinkLine = meetLink ? `Meeting link: ${meetLink}` : null;

  let sentAny = false;

  const customerEmail = appointment.user_id
    ? (await sb.auth.admin.getUserById(appointment.user_id)).data?.user?.email
    : null;
  if (customerEmail) {
    const { text, html } = renderEmail({
      heading: `Your session is coming up ${timeframe}`,
      paragraphs: [`Counselling session — ${categoryLabel}.`, whenLine, ...(meetLinkLine ? [meetLinkLine] : [])],
      cta: meetLink ? { label: "join the meeting", url: meetLink } : { label: "view your bookings", url: `${SITE_URL}/account` },
    });
    await sendEmail(customerEmail, `Reminder: your counselling session is ${timeframe}`, text, html);
    sentAny = true;
  }

  // WhatsApp reminder to the customer — guests included, who have no
  // reminder email. Needs the mindcafe_appointment_reminder Utility
  // template approved in MSG91 with body variables: first name, timeframe,
  // session time, meeting link. Off unless WHATSAPP_APPOINTMENT_UPDATES is
  // "on"; failures are logged and never affect the emails.
  if (Deno.env.get("WHATSAPP_APPOINTMENT_UPDATES") === "on") {
    const { to, name } = await resolveAppointmentWhatsApp(sb, appointment);
    if (to) {
      const result = await sendWhatsAppTemplate(to, "mindcafe_appointment_reminder", [
        name,
        timeframe,
        formatSessionTime(appointment.scheduled_at),
        meetLink ?? `${SITE_URL}/account`,
      ]);
      if (!result.ok) console.error("WhatsApp appointment reminder failed", appointment.id, window, result.reason);
      sentAny = sentAny || result.ok;
    }
  }

  if (appointment.expert_id) {
    const { data: expert } = await sb
      .from("experts")
      .select("profile_id, notification_email")
      .eq("id", appointment.expert_id)
      .maybeSingle();

    if (expert) {
      let expertEmail: string | null = expert.notification_email;
      if (expert.profile_id) {
        const { data: expertAuthUser } = await sb.auth.admin.getUserById(expert.profile_id);
        expertEmail = expertAuthUser?.user?.email ?? expertEmail;
      }

      if (expertEmail) {
        const { text, html } = renderEmail({
          heading: `Session coming up ${timeframe}`,
          paragraphs: [`Category: ${categoryLabel}.`, whenLine, ...(meetLinkLine ? [meetLinkLine] : [])],
          cta: meetLink ? { label: "join the meeting", url: meetLink } : { label: "view your dashboard", url: `${SITE_URL}/expert/dashboard` },
        });
        await sendEmail(expertEmail, `Reminder: session ${timeframe}`, text, html);
        sentAny = true;
      }
    }
  }

  return sentAny;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok");

  const sb = serviceRoleClient();
  const now = Date.now();
  let sent = 0;
  let checked = 0;

  for (const window of WINDOWS) {
    const cutoff = new Date(now + window.hoursAhead * 60 * 60 * 1000).toISOString();

    const { data: appointments, error } = await sb
      .from("appointments")
      .select("id, user_id, guest_name, guest_phone, expert_id, therapy_category, scheduled_at, meet_link")
      .eq("status", "confirmed")
      .is(window.column, null)
      .not("scheduled_at", "is", null)
      .gt("scheduled_at", new Date(now).toISOString())
      .lte("scheduled_at", cutoff);

    if (error) {
      console.error(`appointment-reminder: query failed for ${window.key}`, error);
      continue;
    }

    checked += appointments?.length ?? 0;

    for (const appointment of appointments ?? []) {
      const didSend = await remindOne(sb, appointment as AppointmentRow, window.key);
      if (didSend) sent++;
      await sb
        .from("appointments")
        .update({ [window.column]: new Date().toISOString() })
        .eq("id", appointment.id);
    }
  }

  return jsonResponse({ checked, sent });
});
