import { OversightWorkspace } from "@/components/workspace/OversightWorkspace";
import { HudErrorBoundary } from "@/components/dashboard/HudErrorBoundary";

export default function Home() {
  return (
    <HudErrorBoundary>
      <OversightWorkspace />
    </HudErrorBoundary>
  );
}
