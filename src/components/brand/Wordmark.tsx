export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`font-display font-bold tracking-tight ${className ?? ""}`}>
      Serve<span className="text-primary">OS</span>
    </span>
  );
}
