import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "App Updates",
  description: "Who shipped what: app updates found across tech news, company blogs and the App Store, with confidence scores.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
