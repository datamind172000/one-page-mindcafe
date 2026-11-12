// Admin-only data access — every function here assumes the caller's RLS
// identity is is_admin() (or is_super_admin() for the role-management
// ones). Nothing here does its own authorization check client-side
// beyond that; the database is what actually enforces it (see
// AUTH_AND_ROLES.md). Kept separate from lib/api.ts, which is the public-
// facing surface every signed-out visitor's browser also loads.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/supabase";
import { ApiError } from "@/lib/api";
import type {
  Appointment,
  AppointmentWithDetails,
  AppointmentWithExpert,
  BusinessLead,
  ContactMessage,
  Coupon,
  Expert,
  ExpertApplication,
  Faq,
  Feedback,
  FeelzPreorder,
  InventoryTransaction,
  InventoryWithVariant,
  InventoryWithVariantAndLocation,
  Milestone,
  MisplacedStockLog,
  NewsletterSubscriber,
  OrderWithItemDetailsAndLocation,
  PickupLocation,
  ProductVariant,
  ProductWithVariants,
  Review,
  SiteSetting,
  TherapyCategory,
} from "@/types/domain";

type Sb = SupabaseClient<Database>;

function throwOnError(context: string, error: unknown): void {
  if (error) throw new ApiError(context, error);
}

// --- Sales / analytics ---------------------------------------------------

export type DashboardRange = "1d" | "7d" | "30d" | "all";

// Two different kinds of number here, deliberately kept apart instead of
// both being "affected by the date picker": pendingAppointments and
// newBusinessLeadsQueue are the *current* operational queue (appointments
// nobody's confirmed yet, leads nobody's followed up on) — showing "leads
// in the last 24h" there would hide a lead that came in 3 days ago and is
// still sitting unactioned. Everything under `range` is genuinely
// historical and does move with the picker.
export type SalesSummary = {
  pendingAppointments: number;
  newBusinessLeadsQueue: number;
  feelzPreordersTotal: number;
  range: {
    option: DashboardRange;
    // Combined across both revenue streams — Feelz product orders AND
    // paid counselling sessions. Kept split out below too
    // (productRevenue/appointmentRevenue) since they're different
    // businesses under one roof and collapsing them into one number
    // alone would hide which one is actually driving growth.
    totalRevenue: number;
    productRevenue: number;
    appointmentRevenue: number;
    paidOrderCount: number;
    paidAppointmentCount: number;
    newAppointments: number;
    newBusinessLeads: number;
    newNewsletterSubscribers: number;
    newFeelzPreorders: number;
    // Split per-day so a segment toggle (feelz-only / counselling-only) can
    // chart just its own stream instead of only ever showing the combined
    // total.
    dailyRevenue: { date: string; revenue: number; productRevenue: number; appointmentRevenue: number }[];
    ordersByStatus: Record<string, number>;
    appointmentsByStatus: Record<string, number>;
    orders: { order_number: string; created_at: string; status: string; payment_status: string; fulfillment_type: string; total: number }[];
  };
};

