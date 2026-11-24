import Image from "next/image";
import Link from "next/link";
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import type { ReactNode } from "react";

import styles from "./LegalPage.module.css";

export type LegalSectionLink = {
  id: string;
  label: string;
};

type LegalPageProps = {
  current: "privacy" | "terms";
  title: string;
  description: string;
  effectiveDate: string;
  sections: LegalSectionLink[];
  notice?: ReactNode;
  children: ReactNode;
};

export function LegalPage({
  current,
  title,
  description,
  effectiveDate,
  sections,
  notice,
  children,
}: LegalPageProps) {
  return (
    <div className={styles.page}>
      <a className={styles.skipLink} href="#legal-document">
        Skip to document
      </a>

      <div className={styles.monitor}>
        <div className={styles.screen}>
          <div className={styles.scanlines} aria-hidden="true" />
          <div className={styles.screenContent}>
            <header className={styles.header}>
              <div className={styles.transmissionBar} aria-hidden="true">
                <span>ARCHIVE NODE 02</span>
                <span>OPEN CHANNEL // PUBLIC RECORD</span>
              </div>

              <div className={styles.headerInner}>
                <div
                  className={styles.brand}
                  aria-label="BLAST.FUN legal archive"
                >
                  <Image
                    src="/blast-helmet.svg"
                    alt=""
                    width={44}
                    height={30}
                    priority
                  />
                  <span>
                    BLAST.FUN <b>{"// LEGAL ARCHIVE"}</b>
                  </span>
                </div>
                <nav aria-label="Legal archive">
                  <Link
                    href="/terms"
                    aria-current={current === "terms" ? "page" : undefined}
                  >
                    Terms
                  </Link>
                  <Link
                    href="/privacy"
                    aria-current={current === "privacy" ? "page" : undefined}
                  >
                    Privacy
                  </Link>
                </nav>
              </div>
            </header>

            <main className={styles.layout} id="legal-document" tabIndex={-1}>
              <header className={styles.hero}>
                <div className={styles.classification}>
                  <span>PUBLIC CLEARANCE</span>
                  <span aria-hidden="true">■</span>
                </div>
                <p className={styles.fileNumber}>
                  FILE // {current === "terms" ? "TOU-001" : "PRV-001"}
                </p>
                <h1>{title}</h1>
                <p className={styles.lede}>{description}</p>
                <p className={styles.effective}>
                  <span>LAST UPDATED</span>
                  <DateStamp at={effectiveDate} plain />
                </p>
              </header>

              <aside className={styles.toc} aria-label="Document index">
                <details open>
                  <summary>INDEX // {sections.length} SECTIONS</summary>
                  <ol>
                    {sections.map((section) => (
                      <li key={section.id}>
                        <a href={`#${section.id}`}>{section.label}</a>
                      </li>
                    ))}
                  </ol>
                </details>
              </aside>

              <article className={styles.document} aria-label={title}>
                {notice ? (
                  <div className={styles.notice} role="note">
                    {notice}
                  </div>
                ) : null}
                {children}
              </article>
            </main>

            <footer className={styles.footer}>
              <p>
                <span aria-hidden="true">●</span> END OF PUBLIC TRANSMISSION
              </p>
              <nav aria-label="Legal archive footer">
                <a href="mailto:hello@blast.fun">Contact us</a>
                <Link href="/software-notices.txt" prefetch={false}>
                  Software notices
                </Link>
              </nav>
            </footer>
          </div>
        </div>
      </div>
    </div>
  );
}
