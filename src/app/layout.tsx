import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PaperTrade BTC — 4h trend bot (paper trading)",
  description:
    "Public paper-trading dashboard for a 4h BTCUSDT trend strategy. Educational only — not financial advice. No real orders are placed.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
