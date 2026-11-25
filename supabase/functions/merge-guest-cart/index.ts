// Called right after login to merge a guest's session-based cart into
// their permanent account cart. Uses the caller's own JWT throughout —
// RLS already permits an authenticated user to read/write both their own
// cart and any guest cart (user_id IS NULL), so no service-role privilege
// is needed for this operation.
import { userScopedClient } from "../_shared/supabaseClients.ts";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const { guest_session_id } = await req.json();
  if (!guest_session_id) return jsonResponse({ error: "guest_session_id is required" }, 400);

  const sb = userScopedClient(req);
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

  const { data: guestCart } = await sb
    .from("carts")
    .select("id")
    .eq("session_id", guest_session_id)
    .eq("status", "active")
    .maybeSingle();

  if (!guestCart) return jsonResponse({ merged: false, reason: "no guest cart" });

  let userCart = (
    await sb.from("carts").select("id").eq("user_id", user.id).eq("status", "active").maybeSingle()
  ).data;

  if (!userCart) {
    const { data: created, error: createError } = await sb
      .from("carts")
      .insert({ user_id: user.id })
      .select("id")
      .single();
    if (createError || !created) return jsonResponse({ error: "Failed to create user cart" }, 500);
    userCart = created;
  }

  const { data: guestItems } = await sb.from("cart_items").select("variant_id, quantity").eq("cart_id", guestCart.id);

  for (const item of guestItems ?? []) {
    const { data: existing } = await sb
      .from("cart_items")
      .select("id, quantity")
      .eq("cart_id", userCart.id)
      .eq("variant_id", item.variant_id)
      .maybeSingle();

    if (existing) {
      await sb.from("cart_items").update({ quantity: existing.quantity + item.quantity }).eq("id", existing.id);
    } else {
      await sb.from("cart_items").insert({ cart_id: userCart.id, variant_id: item.variant_id, quantity: item.quantity });
    }
  }

  await sb.from("carts").update({ status: "merged", funnel_merged_into: userCart.id }).eq("id", guestCart.id);

  return jsonResponse({ merged: true });
});
