import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PaperTrade — multi-instrument trend bot (paper trading)",
  description:
    "Public paper-trading dashboard: one shared $10,000 account running the same trend rules across crypto and US stocks. Educational only — not financial advice. No real orders are placed.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
