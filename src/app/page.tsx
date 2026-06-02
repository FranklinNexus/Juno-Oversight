import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { HudErrorBoundary } from "@/components/dashboard/HudErrorBoundary";

export default function Home() {
  return (
    <HudErrorBoundary>
      <DashboardGrid />
    </HudErrorBoundary>
  );
}
