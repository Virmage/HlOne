import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div className="text-[48px] mb-2">404</div>
        <h1 className="text-[18px] font-semibold text-[var(--foreground)] mb-2">Page not found</h1>
        <p className="text-[12px] text-[var(--hl-muted)] mb-6 leading-relaxed">
          The page you're looking for doesn't exist. It may have been moved or deleted.
        </p>
        <Link
          href="/"
          className="inline-block px-4 py-2 rounded text-[12px] font-medium bg-[var(--hl-accent)] text-[var(--background)] hover:brightness-110"
        >
          Back to terminal →
        </Link>
      </div>
    </div>
  );
}
