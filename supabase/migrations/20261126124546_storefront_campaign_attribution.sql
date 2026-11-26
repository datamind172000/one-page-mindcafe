alter table storefront_analytics.cart_attempts
  add column campaign jsonb,
  add column checkout_at timestamptz;

create table storefront_analytics.page_views (
  event_id uuid primary key,
  visitor_id uuid not null,
  viewed_at timestamptz not null default now(),
  product_view boolean not null,
  campaign jsonb not null
);
create index storefront_page_view_time_idx on storefront_analytics.page_views(viewed_at);
alter table storefront_analytics.page_views enable row level security;
grant insert (event_id, visitor_id, product_view, campaign) on storefront_analytics.page_views to anon, authenticated;
grant select on storefront_analytics.page_views to authenticated;
create policy storefront_page_view_insert on storefront_analytics.page_views for insert to anon, authenticated
  with check (jsonb_typeof(campaign) = 'object' and octet_length(campaign::text) <= 1100);
create policy storefront_page_view_admin on storefront_analytics.page_views for select to authenticated
  using ((select public.is_admin()));

create function storefront_analytics.clean_campaign(input jsonb) returns jsonb
language sql immutable security invoker set search_path = ''
as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
  from jsonb_each_text(case when jsonb_typeof(input) = 'object' then input else '{}'::jsonb end)
  where (key in ('utm_source','utm_medium','utm_campaign','utm_content') and value ~ '^[[:alnum:] _./+%-]{1,100}$')
     or (key in ('campaign_id','adset_id','ad_id') and value ~ '^[0-9]{1,24}$')
$$;
revoke all on function storefront_analytics.clean_campaign(jsonb) from public;
grant execute on function storefront_analytics.clean_campaign(jsonb) to anon, authenticated;

create function public.record_feelz_page(p_event uuid,p_visitor uuid,p_product boolean,p_campaign jsonb) returns void
language sql security invoker set search_path = ''
as $$
  insert into storefront_analytics.page_views(event_id,visitor_id,product_view,campaign)
  values (p_event,p_visitor,p_product,storefront_analytics.clean_campaign(p_campaign))
  on conflict do nothing;
  select public.record_storefront_visit(p_visitor);
$$;
revoke all on function public.record_feelz_page(uuid,uuid,boolean,jsonb) from public;
grant execute on function public.record_feelz_page(uuid,uuid,boolean,jsonb) to anon, authenticated;

create function storefront_analytics.attach_campaign(p_cart uuid,p_guest uuid,p_campaign jsonb,p_checkout boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  target_cart uuid;
  clean jsonb := storefront_analytics.clean_campaign(p_campaign);
begin
  select coalesce(c.funnel_merged_into,c.id) into target_cart from public.carts c
  where c.id=p_cart and (
    (c.user_id is not null and c.user_id=auth.uid())
    or (c.user_id is null and c.session_id=p_guest)
  );
  if target_cart is null then return; end if;

  update storefront_analytics.cart_attempts a
  set campaign=coalesce(a.campaign,nullif(clean,'{}'::jsonb)),
      checkout_at=case when p_checkout then coalesce(a.checkout_at,now()) else a.checkout_at end
  where a.id=(
    select id from storefront_analytics.cart_attempts
    where cart_id=target_cart and not superseded and closed_at is null
    order by (order_id is null) desc,id desc limit 1
  )
  and (a.order_id is null or a.first_add_at > now()-interval '15 minutes');
end;
$$;
revoke all on function storefront_analytics.attach_campaign(uuid,uuid,jsonb,boolean) from public;
grant execute on function storefront_analytics.attach_campaign(uuid,uuid,jsonb,boolean) to anon, authenticated;
create function public.record_feelz_cart_campaign(p_cart uuid,p_guest uuid,p_campaign jsonb,p_checkout boolean)
returns void language sql security invoker set search_path = ''
as $$ select storefront_analytics.attach_campaign(p_cart,p_guest,p_campaign,p_checkout) $$;
revoke all on function public.record_feelz_cart_campaign(uuid,uuid,jsonb,boolean) from public;
grant execute on function public.record_feelz_cart_campaign(uuid,uuid,jsonb,boolean) to anon, authenticated;

-- Run after storefront_cart_merge so the existing merge has created its destination attempt.
create function storefront_analytics.move_campaign() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.carts where id=new.funnel_merged_into and user_id=auth.uid() and status='active')
  then return new; end if;
  update storefront_analytics.cart_attempts dst
  set campaign=coalesce(src.campaign,dst.campaign),
      checkout_at=least(src.checkout_at,dst.checkout_at)
  from lateral (
    select campaign,checkout_at from storefront_analytics.cart_attempts
    where cart_id=new.id and superseded and closed_at is null
    order by id desc limit 1
  ) src
  where dst.cart_id=new.funnel_merged_into and dst.order_id is null and dst.closed_at is null and not dst.superseded;
  return new;
