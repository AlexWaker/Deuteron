import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Deuteron Wallet | Agent-native Web3 Wallet",
  description:
    "Deuteron Wallet is a CLI-first Web3 wallet designed for AI agents, with a Rust daemon, macOS Keychain storage, and auditable transaction flows.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
