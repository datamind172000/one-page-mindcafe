"use client";

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { recordStorefrontCart } from "@/lib/storefrontCampaign";
import { createClient } from "@/lib/supabase/client";
import {
  addCartItem,
  bookAppointment,
  createAddress,
  deleteAddress,
  getAppointment,
  getCartItems,
  getOrder,
  getUserAddresses,
  getUserAppointments,
  getUserOrders,
  removeCartItem,
  updateAddress,
  updateCartItemQuantity,
} from "@/lib/api";
import type { Database } from "@/types/supabase";
import type { CartItemWithVariant, Product, ProductVariant } from "@/types/domain";

export const queryKeys = {
  cart: (cartId: string | null) => ["cart", cartId] as const,
  feelzCatalog: () => ["products", "feelz-catalog"] as const,
  order: (orderId: string) => ["orders", orderId] as const,
  userOrders: (userId: string) => ["orders", "user", userId] as const,
  addresses: (userId: string) => ["addresses", userId] as const,
  appointment: (appointmentId: string) => ["appointments", appointmentId] as const,
  userAppointments: (userId: string) => ["appointments", "user", userId] as const,
};

// Cart *identity* (which cart) lives in CartContext; this hook owns the
// line-item data so it stays reactive and cache-invalidatable.
//
// All three mutations below update the cache optimistically in onMutate
// (so a +/-/remove/add click reflects instantly, not after a network round
// trip), roll back on error, and reconcile with the server in the
// background via onSettled. Without this, every click was: request ->
// wait -> mutation resolves -> invalidate -> second request -> wait ->
// THEN the UI updates — two full network round trips of visible lag per
// click, which is what made add/remove/qty edits feel slow.
export function useCart(cartId: string | null) {
  const queryClient = useQueryClient();
  const sb = createClient();
  const queryKey = queryKeys.cart(cartId);

  const itemsQuery = useQuery({
    queryKey,
    queryFn: () => getCartItems(sb, cartId!),
    enabled: Boolean(cartId),
  });

  async function optimisticUpdate(updater: (items: CartItemWithVariant[]) => CartItemWithVariant[]) {
    await queryClient.cancelQueries({ queryKey });
    const previous = queryClient.getQueryData<CartItemWithVariant[]>(queryKey);
    queryClient.setQueryData<CartItemWithVariant[]>(queryKey, (old) => updater(old ?? []));
    return { previous };
  }

  function rollback(context: { previous?: CartItemWithVariant[] } | undefined) {
    if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
  }

  const settle = () => queryClient.invalidateQueries({ queryKey });

  const addItem = useMutation({
    mutationFn: (args: {
      variant: ProductVariant;
      product: Pick<Product, "id" | "name" | "image_url" | "price"> & { is_bundle?: boolean };
      quantity: number;
    }) =>
      addCartItem(sb, cartId!, args.variant.id, args.quantity),
    onMutate: (args) =>
      optimisticUpdate((items) => {
        const existing = items.find((item) => item.variant_id === args.variant.id);
        if (existing) {
          return items.map((item) =>
            item.id === existing.id ? { ...item, quantity: item.quantity + args.quantity } : item,
          );
        }
        const optimisticItem: CartItemWithVariant = {
          id: `optimistic-${args.variant.id}`,
          cart_id: cartId!,
          variant_id: args.variant.id,
          quantity: args.quantity,
          created_at: new Date().toISOString(),
          product_variants: { ...args.variant, products: args.product },
        };
        return [...items, optimisticItem];
      }),
    onSuccess: () => { if (cartId) void recordStorefrontCart(cartId, false); },
    onError: (_err, _args, context) => rollback(context),
    onSettled: settle,
  });

  const updateQuantity = useMutation({
    mutationFn: (args: { cartItemId: string; quantity: number }) =>
      updateCartItemQuantity(sb, args.cartItemId, args.quantity),
    onMutate: (args) =>
      optimisticUpdate((items) =>
        items.map((item) => (item.id === args.cartItemId ? { ...item, quantity: args.quantity } : item)),
      ),
    onError: (_err, _args, context) => rollback(context),
    onSettled: settle,
  });

  const removeItem = useMutation({
    mutationFn: (cartItemId: string) => removeCartItem(sb, cartItemId),
    onMutate: (cartItemId) => optimisticUpdate((items) => items.filter((item) => item.id !== cartItemId)),
    onError: (_err, _cartItemId, context) => rollback(context),
    onSettled: settle,
  });

  const items = itemsQuery.data ?? [];
  const subtotal = items.reduce((sum, item) => {
    const price = item.product_variants.price_override ?? item.product_variants.products.price;
    return sum + price * item.quantity;
  }, 0);
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

  // create-order deletes every cart_items row for this cart server-side
  // once an order is placed, but nothing about that cart's *id* changes —
  // it's the same row, just emptied, so this query's cache is never
  // invalidated by anything else and was showing the pre-order items
  // indefinitely. Call this right after a successful order; setting
  // directly (not invalidating) is correct here since the emptied state
  // is already a known fact, not something that needs a round trip to confirm.
  function clearCart() {
    queryClient.setQueryData<CartItemWithVariant[]>(queryKey, []);
  }

  return { items, subtotal, itemCount, isLoading: itemsQuery.isLoading, addItem, updateQuantity, removeItem, clearCart };
}

