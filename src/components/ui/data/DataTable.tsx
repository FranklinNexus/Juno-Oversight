import { cn } from "@/lib/cn";
import type { KeyboardEvent, ReactNode } from "react";

export type DataTableColumn<T> = {
  id: string;
  header: string;
  width?: string;
  align?: "left" | "right";
  cell: (row: T) => ReactNode;
};

type DataTableProps<T> = {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  activeKey?: string;
  emptyMessage?: string;
  dense?: boolean;
  className?: string;
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  activeKey,
  emptyMessage = "No rows",
  dense = true,
  className,
}: DataTableProps<T>) {
  const py = dense ? "py-0.5" : "py-1";

  const handleKeyDown = (row: T, event: KeyboardEvent<HTMLTableRowElement>) => {
    if (!onRowClick) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onRowClick(row);
    }
  };

  return (
    <div className={cn("w-full overflow-x-auto", className)}>
      <table className="w-full border-collapse text-[10px]">
        <thead>
          <tr className="border-b border-[var(--border-dim)] text-[var(--text-muted)] uppercase tracking-[0.1em]">
            {columns.map((col) => (
              <th
                key={col.id}
                className={cn(
                  "font-normal px-1",
                  py,
                  col.align === "right" ? "text-right" : "text-left",
                )}
                style={col.width ? { width: col.width } : undefined}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-1 py-3 text-center text-[var(--text-muted)]"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const key = rowKey(row);
              const active = activeKey === key;
              return (
                <tr
                  key={key}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? (event) => handleKeyDown(row, event) : undefined}
                  className={cn(
                    "border-b border-[var(--border-dim)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-gold)]",
                    onRowClick && "cursor-pointer hover:bg-[var(--bg-hover)]",
                    active && "bg-[var(--bg-hover)]",
                  )}
                >
                  {columns.map((col) => (
                    <td
                      key={col.id}
                      className={cn(
                        "px-1 font-mono-numeric text-[11px] text-[var(--text-porcelain)]",
                        py,
                        col.align === "right" ? "text-right" : "text-left",
                      )}
                    >
                      {col.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
