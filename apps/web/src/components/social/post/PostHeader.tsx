import Link from "next/link";

import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";

import styles from "./PostPage.module.css";

export function PostHeader() {
  return (
    <>
      <div className={styles.backbar} data-back-bar="">
        <Link
          aria-label="Back home"
          className={styles.back}
          href="/"
          title="Back home"
        >
          <svg
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
          >
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </Link>
      </div>
      <PageHeader title="Post" />
    </>
  );
}
