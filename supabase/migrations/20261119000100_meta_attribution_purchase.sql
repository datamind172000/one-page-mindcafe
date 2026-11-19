-- Apply in Supabase before deploying the updated create-order Edge Function.
-- Attribution is private order metadata; it must never be included in Meta events.
alter table public.orders
  add column if not exists attribution jsonb not null default '{}'::jsonb;

comment on column public.orders.attribution is
  'First-touch marketing attribution: utm_source, utm_medium, utm_campaign, utm_content, fbclid. Private order metadata.';

-- Durable, authenticated, once-only Purchase claim. Returns only safe
-- commerce data, and never returns an event for unpaid/cancelled orders.
alter table public.orders
  add column if not exists meta_purchase_claimed_at timestamptz;

create or replace function public.claim_meta_purchase(p_order_id uuid)
returns table (event_id text, value numeric, content_ids text[])
language plpgsql
security definer
set search_path = public
as $$
declare v_order public.orders%rowtype;
begin
  update public.orders
     set meta_purchase_claimed_at = now()
   where id = p_order_id
     and user_id = auth.uid()
     and auth.uid() is not null
     and payment_status = 'paid'
     and meta_purchase_claimed_at is null
  returning * into v_order;

  if not found then return; end if;

  return query
    select v_order.id::text,
           v_order.total::numeric,
           coalesce(array_agg(distinct pv.product_id::text)
             filter (where pv.product_id is not null), '{}'::text[])
    from public.order_items oi
    left join public.product_variants pv on pv.id = oi.variant_id
    where oi.order_id = v_order.id;
end;
$$;

revoke all on function public.claim_meta_purchase(uuid) from public, anon;
grant execute on function public.claim_meta_purchase(uuid) to authenticated;
