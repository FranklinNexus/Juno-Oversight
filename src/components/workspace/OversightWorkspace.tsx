"use client";

import { useMemo, useState, type ReactNode } from "react";
import styles from "./OversightWorkspace.module.css";
import { useJupiterTelemetry } from "@/hooks/useJupiterTelemetry";
import { useMissionsSnapshot } from "@/hooks/useMissionsSnapshot";
import { usePromotePanel } from "@/hooks/usePromotePanel";
import { useRunControl } from "@/hooks/useRunControl";
import { useRunEvents } from "@/hooks/useRunEvents";
import { useRuntimeHudMetrics } from "@/hooks/useRuntimeHudMetrics";
import { useSchedulerStatus } from "@/hooks/useSchedulerStatus";
import { useWorkbenchSnapshot } from "@/hooks/useWorkbenchSnapshot";
import { useWorkflowEffectSnapshot } from "@/hooks/useWorkflowEffectSnapshot";
import type { QueueItem, WorkflowEffectMetrics } from "@/lib/workbench/types";

type ViewId = "overview" | "missions" | "runs" | "knowledge" | "systems";
type Tone = "neutral" | "success" | "warning" | "danger" | "accent";

const NAV_ITEMS: Array<{ id: ViewId; symbol: string; label: string; description: string }> = [
  { id: "overview", symbol: "⌂", label: "总览", description: "结果与决策" },
  { id: "missions", symbol: "◎", label: "任务", description: "目标与阶段" },
  { id: "runs", symbol: "▷", label: "运行", description: "队列与事件" },
  { id: "knowledge", symbol: "≡", label: "知识流", description: "日报与发布" },
  { id: "systems", symbol: "◇", label: "系统", description: "调度与基础设施" },
];

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function formatRate(value: number | null | undefined) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function formatTime(value: string | null | undefined) {
  if (!value) return "尚无记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function qualityState(metrics: WorkflowEffectMetrics | null, available: boolean) {
  if (!available || !metrics) {
    return { label: "等待验证", tone: "neutral" as Tone, detail: "尚无持久化门禁结果" };
  }
  const degraded =
    (metrics.verifyPassRate != null && metrics.verifyPassRate < 0.8) ||
    (metrics.reworkRate != null && metrics.reworkRate > 0.25) ||
    metrics.reviewBlock > 0 ||
    metrics.escalations > 2;
  return degraded
    ? { label: "需要修复", tone: "danger" as Tone, detail: "已暂停扩展，优先稳定工作流" }
    : { label: "质量健康", tone: "success" as Tone, detail: "自主推进可以继续" };
}

function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <span className={cn(styles.pill, styles[`tone_${tone}`])}>{children}</span>;
}

