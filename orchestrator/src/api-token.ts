import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { appendEvent, touchHeartbeat } from "./events.js";
import { nowIso } from "./env.js";
import {
  estimateManifestTokens,
  parseHttpRetryAfterMs,
  recordApiFailure,
  recordApiSuccess,
  releaseApiSlot,
  resolveProviderId,
  waitForApiSlot,
} from "./api-gateway.js";
import type { RunManifest } from "./types.js";

function resolveApiKey(manifest: RunManifest): { apiKey: string; model: string; baseUrl: string } {
  const ref = manifest.providerRef ?? "openai";
  const envKey =
    ref === "openai" || ref === "api_token.openai"
      ? "OPENAI_API_KEY"
      : `${ref.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  const apiKey = process.env[envKey] ?? process.env.OPENAI_API_KEY;
  if (!apiKey?.trim()) {
    throw new Error(`${envKey} is not set for api_token provider`);
  }
  const model = manifest.model ?? "gpt-4o";
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  return { apiKey, model, baseUrl };
}

export async function runApiToken(
  manifest: RunManifest,
  workbench: string,
  runDir: string,
  prompt: string,
): Promise<{ ok: boolean; text: string }> {
  const { apiKey, model, baseUrl } = resolveApiKey(manifest);
  const providerId = resolveProviderId(manifest);
  const estimatedTokens = estimateManifestTokens(manifest);
  const started = Date.now();

  const gate = await waitForApiSlot(workbench, providerId, {
    estimatedTokens,
    maxWaitMs: 600_000,
  });
  if (!gate.ok) {
    throw new Error(`API gateway blocked (${gate.reason})`);
  }

  const eventsPath = path.join(runDir, "events.jsonl");
  mkdirSync(path.resolve(workbench, manifest.cwd), { recursive: true });

  appendEvent(eventsPath, {
    ts: nowIso(),
    type: "status",
    status: "starting",
    detail: `api_token:${model} via ${providerId}`,
  });

  const heartbeat = setInterval(() => touchHeartbeat(runDir), 30_000);
  touchHeartbeat(runDir);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          {
            role: "system",
            content:
              "You are Juno Overseer worker. Only read/write Agent Workbench paths. Update checkpoint.md when done with this slot.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      const retryAfterMs = parseHttpRetryAfterMs(res.headers);
      recordApiFailure(workbench, providerId, {
        httpStatus: res.status,
        retryAfterMs,
        retryable: res.status === 429 || res.status >= 500,
        message: errText.slice(0, 200),
      });
      throw new Error(`OpenAI HTTP ${res.status}: ${errText.slice(0, 400)}`);
    }

    if (!res.body) {
      throw new Error("OpenAI response has no body");
    }

    let fullText = "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const chunk = json.choices?.[0]?.delta?.content ?? "";
          if (chunk) {
            fullText += chunk;
            appendEvent(eventsPath, {
              ts: nowIso(),
              type: "assistant",
              text: chunk,
            });
            touchHeartbeat(runDir);
          }
        } catch {
          // skip malformed sse chunk
        }
      }
    }

    appendEvent(eventsPath, {
      ts: nowIso(),
      type: "finished",
      status: "finished",
      result: fullText.slice(0, 8000),
    });
    recordApiSuccess(workbench, providerId, {
      tokens: estimatedTokens,
      latencyMs: Date.now() - started,
    });
    return { ok: true, text: fullText };
  } finally {
    clearInterval(heartbeat);
    releaseApiSlot(workbench, providerId);
  }
}

export function readPromptTemplate(workbench: string, name: string): string {
  const file = path.join(workbench, "prompts", `${name}.md`);
  return readFileSync(file, "utf8");
}
