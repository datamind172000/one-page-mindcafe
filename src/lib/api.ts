import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import type {
  Address,
  Appointment,
  AppointmentNote,
  AppointmentWithCustomer,
  AppointmentWithExpert,
  Cart,
  CartItemWithVariant,
  Expert,
  Faq,
  Milestone,
  OrderWithItemDetails,
  OrderWithItems,
  PickupLocation,
  Product,
  Profile,
  ProductWithVariants,
  Review,
  TherapyCategory,
} from "@/types/domain";
import type { Json } from "@/types/supabase";

// Normalized error shape thrown by every function below, so callers don't
// have to know about PostgREST's raw error format.
export class ApiError extends Error {
  readonly context: string;
  readonly cause?: unknown;

  constructor(context: string, cause?: unknown) {
    const message =
      cause && typeof cause === "object" && "message" in cause
        ? String((cause as { message: unknown }).message)
        : `Request failed: ${context}`;
    super(message);
    this.name = "ApiError";
    this.context = context;
    this.cause = cause;
  }
}

function throwOnError(context: string, error: unknown): void {
  if (error) throw new ApiError(context, error);
}

type Sb = SupabaseClient<Database>;

// --- Auth / profile ---------------------------------------------------

export async function fetchProfile(sb: Sb, userId: string): Promise<Profile | null> {
  const { data, error } = await sb.from("profiles").select("*").eq("id", userId).maybeSingle();
  throwOnError("fetchProfile", error);
  return data;
}

export async function updateProfile(
  sb: Sb,
  userId: string,
  input: Database["public"]["Tables"]["profiles"]["Update"],
): Promise<Profile> {
  const { data, error } = await sb.from("profiles").update(input).eq("id", userId).select("*").single();
  throwOnError("updateProfile", error);
  return data!;
}

// --- Products -----------------------------------------------------------

export async function getFeelzCatalog(sb: Sb): Promise<ProductWithVariants[]> {
  const { data, error } = await sb
    .from("products")
    .select("*, product_variants(*)")
    .eq("is_active", true)
    .order("name");
  throwOnError("getFeelzCatalog", error);
  return (data as ProductWithVariants[]) ?? [];
}

// Lighter than getFeelzCatalog — the homepage teaser only shows name+image,
// no pricing/variant data, so there's no reason to fetch or couple to it.
export async function getFeelzTeaser(sb: Sb, limit = 4): Promise<Pick<Product, "id" | "name" | "image_url" | "price">[]> {
  const { data, error } = await sb
    .from("products")
    .select("id, name, image_url, price")
    .eq("is_active", true)
    // The bundle isn't a mood — this teaser shows the four moods only.
    .eq("is_bundle", false)
    .order("name")
    .limit(limit);
  throwOnError("getFeelzTeaser", error);
  return data ?? [];
}

export async function getAvailableStock(sb: Sb, variantId: string, locationId: string | null = null) {
  const { data, error } = await sb.rpc("available_stock", { p_variant_id: variantId, p_location_id: locationId });
  throwOnError("getAvailableStock", error);
  return data ?? 0;
}

// --- Cart -----------------------------------------------------------------

export async function getOrCreateCart(
  sb: Sb,
  identity: { userId: string | null; sessionId: string | null },
): Promise<Cart> {
  const { userId, sessionId } = identity;
  if (!userId && !sessionId) throw new ApiError("getOrCreateCart", { message: "no user or guest session id" });

  const query = sb.from("carts").select("*").eq("status", "active");
  const { data: existing, error: selectError } = userId
    ? await query.eq("user_id", userId).maybeSingle()
    : await query.eq("session_id", sessionId!).maybeSingle();
  throwOnError("getOrCreateCart.select", selectError);
  if (existing) return existing;

  const { data: created, error: insertError } = await sb
    .from("carts")
    .insert(userId ? { user_id: userId } : { session_id: sessionId })
    .select("*")
    .single();
  throwOnError("getOrCreateCart.insert", insertError);
  return created!;
}

export async function getCartItems(sb: Sb, cartId: string): Promise<CartItemWithVariant[]> {
  const { data, error } = await sb
    .from("cart_items")
    .select("*, product_variants(*, products(id, name, image_url, price, is_bundle))")
    .eq("cart_id", cartId);
  throwOnError("getCartItems", error);
  return (data as unknown as CartItemWithVariant[]) ?? [];
}

export async function addCartItem(sb: Sb, cartId: string, variantId: string, quantity: number) {
  const { data: existing } = await sb
    .from("cart_items")
    .select("id, quantity")
    .eq("cart_id", cartId)
    .eq("variant_id", variantId)
    .maybeSingle();

  if (existing) return updateCartItemQuantity(sb, existing.id, existing.quantity + quantity);

  const { data, error } = await sb
    .from("cart_items")
    .insert({ cart_id: cartId, variant_id: variantId, quantity })
    .select("*")
    .single();
  throwOnError("addCartItem", error);
  return data!;
}

export async function updateCartItemQuantity(sb: Sb, cartItemId: string, quantity: number) {
  if (quantity <= 0) {
    await removeCartItem(sb, cartItemId);
    return null;
  }
  const { data, error } = await sb.from("cart_items").update({ quantity }).eq("id", cartItemId).select("*").single();
  throwOnError("updateCartItemQuantity", error);
  return data!;
}

