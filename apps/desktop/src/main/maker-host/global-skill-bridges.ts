import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

export const SKILL_BRIDGE_CONFIG_VERSION = 1;
const SKILL_BRIDGE_STATE_VERSION = 1;

export type HarnessSkillRootName = 'agents' | 'claude' | 'codex';
export type SkillBridgeTargetName = HarnessSkillRootName | 'cindy';
export type SkillBridgeLinkStatus =
  | 'linked'
  | 'kept'
  | 'removed'
  | 'missing'
  | 'conflict'
  | 'skipped'
  | 'error';

interface SkillBridgeRule {
  source: HarnessSkillRootName;
  skill: string;
  targets: SkillBridgeTargetName[];
}

interface SkillBridgeConfig {
  version: typeof SKILL_BRIDGE_CONFIG_VERSION;
  bridges: SkillBridgeRule[];
}

interface ManagedBridgeRecord {
  source: string;
  target: string;
}

interface ManagedBridgeState {
  version: typeof SKILL_BRIDGE_STATE_VERSION;
  links: ManagedBridgeRecord[];
}

export interface SkillBridgeAction {
  name: string;
  source: string;
  target: string;
  status: SkillBridgeLinkStatus;
  reason?: string;
}

export interface SkillBridgeReconcileResult {
  changed: boolean;
  actions: SkillBridgeAction[];
  warnings: string[];
  configPath: string;
  statePath: string;
}

interface ReconcileOptions {
  homeDir?: string;
  configPath?: string;
  statePath?: string;
  targets: Partial<Record<SkillBridgeTargetName, string>>;
  includeCindyPluginSkills?: boolean;
}

interface DesiredBridge {
  name: string;
  source: string;
  targetName: SkillBridgeTargetName;
  target: string;
}

type LoadStatus = 'valid' | 'missing' | 'invalid';

const ROOT_NAMES: HarnessSkillRootName[] = ['agents', 'claude', 'codex'];
const TARGET_NAMES: SkillBridgeTargetName[] = ['agents', 'claude', 'codex', 'cindy'];
const SKILL_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function equalsPath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

async function realPathOrNull(value: string): Promise<string | null> {
  try {
    return normalizeForCompare(await fsp.realpath(value));
  } catch {
    return null;
  }
}

