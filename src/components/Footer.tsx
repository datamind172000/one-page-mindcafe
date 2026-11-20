"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import { Mail, Phone } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { subscribeToNewsletter } from "@/lib/api";
import { useAuthModal } from "@/contexts/AuthModalContext";
import { StaggerGroup } from "@/components/motion/primitives";
import { MOOD_GRID } from "@/lib/moodStyles";

// lucide-react has no brand icons in this version (see the comment below),
// but this exact glyph — rounded square, lens circle, flash dot — is the
// open-source Feather Icons "instagram" mark lucide itself was forked
// from, so it matches the rest of this icon set stroke-for-stroke.
function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
    </svg>
  );
}

// Same rationale as InstagramIcon above — the Feather Icons "facebook"
// mark, stroke-for-stroke consistent with the rest of this set, standing
// in for the plain Globe placeholder now that there's a real page to link.
function FacebookIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
    </svg>
  );
}

function NewsletterForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim()) return;
    setStatus("submitting");
    try {
      await subscribeToNewsletter(createClient(), email.trim());
      setStatus("done");
      setEmail("");
    } catch {
      setStatus("error");
    }
  }

  if (status === "done") {
    return <p className="mt-2 text-sm text-emerald-700">You&apos;re subscribed. Thanks!</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto mt-2 flex max-w-xs gap-2 sm:mx-0">
      <input
        type="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="you@email.com"
        className="input !py-2 text-sm"
      />
      <button type="submit" disabled={status === "submitting"} className="pill-btn shrink-0 !py-2 text-xs">
        {status === "submitting" ? "…" : "Subscribe"}
      </button>
    </form>
  );
}

