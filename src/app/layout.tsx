import type { Metadata, Viewport } from 'next';
import { Toaster } from 'sonner';
import { ThemeProvider } from '@/components/theme-provider';
import { publicEnv } from '@/lib/env';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: `${publicEnv.appName} InterviewLab`,
    template: `%s · ${publicEnv.appName} InterviewLab`,
  },
  description: `Technical interview and coding assessment platform. Powered by ${publicEnv.appName}.`,
  icons: { icon: '/icon.svg' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#18181b' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        <ThemeProvider>
          {children}
          <Toaster position="bottom-right" closeButton richColors toastOptions={{ duration: 4500 }} />
        </ThemeProvider>
      </body>
    </html>
  );
}