export async function removeCartItem(sb: Sb, cartItemId: string) {
  const { error } = await sb.from("cart_items").delete().eq("id", cartItemId);
  throwOnError("removeCartItem", error);
}

export async function mergeGuestCart(sb: Sb, guestSessionId: string): Promise<void> {
  try {
    await sb.functions.invoke("merge-guest-cart", { body: { guest_session_id: guestSessionId } });
  } catch {
    // best-effort — login must never be blocked by this failing
  }
}

// Reattaches guest orders/appointments placed under the same phone number
// to this now-authenticated account — see claim-guest-records/index.ts for
// why matching is scoped to unclaimed (user_id is null) rows only.
export async function claimGuestRecords(sb: Sb): Promise<void> {
  try {
    await sb.functions.invoke("claim-guest-records", { body: {} });
  } catch {
    // best-effort — login must never be blocked by this failing
  }
}

// --- Addresses --------------------------------------------------------

export async function getUserAddresses(sb: Sb, userId: string): Promise<Address[]> {
  const { data, error } = await sb
    .from("addresses")
    .select("*")
    .eq("user_id", userId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false });
  throwOnError("getUserAddresses", error);
  return data ?? [];
}

export async function createAddress(
  sb: Sb,
  input: Database["public"]["Tables"]["addresses"]["Insert"],
): Promise<Address> {
  const { data, error } = await sb.from("addresses").insert(input).select("*").single();
  throwOnError("createAddress", error);
  return data!;
}

export async function updateAddress(
  sb: Sb,
  addressId: string,
  input: Database["public"]["Tables"]["addresses"]["Update"],
): Promise<Address> {
  const { data, error } = await sb.from("addresses").update(input).eq("id", addressId).select("*").single();
  throwOnError("updateAddress", error);
  return data!;
}

export async function deleteAddress(sb: Sb, addressId: string): Promise<void> {
  const { error } = await sb.from("addresses").delete().eq("id", addressId);
  throwOnError("deleteAddress", error);
}

export type PincodeServiceability =
  | { serviceable: true; deliveryFee: number; courierName: string; etd: string | null }
  | { serviceable: false };

// Real-time check against Shiprocket's own courier network (via the
// check-pincode-serviceability Edge Function), not a static local table —
// covers virtually all of India rather than a hand-picked few cities.
// create-order re-runs this same check server-side as the authoritative
// price; this is just the checkout-time estimate shown to the customer.
export async function checkPincodeServiceability(
  sb: Sb,
  pincode: string,
  items: { variant_id: string; quantity: number }[],
): Promise<PincodeServiceability> {
  const { data, error } = await sb.functions.invoke("check-pincode-serviceability", { body: { pincode, items } });
  if (error) {
    const detail = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new ApiError("checkPincodeServiceability", { message: detail?.error ?? error.message });
  }
  return data as PincodeServiceability;
}

// --- Pickup locations (Zostel takeaway points) -----------------------

export async function getActivePickupLocations(sb: Sb, city?: string): Promise<PickupLocation[]> {
  let query = sb.from("pickup_locations").select("*").eq("is_active", true);
  if (city) query = query.eq("city", city);
  const { data, error } = await query.order("name");
  throwOnError("getActivePickupLocations", error);
  return data ?? [];
}

// --- Marketing / CMS (site_settings, newsletter, reviews) -----------------

// Generic key/value CMS store — the announcement bar and homepage stat
// chips read from this so marketing can change copy without a deploy.
// Returns null (not a thrown error) when the key hasn't been configured
// yet, so callers can fall back to a sensible hardcoded default.
export async function getSiteSetting<T = unknown>(sb: Sb, key: string): Promise<T | null> {
  const { data, error } = await sb.from("site_settings").select("value").eq("key", key).maybeSingle();
  throwOnError("getSiteSetting", error);
  return (data?.value as T | undefined) ?? null;
}

// Public insert-only per RLS — a duplicate email is a user-facing
// "already subscribed" state, not an error to surface as broken.
export async function subscribeToNewsletter(sb: Sb, email: string): Promise<{ alreadySubscribed: boolean }> {
  const { error } = await sb.from("newsletter_subscribers").insert({ email: email.trim().toLowerCase() });
  if (error) {
    if (error.code === "23505") return { alreadySubscribed: true };
    throw new ApiError("subscribeToNewsletter", error);
  }
  return { alreadySubscribed: false };
}

// Homepage trust-stats row: real counts, not invented copy. Sessions goes
// through confirmed_sessions_count() (a security definer RPC — the
// appointments_select RLS policy is owner/expert/admin-only, so a plain
// client-side count would return 0 for an anonymous visitor); experts and
// pickup_locations are both publicly selectable already, so a direct
// count query works for those.
export async function getHomepageStats(sb: Sb): Promise<{ sessionsBooked: number; expertsCount: number; zostelLocationsCount: number }> {
  const [sessionsResult, expertsResult, locationsResult] = await Promise.all([
    sb.rpc("confirmed_sessions_count"),
    sb.from("experts").select("*", { count: "exact", head: true }).eq("is_active", true),
    sb.from("pickup_locations").select("*", { count: "exact", head: true }).eq("is_active", true),
  ]);
  throwOnError("getHomepageStats (sessions)", sessionsResult.error);
  throwOnError("getHomepageStats (experts)", expertsResult.error);
  throwOnError("getHomepageStats (locations)", locationsResult.error);
  return {
    sessionsBooked: sessionsResult.data ?? 0,
    expertsCount: expertsResult.count ?? 0,
    zostelLocationsCount: locationsResult.count ?? 0,
  };
}

