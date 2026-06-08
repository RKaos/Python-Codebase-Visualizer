import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "pyviz — Python Codebase Visualizer",
  description: "Navigate Python call/dependency graphs with correct __init__.py resolution",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
