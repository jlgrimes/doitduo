import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "App Updates",
  description: "A live feed of when popular apps ship new versions.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
