export function Badge({ value, tone }: { value: string; tone?: string }) {
  const cls = (tone ?? value).toLowerCase();
  return <span className={`badge ${cls}`}>{value}</span>;
}