function ToolButton({
  children,
  symbol,
  tone = "neutral",
  disabled,
  onClick,
  title,
}: {
  children?: ReactNode;
  symbol?: string;
  tone?: Tone;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={cn(styles.toolButton, styles[`button_${tone}`])}
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      {symbol ? <span className={styles.buttonSymbol} aria-hidden>{symbol}</span> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

function SectionHeader({
  eyebrow,
  title,
  meta,
  action,
}: {
  eyebrow: string;
  title: string;
  meta?: string;
  action?: ReactNode;
}) {
  return (
    <div className={styles.sectionHeader}>
      <div>
        <div className={styles.eyebrow}>{eyebrow}</div>
        <h2>{title}</h2>
        {meta ? <p>{meta}</p> : null}
      </div>
      {action ? <div className={styles.sectionActions}>{action}</div> : null}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: Tone;
}) {
  return (
    <div className={cn(styles.metric, styles[`metric_${tone}`])}>
      <span className={styles.metricLabel}>{label}</span>
      <strong>{value}</strong>
      <span className={styles.metricDetail}>{detail}</span>
    </div>
  );
}

function EmptyBlock({ symbol, title, detail }: { symbol: string; title: string; detail: string }) {
  return (
    <div className={styles.emptyBlock}>
      <span className={styles.emptySymbol} aria-hidden>{symbol}</span>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function QueueRow({ item, index }: { item: QueueItem; index: number }) {
  const running = item.status === "running";
  return (
    <article className={styles.queueRow}>
      <div className={cn(styles.queueIndex, running && styles.queueIndexRunning)}>
        {running ? "▶" : String(index + 1).padStart(2, "0")}
      </div>
      <div className={styles.queueMain}>
        <div className={styles.queueTitleLine}>
          <strong>{item.id}</strong>
          <StatusPill tone={running ? "success" : "neutral"}>{running ? "运行中" : "已排队"}</StatusPill>
        </div>
        <p>{item.mission_id ? `${item.mission_id} / ${item.phase_id ?? "next"}` : item.prompt}</p>
      </div>
      <div className={styles.queueMeta}>
        <span>{item.kind}</span>
        <span>{item.max_minutes ?? 25} 分钟</span>
      </div>
    </article>
  );
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className={styles.progressTrack} aria-label={`进度 ${value}%`}>
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function OversightWorkspace() {
  const [view, setView] = useState<ViewId>("overview");
  const workbench = useWorkbenchSnapshot();
  const workflow = useWorkflowEffectSnapshot();
  const scheduler = useSchedulerStatus();
  const missionData = useMissionsSnapshot();
  const telemetry = useJupiterTelemetry();
  const runtime = useRuntimeHudMetrics();
  const events = useRunEvents(workbench.activeRunId, Boolean(workbench.activeRunId));
  const promote = usePromotePanel();
  const runControl = useRunControl(() => {
    workbench.refresh();
    events.refresh();
  });

  const quality = qualityState(workflow.latest, workflow.available);
  const runningQueue = workbench.queue.filter((item) => item.status === "running");
  const queuedQueue = workbench.queue.filter((item) => item.status !== "running");
  const activeMissions = missionData.missions.filter((mission) => mission.status === "ACTIVE");
  const currentNav = NAV_ITEMS.find((item) => item.id === view) ?? NAV_ITEMS[0];

  const refreshAll = () => {
    workbench.refresh();
    scheduler.refresh();
    events.refresh();
    promote.refresh();
  };

  const metricItems = useMemo(() => {
    const latest = workflow.latest;
    return [
      {
        label: "已交付任务",
        value: latest ? String(latest.missionDone) : "—",
        detail: latest ? `${latest.date} 的已验证结果` : "等待真实完成证据",
        tone: latest?.missionDone ? "accent" as Tone : "neutral" as Tone,
      },
      {
        label: "验证通过率",
        value: formatRate(latest?.verifyPassRate),
        detail: latest ? `${latest.verifyPass} 个验证通过` : "未生成 KPI 快照",
        tone: latest?.verifyPassRate === 1 ? "success" as Tone : latest?.verifyPassRate != null ? "warning" as Tone : "neutral" as Tone,
      },
      {
        label: "返工率",
        value: formatRate(latest?.reworkRate),
        detail: latest ? `${latest.reviewRework} 次 review revise` : "目标低于 25%",
        tone: latest?.reworkRate != null && latest.reworkRate > 0.25 ? "danger" as Tone : latest ? "success" as Tone : "neutral" as Tone,
      },
      {
        label: "人工升级",
        value: latest ? String(latest.escalations) : "—",
        detail: latest ? `${latest.reviewBlock} 个 review block` : "目标每日少于 3 次",
        tone: latest?.escalations ? "warning" as Tone : latest ? "success" as Tone : "neutral" as Tone,
      },
    ];
  }, [workflow.latest]);

  return (
    <div className={styles.workspace}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <div className={styles.brandMark}>J</div>
          <div>
            <strong>Juno</strong>
            <span>Oversight</span>
          </div>
        </div>

        <nav className={styles.nav} aria-label="工作台导航">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn(styles.navItem, view === item.id && styles.navItemActive)}
              onClick={() => setView(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <span className={styles.navSymbol} aria-hidden>{item.symbol}</span>
              <span className={styles.navCopy}>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          ))}
        </nav>

        <div className={styles.sidebarStatus}>
          <div className={styles.statusLine}>
            <span className={cn(styles.statusDot, scheduler.status.running && styles.statusDotLive)} />
            <span>自治调度</span>
            <strong>{scheduler.status.running ? "运行中" : "已停止"}</strong>
          </div>
          <div className={styles.statusLine}>
            <span className={cn(styles.statusDot, workbench.rootConfigured && styles.statusDotLive)} />
            <span>Workbench</span>
            <strong>{workbench.rootConfigured ? "已连接" : "预览模式"}</strong>
          </div>
          <p>{workbench.rootPath ?? "浏览器预览不写入本地工作区"}</p>
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.topbar}>
          <div>
            <div className={styles.breadcrumb}>Juno / {currentNav.label}</div>
            <h1>{currentNav.label}</h1>
          </div>
          <div className={styles.topbarActions}>
            <div className={styles.syncMeta}>
              <span className={styles.syncDot} />
              <div>
                <strong>{workbench.rootConfigured ? "桌面数据" : "预览数据"}</strong>
                <span>更新于 {formatTime(workbench.updatedAt)}</span>
              </div>
            </div>
            <ToolButton symbol="↻" onClick={refreshAll} title="刷新所有数据">刷新</ToolButton>
          </div>
        </header>

        <div className={styles.content}>
          {view === "overview" ? (
            <>
              <section className={styles.outcomeBanner}>
                <div>
                  <span className={styles.eyebrow}>Outcome-adaptive workflow</span>
                  <h2>{quality.label}</h2>
                  <p>{quality.detail}</p>
                </div>
                <div className={styles.bannerStatus}>
                  <StatusPill tone={quality.tone}>{quality.label}</StatusPill>
                  <span>{workflow.latest?.strategy ?? "balanced"} 策略</span>
                </div>
              </section>

              <section className={styles.metricsGrid} aria-label="工作流效果">
                {metricItems.map((item) => <Metric key={item.label} {...item} />)}
              </section>

              <div className={styles.overviewGrid}>
                <section className={styles.panel}>
                  <SectionHeader
                    eyebrow="Execution"
                    title="当前执行队列"
                    meta={`${runningQueue.length} 个运行中 · ${queuedQueue.length} 个等待中`}
                    action={<button type="button" className={styles.textAction} onClick={() => setView("runs")}>查看全部 →</button>}
                  />
                  <div className={styles.queueList}>
                    {workbench.loading ? (
                      <div className={styles.skeletonList}><span /><span /><span /></div>
                    ) : workbench.queue.length ? (
                      workbench.queue.slice(0, 5).map((item, index) => <QueueRow key={item.id} item={item} index={index} />)
                    ) : (
                      <EmptyBlock symbol="✓" title="队列已清空" detail="没有待执行的任务，Drive 可以评估下一步。" />
                    )}
                  </div>
                </section>

                <aside className={styles.sideStack}>
                  <section className={styles.panel}>
                    <SectionHeader eyebrow="Autonomy" title="自治控制" meta="有界调度器与运行入口" />
                    <div className={styles.daemonState}>
                      <div>
                        <span className={cn(styles.largeStatusDot, scheduler.status.running && styles.largeStatusDotLive)} />
                        <div>
                          <strong>{scheduler.status.running ? "调度器正在工作" : "调度器已停止"}</strong>
                          <p>{scheduler.status.running ? `PID ${scheduler.status.pid ?? "—"}` : scheduler.tauriReady ? "可安全启动" : "桌面端可用"}</p>
                        </div>
                      </div>
                      <StatusPill tone={scheduler.status.running ? "success" : "neutral"}>{scheduler.status.running ? "LIVE" : "IDLE"}</StatusPill>
                    </div>
                    <div className={styles.actionRow}>
                      <ToolButton
                        symbol="▶"
                        tone="accent"
                        disabled={!scheduler.tauriReady || scheduler.busy || scheduler.status.running}
                        onClick={scheduler.start}
                        title="启动自治调度器"
                      >启动</ToolButton>
                      <ToolButton
                        symbol="■"
                        disabled={!scheduler.tauriReady || scheduler.busy || !scheduler.status.running}
                        onClick={scheduler.stop}
                        title="停止自治调度器"
                      >停止</ToolButton>
                    </div>
                    <dl className={styles.compactFacts}>
                      <div><dt>今日运行</dt><dd>{scheduler.status.runsToday}</dd></div>
                      <div><dt>最近动作</dt><dd>{scheduler.status.lastAction ?? "—"}</dd></div>
                      <div><dt>最近心跳</dt><dd>{formatTime(scheduler.status.lastTickAt)}</dd></div>
                    </dl>
                  </section>

                  <section className={styles.panel}>
                    <SectionHeader eyebrow="Daily context" title={workbench.dailyTitle ?? "今日上下文"} />
                    {workbench.dailyExcerpt ? (
                      <pre className={styles.digestPreview}>{workbench.dailyExcerpt}</pre>
                    ) : (
                      <EmptyBlock symbol="≡" title="还没有今日日报" detail="第一次运行完成后会在这里形成上下文。" />
                    )}
                    <button type="button" className={styles.textAction} onClick={() => setView("knowledge")}>进入知识流 →</button>
                  </section>
                </aside>
              </div>

              <div className={styles.overviewLowerGrid}>
                <section className={styles.panel}>
                  <SectionHeader
                    eyebrow="Latest run"
                    title={workbench.activeRunId ?? "还没有活跃运行"}
                    meta={workbench.activeRunId ? "实时事件会在运行视图持续刷新" : "从 Dry Run 开始验证执行链路"}
                    action={<button type="button" className={styles.textAction} onClick={() => setView("runs")}>打开运行 →</button>}
                  />
                  <div className={styles.latestRunFacts}>
                    <div><span>状态</span><StatusPill tone={workbench.activeRunStatus === "running" ? "success" : "neutral"}>{workbench.activeRunStatus.toUpperCase()}</StatusPill></div>
                    <div><span>任务来源</span><strong>{workbench.rootConfigured ? "AgentWorkbench" : "浏览器预览"}</strong></div>
                    <div><span>事件读取</span><strong>{events.tauriReady ? `${events.lines.length} 条` : "桌面端可用"}</strong></div>
                  </div>
                </section>

                <section className={styles.panel}>
                  <SectionHeader
                    eyebrow="Verified evidence"
                    title="工作流效果"
                    meta={workflow.latest ? `证据日期 ${workflow.latest.date}` : "只展示持久化门禁结果"}
                    action={<button type="button" className={styles.textAction} onClick={() => setView("knowledge")}>查看详情 →</button>}
                  />
                  {workflow.latest ? (
                    <div className={styles.evidenceFacts}>
                      <div><strong>{formatRate(workflow.latest.verifyPassRate)}</strong><span>验证通过率</span></div>
                      <div><strong>{formatRate(workflow.latest.reworkRate)}</strong><span>返工率</span></div>
                      <div><strong>{workflow.latest.reviewBlock}</strong><span>Review block</span></div>
                    </div>
                  ) : (
                    <EmptyBlock symbol="◇" title="暂无已验证结果" detail="连接桌面 Workbench 并完成一次门禁闭环后显示。" />
                  )}
                </section>
              </div>
            </>
          ) : null}

          {view === "missions" ? (
            <section className={styles.pageSection}>
              <SectionHeader eyebrow="Mission portfolio" title="任务组合" meta="按目标检查阶段、执行者和真实进展" />
              {!missionData.tauriReady ? (
                <EmptyBlock symbol="◎" title="桌面端连接后显示任务" detail="浏览器模式不会伪造 missions/ 数据。" />
              ) : missionData.loading ? (
                <div className={styles.skeletonList}><span /><span /><span /></div>
              ) : missionData.missions.length ? (
                <div className={styles.missionGrid}>
                  {missionData.missions.map((mission) => {
                    const done = mission.phases.filter((phase) => phase.status === "done").length;
                    const progress = mission.phases.length ? Math.round((done / mission.phases.length) * 100) : 0;
                    return (
                      <article key={mission.id} className={styles.missionCard}>
                        <div className={styles.missionTop}>
                          <StatusPill tone={mission.status === "ACTIVE" ? "success" : "neutral"}>{mission.status}</StatusPill>
                          <span>{mission.provider}</span>
                        </div>
                        <h3>{mission.title}</h3>
                        <p>{mission.id}</p>
                        <ProgressBar value={progress} />
                        <div className={styles.missionProgress}><span>{done} / {mission.phases.length} 阶段完成</span><strong>{progress}%</strong></div>
                        <div className={styles.phaseList}>
                          {mission.phases.map((phase) => (
                            <span key={phase.id} className={cn(phase.status === "done" && styles.phaseDone, phase.status === "in_progress" && styles.phaseActive)}>
                              {phase.id}
                            </span>
                          ))}
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <EmptyBlock symbol="✓" title="没有未完成任务" detail="任务组合为空，等待 Drive 生成下一项工作。" />
              )}
              {activeMissions.length ? <p className={styles.footnote}>{activeMissions.length} 个任务当前处于 ACTIVE 状态。</p> : null}
            </section>
          ) : null}

          {view === "runs" ? (
            <div className={styles.runsGrid}>
              <section className={styles.panel}>
                <SectionHeader
                  eyebrow="Run control"
                  title={workbench.activeRunId ?? "当前没有运行"}
                  meta={workbench.activeRunId ? `状态：${workbench.activeRunStatus}` : "从 Dry Run 验证链路，或启动真实运行"}
                  action={<StatusPill tone={workbench.activeRunStatus === "running" ? "success" : "neutral"}>{workbench.activeRunStatus.toUpperCase()}</StatusPill>}
                />
                <div className={styles.actionRow}>
                  <ToolButton symbol="▷" disabled={!runControl.tauriReady || runControl.busy || workbench.activeRunStatus === "running"} onClick={() => runControl.spawn(true)}>Dry Run</ToolButton>
                  <ToolButton symbol="▶" tone="accent" disabled={!runControl.tauriReady || runControl.busy || workbench.activeRunStatus === "running"} onClick={() => runControl.spawn(false)}>Live Run</ToolButton>
                  <ToolButton symbol="■" tone="danger" disabled={!runControl.tauriReady || runControl.busy || workbench.activeRunStatus !== "running"} onClick={runControl.kill}>终止</ToolButton>
                </div>
                {runControl.error ? <p className={styles.errorText}>{runControl.error}</p> : null}
                <div className={styles.eventLog}>
                  <div className={styles.eventLogHeader}><span>事件流</span><span>{events.lines.length} 条</span></div>
                  {events.lines.length ? events.lines.map((line, index) => <pre key={`${index}-${line.slice(0, 16)}`}>{line}</pre>) : <EmptyBlock symbol="…" title="等待运行事件" detail={runControl.tauriReady ? "启动运行后 events.jsonl 会实时出现在这里。" : "请在 Tauri 桌面端启动运行。"} />}
                </div>
              </section>
              <section className={styles.panel}>
                <SectionHeader eyebrow="Queue" title="完整队列" meta={`${workbench.queue.length} 个 slot`} />
                <div className={styles.queueList}>{workbench.queue.length ? workbench.queue.map((item, index) => <QueueRow key={item.id} item={item} index={index} />) : <EmptyBlock symbol="✓" title="队列为空" detail="当前没有等待执行的 slot。" />}</div>
              </section>
            </div>
          ) : null}

          {view === "knowledge" ? (
            <div className={styles.knowledgeGrid}>
              <section className={styles.panel}>
                <SectionHeader eyebrow="Daily brief" title={workbench.dailyTitle ?? "今日运行摘要"} meta="由已发生的运行与门禁结果生成" />
                {workbench.dailyExcerpt ? <pre className={styles.digestFull}>{workbench.dailyExcerpt}</pre> : <EmptyBlock symbol="≡" title="暂无摘要" detail="运行完成后会自动形成当日上下文。" />}
              </section>
              <section className={styles.panel}>
                <SectionHeader eyebrow="Promote" title="发布到知识库" meta="预览差异后再写入 Vault" />
                {!promote.tauriReady ? (
                  <EmptyBlock symbol="↑" title="桌面端连接后可发布" detail="浏览器模式不会触碰 Vault 文件。" />
                ) : promote.loading ? (
                  <div className={styles.skeletonList}><span /><span /></div>
                ) : promote.staging.length ? (
                  <div className={styles.promoteLayout}>
                    <div className={styles.stagingList}>
                      {promote.staging.map((entry) => (
                        <button key={entry.relativePath} type="button" className={cn(styles.stagingItem, promote.selectedPath === entry.relativePath && styles.stagingItemActive)} onClick={() => promote.selectEntry(entry.relativePath)}>
                          <span>{entry.relativePath}</span><small>{entry.sizeBytes} B</small>
                        </button>
                      ))}
                    </div>
                    <div className={styles.diffPreview}>
                      <pre>{promote.previewText ?? "选择一个 staging 文件查看差异。"}</pre>
                      <ToolButton symbol="↑" tone="accent" disabled={!promote.selectedPath || promote.previewLoading || promote.busy} onClick={() => promote.selectedPath && promote.promote(promote.defaultRule, promote.selectedPath)}>确认发布</ToolButton>
                    </div>
                  </div>
                ) : (
                  <EmptyBlock symbol="✓" title="Staging 已清空" detail="没有等待发布的知识资产。" />
                )}
                {promote.message ? <p className={styles.noticeText}>{promote.message}</p> : null}
              </section>
            </div>
          ) : null}

          {view === "systems" ? (
            <section className={styles.pageSection}>
              <SectionHeader eyebrow="System health" title="运行环境" meta="本机、边缘节点与自治调度状态" />
              <div className={styles.systemMetrics}>
                <Metric label="CPU" value={`${runtime.cpuPct}%`} detail={`${runtime.source} 运行时`} tone={runtime.cpuPct > 85 ? "danger" : "neutral"} />
                <Metric label="内存" value={`${runtime.ramMb} MB`} detail={runtime.ramTotalMb ? `总计 ${runtime.ramTotalMb} MB` : "实时占用"} />
                <Metric label="边缘温度" value={`${telemetry.thermalC}°C`} detail={telemetry.node} tone={telemetry.thermalC > 62 ? "warning" : "success"} />
                <Metric label="边缘延迟" value={`${telemetry.latencyMs} ms`} detail={telemetry.sshConnected ? "SSH 已连接" : "SSH 未连接"} tone={telemetry.sshConnected ? "success" : "danger"} />
              </div>
              <div className={styles.systemGrid}>
                <section className={styles.panel}>
                  <SectionHeader eyebrow="Scheduler" title="自治调度器" action={<StatusPill tone={scheduler.status.running ? "success" : "neutral"}>{scheduler.status.running ? "RUNNING" : "STOPPED"}</StatusPill>} />
                  <dl className={styles.detailFacts}>
                    <div><dt>PID</dt><dd>{scheduler.status.pid ?? "—"}</dd></div>
                    <div><dt>今日运行</dt><dd>{scheduler.status.runsToday}</dd></div>
                    <div><dt>最近动作</dt><dd>{scheduler.status.lastAction ?? "—"}</dd></div>
                    <div><dt>最近心跳</dt><dd>{formatTime(scheduler.status.lastTickAt)}</dd></div>
                    <div><dt>启动时间</dt><dd>{formatTime(scheduler.status.daemonStartedAt)}</dd></div>
                  </dl>
                  <div className={styles.actionRow}>
                    <ToolButton symbol="▶" tone="accent" disabled={!scheduler.tauriReady || scheduler.busy || scheduler.status.running} onClick={scheduler.start}>启动调度器</ToolButton>
                    <ToolButton symbol="■" disabled={!scheduler.tauriReady || scheduler.busy || !scheduler.status.running} onClick={scheduler.stop}>停止</ToolButton>
                  </div>
                </section>
                <section className={styles.panel}>
                  <SectionHeader eyebrow="Edge node" title={telemetry.node} action={<StatusPill tone={telemetry.sshConnected ? "success" : "danger"}>{telemetry.sshConnected ? "CONNECTED" : "OFFLINE"}</StatusPill>} />
                  <dl className={styles.detailFacts}>
                    <div><dt>数据源</dt><dd>{telemetry.source}</dd></div>
                    <div><dt>SSH</dt><dd>{telemetry.sshConnected ? "已连接" : "未连接"}</dd></div>
                    <div><dt>温度</dt><dd>{telemetry.thermalC}°C</dd></div>
                    <div><dt>NPU</dt><dd>{telemetry.npuPct}%</dd></div>
                    <div><dt>延迟</dt><dd>{telemetry.latencyMs} ms</dd></div>
                  </dl>
                  {telemetry.alert ? <p className={styles.errorText}>节点指标超出建议范围，请检查负载与散热。</p> : <p className={styles.noticeText}>节点指标在正常范围内。</p>}
                </section>
              </div>
            </section>
          ) : null}
        </div>
      </main>
    </div>
  );
}
