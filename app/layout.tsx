import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "App Updates",
  description: "Updates to App Store apps, found in tech news and company blogs, with confidence scores.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
