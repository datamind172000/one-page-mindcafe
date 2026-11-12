"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import {
  getOrdersAdmin,
  getPickupLocationsAdmin,
  listUsersAdmin,
  updateOrderStatusAdmin,
  updateOrderDetailsAdmin,
  updateOrderItemQuantityAdmin,
  deleteOrderAdmin,
  type OrderDetailsEdit,
} from "@/lib/admin-api";
import { useAuth } from "@/contexts/AuthContext";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminTable, type AdminColumn } from "@/components/admin/AdminTable";
import { AdminSearchInput } from "@/components/admin/AdminSearchInput";
import { FilterDropdown, type FilterOption } from "@/components/admin/FilterDropdown";
import { Modal } from "@/components/Modal";
import { useConfirmDialog } from "@/contexts/ConfirmDialogContext";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { formatDateTime, formatInr } from "@/lib/utils";
import { downloadCsv, toCsv } from "@/lib/csv";
import type { OrderWithItemDetailsAndLocation } from "@/types/domain";
import { titleCase } from "@/lib/textCase";

const STATUSES = [
  "placed",
  "confirmed",
  "packed",
  "ready_for_pickup",
  "picked_up",
  "shipped",
  "out_for_delivery",
  "delivered",
  "cancelled",
];

const STATUS_FILTER_OPTIONS: FilterOption[] = [
  { value: "", label: "All Statuses" },
  ...STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, " ") })),
];

const PAYMENT_STATUSES = ["pending", "pending_cash", "paid", "refund_required", "refunded", "failed"];

const PAYMENT_STATUS_FILTER_OPTIONS: FilterOption[] = [
  { value: "", label: "All Payments" },
  ...PAYMENT_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, " ") })),
];

const FULFILLMENT_FILTER_OPTIONS: FilterOption[] = [
  { value: "", label: "All Types" },
  { value: "delivery", label: "Delivery" },
  { value: "takeaway", label: "Takeaway" },
];

const PAGE_SIZE = 20;

