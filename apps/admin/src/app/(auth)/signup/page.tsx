import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth-card';
import { SignupForm } from '@/components/auth-forms';

export const metadata: Metadata = { title: 'Create account' };

export default function SignupPage() {
  return (
    <AuthCard
      title="Create your account"
      description="Build, publish and operate event microsites."
    >
      <SignupForm />
    </AuthCard>
  );
}
