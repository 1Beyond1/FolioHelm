import type { Copy } from "../i18n";

interface FooterProps {
  copy: Copy;
}

export function Footer({ copy }: FooterProps) {
  return (
    <footer className="app-footer">
      <span>{copy.demoFooter}</span>
      <span>{copy.demoHint}</span>
    </footer>
  );
}
