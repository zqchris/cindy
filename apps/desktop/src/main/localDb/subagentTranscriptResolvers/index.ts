/**
 * Reads back the child-session content captured for one durable Subagent run.
 *
 * All three harnesses capture during the run and hand the content to Cindy on
 * the terminal frame, so there is a single read path here. Reading a harness's
 * own on-disk format was considered and rejected: the subagent observation
 * frames carry no handle into those files, and the formats belong to upstream.
 */

import type {
  SubagentProvider,
  SubagentTranscriptPageResponse,
} from '@cindy/maker-shared/subagent-workspace';

import { and, eq, isNull } from 'drizzle-orm';

import { getDbClient } from '../client/current.js';
import { subagentRunAliases, subagentRuns } from '../schema.js';
import { resolveFileTranscript } from './file-based.js';

export interface TranscriptResolveOptions {
  cursor?: string;
  limit?: number;
}

const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 30;

export async function resolveSubagentTranscript(
  sessionId: string,
  provider: SubagentProvider,
  runIdOrAlias: string,
  options?: TranscriptResolveOptions,
): Promise<SubagentTranscriptPageResponse> {
  const row = await findRunRow(sessionId, provider, runIdOrAlias);
  // A run with no file yet is still "supported": content lands on the terminal
  // frame, so a running child legitimately has nothing to show.
  if (!row) return { supported: false, entries: [] };
  if (!row.transcriptFile) return { supported: true, entries: [] };

  const limit = Math.min(Math.max(1, options?.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  return resolveFileTranscript(row.transcriptFile, { cursor: options?.cursor, limit });
}

interface RunRowForTranscript {
  id: string;
  transcriptFile: string | null;
}

const TRANSCRIPT_ROW_COLUMNS = {
  id: subagentRuns.id,
  transcriptFile: subagentRuns.transcriptFile,
} as const;

async function findRunRow(
  sessionId: string,
  provider: SubagentProvider,
  runIdOrAlias: string,
): Promise<RunRowForTranscript | null> {
  const db = getDbClient().drizzle;
  const visibility = [
    eq(subagentRuns.sessionId, sessionId),
    eq(subagentRuns.provider, provider),
    isNull(subagentRuns.rewindAt),
    isNull(subagentRuns.deletedAt),
  ];

  const [direct] = await db
    .select(TRANSCRIPT_ROW_COLUMNS)
    .from(subagentRuns)
    .where(and(...visibility, eq(subagentRuns.id, runIdOrAlias)))
    .limit(1);
  if (direct) return direct;

  const [aliased] = await db
    .select(TRANSCRIPT_ROW_COLUMNS)
    .from(subagentRunAliases)
    .innerJoin(subagentRuns, eq(subagentRunAliases.runId, subagentRuns.id))
    .where(and(...visibility, eq(subagentRunAliases.alias, runIdOrAlias)))
    .limit(1);
  return aliased ?? null;
}
