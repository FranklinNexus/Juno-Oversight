"use client";

import { useCallback, useMemo, useState, type FormEvent } from "react";
import styles from "./OversightWorkspace.module.css";
import { useMissionBrief } from "@/hooks/useMissionBrief";
import { useMissionsSnapshot } from "@/hooks/useMissionsSnapshot";
import { useRunControl } from "@/hooks/useRunControl";
import { useSchedulerStatus } from "@/hooks/useSchedulerStatus";
import { useWorkbenchSnapshot } from "@/hooks/useWorkbenchSnapshot";
import { useWorkflowEffectSnapshot } from "@/hooks/useWorkflowEffectSnapshot";
import type { QueueItem } from "@/lib/workbench/types";

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

function stepLabel(item: QueueItem) {
  if (item.kind === "review") return "复核";
  if (item.kind === "verify") return "验收";
  if (item.kind === "implement") return "执行";
  return "处理";
}

function runLabel(status: string) {
  if (status === "running") return "执行中";
  if (status === "done") return "已完成";
  if (status === "failed") return "需要处理";
  if (status === "stall") return "已暂停";
  return "等待中";
}

export function OversightWorkspace() {
  const [briefText, setBriefText] = useState("");
  const workbench = useWorkbenchSnapshot();
  const workflow = useWorkflowEffectSnapshot();
  const missions = useMissionsSnapshot();
  const scheduler = useSchedulerStatus();
  const runControl = useRunControl(workbench.refresh);
  const refreshWorkbench = workbench.refresh;
  const refreshMissions = missions.refresh;
  const refreshScheduler = scheduler.refresh;

  const refreshAll = useCallback(() => {
    refreshWorkbench();
    refreshMissions();
    refreshScheduler();
  }, [refreshMissions, refreshScheduler, refreshWorkbench]);
  const brief = useMissionBrief(refreshAll);
  const connected = brief.tauriReady && workbench.rootConfigured;

  const activeMission = useMemo(() => {
    const preferredId = workbench.queue[0]?.mission_id ?? brief.result?.missionId;
    return missions.missions.find((mission) => mission.id === preferredId)
      ?? missions.missions.find((mission) => mission.status === "ACTIVE")
      ?? null;
  }, [brief.result?.missionId, missions.missions, workbench.queue]);

  const currentTitle = activeMission?.title
    ?? workbench.queue[0]?.mission_id
    ?? workbench.activeRunId
    ?? null;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitted = await brief.submit(briefText);
    if (submitted) setBriefText("");
  };

  return (
    <div className={styles.workspace}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>J</span>
          <div><strong>Juno</strong><span>把目标交付成结果</span></div>
        </div>
        <div className={styles.connection}>
          <span className={connected ? styles.connectionLive : styles.connectionIdle} />
          {connected ? "已连接" : brief.tauriReady ? "工作区未就绪" : "浏览器预览"}
        </div>
      </header>

      <main className={styles.main}>
        {!brief.runtimeChecked ? (
          <section className={styles.centerState} aria-live="polite">
            <span className={styles.loader} />
            <p>正在连接 Juno</p>
          </section>
        ) : !brief.tauriReady ? (
          <section className={styles.centerState}>
            <span className={styles.stateLabel}>需要桌面端</span>
            <h1>请打开 Juno 桌面应用</h1>
            <p>当前浏览器无法访问你的本地工作区。</p>
            <button type="button" className={styles.secondaryButton} onClick={() => window.location.reload()}>
              <span aria-hidden>↻</span>重新检测
            </button>
          </section>
        ) : !workbench.rootConfigured ? (
          <section className={styles.centerState}>
            <span className={styles.stateLabel}>工作区未找到</span>
            <h1>Juno 还没有可用的工作区</h1>
            <p>{workbench.rootPath ?? "请检查桌面端工作区配置。"}</p>
            <button type="button" className={styles.secondaryButton} onClick={refreshAll}>
              <span aria-hidden>↻</span>重新检测
            </button>
          </section>
        ) : (
          <div className={styles.shell}>
            <section className={styles.composerSection}>
              <span className={styles.stateLabel}>新任务</span>
              <h1>你现在想完成什么？</h1>
              <form className={styles.composer} onSubmit={handleSubmit}>
                <label htmlFor="mission-brief" className={styles.srOnly}>输入目标</label>
                <textarea
                  id="mission-brief"
                  value={briefText}
                  onChange={(event) => setBriefText(event.target.value)}
                  placeholder="输入你要达成的结果"
                  maxLength={4000}
                  rows={5}
                  disabled={brief.busy}
                />
                <div className={styles.composerFooter}>
                  <span>{briefText.length} / 4000</span>
                  <button type="submit" disabled={brief.busy || briefText.trim().length < 4}>
                    {brief.busy ? "正在创建" : "开始"}<span aria-hidden>→</span>
                  </button>
                </div>
              </form>
              {brief.error ? <p className={styles.errorMessage}>{brief.error}</p> : null}
              {brief.result ? (
                <div className={styles.successMessage} role="status">
                  <span aria-hidden>✓</span>
                  <div><strong>{brief.result.message}</strong><small>{brief.result.missionId}</small></div>
                </div>
              ) : null}
            </section>

            <section className={styles.currentSection} aria-labelledby="current-work-title">
              <div className={styles.sectionHeader}>
                <div>
                  <span className={styles.stateLabel}>当前进度</span>
                  <h2 id="current-work-title">
                    {workbench.activeRunId ? "Juno 正在执行" : workbench.queue.length ? "任务已经排好" : brief.result ? "目标已经接收" : "等待你的目标"}
                  </h2>
                </div>
                <span className={styles.runStatus}>{runLabel(workbench.activeRunStatus)}</span>
              </div>

              {currentTitle ? (
                <div className={styles.currentWork}>
                  <strong>{currentTitle}</strong>
                  <span>{workbench.activeRunId ? `运行 ${workbench.activeRunId}` : `${workbench.queue.length} 个步骤等待处理`}</span>
                </div>
              ) : (
                <p className={styles.emptyCopy}>提交目标后，进度会出现在这里。</p>
              )}

              {workbench.queue.length ? (
                <ol className={styles.steps}>
                  {workbench.queue.slice(0, 4).map((item, index) => (
                    <li key={item.id}>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <div><strong>{stepLabel(item)}</strong><small>{item.phase_id ?? item.id}</small></div>
                    </li>
                  ))}
                </ol>
              ) : null}
            </section>

            <section className={styles.resultsSection} aria-labelledby="results-title">
              <div className={styles.sectionHeader}>
                <div><span className={styles.stateLabel}>最近结果</span><h2 id="results-title">交付质量</h2></div>
                <span className={styles.resultDate}>{workflow.latest?.date ?? "尚无结果"}</span>
              </div>
              {workflow.latest ? (
                <div className={styles.results}>
                  <div><span>完成</span><strong>{workflow.latest.missionDone}</strong></div>
                  <div><span>验证通过</span><strong>{formatRate(workflow.latest.verifyPassRate)}</strong></div>
                  <div><span>返工</span><strong>{formatRate(workflow.latest.reworkRate)}</strong></div>
                </div>
              ) : (
                <p className={styles.emptyCopy}>完成第一项任务后，结果会出现在这里。</p>
              )}
            </section>

            <details className={styles.advanced}>
              <summary>运行详情</summary>
              <div className={styles.advancedBody}>
                <dl>
                  <div><dt>自动运行</dt><dd>{scheduler.status.running ? "运行中" : "已停止"}</dd></div>
                  <div><dt>今日执行</dt><dd>{scheduler.status.runsToday}</dd></div>
                  <div><dt>活动任务</dt><dd>{missions.missions.filter((mission) => mission.status === "ACTIVE").length}</dd></div>
                  <div><dt>最近更新</dt><dd>{formatTime(workbench.updatedAt)}</dd></div>
                </dl>
                <div className={styles.advancedActions}>
                  {scheduler.status.running ? (
                    <button type="button" onClick={scheduler.stop} disabled={scheduler.busy}>暂停自动运行</button>
                  ) : (
                    <button type="button" onClick={scheduler.start} disabled={scheduler.busy}>恢复自动运行</button>
                  )}
                  {workbench.activeRunStatus === "running" ? (
                    <button type="button" className={styles.dangerButton} onClick={runControl.kill} disabled={runControl.busy}>终止当前运行</button>
                  ) : null}
                </div>
              </div>
            </details>
          </div>
        )}
      </main>
    </div>
  );
}
