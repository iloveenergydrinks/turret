// All global styles should be imported here for easier maintenance
import "@turret/uikit/index.css";

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { UiKit } from "@turret/uikit";
import { GeistSans } from "geist/font/sans";

export const metadata: Metadata = {
  title: "",
  description: "",
};

export default function Layout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en">
      <body className={GeistSans.className}>
        <UiKit>
          {children}
        </UiKit>
      </body>
    </html>
  );
}
