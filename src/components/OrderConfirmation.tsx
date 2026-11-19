"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { useQuery } from "@tanstack/react-query";
import { useOrderTracking } from "@/lib/query/hooks";
import { createClient } from "@/lib/supabase/client";
import { getOrderStatusEvents } from "@/lib/api";
import { formatInr } from "@/lib/utils";
import { OrderTrackingTimeline } from "@/components/OrderTrackingTimeline";

export const STATUS_LABELS: Record<string, string> = {
  placed: "Placed",
  confirmed: "Confirmed",
  packed: "Packed",
  ready_for_pickup: "Ready for pickup",
  picked_up: "Picked up",
  shipped: "Shipped",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

// Shown in place of the checkout panel once payment is accepted. Polls +
// subscribes to Realtime so it flips from "pending" once the
// payment-webhook confirms, and picks up Shiprocket tracking once it's
// created — no navigation away from the one page.
export function OrderConfirmation({
  orderId,
  onStartNewOrder,
  backLabel = "Place Another Order",
  showEmailNote = true,
}: {
  orderId: string;
  onStartNewOrder: () => void;
  backLabel?: string;
  // Display-only suppression of the "Also sent to you by email." line. The
  // scan-and-order flow turns it off: the guest is standing at the front
  // desk with the QR already on screen, so pointing at an inbox is noise
  // there even for a signed-in user who does have an email on file. Does
  // not affect whether the confirmation email is actually sent.
  showEmailNote?: boolean;
}) {
  const { data: order, isLoading } = useOrderTracking(orderId);
  const purchaseAttempted = useRef(false);

  useEffect(() => {
    if (purchaseAttempted.current || !order || order.payment_status !== "paid" || !window.fbq) return;
    purchaseAttempted.current = true;
    // Atomically claim a verified order once, across refreshes and devices.
    void (async () => {
      const sb = createClient();
      const { data, error } = await sb.rpc("claim_meta_purchase", { p_order_id: orderId });
      if (error || !Array.isArray(data) || data.length !== 1) return;
      const event = data[0] as { event_id: string; value: number; content_ids: string[] };
      if (!Number.isFinite(Number(event.value))) return;
      // Do not leak the order identifier in the Meta document URL.
      // The confirmation stays visible; reloading returns to checkout.
      window.history.replaceState(window.history.state, "", "/checkout");
      window.fbq?.("trackSingle", "1667702978300497", "Purchase", {
        value: Number(event.value), currency: "INR", content_ids: event.content_ids,
      }, { eventID: event.event_id });
    })();
  }, [order, orderId]);
  // Timestamps for the timeline. Refetches alongside the order; if the
  // history table isn't there yet the timeline still renders from status.
  const eventsQuery = useQuery({
    queryKey: ["order-status-events", orderId, order?.status],
    queryFn: () => getOrderStatusEvents(createClient(), orderId),
    enabled: Boolean(order),
    retry: false,
  });
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!order?.pickup_code) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(order.pickup_code, { margin: 1, width: 220 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [order?.pickup_code]);

  if (isLoading) return <p className="text-sm text-ink/60">Loading order…</p>;
  if (!order) return <p className="text-sm text-ink/60">Order not found.</p>;

  const isPendingConfirmation = order.payment_status === "pending";
  const isPickup = order.fulfillment_type === "takeaway";
  const isCollected = order.status === "picked_up";
  // Only true when there's actually somewhere to send it — a signed-in
  // user always has their account email, but a scan-and-order guest
  // checkout never collects one (phone only), so this line would be a
  // false promise there.
  const hasEmailOnFile = Boolean(order.user_id) || Boolean(order.guest_email);

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h2 className="font-display text-4xl font-bold">Order {order.order_number}</h2>

      {isPendingConfirmation && (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-700">
          Confirming your payment. This updates automatically, no need to refresh.
        </p>
      )}

      {isPickup && order.pickup_code && (
        <div className="rounded-xl border border-ink/15 bg-white p-5 text-center">
          {isCollected ? (
            <p className="text-sm font-medium text-emerald-700">Collected. Thanks!</p>
          ) : (
            <>
              <p className="text-sm text-ink/60">Show this at the Zostel front desk to collect your order</p>
              {qrDataUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrDataUrl} alt={`QR code for pickup code ${order.pickup_code}`} className="mx-auto mt-3 h-44 w-44" />
              )}
              <p className="font-display mt-3 text-3xl font-bold tracking-[0.3em]">{order.pickup_code}</p>
              {qrDataUrl && (
                <a
                  href={qrDataUrl}
                  download={`mindcafe-pickup-${order.pickup_code}.png`}
                  className="pill-btn mt-3 inline-flex"
                >
                  Download QR
                </a>
              )}
              {showEmailNote && hasEmailOnFile && (
                <p className="mt-2 text-xs text-ink/50">Also sent to you by email.</p>
              )}
            </>
          )}
        </div>
      )}

      <div className="rounded-xl border border-ink/15 bg-white p-4">
        <p className="mb-4 text-[10px] font-bold uppercase tracking-[0.12em] text-brand">Order tracking</p>
        <OrderTrackingTimeline
          fulfillmentType={order.fulfillment_type}
          status={order.status}
          paymentStatus={order.payment_status}
          events={eventsQuery.data ?? []}
          awbCode={order.awb_code}
          trackingUrl={order.tracking_url}
          estimatedDelivery={order.estimated_delivery}
        />
      </div>

      <div className="rounded-xl border border-ink/15 bg-white p-4 text-sm">
        <div className="flex justify-between">
          <span>Status</span>
          <span className="font-medium capitalize">{STATUS_LABELS[order.status] ?? order.status}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="shrink-0">Fulfillment</span>
          <span className="text-right capitalize">
            {order.fulfillment_type === "takeaway" ? `Takeaway (${order.pickup_locations?.name ?? "Zostel"})` : "Delivery"}
          </span>
        </div>
        <div className="flex justify-between">
          <span>Payment</span>
          <span className="capitalize">{order.payment_status}</span>
        </div>
        <div className="mt-2 flex justify-between border-t border-ink/10 pt-2 font-medium">
          <span>Total</span>
          <span>{formatInr(order.total)}</span>
        </div>
      </div>

      <button type="button" onClick={onStartNewOrder} className="pill-btn-outline w-full">
        {backLabel}
      </button>
    </div>
  );
}
