

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "AI Analytics SaaS",
    template: "%s | AI Analytics SaaS",
  },
  description:
    "Ask questions about your business data in natural language and explore analytics results.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