export async function getRecentReviews(sb: Sb, limit = 4): Promise<Review[]> {
  const { data, error } = await sb.from("reviews").select("*").order("created_at", { ascending: false }).limit(limit);
  throwOnError("getRecentReviews", error);
  return data ?? [];
}

// Real average + count across every review, not just the handful shown in
// the teaser — computed from actual rows, never a placeholder/fabricated
// stat. Returns null when there are no reviews yet so the caller can hide
// the summary line entirely instead of showing "0/5 from 0 reviews".
export async function getReviewsSummary(sb: Sb): Promise<{ average: number; count: number } | null> {
  const { data, error } = await sb.from("reviews").select("rating");
  throwOnError("getReviewsSummary", error);
  if (!data || data.length === 0) return null;
  const average = data.reduce((sum, r) => sum + r.rating, 0) / data.length;
  return { average, count: data.length };
}

// Full /reviews page — paginated, optionally filtered to a star rating.
export async function getReviewsPage(
  sb: Sb,
  options: { page: number; pageSize: number; rating?: number },
): Promise<{ reviews: Review[]; total: number }> {
  const from = options.page * options.pageSize;
  const to = from + options.pageSize - 1;
  let query = sb.from("reviews").select("*", { count: "exact" }).eq("is_corporate", false);
  if (options.rating) query = query.eq("rating", options.rating);
  const { data, error, count } = await query.order("created_at", { ascending: false }).range(from, to);
  throwOnError("getReviewsPage", error);
  return { reviews: data ?? [], total: count ?? 0 };
}

// --- Counselling (experts, therapy categories) -----------------------------

// Public read is already scoped to is_active by RLS (experts_select), but
// filtering here too keeps the query self-documenting and lets a future
// admin-only view reuse the same table without a second function.
export async function getActiveExperts(sb: Sb, specialty?: string): Promise<Expert[]> {
  let query = sb.from("experts").select("*").eq("is_active", true);
  if (specialty) query = query.contains("specialties", [specialty]);
  const { data, error } = await query
    .order("rating", { ascending: false, nullsFirst: false })
    .order("sort_order", { ascending: true });
  throwOnError("getActiveExperts", error);
  return data ?? [];
}

export async function getExpertById(sb: Sb, id: string): Promise<Expert | null> {
  const { data, error } = await sb.from("experts").select("*").eq("id", id).eq("is_active", true).maybeSingle();
  throwOnError("getExpertById", error);
  return data;
}

export async function getTherapyCategories(sb: Sb): Promise<TherapyCategory[]> {
  const { data, error } = await sb.from("therapy_categories").select("*").order("title");
  throwOnError("getTherapyCategories", error);
  return data ?? [];
}

export async function getTherapyCategory(sb: Sb, slug: string): Promise<TherapyCategory | null> {
  const { data, error } = await sb.from("therapy_categories").select("*").eq("slug", slug).maybeSingle();
  throwOnError("getTherapyCategory", error);
  return data;
}

// --- Appointments -----------------------------------------------------------

export type BookAppointmentInput = {
  therapyCategory: string;
  expertId?: string;
  scheduledAt?: string;
  notes?: string;
  couponCode?: string;
  /** Omit when signed in. Required to book without an account — name and
   * phone are the only mandatory fields, matching orders' guest checkout
   * (see create-appointment-order and the appointments_guest_needs_contact
   * check constraint). */
  guest?: { name: string; phone: string; email?: string };
};

export type BookAppointmentResponse =
  | { appointmentId: string; requiresPayment: false; price: number; discountAmount: number; total: 0 }
  | {
      appointmentId: string;
      requiresPayment: true;
      razorpayOrderId: string;
      amount: number;
      currency: string;
      keyId: string;
      price: number;
      discountAmount: number;
      total: number;
    };

// Invokes the create-appointment-order Edge Function: it looks up the
// real session price, validates the coupon (appointments-scoped codes
// only), creates the appointment row, and either marks it paid outright
// (a coupon covering the full price) or creates a matching Razorpay
// order — same server-side-truth pattern as `checkout` for Feelz orders.
export async function bookAppointment(sb: Sb, input: BookAppointmentInput): Promise<BookAppointmentResponse> {
  const { data, error } = await sb.functions.invoke("create-appointment-order", {
    body: {
      therapy_category: input.therapyCategory,
      expert_id: input.expertId,
      scheduled_at: input.scheduledAt,
      notes: input.notes,
      coupon_code: input.couponCode || undefined,
      guest: input.guest,
    },
  });
  if (error) {
    const detail = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new ApiError("bookAppointment", { message: detail?.error ?? error.message });
  }
  return data.requires_payment
    ? {
        appointmentId: data.appointment_id,
        requiresPayment: true,
        razorpayOrderId: data.razorpay_order_id,
        amount: data.amount,
        currency: data.currency,
        keyId: data.key_id,
        price: data.price,
        discountAmount: data.discount_amount,
        total: data.total,
      }
    : {
        appointmentId: data.appointment_id,
        requiresPayment: false,
        price: data.price,
        discountAmount: data.discount_amount,
        total: 0,
      };
}

