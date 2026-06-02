"use client";

import { useEffect, useState } from "react";
import {
  getLatestJupiterTelemetry,
  subscribeJupiterTelemetry,
  type JupiterTelemetry,
} from "@/lib/jupiter-telemetry-hub";

export type { JupiterTelemetry };

export function useJupiterTelemetry(): JupiterTelemetry {
  const [data, setData] = useState<JupiterTelemetry>(() => getLatestJupiterTelemetry());

  useEffect(() => subscribeJupiterTelemetry(setData), []);

  return data;
}
