export function LoadingState({ label, lines = 3 }: { label: string; lines?: number }) {
  return (
    <div
      className="boot-skeleton"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
      aria-label={label}>
      {Array.from({ length: lines }, (_, index) => (
        <div
          key={index}
          className={`sk-line${index === lines - 1 && lines > 1 ? ' short' : ''}`}
          aria-hidden="true" />
      ))}
    </div>
  );
}
