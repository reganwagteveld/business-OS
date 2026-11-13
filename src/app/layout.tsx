import type { Metadata } from 'next';
import './globals.css';
import { getEnv } from '@/core/config/env';

export const metadata: Metadata = { title: 'Business OS', description: 'One platform. One interface. One source of truth.' };
export const dynamic = 'force-dynamic';
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  getEnv(); // Fail closed on invalid deployment configuration.
  return <html lang="en"><body>{children}</body></html>;
}
