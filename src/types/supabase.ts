// Hand-written subset of Mindcafe's Database type — only the tables the
// frontend actually touches so far (Feelz commerce + Phase 1's site_settings/
// newsletter_subscribers/reviews). The full schema has more tables (experts,
// appointments, assessments, business_leads, feeds_posts, faqs,
// therapy_categories, milestones, inventory) added incrementally as each
// phase builds the page that needs them. Regenerate from the live schema with
//   npx supabase gen types typescript --project-id <ref>
// if you'd rather have the full set at once.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type OrderStatus =
  | "placed"
  | "confirmed"
  | "packed"
  | "ready_for_pickup"
  | "picked_up"
  | "shipped"
  | "out_for_delivery"
  | "delivered"
  | "cancelled";

type PaymentMethod = "razorpay" | "cash_on_pickup";
type PaymentStatus = "pending" | "pending_cash" | "paid" | "refund_required" | "refunded" | "failed";
type FulfillmentType = "delivery" | "takeaway";
type ProfileRole = "customer" | "expert" | "employer" | "admin" | "super_admin";
type AuthProvider = "email" | "google" | "phone";
type CartStatus = "active" | "merged" | "abandoned" | "converted";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          full_name: string | null;
          phone: string | null;
          gender: string | null;
          auth_provider: AuthProvider;
          avatar_url: string | null;
          role: ProfileRole;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["profiles"]["Row"]> & { id: string };
        Update: Partial<Database["public"]["Tables"]["profiles"]["Row"]>;
        Relationships: [];
      };
      products: {
        Row: {
          id: string;
          name: string;
          slug: string;
          description: string | null;
          price: number;
          image_url: string | null;
          is_active: boolean;
          /** The Feelz Bundle — fixed price, excluded from the automatic 10%. */
          is_bundle: boolean;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["products"]["Row"]> & {
          name: string;
          slug: string;
          price: number;
        };
        Update: Partial<Database["public"]["Tables"]["products"]["Row"]>;
        Relationships: [];
      };
      product_variants: {
        Row: {
          id: string;
          product_id: string;
          variant_label: string;
          price_override: number | null;
          sku: string | null;
          weight_grams: number | null;
          length_cm: number | null;
          breadth_cm: number | null;
          height_cm: number | null;
          reorder_threshold: number | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["product_variants"]["Row"]> & {
          product_id: string;
          variant_label: string;
        };
        Update: Partial<Database["public"]["Tables"]["product_variants"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "product_variants_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
        ];
      };
      pickup_locations: {
        Row: {
          id: string;
          name: string;
          address: string;
          city: string;
          lat: number | null;
          lng: number | null;
          is_active: boolean;
          staff_pin: string;
          maps_url: string | null;
          commission_percent: number;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["pickup_locations"]["Row"]> & {
          name: string;
          address: string;
          city: string;
        };
        Update: Partial<Database["public"]["Tables"]["pickup_locations"]["Row"]>;
        Relationships: [];
      };
      pickup_location_commission_adjustments: {
        Row: {
          id: string;
          location_id: string;
          amount: number;
          reason: string;
          adjustment_date: string;
          created_by: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["pickup_location_commission_adjustments"]["Row"]> & {
          location_id: string;
          amount: number;
          reason: string;
        };
        Update: Partial<Database["public"]["Tables"]["pickup_location_commission_adjustments"]["Row"]>;
        Relationships: [];
      };
      inventory: {
        Row: {
          id: string;
          variant_id: string;
          location_id: string | null;
          quantity_available: number;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["inventory"]["Row"]> & { variant_id: string };
        Update: Partial<Database["public"]["Tables"]["inventory"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "inventory_variant_id_fkey";
            columns: ["variant_id"];
            isOneToOne: false;
            referencedRelation: "product_variants";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inventory_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "pickup_locations";
            referencedColumns: ["id"];
          },
        ];
      };
      serviceable_pincodes: {
        Row: {
          id: string;
          pincode: string;
          city: string;
          delivery_fee: number;
          free_delivery_threshold: number | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["serviceable_pincodes"]["Row"]> & {
          pincode: string;
          city: string;
        };
        Update: Partial<Database["public"]["Tables"]["serviceable_pincodes"]["Row"]>;
        Relationships: [];
      };
      addresses: {
        Row: {
          id: string;
          user_id: string;
          label: string | null;
          full_name: string;
          phone: string;
          line1: string;
          line2: string | null;
          city: string;
          state: string;
          pincode: string;
          landmark: string | null;
          is_default: boolean;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["addresses"]["Row"]> & {
          user_id: string;
          full_name: string;
          phone: string;
          line1: string;
          city: string;
          state: string;
          pincode: string;
        };
        Update: Partial<Database["public"]["Tables"]["addresses"]["Row"]>;
        Relationships: [];
      };
      carts: {
        Row: {
          id: string;
          user_id: string | null;
          session_id: string | null;
          status: CartStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["carts"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["carts"]["Row"]>;
        Relationships: [];
      };
      cart_items: {
        Row: {
          id: string;
          cart_id: string;
          variant_id: string;
          quantity: number;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["cart_items"]["Row"]> & {
          cart_id: string;
          variant_id: string;
          quantity: number;
        };
        Update: Partial<Database["public"]["Tables"]["cart_items"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "cart_items_variant_id_fkey";
            columns: ["variant_id"];
            isOneToOne: false;
            referencedRelation: "product_variants";
            referencedColumns: ["id"];
          },
        ];
      };
      stock_reservations: {
        Row: {
          id: string;
          cart_id: string;
          variant_id: string;
          location_id: string | null;
          quantity: number;
          expires_at: string;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["stock_reservations"]["Row"]> & {
          cart_id: string;
          variant_id: string;
          quantity: number;
          expires_at: string;
        };
        Update: Partial<Database["public"]["Tables"]["stock_reservations"]["Row"]>;
        Relationships: [];
      };
      orders: {
        Row: {
          id: string;
          order_number: string;
          user_id: string | null;
          source_cart_id: string | null;
          fulfillment_type: FulfillmentType;
          address_id: string | null;
          location_id: string | null;
          pickup_slot: string | null;
          status: OrderStatus;
          payment_method: PaymentMethod;
          payment_status: PaymentStatus;
          payment_ref: string | null;
          razorpay_order_id: string | null;
          shiprocket_order_id: string | null;
          shiprocket_shipment_id: string | null;
          awb_code: string | null;
          tracking_url: string | null;
          subtotal: number;
          delivery_fee: number;
          estimated_delivery: string | null;
          total: number;
          notes: string | null;
          guest_name: string | null;
          guest_phone: string | null;
          guest_email: string | null;
          guest_address_line1: string | null;
          guest_address_line2: string | null;
          guest_address_city: string | null;
          guest_address_state: string | null;
          guest_address_pincode: string | null;
          coupon_code: string | null;
          discount_amount: number;
          pickup_code: string | null;
          pickup_code_collected_at: string | null;
          last_notification_status: string | null;
          last_notification_error: string | null;
          last_notification_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["orders"]["Row"]> & {
          fulfillment_type: FulfillmentType;
          payment_method: PaymentMethod;
          subtotal: number;
          total: number;
        };
        Update: Partial<Database["public"]["Tables"]["orders"]["Row"]>;
        Relationships: [];
      };
      order_status_events: {
        Row: { id: string; order_id: string; status: string; created_at: string };
        Insert: Partial<Database["public"]["Tables"]["order_status_events"]["Row"]> & { order_id: string; status: string };
        Update: Partial<Database["public"]["Tables"]["order_status_events"]["Row"]>;
        Relationships: [];
      };
      order_items: {
        Row: {
          id: string;
          order_id: string;
          variant_id: string;
          quantity: number;
          unit_price: number;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["order_items"]["Row"]> & {
          order_id: string;
          variant_id: string;
          quantity: number;
          unit_price: number;
        };
        Update: Partial<Database["public"]["Tables"]["order_items"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey";
            columns: ["order_id"];
            isOneToOne: false;
            referencedRelation: "orders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "order_items_variant_id_fkey";
            columns: ["variant_id"];
            isOneToOne: false;
            referencedRelation: "product_variants";
            referencedColumns: ["id"];
          },
        ];
      };
      coupons: {
        Row: {
          id: string;
          code: string;
          discount_type: "percent" | "fixed";
          discount_value: number;
          min_order_amount: number;
          max_discount_amount: number | null;
          is_active: boolean;
          expires_at: string | null;
          usage_limit: number | null;
          times_used: number;
          applies_to: "orders" | "appointments" | "both";
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["coupons"]["Row"]> & {
          code: string;
          discount_type: "percent" | "fixed";
          discount_value: number;
        };
        Update: Partial<Database["public"]["Tables"]["coupons"]["Row"]>;
        Relationships: [];
      };
      site_settings: {
        Row: {
          key: string;
          value: Json;
          updated_at: string;
        };
        Insert: { key: string; value: Json; updated_at?: string };
        Update: Partial<Database["public"]["Tables"]["site_settings"]["Row"]>;
        Relationships: [];
      };
      newsletter_subscribers: {
        Row: {
          id: string;
          email: string;
          subscribed_at: string;
          confirmed: boolean;
        };
        Insert: Partial<Database["public"]["Tables"]["newsletter_subscribers"]["Row"]> & { email: string };
        Update: Partial<Database["public"]["Tables"]["newsletter_subscribers"]["Row"]>;
        Relationships: [];
      };
      reviews: {
        Row: {
          id: string;
          reviewer_id: string | null;
          reviewer_name: string;
          city: string | null;
          rating: number;
          comment: string | null;
          related_expert_id: string | null;
          is_corporate: boolean;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["reviews"]["Row"]> & {
          reviewer_name: string;
          rating: number;
        };
        Update: Partial<Database["public"]["Tables"]["reviews"]["Row"]>;
        Relationships: [];
      };
      expert_applications: {
        Row: {
          id: string;
          name: string;
          email: string | null;
          phone: string | null;
          city: string | null;
          social_link: string | null;
          qualification: string | null;
          skills: string | null;
          message: string | null;
          status: "new" | "contacted" | "closed";
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["expert_applications"]["Row"]> & { name: string };
        Update: Partial<Database["public"]["Tables"]["expert_applications"]["Row"]>;
        Relationships: [];
      };
      feelz_preorders: {
        Row: {
          id: string;
          product: string;
          full_name: string;
          mobile: string | null;
          email: string | null;
          city: string | null;
          message: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["feelz_preorders"]["Row"]> & { product: string; full_name: string };
        Update: Partial<Database["public"]["Tables"]["feelz_preorders"]["Row"]>;
        Relationships: [];
      };
      experts: {
        Row: {
          id: string;
          profile_id: string | null;
          name: string;
          photo_url: string | null;
          bio: string | null;
          specialties: string[];
          certifications: string[];
          rating: number | null;
          is_active: boolean;
          is_bookable: boolean;
          notification_email: string | null;
          years_experience: string | null;
          long_bio: string | null;
          modalities: string[];
          client_concerns: string[];
          languages: string[];
          therapist_note: string | null;
          sort_order: number;
          working_hours_start: number;
          working_hours_end: number;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["experts"]["Row"]> & { name: string };
        Update: Partial<Database["public"]["Tables"]["experts"]["Row"]>;
        Relationships: [];
      };
      therapy_categories: {
        Row: {
          slug: string;
          title: string;
          body: string;
          hero_image: string | null;
        };
        Insert: Partial<Database["public"]["Tables"]["therapy_categories"]["Row"]> & {
          slug: string;
          title: string;
          body: string;
        };
        Update: Partial<Database["public"]["Tables"]["therapy_categories"]["Row"]>;
        Relationships: [];
      };
      appointments: {
        Row: {
          id: string;
          user_id: string | null;
          guest_name: string | null;
          guest_phone: string | null;
          guest_email: string | null;
          expert_id: string | null;
          therapy_category: string;
          scheduled_at: string | null;
          status: "pending" | "confirmed" | "completed" | "cancelled";
          notes: string | null;
          price: number | null;
          discount_amount: number;
          coupon_code: string | null;
          total: number | null;
          payment_status: "pending" | "paid" | "failed";
          razorpay_order_id: string | null;
          payment_ref: string | null;
          meet_link: string | null;
          intake_age: string | null;
          intake_pronouns: string | null;
          intake_occupation: string | null;
          intake_description: string | null;
          intake_energy_level: string | null;
          intake_comfort_level: string | null;
          intake_self_perception: string | null;
          intake_concern: string | null;
          intake_answers: Json | null;
          intake_completed_at: string | null;
          last_notification_status: string | null;
          last_notification_error: string | null;
          last_notification_at: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["appointments"]["Row"]> & {
          therapy_category: string;
        };
        Update: Partial<Database["public"]["Tables"]["appointments"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "appointments_expert_id_fkey";
            columns: ["expert_id"];
            isOneToOne: false;
            referencedRelation: "experts";
            referencedColumns: ["id"];
          },
        ];
      };
      assessments: {
        Row: {
          id: string;
          user_id: string | null;
          guest_session_id: string | null;
          answers: Json;
          recommended_category: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["assessments"]["Row"]> & { answers: Json };
        Update: Partial<Database["public"]["Tables"]["assessments"]["Row"]>;
        Relationships: [];
      };
      business_leads: {
        Row: {
          id: string;
          company_name: string;
          contact_name: string;
          email: string;
          phone: string | null;
          message: string | null;
          status: "new" | "contacted" | "closed";
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["business_leads"]["Row"]> & {
          company_name: string;
          contact_name: string;
          email: string;
        };
        Update: Partial<Database["public"]["Tables"]["business_leads"]["Row"]>;
        Relationships: [];
      };
      contact_messages: {
        Row: {
          id: string;
          name: string;
          email: string;
          phone: string | null;
          message: string | null;
          status: "new" | "contacted" | "closed";
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["contact_messages"]["Row"]> & {
          name: string;
          email: string;
        };
        Update: Partial<Database["public"]["Tables"]["contact_messages"]["Row"]>;
        Relationships: [];
      };
      feedback: {
        Row: {
          id: string;
          name: string;
          email: string | null;
          phone: string | null;
          topic: "feelz" | "counselling" | "website" | "other";
          product: string | null;
          rating: number;
          message: string;
          can_publish: boolean;
          source: string | null;
          status: "new" | "reviewed" | "published";
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["feedback"]["Row"]> & {
          name: string;
          rating: number;
          message: string;
        };
        Update: Partial<Database["public"]["Tables"]["feedback"]["Row"]>;
        Relationships: [];
      };
      expert_blocked_slots: {
        Row: {
          id: string;
          expert_id: string;
          blocked_at: string;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["expert_blocked_slots"]["Row"]> & {
          expert_id: string;
          blocked_at: string;
        };
        Update: Partial<Database["public"]["Tables"]["expert_blocked_slots"]["Row"]>;
        Relationships: [];
      };
      appointment_notes: {
        Row: {
          id: string;
          appointment_id: string;
          expert_id: string;
          notes: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["appointment_notes"]["Row"]> & {
          appointment_id: string;
          expert_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["appointment_notes"]["Row"]>;
        Relationships: [];
      };
      inventory_transactions: {
        Row: {
          id: string;
          transaction_date: string;
          transaction_type: "received" | "shipped" | "online_sale";
          variant_id: string;
          location_id: string | null;
          quantity_in: number | null;
          quantity_out: number | null;
          notes: string | null;
          created_by: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["inventory_transactions"]["Row"]> & {
          transaction_date: string;
          transaction_type: "received" | "shipped" | "online_sale";
          variant_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["inventory_transactions"]["Row"]>;
        Relationships: [];
      };
      misplaced_stock_logs: {
        Row: {
          id: string;
          log_date: string;
          variant_id: string;
          location_id: string | null;
          quantity: number;
          notes: string | null;
          created_by: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["misplaced_stock_logs"]["Row"]> & {
          log_date: string;
          variant_id: string;
          quantity: number;
        };
        Update: Partial<Database["public"]["Tables"]["misplaced_stock_logs"]["Row"]>;
        Relationships: [];
      };
      faqs: {
        Row: {
          id: string;
          category: string;
          question: string;
          answer: string;
          sort_order: number;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["faqs"]["Row"]> & {
          category: string;
          question: string;
          answer: string;
        };
        Update: Partial<Database["public"]["Tables"]["faqs"]["Row"]>;
        Relationships: [];
      };
      milestones: {
        Row: {
          id: string;
          year: string;
          title: string;
          description: string | null;
          sort_order: number;
        };
        Insert: Partial<Database["public"]["Tables"]["milestones"]["Row"]> & { year: string; title: string };
        Update: Partial<Database["public"]["Tables"]["milestones"]["Row"]>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      record_feelz_page: {
        Args: { p_event: string; p_visitor: string; p_product: boolean; p_campaign: Json };
        Returns: undefined;
      };
      record_feelz_cart_campaign: {
        Args: { p_cart: string; p_guest: string | null; p_campaign: Json; p_checkout: boolean };
        Returns: undefined;
      };
      feelz_campaign_funnel: {
        Args: { p_from: string; p_through: string };
        Returns: { campaign: Json; visitors: number; page_views: number; product_views: number;
          carts: number; checkouts: number; paid_orders: number; revenue_inr: number; unpaid_24h: number }[];
      };
      record_storefront_visit: {
        Args: { p_visitor: string };
        Returns: undefined;
      };
      storefront_funnel: {
        Args: { p_from: string; p_through: string };
        Returns: {
          visitors: number;
          carts_with_add: number;
          paid_orders: number;
          carts_without_payment_24h: number;
          carts_still_open_24h: number;
        }[];
      };
      track_order: {
        Args: { p_order_number: string; p_phone: string };
        Returns: Json;
      };
      available_stock: {
        Args: { p_variant_id: string; p_location_id: string | null };
        Returns: number;
      };
      create_stock_reservation: {
        Args: { p_cart_id: string; p_variant_id: string; p_location_id: string | null; p_quantity: number };
        Returns: string;
      };
      confirm_cash_order: {
        Args: { p_order_id: string };
        Returns: string;
      };
      confirmed_sessions_count: {
        Args: Record<string, never>;
        Returns: number;
      };
      admin_cancel_order: {
        Args: { p_order_id: string };
        Returns: undefined;
      };
      admin_set_order_item_quantity: {
        Args: { p_order_id: string; p_item_id: string; p_new_quantity: number };
        Returns: undefined;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
