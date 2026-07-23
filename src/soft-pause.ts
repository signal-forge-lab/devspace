import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SOFT_PAUSE_FILE_NAME = "soft-pause.json";
const MAX_REASON_LENGTH = 240;

export const SOFT_PAUSE_TOOL_DESCRIPTION =
  "Responses may include [WORKBRIDGE_SOFT_PAUSE_REQUESTED]. If present, stop at a convenient safe point and report the pause; tools remain available.";

export const SOFT_PAUSE_SERVER_INSTRUCTION =
  " If a tool response includes [WORKBRIDGE_SOFT_PAUSE_REQUESTED], treat it as a non-urgent local request. Complete only the current coherent step, then stop calling tools when convenient and tell the user that work was temporarily paused. Additional tool calls remain allowed when needed to reach a safe stopping point.";

export interface SoftPauseState {
  version: 1;
  requestedAt: string;
  reason?: string;
}

type ToolContent = { type: "text"; text: string } | Record<string, unknown>;

interface ToolResultLike {
  content?: ToolContent[];
  _meta?: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
}

export class SoftPauseController {
  readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = join(stateDir, "control", SOFT_PAUSE_FILE_NAME);
  }

  request(reason?: string): SoftPauseState {
    const normalizedReason = normalizeReason(reason);
    const state: SoftPauseState = {
      version: 1,
      requestedAt: new Date().toISOString(),
      ...(normalizedReason ? { reason: normalizedReason } : {}),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return state;
  }

  clear(): boolean {
    const active = this.status() !== undefined;
    rmSync(this.filePath, { force: true });
    return active;
  }

  status(): SoftPauseState | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
    } catch {
      return undefined;
    }
    if (!isSoftPauseState(parsed)) return undefined;
    return parsed;
  }

  decorateToolResult<T>(result: T): T {
    const state = this.status();
    if (!state || !isToolResultLike(result)) return result;

    const advisory = softPauseAdvisory(state);
    const content = Array.isArray(result.content)
      ? [...result.content, { type: "text", text: advisory }]
      : [{ type: "text", text: advisory }];
    const structuredContent = isRecord(result.structuredContent)
      ? {
          ...result.structuredContent,
          ...(typeof result.structuredContent.result === "string"
            ? { result: `${result.structuredContent.result}\n\n${advisory}` }
            : {}),
        }
      : result.structuredContent;

    return {
      ...result,
      content,
      _meta: {
        ...(isRecord(result._meta) ? result._meta : {}),
        workbridgeSoftPause: {
          state: "requested",
          requestedAt: state.requestedAt,
          ...(state.reason ? { reason: state.reason } : {}),
        },
      },
      ...(structuredContent ? { structuredContent } : {}),
    } as T;
  }
}

export function softPauseAdvisory(state: SoftPauseState): string {
  const reason = state.reason ? ` Reason: ${state.reason}` : "";
  return [
    "[WORKBRIDGE_SOFT_PAUSE_REQUESTED]",
    `A non-urgent local pause was requested.${reason}`,
    "Complete only the current coherent step, then stop calling tools when convenient and tell the user: \"作業を一時中断しました\".",
    "Additional tool calls remain allowed if needed to reach a safe stopping point.",
  ].join("\n");
}

function normalizeReason(reason: string | undefined): string | undefined {
  const normalized = reason?.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, MAX_REASON_LENGTH) : undefined;
}

function isSoftPauseState(value: unknown): value is SoftPauseState {
  return isRecord(value)
    && value.version === 1
    && typeof value.requestedAt === "string"
    && (value.reason === undefined || typeof value.reason === "string");
}

function isToolResultLike(value: unknown): value is ToolResultLike {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
