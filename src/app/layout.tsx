import type { Metadata } from "next";
import { Rubik, IBM_Plex_Mono } from "next/font/google";
import { headers } from "next/headers";
import { MobileNav } from "../components/nav/mobile-nav";
import { TopNav } from "../components/nav/top-nav";
import { ThemeInitScript } from "../components/theme/theme-init-script";
import "./globals.css";

const rubik = Rubik({
  variable: "--font-rubik",
  subsets: ["latin", "hebrew"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  weight: ["500"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PFW",
  description: "Personal finance operating system and simulated trading dashboard.",
};

// Reading a dynamic API (headers(), below) opts the whole app shell out of
// static prerendering. That's required, not incidental: Next only stamps
// its per-request CSP nonce onto the scripts it renders (including its own
// inline hydration payload) when the route is dynamically rendered — a
// statically prerendered page is built once, before any request (and its
// nonce) exists. `instant = false` tells Cache Components this is a
// deliberate blocking/dynamic route rather than a missing Suspense
// boundary; individual cacheable subtrees can still opt back into caching
// with `'use cache'`.
export const instant = false;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en" className={`${rubik.variable} ${ibmPlexMono.variable} h-full antialiased`}>
      <head>
        <ThemeInitScript nonce={nonce} />
      </head>
      <body className="flex min-h-full flex-col bg-bg text-fg">
        <TopNav />
        <main className="flex-1 pb-20 md:pb-0">{children}</main>
        <MobileNav />
      </body>
    </html>
  );
}
