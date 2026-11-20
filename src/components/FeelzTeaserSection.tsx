"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { motion, useReducedMotion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getFeelzTeaser } from "@/lib/api";
import { moodStyleFor, type MoodStyle } from "@/lib/moodStyles";
import { FEELZ_PRODUCT_PAGES } from "@/lib/feelzProductPages";
import { FEELZ_INGREDIENTS, type FeelzMoodKey } from "@/lib/feelzIngredients";
import { formatInr } from "@/lib/utils";
import { Modal } from "@/components/Modal";
import type { Product } from "@/types/domain";

type TeaserProduct = Pick<Product, "id" | "name" | "image_url" | "price">;

// CHAPTER 2 — the breath after the hero.
//
// A plain white section. It previously carried a tinted dissolve, three
// ambient colour fields, a drifting thread and a grain texture; all of that
// was removed on request, leaving only content and its scroll reveals.
//
// The single remaining background element is a short, entirely neutral
// dark-to-white blend at the very top — without it the hero's near-black
// would meet white as a hard horizontal line.
const EASE = [0.22, 0.61, 0.36, 1] as const;

// Each card picks up its own pack colour: a tinted wash, border, accent
// bar, "Best for" panel and ingredient pills. Literal class strings so
// Tailwind generates them. Extrovert's orange is too light to read as text
// on white, so its text uses a deeper amber.
const CARD_ACCENTS: Record<
  MoodStyle["feelzColor"],
  { card: string; bar: string; text: string; panel: string; pill: string }
> = {
  "feelz-orange": {
    card: "border-feelz-orange/25 to-feelz-orange/[0.09] hover:border-feelz-orange/50 hover:shadow-[0_18px_40px_-24px_rgba(219,139,29,0.6)]",
    bar: "bg-feelz-orange",
    text: "text-[#94560a]",
    panel: "bg-feelz-orange/[0.1]",
    pill: "bg-feelz-orange/[0.16] text-[#7a4708]",
  },
  "feelz-navy": {
    card: "border-feelz-navy/20 to-feelz-navy/[0.06] hover:border-feelz-navy/40 hover:shadow-[0_18px_40px_-24px_rgba(36,59,125,0.55)]",
    bar: "bg-feelz-navy",
    text: "text-feelz-navy",
    panel: "bg-feelz-navy/[0.07]",
    pill: "bg-feelz-navy/[0.1] text-feelz-navy",
  },
  "feelz-berry": {
    card: "border-feelz-berry/20 to-feelz-berry/[0.07] hover:border-feelz-berry/40 hover:shadow-[0_18px_40px_-24px_rgba(143,66,102,0.55)]",
    bar: "bg-feelz-berry",
    text: "text-feelz-berry",
    panel: "bg-feelz-berry/[0.08]",
    pill: "bg-feelz-berry/[0.12] text-feelz-berry",
  },
  "feelz-rest": {
    card: "border-feelz-rest/20 to-feelz-rest/[0.07] hover:border-feelz-rest/40 hover:shadow-[0_18px_40px_-24px_rgba(74,63,122,0.55)]",
    bar: "bg-feelz-rest",
    text: "text-feelz-rest",
    panel: "bg-feelz-rest/[0.08]",
    pill: "bg-feelz-rest/[0.12] text-feelz-rest",
  },
};

