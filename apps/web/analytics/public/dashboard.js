import { compact, decimal, integer, utc, day, chartRows } from "/format.js";
const byId = (id) => document.getElementById(id);
const text = (id, value) => {
  byId(id).textContent = value;
};
function valueInto(element, value, label, money = false) {
  element.replaceChildren();
  if (value === null || value === undefined) {
    element.textContent = "—";
    element.setAttribute("aria-label", `${label} unavailable`);
    return;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button";
  button.dataset.uiButton = "";
  button.dataset.uiSize = "lg";
  button.dataset.uiVariant = "ghost";
  button.textContent = compact(value, money);
  button.setAttribute(
    "aria-label",
    `${label}: ${money ? "USD " : ""}${decimal(value)}. Inspect exact value`,
  );
  button.addEventListener("click", () =>
    inspect(label, `${money ? "USD " : ""}${value}`),
  );
  element.append(button);
}
function inspect(label, value) {
  text("inspection-title", label);
  text("exact-value", value);
  text("copy-status", "");
  text("copy", "Copy value");
  byId("inspection").showModal();
}
let snapshot, chart;
function renderVolume() {
  const period = byId("period").value;
  const total = snapshot.totals.trade_volume;
  const volume =
    period === "coverage"
      ? total
        ? {
            receipts: total.count,
            priced_receipts: total.pricedCount,
            priced_usd: total.pricedUsd,
          }
        : null
      : snapshot.volumeWindows[period];
  valueInto(
    byId("volume"),
    volume?.priced_usd,
    "Priced trading turnover",
    true,
  );
  if (!volume) {
    text("pricing", "No since-coverage volume aggregate is available.");
    return;
  }
  const missing = BigInt(volume.receipts) - BigInt(volume.priced_receipts);
  text("volume-label", "Priced turnover · USD");
  text(
    "pricing",
    `${integer(volume.priced_receipts)} of ${integer(volume.receipts)} receipts priced${missing > 0n ? ` · ${integer(missing)} unpriced; USD is incomplete` : " · complete pricing for this period"}.`,
  );
}
function dailyRows() {
  const body = byId("daily");
  body.replaceChildren();
  const rows = [...snapshot.dailyTradeVolume].sort((a, b) =>
    BigInt(a.day_ms) < BigInt(b.day_ms) ? 1 : -1,
  );
  byId("daily-scroll").hidden = !rows.length;
  byId("daily-empty").hidden = rows.length > 0;
  for (const row of rows) {
    const cells = body.insertRow();
    cells.insertCell().textContent = day(row.day_ms);
    cells.insertCell().textContent = integer(row.receipts);
    cells.insertCell().textContent = integer(row.priced_receipts);
    const value = cells.insertCell();
    value.textContent = `$${decimal(row.priced_usd)}`;
  }
}
function renderQuotes() {
  const list = byId("quotes");
  list.replaceChildren();
  for (const [asset, amount] of Object.entries(snapshot.quoteTotals)) {
    const row = document.createElement("div");
    row.className = "quote-row";
    const name = document.createElement("span");
    name.textContent = asset;
    const atoms = document.createElement("span");
    valueInto(atoms, amount, `${asset} turnover · atomic units`);
    row.append(name, atoms);
    list.append(row);
  }
  if (!list.children.length) {
    const empty = document.createElement("div");
    empty.className = "empty compact";
    const title = document.createElement("p");
    title.className = "title";
    title.textContent = "No quote turnover in this snapshot";
    empty.append(title);
    list.append(empty);
  }
}
async function drawChart() {
  chart?.remove();
  chart = undefined;
  const rows = chartRows(snapshot.dailyTradeVolume);
  if (!rows || !rows.length) {
    byId("chart").parentElement.hidden = true;
    text(
      "chart-note",
      rows
        ? "No daily receipts in this snapshot."
        : "Dates exceed the chart range. Use the exact table below.",
    );
    return;
  }
  byId("chart").parentElement.hidden = false;
  try {
    const { createChart, HistogramSeries } = await import(
      "/lightweight-charts.mjs"
    );
    const styles = getComputedStyle(document.documentElement);
    chart = createChart(byId("chart"), {
      autoSize: true,
      layout: {
        background: { color: styles.getPropertyValue("--card").trim() },
        textColor: styles.getPropertyValue("--muted").trim(),
        fontSize: 12,
        attributionLogo: true,
      },
      rightPriceScale: { visible: false },
      leftPriceScale: { visible: false },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
      handleScroll: false,
      handleScale: false,
      timeScale: { borderVisible: false, lockVisibleTimeRangeOnResize: true },
    });
    const series = chart.addSeries(HistogramSeries, {
      color: styles.getPropertyValue("--ink").trim(),
      priceLineVisible: false,
      lastValueVisible: false,
    });
    series.setData(rows);
    chart.timeScale().fitContent();
    text(
      "chart-note",
      "Relative daily priced turnover. Exact USD and receipt counts are in the table.",
    );
  } catch {
    byId("chart").parentElement.hidden = true;
    text("chart-note", "Chart unavailable. Use the exact daily table below.");
  }
}
function render(data) {
  snapshot = data;
  const count = (name) => data.totals[name]?.count;
  const metrics = {
    "wallet-dau": data.users.dau24h,
    "wallet-mau": data.users.mau30d,
    coins: count("launched_coins"),
    transactions: count("transactions"),
    "unique-wallets": data.users.uniqueSinceCoverage,
    presales: count("presale_created"),
    commits: count("presale_commit"),
    claims: count("presale_claim"),
    swaps: count("trade_volume"),
  };
  for (const [id, value] of Object.entries(metrics))
    valueInto(
      byId(id),
      value,
      byId(id).previousElementSibling?.textContent ?? id,
    );
  text(
    "coverage",
    `Checkpoint ${integer(data.coverageStartCheckpoint)} → ${integer(data.asOfCheckpoint)}${data.coverageStartTimestampMs !== null ? ` · Since ${utc(data.coverageStartTimestampMs)}` : " · Start time unavailable"}`,
  );
  text("window-end", `${utc(data.windowEndExclusiveMs)} · exclusive`);
  const generated = Date.parse(data.generatedAt);
  const warnings = [
    data.stale ? "Snapshot is stale" : "Snapshot available",
    data.catchingUp ? "Backfill in progress" : null,
    data.deliveryDegraded ? "Last successful delivery" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  text(
    "status",
    `${warnings} · Generated ${Number.isFinite(generated) ? utc(String(generated)) : data.generatedAt} · Onchain through ${utc(data.asOfTimestampMs)}`,
  );
  renderVolume();
  dailyRows();
  renderQuotes();
  byId("content").hidden = false;
  void drawChart();
}
async function refresh() {
  const button = byId("refresh");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.setAttribute("aria-label", "Refresh snapshot · Loading analytics");
  byId("error").hidden = true;
  const pending = setTimeout(() => {
    if (!snapshot) byId("pending").hidden = false;
  }, 300);
  try {
    const response = await fetch("/api/summary", {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (response.status === 401) {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- This standalone Node app has no Next router.
      location.assign("/");
      return;
    }
    if (!response.ok) throw new Error();
    render(await response.json());
  } catch {
    byId("error").hidden = false;
    text(
      "status",
      snapshot
        ? "Refresh failed · Last successful snapshot below; it may be out of date."
        : "Snapshot unavailable",
    );
  } finally {
    clearTimeout(pending);
    byId("pending").hidden = true;
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.setAttribute("aria-label", "Refresh snapshot");
  }
}
if (byId("password")) {
  if (new URLSearchParams(location.search).get("access") === "invalid") {
    byId("login-error").hidden = false;
    byId("password").setAttribute("aria-invalid", "true");
    byId("password").focus();
  }
} else {
  byId("refresh").addEventListener("click", refresh);
  byId("period").addEventListener("change", renderVolume);
  byId("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(byId("exact-value").textContent);
      text("copy-status", "Full value copied.");
    } catch {
      text("copy-status", "Copy failed. Select and copy the full value above.");
    }
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (snapshot) void drawChart();
  });
  void refresh();
}
