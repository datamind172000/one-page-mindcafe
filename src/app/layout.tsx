import type { Metadata } from "next";
import { Space_Grotesk, Bodoni_Moda, Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { Providers } from "./providers";
import { AnnouncementBar } from "@/components/AnnouncementBar";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { CartDrawer } from "@/components/CartDrawer";
import { CartAddedToast } from "@/components/CartAddedToast";
import { AppLoadingOverlay } from "@/components/AppLoadingOverlay";

const display = Space_Grotesk({ variable: "--font-display", subsets: ["latin"], weight: ["500", "700"] });
// Bodoni Moda: extreme thin/thick hairline contrast, high-fashion
// editorial-headline feel (the client's "Kate" reference) — free Google
// Fonts alternative to that specific paid/custom typeface. One family
// covers both the bold heading treatment and the italic accent words for
// a cohesive serif system.
//
// Loaded with the full weight range (no single pinned `weight`) so this
// stays a true variable font in the browser, same as Inter below — Bodoni
// Moda's "optical size" axis is what makes it render dramatically bolder/
// higher-contrast at large display sizes and more restrained at small
// sizes. Pinning a single static weight (as this used to do) silently
// discards that axis and serves a flatter "text size" cut regardless of
// how big the heading actually is, which is why it looked thinner/smaller
// than intended even after the font-size bump. `font-optical-sizing:
// auto` in globals.css is what actually engages the axis at render time.
const serifItalic = Bodoni_Moda({
  variable: "--font-serif-italic",
  subsets: ["latin"],
  style: "italic",
});
const serifDisplay = Bodoni_Moda({
  variable: "--font-serif-display",
  subsets: ["latin"],
  style: "normal",
});
const body = Inter({ variable: "--font-body", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "mindcafe",
  description: "A paper-thin strip. Sixty seconds on the tongue. Four moods, on demand, delivered or picked up at a Zostel.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${serifItalic.variable} ${serifDisplay.variable} ${body.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-surface text-ink">
        {/* Google tag (gtag.js). next/script's afterInteractive strategy
            injects this at runtime after the page is interactive, rather
            than blocking first paint — Next manages the actual DOM
            injection point itself regardless of where this is written in
            the JSX (confirmed: moving it into a literal <head> had no
            effect on where it lands), so this is the standard next/script
            placement, not a plain <script> that needs to sit in <head>. */}
        <Script src="https://www.googletagmanager.com/gtag/js?id=G-KR5X0X6734" strategy="afterInteractive" />
        <Script id="gtag-init" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-KR5X0X6734');
          `}
        </Script>
        {/* Keep Meta dataset 1667702978300497 disconnected from sitewide browser tracking. */}
        <AppLoadingOverlay />
        <Providers>
          <AnnouncementBar />
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
          <CartDrawer />
          <CartAddedToast />
        </Providers>
      </body>
    </html>
  );
}
