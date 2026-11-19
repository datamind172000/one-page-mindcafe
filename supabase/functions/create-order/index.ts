// Single server-side checkout entry point: given a cart + fulfillment
// choice + optional coupon, this looks up real prices, validates the
// coupon, checks/reserves stock, creates the order (+ order_items) row(s),
// and creates the matching Razorpay order — all in one call, so nothing
// about the amount ever has to be trusted from the client.
//
// Supports both signed-in and guest checkout: a guest just supplies
// name/phone(/email) instead of riding on an auth.users row. Delivery
// still needs a full address either way (Shiprocket requires it) — either
// an existing addresses row (signed-in only) or an inline address object.
import { userScopedClient, serviceRoleClient } from "../_shared/supabaseClients.ts";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

// Shiprocket auth/serviceability logic is duplicated here and in
// check-pincode-serviceability (rather than a shared _shared/ module) so
// each function stays a single self-contained file deployable via the
// dashboard's Code editor — same pattern as create-shiprocket-shipment's
// own token cache.
let cachedShiprocketToken: { token: string; expiresAt: number } | null = null;

// Site-wide free delivery: every delivery order silently gets this coupon
// applied server-side — no code entry from the customer. See the
// 20260817000000_free_delivery_coupon_type migration for the coupon row
// and the discount_type it relies on.
const FREE_DELIVERY_COUPON_CODE = "FREESHIP";

async function getShiprocketToken(): Promise<string> {
  if (cachedShiprocketToken && cachedShiprocketToken.expiresAt > Date.now()) return cachedShiprocketToken.token;

  const res = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: Deno.env.get("SHIPROCKET_EMAIL"),
      password: Deno.env.get("SHIPROCKET_PASSWORD"),
    }),
  });

  if (!res.ok) throw new Error(`Shiprocket auth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedShiprocketToken = { token: data.token, expiresAt: Date.now() + 60 * 60 * 1000 };
  return cachedShiprocketToken.token;
}

type ServiceabilityResult =
  | { serviceable: true; deliveryFee: number; courierName: string; etd: string | null }
  | { serviceable: false };

async function checkServiceability(deliveryPincode: string, weightKg: number): Promise<ServiceabilityResult> {
  const pickupPincode = Deno.env.get("SHIPROCKET_PICKUP_PINCODE");
  const token = await getShiprocketToken();

  const url = new URL("https://apiv2.shiprocket.in/v1/external/courier/serviceability/");
  url.searchParams.set("pickup_postcode", pickupPincode ?? "");
  url.searchParams.set("delivery_postcode", deliveryPincode);
  url.searchParams.set("weight", String(weightKg));
  url.searchParams.set("cod", "0");

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Shiprocket serviceability check failed: ${res.status} ${await res.text()}`);

  const body = await res.json();
  const couriers = body?.data?.available_courier_companies as
    | Array<{ rate: number; courier_name: string; etd?: string }>
    | undefined;

  // Logged unconditionally (not just on the empty-result path) so a run of
  // logs shows the actual courier count Shiprocket returned each time —
  // that's what makes a checkout-time "deliverable" estimate disagreeing
  // with this same call moments later diagnosable, instead of just two
  // silent booleans that don't explain themselves.
  console.log(
    `create-order: Shiprocket serviceability for ${deliveryPincode} (from ${pickupPincode}, ${weightKg}kg) — ${couriers?.length ?? 0} couriers available`,
  );

  if (!couriers || couriers.length === 0) return { serviceable: false };

  const cheapest = couriers.reduce((min, c) => (c.rate < min.rate ? c : min), couriers[0]);
  return {
    serviceable: true,
    deliveryFee: Number(cheapest.rate),
    courierName: cheapest.courier_name,
    etd: cheapest.etd ?? null,
  };
}

type CartItemInput = { variant_id: string; quantity: number };

type DeliveryFulfillment = {
  type: "delivery";
  address_id?: string;
  address?: {
    full_name: string;
    phone: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    pincode: string;
    landmark?: string;
  };
};
type TakeawayFulfillment = { type: "takeaway"; location_id: string; pickup_slot?: string };

