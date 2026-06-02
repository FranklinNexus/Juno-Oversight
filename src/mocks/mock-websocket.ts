import type { HudMode } from "@/store/hud-store";

type MessageHandler = (event: { data: string }) => void;
type OpenHandler = () => void;
type CloseHandler = () => void;

type MockSocketOptions<T> = {
  mode: HudMode;
  generate: () => T;
  onLatency: (latencyMs: number) => void;
};

export class MockSocket<T> {
  public onmessage: MessageHandler | null = null;
  public onopen: OpenHandler | null = null;
  public onclose: CloseHandler | null = null;
  private intervalRef: number | null = null;
  private running = false;

  constructor(private readonly options: MockSocketOptions<T>) {}

  connect() {
    if (this.running) return;
    this.running = true;
    const intervalMs = this.options.mode === "surveillance" ? 700 : 1200;
    window.setTimeout(() => this.onopen?.(), 200);
    this.intervalRef = window.setInterval(() => {
      const latency = Math.round(12 + Math.random() * 36);
      this.options.onLatency(latency);
      const payload = this.options.generate();
      this.onmessage?.({ data: JSON.stringify(payload) });
    }, intervalMs);
  }

  close() {
    if (this.intervalRef !== null) {
      window.clearInterval(this.intervalRef);
      this.intervalRef = null;
    }
    this.running = false;
    this.onclose?.();
  }

  send(_payload: string) {
    void _payload;
  }
}

export function createMockSocket<T>(options: MockSocketOptions<T>) {
  return new MockSocket(options);
}
