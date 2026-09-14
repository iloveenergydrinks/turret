// All global styles should be imported here for easier maintenance
import "./turret-fonts.css";
import "@turret/uikit/index.css";
import "./brand.css";
import "./controls.css";

import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import content from "@/src/content";
import { SOCIAL_DESCRIPTION, SOCIAL_IMAGE } from "@/src/social-metadata";
import { Analytics } from "@vercel/analytics/react";

export const metadata: Metadata = {
  title: content.appName,
  metadataBase: new URL("https://turret.capital"),
  description: SOCIAL_DESCRIPTION,
  openGraph: {
    type: "website", siteName: "Turret", title: "Turret | Borrow against memecoins, stocks and NFTs",
    description: SOCIAL_DESCRIPTION, images: [SOCIAL_IMAGE],
  },
  twitter: {
    card: "summary_large_image", title: "Turret | Borrow against memecoins, stocks and NFTs",
    description: SOCIAL_DESCRIPTION, images: [SOCIAL_IMAGE],
  },
  icons: "/brand/turret-mark.svg",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function Layout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <link rel="stylesheet" href="/turret-beta-notice-v1.css" precedence="turret-beta-notice" />
        <aside className="turret-beta-notice" aria-label="Open beta notice">
          <p>
            <strong>Turret is in open beta.</strong>{" "}
            We recommend starting with small amounts.
          </p>
        </aside>
        {children}
        {process.env.NEXT_PUBLIC_VERCEL_ANALYTICS === "true" && <Analytics />}
      </body>
    </html>
  );
}
