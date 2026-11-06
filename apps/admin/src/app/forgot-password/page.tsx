import type { Metadata } from 'next';
import { ForgotPasswordForm } from '@/components/auth-forms';

export const metadata: Metadata = { title: 'Forgot password' };

export default function ForgotPasswordPage() {
  return (
    <div className="narrow card accent">
      <h1>Forgot your password?</h1>
      <ForgotPasswordForm />
    </div>
  );
}
