import { createClient } from "@/lib/supabase/server";

type SearchParams = Promise<{ from?: string; through?: string }>;

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

  const report = valid
    ? await (await createClient()).rpc("storefront_funnel", { p_from: from, p_through: through }).single()
    : null;
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
            Visitors are unique browsers. Carts are grouped by the first saved add. Paid orders are counted
            on the day payment is confirmed. A payment after 24 hours still counts as a paid order.
          </p>
          <p className="mt-2 text-sm text-ink/70">
            {countFormat.format(data.carts_still_open_24h)} unpaid carts are still within their 24-hour window.
            Reporting starts when collection is enabled.
          </p>
        </>
      )}
    </section>
  );
}
