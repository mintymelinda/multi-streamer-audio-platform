import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import AppearanceProvider from './appearance-provider';

export const metadata: Metadata = {
  title: 'Streamer Audio Platform',
  description: 'Workspace dashboard for the multi-streamer audio platform.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body><AppearanceProvider>{children}</AppearanceProvider></body>
    </html>
  );
}
