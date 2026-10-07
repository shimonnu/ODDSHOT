import type { Metadata } from "next";
import "./globals.css";
import "./cosmic.css";
import "./photo-composer.css";

export const metadata: Metadata = {
  title: "ODDSHOT — 日常の、ちょっと向こう側。",
  description: "奇妙な一枚を集めて、スピリチュアル度を楽しむ写真アプリの操作モック。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body>{children}</body></html>;
}
