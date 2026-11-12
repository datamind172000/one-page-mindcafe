// Triggered by the trg_notify_appointment DB trigger (setup.sql,
// pg_net-based — see notify_webhook()) on `appointments` INSERT and
// UPDATE. Sends up to two emails per event: one to the customer (as
// before), and one to the assigned expert, if there is one and they have
// a reachable email.
//
// An expert's email resolves two ways: via their linked login account
// (experts.profile_id -> auth.users.email) if they have one, or via
// experts.notification_email as a fallback for a directory-only listing
// with no login access. If neither is set, the expert side is silently
// skipped — the customer email still goes out either way.
//
// Payment gating: an appointment row is inserted as soon as the booking
// form is submitted, `payment_status: 'pending'`, BEFORE the Razorpay
// checkout modal even opens — so nobody gets emailed at insert time.
// Nobody hears about a booking until it's actually paid for: the
// "booking received, awaiting expert confirmation" email fires the
// moment payment_status flips to 'paid' (via confirm_appointment_payment,
// called from payment-webhook or the free-coupon path), not at insert.
// Every other status transition (confirmed/completed/cancelled) is also
// gated on payment_status === 'paid' — belt-and-braces alongside the
// prevent_unpaid_appointment_confirm DB trigger, which is the actual
// enforcement boundary stopping status from reaching 'confirmed' unpaid
// in the first place.
import { serviceRoleClient } from "../_shared/supabaseClients.ts";
import { sendEmail, renderEmail, SITE_URL, type SendEmailResult } from "../_shared/email.ts";
import { jsonResponse } from "../_shared/cors.ts";
import { formatSessionTime, resolveAppointmentWhatsApp, sendWhatsAppTemplate } from "../_shared/whatsapp.ts";

// No review-request CTA on 'completed' — a finished counselling session
// isn't a delivered product, and the customer already gets asked for
// feedback through other channels; the email just points back to their
// bookings instead.
const CUSTOMER_MESSAGES: Record<string, { heading: string; body: string; cta: { label: string; url: string } }> = {
  pending: {
    heading: "We've received your payment",
    body: "Your booking request has been sent to the expert for confirmation. We'll let you know as soon as they respond.",
    cta: { label: "view your bookings", url: `${SITE_URL}/account` },
  },
  confirmed: {
    heading: "Your session is confirmed!",
    body: "Your counsellor has confirmed this session. We'll see you at the scheduled time.",
    cta: { label: "view your bookings", url: `${SITE_URL}/account` },
  },
  completed: {
    heading: "Thanks for attending your session",
    body: "We hope it was helpful. You can book a follow-up session any time.",
    cta: { label: "book another session", url: `${SITE_URL}/book-appointment` },
  },
  cancelled: {
    heading: "Your session was cancelled",
    body: "This session won't be going ahead. If this wasn't expected, you're welcome to book a new session.",
    cta: { label: "book a new session", url: `${SITE_URL}/book-appointment` },
  },
};

const EXPERT_MESSAGES: Record<string, { heading: string; body: string; cta: { label: string; url: string } }> = {
  pending: {
    heading: "A new session is awaiting your confirmation",
    body: "A client has booked and paid for a session with you. Confirm or decline it from your dashboard.",
    cta: { label: "confirm or decline", url: `${SITE_URL}/expert/dashboard` },
  },
  confirmed: {
    heading: "A session on your calendar was confirmed",
    body: "This session is now confirmed and on your calendar.",
    cta: { label: "view your dashboard", url: `${SITE_URL}/expert/dashboard` },
  },
  completed: {
    heading: "A session was marked completed",
    body: "This session has been marked as completed.",
    cta: { label: "view your dashboard", url: `${SITE_URL}/expert/dashboard` },
  },
  cancelled: {
    heading: "A session on your calendar was cancelled",
    body: "This session won't be going ahead.",
    cta: { label: "view your dashboard", url: `${SITE_URL}/expert/dashboard` },
  },
};

type AppointmentRecord = {
  id: string;
  user_id: string | null;
  guest_email: string | null;
  guest_name: string | null;
  guest_phone: string | null;
  expert_id: string | null;
  status: string;
  payment_status: string;
  therapy_category: string;
  scheduled_at: string | null;
  meet_link: string | null;
};

type DbWebhookPayload = {
  type: "INSERT" | "UPDATE";
  table: string;
  record: AppointmentRecord;
  old_record: AppointmentRecord | null;
};

