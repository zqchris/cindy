import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  prepareSharedGlobalSkillLinks,
  prepareSharedProjectSkillLinks,
  projectWorkingDirFromSkillPath,
  sharedGlobalSkillsPaths,
  sharedProjectSkillsPaths,
} from '../maker-host/shared-global-skills';

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-global-skills-'));
  tmpDirs.push(dir);
  return dir;
}

async function writeSkill(skillsDir: string, name: string): Promise<string> {
  const skillDir = path.join(skillsDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test skill\n---\n\nbody\n`,
    'utf8',
  );
  return skillDir;
}

async function sameRealPath(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(ra) === normalize(rb);
}

async function writeBridgeConfig(
  root: string,
  bridges: Array<{ source: string; skill: string; targets: string[] }>,
): Promise<string> {
  const configPath = path.join(root, 'skill-bridges.json');
  await fs.writeFile(configPath, JSON.stringify({ version: 1, bridges }), 'utf8');
  return configPath;
}

afterEach(async () => {
  const dirs = tmpDirs;
  tmpDirs = [];
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('prepareSharedGlobalSkillLinks', () => {
  it('keeps native roots isolated by default and preserves an unmanaged manual bridge', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'shared-only');
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'claude-only');
    const manualBridge = path.join(paths.claudeSkillsDir, 'shared-only');
    await fs.symlink(sharedSkill, manualBridge, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await prepareSharedGlobalSkillLinks({ homeDir });

    expect(result.changed).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(await sameRealPath(manualBridge, sharedSkill)).toBe(true);
    await expect(fs.lstat(path.join(paths.sharedSkillsDir, 'claude-only'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'claude-only'), claudeSkill)).toBe(true);
  });

  it('links only explicitly configured skills to the requested harnesses', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'shared-skill');
    await writeSkill(paths.sharedSkillsDir, 'private-skill');
    const bridgeConfigPath = await writeBridgeConfig(root, [
      { source: 'agents', skill: 'shared-skill', targets: ['claude', 'codex'] },
    ]);

    const result = await prepareSharedGlobalSkillLinks({ homeDir, bridgeConfigPath });

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'shared-skill'), sharedSkill)).toBe(true);
    expect(await sameRealPath(path.join(paths.codexSkillsDir, 'shared-skill'), sharedSkill)).toBe(true);
    await expect(fs.lstat(path.join(paths.claudeSkillsDir, 'private-skill'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.lstat(path.join(paths.codexSkillsDir, 'private-skill'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('is idempotent after the configured bridge exists', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    await writeSkill(paths.sharedSkillsDir, 'shared-skill');
    const bridgeConfigPath = await writeBridgeConfig(root, [
      { source: 'agents', skill: 'shared-skill', targets: ['claude'] },
    ]);

    await prepareSharedGlobalSkillLinks({ homeDir, bridgeConfigPath });
    const secondResult = await prepareSharedGlobalSkillLinks({ homeDir, bridgeConfigPath });

    expect(secondResult.changed).toBe(false);
    expect(secondResult.warnings).toEqual([]);
    expect(secondResult.actions.find((action) => action.name === 'shared-skill')?.status).toBe('kept');
  });

  it('does not adopt a matching user-owned link into Cindy-managed state', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'manual-shared');
    const manualBridge = path.join(paths.claudeSkillsDir, 'manual-shared');
    await fs.mkdir(paths.claudeSkillsDir, { recursive: true });
    await fs.symlink(
      sharedSkill,
      manualBridge,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const bridgeConfigPath = await writeBridgeConfig(root, [
      { source: 'agents', skill: 'manual-shared', targets: ['claude'] },
    ]);

    const firstResult = await prepareSharedGlobalSkillLinks({ homeDir, bridgeConfigPath });
    await fs.writeFile(
      bridgeConfigPath,
      JSON.stringify({ version: 1, bridges: [] }),
      'utf8',
    );
    const secondResult = await prepareSharedGlobalSkillLinks({ homeDir, bridgeConfigPath });

    expect(firstResult.changed).toBe(false);
    expect(secondResult.changed).toBe(false);
    expect(await sameRealPath(manualBridge, sharedSkill)).toBe(true);
  });

  it('does not overwrite conflicting real skill directories', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'duplicate');
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'duplicate');
    const bridgeConfigPath = await writeBridgeConfig(root, [
      { source: 'agents', skill: 'duplicate', targets: ['claude'] },
    ]);

    const result = await prepareSharedGlobalSkillLinks({ homeDir, bridgeConfigPath });

    expect(result.warnings.some((warning) => warning.includes('duplicate'))).toBe(true);
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'duplicate'), sharedSkill)).toBe(true);
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'duplicate'), claudeSkill)).toBe(true);
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'duplicate'), path.join(paths.claudeSkillsDir, 'duplicate'))).toBe(false);
  });

  it('does not overwrite user-owned symlinks that point elsewhere', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'user-link');
    const externalSkill = await writeSkill(path.join(root, 'external-skills'), 'user-link');
    const claudeLink = path.join(paths.claudeSkillsDir, 'user-link');
    await fs.mkdir(paths.claudeSkillsDir, { recursive: true });
    await fs.symlink(externalSkill, claudeLink, process.platform === 'win32' ? 'junction' : 'dir');
    const bridgeConfigPath = await writeBridgeConfig(root, [
      { source: 'agents', skill: 'user-link', targets: ['claude'] },
    ]);

    const result = await prepareSharedGlobalSkillLinks({ homeDir, bridgeConfigPath });

    expect(result.warnings.some((warning) => warning.includes('user-link'))).toBe(true);
    expect(await sameRealPath(claudeLink, externalSkill)).toBe(true);
    expect(await sameRealPath(claudeLink, sharedSkill)).toBe(false);
  });

  it('removes a configured bridge after its source skill disappears', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'removed-later');
    const bridgeConfigPath = await writeBridgeConfig(root, [
      { source: 'agents', skill: 'removed-later', targets: ['claude'] },
    ]);

    await prepareSharedGlobalSkillLinks({ homeDir, bridgeConfigPath });
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'removed-later'), sharedSkill)).toBe(true);

    await fs.rm(sharedSkill, { recursive: true, force: true });
    const result = await prepareSharedGlobalSkillLinks({ homeDir, bridgeConfigPath });

    expect(result.changed).toBe(true);
    expect(result.actions.some((action) => action.status === 'missing')).toBe(true);
    await expect(fs.lstat(path.join(paths.claudeSkillsDir, 'removed-later'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each([
    ['invalid JSON', '{'],
    ['unsupported version', JSON.stringify({ version: 2, bridges: [] })],
  ])('leaves existing bridges untouched when config has %s', async (_label, invalidConfig) => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'shared-skill');
    const bridgeConfigPath = await writeBridgeConfig(root, [
      { source: 'agents', skill: 'shared-skill', targets: ['claude'] },
    ]);
    await prepareSharedGlobalSkillLinks({ homeDir, bridgeConfigPath });
    await fs.writeFile(bridgeConfigPath, invalidConfig, 'utf8');

    const result = await prepareSharedGlobalSkillLinks({ homeDir, bridgeConfigPath });

    expect(result.changed).toBe(false);
    expect(result.warnings.some((warning) => warning.includes('invalid'))).toBe(true);
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'shared-skill'), sharedSkill)).toBe(true);
  });

  it('leaves existing bridges untouched when the config cannot be read', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'shared-skill');
    const bridgeConfigPath = await writeBridgeConfig(root, [
      { source: 'agents', skill: 'shared-skill', targets: ['claude'] },
    ]);
    await prepareSharedGlobalSkillLinks({ homeDir, bridgeConfigPath });
    await fs.rm(bridgeConfigPath);
    await fs.mkdir(bridgeConfigPath);

    const result = await prepareSharedGlobalSkillLinks({ homeDir, bridgeConfigPath });

    expect(result.changed).toBe(false);
    expect(result.warnings.some((warning) => warning.includes('cannot read'))).toBe(true);
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'shared-skill'), sharedSkill)).toBe(true);
  });
});

describe('prepareSharedProjectSkillLinks', () => {
  it('exposes a legacy Claude project skill to Codex without copying it', async () => {
    const workingDir = await makeTmpDir();
    const paths = sharedProjectSkillsPaths(workingDir);
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'legacy');

    const result = await prepareSharedProjectSkillLinks({ workingDir });
    const sharedLink = path.join(paths.sharedSkillsDir, 'legacy');

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect((await fs.lstat(sharedLink)).isSymbolicLink()).toBe(true);
    expect(await sameRealPath(sharedLink, claudeSkill)).toBe(true);
    if (process.platform !== 'win32') {
      expect(path.isAbsolute(await fs.readlink(sharedLink))).toBe(false);
    }
  });

  it('exposes a canonical shared project skill to Claude without copying it', async () => {
    const workingDir = await makeTmpDir();
    const paths = sharedProjectSkillsPaths(workingDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'shared');

    const result = await prepareSharedProjectSkillLinks({ workingDir });
    const claudeLink = path.join(paths.claudeSkillsDir, 'shared');

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect((await fs.lstat(claudeLink)).isSymbolicLink()).toBe(true);
    expect(await sameRealPath(claudeLink, sharedSkill)).toBe(true);
  });

  it('does not create empty discovery roots when the project has no skills', async () => {
    const workingDir = await makeTmpDir();
    const paths = sharedProjectSkillsPaths(workingDir);

    const result = await prepareSharedProjectSkillLinks({ workingDir });

    expect(result).toMatchObject({ changed: false, actions: [], warnings: [] });
    await expect(fs.lstat(paths.sharedSkillsDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(paths.claudeSkillsDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps conflicting real project skills on both sides', async () => {
    const workingDir = await makeTmpDir();
    const paths = sharedProjectSkillsPaths(workingDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'duplicate');
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'duplicate');

    const result = await prepareSharedProjectSkillLinks({ workingDir });

    expect(result.warnings.some((warning) => warning.includes('duplicate'))).toBe(true);
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'duplicate'), sharedSkill)).toBe(true);
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'duplicate'), claudeSkill)).toBe(true);
    expect(await sameRealPath(sharedSkill, claudeSkill)).toBe(false);
  });

  it('repairs a broken absolute project link after the checkout moves', async () => {
    const root = await makeTmpDir();
    const oldWorkingDir = path.join(root, 'old-checkout');
    const workingDir = path.join(root, 'moved-checkout');
    const oldPaths = sharedProjectSkillsPaths(oldWorkingDir);
    const paths = sharedProjectSkillsPaths(workingDir);
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'moved-skill');
    const staleSharedLink = path.join(paths.sharedSkillsDir, 'moved-skill');
    await fs.mkdir(paths.sharedSkillsDir, { recursive: true });
    await fs.symlink(
      path.join(oldPaths.claudeSkillsDir, 'moved-skill'),
      staleSharedLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await prepareSharedProjectSkillLinks({ workingDir });

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await sameRealPath(staleSharedLink, claudeSkill)).toBe(true);
  });

  it('does not replace an unrelated broken project skill symlink', async () => {
    const root = await makeTmpDir();
    const workingDir = path.join(root, 'checkout');
    const paths = sharedProjectSkillsPaths(workingDir);
    await writeSkill(paths.claudeSkillsDir, 'user-link');
    const userLink = path.join(paths.sharedSkillsDir, 'user-link');
    const externalTarget = path.join(root, 'removed-external-skills', 'user-link');
    await fs.mkdir(paths.sharedSkillsDir, { recursive: true });
    await fs.symlink(
      externalTarget,
      userLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await prepareSharedProjectSkillLinks({ workingDir });

    expect(result.changed).toBe(false);
    expect(result.warnings.some((warning) => warning.includes('user-link'))).toBe(true);
    expect(await fs.readlink(userLink)).toBe(externalTarget);
  });
});

describe('projectWorkingDirFromSkillPath', () => {
  it('accepts only direct project skill discovery children', () => {
    const projectRoot = path.resolve(path.sep, 'projects', 'demo');
    expect(
      projectWorkingDirFromSkillPath(
        path.join(projectRoot, '.agents', 'skills', 'my-skill'),
      ),
    ).toBe(projectRoot);
    expect(
      projectWorkingDirFromSkillPath(
        path.join(projectRoot, '.claude', 'skills', 'my-skill'),
      ),
    ).toBe(projectRoot);
    expect(projectWorkingDirFromSkillPath(path.join(projectRoot, 'skills', 'my-skill')))
      .toBeNull();
  });
});
