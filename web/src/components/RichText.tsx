function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function inline(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br />");
}

export function RichText({ text }: { text: string }) {
  const parts = String(text ?? "").split("```");
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <pre className="code-block" key={index}>
            {part.replace(/^\w+\n/, "")}
          </pre>
        ) : (
          <span key={index} dangerouslySetInnerHTML={{ __html: inline(part) }} />
        ),
      )}
    </>
  );
}
