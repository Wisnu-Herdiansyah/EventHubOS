import type { Metadata } from 'next';
import { SignupForm } from '@/components/auth-forms';

export const metadata: Metadata = { title: 'Create account' };

export default function SignupPage() {
  return (
    <div className="narrow card accent">
      <p className="eyebrow">Get started</p>
      <h1>Create your account</h1>
      <SignupForm />
    </div>
  );
}
