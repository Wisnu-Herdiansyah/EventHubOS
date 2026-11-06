import type { Metadata } from 'next';
import { ResetPasswordForm } from '@/components/auth-forms';

export const metadata: Metadata = { title: 'Choose a new password' };

export default function ResetPasswordPage() {
  return (
    <div className="narrow card accent">
      <h1>Choose a new password</h1>
      <ResetPasswordForm />
    </div>
  );
}