end;
$$;
revoke all on function storefront_analytics.move_campaign() from public;
create trigger storefront_zz_campaign_merge after update of status on public.carts for each row
when (old.status='active' and new.status='merged' and old.user_id is null and new.funnel_merged_into is not null)
execute function storefront_analytics.move_campaign();

create function public.feelz_campaign_funnel(p_from date,p_through date)
returns table(campaign jsonb,visitors bigint,page_views bigint,product_views bigint,carts bigint,checkouts bigint,paid_orders bigint,revenue_inr numeric,unpaid_24h bigint)
language plpgsql stable security invoker set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'Admin access required' using errcode='42501'; end if;
  if p_from is null or p_through is null or p_through<p_from or p_through-p_from>90
  then raise exception 'Choose a date range of 1 to 91 days' using errcode='22023'; end if;
  return query
  with bounds as (
    select p_from::timestamp at time zone 'Asia/Kolkata' lo,(p_through+1)::timestamp at time zone 'Asia/Kolkata' hi
  ), pages as (
    select v.campaign dim,count(distinct v.visitor_id) visitors,count(*) views,count(*) filter(where v.product_view) products
    from storefront_analytics.page_views v,bounds b where v.viewed_at>=b.lo and v.viewed_at<b.hi group by 1
  ), attempts as (
    select coalesce(a.campaign,'{}') dim,
      count(*) filter(where a.first_add_at>=b.lo and a.first_add_at<b.hi) adds,
      count(*) filter(where a.checkout_at>=b.lo and a.checkout_at<b.hi) starts,
      count(*) filter(where a.first_add_at>=b.lo and a.first_add_at<b.hi and now()>=a.first_add_at+interval '24 hours'
        and (p.paid_at is null or p.paid_at>a.first_add_at+interval '24 hours')) unpaid
    from storefront_analytics.cart_attempts a cross join bounds b
    left join storefront_analytics.paid_orders p on p.order_id=a.order_id
    where not a.superseded and ((a.first_add_at>=b.lo and a.first_add_at<b.hi) or (a.checkout_at>=b.lo and a.checkout_at<b.hi)) group by 1
  ), payments as (
    select coalesce(a.campaign,'{}') dim,count(*) paid,coalesce(sum(o.total),0)::numeric revenue
    from storefront_analytics.paid_orders p cross join bounds b
    left join storefront_analytics.cart_attempts a on a.order_id=p.order_id
    left join public.orders o on o.id=p.order_id
    where p.paid_at>=b.lo and p.paid_at<b.hi group by 1
  )
  select dim,coalesce(v.visitors,0),coalesce(v.views,0),coalesce(v.products,0),coalesce(a.adds,0),coalesce(a.starts,0),
    coalesce(p.paid,0),coalesce(p.revenue,0),coalesce(a.unpaid,0)
  from pages v full join attempts a using(dim) full join payments p using(dim)
  order by coalesce(p.paid,0) desc,coalesce(v.views,0) desc,dim;
end;
$$;
revoke all on function public.feelz_campaign_funnel(date,date) from public, anon;
grant execute on function public.feelz_campaign_funnel(date,date) to authenticated;
