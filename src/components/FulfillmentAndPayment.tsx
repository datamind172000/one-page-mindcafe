"use client";

import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useAuthModal } from "@/contexts/AuthModalContext";
import { useCartContext } from "@/contexts/CartContext";
import { createClient } from "@/lib/supabase/client";
import {
  checkPincodeServiceability,
  checkout,
  getActivePickupLocations,
  validateCoupon,
  type CouponPreview,
  type PincodeServiceability,
} from "@/lib/api";
import { openRazorpayCheckout } from "@/lib/razorpay";
import { readFirstTouch } from "@/lib/firstTouch";
import { useAddresses } from "@/lib/query/hooks";
import { AddressForm, type AddressFormValues } from "@/components/AddressForm";
import { formatInr } from "@/lib/utils";
import { AUTO_DISCOUNT_MIN_SUBTOTAL, autoDiscountFor, discountableSubtotal, isBundleLine } from "@/lib/pricing";
import type { PickupLocation } from "@/types/domain";

type Mode = "delivery" | "takeaway";

// The automatic discount — 10% off the non-bundle items once they alone
// reach ₹300, no code needed — is computed and charged server-side by
// create-order; this component only previews it via lib/pricing.ts, which
// mirrors that rule. The Feelz Bundle is a fixed-price product it never
// touches. A customer's own coupon can still be applied; create-order then
// uses whichever of the two is larger, never both, and so does the preview.

// Signed-out checkout details, kept across sign-in. The email/phone code
// signs in without leaving the page, but Google navigates away and back,
// so the details are parked in sessionStorage when "Pay Now" asks for
// sign-in and restored when the page loads again.
const DRAFT_KEY = "checkoutDraft";
const DRAFT_MAX_AGE_MS = 15 * 60 * 1000;

type CheckoutDraft = {
  mode: Mode;
  guestAddress: AddressFormValues | null;
  locationId: string | null;
  pickupSlot: string;
  couponCode: string | null;
  at: number;
};

function readDraft(): CheckoutDraft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as CheckoutDraft;
    return Date.now() - draft.at < DRAFT_MAX_AGE_MS ? draft : null;
  } catch {
    return null;
  }
}

function clearDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // storage blocked — nothing was saved to clear
  }
}