// Client-side "Apply" preview only, mirroring validateCoupon for orders —
// reproduces create-appointment-order's discount math against the real
// session price so the booking summary can show the real number before
// payment. Not authoritative: create-appointment-order revalidates
// everything (including applies_to and usage_limit) server-side at
// booking time regardless of what this returns.
export async function validateAppointmentCoupon(sb: Sb, code: string, sessionPrice: number): Promise<CouponPreview> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) throw new ApiError("validateAppointmentCoupon", { message: "Enter a coupon code" });

  const { data: coupon, error } = await sb.from("coupons").select("*").eq("code", normalized).maybeSingle();
  throwOnError("validateAppointmentCoupon", error);

  if (!coupon || !coupon.is_active || (coupon.expires_at && new Date(coupon.expires_at) < new Date())) {
    throw new ApiError("validateAppointmentCoupon", { message: "Invalid or expired coupon code" });
  }
  if (coupon.applies_to !== "appointments" && coupon.applies_to !== "both") {
    throw new ApiError("validateAppointmentCoupon", { message: "This coupon isn't valid for counselling sessions" });
  }
  if (coupon.usage_limit !== null && coupon.times_used >= coupon.usage_limit) {
    throw new ApiError("validateAppointmentCoupon", { message: "This coupon has reached its usage limit" });
  }
  if (sessionPrice < Number(coupon.min_order_amount)) {
    throw new ApiError("validateAppointmentCoupon", {
      message: `This coupon needs a minimum order of ₹${coupon.min_order_amount}`,
    });
  }

  let discountAmount =
    coupon.discount_type === "percent" ? sessionPrice * (Number(coupon.discount_value) / 100) : Number(coupon.discount_value);
  if (coupon.max_discount_amount !== null) discountAmount = Math.min(discountAmount, Number(coupon.max_discount_amount));
  discountAmount = Math.min(discountAmount, sessionPrice);

  return { code: coupon.code, discountAmount };
}

export async function getAppointment(sb: Sb, appointmentId: string): Promise<AppointmentWithExpert | null> {
  const { data, error } = await sb
    .from("appointments")
    .select("*, experts(name, photo_url)")
    .eq("id", appointmentId)
    .maybeSingle();
  throwOnError("getAppointment", error);
  return data as unknown as AppointmentWithExpert | null;
}