type RequestBody = {
  cart_id: string;
  items: CartItemInput[];
  fulfillment: DeliveryFulfillment | TakeawayFulfillment;
  coupon_code?: string;
  guest?: { name: string; phone: string; email?: string };
  notes?: string;
  attribution?: Record<string, unknown>;
};

const ATTRIBUTION_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "fbclid"] as const;
function cleanAttribution(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  const safe: Record<string, string> = {};
  for (const key of ATTRIBUTION_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 160 && /^[a-zA-Z0-9_.~%-]+$/.test(value)) safe[key] = value;
  }
  return safe;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { cart_id, items, fulfillment, coupon_code, guest, notes, attribution } = body ?? ({} as RequestBody);
  const safeAttribution = cleanAttribution(attribution);

  if (!cart_id || !Array.isArray(items) || items.length === 0) {
    return jsonResponse({ error: "cart_id and a non-empty items array are required" }, 400);
  }
  if (!fulfillment || (fulfillment.type !== "delivery" && fulfillment.type !== "takeaway")) {
    return jsonResponse({ error: "fulfillment.type must be 'delivery' or 'takeaway'" }, 400);
  }

  // The caller authenticates as themself (or anon) via the JWT
  // supabase.functions.invoke already attaches — we never take a user_id
  // from the request body itself.
  const callerClient = userScopedClient(req);
  const {
    data: { user },
  } = await callerClient.auth.getUser();

  if (!user && (!guest?.name || !guest?.phone)) {
    return jsonResponse({ error: "guest.name and guest.phone are required for guest checkout" }, 400);
  }

  const sb = serviceRoleClient();

  // --- Real prices, looked up server-side. Never trust a price/subtotal
  // sent from the client. ---
  const variantIds = items.map((i) => i.variant_id);
  const { data: variants, error: variantsError } = await sb
    .from("product_variants")
    .select("id, price_override, weight_grams, products(id, name, price, is_active, is_bundle)")
    .in("id", variantIds);

  if (variantsError || !variants) return jsonResponse({ error: "Failed to look up products" }, 500);

  const variantById = new Map(variants.map((v) => [v.id, v as unknown as {
    id: string;
    price_override: number | null;
    weight_grams: number | null;
    products: { id: string; name: string; price: number; is_active: boolean; is_bundle: boolean } | null;
  }]));

  const FALLBACK_WEIGHT_GRAMS = 500;
  let subtotal = 0;
  // Everything except the Feelz Bundle (products.is_bundle) — the bundle
  // is always exactly its own price, so neither the automatic discount
  // nor any coupon below ever takes money off it.
  let discountableSubtotal = 0;
  let totalWeightGrams = 0;
  const orderItemsInput: { variantId: string; quantity: number; unitPrice: number }[] = [];

  for (const item of items) {
    const variant = variantById.get(item.variant_id);
    const quantity = Number(item.quantity);
    if (!variant || !variant.products?.is_active || !Number.isInteger(quantity) || quantity <= 0) {
      return jsonResponse({ error: `Invalid or inactive item: ${item.variant_id}` }, 400);
    }
    const unitPrice = Number(variant.price_override ?? variant.products.price);
    subtotal += unitPrice * quantity;
    if (!variant.products.is_bundle) discountableSubtotal += unitPrice * quantity;
    totalWeightGrams += (variant.weight_grams ?? FALLBACK_WEIGHT_GRAMS) * quantity;
    orderItemsInput.push({ variantId: item.variant_id, quantity, unitPrice });
  }

  // 10% off the non-bundle items once they alone total ₹300+ — automatic,
  // no code needed (e.g. 2 × Joy = ₹580 → ₹58 off; bundle + 1 Joy → no
  // discount). Computed here so it's real (enforced on the actual charge);
  // kept out of the coupons table entirely and resolved against any coupon
  // below by taking whichever is larger, never both. Mirrored for display
  // in the storefront's src/lib/pricing.ts — keep the two in sync.
  const AUTO_DISCOUNT_MIN_SUBTOTAL = 300;
  const AUTO_DISCOUNT_PERCENT = 0.1;
  const quantityDiscountAmount =
    discountableSubtotal >= AUTO_DISCOUNT_MIN_SUBTOTAL
      ? Math.round(discountableSubtotal * AUTO_DISCOUNT_PERCENT * 100) / 100
      : 0;

  // --- Fulfillment-specific validation ---
  let addressId: string | null = null;
  let guestAddress: Record<string, string | null> | null = null;
  let locationId: string | null = null;
  let pickupSlot: string | null = null;
  let deliveryFee = 0;
  let freeDeliveryApplied = false;
  // Shiprocket's own delivery estimate ("5-7 days" style string) from the
  // same serviceability check that sets deliveryFee — previously computed
  // and discarded; now persisted so it can actually reach the customer
  // (order confirmation, order-status-notifier emails) instead of only
  // flashing on screen once during the pincode check at checkout.
  let estimatedDelivery: string | null = null;

  if (fulfillment.type === "delivery") {
    let pincode: string;

    if (fulfillment.address_id) {
      if (!user) return jsonResponse({ error: "address_id requires being signed in" }, 400);
      // Uses the caller's own JWT so RLS's owner-only policy is what
      // actually stops someone from checking out against a stranger's
      // saved address.
      const { data: address } = await callerClient
        .from("addresses")
        .select("*")
        .eq("id", fulfillment.address_id)
        .maybeSingle();
      if (!address) return jsonResponse({ error: "Address not found" }, 404);
      addressId = address.id;
      pincode = address.pincode;
    } else if (fulfillment.address) {
      const a = fulfillment.address;
      if (!a.full_name || !a.phone || !a.line1 || !a.city || !a.state || !a.pincode) {
        return jsonResponse({ error: "Incomplete delivery address" }, 400);
      }
      guestAddress = {
        guest_address_line1: a.line1,
        guest_address_line2: a.line2 ?? null,
        guest_address_city: a.city,
        guest_address_state: a.state,
        guest_address_pincode: a.pincode,
      };
      pincode = a.pincode;
    } else {
      return jsonResponse({ error: "fulfillment.address_id or fulfillment.address is required for delivery" }, 400);
    }

    // Real-time check against Shiprocket's own courier network, not the
    // old manually-curated serviceable_pincodes table — this is the
    // authoritative price actually charged, so a Shiprocket outage fails
    // the checkout rather than silently falling back to a guessed fee.
    //
    // One retry on a "no couriers" result before failing the order: the
    // checkout-time estimate (check-pincode-serviceability) already told
    // the customer this address was deliverable, so a single empty
    // response here is more likely Shiprocket-side flakiness between two
    // calls seconds apart than a real coverage change — worth one more
    // look before turning that into a hard failure at the moment they're
    // trying to pay.
    let serviceability;
    try {
      serviceability = await checkServiceability(pincode, totalWeightGrams / 1000);
      if (!serviceability.serviceable) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        serviceability = await checkServiceability(pincode, totalWeightGrams / 1000);
      }
    } catch (err) {
      console.error("create-order: Shiprocket serviceability check failed", err);
      return jsonResponse({ error: "Couldn't verify delivery availability right now — please try again" }, 502);
    }
    if (!serviceability.serviceable) return jsonResponse({ error: "This pincode isn't serviceable yet" }, 400);
    deliveryFee = serviceability.deliveryFee;
    estimatedDelivery = serviceability.etd;

    // deliveryFee above stays the real Shiprocket cost (recorded on the
    // order below for accounting) — this only decides whether the
    // customer is charged for it.
    const { data: freeDeliveryCoupon } = await sb
      .from("coupons")
      .select("is_active, expires_at, usage_limit, times_used")
      .eq("code", FREE_DELIVERY_COUPON_CODE)
      .maybeSingle();
    freeDeliveryApplied = Boolean(
      freeDeliveryCoupon?.is_active &&
        (!freeDeliveryCoupon.expires_at || new Date(freeDeliveryCoupon.expires_at) > new Date()) &&
        (freeDeliveryCoupon.usage_limit === null || freeDeliveryCoupon.times_used < freeDeliveryCoupon.usage_limit),
    );
  } else {
    if (!fulfillment.location_id) {
      return jsonResponse({ error: "fulfillment.location_id is required for takeaway" }, 400);
    }
    locationId = fulfillment.location_id;
    pickupSlot = fulfillment.pickup_slot ?? null;
  }

  // --- Coupon, validated and priced server-side — before reserving stock,
  // so an invalid code fails fast without holding reservations. ---
  let couponDiscountAmount = 0;
  let validatedCoupon: { code: string } | null = null;

  if (coupon_code) {
    const { data: coupon } = await sb
      .from("coupons")
      .select("*")
      .eq("code", coupon_code.trim().toUpperCase())
      .maybeSingle();

    if (!coupon || !coupon.is_active || (coupon.expires_at && new Date(coupon.expires_at) < new Date())) {
      return jsonResponse({ error: "Invalid or expired coupon code" }, 400);
    }
    if (coupon.usage_limit !== null && coupon.times_used >= coupon.usage_limit) {
      return jsonResponse({ error: "This coupon has reached its usage limit" }, 400);
    }
    if (subtotal < Number(coupon.min_order_amount)) {
      return jsonResponse({ error: `This coupon needs a minimum order of ₹${coupon.min_order_amount}` }, 400);
    }

    // Priced against the non-bundle items only (the bundle is fixed-price);
    // the minimum-order check above still uses the full subtotal.
    couponDiscountAmount =
      coupon.discount_type === "percent"
        ? discountableSubtotal * (Number(coupon.discount_value) / 100)
        : Number(coupon.discount_value);
    if (coupon.max_discount_amount !== null) couponDiscountAmount = Math.min(couponDiscountAmount, Number(coupon.max_discount_amount));
    couponDiscountAmount = Math.min(couponDiscountAmount, discountableSubtotal);
    validatedCoupon = { code: coupon.code };
  }

  // Resolved against the quantity discount computed above — whichever is
  // larger wins, never both (a customer applying FEELZ10 on top of the
  // automatic 10% shouldn't get 20% off). The coupon's usage_limit is only consumed when
  // the coupon is actually what's used, below.
  const quantityDiscountWins = quantityDiscountAmount > couponDiscountAmount;
  const discountAmount = quantityDiscountWins ? quantityDiscountAmount : couponDiscountAmount;
  const appliedCouponCode = quantityDiscountWins ? null : validatedCoupon?.code ?? null;

  // --- Stock check + short-lived reservation (re-verified atomically
  // inside the RPC, same guard the 3-step checkout uses). ---
  for (const item of orderItemsInput) {
    const { error: reserveError } = await sb.rpc("create_stock_reservation", {
      p_cart_id: cart_id,
      p_variant_id: item.variantId,
      p_location_id: locationId,
      p_quantity: item.quantity,
    });
    if (reserveError) {
      const insufficientStock = reserveError.message?.includes("INSUFFICIENT_STOCK");
      return jsonResponse(
        { error: insufficientStock ? "One of the items in your cart just went out of stock" : "Failed to reserve stock" },
        409,
      );
    }
  }

  const total = Math.max(0, subtotal - discountAmount + (freeDeliveryApplied ? 0 : deliveryFee));

  const { data: order, error: orderError } = await sb
    .from("orders")
    .insert({
      user_id: user?.id ?? null,
      source_cart_id: cart_id,
      fulfillment_type: fulfillment.type,
      address_id: addressId,
      location_id: locationId,
      pickup_slot: pickupSlot,
      payment_method: "razorpay",
      subtotal,
      delivery_fee: deliveryFee,
      estimated_delivery: estimatedDelivery,
      discount_amount: discountAmount,
      coupon_code: appliedCouponCode,
      total,
      guest_name: user ? null : guest!.name,
      guest_phone: user ? null : guest!.phone,
      guest_email: user ? null : (guest!.email ?? null),
      notes: notes?.trim() || null,
      attribution: safeAttribution,
      ...(guestAddress ?? {}),
    })
    .select("id")
    .single();

  if (orderError || !order) {
    console.error("create-order: failed to insert order", orderError);
    return jsonResponse({ error: "Failed to create order" }, 500);
  }

  const { error: itemsError } = await sb
    .from("order_items")
    .insert(orderItemsInput.map((i) => ({ order_id: order.id, variant_id: i.variantId, quantity: i.quantity, unit_price: i.unitPrice })));

  if (itemsError) {
    console.error("create-order: failed to insert order_items", itemsError);
    return jsonResponse({ error: "Failed to create order items" }, 500);
  }

  if (appliedCouponCode) {
    await sb.rpc("increment_coupon_usage", { p_code: appliedCouponCode });
  }
  if (freeDeliveryApplied) {
    await sb.rpc("increment_coupon_usage", { p_code: FREE_DELIVERY_COUPON_CODE });
  }

  // Cart's job is done once its contents are snapshotted into the order.
  await sb.from("cart_items").delete().eq("cart_id", cart_id);

  // --- A coupon can bring the order down to ₹0, or (a percent-off coupon
  // on a low enough price) down to a few paise — Razorpay's Orders API
  // rejects anything under its 100-paise (₹1) minimum either way, which
  // otherwise surfaces to the customer as "failed to create razorpay
  // order" despite nothing actually being wrong. Below that floor, there's
  // nothing Checkout.js can meaningfully charge — confirm the order
  // immediately via the same real confirmation path a successful payment
  // webhook uses (confirm_order_and_decrement_stock), so it still
  // decrements real inventory and fires the same order-confirmed
  // notification as any paid one. ---
  const RAZORPAY_MIN_AMOUNT_PAISE = 100;
  if (Math.round(total * 100) < RAZORPAY_MIN_AMOUNT_PAISE) {
    const { error: confirmError } = await sb.rpc("confirm_order_and_decrement_stock", {
      p_order_id: order.id,
      p_payment_ref: "free-fully-discounted",
    });
    if (confirmError) {
      console.error("create-order: failed to auto-confirm free order", confirmError);
      return jsonResponse({ error: "Failed to confirm order" }, 500);
    }

    return jsonResponse({
      order_id: order.id,
      free: true,
      subtotal,
      discount_amount: discountAmount,
      delivery_fee: deliveryFee,
      total,
    });
  }

  // --- Razorpay order, same two-step flow create-razorpay-order used:
  // amount is fixed server-side before Checkout.js ever opens. ---
  const amountPaise = Math.round(total * 100);
  const keyId = Deno.env.get("RAZORPAY_KEY_ID")!;
  const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET")!;
  const auth = btoa(`${keyId}:${keySecret}`);

  const razorpayRes = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ amount: amountPaise, currency: "INR", receipt: order.id, notes: safeAttribution }),
  });

  if (!razorpayRes.ok) {
    console.error("create-order: Razorpay order creation failed", await razorpayRes.text());
    // The order row already exists as 'placed' with no razorpay_order_id —
    // same abandoned-order shape the 3-step checkout can leave behind on
    // this failure path today; nothing further to clean up here.
    return jsonResponse({ error: "Failed to create Razorpay order" }, 502);
  }

  const razorpayOrder = await razorpayRes.json();
  await sb.from("orders").update({ razorpay_order_id: razorpayOrder.id }).eq("id", order.id);

  return jsonResponse({
    order_id: order.id,
    razorpay_order_id: razorpayOrder.id,
    amount: amountPaise,
    currency: "INR",
    key_id: keyId,
    subtotal,
    discount_amount: discountAmount,
    delivery_fee: deliveryFee,
    total,
  });
});
