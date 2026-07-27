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

type ViewId = "now" | "missions" | "runs" | "knowledge" | "systems";
type Tone = "neutral" | "success" | "warning" | "danger" | "accent";

const NAV_ITEMS: Array<{ id: ViewId; glyph: string; label: string; hint: string }> = [
  { id: "now", glyph: "→", label: "现在", hint: "下一步动作" },
  { id: "missions", glyph: "○", label: "任务", hint: "目标与阶段" },
  { id: "runs", glyph: "▸", label: "运行", hint: "队列与事件" },
  { id: "knowledge", glyph: "≡", label: "证据", hint: "日报与发布" },
  { id: "systems", glyph: "⌁", label: "系统", hint: "环境与自治" },
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
    return {
      label: "未验证",
      tone: "neutral" as Tone,
      detail: "完成一次真实运行并通过门禁，Juno 才会放开自治动作。",
    };
  }
  const degraded =
    (metrics.verifyPassRate != null && metrics.verifyPassRate < 0.8) ||
    (metrics.reworkRate != null && metrics.reworkRate > 0.25) ||
    metrics.reviewBlock > 0 ||
    metrics.escalations > 2;
  return degraded
    ? { label: "需要修复", tone: "danger" as Tone, detail: "质量信号下降，扩展动作已暂停。" }
    : { label: "可继续", tone: "success" as Tone, detail: "质量信号稳定，可以继续推进下一项任务。" };
}

function Status({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <span className={cn(styles.status, styles[`tone_${tone}`])}>{children}</span>;
}

function ActionButton({
  children,
  glyph,
  tone = "neutral",
  disabled,
  onClick,
  title,
  wide = false,
}: {
  children: ReactNode;
  glyph?: string;
  tone?: Tone;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(styles.actionButton, styles[`action_${tone}`], wide && styles.actionWide)}
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      {glyph ? <span className={styles.buttonGlyph} aria-hidden>{glyph}</span> : null}
      <span>{children}</span>
    </button>
  );
}

function SectionHeading({
  eyebrow,
  title,
  detail,
  action,
}: {
  eyebrow: string;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className={styles.sectionHeading}>
      <div>
        <div className={styles.eyebrow}>{eyebrow}</div>
        <h2>{title}</h2>
        {detail ? <p>{detail}</p> : null}
      </div>
      {action ? <div className={styles.sectionAction}>{action}</div> : null}
    </div>
  );
}

function QueueRow({ item, index }: { item: QueueItem; index: number }) {
  const running = item.status === "running";
  return (
    <article className={styles.queueRow}>
      <span className={cn(styles.queueMark, running && styles.queueMarkLive)}>{running ? "●" : String(index + 1).padStart(2, "0")}</span>
      <div className={styles.queueBody}>
        <div className={styles.queueTitle}>
          <strong>{item.id}</strong>
          <Status tone={running ? "success" : "neutral"}>{running ? "运行中" : "排队"}</Status>
        </div>
        <p>{item.mission_id ? `${item.mission_id} / ${item.phase_id ?? "next"}` : item.prompt}</p>
      </div>
      <div className={styles.queueAside}>
        <span>{item.kind}</span>
        <span>{item.max_minutes ?? 25} min</span>
      </div>
    </article>
  );
}