export async function getUserAppointments(sb: Sb, userId: string): Promise<AppointmentWithExpert[]> {
  const { data, error } = await sb
    .from("appointments")
    .select("*, experts(name, photo_url)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  throwOnError("getUserAppointments", error);
  return (data as unknown as AppointmentWithExpert[]) ?? [];
}

export type ResumeAppointmentPaymentResponse = {
  razorpay_order_id: string;
  amount: number;
  currency: string;
  key_id: string;
};

// Picks a stalled booking (payment pending or failed) back up — reuses the
// original Razorpay order where one exists, see
// resume-appointment-payment/index.ts. Signed-in customers only, same as
// the rest of /account.
export async function resumeAppointmentPayment(sb: Sb, appointmentId: string): Promise<ResumeAppointmentPaymentResponse> {
  const { data, error } = await sb.functions.invoke("resume-appointment-payment", {
    body: { appointment_id: appointmentId },
  });
  if (error) {
    const detail = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new ApiError("resumeAppointmentPayment", { message: detail?.error ?? error.message });
  }
  return data as ResumeAppointmentPaymentResponse;
}

// --- Expert dashboard ---------------------------------------------------

export async function getExpertByProfileId(sb: Sb, profileId: string): Promise<Expert | null> {
  const { data, error } = await sb.from("experts").select("*").eq("profile_id", profileId).maybeSingle();
  throwOnError("getExpertByProfileId", error);
  return data;
}

// appointments.user_id references auth.users, not public.profiles, so
// PostgREST has no foreign key to auto-embed profiles the way
// getAppointment/getUserAppointments embed experts — two queries, merged
// client-side, instead of one that would 400 on a relationship that
// doesn't exist in the schema.
export async function getExpertAppointments(sb: Sb, expertId: string): Promise<AppointmentWithCustomer[]> {
  const { data: appointments, error } = await sb
    .from("appointments")
    .select("*")
    .eq("expert_id", expertId)
    .order("created_at", { ascending: false });
  throwOnError("getExpertAppointments", error);

  const userIds = [...new Set((appointments ?? []).map((a) => a.user_id).filter((id): id is string => id !== null))];

  const profileById = new Map<string, { full_name: string | null; phone: string | null }>();
  if (userIds.length > 0) {
    const { data: profiles, error: profilesError } = await sb
      .from("profiles")
      .select("id, full_name, phone")
      .in("id", userIds);
    throwOnError("getExpertAppointments (profiles)", profilesError);
    for (const p of profiles ?? []) profileById.set(p.id, { full_name: p.full_name, phone: p.phone });
  }

  // A guest booking (no account) has no profiles row to join — its own
  // guest_name/guest_phone columns are the only place that info lives, so
  // they're used directly instead of leaving the expert with a blank
  // customer name.
  return (appointments ?? []).map((a) => ({
    ...a,
    profiles: a.user_id
      ? (profileById.get(a.user_id) ?? null)
      : a.guest_name
        ? { full_name: a.guest_name, phone: a.guest_phone }
        : null,
  })) as unknown as AppointmentWithCustomer[];
}

// RLS (appointments_update) only lets the assigned expert or an admin do
// this — the same guard that stops a customer from marking their own
// booking "completed". meetLink is required by the DB trigger
// (prevent_confirm_without_meet_link) whenever status is 'confirmed' —
// pass it in the same call so both land in one UPDATE the trigger can see
// together, rather than a separate follow-up write.
export async function updateAppointmentStatus(
  sb: Sb,
  appointmentId: string,
  status: Appointment["status"],
  meetLink?: string,
): Promise<void> {
  const { error } = await sb
    .from("appointments")
    .update({ status, ...(meetLink ? { meet_link: meetLink } : {}) })
    .eq("id", appointmentId);
  throwOnError("updateAppointmentStatus", error);
}

// Local day boundaries (not UTC) for a yyyy-mm-dd string — same reasoning
// as toLocalDateInputValue in BookAppointmentContent.tsx: the date input's
// value is a local calendar date, so "that day" has to be computed in the
// browser's local timezone, not sliced off a UTC ISO string.
function localDayBounds(dateStr: string): { start: string; end: string } {
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(`${dateStr}T23:59:59.999`);
  return { start: start.toISOString(), end: end.toISOString() };
}

function toHHMM(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export type BookedSlotInfo = { appointmentId: string; customerName: string | null; scheduledAt: string };

export type SlotAvailability = {
  // Already booked by a real (non-cancelled) appointment — keyed by "HH:MM".
  // Carries who booked it + the appointment id, so the availability
  // manager can show "booked by {name}" and offer a reschedule action —
  // not just a bare yes/no like the booking form needs.
  booked: Map<string, BookedSlotInfo>;
  // Manually blocked by the expert/admin — togglable via block/unblockSlot.
  blocked: Set<string>;
};

// Two sources of "can't be booked": slots another customer has already
// booked (any non-cancelled appointment for this expert that day, EXCLUDING
// ones whose payment definitively failed — a failed payment never actually
// secured the slot, so it shouldn't block anyone else from taking it) and
// slots the expert/admin manually blocked out (expert_blocked_slots).
// A 'pending' payment still blocks, deliberately — that's the brief window
// right after checkout starts, before the webhook lands; treating it as
// free would risk two customers landing on the same slot mid-checkout.
// Kept separate rather than pre-unioned — the availability-management UI
// needs to tell them apart (a booked slot can't be unblocked, a manually
// blocked one can), while the booking form just treats the union as
// unavailable.
export async function getSlotAvailability(sb: Sb, expertId: string, dateStr: string): Promise<SlotAvailability> {
  const { start, end } = localDayBounds(dateStr);

  const [appointmentsRes, blockedRes] = await Promise.all([
    sb
      .from("appointments")
      .select("id, user_id, guest_name, scheduled_at")
      .eq("expert_id", expertId)
      .neq("status", "cancelled")
      .neq("payment_status", "failed")
      .gte("scheduled_at", start)
      .lte("scheduled_at", end),
    sb.from("expert_blocked_slots").select("blocked_at").eq("expert_id", expertId).gte("blocked_at", start).lte("blocked_at", end),
  ]);
  throwOnError("getSlotAvailability (appointments)", appointmentsRes.error);
  throwOnError("getSlotAvailability (blocked)", blockedRes.error);

  const appointments = appointmentsRes.data ?? [];
  // appointments.user_id has no FK to public.profiles (only to
  // auth.users) — same two-query merge pattern as getExpertAppointments.
  const userIds = [...new Set(appointments.map((a) => a.user_id).filter((id): id is string => id !== null))];
  const nameById = new Map<string, string | null>();
  if (userIds.length > 0) {
    const { data: profiles, error: profilesError } = await sb.from("profiles").select("id, full_name").in("id", userIds);
    throwOnError("getSlotAvailability (profiles)", profilesError);
    for (const p of profiles ?? []) nameById.set(p.id, p.full_name);
  }

  const booked = new Map<string, BookedSlotInfo>();
  for (const a of appointments) {
    if (!a.scheduled_at) continue;
    booked.set(toHHMM(a.scheduled_at), {
      appointmentId: a.id,
      customerName: (a.user_id ? nameById.get(a.user_id) : a.guest_name) ?? null,
      scheduledAt: a.scheduled_at,
    });
  }
  const blocked = new Set<string>();
  for (const b of blockedRes.data ?? []) {
    blocked.add(toHHMM(b.blocked_at));
  }
  return { booked, blocked };
}

// Union of both sources — what the booking form treats as unavailable to
// select, without needing to distinguish why.
export async function getUnavailableSlots(sb: Sb, expertId: string, dateStr: string): Promise<Set<string>> {
  const { booked, blocked } = await getSlotAvailability(sb, expertId, dateStr);
  return new Set([...booked.keys(), ...blocked]);
}

// Reschedules one appointment — RLS (appointments_update) and the
// prevent_customer_appointment_tampering trigger both already allow the
// assigned expert (or admin) to change scheduled_at freely; no new DB work
// needed for this, just the call.
export async function updateAppointmentSchedule(sb: Sb, appointmentId: string, scheduledAt: string): Promise<void> {
  const { error } = await sb.from("appointments").update({ scheduled_at: scheduledAt }).eq("id", appointmentId);
  throwOnError("updateAppointmentSchedule", error);
}

// RLS (experts_self_write) lets the expert update their own row or an
// admin update any row; prevent_expert_self_edit_overreach restricts a
// self-edit to just these two columns.
export async function updateExpertWorkingHours(sb: Sb, expertId: string, startHour: number, endHour: number): Promise<void> {
  const { error } = await sb
    .from("experts")
    .update({ working_hours_start: startHour, working_hours_end: endHour })
    .eq("id", expertId);
  throwOnError("updateExpertWorkingHours", error);
}

// dateStr + slotValue ("HH:MM") -> the same local-time construction
// BookAppointmentContent.tsx uses for scheduled_at, so a blocked slot and
// a booked slot land on the exact same instant if they're "the same slot".
function slotToIso(dateStr: string, slotValue: string): string {
  return new Date(`${dateStr}T${slotValue}:00`).toISOString();
}

// RLS (expert_blocked_slots_write) only lets the assigned expert or an
// admin block/unblock their own slots.
export async function blockSlot(sb: Sb, expertId: string, dateStr: string, slotValue: string): Promise<void> {
  const { error } = await sb.from("expert_blocked_slots").insert({ expert_id: expertId, blocked_at: slotToIso(dateStr, slotValue) });
  throwOnError("blockSlot", error);
}

export async function unblockSlot(sb: Sb, expertId: string, dateStr: string, slotValue: string): Promise<void> {
  const { error } = await sb
    .from("expert_blocked_slots")
    .delete()
    .eq("expert_id", expertId)
    .eq("blocked_at", slotToIso(dateStr, slotValue));
  throwOnError("unblockSlot", error);
}

// Private per-session notes (appointment_notes table) — RLS scopes these to
// the assigned expert or admin only, deliberately excluding the customer
// even though they can read the appointment row itself. Bulk-fetched once
// per dashboard load and keyed by appointment_id so the UI can look one up
// per card without a query per card.
export async function getExpertAppointmentNotes(sb: Sb, expertId: string): Promise<Map<string, AppointmentNote>> {
  const { data, error } = await sb.from("appointment_notes").select("*").eq("expert_id", expertId);
  throwOnError("getExpertAppointmentNotes", error);
  return new Map((data ?? []).map((n) => [n.appointment_id, n]));
}

// Upsert on appointment_id (unique constraint) so the first save creates the
// row and every save after that just updates it in place.
export async function saveAppointmentNote(sb: Sb, appointmentId: string, expertId: string, notes: string): Promise<void> {
  const { error } = await sb
    .from("appointment_notes")
    .upsert({ appointment_id: appointmentId, expert_id: expertId, notes, updated_at: new Date().toISOString() }, { onConflict: "appointment_id" });
  throwOnError("saveAppointmentNote", error);
}

// RLS (experts_self_write) + prevent_expert_self_edit_overreach now also
// allow a self-edit of bio/long_bio/photo_url (see
// 20260724110000_expert_self_edit_bio_photo) — everything else on the row
// (name, specialties, is_bookable, etc.) stays admin-only and the trigger
// rejects those columns outright for a non-admin caller.
export async function updateExpertProfile(
  sb: Sb,
  expertId: string,
  input: { bio: string; longBio: string; photoUrl: string | null },
): Promise<void> {
  const { error } = await sb
    .from("experts")
    .update({ bio: input.bio, long_bio: input.longBio, photo_url: input.photoUrl })
    .eq("id", expertId);
  throwOnError("updateExpertProfile", error);
}

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ALLOWED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

// Expert-callable counterpart to uploadExpertPhotoAdmin (admin-api.ts) —
// same bucket/validation/random-filename logic, now reachable by an expert
// too via the expert_photos_expert_insert storage policy.
export async function uploadExpertPhoto(sb: Sb, file: File): Promise<string> {
  if (!ALLOWED_PHOTO_TYPES.includes(file.type)) {
    throw new ApiError("uploadExpertPhoto", { message: "Please upload a JPEG, PNG, or WebP image" });
  }
  if (file.size > MAX_PHOTO_BYTES) {
    throw new ApiError("uploadExpertPhoto", { message: "Image must be under 5MB" });
  }

  const ext = file.name.split(".").pop() ?? "jpg";
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error: uploadError } = await sb.storage.from("expert-photos").upload(path, file, { upsert: false });
  throwOnError("uploadExpertPhoto", uploadError);

  const { data } = sb.storage.from("expert-photos").getPublicUrl(path);
  return data.publicUrl;
}

export type IntakeFormInput = {
  age: string;
  pronouns: string;
  occupation: string;
  description: string;
  concern: string;
  answers: { question: string; answer: string }[];
};

// Customer-only write path — RLS (appointments_customer_intake_update)
// only lets someone touch their own appointment, and the
// prevent_customer_appointment_tampering trigger rejects the update
// outright if anything besides these intake_* columns changes in the
// same call, so there's no way this accidentally also moves status/
// payment/meet_link fields even if a caller tried to pass more.
export async function submitAppointmentIntake(sb: Sb, appointmentId: string, input: IntakeFormInput): Promise<void> {
  const { error } = await sb
    .from("appointments")
    .update({
      intake_age: input.age,
      intake_pronouns: input.pronouns,
      intake_occupation: input.occupation,
      intake_description: input.description,
      intake_concern: input.concern,
      intake_answers: input.answers,
      intake_completed_at: new Date().toISOString(),
    })
    .eq("id", appointmentId);
  throwOnError("submitAppointmentIntake", error);
}

// --- Self-assessment ---------------------------------------------------------

// Scoring happens client-side (spec 4.10 allows either) — this just
// persists the answers + result. Works signed-in or guest, mirroring the
// cart's guest_session_id pattern; RLS treats user_id IS NULL rows as
// world-writable/readable, the same accepted tradeoff carts already use.
export async function submitAssessment(
  sb: Sb,
  input: { userId?: string; guestSessionId?: string; answers: Json; recommendedCategory: string },
): Promise<void> {
  const { error } = await sb.from("assessments").insert({
    user_id: input.userId,
    guest_session_id: input.guestSessionId,
    answers: input.answers,
    recommended_category: input.recommendedCategory,
  });
  throwOnError("submitAssessment", error);
}

// --- Coupons --------------------------------------------------------------

export type CouponPreview = { code: string; discountAmount: number };

// Client-side "Apply" preview only — reads the same public, RLS-gated
// coupons row (coupons_select already restricts this to is_active +
// unexpired) and reproduces create-order's discount math so the checkout
// summary can show the real number before payment. This is NOT the
// authoritative check: create-order revalidates everything (including
// usage_limit, which this preview can't safely enforce client-side
// without a race) server-side at pay time regardless of what this
// returns, so there's nothing to trust here beyond UX.
// `discountableSubtotal` is the part a coupon may actually discount —
// everything except the fixed-price Feelz Bundle (see lib/pricing.ts and
// create-order, which computes it the same way). The minimum-order check
// still uses the full subtotal.
export async function validateCoupon(
  sb: Sb,
  code: string,
  subtotal: number,
  discountableSubtotal: number = subtotal,
): Promise<CouponPreview> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) throw new ApiError("validateCoupon", { message: "Enter a coupon code" });

  const { data: coupon, error } = await sb.from("coupons").select("*").eq("code", normalized).maybeSingle();
  throwOnError("validateCoupon", error);

  if (!coupon || !coupon.is_active || (coupon.expires_at && new Date(coupon.expires_at) < new Date())) {
    throw new ApiError("validateCoupon", { message: "Invalid or expired coupon code" });
  }
  if (coupon.usage_limit !== null && coupon.times_used >= coupon.usage_limit) {
    throw new ApiError("validateCoupon", { message: "This coupon has reached its usage limit" });
  }
  if (subtotal < Number(coupon.min_order_amount)) {
    throw new ApiError("validateCoupon", {
      message: `This coupon needs a minimum order of ₹${coupon.min_order_amount}`,
    });
  }

  let discountAmount =
    coupon.discount_type === "percent"
      ? discountableSubtotal * (Number(coupon.discount_value) / 100)
      : Number(coupon.discount_value);
  if (coupon.max_discount_amount !== null) discountAmount = Math.min(discountAmount, Number(coupon.max_discount_amount));
  discountAmount = Math.min(discountAmount, discountableSubtotal);

  return { code: coupon.code, discountAmount };
}

