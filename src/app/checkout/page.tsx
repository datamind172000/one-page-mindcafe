"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { Trash2 } from "lucide-react";
import { useCartContext } from "@/contexts/CartContext";
import { FulfillmentAndPayment } from "@/components/FulfillmentAndPayment";
import { OrderConfirmation } from "@/components/OrderConfirmation";
import { formatInr } from "@/lib/utils";
import { moodStyleFor } from "@/lib/moodStyles";

// Real checkout route — cart summary + fulfillment/payment, or (once
// ?order= is set after a successful payment) the tracking/confirmation
// view. Both used to live inside the CartDrawer modal; this is a direct
// relocation, not a redesign. Guests reach this page signed out, on a
// guest cart; FulfillmentAndPayment.tsx asks them to sign in only once
// they press "Pay Now", keeping the details they've already entered.
function CheckoutContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const orderId = searchParams.get("order");
  const { items, isLoading, updateQuantity, removeItem } = useCartContext();

  useEffect(() => {
    if (orderId || isLoading || items.length > 0) return;
    router.replace("/feelz");
  }, [orderId, isLoading, items.length, router]);

  return (
    <div className="bg-feelz-cream">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      {orderId ? (
        <OrderConfirmation orderId={orderId} onStartNewOrder={() => router.push("/feelz")} />
      ) : isLoading ? (
        <p className="text-sm text-feelz-ink/60">Loading cart…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-feelz-ink/60">Your cart is empty. Redirecting…</p>
      ) : (
        <div>
          <h1 className="font-display text-4xl font-bold text-feelz-ink">Checkout</h1>

          {/* Items (image + details) on the left, fulfillment/payment on
              the right, side by side from lg up — a plain stacked single
              column below that, since there's no room for two columns on
              a phone-width screen. The right column carries its own
              subtotal/discount/total (FulfillmentAndPayment's own summary
              card), so this page doesn't duplicate a second, simpler
              total above it that could drift out of sync with discounts. */}
          <div className="mt-8 lg:grid lg:grid-cols-[1fr_26rem] lg:items-start lg:gap-10">
            <ul className="space-y-3">
              {items.map((item) => {
                const price = item.product_variants.price_override ?? item.product_variants.products.price;
                return (
                  <li key={item.id} className="flex gap-4 rounded-2xl border border-feelz-ink/10 bg-feelz-paper p-4">
                    <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-white sm:h-24 sm:w-24">
                      <Image
                        src={moodStyleFor(item.product_variants.products.name).catalogueSrc}
                        alt={item.product_variants.products.name}
                        fill
                        sizes="96px"
                        className="object-cover"
                      />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col justify-between">
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-display text-base font-bold text-feelz-ink">{item.product_variants.products.name}</span>
                        <button
                          type="button"
                          onClick={() => removeItem.mutate(item.id)}
                          aria-label={`Remove ${item.product_variants.products.name}`}
                          className="shrink-0 text-red-600 hover:text-red-700"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </button>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <div className="flex items-center rounded-full border border-feelz-ink/15 bg-feelz-cream">
                          <button
                            type="button"
                            onClick={() =>
                              item.quantity <= 1
                                ? removeItem.mutate(item.id)
                                : updateQuantity.mutate({ cartItemId: item.id, quantity: item.quantity - 1 })
                            }
                            className="px-3 py-1.5 text-sm font-bold text-feelz-ink"
                            aria-label={`Decrease ${item.product_variants.products.name} quantity`}
                          >
                            −
                          </button>
                          <span className="min-w-[1.5rem] text-center text-sm font-semibold text-feelz-ink">
                            {item.quantity}
                          </span>
                          <button
                            type="button"
                            onClick={() => updateQuantity.mutate({ cartItemId: item.id, quantity: item.quantity + 1 })}
                            className="px-3 py-1.5 text-sm font-bold text-feelz-ink"
                            aria-label={`Increase ${item.product_variants.products.name} quantity`}
                          >
                            +
                          </button>
                        </div>
                        <span className="font-semibold text-feelz-ink">{formatInr(price * item.quantity)}</span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="mt-8 lg:mt-0">
              <FulfillmentAndPayment onOrderPlaced={(id) => router.push(`/checkout?order=${id}`)} />
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense
      fallback={
        <div className="bg-white">
          <div className="mx-auto max-w-lg px-4 py-12 sm:px-6 text-sm text-ink/60">Loading…</div>
        </div>
      }
    >
      <CheckoutContent />
    </Suspense>
  );
}