// Delivery or takeaway pickup at a listed Zostel — payment is Razorpay
// only in both cases (pay-online, no cash-on-pickup). Guests fill in the
// whole form signed out; "Pay Now" is where sign-in is asked for (the
// AuthModal, which returns to this page), and payment then continues on
// its own with the details they already entered. A guest's address lives
// only in this component until then, and is saved to their account just
// before the order is placed. The actual order — real prices, coupon,
// stock, Razorpay order — is all created server-side by the create-order
// Edge Function (lib/api.ts `checkout`), never trusting anything computed
// here.
export function FulfillmentAndPayment({ onOrderPlaced }: { onOrderPlaced: (orderId: string) => void }) {
  const { user, profile, status: authStatus } = useAuth();
  const { openAuthModal, isAuthModalOpen } = useAuthModal();
  const { cartId, cartUserId, items, subtotal, clearCart, isLoading: isCartLoading } = useCartContext();
  const { addresses, addAddress } = useAddresses(user?.id ?? null);

  // The address a signed-out customer entered, not yet saved anywhere.
  const [guestAddress, setGuestAddress] = useState<AddressFormValues | null>(null);
  // Set when "Pay Now" opened sign-in; payment resumes once signed in.
  const [payAfterSignIn, setPayAfterSignIn] = useState(false);

  const [mode, setMode] = useState<Mode>("delivery");
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [showNewAddressForm, setShowNewAddressForm] = useState(false);
  const [serviceability, setServiceability] = useState<PincodeServiceability | "unchecked" | "checking" | "error">(
    "unchecked",
  );
  const [serviceabilityError, setServiceabilityError] = useState<string | null>(null);

  const [locations, setLocations] = useState<PickupLocation[]>([]);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [pickupSlot, setPickupSlot] = useState("");
  const [locationSearch, setLocationSearch] = useState("");
  // Same collapse-once-picked pattern as BookAppointmentContent.tsx's
  // expert picker — a long flat list of Zostels doesn't need to stay open
  // once one's chosen, and search only makes sense while still choosing.
  const [showAllLocations, setShowAllLocations] = useState(true);

  const [manualCouponCode, setManualCouponCode] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState<CouponPreview | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [isCheckingCoupon, setIsCheckingCoupon] = useState(false);
  const hasManualCoupon = appliedCoupon !== null;
  const hasBundle = items.some(isBundleLine);
  const singlesSubtotal = discountableSubtotal(items);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "takeaway" || locations.length > 0) return;
    const sb = createClient();
    getActivePickupLocations(sb)
      .then(setLocations)
      .catch(() => setLocations([]));
  }, [mode, locations.length]);

  // Back from a Google sign-in started at "Pay Now": put the details back
  // and carry on to payment. Runs once, after the cart has loaded, since
  // the pincode check and coupon are both priced off the cart's items.
  const draftRestored = useRef(false);
  useEffect(() => {
    if (draftRestored.current || isCartLoading || items.length === 0) return;
    draftRestored.current = true;
    const draft = readDraft();
    clearDraft();
    if (!draft) return;
    setMode(draft.mode);
    setGuestAddress(draft.guestAddress);
    setLocationId(draft.locationId);
    if (draft.locationId) setShowAllLocations(false);
    setPickupSlot(draft.pickupSlot);
    if (draft.mode === "delivery" && draft.guestAddress) void handleCheckServiceability(draft.guestAddress.pincode);
    if (draft.couponCode) {
      setManualCouponCode(draft.couponCode);
      void applyCoupon(draft.couponCode);
    }
    setPayAfterSignIn(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCartLoading, items.length]);

  async function handleCheckServiceability(pincode: string) {
    setServiceability("checking");
    setServiceabilityError(null);
    const sb = createClient();
    const cartItems = items.map((i) => ({ variant_id: i.variant_id, quantity: i.quantity }));
    try {
      const result = await checkPincodeServiceability(sb, pincode, cartItems);
      setServiceability(result);
    } catch (err) {
      // A failed check (network issue, Shiprocket auth/config problem) is
      // NOT the same as Shiprocket genuinely not covering this pincode —
      // collapsing both into "not serviceable" hides real integration
      // breakage behind what looks like a normal coverage gap.
      setServiceability("error");
      setServiceabilityError(err instanceof Error ? err.message : "Couldn't check delivery availability");
    }
  }

  async function handleAddAddress(values: AddressFormValues) {
    if (!user) {
      setGuestAddress(values);
      setShowNewAddressForm(false);
      await handleCheckServiceability(values.pincode);
      return;
    }
    const created = await addAddress.mutateAsync({ ...values, user_id: user.id });
    setSelectedAddressId(created.id);
    setShowNewAddressForm(false);
    await handleCheckServiceability(values.pincode);
  }

  const deliveryFee =
    mode === "delivery" &&
    serviceability !== "unchecked" &&
    serviceability !== "checking" &&
    serviceability !== "error" &&
    serviceability.serviceable
      ? serviceability.deliveryFee
      : 0;
  // appliedCoupon is the single source of truth for the COUPON discount;
  // the automatic 10% is entirely separate (no code, just cart contents).
  const couponDiscountAmount = appliedCoupon?.discountAmount ?? 0;
  const quantityDiscountAmount = autoDiscountFor(items);
  const quantityDiscountWins = quantityDiscountAmount > couponDiscountAmount;
  const discountAmount = Math.max(couponDiscountAmount, quantityDiscountAmount);
  // Delivery is free for every customer right now — create-order applies
  // this server-side too (the FREESHIP coupon, looked up automatically,
  // no code entry from the customer), so the total shown here has to
  // exclude it the same way or this estimate would be wrong.
  const total = Math.max(0, subtotal - discountAmount);

  async function applyCoupon(code: string): Promise<boolean> {
    setIsCheckingCoupon(true);
    setCouponError(null);
    try {
      const sb = createClient();
      const result = await validateCoupon(sb, code, subtotal, singlesSubtotal);
      setAppliedCoupon(result);
      return true;
    } catch (err) {
      setCouponError(err instanceof Error ? err.message : "Couldn't apply coupon");
      return false;
    } finally {
      setIsCheckingCoupon(false);
    }
  }

  async function handleApplyManualCoupon() {
    if (!manualCouponCode.trim()) return;
    await applyCoupon(manualCouponCode);
  }

  function handleRemoveManualCoupon() {
    setManualCouponCode("");
    setCouponError(null);
    if (hasManualCoupon) setAppliedCoupon(null);
  }

  const serviceabilityOk =
    serviceability !== "unchecked" &&
    serviceability !== "checking" &&
    serviceability !== "error" &&
    serviceability.serviceable;
  const hasDeliveryTarget = Boolean(selectedAddressId) || Boolean(guestAddress);

  const canPay =
    items.length > 0 && (mode === "delivery" ? hasDeliveryTarget && serviceabilityOk : Boolean(locationId));

  function handlePayNow() {
    if (!canPay) return;
    if (user) {
      void handlePlaceOrder();
      return;
    }
    try {
      const draft: CheckoutDraft = {
        mode,
        guestAddress,
        locationId,
        pickupSlot,
        couponCode: appliedCoupon?.code ?? null,
        at: Date.now(),
      };
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // storage blocked — the in-page sign-in still works without it
    }
    setPayAfterSignIn(true);
    openAuthModal();
  }

  // Closing the sign-in popup without signing in drops the pending
  // payment, so signing in later from the header doesn't suddenly open it.
  // (A successful code sign-in flips to "authenticated" before the popup
  // closes, and Google leaves the page with the popup still open.)
  useEffect(() => {
    if (payAfterSignIn && authStatus === "unauthenticated" && !isAuthModalOpen) {
      setPayAfterSignIn(false);
      clearDraft();
    }
  }, [payAfterSignIn, authStatus, isAuthModalOpen]);

  // Signed in after "Pay Now": wait until the cart is the account cart
  // (CartProvider merges the guest cart in first) and any restored
  // details have settled, then pay.
  useEffect(() => {
    if (!payAfterSignIn || !user || cartUserId !== user.id || isCartLoading || isSubmitting) return;
    const settling =
      isCheckingCoupon ||
      serviceability === "checking" ||
      (mode === "delivery" && guestAddress !== null && serviceability === "unchecked") ||
      (mode === "takeaway" && locations.length === 0);
    if (settling) return;
    setPayAfterSignIn(false);
    clearDraft();
    // Not payable after all (e.g. pincode turned out unserviceable): the
    // form shows why, and the customer takes it from there.
    if (canPay) void handlePlaceOrder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payAfterSignIn, user, cartUserId, isCartLoading, isCheckingCoupon, canPay, serviceability, guestAddress, locations.length]);

  async function handlePlaceOrder() {
    if (!cartId || !canPay || !user) return;
    setIsSubmitting(true);
    setError(null);

    const sb = createClient();

    try {
      // A guest's address is saved to their account only now, at payment.
      let addressId = selectedAddressId;
      if (mode === "delivery" && guestAddress) {
        const created = await addAddress.mutateAsync({ ...guestAddress, user_id: user.id });
        addressId = created.id;
        setSelectedAddressId(created.id);
        setGuestAddress(null);
      }

      const result = await checkout(sb, {
        cartId,
        items: items.map((item) => ({ variantId: item.variant_id, quantity: item.quantity })),
        fulfillment:
          mode === "delivery"
            ? { type: "delivery", addressId: addressId! }
            : { type: "takeaway", locationId: locationId!, pickupSlot: pickupSlot || undefined },
        couponCode: appliedCoupon?.code,
        attribution: readFirstTouch(),
      });

      // Use the authoritative, discount-adjusted amount returned by the server.
      // Fire at checkout initiation, not on every render of the cart page.
      if (!result.free && window.fbq && !window.location.search && Number.isFinite(result.total)) {
        window.fbq("trackSingle", "1667702978300497", "InitiateCheckout", {
          content_ids: items.map((item) => item.product_variants.products.id),
          value: Math.round(result.total * 100) / 100,
          num_items: items.reduce((sum, item) => sum + item.quantity, 0),
          currency: "INR",
        });
      }

      if (result.free) {
        clearCart();
        onOrderPlaced(result.order_id);
        return;
      }

      await openRazorpayCheckout({
        keyId: result.key_id,
        amount: result.amount,
        currency: result.currency,
        razorpayOrderId: result.razorpay_order_id,
        name: "mindcafe",
        prefill: {
          name: profile?.full_name ?? undefined,
          email: user?.email ?? undefined,
          contact: profile?.phone ?? user?.phone ?? undefined,
        },
        onSuccess: () => {
          clearCart();
          onOrderPlaced(result.order_id);
        },
        onDismiss: () => {
          setError("Payment was cancelled. Your order is saved as pending.");
          setIsSubmitting(false);
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong placing your order.");
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode("delivery")}
          className={`flex-1 rounded-full border px-4 py-2 text-sm font-medium ${mode === "delivery" ? "border-feelz-ink bg-feelz-ink text-feelz-cream" : "border-feelz-ink/20 text-feelz-ink/70"}`}
        >
          DIRECT DELIVERY
        </button>
        <button
          type="button"
          onClick={() => setMode("takeaway")}
          className={`flex-1 rounded-full border px-4 py-2 text-sm font-medium ${mode === "takeaway" ? "border-feelz-ink bg-feelz-ink text-feelz-cream" : "border-feelz-ink/20 text-feelz-ink/70"}`}
        >
          TAKEAWAY FROM A ZOSTEL
        </button>
      </div>

      {user && (user.phone || profile?.phone) && (
        <p className="text-sm text-feelz-ink/60">
          We&apos;ll reach you about this order at{" "}
          <span className="font-medium text-feelz-ink">{user.phone ? `+${user.phone}` : profile?.phone}</span>.
        </p>
      )}

      {mode === "delivery" ? (
        <div className="space-y-4">
          {guestAddress && !showNewAddressForm && (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-feelz-ink bg-feelz-paper p-3 text-sm">
              <span>
                <span className="block font-medium text-feelz-ink">{guestAddress.full_name}</span>
                <span className="block text-feelz-ink/60">
                  {guestAddress.line1}, {guestAddress.city}, {guestAddress.state} {guestAddress.pincode}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setShowNewAddressForm(true)}
                className="shrink-0 text-xs font-medium text-feelz-ink underline"
              >
                Change
              </button>
            </div>
          )}

          {!guestAddress && addresses.length > 0 && !showNewAddressForm && (
            <div className="space-y-2">
              {addresses.map((address) => (
                <label
                  key={address.id}
                  className="flex items-start gap-3 rounded-xl border border-feelz-ink/15 bg-feelz-paper p-3 text-sm has-[:checked]:border-feelz-ink"
                >
                  <input
                    type="radio"
                    name="address"
                    checked={selectedAddressId === address.id}
                    onChange={() => {
                      setSelectedAddressId(address.id);
                      void handleCheckServiceability(address.pincode);
                    }}
                    className="mt-1"
                  />
                  <span>
                    <span className="block font-medium text-feelz-ink">{address.full_name}</span>
                    <span className="block text-feelz-ink/60">
                      {address.line1}, {address.city}, {address.state} {address.pincode}
                    </span>
                  </span>
                </label>
              ))}
              <button
                type="button"
                onClick={() => setShowNewAddressForm(true)}
                className="text-sm font-medium text-feelz-ink underline"
              >
                + Use a New Address
              </button>
            </div>
          )}

          {((!guestAddress && addresses.length === 0) || showNewAddressForm) && (
            <AddressForm
              onSubmit={handleAddAddress}
              isSubmitting={addAddress.isPending}
              defaultValues={guestAddress ?? undefined}
            />
          )}

          {serviceability === "checking" && <p className="text-sm text-feelz-ink/60">Checking serviceability…</p>}
          {serviceability === "error" && (
            <p className="text-sm text-red-700">
              {serviceabilityError ?? "Couldn't check delivery availability"}. Please try again.
            </p>
          )}
          {serviceability !== "unchecked" &&
            serviceability !== "checking" &&
            serviceability !== "error" &&
            !serviceability.serviceable && (
              <p className="text-sm text-amber-700">This pincode isn&apos;t serviceable yet. Try takeaway instead.</p>
            )}
          {serviceability !== "unchecked" &&
            serviceability !== "checking" &&
            serviceability !== "error" &&
            serviceability.serviceable && (
              <p className="text-sm text-emerald-700">
                Deliverable:{" "}
                {serviceability.deliveryFee === 0 ? (
                  "free"
                ) : (
                  <>
                    <span className="text-feelz-ink/40 line-through">{formatInr(serviceability.deliveryFee)}</span>{" "}
                    <span className="font-semibold">FREE</span>
                  </>
                )}
              </p>
            )}
        </div>
      ) : (
        <div className="space-y-4">
          {(() => {
            const selectedLocation = locations.find((l) => l.id === locationId);
            const term = locationSearch.trim().toLowerCase();
            const filteredLocations = term
              ? locations.filter(
                  (l) => l.name.toLowerCase().includes(term) || l.city.toLowerCase().includes(term),
                )
              : locations;

            if (locations.length === 0) {
              return <p className="text-sm text-feelz-ink/60">Loading Zostel pickup points…</p>;
            }

            if (selectedLocation && !showAllLocations) {
              return (
                <div className="flex items-start justify-between gap-3 rounded-xl border border-feelz-ink bg-feelz-paper p-3 text-sm">
                  <span>
                    <span className="block font-medium text-feelz-ink">{selectedLocation.name}</span>
                    <span className="block text-feelz-ink/60">
                      {selectedLocation.address}, {selectedLocation.city}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowAllLocations(true)}
                    className="shrink-0 text-xs font-medium text-feelz-ink underline"
                  >
                    Change
                  </button>
                </div>
              );
            }

            return (
              <div className="space-y-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-feelz-ink/40" aria-hidden />
                  <input
                    type="text"
                    value={locationSearch}
                    onChange={(event) => setLocationSearch(event.target.value)}
                    placeholder="Search by Zostel name or city"
                    className="input w-full !pl-10"
                  />
                </div>
                <div className="max-h-72 space-y-2 overflow-y-auto">
                  {filteredLocations.length === 0 ? (
                    <p className="text-sm text-feelz-ink/60">No Zostel matches &ldquo;{locationSearch}&rdquo;.</p>
                  ) : (
                    filteredLocations.map((location) => (
                      <label
                        key={location.id}
                        className="flex items-start gap-3 rounded-xl border border-feelz-ink/15 bg-feelz-paper p-3 text-sm has-[:checked]:border-feelz-ink"
                      >
                        <input
                          type="radio"
                          name="pickup-location"
                          checked={locationId === location.id}
                          onChange={() => {
                            setLocationId(location.id);
                            setShowAllLocations(false);
                          }}
                          className="mt-1"
                        />
                        <span>
                          <span className="block font-medium text-feelz-ink">{location.name}</span>
                          <span className="block text-feelz-ink/60">
                            {location.address}, {location.city}
                          </span>
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            );
          })()}

          <div>
            <label className="mb-1 block text-sm text-feelz-ink/70">Pickup slot (optional)</label>
            <input
              value={pickupSlot}
              onChange={(event) => setPickupSlot(event.target.value)}
              placeholder="e.g. Ready in 2 hours"
              className="input"
            />
          </div>
        </div>
      )}

      <div className="space-y-3">
        <p className="rounded-xl border border-feelz-ink/15 bg-feelz-cream p-3 text-sm">
          {quantityDiscountAmount > 0 ? (
            <>
              10% off{hasBundle ? " your non-bundle items" : ""} is applied automatically
              {hasBundle ? ". The Feelz Bundle is already at its bundle price." : "."}
            </>
          ) : singlesSubtotal > 0 ? (
            <span className="text-feelz-ink/60">
              Add {formatInr(AUTO_DISCOUNT_MIN_SUBTOTAL - singlesSubtotal)} more{hasBundle ? " (besides the bundle)" : ""} to get 10% off
              automatically.
            </span>
          ) : (
            <span className="text-feelz-ink/60">The Feelz Bundle is already at its bundle price.</span>
          )}
        </p>

        <div>
          <label className="mb-1 block text-sm text-feelz-ink/70">Have a coupon code? (optional)</label>
          <div className="flex gap-2">
            <input
              value={manualCouponCode}
              onChange={(event) => {
                setManualCouponCode(event.target.value);
                setCouponError(null);
              }}
              onKeyDown={(event) => event.key === "Enter" && (event.preventDefault(), handleApplyManualCoupon())}
              placeholder="Enter coupon code"
              className="input uppercase"
            />
            {hasManualCoupon ? (
              <button
                type="button"
                onClick={handleRemoveManualCoupon}
                className="pill-btn-outline shrink-0 !py-2 text-xs normal-case tracking-normal"
              >
                Remove
              </button>
            ) : (
              <button
                type="button"
                onClick={handleApplyManualCoupon}
                disabled={!manualCouponCode.trim() || isCheckingCoupon}
                className="pill-btn-outline shrink-0 !py-2 text-xs normal-case tracking-normal"
              >
                {isCheckingCoupon ? "Checking…" : "Apply"}
              </button>
            )}
          </div>
          {couponError && <p className="mt-1.5 text-sm text-red-600">{couponError}</p>}
        </div>

        {discountAmount > 0 && (
          <p className="text-sm text-emerald-700">
            {quantityDiscountWins
              ? `10% off applied automatically, ${formatInr(discountAmount)} off`
              : `"${appliedCoupon!.code}" applied, ${formatInr(discountAmount)} off`}
          </p>
        )}
      </div>

      <div className="rounded-xl border border-feelz-ink/15 bg-feelz-paper p-4 text-sm">
        <div className="flex justify-between">
          <span>Subtotal</span>
          <span>{formatInr(subtotal)}</span>
        </div>
        {discountAmount > 0 && (
          <div className="flex justify-between text-emerald-700">
            <span>{quantityDiscountWins ? "10% off" : `Coupon (${appliedCoupon!.code})`}</span>
            <span>−{formatInr(discountAmount)}</span>
          </div>
        )}
        <div className="flex justify-between">
          <span>{mode === "delivery" ? "Delivery fee" : "Pickup"}</span>
          {mode === "delivery" && deliveryFee > 0 ? (
            <span>
              <span className="text-feelz-ink/40 line-through">{formatInr(deliveryFee)}</span>{" "}
              <span className="font-semibold text-emerald-700">FREE</span>
            </span>
          ) : (
            <span>Free</span>
          )}
        </div>
        <div className="mt-2 flex justify-between border-t border-feelz-ink/10 pt-2 font-medium">
          <span>Total</span>
          <span>{formatInr(total)}</span>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button type="button" onClick={handlePayNow} disabled={!canPay || isSubmitting} className="pill-btn w-full">
        {isSubmitting ? "Processing…" : "Pay Now"}
      </button>
      {!user && (
        <p className="-mt-3 text-center text-xs text-feelz-ink/50">
          You&apos;ll sign in with your phone, email or Google before paying. Your details stay as they are.
        </p>
      )}
    </div>
  );
}
