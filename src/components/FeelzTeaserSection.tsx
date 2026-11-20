import Image from "next/image";

// MindCafe highlights Feelz as a sister offering. Shopping and product data
// are now served exclusively from the independent Feelz storefront.
export function FeelzTeaserSection() {
  return (
    <section id="feelz-teaser" className="bg-white px-5 py-20 sm:px-8 sm:py-28">
      <div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-2 lg:gap-16">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-ink/50">Introducing Feelz by MindCafe</p>
          <h2 className="font-display mt-5 text-4xl font-bold leading-tight tracking-tight text-ink sm:text-5xl">
            Elevate your mood with Feelz
          </h2>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-ink/70">
            Discover Feelz mood strips from MindCafe. Explore the collection,
            learn about the products, and shop on the dedicated Feelz website.
          </p>
          <a
            href="https://feelz.mindcafe.app"
            className="pill-btn mt-8 inline-flex items-center justify-center gap-2"
          >
            Explore Feelz <span aria-hidden="true">↗</span>
          </a>
        </div>
        <a href="https://feelz.mindcafe.app" aria-label="Explore the Feelz website" className="group block overflow-hidden rounded-3xl bg-cream">
          <Image
            src="/feelz-creative/00-feelz-bundle-hero-v4.webp"
            alt="Feelz product collection"
            width={1200}
            height={900}
            sizes="(min-width: 1024px) 50vw, 100vw"
            className="h-auto w-full transition-transform duration-500 group-hover:scale-[1.03]"
          />
        </a>
      </div>
    </section>
  );
}
