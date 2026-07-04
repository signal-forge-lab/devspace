import { readFileTool } from "./pi-tools.js";
import type { Workspace, WorkspaceRegistry } from "./workspaces.js";

export const DEFAULT_MAX_TOTAL_CHARACTERS = 120_000;
export const MAX_READ_MANY_FILES = 20;

export interface ReadManyFileInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadManyInput {
  files: ReadManyFileInput[];
  maxTotalCharacters?: number;
}

export interface ReadManyFileResult {
  path: string;
  ok: boolean;
  content?: string;
  error?: string;
  offset: number;
  limited: boolean;
  characters?: number;
  lines?: number;
}

export interface ReadManyResult extends Record<string, unknown> {
  files: ReadManyFileResult[];
  summary: {
    requested: number;
    succeeded: number;
    failed: number;
    characters: number;
    truncated: boolean;
  };
  result: string;
}

export async function readManyFiles(
  input: ReadManyInput,
  workspace: Workspace,
  workspaces: WorkspaceRegistry,
): Promise<ReadManyResult> {
  const maxTotalCharacters =
    input.maxTotalCharacters ?? DEFAULT_MAX_TOTAL_CHARACTERS;
  const files: ReadManyFileResult[] = [];
  let characters = 0;
  let truncated = false;

  for (const file of input.files) {
    const offset = file.offset ?? 1;
    const remainingCharacters = Math.max(
      0,
      maxTotalCharacters - characters,
    );

    try {
      const readPath = workspaces.resolveReadPath(workspace, file.path);
      const response = await readFileTool(
        {
          path: readPath.absolutePath,
          offset: file.offset,
          limit: file.limit,
        },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        files.push({
          path: file.path,
          ok: false,
          error: contentText(response.content),
          offset,
          limited: false,
        });
        continue;
      }

      workspaces.markReadPathLoaded(workspace, readPath);
      const fullContent = contentText(response.content);
      const content = fullContent.slice(0, remainingCharacters);
      const characterLimited = content.length < fullContent.length;
      characters += content.length;
      truncated ||= characterLimited;

      files.push({
        path: file.path,
        ok: true,
        content,
        offset,
        limited: file.limit !== undefined || characterLimited,
        characters: content.length,
        lines: contentLineCount(content),
      });
    } catch (error) {
      files.push({
        path: file.path,
        ok: false,
        error: errorMessage(error),
        offset,
        limited: false,
      });
    }
  }

  const succeeded = files.filter((file) => file.ok).length;
  const failed = files.length - succeeded;
  const summary = {
    requested: input.files.length,
    succeeded,
    failed,
    characters,
    truncated,
  };

  return {
    files,
    summary,
    result: formatReadManyResult(files),
  };
}

function contentText(
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >,
): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatReadManyResult(files: ReadManyFileResult[]): string {
  return files
    .map((file) => {
      const heading = `# ${file.path.replace(/[\r\n]+/g, " ")}`;
      if (!file.ok) return `${heading}\n[error] ${file.error ?? "Unknown error"}`;
      if (file.content) {
        return `${heading}\n${file.content}${file.limited ? "\n[limited]" : ""}`;
      }
      if (file.limited) {
        return `${heading}\n[truncated: maxTotalCharacters reached]`;
      }
      return heading;
    })
    .join("\n\n");
}
