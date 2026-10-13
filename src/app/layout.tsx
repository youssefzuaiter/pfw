import type { Metadata, Viewport } from "next";
import { Rubik, IBM_Plex_Mono } from "next/font/google";
import { headers } from "next/headers";
import { CommandPalette } from "../components/CommandPalette";
import { CopilotSidebar } from "../components/copilot/copilot-sidebar";
import { ReportingCurrencyProvider } from "../components/currency/reporting-currency-provider";
import { ILS_REPORTING, type ReportingContext } from "../lib/reporting-currency";
import { getCurrentUser } from "../server/auth/current-user";
import { getReportingContext } from "../server/reporting/reporting-context";
import { MobileNav } from "../components/nav/mobile-nav";
import { Sidebar } from "../components/nav/sidebar";
import { OfflineBanner } from "../components/pwa/offline-banner";
import { ServiceWorkerRegistration } from "../components/pwa/service-worker-registration";
import { PWA_THEME_COLOR } from "../lib/pwa-theme-color";
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
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "PFW",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

// `themeColor`/`colorScheme` were split out of `Metadata` into this
// separate `Viewport` export in a recent Next major — `metadata.themeColor`
// is deprecated (verified against this exact installed Next version's
// own type declarations, not assumed from older docs). Matches
// `manifest.json`'s own `theme_color` — the app's actual dark-navy brand
// (`--pfw-bg`'s dark value), not `/trading`'s separately-fixed neutral
// palette, since a PWA's theme color applies to the whole installed app,
// not one subtree.
export const viewport: Viewport = {
  themeColor: PWA_THEME_COLOR,
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
  const requestHeaders = await headers();
  const nonce = requestHeaders.get("x-nonce") ?? undefined;
  // Set by src/proxy.ts — a public route (login/register/welcome/etc.)
  // can still be visited while signed out, so the authenticated app shell
  // (Sidebar/MobileNav/CopilotSidebar, which includes a "Sign out" link
  // and full app navigation) must not render for those requests.
  const isAuthenticated = requestHeaders.get("x-authenticated") === "1";
  const reporting = isAuthenticated ? await resolveReportingContext() : ILS_REPORTING;

  return (
    <html lang="en" className={`${rubik.variable} ${ibmPlexMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-bg text-fg md:flex-row">
        <ReportingCurrencyProvider value={reporting}>
          <OfflineBanner />
          {isAuthenticated && <Sidebar />}
          <main className="min-w-0 flex-1 pb-20 md:pb-0">{children}</main>
          {isAuthenticated && <MobileNav />}
          {isAuthenticated && <CopilotSidebar />}
          {isAuthenticated && <CommandPalette nonce={nonce} />}
          <ServiceWorkerRegistration />
        </ReportingCurrencyProvider>
      </body>
    </html>
  );
}

/**
 * The signed-in user's reporting currency (AGENTS.md §3nnn). A failure
 * here falls back to ILS rather than breaking every page: the figures are
 * then shown in shekels, correctly labelled, just not in the chosen
 * currency. A page that needs the context itself will surface the same
 * failure through its own error boundary.
 */
async function resolveReportingContext(): Promise<ReportingContext> {
  try {
    const user = await getCurrentUser();
    return await getReportingContext(user.id);
  } catch (error) {
    console.error("root layout: could not resolve the reporting currency — showing shekels", error);
    return ILS_REPORTING;
  }
}
