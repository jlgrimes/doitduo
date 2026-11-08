import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Works with iPhone Duo",
  description: "App Store apps that support iPhone Duo, and when they added it, with confidence scores.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
