import Image from "next/image";

import styles from "./BrandLanding.module.css";

export function BrandLanding() {
  return (
    <main className={styles.landing} aria-label="Blast">
      <Image
        className={styles.logo}
        src="/landing/blast-logo.svg"
        width={1421}
        height={291}
        alt="Blast"
        preload
      />
      <Image
        className={styles.mascot}
        src="/landing/blast-salute.png"
        width={1024}
        height={1536}
        alt="Blast's pink-helmeted mascot saluting"
        preload
      />
    </main>
  );
}
