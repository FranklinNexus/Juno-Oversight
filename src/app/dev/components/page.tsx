"use client";

import {
  ConnectionBadge,
  DataTable,
  DataValue,
  DepthRow,
  EmptyState,
  FeedItem,
  FilterBar,
  HudButton,
  HudInput,
  HudSegment,
  KpiStrip,
  LiveBadge,
  LoadingRows,
  MetricRow,
  SectionLabel,
  Sparkline,
  StatusDot,
  TagChip,
} from "@/components/ui";

const spark = [10, 12, 11, 14, 13, 16, 15, 18, 17, 20, 19, 22];

type DemoRow = { symbol: string; last: string; chg: string };

const demoRows: DemoRow[] = [
  { symbol: "BTC-USD", last: "68,320.12", chg: "+1.2%" },
  { symbol: "ETH-USD", last: "3,412.50", chg: "-0.4%" },
];

export default function ComponentCatalogPage() {
  return (
    <main className="min-h-screen bg-[var(--bg-base)] p-4 text-[var(--text-porcelain)]">
      <h1 className="text-sm uppercase tracking-[0.14em] mb-4">Juno HUD Component Catalog</h1>

      <section className="mb-6 border border-[var(--border-dim)] p-3">
        <SectionLabel>Primitives</SectionLabel>
        <div className="flex flex-wrap gap-2 mt-2">
          <HudButton active>Active</HudButton>
          <HudButton>Default</HudButton>
          <HudButton variant="danger">Delete</HudButton>
          <LiveBadge />
          <StatusDot ok />
          <StatusDot />
        </div>
        <div className="mt-3 flex gap-2 items-center">
          <HudInput placeholder="Symbol filter" className="max-w-[140px]" />
          <HudSegment
            value="us"
            onChange={() => undefined}
            options={[
              { id: "all", label: "ALL" },
              { id: "us", label: "US" },
              { id: "hk", label: "HK" },
            ]}
          />
        </div>
      </section>

      <section className="mb-6 border border-[var(--border-dim)] p-3">
        <SectionLabel>Connection & KPI</SectionLabel>
        <div className="mt-2 flex flex-wrap gap-4 items-center">
          <ConnectionBadge connected latencyMs={42} />
          <ConnectionBadge connected={false} />
        </div>
        <div className="mt-3 max-w-lg">
          <KpiStrip
            items={[
              { id: "cpu", label: "CPU", value: "12%", tone: "ok" },
              { id: "ram", label: "RAM", value: "23.6G", tone: "default" },
              { id: "lat", label: "LAT", value: "42ms", tone: "gold" },
            ]}
          />
        </div>
      </section>

      <section className="mb-6 border border-[var(--border-dim)] p-3">
        <SectionLabel>Data</SectionLabel>
        <div className="grid grid-cols-3 gap-4 mt-2">
          <DataValue label="Last" value="68,320.12" suffix="USD" tone="up" />
          <MetricRow label="Thermal" value="67C" alert />
          <Sparkline values={spark} alert />
        </div>
        <div className="mt-3 max-w-xs">
          <DepthRow price="123.45" size="1.230" widthPct={72} side="bid" />
        </div>
        <div className="mt-3 max-w-md">
          <FilterBar query="" onQueryChange={() => undefined} trailing={<HudButton>Apply</HudButton>} />
          <DataTable<DemoRow>
            columns={[
              { id: "sym", header: "SYM", cell: (r) => r.symbol },
              { id: "last", header: "LAST", align: "right", cell: (r) => r.last },
              { id: "chg", header: "CHG%", align: "right", cell: (r) => r.chg },
            ]}
            rows={demoRows}
            rowKey={(r) => r.symbol}
            activeKey="BTC-USD"
          />
        </div>
      </section>

      <section className="mb-6 border border-[var(--border-dim)] p-3">
        <SectionLabel>Feedback</SectionLabel>
        <div className="mt-2 max-w-xs">
          <LoadingRows rows={3} />
        </div>
      </section>

      <section className="mb-6 border border-[var(--border-dim)] p-3">
        <SectionLabel>Feed</SectionLabel>
        <div className="mt-2 max-w-md space-y-1">
          <FeedItem
            tag={<TagChip tone="gold">PR</TagChip>}
            title="Improve websocket reconnection policy"
            meta="langchain-ai/langgraph / ops-bot"
            time="3m"
          />
          <EmptyState message="Waiting for events..." />
        </div>
      </section>
    </main>
  );
}