function rangeStartDate(range: DashboardRange): Date | null {
  if (range === "all") return null;
  const days = range === "1d" ? 1 : range === "7d" ? 7 : 30;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

export async function getSalesSummary(sb: Sb, range: DashboardRange = "30d"): Promise<SalesSummary> {
  const rangeStart = rangeStartDate(range);
  const rangeStartIso = rangeStart?.toISOString();

  let ordersQuery = sb.from("orders").select("order_number, total, status, payment_status, fulfillment_type, created_at");
  if (rangeStartIso) ordersQuery = ordersQuery.gte("created_at", rangeStartIso);

  let appointmentsRangeQuery = sb.from("appointments").select("status", { count: "exact" });
  if (rangeStartIso) appointmentsRangeQuery = appointmentsRangeQuery.gte("created_at", rangeStartIso);

  // Paid appointments in-range — the counselling side of revenue, folded
  // into totalRevenue/dailyRevenue below alongside paid orders. Previously
  // this dashboard only ever counted product sales, silently excluding an
  // entire revenue stream.
  let paidAppointmentsQuery = sb.from("appointments").select("total, created_at").eq("payment_status", "paid");
  if (rangeStartIso) paidAppointmentsQuery = paidAppointmentsQuery.gte("created_at", rangeStartIso);

  let leadsRangeQuery = sb.from("business_leads").select("id", { count: "exact", head: true });
  if (rangeStartIso) leadsRangeQuery = leadsRangeQuery.gte("created_at", rangeStartIso);

  let subscribersRangeQuery = sb.from("newsletter_subscribers").select("id", { count: "exact", head: true });
  if (rangeStartIso) subscribersRangeQuery = subscribersRangeQuery.gte("subscribed_at", rangeStartIso);

  let preordersRangeQuery = sb.from("feelz_preorders").select("id", { count: "exact", head: true });
  if (rangeStartIso) preordersRangeQuery = preordersRangeQuery.gte("created_at", rangeStartIso);

  const [
    ordersRes,
    pendingAppointmentsRes,
    newLeadsQueueRes,
    appointmentsRangeRes,
    paidAppointmentsRes,
    leadsRangeRes,
    subscribersRangeRes,
    preordersTotalRes,
    preordersRangeRes,
  ] = await Promise.all([
    ordersQuery,
    sb.from("appointments").select("id", { count: "exact", head: true }).eq("status", "pending"),
    sb.from("business_leads").select("id", { count: "exact", head: true }).eq("status", "new"),
    appointmentsRangeQuery,
    paidAppointmentsQuery,
    leadsRangeQuery,
    subscribersRangeQuery,
    sb.from("feelz_preorders").select("id", { count: "exact", head: true }),
    preordersRangeQuery,
  ]);
  throwOnError("getSalesSummary.orders", ordersRes.error);
  throwOnError("getSalesSummary.pendingAppointments", pendingAppointmentsRes.error);
  throwOnError("getSalesSummary.newLeadsQueue", newLeadsQueueRes.error);
  throwOnError("getSalesSummary.appointmentsRange", appointmentsRangeRes.error);
  throwOnError("getSalesSummary.paidAppointments", paidAppointmentsRes.error);
  throwOnError("getSalesSummary.leadsRange", leadsRangeRes.error);
  throwOnError("getSalesSummary.subscribersRange", subscribersRangeRes.error);
  throwOnError("getSalesSummary.preordersTotal", preordersTotalRes.error);
  throwOnError("getSalesSummary.preordersRange", preordersRangeRes.error);

  const orders = ordersRes.data ?? [];
  const paidOrders = orders.filter((o) => o.payment_status === "paid");
  const productRevenue = paidOrders.reduce((sum, o) => sum + Number(o.total), 0);

  const paidAppointments = (paidAppointmentsRes.data ?? []).filter((a) => a.total !== null);
  const appointmentRevenue = paidAppointments.reduce((sum, a) => sum + Number(a.total), 0);

  const totalRevenue = productRevenue + appointmentRevenue;

  const ordersByStatus: Record<string, number> = {};
  for (const o of orders) ordersByStatus[o.status] = (ordersByStatus[o.status] ?? 0) + 1;

  const appointmentsByStatus: Record<string, number> = {};
  for (const a of appointmentsRangeRes.data ?? []) {
    appointmentsByStatus[a.status] = (appointmentsByStatus[a.status] ?? 0) + 1;
  }

  const byDay = new Map<string, { productRevenue: number; appointmentRevenue: number }>();
  for (const o of paidOrders) {
    const day = new Date(o.created_at).toISOString().slice(0, 10);
    const entry = byDay.get(day) ?? { productRevenue: 0, appointmentRevenue: 0 };
    entry.productRevenue += Number(o.total);
    byDay.set(day, entry);
  }
  for (const a of paidAppointments) {
    const day = new Date(a.created_at).toISOString().slice(0, 10);
    const entry = byDay.get(day) ?? { productRevenue: 0, appointmentRevenue: 0 };
    entry.appointmentRevenue += Number(a.total);
    byDay.set(day, entry);
  }
  const dailyRevenue = Array.from(byDay.entries())
    .map(([date, { productRevenue, appointmentRevenue }]) => ({
      date,
      revenue: productRevenue + appointmentRevenue,
      productRevenue,
      appointmentRevenue,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    pendingAppointments: pendingAppointmentsRes.count ?? 0,
    newBusinessLeadsQueue: newLeadsQueueRes.count ?? 0,
    feelzPreordersTotal: preordersTotalRes.count ?? 0,
    range: {
      option: range,
      totalRevenue,
      productRevenue,
      appointmentRevenue,
      paidOrderCount: paidOrders.length,
      paidAppointmentCount: paidAppointments.length,
      ordersByStatus,
      appointmentsByStatus,
      newAppointments: appointmentsRangeRes.count ?? 0,
      newBusinessLeads: leadsRangeRes.count ?? 0,
      newNewsletterSubscribers: subscribersRangeRes.count ?? 0,
      newFeelzPreorders: preordersRangeRes.count ?? 0,
      dailyRevenue,
      orders: orders
        .map((o) => ({ ...o, total: Number(o.total) }))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    },
  };
}

// --- Orders ---------------------------------------------------------------

// PostgREST's .or() filter syntax uses "," and "()" as separators — a raw
// search term containing them would break the filter string rather than
// just fail to match, so they're stripped (not escaped; admin search
// input, not something that needs to preserve exact punctuation).
function sanitizeSearchTerm(term: string): string {
  return term.trim().replace(/[,()]/g, "");
}

export async function getOrdersAdmin(
  sb: Sb,
  options: {
    page: number;
    pageSize: number;
    status?: string;
    locationId?: string;
    search?: string;
    paymentStatus?: string;
    fulfillmentType?: string;
    dateFrom?: string;
    dateTo?: string;
  },
): Promise<{ orders: OrderWithItemDetailsAndLocation[]; total: number }> {
  const from = options.page * options.pageSize;
  const to = from + options.pageSize - 1;
  let query = sb
    .from("orders")
    .select(
      "*, order_items(*, product_variants(variant_label, products(name))), pickup_locations(name, city), addresses:address_id(city, pincode, phone, line1, line2, landmark, state)",
      { count: "exact" },
    );
  if (options.status) {
    query = query.eq("status", options.status as Database["public"]["Tables"]["orders"]["Row"]["status"]);
  }
  if (options.locationId === "online") {
    // Synthetic filter value (not a real pickup_locations id) — delivery
    // orders have no location_id, so "online" means "show delivery orders"
    // rather than any specific Zostel pickup point.
    query = query.eq("fulfillment_type", "delivery");
  } else if (options.locationId) {
    query = query.eq("location_id", options.locationId);
  }
  if (options.paymentStatus) {
    query = query.eq("payment_status", options.paymentStatus as Database["public"]["Tables"]["orders"]["Row"]["payment_status"]);
  }
  if (options.fulfillmentType) {
    query = query.eq(
      "fulfillment_type",
      options.fulfillmentType as Database["public"]["Tables"]["orders"]["Row"]["fulfillment_type"],
    );
  }
  if (options.dateFrom) query = query.gte("created_at", options.dateFrom);
  if (options.dateTo) {
    // dateTo is a plain yyyy-mm-dd from a <input type="date">, so this
    // needs to include the entire day rather than filtering at midnight.
    const end = new Date(options.dateTo);
    end.setDate(end.getDate() + 1);
    query = query.lt("created_at", end.toISOString().slice(0, 10));
  }
  const term = options.search ? sanitizeSearchTerm(options.search) : "";
  if (term) {
    query = query.or(`order_number.ilike.%${term}%,guest_name.ilike.%${term}%,guest_phone.ilike.%${term}%`);
  }
  const { data, error, count } = await query.order("created_at", { ascending: false }).range(from, to);
  throwOnError("getOrdersAdmin", error);

  // orders.user_id has no FK to public.profiles (only to auth.users), so
  // the customer name/phone can't come along in the same nested select
  // above — same two-query merge pattern as getAppointmentsAdmin.
  const orders = (data as unknown as OrderWithItemDetailsAndLocation[]) ?? [];
  const userIds = [...new Set(orders.map((o) => o.user_id).filter((id): id is string => id !== null))];
  const profileById = new Map<string, { full_name: string | null; phone: string | null }>();
  if (userIds.length > 0) {
    const { data: profiles, error: profilesError } = await sb.from("profiles").select("id, full_name, phone").in("id", userIds);
    throwOnError("getOrdersAdmin (profiles)", profilesError);
    for (const p of profiles ?? []) profileById.set(p.id, { full_name: p.full_name, phone: p.phone });
  }

  // How many real orders each customer on this page has placed in total,
  // across all pages — "real" meaning past checkout ('placed' is an
  // unpaid/abandoned attempt) and not cancelled. Accounts are matched by
  // user_id, guests by the last 10 digits of their phone, since the same
  // number gets typed in different formats.
  const last10 = (phone: string | null | undefined) => (phone ?? "").replace(/\D/g, "").slice(-10);
  const countByUser = new Map<string, number>();
  const countByPhone = new Map<string, number>();
  if (userIds.length > 0) {
    const { data: rows, error: countError } = await sb
      .from("orders")
      .select("user_id")
      .in("user_id", userIds)
      .not("status", "in", "(placed,cancelled)");
    throwOnError("getOrdersAdmin (customer order counts)", countError);
    for (const r of rows ?? []) if (r.user_id) countByUser.set(r.user_id, (countByUser.get(r.user_id) ?? 0) + 1);
  }
  const guestPhones = [...new Set(orders.filter((o) => !o.user_id).map((o) => last10(o.guest_phone)).filter((p) => p.length === 10))];
  if (guestPhones.length > 0) {
    const formats = guestPhones.flatMap((p) => [p, `91${p}`, `+91${p}`, `+91 ${p}`, `0${p}`, `${p.slice(0, 5)} ${p.slice(5)}`]);
    const { data: rows, error: countError } = await sb
      .from("orders")
      .select("guest_phone")
      .is("user_id", null)
      .in("guest_phone", formats)
      .not("status", "in", "(placed,cancelled)");
    throwOnError("getOrdersAdmin (guest order counts)", countError);
    for (const r of rows ?? []) {
      const p = last10(r.guest_phone);
      countByPhone.set(p, (countByPhone.get(p) ?? 0) + 1);
    }
  }

  return {
    orders: orders.map((o) => ({
      ...o,
      profiles: o.user_id ? (profileById.get(o.user_id) ?? null) : null,
      customer_order_count: o.user_id ? (countByUser.get(o.user_id) ?? 0) : (countByPhone.get(last10(o.guest_phone)) ?? 0),
    })),
    total: count ?? 0,
  };
}

// "cancelled" is routed through admin_cancel_order (see
// 20260825000000_admin_order_editing.sql) instead of a plain column
// update — it restocks the order's items back to inventory, but only for
// an order whose stock was actually decremented already (anything past
// 'placed'), and only once (idempotent on an already-cancelled order).
export async function updateOrderStatusAdmin(
  sb: Sb,
  orderId: string,
  status: Database["public"]["Tables"]["orders"]["Row"]["status"],
): Promise<void> {
  if (status === "cancelled") {
    const { error } = await sb.rpc("admin_cancel_order", { p_order_id: orderId });
    throwOnError("updateOrderStatusAdmin (cancel)", error);
    return;
  }
  const { error } = await sb.from("orders").update({ status }).eq("id", orderId);
  throwOnError("updateOrderStatusAdmin", error);
}

// Plain-column edits an admin can make on an order after the fact —
// covered by the existing orders_admin_update RLS policy, so a normal
// .update() is enough (no inventory/total side effects like the item
// quantity RPC below). guest_address_* only exists on guest-checkout
// orders; a signed-in order's address lives on the separate `addresses`
// row via address_id and isn't editable from here.
export type OrderDetailsEdit = Partial<{
  location_id: string | null;
  pickup_slot: string | null;
  payment_status: Database["public"]["Tables"]["orders"]["Row"]["payment_status"];
  notes: string | null;
  guest_address_line1: string | null;
  guest_address_line2: string | null;
  guest_address_city: string | null;
  guest_address_state: string | null;
  guest_address_pincode: string | null;
}>;

export async function updateOrderDetailsAdmin(sb: Sb, orderId: string, edit: OrderDetailsEdit): Promise<void> {
  const { error } = await sb.from("orders").update(edit).eq("id", orderId);
  throwOnError("updateOrderDetailsAdmin", error);
}

// order_items has no RLS update/delete policy at all (see setup.sql) —
// line items are an immutable purchase record except through this RPC,
// which also reconciles inventory and recomputes orders.subtotal/total
// atomically server-side. newQuantity: 0 removes the line entirely.
export async function updateOrderItemQuantityAdmin(sb: Sb, orderId: string, itemId: string, newQuantity: number): Promise<void> {
  const { error } = await sb.rpc("admin_set_order_item_quantity", {
    p_order_id: orderId,
    p_item_id: itemId,
    p_new_quantity: newQuantity,
  });
  throwOnError("updateOrderItemQuantityAdmin", error);
}

// RLS (orders_super_admin_delete) restricts this to super_admin — a plain
// admin passes is_admin() everywhere else in this file but not here,
// deleting a real order is destructive/hard to reverse. order_items
// cascades automatically (on delete cascade, see setup.sql).
export async function deleteOrderAdmin(sb: Sb, orderId: string): Promise<void> {
  const { error } = await sb.from("orders").delete().eq("id", orderId);
  throwOnError("deleteOrderAdmin", error);
}

// --- Appointments -----------------------------------------------------------

export async function getAppointmentsAdmin(
  sb: Sb,
  options: { page: number; pageSize: number; status?: string; search?: string },
): Promise<{ appointments: AppointmentWithDetails[]; total: number }> {
  const from = options.page * options.pageSize;
  const to = from + options.pageSize - 1;
  let query = sb.from("appointments").select("*, experts(name, photo_url)", { count: "exact" });
  if (options.status) {
    query = query.eq("status", options.status as Database["public"]["Tables"]["appointments"]["Row"]["status"]);
  }
  // Only base-table columns are searchable via .or() — the joined expert's
  // name can't be combined into the same OR filter, so this covers notes/
  // category, not "search by customer or expert name".
  const term = options.search ? sanitizeSearchTerm(options.search) : "";
  if (term) {
    query = query.or(`notes.ilike.%${term}%,therapy_category.ilike.%${term}%`);
  }
  const { data, error, count } = await query.order("created_at", { ascending: false }).range(from, to);
  throwOnError("getAppointmentsAdmin", error);

  // appointments.user_id has no FK to public.profiles (only to
  // auth.users), so the customer name/phone can't come along in the same
  // nested select above — same two-query merge pattern as
  // getExpertAppointments in lib/api.ts.
  const appointments = (data as unknown as AppointmentWithExpert[]) ?? [];
  const userIds = [...new Set(appointments.map((a) => a.user_id).filter((id): id is string => id !== null))];
  const profileById = new Map<string, { full_name: string | null; phone: string | null }>();
  if (userIds.length > 0) {
    const { data: profiles, error: profilesError } = await sb.from("profiles").select("id, full_name, phone").in("id", userIds);
    throwOnError("getAppointmentsAdmin (profiles)", profilesError);
    for (const p of profiles ?? []) profileById.set(p.id, { full_name: p.full_name, phone: p.phone });
  }

  return {
    appointments: appointments.map((a) => ({
      ...a,
      profiles: a.user_id
        ? (profileById.get(a.user_id) ?? null)
        : a.guest_name
          ? { full_name: a.guest_name, phone: a.guest_phone }
          : null,
    })) as AppointmentWithDetails[],
    total: count ?? 0,
  };
}

export async function updateAppointmentAdmin(
  sb: Sb,
  appointmentId: string,
  input: Database["public"]["Tables"]["appointments"]["Update"],
): Promise<void> {
  const { error } = await sb.from("appointments").update(input).eq("id", appointmentId);
  throwOnError("updateAppointmentAdmin", error);
}

// RLS (appointments_super_admin_delete) restricts this to super_admin,
// same reasoning as deleteOrderAdmin.
export async function deleteAppointmentAdmin(sb: Sb, appointmentId: string): Promise<void> {
  const { error } = await sb.from("appointments").delete().eq("id", appointmentId);
  throwOnError("deleteAppointmentAdmin", error);
}

// --- Products & variants ----------------------------------------------------

export async function getProductsAdmin(sb: Sb): Promise<ProductWithVariants[]> {
  const { data, error } = await sb.from("products").select("*, product_variants(*)").order("name");
  throwOnError("getProductsAdmin", error);
  return (data as ProductWithVariants[]) ?? [];
}

export async function createProductAdmin(
  sb: Sb,
  input: Database["public"]["Tables"]["products"]["Insert"],
) {
  const { data, error } = await sb.from("products").insert(input).select("*").single();
  throwOnError("createProductAdmin", error);
  return data!;
}

export async function updateProductAdmin(
  sb: Sb,
  id: string,
  input: Database["public"]["Tables"]["products"]["Update"],
) {
  const { error } = await sb.from("products").update(input).eq("id", id);
  throwOnError("updateProductAdmin", error);
}

export async function deleteProductAdmin(sb: Sb, id: string): Promise<void> {
  const { error } = await sb.from("products").delete().eq("id", id);
  throwOnError("deleteProductAdmin", error);
}

export async function createVariantAdmin(
  sb: Sb,
  input: Database["public"]["Tables"]["product_variants"]["Insert"],
): Promise<ProductVariant> {
  const { data, error } = await sb.from("product_variants").insert(input).select("*").single();
  throwOnError("createVariantAdmin", error);
  return data!;
}

export async function updateVariantAdmin(
  sb: Sb,
  id: string,
  input: Database["public"]["Tables"]["product_variants"]["Update"],
): Promise<void> {
  const { error } = await sb.from("product_variants").update(input).eq("id", id);
  throwOnError("updateVariantAdmin", error);
}

export async function deleteVariantAdmin(sb: Sb, id: string): Promise<void> {
  const { error } = await sb.from("product_variants").delete().eq("id", id);
  throwOnError("deleteVariantAdmin", error);
}

// --- Coupons ----------------------------------------------------------------

export async function getCouponsAdmin(sb: Sb): Promise<Coupon[]> {
  const { data, error } = await sb.from("coupons").select("*").order("created_at", { ascending: false });
  throwOnError("getCouponsAdmin", error);
  return data ?? [];
}

export async function createCouponAdmin(sb: Sb, input: Database["public"]["Tables"]["coupons"]["Insert"]) {
  const { data, error } = await sb.from("coupons").insert(input).select("*").single();
  throwOnError("createCouponAdmin", error);
  return data!;
}

export async function updateCouponAdmin(
  sb: Sb,
  id: string,
  input: Database["public"]["Tables"]["coupons"]["Update"],
): Promise<void> {
  const { error } = await sb.from("coupons").update(input).eq("id", id);
  throwOnError("updateCouponAdmin", error);
}

export async function deleteCouponAdmin(sb: Sb, id: string): Promise<void> {
  const { error } = await sb.from("coupons").delete().eq("id", id);
  throwOnError("deleteCouponAdmin", error);
}

// --- Pickup locations ---------------------------------------------------

export async function getPickupLocationsAdmin(sb: Sb): Promise<PickupLocation[]> {
  const { data, error } = await sb.from("pickup_locations").select("*").order("name");
  throwOnError("getPickupLocationsAdmin", error);
  return data ?? [];
}

export async function createPickupLocationAdmin(
  sb: Sb,
  input: Database["public"]["Tables"]["pickup_locations"]["Insert"],
) {
  const { data, error } = await sb.from("pickup_locations").insert(input).select("*").single();
  throwOnError("createPickupLocationAdmin", error);
  return data!;
}

export async function updatePickupLocationAdmin(
  sb: Sb,
  id: string,
  input: Database["public"]["Tables"]["pickup_locations"]["Update"],
): Promise<void> {
  const { error } = await sb.from("pickup_locations").update(input).eq("id", id);
  throwOnError("updatePickupLocationAdmin", error);
}

export async function deletePickupLocationAdmin(sb: Sb, id: string): Promise<void> {
  const { error } = await sb.from("pickup_locations").delete().eq("id", id);
  throwOnError("deletePickupLocationAdmin", error);
}

// --- Pickup location commission adjustments ------------------------------
// A manual +/- ₹ correction, bonus, or deduction on top of the calculated
// percent × revenue commission /staff already shows — see
// 20260901000000_pickup_location_commission_adjustments.sql. Kept as a
// running ledger, not a single overridable field.

export type CommissionAdjustment = Database["public"]["Tables"]["pickup_location_commission_adjustments"]["Row"];

export async function getCommissionAdjustmentsAdmin(sb: Sb, locationId?: string): Promise<CommissionAdjustment[]> {
  let query = sb.from("pickup_location_commission_adjustments").select("*");
  if (locationId) query = query.eq("location_id", locationId);
  const { data, error } = await query.order("adjustment_date", { ascending: false }).order("created_at", { ascending: false });
  throwOnError("getCommissionAdjustmentsAdmin", error);
  return data ?? [];
}

export async function createCommissionAdjustmentAdmin(
  sb: Sb,
  input: { locationId: string; amount: number; reason: string; adjustmentDate: string },
): Promise<void> {
  const {
    data: { user },
  } = await sb.auth.getUser();
  const { error } = await sb.from("pickup_location_commission_adjustments").insert({
    location_id: input.locationId,
    amount: input.amount,
    reason: input.reason,
    adjustment_date: input.adjustmentDate,
    created_by: user?.id ?? null,
  });
  throwOnError("createCommissionAdjustmentAdmin", error);
}

export async function deleteCommissionAdjustmentAdmin(sb: Sb, id: string): Promise<void> {
  const { error } = await sb.from("pickup_location_commission_adjustments").delete().eq("id", id);
  throwOnError("deleteCommissionAdjustmentAdmin", error);
}

// --- Inventory (per-location stock) ---------------------------------------

// location_id = null is the central/online pool (used for delivery
// orders); every other value is a specific pickup_locations row's
// takeaway stock. Kept as two separate rows per variant on purpose (see
// setup.sql's inventory table) — an online sale and a walk-in sale at a
// Zostel never compete for the same units.
export async function getInventoryAdmin(sb: Sb, locationId: string | null): Promise<InventoryWithVariant[]> {
  let query = sb.from("inventory").select("*, product_variants(*, products(name))");
  query = locationId === null ? query.is("location_id", null) : query.eq("location_id", locationId);
  const { data, error } = await query;
  throwOnError("getInventoryAdmin", error);
  const rows = (data as unknown as InventoryWithVariant[]) ?? [];
  // Without an explicit order, Postgres doesn't guarantee row order between
  // calls — an UPDATE can visibly reshuffle the list on the very next
  // refetch, which reads as "I changed the wrong row" even though nothing
  // is actually wrong. Sorted client-side (not via .order() on a joined
  // column, which the embedded product_variants(products(name)) shape
  // doesn't support directly) for a stable, human-readable order.
  return rows.sort((a, b) => {
    const nameCompare = a.product_variants.products.name.localeCompare(b.product_variants.products.name);
    return nameCompare !== 0 ? nameCompare : a.product_variants.variant_label.localeCompare(b.product_variants.variant_label);
  });
}

export async function updateInventoryQuantityAdmin(sb: Sb, id: string, quantity: number): Promise<void> {
  const { error } = await sb.from("inventory").update({ quantity_available: quantity }).eq("id", id);
  throwOnError("updateInventoryQuantityAdmin", error);
}

// Every active Zostel property's inventory in one list, instead of
// stepping through the location dropdown one property at a time — same
// editable rows as getInventoryAdmin, just not scoped to a single
// location_id (and excludes the online/delivery pool, which has its own
// "online / delivery" option in the existing dropdown).
export async function getAllZostelInventoryAdmin(sb: Sb): Promise<InventoryWithVariantAndLocation[]> {
  // !inner + a filter on the embedded resource excludes inactive
  // locations (e.g. the currently-deactivated Jaipur/HQ rows) at the
  // query level, rather than fetching them and throwing them away
  // client-side.
  const { data, error } = await sb
    .from("inventory")
    .select("*, product_variants(*, products(name)), pickup_locations:location_id!inner(name, city, is_active)")
    .eq("pickup_locations.is_active", true);
  throwOnError("getAllZostelInventoryAdmin", error);
  const rows = (data as unknown as InventoryWithVariantAndLocation[]) ?? [];
  return rows.sort((a, b) => {
      const locationCompare = a.pickup_locations!.name.localeCompare(b.pickup_locations!.name);
      if (locationCompare !== 0) return locationCompare;
      const nameCompare = a.product_variants.products.name.localeCompare(b.product_variants.products.name);
      return nameCompare !== 0 ? nameCompare : a.product_variants.variant_label.localeCompare(b.product_variants.variant_label);
    });
}

export type FullInventoryRow = {
  id: string;
  quantityAvailable: number;
  variantId: string;
  productName: string;
  variantLabel: string;
  price: number;
  reorderThreshold: number | null;
  /** null = the online/central pool, not a physical Zostel. */
  locationId: string | null;
  locationName: string | null;
};

// Every inventory row across every location, including the online pool —
// fetched once and aggregated differently client-side depending on which
// scope the inventory summary card's selector is on (all locations, all
// Zostel only, online only, or one specific Zostel), rather than a
// separate round trip per scope. Row count is tiny (variants × locations,
// a few dozen at most), so this is simpler than a query per scope.
export async function getFullInventoryAdmin(sb: Sb): Promise<FullInventoryRow[]> {
  const { data, error } = await sb
    .from("inventory")
    .select(
      "id, quantity_available, location_id, variant_id, product_variants(variant_label, price_override, reorder_threshold, products(name, price)), pickup_locations:location_id(name, is_active)",
    );
  throwOnError("getFullInventoryAdmin", error);

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    quantity_available: number;
    location_id: string | null;
    variant_id: string;
    product_variants: {
      variant_label: string;
      price_override: number | null;
      reorder_threshold: number | null;
      products: { name: string; price: number };
    };
    pickup_locations: { name: string; is_active: boolean } | null;
  }>;

  return rows
    .filter((row) => row.location_id === null || row.pickup_locations?.is_active === true)
    .map((row) => ({
      id: row.id,
      quantityAvailable: row.quantity_available,
      variantId: row.variant_id,
      productName: row.product_variants.products.name,
      variantLabel: row.product_variants.variant_label,
      price: row.product_variants.price_override ?? row.product_variants.products.price,
      reorderThreshold: row.product_variants.reorder_threshold,
      locationId: row.location_id,
      locationName: row.pickup_locations?.name ?? null,
    }));
}

export type InventoryTransactionWithVariant = InventoryTransaction & {
  product_variants: { variant_label: string; products: { name: string } };
  pickup_locations: { name: string } | null;
};

export type OrderStockMovementRow = { variantId: string; locationId: string | null; quantity: number };

// Real stock movement from actual orders — every order past 'placed' has
// already had its items decremented from inventory.quantity_available
// (see confirm_order_and_decrement_stock / confirm_cash_order), but that
// decrement never touches the manual Transaction Log, so a real online or
// takeaway sale silently drifts live stock away from whatever the log
// last claimed. This feeds the inventory summary's "gap vs. log" column
// so a routine sale is folded into the comparison as movement the log
// implicitly accounts for, instead of surfacing as a false discrepancy —
// without writing anything into inventory_transactions itself, so the
// manual ledger stays exactly what an admin typed into it, nothing more.
// 'cancelled' is excluded too: a cancelled order's stock has already been
// restocked (admin_cancel_order), so it nets to zero movement anyway.
export async function getOrderStockMovementAdmin(sb: Sb): Promise<OrderStockMovementRow[]> {
  const { data, error } = await sb
    .from("orders")
    .select("location_id, order_items(variant_id, quantity)")
    .not("status", "in", "(placed,cancelled)");
  throwOnError("getOrderStockMovementAdmin", error);

  const rows: OrderStockMovementRow[] = [];
  for (const order of (data ?? []) as unknown as { location_id: string | null; order_items: { variant_id: string; quantity: number }[] }[]) {
    for (const item of order.order_items) {
      rows.push({ variantId: item.variant_id, locationId: order.location_id, quantity: item.quantity });
    }
  }
  return rows;
}

// Manual reconciliation ledger (see 20260806113057_inventory_transactions
// migration) — an audit trail an admin fills in from the manufacturer's
// receipt paperwork and Zostel shipment records, deliberately NOT wired to
// mutate inventory.quantity_available (see the migration's comment for
// why). Most recent first.
export async function getInventoryTransactionsAdmin(sb: Sb): Promise<InventoryTransactionWithVariant[]> {
  const { data, error } = await sb
    .from("inventory_transactions")
    .select("*, product_variants(variant_label, products(name)), pickup_locations:location_id(name)")
    .order("transaction_date", { ascending: false })
    .order("created_at", { ascending: false });
  throwOnError("getInventoryTransactionsAdmin", error);
  return (data as unknown as InventoryTransactionWithVariant[]) ?? [];
}

export async function createInventoryTransactionAdmin(
  sb: Sb,
  input: {
    transactionDate: string;
    transactionType: "received" | "shipped" | "online_sale";
    variantId: string;
    locationId: string | null;
    quantity: number;
    notes?: string;
  },
): Promise<void> {
  const {
    data: { user },
  } = await sb.auth.getUser();
  const { error } = await sb.from("inventory_transactions").insert({
    transaction_date: input.transactionDate,
    transaction_type: input.transactionType,
    variant_id: input.variantId,
    location_id: input.locationId,
    quantity_in: input.transactionType === "received" ? input.quantity : null,
    quantity_out: input.transactionType === "received" ? null : input.quantity,
    notes: input.notes || null,
    created_by: user?.id ?? null,
  });
  throwOnError("createInventoryTransactionAdmin", error);
}

export async function updateInventoryTransactionAdmin(
  sb: Sb,
  id: string,
  input: {
    transactionDate: string;
    transactionType: "received" | "shipped" | "online_sale";
    variantId: string;
    locationId: string | null;
    quantity: number;
    notes?: string;
  },
): Promise<void> {
  const { error } = await sb
    .from("inventory_transactions")
    .update({
      transaction_date: input.transactionDate,
      transaction_type: input.transactionType,
      variant_id: input.variantId,
      location_id: input.locationId,
      quantity_in: input.transactionType === "received" ? input.quantity : null,
      quantity_out: input.transactionType === "received" ? null : input.quantity,
      notes: input.notes || null,
    })
    .eq("id", id);
  throwOnError("updateInventoryTransactionAdmin", error);
}

export async function deleteInventoryTransactionAdmin(sb: Sb, id: string): Promise<void> {
  const { error } = await sb.from("inventory_transactions").delete().eq("id", id);
  throwOnError("deleteInventoryTransactionAdmin", error);
}

export type MisplacedStockLogWithVariant = MisplacedStockLog & {
  product_variants: { variant_label: string; products: { name: string } };
  pickup_locations: { name: string } | null;
};

// Manual log for stock that went missing or got misplaced at a place —
// see 20260902000000_misplaced_stock_logs migration. Kept as its own
// table rather than a 4th Transaction Log type, since a missing unit
// isn't a received/shipped/sold movement. Most recent first.
export async function getMisplacedStockLogsAdmin(sb: Sb): Promise<MisplacedStockLogWithVariant[]> {
  const { data, error } = await sb
    .from("misplaced_stock_logs")
    .select("*, product_variants(variant_label, products(name)), pickup_locations:location_id(name)")
    .order("log_date", { ascending: false })
    .order("created_at", { ascending: false });
  throwOnError("getMisplacedStockLogsAdmin", error);
  return (data as unknown as MisplacedStockLogWithVariant[]) ?? [];
}

export async function createMisplacedStockLogAdmin(
  sb: Sb,
  input: { logDate: string; variantId: string; locationId: string | null; quantity: number; notes?: string },
): Promise<void> {
  const {
    data: { user },
  } = await sb.auth.getUser();
  const { error } = await sb.from("misplaced_stock_logs").insert({
    log_date: input.logDate,
    variant_id: input.variantId,
    location_id: input.locationId,
    quantity: input.quantity,
    notes: input.notes || null,
    created_by: user?.id ?? null,
  });
  throwOnError("createMisplacedStockLogAdmin", error);
}

export async function updateMisplacedStockLogAdmin(
  sb: Sb,
  id: string,
  input: { logDate: string; variantId: string; locationId: string | null; quantity: number; notes?: string },
): Promise<void> {
  const { error } = await sb
    .from("misplaced_stock_logs")
    .update({
      log_date: input.logDate,
      variant_id: input.variantId,
      location_id: input.locationId,
      quantity: input.quantity,
      notes: input.notes || null,
    })
    .eq("id", id);
  throwOnError("updateMisplacedStockLogAdmin", error);
}

export async function deleteMisplacedStockLogAdmin(sb: Sb, id: string): Promise<void> {
  const { error } = await sb.from("misplaced_stock_logs").delete().eq("id", id);
  throwOnError("deleteMisplacedStockLogAdmin", error);
}

// The real number of units sold online, straight from paid orders — not
// the manually-typed "online_sale" ledger entries above. Shown alongside
// the ledger so a mismatch is an actual, grounded variance, not a
// reconciliation between two manually-entered figures.
export async function getRealOnlineSalesByVariantAdmin(sb: Sb): Promise<Map<string, number>> {
  const { data, error } = await sb
    .from("order_items")
    .select("variant_id, quantity, orders!inner(payment_status)")
    .eq("orders.payment_status", "paid");
  throwOnError("getRealOnlineSalesByVariantAdmin", error);

  const rows = (data ?? []) as unknown as Array<{ variant_id: string; quantity: number }>;
  const byVariant = new Map<string, number>();
  for (const row of rows) {
    byVariant.set(row.variant_id, (byVariant.get(row.variant_id) ?? 0) + row.quantity);
  }
  return byVariant;
}

// A location (a new pickup point, or one that was never fully stocked —
// see the Zostel Mumbai gap this was built to fix) can end up with fewer
// inventory rows than the product catalog. There was previously no way to
// fix that from this page at all: QuantityCell only edits rows that
// already exist. New rows start at 0 (out of stock) rather than guessing a
// real count — an admin fills in the actual number afterward via the same
// per-row editor.
export async function addMissingInventoryRowsAdmin(sb: Sb, locationId: string | null): Promise<number> {
  const { data: variants, error: variantsError } = await sb.from("product_variants").select("id");
  throwOnError("addMissingInventoryRowsAdmin (variants)", variantsError);

  let existingQuery = sb.from("inventory").select("variant_id");
  existingQuery = locationId === null ? existingQuery.is("location_id", null) : existingQuery.eq("location_id", locationId);
  const { data: existing, error: existingError } = await existingQuery;
  throwOnError("addMissingInventoryRowsAdmin (existing)", existingError);

  const existingIds = new Set((existing ?? []).map((row) => row.variant_id));
  const missing = (variants ?? []).filter((variant) => !existingIds.has(variant.id));
  if (missing.length === 0) return 0;

  const { error: insertError } = await sb
    .from("inventory")
    .insert(missing.map((variant) => ({ variant_id: variant.id, location_id: locationId, quantity_available: 0 })));
  throwOnError("addMissingInventoryRowsAdmin (insert)", insertError);
  return missing.length;
}

// Single-row counterpart to addMissingInventoryRowsAdmin above — used by
// the inventory health dashboard's per-product missing list, where an
// admin picks a specific product/location gap and enters a real starting
// count instead of the bulk button's blind 0.
export async function addInventoryRowAdmin(sb: Sb, variantId: string, locationId: string | null, quantity: number): Promise<void> {
  const { error } = await sb.from("inventory").insert({ variant_id: variantId, location_id: locationId, quantity_available: quantity });
  throwOnError("addInventoryRowAdmin", error);
}

// --- Serviceable pincodes -------------------------------------------------

export async function getPincodesAdmin(sb: Sb) {
  const { data, error } = await sb.from("serviceable_pincodes").select("*").order("pincode");
  throwOnError("getPincodesAdmin", error);
  return data ?? [];
}

export async function createPincodeAdmin(
  sb: Sb,
  input: Database["public"]["Tables"]["serviceable_pincodes"]["Insert"],
) {
  const { data, error } = await sb.from("serviceable_pincodes").insert(input).select("*").single();
  throwOnError("createPincodeAdmin", error);
  return data!;
}

export async function updatePincodeAdmin(
  sb: Sb,
  id: string,
  input: Database["public"]["Tables"]["serviceable_pincodes"]["Update"],
): Promise<void> {
  const { error } = await sb.from("serviceable_pincodes").update(input).eq("id", id);
  throwOnError("updatePincodeAdmin", error);
}

export async function deletePincodeAdmin(sb: Sb, id: string): Promise<void> {
  const { error } = await sb.from("serviceable_pincodes").delete().eq("id", id);
  throwOnError("deletePincodeAdmin", error);
}

// --- Experts (edit/moderate — creation stays in admin-create-expert) -----

export async function getAllExpertsAdmin(sb: Sb): Promise<Expert[]> {
  const { data, error } = await sb.from("experts").select("*").order("name");
  throwOnError("getAllExpertsAdmin", error);
  return data ?? [];
}

export async function updateExpertAdmin(
  sb: Sb,
  id: string,
  input: Database["public"]["Tables"]["experts"]["Update"],
): Promise<void> {
  const { error } = await sb.from("experts").update(input).eq("id", id);
  throwOnError("updateExpertAdmin", error);
}

export async function deleteExpertAdmin(sb: Sb, id: string): Promise<void> {
  const { error } = await sb.from("experts").delete().eq("id", id);
  throwOnError("deleteExpertAdmin", error);
}

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ALLOWED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

// Uploads directly to the public expert-photos bucket (see setup.sql —
// public read, is_admin() write) and returns the public URL to store on
// experts.photo_url. A random filename avoids collisions between two
// admins uploading around the same time; nothing here needs to be
// human-readable since it's never linked to from anywhere but that column.
export async function uploadExpertPhotoAdmin(sb: Sb, file: File): Promise<string> {
  if (!ALLOWED_PHOTO_TYPES.includes(file.type)) {
    throw new ApiError("uploadExpertPhotoAdmin", { message: "Please upload a JPEG, PNG, or WebP image" });
  }
  if (file.size > MAX_PHOTO_BYTES) {
    throw new ApiError("uploadExpertPhotoAdmin", { message: "Image must be under 5MB" });
  }

  const ext = file.name.split(".").pop() ?? "jpg";
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error: uploadError } = await sb.storage.from("expert-photos").upload(path, file, { upsert: false });
  throwOnError("uploadExpertPhotoAdmin", uploadError);

  const { data } = sb.storage.from("expert-photos").getPublicUrl(path);
  return data.publicUrl;
}

// Links an ALREADY-SIGNED-UP account to a directory-only expert row (the
// other path to expert login access, alongside admin-create-expert which
// creates a brand-new account). Two writes, deliberately in this order:
// the role change is attempted first because it's the one that requires
// super_admin (prevent_role_self_escalation) — if it fails, nothing about
// the experts row has changed yet, so there's no partial link left behind
// for a plain admin who tries this.
export async function linkExistingUserAsExpertAdmin(sb: Sb, expertId: string, userId: string): Promise<void> {
  const { error: roleError } = await sb.from("profiles").update({ role: "expert" }).eq("id", userId);
  throwOnError("linkExistingUserAsExpertAdmin.role", roleError);

  const { error: linkError } = await sb.from("experts").update({ profile_id: userId }).eq("id", expertId);
  throwOnError("linkExistingUserAsExpertAdmin.link", linkError);
}

// Removes login access without touching the person's role — deciding
// whether they should also stop being 'expert' is a separate call (the
// /admin/users role dropdown), not implied by unlinking the directory
// entry.
export async function unlinkExpertAdmin(sb: Sb, expertId: string): Promise<void> {
  const { error } = await sb.from("experts").update({ profile_id: null }).eq("id", expertId);
  throwOnError("unlinkExpertAdmin", error);
}

// --- Business leads -----------------------------------------------------

export async function getBusinessLeadsAdmin(sb: Sb): Promise<BusinessLead[]> {
  const { data, error } = await sb.from("business_leads").select("*").order("created_at", { ascending: false });
  throwOnError("getBusinessLeadsAdmin", error);
  return data ?? [];
}

export async function updateBusinessLeadAdmin(
  sb: Sb,
  id: string,
  status: BusinessLead["status"],
): Promise<void> {
  const { error } = await sb.from("business_leads").update({ status }).eq("id", id);
  throwOnError("updateBusinessLeadAdmin", error);
}

// --- Contact messages -----------------------------------------------------

export async function getContactMessagesAdmin(sb: Sb): Promise<ContactMessage[]> {
  const { data, error } = await sb.from("contact_messages").select("*").order("created_at", { ascending: false });
  throwOnError("getContactMessagesAdmin", error);
  return data ?? [];
}

export async function updateContactMessageAdmin(
  sb: Sb,
  id: string,
  status: ContactMessage["status"],
): Promise<void> {
  const { error } = await sb.from("contact_messages").update({ status }).eq("id", id);
  throwOnError("updateContactMessageAdmin", error);
}

// --- Feedback (shareable /feedback page) ----------------------------------

export async function getFeedbackAdmin(sb: Sb): Promise<Feedback[]> {
  const { data, error } = await sb.from("feedback").select("*").order("created_at", { ascending: false });
  throwOnError("getFeedbackAdmin", error);
  return data ?? [];
}

export async function updateFeedbackStatusAdmin(sb: Sb, id: string, status: Feedback["status"]): Promise<void> {
  const { error } = await sb.from("feedback").update({ status }).eq("id", id);
  throwOnError("updateFeedbackStatusAdmin", error);
}

export async function deleteFeedbackAdmin(sb: Sb, id: string): Promise<void> {
  const { error } = await sb.from("feedback").delete().eq("id", id);
  throwOnError("deleteFeedbackAdmin", error);
}

// Copies a feedback entry the person agreed to share (can_publish) into the
// public reviews table — so it shows in the site's testimonial carousels —
// then marks the feedback as published. Two writes; the review goes first
// so a failure never leaves feedback marked "published" with no review.
export async function publishFeedbackAsReviewAdmin(sb: Sb, feedback: Feedback): Promise<void> {
  const { error: reviewError } = await sb.from("reviews").insert({
    reviewer_name: feedback.name,
    rating: feedback.rating,
    comment: feedback.message,
    is_corporate: false,
  });
  throwOnError("publishFeedbackAsReviewAdmin.review", reviewError);
  await updateFeedbackStatusAdmin(sb, feedback.id, "published");
}

// --- Expert applications ("become an expert" submissions) -----------------

export async function getExpertApplicationsAdmin(sb: Sb): Promise<ExpertApplication[]> {
  const { data, error } = await sb.from("expert_applications").select("*").order("created_at", { ascending: false });
  throwOnError("getExpertApplicationsAdmin", error);
  return data ?? [];
}

export async function updateExpertApplicationAdmin(
  sb: Sb,
  id: string,
  status: ExpertApplication["status"],
): Promise<void> {
  const { error } = await sb.from("expert_applications").update({ status }).eq("id", id);
  throwOnError("updateExpertApplicationAdmin", error);
}

// --- Feelz preorders --------------------------------------------------------

export async function getFeelzPreordersAdmin(sb: Sb): Promise<FeelzPreorder[]> {
  const { data, error } = await sb.from("feelz_preorders").select("*").order("created_at", { ascending: false });
  throwOnError("getFeelzPreordersAdmin", error);
  return data ?? [];
}

// --- FAQs -----------------------------------------------------------------

export async function createFaqAdmin(sb: Sb, input: Database["public"]["Tables"]["faqs"]["Insert"]): Promise<Faq> {
  const { data, error } = await sb.from("faqs").insert(input).select("*").single();
  throwOnError("createFaqAdmin", error);
  return data!;
}

export async function updateFaqAdmin(
  sb: Sb,
  id: string,
  input: Database["public"]["Tables"]["faqs"]["Update"],
): Promise<void> {
  const { error } = await sb.from("faqs").update(input).eq("id", id);
  throwOnError("updateFaqAdmin", error);
}

export async function deleteFaqAdmin(sb: Sb, id: string): Promise<void> {
  const { error } = await sb.from("faqs").delete().eq("id", id);
  throwOnError("deleteFaqAdmin", error);
}

// --- Therapy categories ---------------------------------------------------

export async function updateTherapyCategoryAdmin(
  sb: Sb,
  slug: string,
  input: Database["public"]["Tables"]["therapy_categories"]["Update"],
): Promise<void> {
  const { error } = await sb.from("therapy_categories").update(input).eq("slug", slug);
  throwOnError("updateTherapyCategoryAdmin", error);
}

// --- Milestones -------------------------------------------------------------

export async function createMilestoneAdmin(
  sb: Sb,
  input: Database["public"]["Tables"]["milestones"]["Insert"],
): Promise<Milestone> {
  const { data, error } = await sb.from("milestones").insert(input).select("*").single();
  throwOnError("createMilestoneAdmin", error);
  return data!;
}

export async function updateMilestoneAdmin(
  sb: Sb,
  id: string,
  input: Database["public"]["Tables"]["milestones"]["Update"],
): Promise<void> {
  const { error } = await sb.from("milestones").update(input).eq("id", id);
  throwOnError("updateMilestoneAdmin", error);
}

export async function deleteMilestoneAdmin(sb: Sb, id: string): Promise<void> {
  const { error } = await sb.from("milestones").delete().eq("id", id);
  throwOnError("deleteMilestoneAdmin", error);
}

// --- Site settings ----------------------------------------------------------

export async function getAllSiteSettingsAdmin(sb: Sb): Promise<SiteSetting[]> {
  const { data, error } = await sb.from("site_settings").select("*").order("key");
  throwOnError("getAllSiteSettingsAdmin", error);
  return data ?? [];
}

export async function upsertSiteSettingAdmin(sb: Sb, key: string, value: Json): Promise<void> {
  const { error } = await sb.from("site_settings").upsert({ key, value, updated_at: new Date().toISOString() });
  throwOnError("upsertSiteSettingAdmin", error);
}

export async function deleteSiteSettingAdmin(sb: Sb, key: string): Promise<void> {
  const { error } = await sb.from("site_settings").delete().eq("key", key);
  throwOnError("deleteSiteSettingAdmin", error);
}

// --- Reviews ----------------------------------------------------------------

export async function getAllReviewsAdmin(sb: Sb): Promise<Review[]> {
  const { data, error } = await sb.from("reviews").select("*").order("created_at", { ascending: false });
  throwOnError("getAllReviewsAdmin", error);
  return data ?? [];
}

export async function updateReviewAdmin(
  sb: Sb,
  id: string,
  input: Database["public"]["Tables"]["reviews"]["Update"],
): Promise<void> {
  const { error } = await sb.from("reviews").update(input).eq("id", id);
  throwOnError("updateReviewAdmin", error);
}

export async function deleteReviewAdmin(sb: Sb, id: string): Promise<void> {
  const { error } = await sb.from("reviews").delete().eq("id", id);
  throwOnError("deleteReviewAdmin", error);
}

// --- Newsletter -------------------------------------------------------------

export async function getNewsletterSubscribersAdmin(sb: Sb): Promise<NewsletterSubscriber[]> {
  const { data, error } = await sb.from("newsletter_subscribers").select("*").order("subscribed_at", { ascending: false });
  throwOnError("getNewsletterSubscribersAdmin", error);
  return data ?? [];
}

// --- Users & roles (list via Edge Function; role change is a direct,
// RLS-enforced table update — only actually succeeds for a super_admin
// caller, see prevent_role_self_escalation() in setup.sql) -------------

export type AdminUserRow = {
  id: string;
  email: string | null;
  phone: string | null;
  full_name: string | null;
  role: Database["public"]["Tables"]["profiles"]["Row"]["role"];
  created_at: string;
};

export async function listUsersAdmin(sb: Sb): Promise<AdminUserRow[]> {
  const { data, error } = await sb.functions.invoke("admin-list-users", { body: {} });
  if (error) {
    const detail = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new ApiError("listUsersAdmin", { message: detail?.error ?? error.message });
  }
  return (data as { users: AdminUserRow[] }).users;
}

export async function updateUserRoleAdmin(
  sb: Sb,
  userId: string,
  role: Database["public"]["Tables"]["profiles"]["Row"]["role"],
): Promise<void> {
  const { error } = await sb.from("profiles").update({ role }).eq("id", userId);
  throwOnError("updateUserRoleAdmin", error);
}
