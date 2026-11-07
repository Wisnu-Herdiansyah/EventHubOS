import Link from 'next/link';
import type { ReactNode } from 'react';

/** Signed-out pages: one centred column with the brand above a single card. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <Link href="/" className="auth__brand">
        <img className="auth__logo" src="/brand/awh-monogram.svg" alt="" width={56} height={41} />
        <span>EventHub OS</span>
      </Link>
      <main id="main" className="auth__main" tabIndex={-1}>
        {children}
      </main>
      <p className="auth__footer">Systematic elegance in operations and branding.</p>
    </div>
  );
}
