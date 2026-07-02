import "./styles.css";
import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="shell-nav">
          <a href="/">Inbox</a>
          <a href="/exceptions">Exceptions</a>
          <a href="/approvals">Approvals</a>
          <a href="/ops">Ops</a>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}

