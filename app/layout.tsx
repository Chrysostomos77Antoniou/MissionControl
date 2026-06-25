import type { Metadata } from "next";
import { Geist_Mono, Orbitron, Rajdhani } from "next/font/google";
import "./globals.css";

const orbitron = Orbitron({ variable: "--font-display", subsets: ["latin"], weight: ["500", "700", "900"] });
const rajdhani = Rajdhani({ variable: "--font-sans", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const geistMono = Geist_Mono({ variable: "--font-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "FootRank Mission Control",
  description: "Autonomous agent command deck",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${orbitron.variable} ${rajdhani.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <div className="hud-grid" aria-hidden />
        <div className="hud-scanline" aria-hidden />
        {children}
      </body>
    </html>
  );
}
