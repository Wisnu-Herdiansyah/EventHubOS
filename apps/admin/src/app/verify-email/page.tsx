import type { Metadata } from 'next';
import { VerifyEmail } from '@/components/auth-forms';

export const metadata: Metadata = { title: 'Verify email' };

export default function VerifyEmailPage() {
  return (
    <div className="narrow card accent">
      <h1>Verify your email</h1>
      <VerifyEmail />
    </div>
  );
}