export function FeelzTeaserSection() {
  const teaserQuery = useQuery({
    queryKey: ["products", "feelz-teaser"],
    queryFn: () => getFeelzTeaser(createClient()),
  });
  const products = teaserQuery.data ?? [];
  const [lightboxProduct, setLightboxProduct] = useState<TeaserProduct | null>(null);

  const reduced = !!useReducedMotion();

  // The scroll-linked ambient drift that used to live here (two glow fields
  // and the thread) is gone along with the layers it moved, so the section
  // no longer runs any scroll listener at all.

  const headingStagger = {
    hidden: {},
    show: { transition: { staggerChildren: 0.16, delayChildren: 0.05 } },
  };

  /** Rises from behind a clipping mask — the line's own overflow-hidden
   *  parent is what makes it read as revealed rather than faded in. */
  const maskLine = {
    hidden: { y: "112%" },
    show: { y: "0%", transition: { duration: 1.05, ease: EASE } },
  };

  const cardVariants = {
    hidden: { opacity: 0, y: 20, scale: 0.985 },
    show: (i: number) => ({
      opacity: 1,
      y: 0,
      scale: 1,
      transition: { duration: 0.85, ease: EASE, delay: i * 0.11 },
    }),
  };

  return (
    <section id="feelz-teaser" className="relative isolate overflow-hidden">
      {/* Plain white section. The tinted dissolve, the three ambient colour
          fields, the drifting thread, the grain texture, and the dark-to-white
          blend at the top have all been removed — the only thing behind the
          content is white, full stop. */}

      <div className="relative mx-auto max-w-[88rem] px-5 pb-24 pt-16 sm:px-8 sm:pb-28 sm:pt-20">
        <motion.div
          className="text-center"
          variants={headingStagger}
          initial={reduced ? undefined : "hidden"}
          whileInView="show"
          viewport={{ once: true, amount: 0.4 }}
        >
          {/* Label: opens tight and settles outward. */}
          <motion.p
            className="text-[10.5px] font-semibold uppercase text-ink/45"
            initial={reduced ? undefined : { opacity: 0, letterSpacing: "0.05em" }}
            whileInView={{ opacity: 1, letterSpacing: "0.34em" }}
            viewport={{ once: true, amount: 0.6 }}
            transition={{ duration: 1.3, ease: EASE }}
          >
            Feelz
          </motion.p>

          {/* Two masked lines, revealed in sequence so the second lands as a
              beat rather than as more of the same. */}
          <h2 className="font-display mt-7 text-[2.4rem] font-bold leading-[1.08] tracking-tight text-ink sm:text-6xl lg:text-[4.1rem]">
            <span className="block overflow-hidden pb-[0.08em]">
              <motion.span className="block" variants={reduced ? undefined : maskLine}>
                Elevate your Mood
              </motion.span>
            </span>
            <span className="block overflow-hidden pb-[0.08em]">
              <motion.span
                className="font-tagline block italic text-[#8a5f7d]"
                variants={reduced ? undefined : maskLine}
              >
                with Feelz
              </motion.span>
            </span>
          </h2>

          <motion.div
            className="mx-auto mt-9 h-px w-14 bg-ink/15"
            initial={reduced ? undefined : { scaleX: 0, opacity: 0 }}
            whileInView={{ scaleX: 1, opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 1, delay: 0.5, ease: EASE }}
          />
        </motion.div>

        {/* Cards. Editorial objects: hairline border, soft ivory surface,
            generous internal rhythm, and no drop shadow at rest. */}
        <div className="mt-20 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:mt-24 lg:grid-cols-4 lg:gap-7">
          {products.map((product, index) => {
            const style = moodStyleFor(product.name);
            const mood = product.name.trim().toLowerCase() as FeelzMoodKey;
            const copy = FEELZ_PRODUCT_PAGES[mood];
            const ingredients = FEELZ_INGREDIENTS[mood] ?? [];
            const accent = CARD_ACCENTS[style.feelzColor];
            return (
              <motion.div
                key={product.id}
                custom={index}
                variants={reduced ? undefined : cardVariants}
                initial={reduced ? undefined : "hidden"}
                whileInView="show"
                viewport={{ once: true, amount: 0.25 }}
                className={`group relative flex h-full flex-col overflow-hidden rounded-[1.75rem] border bg-gradient-to-b from-white from-55% transition-all duration-500 ease-out hover:-translate-y-1 ${accent.card}`}
              >

                <button
                  type="button"
                  onClick={() => setLightboxProduct(product)}
                  aria-label={`View larger image of ${product.name}`}
                  className="relative block aspect-square w-full cursor-zoom-in overflow-hidden"
                >
                  <Image
                    src={style.catalogueSrc}
                    alt={product.name}
                    fill
                    sizes="(min-width: 1024px) 22vw, (min-width: 640px) 45vw, 90vw"
                    className="object-cover transition-transform duration-[900ms] ease-out group-hover:scale-[1.04]"
                  />
                </button>
                <span className={`block h-1 w-full ${accent.bar}`} aria-hidden />

                {/* Official product details (the client's Website Product Information
                    note): positioning, best-for, key ingredients, flavour,
                    pack size and live price. */}
                <Link href={copy ? `https://feelz.mindcafe.app/feelz/${mood}` : "https://feelz.mindcafe.app"} className="flex flex-1 flex-col px-5 pb-6 pt-5">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="font-display text-lg font-bold tracking-tight text-ink">{product.name}</p>
                    <p className="shrink-0 text-sm font-semibold text-ink">{formatInr(product.price)}</p>
                  </div>
                  {copy && (
                    <p className="mt-1 flex items-center gap-1.5 text-[12px] text-ink/55">
                      <span className={`h-1.5 w-1.5 rounded-full ${accent.bar}`} aria-hidden />
                      {copy.flavor} flavour · 10 strips
                    </p>
                  )}
                  <p className={`mt-3 text-[13.5px] font-semibold leading-snug ${accent.text}`}>{copy?.positioning ?? style.tagline}</p>

                  {copy && (
                    <p className={`mt-3.5 rounded-xl px-3.5 py-3 text-[12.5px] leading-relaxed text-ink/70 ${accent.panel}`}>
                      <span className={`font-semibold ${accent.text}`}>Best for: </span>
                      {copy.bestFor}
                    </p>
                  )}

                  {ingredients.length > 0 && (
                    <div className="mt-4">
                      <p className={`text-[10.5px] font-semibold uppercase tracking-[0.14em] opacity-75 ${accent.text}`}>Key ingredients</p>
                      <ul className="mt-2 flex flex-wrap gap-1.5">
                        {ingredients.map((ingredient) => (
                          <li key={ingredient.name} className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${accent.pill}`}>
                            {ingredient.name}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <span className={`mt-auto inline-flex items-center gap-1 pt-5 text-[12.5px] font-semibold transition-transform duration-300 group-hover:translate-x-0.5 ${accent.text}`}>
                    Shop {product.name}
                    <span aria-hidden>→</span>
                  </span>
                </Link>
              </motion.div>
            );
          })}
        </div>

        <motion.div
          className="mt-16 text-center"
          initial={reduced ? undefined : { opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.9, delay: 0.15, ease: EASE }}
        >
          <Link
            href="https://feelz.mindcafe.app"
            className="group inline-flex items-center gap-2 rounded-full border border-ink/20 px-7 py-3 text-[13px] font-medium text-ink transition-all duration-300 hover:-translate-y-px hover:border-ink/40 hover:bg-white"
          >
            Shop All Feelz
          </Link>
        </motion.div>
      </div>

      <Modal
        isOpen={!!lightboxProduct}
        onClose={() => setLightboxProduct(null)}
        title={lightboxProduct?.name ?? ""}
        panelClassName="max-w-lg"
        bgClassName="bg-white"
      >
        {lightboxProduct && (
          <div className="relative aspect-square w-full overflow-hidden rounded-2xl">
            <Image
              src={moodStyleFor(lightboxProduct.name).catalogueSrc}
              alt={lightboxProduct.name}
              fill
              sizes="32rem"
              className="object-contain"
            />
          </div>
        )}
        <Link href="https://feelz.mindcafe.app" className="pill-btn mt-4 w-full text-center">
          Shop Feelz
        </Link>
      </Modal>
    </section>
  );
}
