import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Toaster } from 'react-hot-toast';
import AppBootstrap from './components/AppBootstrap';

export const metadata: Metadata = {
  title: 'TradeHelper — Crypto Trading Analysis',
  description:
    'Real-time cryptocurrency charting, technical indicators, backtesting, and price alerts — fully client-side.',
  manifest: '/manifest.json',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#1E1E1E',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-background text-foreground min-h-screen">
        <AppBootstrap />
        {children}
        <Toaster
          position="top-right"
          toastOptions={{
            style: {
              background: '#252525',
              color: '#D9D9D9',
              border: '1px solid #2B2B43',
            },
            success: {
              iconTheme: {
                primary: '#26A69A',
                secondary: '#252525',
              },
            },
            error: {
              iconTheme: {
                primary: '#EF5350',
                secondary: '#252525',
              },
            },
          }}
        />
      </body>
    </html>
  );
}
