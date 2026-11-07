import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth-card';
import { ResetPasswordForm } from '@/components/auth-forms';

export const metadata: Metadata = { title: 'Choose a new password' };

export default function ResetPasswordPage() {
  return (
    <AuthCard title="Choose a new password">
      <ResetPasswordForm />
    </AuthCard>
  );
}