// --- Orders -------------------------------------------------------------

export async function getOrder(sb: Sb, orderId: string): Promise<OrderWithItems | null> {
  const { data, error } = await sb
    .from("orders")
    .select("*, order_items(*), pickup_locations:location_id(name)")
    .eq("id", orderId)
    .maybeSingle();
  throwOnError("getOrder", error);
  return data as unknown as OrderWithItems | null;
}

export type OrderStatusEvent = { status: string; created_at: string };

// Timestamped status history (order_status_events, written by a trigger on
// orders). Same visibility as the order itself.
export async function getOrderStatusEvents(sb: Sb, orderId: string): Promise<OrderStatusEvent[]> {
  const { data, error } = await sb
    .from("order_status_events")
    .select("status, created_at")
    .eq("order_id", orderId)
    .order("created_at");
  throwOnError("getOrderStatusEvents", error);
  return data ?? [];
}

export type TrackedOrder = {
  order_number: string;
  status: string;
  payment_status: string;
  fulfillment_type: "delivery" | "takeaway";
  created_at: string;
  estimated_delivery: string | null;
  awb_code: string | null;
  tracking_url: string | null;
  total: number;
  pickup_location: string | null;
  items: { name: string; quantity: number }[];
  events: OrderStatusEvent[];
};

// Public /track-order lookup — needs both the order number and the phone
// used on the order; returns null for any mismatch (see track_order()).
export async function trackOrder(sb: Sb, orderNumber: string, phone: string): Promise<TrackedOrder | null> {
  const { data, error } = await sb.rpc("track_order", { p_order_number: orderNumber, p_phone: phone });
  throwOnError("trackOrder", error);
  return (data as unknown as TrackedOrder | null) ?? null;
}

