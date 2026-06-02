export type GitHubEventType = "commit" | "pr" | "issue";

export type GitHubEvent = {
  id: string;
  type: GitHubEventType;
  repo: string;
  title: string;
  author: string;
  timestamp: number;
};

const repos = [
  "riscv/riscv-gnu-toolchain",
  "langchain-ai/langgraph",
  "tauri-apps/tauri",
  "vercel/next.js",
];

const users = ["ops-bot", "alice", "zk-chen", "infra-ci", "nightwatch"];

const commitTitles = [
  "optimize cache invalidation path",
  "tighten rpc retry strategy",
  "refactor telemetry collector",
  "bump dependency for security",
];

const prTitles = [
  "Add RISC-V NPU diagnostics panel",
  "Improve websocket reconnection policy",
  "Refine event stream backpressure handling",
  "Stabilize CI flaky integration suite",
];

const issueTitles = [
  "Investigate latency spikes in ws feed",
  "Dashboard freezes after mode toggle",
  "Need thermal throttle alarm thresholds",
  "Improve log timeline readability",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateGitHubEvent(): GitHubEvent {
  const typeRoll = Math.random();
  const type: GitHubEventType = typeRoll < 0.5 ? "commit" : typeRoll < 0.8 ? "pr" : "issue";
  const title =
    type === "commit" ? pick(commitTitles) : type === "pr" ? pick(prTitles) : pick(issueTitles);
  return {
    id: `gh-${Date.now()}-${Math.round(Math.random() * 10000)}`,
    type,
    repo: pick(repos),
    title,
    author: pick(users),
    timestamp: Date.now(),
  };
}
