import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md text-center space-y-3">
        <h2 className="text-2xl font-semibold">404</h2>
        <p className="text-sm text-foreground-muted">
          The page you are looking for does not exist.
        </p>
        <Link href="/" className="btn-primary inline-block">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
