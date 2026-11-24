"use client";

import clsx from "clsx";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { SocialPresaleDetail } from "@blast/core/web/contracts/presales.ts";
import { SkeletonText as Text } from "#web/components/blast-ui/Skeleton.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";
import styles from "#web/components/blast-ui/RouteLoading.module.css";
import { cx } from "./cx";
import { PreviousIcon } from "#web/components/blast-ui/Icons.tsx";
import { SaleView } from "./SaleView";

export function SaleLoading({ presaleId: knownId }: Readonly<{ presaleId?: string }> = {}) {
  const params = useParams<{ presaleId: string }>();
  const presaleId = knownId ?? params?.presaleId;
  const client = useAppQueryClient();
  const [nowMs] = useState(() => Date.now());
  const cached = presaleId ? client.getQueryData<SocialPresaleDetail>(queryKeys.presales.detail(presaleId)) : undefined;
  if (cached && cached.presale?.presale_id === presaleId && cached.raise && cached.backers) {
    return <div aria-busy="true" aria-label="Refreshing presale" inert><SaleView detail={cached} nowMs={nowMs} viewerEntry={null} /></div>;
  }
  return <SaleSkeleton />;
}

/** The Sale board's frame while the sale reads: the head (cover, name, pills, meta, actions), the main card, the state line and the terms. */
export function SaleSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading presale"
      className={cx("sale-page")}
      data-route-loading="sale"
      data-sale-page=""
      data-shell-aside="wide"
    >
      <div className={cx("sale-head")}>
        <div className={cx("backbar")} data-page-head="">
          <Link href="/presale">
            <PreviousIcon />
            Presales
          </Link>
        </div>
        <div aria-hidden="true" className={cx("sale-cover")}>
          <span className={clsx(cx("sale-cover-art"), styles.shape)} />
          <span className={cx("skeleton-mark")} data-artwork-size={84} />
        </div>
        <div aria-hidden="true" className={cx("sale-id")}>
          <div className={cx("sale-id-text")}>
            <h1 className={cx("sale-name")}><Text>Presale name</Text> <span className={cx("sale-ticker")}><Text>$Symbol</Text></span></h1>
            <span className={cx("sale-pills")}><span className={cx("sale-pill")}><Text>Live</Text></span><span className={cx("sale-pill")}><Text>LP locked</Text></span></span>
            <span className={cx("sale-meta")}><Text>Created by 0x0000…0000 · 0x0000…0000 · Share on X</Text></span>
          </div>
        </div>
      </div>
      <div className={cx("sale-body")} data-sale-content="">
        <section aria-hidden="true" className={cx("card sale-raise")}>
          <span className={cx("sale-raised")}><b><Text>00,000 SUI</Text></b><span><Text>of 000,000 SUI</Text></span></span>
          <div className={cx("sale-raise-progress")}>
            <div className={cx("sale-raise-bar")} data-progress-bar="" />
            <span className={cx("sale-raise-percent")}><Text>00% funded</Text></span>
          </div>
          <span className={cx("sale-tiles")}>
            {["Total supply", "Ends in", "Backers", "Launches on"].map((label) => <span key={label}><span>{label}</span><b><Text>Figure</Text></b></span>)}
          </span>
        </section>
        <p aria-hidden="true" className={cx("card sale-notice")}><Text>Opened · Closes · Then trades</Text></p>
        <div aria-hidden="true" className={cx("sale-grid")}>
          {["Tokenomics", "Where the money goes", "Rules", "Buyer vesting"].map((title) => (
            <section className={cx("card sale-card")} key={title}>
              <div className={cx("sec-title")}><h2>{title}</h2></div>
              <dl className={cx("kv")}>
                {[0, 1, 2].map((key) => <div key={key}><dt><Text>Details</Text></dt><dd><Text>Reading</Text></dd></div>)}
              </dl>
            </section>
          ))}
        </div>
        <div className={cx("m-commitbar onSale")}>
          <span className={cx("t")}><b><Text>Presale action</Text></b><span><Text>Presale status</Text></span></span>
          <Button aria-label="Loading presale action" disabled><Text>Buy allocation</Text></Button>
        </div>
      </div>
    </div>
  );
}