Deno.serve(async (req) => {
  const payload = (await req.json()) as DbWebhookPayload;
  const { type, record, old_record } = payload;

  if (!record) return jsonResponse({ skipped: true });

  // Nothing to tell anyone about until the appointment is paid for.
  if (record.payment_status !== "paid") {
    return jsonResponse({ skipped: true, reason: "payment not confirmed" });
  }

  const paymentJustConfirmed = old_record?.payment_status !== "paid";
  const statusChanged = type === "UPDATE" && record.status !== old_record?.status;

  // A plain re-save that neither just got paid nor changed status has
  // nothing new to report (e.g. razorpay_order_id being backfilled).
  if (!paymentJustConfirmed && !statusChanged) {
    return jsonResponse({ skipped: true, reason: "nothing changed" });
  }

  // Payment confirming for the first time is what "pending, awaiting
  // confirmation" actually means to a customer/expert — regardless of
  // what the status column happened to already say.
  const messageKey = paymentJustConfirmed ? "pending" : record.status;

  const sb = serviceRoleClient();
  const categoryLabel = record.therapy_category.replace("-", " & ");
  const whenLine = record.scheduled_at
    ? `Requested time: ${new Date(record.scheduled_at).toLocaleString("en-IN")}.`
    : null;
  // Once an expert confirms with a meet link attached, that link IS the
  // actionable next step for both sides — the CTA becomes "join the
  // meeting" pointing straight at it instead of the usual dashboard/
  // bookings link, so it's a real clickable button in the email, not just
  // plain-text the recipient has to copy.
  const hasMeetLink = messageKey === "confirmed" && Boolean(record.meet_link);
  const meetLinkLine = hasMeetLink ? `Meeting link: ${record.meet_link}` : null;

  let sentAny = false;

  const customerMessage = CUSTOMER_MESSAGES[messageKey];
  if (customerMessage) {
    // Same guest_email-first pattern as order-status-notifier's
    // resolveCustomerEmail — an account's email always wins when there is
    // one, guest_email is what a guest booking actually has.
    let email: string | null = record.guest_email;
    if (record.user_id) {
      const { data: authUser } = await sb.auth.admin.getUserById(record.user_id);
      email = authUser?.user?.email ?? null;
    }

    if (!email) {
      await sb
        .from("appointments")
        .update({
          last_notification_status: "no_email",
          last_notification_error: "No email on file for this booking",
          last_notification_at: new Date().toISOString(),
        })
        .eq("id", record.id);
    } else {
      const { text, html } = renderEmail({
        heading: customerMessage.heading,
        paragraphs: [
          `Counselling session — ${categoryLabel}.`,
          customerMessage.body,
          ...(whenLine ? [whenLine] : []),
          ...(meetLinkLine ? [meetLinkLine] : []),
        ],
        cta: hasMeetLink ? { label: "join the meeting", url: record.meet_link! } : customerMessage.cta,
      });
      const result: SendEmailResult = await sendEmail(email, `Your counselling booking: ${customerMessage.heading}`, text, html);
      // Tracked the same way orders are — a guest has no account/dashboard
      // to fall back on, so this email is their only way to know what
      // happened to their booking.
      await sb
        .from("appointments")
        .update({
          last_notification_status: result.ok ? "sent" : "failed",
          last_notification_error: result.ok ? null : result.reason,
          last_notification_at: new Date().toISOString(),
        })
        .eq("id", record.id);
      sentAny = true;
    }
  }

  // WhatsApp "booking received" to the customer, once, when payment lands.
  // Needs the mindcafe_appointment_booked Utility template approved in
  // MSG91 with body variables: first name, session type, requested time.
  // Off unless the WHATSAPP_APPOINTMENT_UPDATES secret is "on"; failures
  // are logged and never affect the emails.
  if (messageKey === "pending" && Deno.env.get("WHATSAPP_APPOINTMENT_UPDATES") === "on") {
    const { to, name } = await resolveAppointmentWhatsApp(sb, record);
    if (!to) {
      console.log("WhatsApp skipped — no valid phone for appointment", record.id);
    } else {
      const result = await sendWhatsAppTemplate(to, "mindcafe_appointment_booked", [name, categoryLabel, formatSessionTime(record.scheduled_at)]);
      if (!result.ok) console.error("WhatsApp appointment booked failed", record.id, result.reason);
      sentAny = sentAny || result.ok;
    }
  }

  const expertMessage = EXPERT_MESSAGES[messageKey];
  if (expertMessage && record.expert_id) {
    const { data: expert } = await sb
      .from("experts")
      .select("name, profile_id, notification_email")
      .eq("id", record.expert_id)
      .maybeSingle();

    if (expert) {
      let expertEmail: string | null = expert.notification_email;
      if (expert.profile_id) {
        const { data: authUser } = await sb.auth.admin.getUserById(expert.profile_id);
        expertEmail = authUser?.user?.email ?? expertEmail;
      }

      if (expertEmail) {
        const { text, html } = renderEmail({
          heading: expertMessage.heading,
          paragraphs: [
            `Category: ${categoryLabel}.`,
            expertMessage.body,
            ...(whenLine ? [whenLine] : []),
            ...(meetLinkLine ? [meetLinkLine] : []),
          ],
          cta: hasMeetLink ? { label: "join the meeting", url: record.meet_link! } : expertMessage.cta,
        });
        await sendEmail(expertEmail, `Booking update: ${expertMessage.heading}`, text, html);
        sentAny = true;
      }
    }
  }

  return jsonResponse(sentAny ? { sent: true } : { skipped: true, reason: "no reachable email" });
});