export function Footer() {
  const { openAuthModal } = useAuthModal();
  return (
    <footer className="mx-3 mb-3 rounded-2xl border border-ink/10 bg-brand-blush/15 px-6 py-8 text-center text-ink sm:mx-6 sm:mb-6 sm:px-10 sm:text-left">
      {/* Quiet closure: columns arrive in sequence rather than as one block. */}
      <StaggerGroup className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4" gap={0.11}>
        <div>
          <p className="font-display text-2xl font-bold">Feelz</p>
          <p className="mx-auto mt-2 max-w-xs text-sm text-ink/60 sm:mx-0">
            Sublingual mood strips, made by mindcafe, incubated at Zo World, distributed by Zostel.
          </p>
          <ul className="mt-3 space-y-1 text-sm text-ink/70">
            {MOOD_GRID.map((mood) => (
              <li key={mood.key}>
                <Link href={`https://feelz.mindcafe.app/feelz/${mood.key}`} className="hover:text-brand hover:underline">
                  {mood.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-label text-ink/50">Counselling</p>
          <ul className="mt-2 space-y-1 text-sm text-ink/70">
            <li>
              <Link href="/counselling" className="hover:text-brand hover:underline">
                1:1 Counselling
              </Link>
            </li>
            <li>
              <Link href="/book-appointment" className="hover:text-brand hover:underline">
                Book a Session
              </Link>
            </li>
            <li>
              <Link href="/self-assessment" className="hover:text-brand hover:underline">
                Self-Assessment Tests
              </Link>
            </li>
            <li>
              <Link href="/business" className="hover:text-brand hover:underline">
                For Business
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-label text-ink/50">Company</p>
          <ul className="mt-2 space-y-1 text-sm text-ink/70">
            <li>
              <Link href="/about" className="hover:text-brand hover:underline">
                About
              </Link>
            </li>
            <li>
              <a href="mailto:team@mindcafe.app" className="hover:text-brand hover:underline">
                Contact
              </a>
            </li>
            <li>
              <Link href="/trust" className="hover:text-brand hover:underline">
                Trust & Safety
              </Link>
            </li>
            <li>
              <Link href="/awards" className="hover:text-brand hover:underline">
                Awards
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-label text-ink/50">Accounts</p>
          <ul className="mt-2 space-y-1 text-sm text-ink/70">
            <li>
              <button type="button" onClick={openAuthModal} className="hover:text-brand hover:underline">
                Login
              </button>
            </li>
            <li>
              <Link href="/expert/login" className="hover:text-brand hover:underline">
                Expert Login
              </Link>
            </li>
            <li>
              <Link href="/employer/login" className="hover:text-brand hover:underline">
                Employer Login
              </Link>
            </li>
          </ul>
        </div>
      </StaggerGroup>

      <StaggerGroup
        className="mt-8 grid gap-8 border-t border-ink/10 pt-8 sm:grid-cols-2 lg:grid-cols-4"
        gap={0.11}
      >
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-label text-ink/50">Stay in the Loop</p>
          <NewsletterForm />
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-label text-ink/50">Trust &amp; Quality</p>
          <ul className="mt-2 space-y-3 text-sm text-ink/70">
            <li className="flex items-center justify-center gap-2 sm:justify-start">
              <Image
                src="/certifications/fssai-logo.png"
                alt=""
                width={64}
                height={36}
                className="h-6 w-auto shrink-0 object-contain"
              />
              FSSAI compliant
            </li>
            <li className="flex items-center justify-center gap-2 sm:justify-start">
              <Image
                src="/certifications/made-in-india-badge.png"
                alt=""
                width={48}
                height={48}
                className="h-6 w-auto shrink-0 object-contain"
              />
              Proudly made in India
            </li>
          </ul>
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-label text-ink/50">Contact</p>
          <ul className="mt-2 space-y-3 text-sm">
            <li>
              <a
                href="mailto:team@mindcafe.app"
                className="flex items-center justify-center gap-1.5 text-ink hover:text-brand hover:underline sm:justify-start"
              >
                <Mail className="h-3.5 w-3.5 text-ink/40" aria-hidden />
                team@mindcafe.app
              </a>
              <span className="mt-0.5 block text-xs text-ink/50">Response Within 24 Hours</span>
            </li>
            <li>
              <a
                href="tel:+917566007770"
                className="flex items-center justify-center gap-1.5 text-ink hover:text-brand hover:underline sm:justify-start"
              >
                <Phone className="h-3.5 w-3.5 text-ink/40" aria-hidden />
                +91 75660 07770
              </a>
            </li>
          </ul>
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-label text-ink/50">Follow</p>
          {/* lucide-react has no brand icons in this version — Facebook and
              Instagram get their own real glyphs via FacebookIcon/
              InstagramIcon above. */}
          <div className="mt-2 flex items-center justify-center gap-3 sm:justify-start">
            <a
              href="https://share.google/cLT3bm4eAVcgIg7DG"
              target="_blank"
              rel="noreferrer"
              aria-label="Facebook"
              className="text-ink/60 hover:text-brand"
            >
              <FacebookIcon className="h-4 w-4" />
            </a>
            <a
              href="https://www.instagram.com/feelzbymindcafe/"
              target="_blank"
              rel="noreferrer"
              aria-label="Instagram: feelzbymindcafe"
              className="flex items-center gap-1 text-xs text-ink/60 hover:text-brand"
            >
              <InstagramIcon className="h-4 w-4" />
              feelzbymindcafe
            </a>
          </div>
          <span className="badge-pill mt-4 inline-block">ISO/IEC 27001</span>
        </div>
      </StaggerGroup>

      <div className="mt-8 flex flex-col items-center gap-3 border-t border-ink/10 pt-6 text-xs text-ink/50 sm:flex-row sm:items-center sm:justify-between">
        <p>© 2026 mindcafe, a venture of Sneh Care Club Pvt. Ltd. All rights reserved.</p>
        <div className="flex gap-4">
          <Link href="/legal/privacy" className="hover:text-brand hover:underline">
            Privacy
          </Link>
          <Link href="/legal/terms" className="hover:text-brand hover:underline">
            Terms
          </Link>
          <Link href="/legal/refund" className="hover:text-brand hover:underline">
            Refund & Cancellation
          </Link>
        </div>
      </div>
    </footer>
  );
}
