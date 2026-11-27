import { createClient } from "@/lib/supabase/server";

type SearchParams = Promise<{ from?: string; through?: string; metric?: string; group?: string; page?: string }>;

const metricLabels = { carts: "Carts", checkouts: "Checkouts", paid: "Paid orders", unpaid: "Unpaid after 24 hours" } as const;
type Metric = keyof typeof metricLabels;
const detailsDate = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

function readGroup(raw: unknown): Record<string, string> | null {
  if (typeof raw !== "string" || raw.length > 1100) return null;
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value) &&
      Object.values(value).every(item => typeof item === "string")) return value;
  } catch {}
  return null;
}

function dateInIndia(date: Date) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Kolkata" }).format(date);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}

const countFormat = new Intl.NumberFormat("en-IN");

export default async function StorefrontFunnel({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const today = new Date();
  const defaultFrom = dateInIndia(new Date(+today - 6 * 86_400_000));
  const defaultThrough = dateInIndia(today);
  const from = params.from ?? defaultFrom;
  const through = params.through ?? defaultThrough;
  const valid = isDate(from) && isDate(through) && from <= through &&
    +new Date(through) - +new Date(from) <= 90 * 86_400_000;

  const db = valid ? await createClient() : null;
  const args = { p_from: from, p_through: through };
  const metric = typeof params.metric === "string" && Object.hasOwn(metricLabels, params.metric)
    ? params.metric as Metric : null;
  const group = readGroup(params.group);
  const offset = /^\d{1,6}$/.test(params.page ?? "") ? Number(params.page) * 50 : 0;
  const detailLink = (m: Metric, tags: Record<string, string>, part = 0) =>
    `?${new URLSearchParams({ from, through, metric: m, group: JSON.stringify(tags), page: String(part) })}#campaign-records`;
  const [report, breakdown, details] = db ? await Promise.all([
    db.rpc("storefront_funnel", args).single(),
    db.rpc("feelz_campaign_funnel", args),
    metric && group ? db.rpc("feelz_campaign_records", { ...args, p_metric: metric, p_campaign: group, p_offset: offset }) : null,
  ]) : [null, null, null];
  const data = report?.data;

  return (
    <section>
      <h1 className="font-display text-3xl font-bold">Storefront funnel</h1>
      <p className="mt-2 text-sm text-ink/70">Feelz storefront and product pages. Dates are in India time.</p>
      <form className="mt-6 flex flex-wrap items-end gap-3" method="get">
        <label className="grid gap-1 text-sm">
          From
          <input className="rounded border border-ink/20 px-2 py-1" type="date" name="from"
            defaultValue={isDate(from) ? from : defaultFrom} required />
        </label>
        <label className="grid gap-1 text-sm">
          Through
          <input className="rounded border border-ink/20 px-2 py-1" type="date" name="through"
            defaultValue={isDate(through) ? through : defaultThrough} required />
        </label>
        <button className="pill-btn" type="submit">Apply dates</button>
      </form>
      {!valid && <p role="alert" className="mt-6">Choose a date range of 1 to 91 days.</p>}
      {valid && !data && <p role="alert" className="mt-6">The report is unavailable. Check admin access and try again.</p>}
      {data && (
        <>
          <dl className="mt-6 grid gap-3 sm:grid-cols-2">
            {[
              ["Storefront visitors", data.visitors],
              ["Carts with a successful add", data.carts_with_add],
              ["Paid orders", data.paid_orders],
              ["Carts unpaid after 24 hours", data.carts_without_payment_24h],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-ink/10 p-4">
                <dt className="text-sm text-ink/70">{label}</dt>
                <dd className="mt-1 text-2xl font-bold">{countFormat.format(Number(value))}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-5 text-sm text-ink/70">
            Visitors are unique browsers. A cart attempt starts on a saved add. Another add after 24 hours
            can start a new attempt on the same cart. Paid orders are counted on the day payment is
            confirmed, including payments received after 24 hours.
          </p>
          <p className="mt-2 text-sm text-ink/70">
            {countFormat.format(data.carts_still_open_24h)} unpaid carts are still within their 24-hour window.
            Reporting starts when collection is enabled.
          </p>
        </>
      )}
      {valid && data && (
        <section className="mt-8">
          <h2 className="font-display text-xl font-bold">Campaign and ad performance</h2>
          <p className="my-2 text-sm text-ink/70">Latest tagged visit within seven days. Cart attribution is saved on the cart attempt. Paid orders use payment confirmation dates. Untagged traffic is unattributed.</p>
          {breakdown?.error && <p role="alert">Campaign breakdown is unavailable.</p>}
          {breakdown?.data?.length === 0 && <p>No campaign activity in this period.</p>}
          {!!breakdown?.data?.length && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr>{["Source", "Medium", "Campaign", "Content", "Ad set", "Ad", "Visitors", "Page views", "Product views", "Carts", "Checkouts", "Paid orders", "Revenue (INR)", "Unpaid after 24h"].map(label =>
                  <th key={label} scope="col" className="border-b p-2">{label}</th>
                )}</tr></thead>
                <tbody>{breakdown.data.map(row => {
                  const tags = row.campaign as Record<string, string>;
                  return <tr key={JSON.stringify(tags)} className="border-b">
                    {[tags.utm_source || "Unattributed", tags.utm_medium, [tags.utm_campaign, tags.campaign_id].filter(Boolean).join(" · "), tags.utm_content, tags.adset_id, tags.ad_id].map((value, index) =>
                      <td key={index} className="p-2">{value || "—"}</td>)}
                    {[row.visitors, row.page_views, row.product_views, row.carts, row.checkouts, row.paid_orders, row.revenue_inr, row.unpaid_24h].map((value, index) => {
                      const m = ([null, null, null, "carts", "checkouts", "paid", "paid", "unpaid"] as const)[index];
                      const formatted = countFormat.format(Number(value));
                      return <td key={index} className="p-2 tabular-nums">{m && Number(value) > 0
                        ? <a className="underline" href={detailLink(m, tags)}
                            aria-label={`View ${metricLabels[m]} records for ${tags.utm_source || "unattributed traffic"}`}>{formatted}</a>
                        : formatted}</td>;
                    })}
                  </tr>;
                })}</tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {metric && group && details && (
        <section id="campaign-records" className="mt-8 scroll-mt-24">
          <h2 className="font-display text-xl font-bold">{metricLabels[metric]}</h2>
          <p className="my-2 text-sm text-ink/70">
            {[group.utm_source || "Unattributed", group.utm_campaign, group.ad_id && `Ad ${group.ad_id}`].filter(Boolean).join(" · ")}.
            Contact details appear only where MindCafe already has them. Check contact permission before outreach.
            {metric === "unpaid" && " Some carts may have paid after the 24-hour window. Check payment status before contacting anyone."}
          </p>
          {details.error && <p role="alert">Unable to load campaign records.</p>}
          {details.data?.length === 0 && <p>No matching records on this page.</p>}
          {!!details.data?.length && <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead><tr>{["Time (IST)", "Cart attempt", "Customer", "Phone", "Email", "Order", "Payment", "Order total (INR)"].map(label =>
                <th key={label} scope="col" className="border-b p-2">{label}</th>)}</tr></thead>
              <tbody>{details.data.map(row => <tr key={row.attempt_id ?? row.order_number} className="border-b">
                <td className="p-2">{detailsDate.format(new Date(row.happened_at))}</td>
                <td className="p-2">{row.attempt_id ?? "—"}</td>
                <td className="p-2">{row.customer_name || (row.phone || row.email ? "Name unavailable" : "No contact on file")}</td>
                <td className="p-2">{row.phone ?? "—"}</td>
                <td className="p-2">{row.email ?? "—"}</td>
                <td className="p-2">{row.order_number ?? "—"}</td>
                <td className="p-2">{row.payment_status?.replaceAll("_", " ") ?? "No order"}{row.paid_at && ` · ${detailsDate.format(new Date(row.paid_at))}`}</td>
                <td className="p-2">{row.total_inr == null ? "—" : countFormat.format(Number(row.total_inr))}</td>
              </tr>)}</tbody>
            </table>
          </div>}
          <nav className="mt-3 flex gap-4" aria-label="Campaign record pages">
            {offset > 0 && <a className="underline" href={detailLink(metric, group, offset / 50 - 1)}>Previous</a>}
            {Number(details.data?.[0]?.total_rows ?? 0) > offset + 50 &&
              <a className="underline" href={detailLink(metric, group, offset / 50 + 1)}>Next</a>}
          </nav>
        </section>
      )}
    </section>
  );
}
