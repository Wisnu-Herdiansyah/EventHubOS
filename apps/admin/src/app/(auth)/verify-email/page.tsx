import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth-card';
import { VerifyEmail } from '@/components/auth-forms';

export const metadata: Metadata = { title: 'Verify email' };

export default function VerifyEmailPage() {
  return (
    <AuthCard title="Verify your email">
      <VerifyEmail />
    </AuthCard>
  );
}
