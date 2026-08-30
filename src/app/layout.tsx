import type { Metadata } from "next";
import { Nav } from "@/components/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Procura",
  description: "Lightweight procurement tracking: requests, approvals, and orders.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <Nav />
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">{children}</main>
        <footer className="border-t border-line px-6 py-6 text-center text-xs text-muted">
          Procura — demo data, resets when the server restarts.
        </footer>
      </body>
    </html>
  );
}
