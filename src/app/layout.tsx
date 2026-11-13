import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'Business OS', description: 'One platform. One interface. One source of truth.' };
export const dynamic = 'force-dynamic';
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
