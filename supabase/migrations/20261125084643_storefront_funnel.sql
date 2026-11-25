-- First-party Feelz funnel. Keep raw identifiers outside the exposed schema.
create schema storefront_analytics;
revoke all on schema storefront_analytics from public;
grant usage on schema storefront_analytics to anon, authenticated;

create table storefront_analytics.visits (
  visitor_id uuid not null,
  visit_day date not null default ((now() at time zone 'Asia/Kolkata')::date),
  primary key (visit_day, visitor_id)
);
create table storefront_analytics.cart_attempts (
  id bigint generated always as identity primary key,
  cart_id uuid not null,
  first_add_at timestamptz not null default now(),
  order_id uuid unique,
  superseded boolean not null default false
);
create unique index storefront_open_cart_idx on storefront_analytics.cart_attempts (cart_id)
  where order_id is null and not superseded;
create index storefront_cart_cohort_idx on storefront_analytics.cart_attempts (first_add_at)
  where not superseded;
create table storefront_analytics.paid_orders (
  order_id uuid primary key,
  paid_at timestamptz not null default now()
);
create index storefront_paid_at_idx on storefront_analytics.paid_orders (paid_at);

alter table storefront_analytics.visits enable row level security;
alter table storefront_analytics.cart_attempts enable row level security;
alter table storefront_analytics.paid_orders enable row level security;

grant insert (visitor_id) on storefront_analytics.visits to anon, authenticated;
grant select on storefront_analytics.visits, storefront_analytics.cart_attempts,
  storefront_analytics.paid_orders to authenticated;

create policy storefront_visit_insert on storefront_analytics.visits
  for insert to anon, authenticated with check (true);
create policy storefront_visit_admin_read on storefront_analytics.visits
  for select to authenticated using ((select public.is_admin()));
create policy storefront_cart_admin_read on storefront_analytics.cart_attempts
  for select to authenticated using ((select public.is_admin()));
create policy storefront_paid_admin_read on storefront_analytics.paid_orders
  for select to authenticated using ((select public.is_admin()));

create function public.record_storefront_visit(p_visitor uuid) returns void
language sql security invoker set search_path = ''
as $$
  insert into storefront_analytics.visits (visitor_id)
  values (p_visitor)
  on conflict do nothing;
$$;
revoke all on function public.record_storefront_visit(uuid) from public;
grant execute on function public.record_storefront_visit(uuid) to anon, authenticated;

-- Store the merge destination when the existing guest-cart merge completes.
alter table public.carts add column funnel_merged_into uuid;

create function storefront_analytics.record_cart_add() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.quantity <= old.quantity then return new; end if;
  end if;

  if not exists (select 1 from public.carts where id = new.cart_id and status = 'active') then
    return new;
  end if;

  insert into storefront_analytics.cart_attempts (cart_id)
  values (new.cart_id)
  on conflict (cart_id) where order_id is null and not superseded do nothing;
  return new;
end;
$$;

create function storefront_analytics.merge_cart_attempt() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  guest_first_add timestamptz;
begin
  if not exists (
    select 1 from public.carts
    where id = new.funnel_merged_into and user_id = auth.uid() and status = 'active'
  ) then
    return new;
  end if;

  update storefront_analytics.cart_attempts
    set superseded = true
    where cart_id = new.id and order_id is null and not superseded
    returning first_add_at into guest_first_add;

  if guest_first_add is not null then
    insert into storefront_analytics.cart_attempts (cart_id, first_add_at)
    values (new.funnel_merged_into, guest_first_add)
    on conflict (cart_id) where order_id is null and not superseded
    do update set first_add_at = least(
      storefront_analytics.cart_attempts.first_add_at, excluded.first_add_at
    );
  end if;
  return new;
end;
$$;

create function storefront_analytics.record_order() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.source_cart_id is null then return new; end if;
  -- Order writes from the storefront's Edge Functions use service_role.
  -- Ordinary customer writes must never attach an order or count as payment.
  if current_setting('role', true) in ('anon', 'authenticated') and not public.is_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    update storefront_analytics.cart_attempts
      set order_id = new.id
      where cart_id = new.source_cart_id and order_id is null and not superseded;
  elsif old.payment_status = 'paid' then
    return new;
  end if;

  if new.payment_status = 'paid' then
    insert into storefront_analytics.paid_orders (order_id)
    values (new.id)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

revoke all on function storefront_analytics.record_cart_add() from public;
revoke all on function storefront_analytics.merge_cart_attempt() from public;
revoke all on function storefront_analytics.record_order() from public;

create trigger storefront_cart_add
after insert or update of quantity on public.cart_items
for each row execute function storefront_analytics.record_cart_add();

create trigger storefront_cart_merge
after update of status on public.carts
for each row when (
  old.status = 'active' and new.status = 'merged'
  and old.user_id is null and new.funnel_merged_into is not null
) execute function storefront_analytics.merge_cart_attempt();

create trigger storefront_order
after insert or update of payment_status on public.orders
for each row execute function storefront_analytics.record_order();

create function public.storefront_funnel(p_from date, p_through date)
returns table (visitors bigint, carts_with_add bigint, paid_orders bigint,
  carts_without_payment_24h bigint, carts_still_open_24h bigint)
language plpgsql stable security invoker set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Storefront report requires admin access' using errcode = '42501';
  end if;
  if p_from is null or p_through is null or p_through < p_from or p_through - p_from > 90 then
    raise exception 'Choose a date range of 1 to 91 days' using errcode = '22023';
  end if;
  return query
  with bounds as (
    select p_from::timestamp at time zone 'Asia/Kolkata' as starts_at,
           (p_through + 1)::timestamp at time zone 'Asia/Kolkata' as ends_at
  ),
  carts as (
    select
      count(*) as added,
      count(*) filter (
        where now() >= c.first_add_at + interval '24 hours'
          and (p.paid_at is null or p.paid_at > c.first_add_at + interval '24 hours')
      ) as abandoned,
      count(*) filter (
        where now() < c.first_add_at + interval '24 hours' and p.paid_at is null
      ) as awaiting_payment
    from storefront_analytics.cart_attempts c
    cross join bounds b
    left join storefront_analytics.paid_orders p on p.order_id = c.order_id
    where not c.superseded and c.first_add_at >= b.starts_at and c.first_add_at < b.ends_at
  )
  select
    (select count(distinct visitor_id) from storefront_analytics.visits
      where visit_day between p_from and p_through),
    carts.added,
    (select count(*) from storefront_analytics.paid_orders p cross join bounds b
      where p.paid_at >= b.starts_at and p.paid_at < b.ends_at),
    carts.abandoned,
    carts.awaiting_payment
  from carts;
end;
$$;
revoke all on function public.storefront_funnel(date, date) from public, anon;
grant execute on function public.storefront_funnel(date, date) to authenticated;
