import type { Metadata } from "next";
import { Georama, Montserrat, Poppins } from "next/font/google";
import "./globals.css";

const heading = Montserrat({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-heading",
});

const body = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
});

const logo = Georama({
  subsets: ["latin"],
  weight: ["700", "800"],
  variable: "--font-logo",
});

export const metadata: Metadata = {
  title: "Nexa",
  description: "Private VPN conversion hub",
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
    apple: "/icon.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${heading.variable} ${body.variable} ${logo.variable}`}>{children}</body>
    </html>
  );
}
