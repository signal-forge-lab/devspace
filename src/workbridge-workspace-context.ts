import type { SessionMonitorWorkspaceContext } from "./session-monitor.js";
import type { Workspace } from "./workspaces.js";

export function buildMonitorWorkspaceContext(
  workspace: Workspace,
  result?: unknown,
): SessionMonitorWorkspaceContext {
  const structured = objectValue(objectValue(result)?.structuredContent);
  const worktree = workspace.worktree;
  return {
    mode: workspace.mode,
    base: worktree
      ? [
          worktree.baseRef,
          worktree.baseSha ? worktree.baseSha.slice(0, 8) : undefined,
          worktree.dirtySource ? "source dirty" : undefined,
        ].filter(Boolean).join(" · ")
      : undefined,
    sourceRoot: workspace.sourceRoot && workspace.sourceRoot !== workspace.root
      ? workspace.sourceRoot
      : undefined,
    loadedInstructions: stringFields(structured?.agentsFiles, "path"),
    availableInstructions: stringFields(structured?.availableAgentsFiles, "path"),
    skills: uniqueStrings(workspace.skills.map((skill) => skill.name)),
    explicitOnlySkills: uniqueStrings(
      workspace.skills
        .filter((skill) => skill.disableModelInvocation)
        .map((skill) => skill.name),
    ),
    agents: uniqueStrings(workspace.agentProfiles.map(formatAgent).filter(Boolean)),
  };
}

function recordFields(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(objectValue).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function stringFields(value: unknown, key: string): string[] {
  return uniqueStrings(recordFields(value).map((item) => stringValue(item[key])).filter(Boolean));
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).slice(0, 24);
}

function formatAgent(value: unknown): string {
  const record = objectValue(value);
  if (!record) return "";
  return [
    stringValue(record.name),
    stringValue(record.provider),
    stringValue(record.model),
    stringValue(record.thinking),
  ].filter(Boolean).join(" · ");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
