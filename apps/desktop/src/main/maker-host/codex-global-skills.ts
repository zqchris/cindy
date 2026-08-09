import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  normalizeForCompare,
  realPathOrNull,
} from './managed-dir-links.js';
import {
  reconcileGlobalSkillBridges,
  type SkillBridgeLinkStatus,
} from './global-skill-bridges.js';

export const CODEX_LEGACY_CODEX_SKILLS_LINK_NAME = 'xdt-codex';
export const CODEX_SHARED_AGENTS_SKILLS_LINK_NAME = 'xdt-agents';

export interface CodexGlobalSkillSourceResult {
  name: string;
  source: string;
  link: string;
  status: SkillBridgeLinkStatus;
  reason?: string;
}

export interface CodexGlobalSkillsPrepareResult {
  codexHome: string;
  skillsDir: string;
  configPath: string;
  statePath: string;
  changed: boolean;
  sources: CodexGlobalSkillSourceResult[];
  warnings: string[];
}

interface PrepareOptions {
  homeDir?: string;
  bridgeConfigPath?: string;
  bridgeStatePath?: string;
}

async function legacyLinkMatchesExpected(
  linkPath: string,
  expectedTarget: string,
): Promise<boolean> {
  const [linkReal, targetReal] = await Promise.all([
    realPathOrNull(linkPath),
    realPathOrNull(expectedTarget),
  ]);
  if (linkReal && targetReal && linkReal === targetReal) return true;

  try {
    const rawTarget = await fsp.readlink(linkPath);
    const resolvedTarget = path.isAbsolute(rawTarget)
      ? rawTarget
      : path.resolve(path.dirname(linkPath), rawTarget);
    return normalizeForCompare(resolvedTarget) === normalizeForCompare(expectedTarget);
  } catch {
    return false;
  }
}

async function removeLegacyLinkIfExpected(
  linkPath: string,
  expectedTarget: string,
): Promise<{ changed: boolean; warning?: string }> {
  let stat;
  try {
    stat = await fsp.lstat(linkPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { changed: false };
    throw err;
  }
  if (!stat.isSymbolicLink()) {
    return {
      changed: false,
      warning: `reserved legacy skill path is user-owned and was not removed: ${linkPath}`,
    };
  }

  if (!(await legacyLinkMatchesExpected(linkPath, expectedTarget))) {
    return {
      changed: false,
      warning: `reserved legacy skill link points elsewhere and was not removed: ${linkPath}`,
    };
  }

  await fsp.rm(linkPath, { recursive: true, force: true });
  return { changed: true };
}

async function cleanupLegacyAggregate(
  codexHome: string,
  legacyCodexSkillsDir: string,
  sharedAgentsSkillsDir: string,
): Promise<{ changed: boolean; warnings: string[] }> {
  const legacyScanEntry = path.join(codexHome, 'skills', 'xdt-global');
  const legacyAggregateDir = path.join(codexHome, 'global_skills');
  const scanCleanup = await removeLegacyLinkIfExpected(legacyScanEntry, legacyAggregateDir);
  let changed = scanCleanup.changed;
  const warnings = scanCleanup.warning ? [scanCleanup.warning] : [];
  let entries: string[];
  try {
    entries = await fsp.readdir(legacyAggregateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { changed, warnings };
    throw err;
  }

  const removableTargets = new Map([
    ['codex', legacyCodexSkillsDir],
    ['agents', sharedAgentsSkillsDir],
  ]);
  for (const entry of entries) {
    const expectedTarget = removableTargets.get(entry);
    if (!expectedTarget) return { changed, warnings };
    const entryPath = path.join(legacyAggregateDir, entry);
    try {
      const stat = await fsp.lstat(entryPath);
      if (!stat.isSymbolicLink()) {
        warnings.push(
          `reserved legacy aggregate path is user-owned and was not removed: ${entryPath}`,
        );
        return { changed, warnings };
      }
    } catch {
      return { changed, warnings };
    }
    if (!(await legacyLinkMatchesExpected(entryPath, expectedTarget))) {
      warnings.push(
        `reserved legacy aggregate link points elsewhere and was not removed: ${entryPath}`,
      );
      return { changed, warnings };
    }
  }

  for (const entry of entries) {
    await fsp.rm(path.join(legacyAggregateDir, entry), { recursive: true, force: true });
    changed = true;
  }
  await fsp.rmdir(legacyAggregateDir).then(
    () => { changed = true; },
    () => undefined,
  );
  return { changed, warnings };
}

export function codexGlobalSkillsPaths(codexHome: string, homeDir = os.homedir()) {
  const skillsDir = path.join(codexHome, 'skills');
  return {
    codexHome,
    skillsDir,
    legacyCodexSkillsLink: path.join(skillsDir, CODEX_LEGACY_CODEX_SKILLS_LINK_NAME),
    sharedAgentsSkillsLink: path.join(skillsDir, CODEX_SHARED_AGENTS_SKILLS_LINK_NAME),
    legacyCodexSkillsDir: path.join(homeDir, '.codex', 'skills'),
    sharedAgentsSkillsDir: path.join(homeDir, '.agents', 'skills'),
  };
}

export async function prepareCodexGlobalSkillsLinks(
  codexHome: string,
  opts: PrepareOptions = {},
): Promise<CodexGlobalSkillsPrepareResult> {
  const paths = codexGlobalSkillsPaths(codexHome, opts.homeDir);
  await fsp.mkdir(paths.codexHome, { recursive: true });
  await fsp.mkdir(paths.skillsDir, { recursive: true });

  const warnings: string[] = [];
  let changed = false;
  const aggregateCleanup = await cleanupLegacyAggregate(
    paths.codexHome,
    paths.legacyCodexSkillsDir,
    paths.sharedAgentsSkillsDir,
  );
  changed = aggregateCleanup.changed || changed;
  warnings.push(...aggregateCleanup.warnings);
  for (const [linkPath, expectedTarget] of [
    [paths.legacyCodexSkillsLink, paths.legacyCodexSkillsDir],
    [paths.sharedAgentsSkillsLink, paths.sharedAgentsSkillsDir],
  ] as const) {
    const result = await removeLegacyLinkIfExpected(linkPath, expectedTarget);
    changed = result.changed || changed;
    if (result.warning) warnings.push(result.warning);
  }

  const bridgeResult = await reconcileGlobalSkillBridges({
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    ...(opts.bridgeConfigPath !== undefined ? { configPath: opts.bridgeConfigPath } : {}),
    ...(opts.bridgeStatePath !== undefined ? { statePath: opts.bridgeStatePath } : {}),
    targets: { cindy: paths.skillsDir },
    includeCindyPluginSkills: true,
  });
  changed = bridgeResult.changed || changed;
  warnings.push(...bridgeResult.warnings);

  const sources: CodexGlobalSkillSourceResult[] = bridgeResult.actions.map((action) => ({
    name: action.name,
    source: action.source,
    link: action.target,
    status: action.status,
    ...(action.reason ? { reason: action.reason } : {}),
  }));

  return {
    codexHome: paths.codexHome,
    skillsDir: paths.skillsDir,
    configPath: bridgeResult.configPath,
    statePath: bridgeResult.statePath,
    changed,
    sources,
    warnings,
  };
}