function EmptySignal({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className={styles.emptySignal}>
      <span className={styles.emptyRule} aria-hidden />
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
        {action ? <div className={styles.emptyAction}>{action}</div> : null}
      </div>
    </div>
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
  const [view, setView] = useState<ViewId>("now");
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
  const currentNav = NAV_ITEMS.find((item) => item.id === view) ?? NAV_ITEMS[0];
  const connected = workbench.rootConfigured;
  const runningQueue = workbench.queue.filter((item) => item.status === "running");
  const queuedQueue = workbench.queue.filter((item) => item.status !== "running");
  const activeMissions = missionData.missions.filter((mission) => mission.status === "ACTIVE");

  const refreshAll = () => {
    workbench.refresh();
    scheduler.refresh();
    events.refresh();
    promote.refresh();
  };

  const verifiedMetrics = useMemo(() => {
    const latest = workflow.latest;
    return [
      { label: "通过率", value: formatRate(latest?.verifyPassRate), detail: latest ? `${latest.verifyPass} 次通过` : "等待真实证据", tone: latest?.verifyPassRate === 1 ? "success" as Tone : "neutral" as Tone },
      { label: "返工率", value: formatRate(latest?.reworkRate), detail: latest ? `${latest.reviewRework} 次 revise` : "目标低于 25%", tone: latest?.reworkRate != null && latest.reworkRate > 0.25 ? "danger" as Tone : "neutral" as Tone },
      { label: "人工升级", value: latest ? String(latest.escalations) : "—", detail: latest ? `${latest.reviewBlock} 个 block` : "目标少于 3 次", tone: latest?.escalations ? "warning" as Tone : "neutral" as Tone },
    ];
  }, [workflow.latest]);

  return (
    <div className={styles.workspace}>
      <aside className={styles.rail} aria-label="Juno 工作流导航">
        <div className={styles.identity}>
          <span className={styles.identityMark}>J</span>
          <div><strong>JUNO</strong><span>OVERSIGHT</span></div>
        </div>
        <div className={styles.railLabel}>工作流</div>
        <nav className={styles.nav}>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn(styles.navItem, view === item.id && styles.navItemActive)}
              onClick={() => setView(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <span className={styles.navGlyph} aria-hidden>{item.glyph}</span>
              <span className={styles.navText}><strong>{item.label}</strong><small>{item.hint}</small></span>
            </button>
          ))}
        </nav>
        <div className={styles.railFooter}>
          <div className={styles.connectionLine}>
            <span className={cn(styles.connectionDot, connected && styles.connectionDotLive)} />
            <span>{connected ? "Workbench 已连接" : "Workbench 未接入"}</span>
          </div>
          <p>{connected ? workbench.rootPath : "浏览器只读 · 不写入本地文件"}</p>
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.topbar}>
          <div className={styles.pageContext}>
            <span className={styles.contextPath}>JUNO / {currentNav.label}</span>
            <h1>{currentNav.label}</h1>
          </div>
          <div className={styles.topbarRight}>
            <div className={styles.liveMeta}>
              <span className={cn(styles.liveDot, connected && styles.liveDotOn)} />
              <div><strong>{connected ? "LIVE DATA" : "NO WORKSPACE"}</strong><span>{formatTime(workbench.updatedAt)}</span></div>
            </div>
            <button type="button" className={styles.refreshButton} onClick={refreshAll} title="刷新工作区数据"><span aria-hidden>↻</span>刷新</button>
          </div>
        </header>

        <div className={styles.content}>
          {view === "now" ? (
            <>
              <section className={cn(styles.focus, !connected && styles.focusDisconnected)}>
                <div className={styles.focusMain}>
                  <div className={styles.focusKicker}><span className={styles.focusSignal} />NEXT MOVE · {connected ? "READY" : "SETUP"}</div>
                  <h2>{connected ? (workbench.activeRunId ? "正在观察一次运行" : workbench.queue.length ? "队列里有下一步" : "工作区已接入") : "先接入你的工作区"}</h2>
                  <p>{connected ? (workbench.activeRunId ? `${workbench.activeRunId} 正在产生实时证据，先看结果再决定是否继续。` : workbench.queue.length ? `${workbench.queue.length} 个任务等待决策，Juno 不会在没有门禁结果时自动扩张。` : "没有待执行任务。可以先运行一次 Dry Run，建立第一条可验证证据。") : "Juno 不制造任务，也不拿预览数据冒充运行。连接桌面 Workbench 后，所有动作、事件和 KPI 都来自真实文件。"}</p>
                  {!connected ? (
                    <div className={styles.setupSteps}>
                      <div><span>01</span><strong>打开桌面端</strong><small>启动 pnpm tauri:dev</small></div>
                      <div><span>02</span><strong>指向 Workbench</strong><small>读取本地任务与日报</small></div>
                      <div><span>03</span><strong>先做 Dry Run</strong><small>通过门禁后再 Live</small></div>
                    </div>
                  ) : (
                    <div className={styles.focusActions}>
                      <ActionButton glyph="▸" tone="accent" disabled={!runControl.tauriReady || runControl.busy || workbench.activeRunStatus === "running"} onClick={() => runControl.spawn(true)} title="启动 Dry Run">Dry Run</ActionButton>
                      <ActionButton glyph="→" disabled={!workbench.queue.length} onClick={() => setView("runs")}>查看队列</ActionButton>
                    </div>
                  )}
                  {runControl.error ? <p className={styles.errorText}>{runControl.error}</p> : null}
                </div>
                <div className={styles.focusAside}>
                  <div className={styles.focusAsideLabel}>自治策略</div>
                  <strong>{workflow.latest?.strategy ?? "BALANCED"}</strong>
                  <span>{workflow.latest ? "由最近一次门禁结果决定" : "等待首条验证结果"}</span>
                </div>
              </section>

              <div className={styles.commandGrid}>
                <section className={styles.surface}>
                  <SectionHeading eyebrow="EXECUTION" title="当前队列" detail={`${runningQueue.length} 运行中 · ${queuedQueue.length} 等待中`} action={<button type="button" className={styles.inlineAction} onClick={() => setView("runs")}>全部运行 →</button>} />
                  {workbench.loading ? <div className={styles.loadingRows}><span /><span /><span /></div> : workbench.queue.length ? <div className={styles.queueList}>{workbench.queue.slice(0, 6).map((item, index) => <QueueRow key={item.id} item={item} index={index} />)}</div> : <EmptySignal title="队列为空" detail={connected ? "没有待执行 slot。Drive 会在有真实输入时生成下一项。" : "接入桌面 Workbench 后，这里会显示真实任务。"} action={!connected ? <button type="button" className={styles.inlineAction} onClick={() => setView("systems")}>查看接入状态 →</button> : null} />}
                </section>

                <aside className={styles.rightRail}>
                  <section className={cn(styles.surface, styles.gateSurface)}>
                    <SectionHeading eyebrow="QUALITY GATE" title="结果门禁" detail={quality.detail} action={<Status tone={quality.tone}>{quality.label}</Status>} />
                    <div className={styles.gateMetrics}>{verifiedMetrics.map((metric) => <div className={cn(styles.gateMetric, styles[`metric_${metric.tone}`])} key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.detail}</small></div>)}</div>
                    <button type="button" className={styles.linkButton} onClick={() => setView("knowledge")}>打开证据流 →</button>
                  </section>

                  <section className={styles.surface}>
                    <SectionHeading eyebrow="AUTONOMY" title="自治控制" detail={scheduler.status.running ? `PID ${scheduler.status.pid ?? "—"} · 最近心跳 ${formatTime(scheduler.status.lastTickAt)}` : "默认停止，先验证再放权"} action={<Status tone={scheduler.status.running ? "success" : "neutral"}>{scheduler.status.running ? "LIVE" : "IDLE"}</Status>} />
                    <div className={styles.autonomyActions}>
                      <ActionButton glyph="▶" tone="accent" disabled={!scheduler.tauriReady || scheduler.busy || scheduler.status.running} onClick={scheduler.start}>启动</ActionButton>
                      <ActionButton glyph="■" disabled={!scheduler.tauriReady || scheduler.busy || !scheduler.status.running} onClick={scheduler.stop}>停止</ActionButton>
                    </div>
                    <div className={styles.autonomyFacts}><span>今日运行 <strong>{scheduler.status.runsToday}</strong></span><span>工作区 <strong>{connected ? "真实" : "未接入"}</strong></span></div>
                  </section>
                </aside>
              </div>

              <div className={styles.signalGrid}>
                <section className={styles.signalPanel}><span className={styles.signalLabel}>LATEST RUN</span><strong>{workbench.activeRunId ?? "—"}</strong><span>{workbench.activeRunId ? workbench.activeRunStatus.toUpperCase() : "尚无真实运行"}</span><button type="button" onClick={() => setView("runs")}>查看事件 →</button></section>
                <section className={styles.signalPanel}><span className={styles.signalLabel}>DAILY CONTEXT</span><strong>{workbench.dailyTitle ?? "今日上下文"}</strong><span>{workbench.dailyExcerpt ? "已从 Workbench 读取" : "运行完成后自动生成"}</span><button type="button" onClick={() => setView("knowledge")}>查看日报 →</button></section>
                <section className={styles.signalPanel}><span className={styles.signalLabel}>EDGE SIGNAL</span><strong>{telemetry.source === "tauri" ? telemetry.node : "未连接"}</strong><span>{telemetry.source === "tauri" ? `${telemetry.latencyMs} ms · ${telemetry.thermalC}°C` : "浏览器不展示模拟指标"}</span><button type="button" onClick={() => setView("systems")}>查看系统 →</button></section>
              </div>
            </>
          ) : null}

          {view === "missions" ? (
            <section className={styles.pageSection}>
              <SectionHeading eyebrow="MISSION PORTFOLIO" title="任务组合" detail="只展示桌面 Workbench 中已存在的目标与阶段。" />
              {!missionData.tauriReady ? <EmptySignal title="桌面端尚未接入" detail="浏览器模式不会伪造 missions/ 数据。启动桌面端后刷新本页。" action={<button type="button" className={styles.inlineAction} onClick={refreshAll}>重新检查 →</button>} /> : missionData.loading ? <div className={styles.loadingRows}><span /><span /><span /></div> : missionData.missions.length ? <div className={styles.missionTable}>{missionData.missions.map((mission) => { const done = mission.phases.filter((phase) => phase.status === "done").length; const progress = mission.phases.length ? Math.round((done / mission.phases.length) * 100) : 0; return <article key={mission.id} className={styles.missionRow}><div className={styles.missionRowTop}><Status tone={mission.status === "ACTIVE" ? "success" : "neutral"}>{mission.status}</Status><span>{mission.provider}</span></div><h3>{mission.title}</h3><p>{mission.id}</p><ProgressBar value={progress} /><div className={styles.missionProgress}><span>{done} / {mission.phases.length} 阶段</span><strong>{progress}%</strong></div><div className={styles.phaseList}>{mission.phases.map((phase) => <span key={phase.id} className={cn(phase.status === "done" && styles.phaseDone, phase.status === "in_progress" && styles.phaseActive)}>{phase.id}</span>)}</div></article>; })}</div> : <EmptySignal title="没有未完成任务" detail="任务组合为空，等待 Drive 生成下一项工作。" />}
              {activeMissions.length ? <p className={styles.footnote}>{activeMissions.length} 个任务当前处于 ACTIVE 状态。</p> : null}
            </section>
          ) : null}

          {view === "runs" ? (
            <div className={styles.twoColumn}>
              <section className={styles.surface}>
                <SectionHeading eyebrow="RUN CONTROL" title={workbench.activeRunId ?? "当前没有运行"} detail={workbench.activeRunId ? `状态：${workbench.activeRunStatus}` : "先用 Dry Run 验证链路，再决定是否 Live。"} action={<Status tone={workbench.activeRunStatus === "running" ? "success" : "neutral"}>{workbench.activeRunStatus.toUpperCase()}</Status>} />
                <div className={styles.actionRow}><ActionButton glyph="▷" disabled={!runControl.tauriReady || runControl.busy || workbench.activeRunStatus === "running"} onClick={() => runControl.spawn(true)}>Dry Run</ActionButton><ActionButton glyph="▶" tone="accent" disabled={!runControl.tauriReady || runControl.busy || workbench.activeRunStatus === "running"} onClick={() => runControl.spawn(false)}>Live Run</ActionButton><ActionButton glyph="■" tone="danger" disabled={!runControl.tauriReady || runControl.busy || workbench.activeRunStatus !== "running"} onClick={runControl.kill}>终止</ActionButton></div>
                {runControl.error ? <p className={styles.errorText}>{runControl.error}</p> : null}
                <div className={styles.eventLog}><div className={styles.eventLogHeader}><span>EVENT STREAM</span><span>{events.lines.length} 条</span></div>{events.lines.length ? events.lines.map((line, index) => <pre key={`${index}-${line.slice(0, 16)}`}>{line}</pre>) : <EmptySignal title="等待运行事件" detail={runControl.tauriReady ? "启动运行后 events.jsonl 会实时出现。" : "请在 Tauri 桌面端启动运行。"} />}</div>
              </section>
              <section className={styles.surface}><SectionHeading eyebrow="QUEUE" title="完整队列" detail={`${workbench.queue.length} 个 slot`} />{workbench.queue.length ? <div className={styles.queueList}>{workbench.queue.map((item, index) => <QueueRow key={item.id} item={item} index={index} />)}</div> : <EmptySignal title="没有待执行 slot" detail="真实任务会在 Workbench 接入后出现在这里。" />}</section>
            </div>
          ) : null}

          {view === "knowledge" ? (
            <div className={styles.twoColumn}>
              <section className={styles.surface}><SectionHeading eyebrow="DAILY BRIEF" title={workbench.dailyTitle ?? "今日运行摘要"} detail="由已经发生的运行与门禁结果生成。" />{workbench.dailyExcerpt ? <pre className={styles.digest}>{workbench.dailyExcerpt}</pre> : <EmptySignal title="暂无摘要" detail="运行完成后会自动形成当日上下文。" />}</section>
              <section className={styles.surface}><SectionHeading eyebrow="PROMOTE" title="发布到知识库" detail="先预览差异，再写入 Vault。" />{!promote.tauriReady ? <EmptySignal title="桌面端尚未接入" detail="浏览器模式不会触碰 Vault 文件。" /> : promote.loading ? <div className={styles.loadingRows}><span /><span /></div> : promote.staging.length ? <div className={styles.promoteLayout}><div className={styles.stagingList}>{promote.staging.map((entry) => <button key={entry.relativePath} type="button" className={cn(styles.stagingItem, promote.selectedPath === entry.relativePath && styles.stagingItemActive)} onClick={() => promote.selectEntry(entry.relativePath)}><span>{entry.relativePath}</span><small>{entry.sizeBytes} B</small></button>)}</div><div className={styles.diffPreview}><pre>{promote.previewText ?? "选择一个 staging 文件查看差异。"}</pre><ActionButton glyph="↑" tone="accent" disabled={!promote.selectedPath || promote.previewLoading || promote.busy} onClick={() => promote.selectedPath && promote.promote(promote.defaultRule, promote.selectedPath)}>确认发布</ActionButton></div></div> : <EmptySignal title="Staging 已清空" detail="没有等待发布的知识资产。" />}{promote.message ? <p className={styles.noticeText}>{promote.message}</p> : null}</section>
            </div>
          ) : null}

          {view === "systems" ? (
            <section className={styles.pageSection}><SectionHeading eyebrow="SYSTEM HEALTH" title="运行环境" detail="本机、边缘节点与自治调度状态。模拟数据不会被标记为真实。" /><div className={styles.systemMetrics}><div className={styles.systemMetric}><span>CPU</span><strong>{runtime.source === "tauri" ? `${runtime.cpuPct}%` : "—"}</strong><small>{runtime.source === "tauri" ? "桌面端实时" : "未接入桌面端"}</small></div><div className={styles.systemMetric}><span>内存</span><strong>{runtime.source === "tauri" ? `${runtime.ramMb} MB` : "—"}</strong><small>{runtime.source === "tauri" && runtime.ramTotalMb ? `总计 ${runtime.ramTotalMb} MB` : "不展示模拟占用"}</small></div><div className={styles.systemMetric}><span>边缘温度</span><strong>{telemetry.source === "tauri" ? `${telemetry.thermalC}°C` : "—"}</strong><small>{telemetry.source === "tauri" ? telemetry.node : "未连接边缘节点"}</small></div><div className={styles.systemMetric}><span>边缘延迟</span><strong>{telemetry.source === "tauri" ? `${telemetry.latencyMs} ms` : "—"}</strong><small>{telemetry.source === "tauri" ? "SSH 已连接" : "不展示模拟延迟"}</small></div></div><div className={styles.twoColumn}><section className={styles.surface}><SectionHeading eyebrow="SCHEDULER" title="自治调度器" action={<Status tone={scheduler.status.running ? "success" : "neutral"}>{scheduler.status.running ? "RUNNING" : "STOPPED"}</Status>} /><dl className={styles.detailFacts}><div><dt>PID</dt><dd>{scheduler.status.pid ?? "—"}</dd></div><div><dt>今日运行</dt><dd>{scheduler.status.runsToday}</dd></div><div><dt>最近动作</dt><dd>{scheduler.status.lastAction ?? "—"}</dd></div><div><dt>最近心跳</dt><dd>{formatTime(scheduler.status.lastTickAt)}</dd></div><div><dt>启动时间</dt><dd>{formatTime(scheduler.status.daemonStartedAt)}</dd></div></dl><div className={styles.actionRow}><ActionButton glyph="▶" tone="accent" disabled={!scheduler.tauriReady || scheduler.busy || scheduler.status.running} onClick={scheduler.start}>启动调度器</ActionButton><ActionButton glyph="■" disabled={!scheduler.tauriReady || scheduler.busy || !scheduler.status.running} onClick={scheduler.stop}>停止</ActionButton></div></section><section className={styles.surface}><SectionHeading eyebrow="EDGE NODE" title={telemetry.source === "tauri" ? telemetry.node : "未连接"} action={<Status tone={telemetry.source === "tauri" && telemetry.sshConnected ? "success" : "neutral"}>{telemetry.source === "tauri" && telemetry.sshConnected ? "CONNECTED" : "OFFLINE"}</Status>} /><dl className={styles.detailFacts}><div><dt>数据源</dt><dd>{telemetry.source === "tauri" ? "桌面端" : "浏览器只读"}</dd></div><div><dt>SSH</dt><dd>{telemetry.source === "tauri" && telemetry.sshConnected ? "已连接" : "未连接"}</dd></div><div><dt>温度</dt><dd>{telemetry.source === "tauri" ? `${telemetry.thermalC}°C` : "—"}</dd></div><div><dt>NPU</dt><dd>{telemetry.source === "tauri" ? `${telemetry.npuPct}%` : "—"}</dd></div><div><dt>延迟</dt><dd>{telemetry.source === "tauri" ? `${telemetry.latencyMs} ms` : "—"}</dd></div></dl><p className={telemetry.source === "tauri" && !telemetry.alert ? styles.noticeText : styles.errorText}>{telemetry.source === "tauri" ? (telemetry.alert ? "节点指标超出建议范围，请检查负载与散热。" : "节点指标在正常范围内。") : "桌面端接入后才读取边缘指标。"}</p></section></div></section>
          ) : null}
        </div>
      </main>
    </div>
  );
}
