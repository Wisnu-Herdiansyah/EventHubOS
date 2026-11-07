import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth-card';
import { ForgotPasswordForm } from '@/components/auth-forms';

export const metadata: Metadata = { title: 'Forgot password' };

export default function ForgotPasswordPage() {
  return (
    <AuthCard title="Forgot your password?">
      <ForgotPasswordForm />
    </AuthCard>
  );
}
