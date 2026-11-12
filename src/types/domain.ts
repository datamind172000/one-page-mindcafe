import type { Database } from "@/types/supabase";

type Tables = Database["public"]["Tables"];

export type Profile = Tables["profiles"]["Row"];
export type Product = Tables["products"]["Row"];
export type ProductVariant = Tables["product_variants"]["Row"];
export type PickupLocation = Tables["pickup_locations"]["Row"];
export type Inventory = Tables["inventory"]["Row"];
export type Address = Tables["addresses"]["Row"];
export type Cart = Tables["carts"]["Row"];
export type CartItem = Tables["cart_items"]["Row"];
export type Order = Tables["orders"]["Row"];
export type OrderItem = Tables["order_items"]["Row"];
export type Coupon = Tables["coupons"]["Row"];
export type SiteSetting = Tables["site_settings"]["Row"];
export type NewsletterSubscriber = Tables["newsletter_subscribers"]["Row"];
export type Review = Tables["reviews"]["Row"];
export type Expert = Tables["experts"]["Row"];
export type TherapyCategory = Tables["therapy_categories"]["Row"];
export type Appointment = Tables["appointments"]["Row"];
export type Assessment = Tables["assessments"]["Row"];
export type BusinessLead = Tables["business_leads"]["Row"];
export type ContactMessage = Tables["contact_messages"]["Row"];
export type Feedback = Tables["feedback"]["Row"];
export type ExpertBlockedSlot = Tables["expert_blocked_slots"]["Row"];
export type AppointmentNote = Tables["appointment_notes"]["Row"];
export type InventoryTransaction = Tables["inventory_transactions"]["Row"];
export type MisplacedStockLog = Tables["misplaced_stock_logs"]["Row"];
export type ExpertApplication = Tables["expert_applications"]["Row"];
export type FeelzPreorder = Tables["feelz_preorders"]["Row"];
export type Faq = Tables["faqs"]["Row"];
export type Milestone = Tables["milestones"]["Row"];

export type AppointmentWithExpert = Appointment & { experts: Pick<Expert, "name" | "photo_url"> | null };
export type AppointmentWithCustomer = Appointment & { profiles: Pick<Profile, "full_name" | "phone"> | null };
export type AppointmentWithDetails = Appointment & {
  experts: Pick<Expert, "name" | "photo_url"> | null;
  profiles: Pick<Profile, "full_name" | "phone"> | null;
};

export type ProductWithVariants = Product & { product_variants: ProductVariant[] };
export type InventoryWithVariant = Inventory & {
  product_variants: ProductVariant & { products: Pick<Product, "name"> };
};
export type InventoryWithVariantAndLocation = InventoryWithVariant & {
  pickup_locations: Pick<PickupLocation, "name" | "city"> | null;
};
export type CartItemWithVariant = CartItem & {
  product_variants: ProductVariant & { products: Pick<Product, "id" | "name" | "image_url" | "price"> & { is_bundle?: boolean } };
};
export type OrderWithItems = Order & {
  order_items: OrderItem[];
  pickup_locations: Pick<PickupLocation, "name"> | null;
};
export type OrderItemWithVariant = OrderItem & {
  product_variants: Pick<ProductVariant, "variant_label"> & { products: Pick<Product, "name"> };
};
export type OrderWithItemDetails = Order & { order_items: OrderItemWithVariant[] };
// Admin orders list — same item/variant/product join as the customer
// "your orders" view, plus the pickup location (null for delivery orders,
// or a location whose row got deleted after the order was placed) and the
// saved address (null for guest checkout, which carries its city/pincode
// on the order row itself via guest_address_city/guest_address_pincode
// instead — see the `Order` base type this extends).
export type OrderWithItemDetailsAndLocation = OrderWithItemDetails & {
  pickup_locations: Pick<PickupLocation, "name" | "city"> | null;
  addresses: Pick<Address, "city" | "pincode" | "phone" | "line1" | "line2" | "landmark" | "state"> | null;
  profiles: Pick<Profile, "full_name" | "phone"> | null;
  // Customer's total real orders (not abandoned/cancelled) — see getOrdersAdmin.
  customer_order_count?: number;
};
