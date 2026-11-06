import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="narrow card accent">
      <h1>Not found</h1>
      <p>This page doesn’t exist, or you don’t have access to it.</p>
      <Link className="button" href="/">
        Back to your organizations
      </Link>
    </div>
  );
}