// "Your orders" — order_items joined with the variant/product so the list
// can show what was actually bought, not just totals.
export async function getUserOrders(sb: Sb, userId: string): Promise<OrderWithItemDetails[]> {
  const { data, error } = await sb
    .from("orders")
    .select("*, order_items(*, product_variants(variant_label, products(name)))")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  throwOnError("getUserOrders", error);
  return (data as unknown as OrderWithItemDetails[]) ?? [];
}

// --- Checkout (server-side price/coupon validation + Razorpay order) ---

export type CheckoutFulfillment =
  | { type: "delivery"; addressId?: string; address?: {
      full_name: string; phone: string; line1: string; line2?: string;
      city: string; state: string; pincode: string; landmark?: string;
    } }
  | { type: "takeaway"; locationId: string; pickupSlot?: string };

export type CheckoutInput = {
  cartId: string;
  items: { variantId: string; quantity: number }[];
  fulfillment: CheckoutFulfillment;
  couponCode?: string;
  attribution?: Partial<Record<"utm_source" | "utm_medium" | "utm_campaign" | "utm_content" | "fbclid", string>>;
  guest?: { name: string; phone: string; email?: string };
  notes?: string;
};

// A coupon can fully cover the order (total lands at exactly 0) — Razorpay's
// Orders API rejects a 0-amount order outright, so create-order skips
// Razorpay entirely for that case and confirms the order immediately
// instead (see the Edge Function). `free: true` is the caller's signal to
// skip openRazorpayCheckout and treat the order as placed right away.
export type CheckoutResponse =
  | {
      order_id: string;
      free: true;
      subtotal: number;
      discount_amount: number;
      delivery_fee: number;
      total: number;
    }
  | {
      order_id: string;
      free?: false;
      razorpay_order_id: string;
      amount: number;
      currency: string;
      key_id: string;
      subtotal: number;
      discount_amount: number;
      delivery_fee: number;
      total: number;
    };