async function hasSkillFile(dirPath: string): Promise<boolean> {
  for (const name of ['SKILL.md', 'skill.md']) {
    try {
      if ((await fsp.stat(path.join(dirPath, name))).isFile()) return true;
    } catch {
      // Try the other supported casing.
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRootName(value: unknown): value is HarnessSkillRootName {
  return typeof value === 'string' && ROOT_NAMES.includes(value as HarnessSkillRootName);
}

function isTargetName(value: unknown): value is SkillBridgeTargetName {
  return typeof value === 'string' && TARGET_NAMES.includes(value as SkillBridgeTargetName);
}

export function globalHarnessSkillRoots(homeDir = os.homedir()) {
  return {
    agents: path.join(homeDir, '.agents', 'skills'),
    claude: path.join(homeDir, '.claude', 'skills'),
    codex: path.join(homeDir, '.codex', 'skills'),
  } satisfies Record<HarnessSkillRootName, string>;
}

export function defaultSkillBridgeConfigPath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.config', 'cindy', 'skill-bridges.json');
}

export function defaultSkillBridgeStatePath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.config', 'cindy', 'skill-bridges.state.json');
}

async function loadConfig(
  configPath: string,
): Promise<{ config: SkillBridgeConfig; status: LoadStatus; warnings: string[] }> {
  let raw: string;
  try {
    raw = await fsp.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        config: { version: SKILL_BRIDGE_CONFIG_VERSION, bridges: [] },
        status: 'missing',
        warnings: [],
      };
    }
    return {
      config: { version: SKILL_BRIDGE_CONFIG_VERSION, bridges: [] },
      status: 'invalid',
      warnings: [`cannot read skill bridge config ${configPath}: ${(err as Error).message}`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return {
      config: { version: SKILL_BRIDGE_CONFIG_VERSION, bridges: [] },
      status: 'invalid',
      warnings: [`invalid skill bridge config ${configPath}: ${(err as Error).message}`],
    };
  }

  if (!isRecord(parsed)
    || parsed.version !== SKILL_BRIDGE_CONFIG_VERSION
    || !Array.isArray(parsed.bridges)) {
    return {
      config: { version: SKILL_BRIDGE_CONFIG_VERSION, bridges: [] },
      status: 'invalid',
      warnings: [
        `invalid skill bridge config ${configPath}: expected { version: 1, bridges: [...] }`,
      ],
    };
  }

  const bridges: SkillBridgeRule[] = [];
  for (const [index, value] of parsed.bridges.entries()) {
    if (!isRecord(value)
      || !isRootName(value.source)
      || typeof value.skill !== 'string'
      || !SKILL_NAME_RE.test(value.skill)
      || !Array.isArray(value.targets)
      || value.targets.length === 0
      || !value.targets.every(isTargetName)) {
      return {
        config: { version: SKILL_BRIDGE_CONFIG_VERSION, bridges: [] },
        status: 'invalid',
        warnings: [`invalid skill bridge rule ${index} in ${configPath}; no links were changed`],
      };
    }

    const targets = Array.from(new Set(value.targets));
    bridges.push({ source: value.source, skill: value.skill, targets });
  }

  return {
    config: { version: SKILL_BRIDGE_CONFIG_VERSION, bridges },
    status: 'valid',
    warnings: [],
  };
}

async function loadState(
  statePath: string,
): Promise<{ state: ManagedBridgeState; status: LoadStatus; warnings: string[] }> {
  let raw: string;
  try {
    raw = await fsp.readFile(statePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        state: { version: SKILL_BRIDGE_STATE_VERSION, links: [] },
        status: 'missing',
        warnings: [],
      };
    }
    return {
      state: { version: SKILL_BRIDGE_STATE_VERSION, links: [] },
      status: 'invalid',
      warnings: [`cannot read skill bridge state ${statePath}: ${(err as Error).message}`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return {
      state: { version: SKILL_BRIDGE_STATE_VERSION, links: [] },
      status: 'invalid',
      warnings: [`invalid skill bridge state ${statePath}: ${(err as Error).message}`],
    };
  }

  if (!isRecord(parsed)
    || parsed.version !== SKILL_BRIDGE_STATE_VERSION
    || !Array.isArray(parsed.links)
    || !parsed.links.every((value) => isRecord(value)
      && typeof value.source === 'string'
      && path.isAbsolute(value.source)
      && typeof value.target === 'string'
      && path.isAbsolute(value.target))) {
    return {
      state: { version: SKILL_BRIDGE_STATE_VERSION, links: [] },
      status: 'invalid',
      warnings: [`invalid skill bridge state ${statePath}; no links were changed`],
    };
  }

  const links = new Map<string, ManagedBridgeRecord>();
  for (const value of parsed.links) {
    const record = value as unknown as ManagedBridgeRecord;
    links.set(normalizeForCompare(record.target), record);
  }
  return {
    state: { version: SKILL_BRIDGE_STATE_VERSION, links: [...links.values()] },
    status: 'valid',
    warnings: [],
  };
}

async function writeState(statePath: string, links: ManagedBridgeRecord[]): Promise<void> {
  const sorted = [...links].sort((a, b) => a.target.localeCompare(b.target));
  const content = `${JSON.stringify({
    version: SKILL_BRIDGE_STATE_VERSION,
    links: sorted,
  }, null, 2)}\n`;
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tempPath, content, 'utf8');
    await fsp.rename(tempPath, statePath);
  } catch (err) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

function targetLooksCindyManaged(targetPath: string, linkName: string): boolean {
  return linkName.includes('--')
    && targetPath
      .split(/[\\/]/)
      .some((segment) => segment.toLowerCase() === 'cindy-brain');
}

async function listCindyPluginBridges(
  agentsRoot: string,
  cindySkillsDir: string,
): Promise<DesiredBridge[]> {
  let entries;
  try {
    entries = await fsp.readdir(agentsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const desired: DesiredBridge[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isSymbolicLink()) continue;
    const source = path.join(agentsRoot, entry.name);
    let rawTarget: string;
    try {
      rawTarget = await fsp.readlink(source);
    } catch {
      continue;
    }
    const targetPath = path.isAbsolute(rawTarget)
      ? rawTarget
      : path.resolve(agentsRoot, rawTarget);
    if (!targetLooksCindyManaged(targetPath, entry.name)) continue;

    desired.push({
      name: entry.name,
      source,
      targetName: 'cindy',
      target: path.join(cindySkillsDir, entry.name),
    });
  }
  return desired;
}

async function linkMatchesSource(linkPath: string, sourcePath: string): Promise<boolean> {
  const [linkReal, sourceReal] = await Promise.all([
    realPathOrNull(linkPath),
    realPathOrNull(sourcePath),
  ]);
  if (linkReal && sourceReal && linkReal === sourceReal) return true;

  try {
    const rawTarget = await fsp.readlink(linkPath);
    const targetPath = path.isAbsolute(rawTarget)
      ? rawTarget
      : path.resolve(path.dirname(linkPath), rawTarget);
    return equalsPath(targetPath, sourcePath);
  } catch {
    return false;
  }
}

async function ensureExplicitBridge(
  bridge: DesiredBridge,
  alreadyManaged: boolean,
): Promise<{
  action: SkillBridgeAction;
  changed: boolean;
  managed: boolean;
  warning?: string;
}> {
  const actionBase = {
    name: bridge.name,
    source: bridge.source,
    target: bridge.target,
  };
  if (!(await hasSkillFile(bridge.source))) {
    return {
      action: {
        ...actionBase,
        status: 'missing',
        reason: 'source skill does not exist or has no SKILL.md',
      },
      changed: false,
      managed: false,
    };
  }

  try {
    const stat = await fsp.lstat(bridge.target);
    if (!stat.isSymbolicLink()) {
      const reason = 'path exists and is not a managed symlink/junction';
      return {
        action: { ...actionBase, status: 'conflict', reason },
        changed: false,
        managed: false,
        warning: `cannot link skill ${bridge.name} to ${bridge.target}: ${reason}`,
      };
    }
    if (await linkMatchesSource(bridge.target, bridge.source)) {
      return {
        action: { ...actionBase, status: 'kept' },
        changed: false,
        managed: alreadyManaged,
      };
    }

    const reason = 'path exists as an unrelated symlink/junction';
    return {
      action: { ...actionBase, status: 'conflict', reason },
      changed: false,
      managed: false,
      warning: `cannot link skill ${bridge.name} to ${bridge.target}: ${reason}`,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      const reason = (err as Error).message;
      return {
        action: { ...actionBase, status: 'error', reason },
        changed: false,
        managed: false,
        warning: `cannot link skill ${bridge.name} to ${bridge.target}: ${reason}`,
      };
    }
  }

  try {
    await fsp.mkdir(path.dirname(bridge.target), { recursive: true });
    await fsp.symlink(
      bridge.source,
      bridge.target,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    return {
      action: { ...actionBase, status: 'linked' },
      changed: true,
      managed: true,
    };
  } catch (err) {
    const reason = (err as Error).message;
    return {
      action: { ...actionBase, status: 'error', reason },
      changed: false,
      managed: false,
      warning: `cannot link skill ${bridge.name} to ${bridge.target}: ${reason}`,
    };
  }
}

function managedStateKey(target: string): string {
  return normalizeForCompare(target);
}

function bridgeKey(targetName: SkillBridgeTargetName, name: string): string {
  return `${targetName}\0${name}`;
}

async function reconcileGlobalSkillBridgesUnlocked(
  opts: ReconcileOptions,
): Promise<SkillBridgeReconcileResult> {
  const homeDir = opts.homeDir ?? os.homedir();
  const roots = globalHarnessSkillRoots(homeDir);
  const configPath = opts.configPath ?? defaultSkillBridgeConfigPath(homeDir);
  const statePath = opts.statePath ?? defaultSkillBridgeStatePath(homeDir);
  const [loadedConfig, loadedState] = await Promise.all([
    loadConfig(configPath),
    loadState(statePath),
  ]);
  const warnings = [...loadedConfig.warnings, ...loadedState.warnings];
  const actions: SkillBridgeAction[] = [];
  if (loadedConfig.status === 'invalid' || loadedState.status === 'invalid') {
    return { changed: false, actions, warnings, configPath, statePath };
  }

  const desiredCandidates: DesiredBridge[] = [];
  for (const rule of loadedConfig.config.bridges) {
    for (const targetName of rule.targets) {
      const targetRoot = opts.targets[targetName];
      if (!targetRoot) continue;
      if (targetName === rule.source) {
        actions.push({
          name: rule.skill,
          source: path.join(roots[rule.source], rule.skill),
          target: path.join(targetRoot, rule.skill),
          status: 'skipped',
          reason: 'source and target roots are the same',
        });
        continue;
      }
      desiredCandidates.push({
        name: rule.skill,
        source: path.join(roots[rule.source], rule.skill),
        targetName,
        target: path.join(targetRoot, rule.skill),
      });
    }
  }

  if (opts.includeCindyPluginSkills && opts.targets.cindy) {
    desiredCandidates.push(...await listCindyPluginBridges(roots.agents, opts.targets.cindy));
  }

  const desired = new Map<string, DesiredBridge>();
  for (const candidate of desiredCandidates) {
    const key = bridgeKey(candidate.targetName, candidate.name);
    const prior = desired.get(key);
    if (!prior) {
      desired.set(key, candidate);
      continue;
    }
    if (equalsPath(prior.source, candidate.source)) continue;
    warnings.push(
      `ignoring duplicate skill bridge for ${candidate.targetName}:${candidate.name} from ${candidate.source}`,
    );
  }

  const validDesired = new Map<string, DesiredBridge>();
  for (const [key, bridge] of desired) {
    if (await hasSkillFile(bridge.source)) validDesired.set(key, bridge);
  }

  const managed = new Map<string, ManagedBridgeRecord>();
  for (const record of loadedState.state.links) {
    managed.set(managedStateKey(record.target), record);
  }
  let stateDirty = false;
  let changed = false;

  for (const [targetName, targetRoot] of Object.entries(opts.targets) as Array<
    [SkillBridgeTargetName, string]
  >) {
    const records = [...managed.values()].filter((record) =>
      equalsPath(path.dirname(record.target), targetRoot));
    for (const record of records) {
      const key = managedStateKey(record.target);
      const desiredBridge = validDesired.get(bridgeKey(targetName, path.basename(record.target)));
      const stillDesired = desiredBridge
        && equalsPath(desiredBridge.target, record.target)
        && equalsPath(desiredBridge.source, record.source);

      let stat;
      try {
        stat = await fsp.lstat(record.target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          managed.delete(key);
          stateDirty = true;
          continue;
        }
        warnings.push(`cannot inspect managed skill bridge ${record.target}: ${(err as Error).message}`);
        continue;
      }

      if (!stat.isSymbolicLink() || !(await linkMatchesSource(record.target, record.source))) {
        managed.delete(key);
        stateDirty = true;
        warnings.push(`managed skill bridge was replaced; leaving user entry untouched: ${record.target}`);
        continue;
      }
      if (stillDesired) continue;

      try {
        await fsp.rm(record.target, { recursive: true, force: true });
        managed.delete(key);
        stateDirty = true;
        changed = true;
        actions.push({
          name: path.basename(record.target),
          source: record.source,
          target: record.target,
          status: 'removed',
          reason: 'Cindy-managed bridge is no longer explicitly enabled',
        });
      } catch (err) {
        const reason = (err as Error).message;
        actions.push({
          name: path.basename(record.target),
          source: record.source,
          target: record.target,
          status: 'error',
          reason,
        });
        warnings.push(`cannot remove stale managed skill bridge ${record.target}: ${reason}`);
      }
    }
  }

  for (const bridge of desired.values()) {
    const stateKey = managedStateKey(bridge.target);
    const result = await ensureExplicitBridge(bridge, managed.has(stateKey));
    actions.push(result.action);
    changed = changed || result.changed;
    if (result.warning) warnings.push(result.warning);
    if (!result.managed) continue;

    const prior = managed.get(stateKey);
    if (!prior
      || !equalsPath(prior.source, bridge.source)
      || !equalsPath(prior.target, bridge.target)) {
      managed.set(stateKey, { source: bridge.source, target: bridge.target });
      stateDirty = true;
    }
  }

  if (stateDirty) {
    try {
      await writeState(statePath, [...managed.values()]);
      changed = true;
    } catch (err) {
      warnings.push(`cannot persist skill bridge state ${statePath}: ${(err as Error).message}`);
    }
  }

  return { changed, actions, warnings, configPath, statePath };
}

let reconcileTail: Promise<void> = Promise.resolve();

export function reconcileGlobalSkillBridges(
  opts: ReconcileOptions,
): Promise<SkillBridgeReconcileResult> {
  const run = reconcileTail.then(
    () => reconcileGlobalSkillBridgesUnlocked(opts),
    () => reconcileGlobalSkillBridgesUnlocked(opts),
  );
  reconcileTail = run.then(() => undefined, () => undefined);
  return run;
}
