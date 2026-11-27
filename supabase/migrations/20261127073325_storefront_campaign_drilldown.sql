create function public.feelz_campaign_records(p_from date,p_through date,p_campaign jsonb,p_metric text,p_offset integer default 0)
returns table(attempt_id bigint, happened_at timestamptz, customer_name text, phone text, email text,
  order_number text, payment_status text, paid_at timestamptz, total_inr numeric, total_rows bigint)
language plpgsql stable security invoker set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'Admin access required' using errcode='42501'; end if;
  if p_from is null or p_through is null or p_through<p_from or p_through-p_from>90
    or p_metric is null or p_metric not in ('carts','checkouts','paid','unpaid')
    or p_offset is null or p_offset<0 or jsonb_typeof(p_campaign) is distinct from 'object'
    or octet_length(p_campaign::text)>1100
  then raise exception 'Invalid storefront drill-down filters' using errcode='22023'; end if;

  return query
  with bounds as (
    select p_from::timestamp at time zone 'Asia/Kolkata' lo,(p_through+1)::timestamp at time zone 'Asia/Kolkata' hi
  ), matching as (
    select a.id, a.cart_id, a.order_id, p.paid_at payment_time,
      case when p_metric='checkouts' then a.checkout_at else a.first_add_at end metric_time
    from storefront_analytics.cart_attempts a cross join bounds b
    left join storefront_analytics.paid_orders p on p.order_id=a.order_id
    where p_metric<>'paid' and not a.superseded and coalesce(a.campaign,'{}')=p_campaign
      and case when p_metric='checkouts' then a.checkout_at>=b.lo and a.checkout_at<b.hi
        else a.first_add_at>=b.lo and a.first_add_at<b.hi end
      and (p_metric<>'unpaid' or (now()>=a.first_add_at+interval '24 hours'
        and (p.paid_at is null or p.paid_at>a.first_add_at+interval '24 hours')))
    union all
    select a.id,a.cart_id,p.order_id,p.paid_at,p.paid_at
    from storefront_analytics.paid_orders p cross join bounds b
    left join storefront_analytics.cart_attempts a on a.order_id=p.order_id
    where p_metric='paid' and p.paid_at>=b.lo and p.paid_at<b.hi and coalesce(a.campaign,'{}')=p_campaign
  ), paged as (
    select m.*, count(*) over() row_count from matching m
    order by m.metric_time desc,m.id desc,m.order_id desc offset p_offset limit 50
  )
  select m.id,m.metric_time,
    coalesce(nullif(trim(o.guest_name),''),nullif(trim(pr.full_name),'')),
    coalesce(nullif(trim(o.guest_phone),''),nullif(trim(pr.phone),'')),
    nullif(trim(o.guest_email),''),o.order_number,o.payment_status,m.payment_time,o.total::numeric,m.row_count
  from paged m
  left join public.orders o on o.id=m.order_id
  left join public.carts c on c.id=m.cart_id
  left join public.profiles pr on pr.id=coalesce(o.user_id,c.user_id)
  order by m.metric_time desc,m.id desc,m.order_id desc;
end;
$$;
revoke all on function public.feelz_campaign_records(date,date,jsonb,text,integer) from public, anon;
grant execute on function public.feelz_campaign_records(date,date,jsonb,text,integer) to authenticated;
