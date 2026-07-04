export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true" focusable="false">
      <path d="M26 32 L74 32 L50 78 Z" fill="none" stroke="currentColor" strokeWidth={6} strokeLinejoin="round" />
      <circle cx="26" cy="32" r="9" fill="currentColor" />
      <circle cx="74" cy="32" r="9" fill="currentColor" />
      <circle cx="50" cy="78" r="9" fill="currentColor" />
    </svg>
  );
}
