"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useAuthModal } from "@/contexts/AuthModalContext";
import { ProfileMenu } from "@/components/ProfileMenu";
import { Avatar } from "@/components/Avatar";

import { getDashboardLink } from "@/lib/roleNav";


function scrollToTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Plain top-level links — Feelz gets the ShopMenu mega-menu instead (it's
// the only item with real subcategories), see below.
const NAV_LINKS = [
  { href: "/counselling", label: "Counselling" },
  { href: "/business", label: "For Business" },
  { href: "/assessments", label: "Assessments" },
  { href: "/about", label: "About" },
];

export function Header() {
  const { status, profile, user, signOut } = useAuth();
  const { openAuthModal } = useAuthModal();
  const [menuOpen, setMenuOpen] = useState(false);
  // Purely cosmetic: the floating glass panel reads slightly denser once
  // the page has scrolled, on every route (not homepage-specific anymore
  // — there's no dark hero left to key that off of).
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The floating "Liquid Glass" pill navbar is the one permanent treatment
  // sitewide now that every hero is light — `cinematic` only turns off
  // while the mobile menu is open, so the header becomes a full-width
  // solid bar the dropdown panel can attach to cleanly instead of a
  // floating pill with gaps down the sides.
  const cinematic = !menuOpen;

  const dashboardLink = getDashboardLink(profile?.role);


  return (
    <header
      className={`sticky top-0 z-30 transition-all duration-500 ease-out ${
        cinematic
          ? "px-3 pt-3 sm:px-6 sm:pt-4"
          : "border-b border-ink/10 bg-white shadow-[0_1px_24px_-8px_rgba(17,17,16,0.18)]"
      }`}
    >
      <div
        className={`mx-auto flex max-w-[88rem] items-center justify-between transition-all duration-500 xl:grid xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] ${
          cinematic
            ? `liquid-glass liquid-glass-onlight rounded-full px-4 py-2.5 sm:px-6 sm:py-3 ${scrolled ? "liquid-glass-dense" : ""}`
            : "px-5 py-4 sm:px-8"
        }`}
      >
        {/* Left column: nav links. Right column mirrors it at 1fr, so the
            center column (the logo) lands exactly in the middle of the bar
            regardless of how much content sits on either side. */}
        {/* Full link row only from xl (1280px): five links + a centred logo don't fit
            narrower; below that the menu button handles navigation. */}
        <nav className="font-display hidden items-center gap-6 whitespace-nowrap text-[13px] font-semibold tracking-[0.14em] text-ink/70 xl:flex">
          <a href="https://feelz.mindcafe.app" className="nav-cine hover:text-brand">Feelz</a>
          {NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="nav-cine hover:text-brand">
              {link.label}
            </Link>
          ))}
        </nav>

        <Link href="/" onClick={scrollToTop} className="flex shrink-0 items-center gap-2 leading-none xl:justify-self-center">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-cream/90 shadow-sm">
            <Image src="/mindcafe-icon.png" alt="" width={28} height={28} priority className="h-7 w-7" />
          </span>
          <span className="font-display text-xl font-bold tracking-tight text-ink">mindcafe</span>
        </Link>

        {/* Cart + account: visible inline on desktop, folded into the
            hamburger toggle on mobile so the header row stays to just the
            logo and the toggle at narrow widths. */}
        <div className="flex items-center justify-self-end gap-3">
          <div className="hidden items-center gap-3 sm:flex">
            <Link href="/book-appointment" className="pill-btn-outline !py-2 text-xs">
              Talk to an Expert
            </Link>

            {status === "authenticated" ? (
              <ProfileMenu />
            ) : (
              status !== "loading" && (
                <button type="button" onClick={openAuthModal} className="pill-btn !py-2 text-xs">
                  Log In
                </button>
              )
            )}
          </div>

          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-ink/15 text-ink xl:hidden"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X className="h-4 w-4" aria-hidden /> : <Menu className="h-4 w-4" aria-hidden />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <nav className="flex flex-col gap-1 border-t border-ink/10 bg-white px-4 py-3 text-[11px] font-medium tracking-label text-ink/70 xl:hidden">
          <a href="https://feelz.mindcafe.app" onClick={() => setMenuOpen(false)} className="w-full py-2.5 text-center uppercase hover:text-ink">Feelz</a>

          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setMenuOpen(false)}
              className="w-full py-2.5 text-center uppercase hover:text-ink"
            >
              {link.label}
            </Link>
          ))}

          <Link
            href="/book-appointment"
            onClick={() => setMenuOpen(false)}
            className="w-full py-2.5 text-center uppercase hover:text-ink"
          >
            talk to an expert
          </Link>

          {status === "authenticated" ? (
            <>
              {dashboardLink && (
                <Link
                  href={dashboardLink.href}
                  onClick={() => setMenuOpen(false)}
                  className="mt-1 w-full border-t border-ink/10 py-2.5 pt-3 text-center uppercase hover:text-ink"
                >
                  {dashboardLink.label}
                </Link>
              )}
              <Link
                href="/account"
                onClick={() => setMenuOpen(false)}
                className={`w-full py-2.5 text-center uppercase hover:text-ink ${dashboardLink ? "" : "mt-1 border-t border-ink/10 pt-3"}`}
              >
                your account
              </Link>
              <div className="flex flex-col items-center gap-2 py-2">
                <Avatar label={profile?.full_name ?? user?.email ?? "Account"} avatarUrl={profile?.avatar_url} />
                <span className="text-center text-[10px] normal-case tracking-normal text-ink/40">
                  {profile?.full_name ?? user?.email}
                </span>
              </div>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  void signOut();
                }}
                className="pill-btn-outline w-full normal-case tracking-normal"
              >
                Sign Out
              </button>
            </>
          ) : (
            status !== "loading" && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  openAuthModal();
                }}
                className="pill-btn mt-2 w-full normal-case tracking-normal"
              >
                Log In
              </button>
            )
          )}
        </nav>
      )}
    </header>
  );
}
