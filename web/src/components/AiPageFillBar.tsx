export function AiPageFillBar({
  title, description, actionLabel, disabled = false, busy = false, onFill,
}: {
  title: string;
  description: string;
  actionLabel: string;
  disabled?: boolean;
  busy?: boolean;
  onFill: () => void;
}) {
  return (
    <section className="ai-page-fill-bar sketch-alt" aria-label={title}>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <button className="hbtn accent" type="button" disabled={disabled || busy}
        onClick={onFill}>{busy ? 'AI 填充中…' : actionLabel}</button>
    </section>
  );
}
