import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Design Sharingan Studio",
  description: "Local-first design intelligence for product evolution."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
