"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertFrame, HudButton } from "@/components/ui";

type Props = { children: ReactNode };
type State = { error: Error | null; retryKey: number };

export class HudErrorBoundary extends Component<Props, State> {
  state: State = { error: null, retryKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Juno HUD]", error, info.componentStack);
  }

  handleRetry = () => {
    this.setState((prev) => ({
      error: null,
      retryKey: prev.retryKey + 1,
    }));
  };

  render() {
    if (this.state.error) {
      return (
        <div className="hud-viewport flex items-center justify-center p-6">
          <AlertFrame active className="max-w-md w-full p-4">
            <p className="text-xs uppercase tracking-[0.12em] text-[var(--accent-gold)] mb-2">
              Panel fault
            </p>
            <p className="text-[11px] text-[var(--text-porcelain)] mb-3">
              {this.state.error.message}
            </p>
            <HudButton onClick={this.handleRetry}>Retry</HudButton>
          </AlertFrame>
        </div>
      );
    }
    return <div key={this.state.retryKey}>{this.props.children}</div>;
  }
}