export function useAddresses(userId: string | null) {
  const queryClient = useQueryClient();
  const sb = createClient();
  const queryKey = queryKeys.addresses(userId ?? "");

  const addressesQuery = useQuery({
    queryKey,
    queryFn: () => getUserAddresses(sb, userId!),
    enabled: Boolean(userId),
  });

  const addAddress = useMutation({
    mutationFn: (input: Database["public"]["Tables"]["addresses"]["Insert"]) => createAddress(sb, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const editAddress = useMutation({
    mutationFn: (args: { addressId: string; input: Database["public"]["Tables"]["addresses"]["Update"] }) =>
      updateAddress(sb, args.addressId, args.input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const removeAddress = useMutation({
    mutationFn: (addressId: string) => deleteAddress(sb, addressId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  return { addresses: addressesQuery.data ?? [], isLoading: addressesQuery.isLoading, addAddress, editAddress, removeAddress };
}

// "Your orders" list — no Realtime subscription here (that's what the
// expanded single-order view via useOrderTracking is for); this just needs
// a fresh snapshot whenever the modal opens.
export function useUserOrders(userId: string | null) {
  const sb = createClient();
  const query = useQuery({
    queryKey: queryKeys.userOrders(userId ?? ""),
    queryFn: () => getUserOrders(sb, userId!),
    enabled: Boolean(userId),
  });
  return { orders: query.data ?? [], isLoading: query.isLoading };
}

// Order confirmation / tracking: subscribes to this order's status so it
// flips placed -> confirmed -> shipped -> delivered live. Degrades to the
// last fetched snapshot if the Realtime channel disconnects.
export function useOrderTracking(orderId: string | null) {
  const queryClient = useQueryClient();
  const sb = createClient();
  const queryKey = queryKeys.order(orderId ?? "");

  const orderQuery = useQuery({
    queryKey,
    queryFn: () => getOrder(sb, orderId!),
    enabled: Boolean(orderId),
    refetchInterval: (query) => (query.state.data?.status === "delivered" ? false : 15_000),
  });

  useEffect(() => {
    if (!orderId) return;
    const channel = sb
      .channel(`order-${orderId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "orders", filter: `id=eq.${orderId}` },
        () => queryClient.invalidateQueries({ queryKey }),
      )
      .subscribe();

    return () => {
      sb.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  return orderQuery;
}

export function useCreateAppointment() {
  const sb = createClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof bookAppointment>[1]) => bookAppointment(sb, input),
  });
}

// "Your appointments" — same no-realtime rationale as useUserOrders; the
// expanded single-appointment view (useAppointmentTracking) is what
// subscribes live.
export function useUserAppointments(userId: string | null) {
  const sb = createClient();
  const query = useQuery({
    queryKey: queryKeys.userAppointments(userId ?? ""),
    queryFn: () => getUserAppointments(sb, userId!),
    enabled: Boolean(userId),
  });
  return { appointments: query.data ?? [], isLoading: query.isLoading };
}

// Mirrors useOrderTracking exactly: poll + Realtime subscription so a
// pending -> confirmed status change (an expert/admin confirming the
// booking) shows up without the user refreshing.
export function useAppointmentTracking(appointmentId: string | null) {
  const queryClient = useQueryClient();
  const sb = createClient();
  const queryKey = queryKeys.appointment(appointmentId ?? "");

  const appointmentQuery = useQuery({
    queryKey,
    queryFn: () => getAppointment(sb, appointmentId!),
    enabled: Boolean(appointmentId),
    refetchInterval: (query) => (query.state.data?.status === "cancelled" ? false : 20_000),
  });

  useEffect(() => {
    if (!appointmentId) return;
    const channel = sb
      .channel(`appointment-${appointmentId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "appointments", filter: `id=eq.${appointmentId}` },
        () => queryClient.invalidateQueries({ queryKey }),
      )
      .subscribe();

    return () => {
      sb.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointmentId]);

  return appointmentQuery;
}