export default function AdminOrdersPage() {
  const { profile } = useAuth();
  const isSuperAdmin = profile?.role === "super_admin";
  const confirmDialog = useConfirmDialog();
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState("");
  const [locationId, setLocationId] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("");
  const [fulfillmentType, setFulfillmentType] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();

  const ordersQueryKey = [
    "admin",
    "orders",
    page,
    status,
    locationId,
    paymentStatus,
    fulfillmentType,
    dateFrom,
    dateTo,
    debouncedSearch,
  ] as const;

  const ordersQuery = useQuery({
    queryKey: ordersQueryKey,
    queryFn: () =>
      getOrdersAdmin(createClient(), {
        page,
        pageSize: PAGE_SIZE,
        status: status || undefined,
        locationId: locationId || undefined,
        paymentStatus: paymentStatus || undefined,
        fulfillmentType: fulfillmentType || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        search: debouncedSearch || undefined,
      }),
  });

  const locationsQuery = useQuery({
    queryKey: ["admin", "pickup-locations"],
    queryFn: () => getPickupLocationsAdmin(createClient()),
  });

  const locationFilterOptions: FilterOption[] = useMemo(
    () => [
      { value: "", label: "All Locations" },
      { value: "online", label: "Online (Delivery)" },
      ...(locationsQuery.data ?? []).map((l) => ({ value: l.id, label: l.city ? `${l.name}, ${l.city}` : l.name })),
    ],
    [locationsQuery.data],
  );

  // Logged-in orders carry no email on the order row itself (only
  // guest_email, for guest checkout) — the account's email lives in
  // auth.users, so it's fetched once via the same admin-list-users lookup
  // the users page uses and matched onto each order by user_id.
  const usersQuery = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => listUsersAdmin(createClient()),
  });
  const emailByUserId = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const u of usersQuery.data ?? []) map.set(u.id, u.email);
    return map;
  }, [usersQuery.data]);
  // Phone-OTP sign-ins keep the number on auth.users, not always on the
  // profile — used as a fallback when the profile's phone is empty.
  const authPhoneByUserId = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const u of usersQuery.data ?? []) map.set(u.id, u.phone);
    return map;
  }, [usersQuery.data]);

  // Live: new orders / status changes show up without a manual refresh —
  // broad invalidate, same rationale as the admin appointments page.
  useEffect(() => {
    const sb = createClient();
    const channel = sb
      .channel("admin-orders")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () =>
        queryClient.invalidateQueries({ queryKey: ["admin", "orders"] }),
      )
      .subscribe();

    return () => {
      sb.removeChannel(channel);
    };
  }, [queryClient]);

  // Optimistic: the status select flips instantly instead of waiting on a
  // full 20-row page refetch to come back before the UI shows the change.
  const updateStatus = useMutation({
    mutationFn: (args: { id: string; status: string }) =>
      updateOrderStatusAdmin(createClient(), args.id, args.status as OrderWithItemDetailsAndLocation["status"]),
    onMutate: async (args) => {
      await queryClient.cancelQueries({ queryKey: ordersQueryKey });
      const previous = queryClient.getQueryData<{ orders: OrderWithItemDetailsAndLocation[]; total: number }>(ordersQueryKey);
      queryClient.setQueryData<{ orders: OrderWithItemDetailsAndLocation[]; total: number }>(ordersQueryKey, (old) =>
        old && {
          ...old,
          orders: old.orders.map((o) => (o.id === args.id ? { ...o, status: args.status as OrderWithItemDetailsAndLocation["status"] } : o)),
        },
      );
      return { previous };
    },
    onError: (_err, _args, context) => {
      if (context?.previous) queryClient.setQueryData(ordersQueryKey, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["admin", "orders"] }),
  });

  // RLS (orders_super_admin_delete) enforces this server-side too — the
  // isSuperAdmin check here is just so a plain admin doesn't even see the
  // option, not the real security boundary.
  const remove = useMutation({
    mutationFn: (id: string) => deleteOrderAdmin(createClient(), id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "orders"] }),
  });

  // Bulk versions of the same two single-row actions above — fire the
  // per-order calls in parallel, then invalidate once at the end rather
  // than once per row, so a 10-order bulk action doesn't refetch the page
  // 10 times in a row.
  const bulkMarkPickedUp = useMutation({
    mutationFn: (ids: string[]) => {
      const sb = createClient();
      return Promise.all(ids.map((id) => updateOrderStatusAdmin(sb, id, "picked_up")));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "orders"] });
      setSelectedIds(new Set());
    },
  });

  const bulkDelete = useMutation({
    mutationFn: (ids: string[]) => {
      const sb = createClient();
      return Promise.all(ids.map((id) => deleteOrderAdmin(sb, id)));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "orders"] });
      setSelectedIds(new Set());
    },
  });

  const orders = ordersQuery.data?.orders ?? [];
  const total = ordersQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Edit modal — mirrors /admin/pickup-locations' pencil-icon → form-modal
  // pattern. `editingOrder` is kept in sync with the live query below
  // rather than frozen at open time, so an item-quantity change (which
  // recomputes subtotal/total server-side) is reflected the moment the
  // refetch lands, without the admin having to close and reopen.
  const [editingOrder, setEditingOrder] = useState<OrderWithItemDetailsAndLocation | null>(null);
  const [detailsForm, setDetailsForm] = useState<OrderDetailsEdit>({});

  useEffect(() => {
    if (!editingOrder) return;
    const fresh = orders.find((o) => o.id === editingOrder.id);
    if (fresh && fresh !== editingOrder) setEditingOrder(fresh);
  }, [orders, editingOrder]);

  function openEdit(order: OrderWithItemDetailsAndLocation) {
    setEditingOrder(order);
    setDetailsForm({
      location_id: order.location_id,
      pickup_slot: order.pickup_slot,
      payment_status: order.payment_status,
      notes: order.notes,
      guest_address_line1: order.guest_address_line1,
      guest_address_line2: order.guest_address_line2,
      guest_address_city: order.guest_address_city,
      guest_address_state: order.guest_address_state,
      guest_address_pincode: order.guest_address_pincode,
    });
  }

  const saveDetails = useMutation({
    mutationFn: (args: { id: string; edit: OrderDetailsEdit }) => updateOrderDetailsAdmin(createClient(), args.id, args.edit),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "orders"] });
      setEditingOrder(null);
    },
  });

  // Deliberately not optimistic: this touches inventory server-side (see
  // admin_set_order_item_quantity in 20260825000000_admin_order_editing.sql)
  // and can fail on insufficient stock — the row should only ever show a
  // quantity the server actually accepted.
  const updateItemQty = useMutation({
    mutationFn: (args: { orderId: string; itemId: string; quantity: number }) =>
      updateOrderItemQuantityAdmin(createClient(), args.orderId, args.itemId, args.quantity),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "orders"] }),
  });

  function toggleRow(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelectedIds((current) => (current.size === orders.length ? new Set() : new Set(orders.map((o) => o.id))));
  }

  // Same contact resolution the "customer" column uses, shared with the
  // CSV export so both always agree.
  function contactFor(o: OrderWithItemDetailsAndLocation) {
    return {
      name: (o.user_id ? o.profiles?.full_name : o.guest_name) ?? "",
      phone:
        (o.user_id
          ? o.profiles?.phone || authPhoneByUserId.get(o.user_id) || o.addresses?.phone
          : o.guest_phone || o.addresses?.phone) ?? "",
      email: (o.user_id ? emailByUserId.get(o.user_id) : o.guest_email) ?? "",
    };
  }

  // Exports every order matching the current filters/search — not just
  // the 20 on screen — fetched in pages of 500 (PostgREST caps a single
  // response at 1000 rows).
  const [isExporting, setIsExporting] = useState(false);
  async function handleExportCsv() {
    setIsExporting(true);
    try {
      const sb = createClient();
      const filters = {
        status: status || undefined,
        locationId: locationId || undefined,
        paymentStatus: paymentStatus || undefined,
        fulfillmentType: fulfillmentType || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        search: debouncedSearch || undefined,
      };
      const all: OrderWithItemDetailsAndLocation[] = [];
      for (let exportPage = 0; ; exportPage++) {
        const { orders: batch, total: matching } = await getOrdersAdmin(sb, { ...filters, page: exportPage, pageSize: 500 });
        all.push(...batch);
        if (batch.length === 0 || all.length >= matching) break;
      }

      const header = [
        "order number", "placed at", "customer name", "phone", "email", "fulfillment", "items", "total quantity",
        "subtotal", "discount", "coupon", "delivery fee", "total", "payment status", "payment method", "order status",
        "pickup location", "address", "city", "state", "pincode", "awb", "tracking url", "notes",
      ];
      const rows = all.map((o) => {
        const contact = contactFor(o);
        const isDelivery = o.fulfillment_type === "delivery";
        const address = isDelivery
          ? [o.addresses?.line1 ?? o.guest_address_line1, o.addresses?.line2 ?? o.guest_address_line2, o.addresses?.landmark]
              .filter(Boolean)
              .join(", ")
          : "";
        return [
          o.order_number,
          formatDateTime(o.created_at),
          contact.name,
          contact.phone,
          contact.email,
          o.fulfillment_type,
          o.order_items
            .map((item) => `${item.product_variants.products.name} (${item.product_variants.variant_label}) x${item.quantity}`)
            .join("; "),
          o.order_items.reduce((sum, item) => sum + item.quantity, 0),
          o.subtotal,
          o.discount_amount,
          o.coupon_code ?? "",
          o.delivery_fee,
          o.total,
          o.payment_status,
          o.payment_method ?? "",
          o.status.replace(/_/g, " "),
          o.pickup_locations ? [o.pickup_locations.name, o.pickup_locations.city].filter(Boolean).join(", ") : "",
          address,
          isDelivery ? o.addresses?.city ?? o.guest_address_city ?? "" : "",
          isDelivery ? o.addresses?.state ?? o.guest_address_state ?? "" : "",
          isDelivery ? o.addresses?.pincode ?? o.guest_address_pincode ?? "" : "",
          o.awb_code ?? "",
          o.tracking_url ?? "",
          o.notes ?? "",
        ];
      });
      downloadCsv(`orders-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(header, rows));
    } catch (error) {
      console.error("Order export failed", error);
      window.alert("Couldn't export orders. Please try again.");
    } finally {
      setIsExporting(false);
    }
  }

  const columns: AdminColumn<OrderWithItemDetailsAndLocation>[] = [
    { key: "order_number", label: "order", render: (o) => <span className="font-medium text-ink">{o.order_number}</span> },
    {
      key: "contact",
      label: "Customer",
      render: (o) => {
        // Guest checkout (scan-and-order or site-direct) always collects a
        // phone number and optionally an email, both stored on the order
        // row. A logged-in order has neither — name/phone come from the
        // profile, email from the auth.users lookup above.
        // Phone falls back profile → sign-in phone → delivery address
        // (every saved address requires one), so delivery orders always
        // have a contact number even when the profile's is empty. Phone
        // and email are both shown, not one-or-the-other.
        const { name, phone, email } = contactFor(o);
        if (!name && !phone && !email) return <span className="text-ink/30">-</span>;
        return (
          <div className="space-y-0.5 text-xs">
            {name && <p className="font-medium text-ink">{name}</p>}
            {phone && (
              <a href={`tel:${phone}`} className="block text-ink/70 hover:underline">
                {phone}
              </a>
            )}
            {email && <p className="break-all text-ink/50">{email}</p>}
            {(o.customer_order_count ?? 0) >= 2 ? (
              <span className="inline-block rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-800">
                Repeat · {o.customer_order_count} orders
              </span>
            ) : (o.customer_order_count ?? 0) === 1 ? (
              <span className="inline-block text-[11px] text-ink/40">1st order</span>
            ) : null}
          </div>
        );
      },
    },
    { key: "type", label: "Fulfillment", render: (o) => <span className="capitalize">{o.fulfillment_type}</span> },
    {
      key: "items",
      label: "Type / Variant",
      render: (o) => (
        <div className="space-y-0.5">
          {o.order_items.map((item) => (
            <p key={item.id} className="whitespace-nowrap text-xs">
              {item.product_variants.products.name} · {item.product_variants.variant_label} × {item.quantity}
            </p>
          ))}
        </div>
      ),
    },
    {
      key: "location",
      label: "Location",
      render: (o) =>
        o.pickup_locations ? (
          <span>
            {o.pickup_locations.name}
            {o.pickup_locations.city ? `, ${o.pickup_locations.city}` : ""}
          </span>
        ) : (
          <span className="text-ink/30">-</span>
        ),
    },
    {
      key: "city_pincode",
      label: "City / Pincode",
      render: (o) => {
        if (o.fulfillment_type !== "delivery") return <span className="text-ink/30">-</span>;
        // Signed-in checkout carries city/pincode via the saved address row
        // (o.addresses); guest checkout has no address_id and instead
        // stores them directly on the order (guest_address_city/pincode).
        const city = o.addresses?.city ?? o.guest_address_city;
        const pincode = o.addresses?.pincode ?? o.guest_address_pincode;
        if (!city && !pincode) return <span className="text-ink/30">-</span>;
        return (
          <span className="text-xs">
            {city ?? "-"}
            {pincode ? ` · ${pincode}` : ""}
          </span>
        );
      },
    },
    { key: "total", label: "Total", render: (o) => <span>{formatInr(o.total)}</span> },
    {
      key: "coupon",
      label: "Coupon",
      render: (o) =>
        o.coupon_code ? (
          <span className="whitespace-nowrap">
            {o.coupon_code}
            {o.discount_amount > 0 && <span className="text-ink/50"> · −{formatInr(o.discount_amount)}</span>}
          </span>
        ) : (
          <span className="text-ink/30">-</span>
        ),
    },
    { key: "payment", label: "Payment", render: (o) => <span className="capitalize">{o.payment_status}</span> },
    {
      key: "status",
      label: "status",
      render: (o) => (
        <select
          value={o.status}
          onChange={(e) => updateStatus.mutate({ id: o.id, status: e.target.value })}
          className="input !w-auto !py-1.5 text-xs"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {titleCase(s.replace(/_/g, " "))}
            </option>
          ))}
        </select>
      ),
    },
    {
      key: "tracking",
      label: "Tracking",
      render: (o) =>
        o.fulfillment_type !== "delivery" ? (
          <span className="text-ink/30">-</span>
        ) : o.awb_code ? (
          <div>
            <p className="text-ink">{o.awb_code}</p>
            {o.tracking_url && (
              <a href={o.tracking_url} target="_blank" rel="noreferrer" className="text-ink/60 underline">
                Track
              </a>
            )}
          </div>
        ) : o.shiprocket_order_id ? (
          <span className="text-amber-600">Shipment created, no AWB yet</span>
        ) : (
          <span className="text-ink/40">Not Shipped</span>
        ),
    },
    { key: "date", label: "Placed", render: (o) => <span className="whitespace-nowrap text-ink/60">{formatDateTime(o.created_at)}</span> },
    {
      key: "notification",
      label: "email",
      render: (o) =>
        o.last_notification_status === "sent" ? (
          <span className="text-xs font-medium text-emerald-700">✓ sent</span>
        ) : o.last_notification_status === "failed" ? (
          <span className="text-xs font-medium text-red-600" title={o.last_notification_error ?? undefined}>
            ✗ failed
          </span>
        ) : o.last_notification_status === "no_email" ? (
          <span className="text-xs font-medium text-amber-600">No Email on File</span>
        ) : (
          <span className="text-xs text-ink/30">-</span>
        ),
    },
  ];

  return (
    <div>
      <AdminPageHeader title="orders" description={`${total} total`} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <AdminSearchInput
          value={search}
          onChange={(v) => {
            setSearch(v);
            setPage(0);
          }}
          placeholder="Search by order number, name, or phone…"
          wrapperClassName="max-w-sm flex-1"
        />
        <FilterDropdown
          options={STATUS_FILTER_OPTIONS}
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(0);
          }}
          searchPlaceholder="Search statuses…"
        />
        <FilterDropdown
          options={locationFilterOptions}
          value={locationId}
          onChange={(v) => {
            setLocationId(v);
            setPage(0);
          }}
          searchPlaceholder="Search locations…"
        />
        <FilterDropdown
          options={PAYMENT_STATUS_FILTER_OPTIONS}
          value={paymentStatus}
          onChange={(v) => {
            setPaymentStatus(v);
            setPage(0);
          }}
          searchPlaceholder="Search payment status…"
        />
        <FilterDropdown
          options={FULFILLMENT_FILTER_OPTIONS}
          value={fulfillmentType}
          onChange={(v) => {
            setFulfillmentType(v);
            setPage(0);
          }}
          searchPlaceholder="Search type…"
        />
        <div className="flex items-center gap-1.5 text-xs">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setPage(0);
            }}
            max={dateTo || undefined}
            className="input !w-auto !py-1.5 text-xs"
            aria-label="From date"
          />
          <span className="text-ink/40">to</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => {
              setDateTo(e.target.value);
              setPage(0);
            }}
            min={dateFrom || undefined}
            className="input !w-auto !py-1.5 text-xs"
            aria-label="To date"
          />
        </div>
        {(status || locationId || paymentStatus || fulfillmentType || dateFrom || dateTo || search) && (
          <button
            type="button"
            onClick={() => {
              setStatus("");
              setLocationId("");
              setPaymentStatus("");
              setFulfillmentType("");
              setDateFrom("");
              setDateTo("");
              setSearch("");
              setPage(0);
            }}
            className="text-xs text-ink/50 underline hover:text-ink"
          >
            Clear Filters
          </button>
        )}
        <button
          type="button"
          onClick={handleExportCsv}
          disabled={isExporting || total === 0}
          className="pill-btn-outline ml-auto !py-1.5 text-xs disabled:opacity-40"
          title="Download every order matching the current filters"
        >
          {isExporting ? "Exporting…" : `download csv (${total})`}
        </button>
      </div>

      {selectedIds.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-ink/15 bg-cream/60 px-4 py-2.5 text-sm">
          <span className="font-medium text-ink">{selectedIds.size} selected</span>
          <button
            type="button"
            onClick={() => bulkMarkPickedUp.mutate(Array.from(selectedIds))}
            disabled={bulkMarkPickedUp.isPending}
            className="pill-btn-outline !py-1.5 text-xs disabled:opacity-40"
          >
            {bulkMarkPickedUp.isPending ? "Updating…" : "Mark Picked Up"}
          </button>
          {isSuperAdmin && (
            <button
              type="button"
              onClick={async () => {
                if (
                  await confirmDialog({
                    title: "Delete Orders",
                    message: `Delete ${selectedIds.size} selected order${selectedIds.size === 1 ? "" : "s"} permanently? This can't be undone.`,
                    danger: true,
                  })
                ) {
                  bulkDelete.mutate(Array.from(selectedIds));
                }
              }}
              disabled={bulkDelete.isPending}
              className="text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-40"
            >
              {bulkDelete.isPending ? "Deleting…" : "Delete Selected"}
            </button>
          )}
          <button type="button" onClick={() => setSelectedIds(new Set())} className="ml-auto text-xs text-ink/50 hover:text-ink">
            clear
          </button>
        </div>
      )}

      <AdminTable
        columns={columns}
        rows={orders}
        getRowId={(o) => o.id}
        isLoading={ordersQuery.isLoading}
        emptyLabel="No orders."
        selectedIds={selectedIds}
        onToggleRow={toggleRow}
        onToggleAll={toggleAll}
        onEdit={openEdit}
        onDelete={
          isSuperAdmin
            ? async (o) => {
                if (
                  await confirmDialog({
                    title: "Delete Order",
                    message: `Delete order "${o.order_number}" permanently? This can't be undone.`,
                    danger: true,
                  })
                ) {
                  remove.mutate(o.id);
                }
              }
            : undefined
        }
      />

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3 text-xs">
          <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="pill-btn-outline !py-1.5 disabled:opacity-40">
            Previous
          </button>
          <span className="text-ink/50">
            page {page + 1} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="pill-btn-outline !py-1.5 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}

      <Modal isOpen={!!editingOrder} onClose={() => setEditingOrder(null)} title={editingOrder ? `edit: ${editingOrder.order_number}` : "Edit Order"}>
        {editingOrder && (
          <div className="space-y-5">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-label text-ink/50">Items</p>
              <div className="space-y-2 rounded-lg border border-ink/15 p-3">
                {editingOrder.order_items.map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <p className="truncate text-ink">
                        {item.product_variants.products.name} · {item.product_variants.variant_label}
                      </p>
                      <p className="text-xs text-ink/50">{formatInr(item.unit_price)} each</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => updateItemQty.mutate({ orderId: editingOrder.id, itemId: item.id, quantity: item.quantity - 1 })}
                        disabled={updateItemQty.isPending || item.quantity <= 1}
                        className="flex h-6 w-6 items-center justify-center rounded-full border border-ink/20 text-ink disabled:opacity-30"
                      >
                        −
                      </button>
                      <span className="w-5 text-center">{item.quantity}</span>
                      <button
                        type="button"
                        onClick={() => updateItemQty.mutate({ orderId: editingOrder.id, itemId: item.id, quantity: item.quantity + 1 })}
                        disabled={updateItemQty.isPending}
                        className="flex h-6 w-6 items-center justify-center rounded-full border border-ink/20 text-ink disabled:opacity-30"
                      >
                        +
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (
                            await confirmDialog({
                              title: "Remove Item",
                              message: `Remove "${item.product_variants.products.name} · ${item.product_variants.variant_label}" from this order? If stock was already taken for it, it'll be restocked.`,
                              danger: true,
                            })
                          ) {
                            updateItemQty.mutate({ orderId: editingOrder.id, itemId: item.id, quantity: 0 });
                          }
                        }}
                        disabled={updateItemQty.isPending}
                        className="text-xs text-red-600 hover:text-red-700 disabled:opacity-30"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {updateItemQty.isError && (
                <p className="mt-1.5 text-xs text-red-600">
                  {updateItemQty.error instanceof Error ? updateItemQty.error.message : "Couldn't update quantity. Not enough stock?"}
                </p>
              )}
              <div className="mt-2 flex justify-between text-xs text-ink/60">
                <span>Subtotal</span>
                <span>{formatInr(editingOrder.subtotal)}</span>
              </div>
              <div className="flex justify-between text-xs text-ink/60">
                <span>Delivery Fee</span>
                <span>{formatInr(editingOrder.delivery_fee)}</span>
              </div>
              {editingOrder.discount_amount > 0 && (
                <div className="flex justify-between text-xs text-ink/60">
                  <span>Discount</span>
                  <span>−{formatInr(editingOrder.discount_amount)}</span>
                </div>
              )}
              <div className="flex justify-between text-sm font-medium text-ink">
                <span>Total</span>
                <span>{formatInr(editingOrder.total)}</span>
              </div>
            </div>

            {editingOrder.fulfillment_type === "takeaway" && (
              <div>
                <label className="mb-1 block text-sm text-ink/70">Pickup location</label>
                <select
                  value={detailsForm.location_id ?? ""}
                  onChange={(e) => setDetailsForm({ ...detailsForm, location_id: e.target.value || null })}
                  className="input"
                >
                  <option value="">None</option>
                  {(locationsQuery.data ?? []).map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                      {l.city ? `, ${l.city}` : ""}
                    </option>
                  ))}
                </select>
                <input
                  value={detailsForm.pickup_slot ?? ""}
                  onChange={(e) => setDetailsForm({ ...detailsForm, pickup_slot: e.target.value || null })}
                  placeholder="Pickup slot (e.g. 4–6pm)"
                  className="input mt-2"
                />
              </div>
            )}

            {editingOrder.fulfillment_type === "delivery" &&
              (editingOrder.address_id ? (
                <div>
                  <label className="mb-1 block text-sm text-ink/70">Delivery address</label>
                  <p className="rounded-lg border border-ink/15 bg-cream/60 p-3 text-xs text-ink/60">
                    This order ships to the customer&apos;s saved address ({editingOrder.addresses?.city ?? "-"}
                    {editingOrder.addresses?.pincode ? ` · ${editingOrder.addresses.pincode}` : ""}). Edit it from their account,
                    not here.
                  </p>
                </div>
              ) : (
                <div>
                  <label className="mb-1 block text-sm text-ink/70">Delivery address (guest checkout)</label>
                  <div className="space-y-2">
                    <input
                      value={detailsForm.guest_address_line1 ?? ""}
                      onChange={(e) => setDetailsForm({ ...detailsForm, guest_address_line1: e.target.value })}
                      placeholder="Address line 1"
                      className="input"
                    />
                    <input
                      value={detailsForm.guest_address_line2 ?? ""}
                      onChange={(e) => setDetailsForm({ ...detailsForm, guest_address_line2: e.target.value || null })}
                      placeholder="Address line 2 (optional)"
                      className="input"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        value={detailsForm.guest_address_city ?? ""}
                        onChange={(e) => setDetailsForm({ ...detailsForm, guest_address_city: e.target.value })}
                        placeholder="City"
                        className="input"
                      />
                      <input
                        value={detailsForm.guest_address_state ?? ""}
                        onChange={(e) => setDetailsForm({ ...detailsForm, guest_address_state: e.target.value })}
                        placeholder="State"
                        className="input"
                      />
                    </div>
                    <input
                      value={detailsForm.guest_address_pincode ?? ""}
                      onChange={(e) => setDetailsForm({ ...detailsForm, guest_address_pincode: e.target.value })}
                      placeholder="Pincode"
                      className="input"
                    />
                  </div>
                </div>
              ))}

            <div>
              <label className="mb-1 block text-sm text-ink/70">Payment status</label>
              <select
                value={detailsForm.payment_status ?? editingOrder.payment_status}
                onChange={(e) =>
                  setDetailsForm({ ...detailsForm, payment_status: e.target.value as OrderDetailsEdit["payment_status"] })
                }
                className="input"
              >
                {PAYMENT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {titleCase(s.replace(/_/g, " "))}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-sm text-ink/70">Internal notes</label>
              <textarea
                value={detailsForm.notes ?? ""}
                onChange={(e) => setDetailsForm({ ...detailsForm, notes: e.target.value || null })}
                rows={2}
                className="input"
              />
            </div>

            {saveDetails.isError && (
              <p className="text-sm text-red-600">
                {saveDetails.error instanceof Error ? saveDetails.error.message : "Failed to save changes"}
              </p>
            )}
            <button
              type="button"
              onClick={() => saveDetails.mutate({ id: editingOrder.id, edit: detailsForm })}
              disabled={saveDetails.isPending}
              className="pill-btn w-full"
            >
              {saveDetails.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}
