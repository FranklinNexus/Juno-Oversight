import { cn } from "@/lib/cn";

type ScrollFeedProps = {
  children: React.ReactNode;
  className?: string;
};

export function ScrollFeed({ children, className }: ScrollFeedProps) {
  return (
    <div className={cn("h-full overflow-y-auto space-y-1 hud-scroll", className)}>
      {children}
    </div>
  );
}