// Invokes the create-order Edge Function: it looks up real prices,
// validates the coupon, reserves stock, creates the order, and creates the
// matching Razorpay order — all server-side, so nothing here can be
// tampered with client-side. Works for both signed-in and guest checkout.
export async function checkout(sb: Sb, input: CheckoutInput): Promise<CheckoutResponse> {
  const { data, error } = await sb.functions.invoke("create-order", {
    body: {
      cart_id: input.cartId,
      items: input.items.map((i) => ({ variant_id: i.variantId, quantity: i.quantity })),
      fulfillment:
        input.fulfillment.type === "delivery"
          ? { type: "delivery", address_id: input.fulfillment.addressId, address: input.fulfillment.address }
          : { type: "takeaway", location_id: input.fulfillment.locationId, pickup_slot: input.fulfillment.pickupSlot },
      coupon_code: input.couponCode || undefined,
      attribution: input.attribution,
      guest: input.guest,
      notes: input.notes || undefined,
    },
  });
  if (error) {
    // supabase-js surfaces a non-2xx Edge Function response as a generic
    // FunctionsHttpError — the actual { error: "..." } message create-order
    // sent is on the response body, not `error.message`.
    const detail = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new ApiError("checkout", { message: detail?.error ?? error.message });
  }
  return data as CheckoutResponse;
}

// --- Business leads (corporate/EAP contact form) ----------------------------

// Routed through the submit-business-lead Edge Function rather than a
// direct table insert — business_leads has no anon insert policy at all
// anymore (see migration 20260814020000_lockdown_public_insert_forms.sql),
// since the open policy was being actively spammed by a bot hitting the
// REST API directly. The function checks a honeypot field + an IP rate
// limit before writing. `honeypot` must stay empty; BusinessLeadForm.tsx
// wires it to a field real users never see.
export async function submitBusinessLead(
  sb: Sb,
  input: { companyName: string; contactName: string; email: string; phone?: string; message?: string; honeypot?: string },
): Promise<void> {
  const { data, error } = await sb.functions.invoke("submit-business-lead", {
    body: {
      company_name: input.companyName,
      contact_name: input.contactName,
      email: input.email,
      phone: input.phone,
      message: input.message,
      website: input.honeypot,
    },
  });
  if (error) {
    const detail = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new ApiError("submitBusinessLead", { message: detail?.error ?? error.message });
  }
  if (data?.error) throw new ApiError("submitBusinessLead", { message: data.error });
}

// Public /feedback page — goes through the submit-feedback Edge Function
// (honeypot + IP rate limit), never a direct table insert.
export async function submitFeedback(
  sb: Sb,
  input: {
    name: string;
    email?: string;
    phone?: string;
    topic: string;
    product?: string;
    rating: number;
    message: string;
    canPublish: boolean;
    source?: string;
    honeypot?: string;
  },
): Promise<void> {
  const { data, error } = await sb.functions.invoke("submit-feedback", {
    body: {
      name: input.name,
      email: input.email,
      phone: input.phone,
      topic: input.topic,
      product: input.product,
      rating: input.rating,
      message: input.message,
      can_publish: input.canPublish,
      source: input.source,
      website: input.honeypot,
    },
  });
  if (error) {
    const detail = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new ApiError("submitFeedback", { message: detail?.error ?? error.message });
  }
  if (data?.error) throw new ApiError("submitFeedback", { message: data.error });
}

// --- FAQs, milestones (CMS content) ------------------------------------------

export async function getFaqs(sb: Sb, category?: string): Promise<Faq[]> {
  let query = sb.from("faqs").select("*");
  if (category) query = query.eq("category", category);
  const { data, error } = await query.order("category").order("sort_order");
  throwOnError("getFaqs", error);
  return data ?? [];
}

export async function getMilestones(sb: Sb): Promise<Milestone[]> {
  const { data, error } = await sb.from("milestones").select("*").order("sort_order");
  throwOnError("getMilestones", error);
  return data ?? [];
}
