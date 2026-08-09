import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_LEGACY_CODEX_SKILLS_LINK_NAME,
  CODEX_SHARED_AGENTS_SKILLS_LINK_NAME,
  codexGlobalSkillsPaths,
  prepareCodexGlobalSkillsLinks,
} from '../maker-host/codex-global-skills';

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-global-skills-'));
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

describe('prepareCodexGlobalSkillsLinks', () => {
  it('removes legacy whole-root imports and keeps native harness roots isolated by default', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');
    await writeSkill(agentsSkills, 'shared-skill');
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    await fs.mkdir(paths.skillsDir, { recursive: true });
    await fs.symlink(
      legacySkills,
      paths.legacyCodexSkillsLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await fs.symlink(
      agentsSkills,
      paths.sharedAgentsSkillsLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(path.basename(paths.legacyCodexSkillsLink)).toBe(CODEX_LEGACY_CODEX_SKILLS_LINK_NAME);
    expect(path.basename(paths.sharedAgentsSkillsLink)).toBe(CODEX_SHARED_AGENTS_SKILLS_LINK_NAME);
    await expect(fs.lstat(paths.legacyCodexSkillsLink)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(paths.sharedAgentsSkillsLink)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(path.join(paths.skillsDir, 'legacy-skill'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.lstat(path.join(paths.skillsDir, 'shared-skill'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('imports only skills explicitly configured for Cindy', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const sharedSkill = await writeSkill(agentsSkills, 'shared-skill');
    await writeSkill(agentsSkills, 'private-skill');
    const bridgeConfigPath = await writeBridgeConfig(root, [
      { source: 'agents', skill: 'shared-skill', targets: ['cindy'] },
    ]);

    const result = await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      bridgeConfigPath,
    });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);

    expect(await sameRealPath(path.join(paths.skillsDir, 'shared-skill'), sharedSkill)).toBe(true);
    await expect(fs.lstat(path.join(paths.skillsDir, 'private-skill'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(result.sources.find((source) => source.name === 'shared-skill')?.status).toBe('linked');
  });

  it('imports Cindy-managed plugin skills individually without an agents root link', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const pluginSkill = await writeSkill(
      path.join(root, 'owner', 'cindy-brain', 'my-plugin', 'skills'),
      'plugin-skill',
    );
    const pluginLinkName = 'my-plugin--plugin-skill';
    await fs.mkdir(agentsSkills, { recursive: true });
    await fs.symlink(
      pluginSkill,
      path.join(agentsSkills, pluginLinkName),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);

    expect(result.warnings).toEqual([]);
    expect(await sameRealPath(path.join(paths.skillsDir, pluginLinkName), pluginSkill)).toBe(true);
    await expect(fs.lstat(paths.sharedAgentsSkillsLink)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a configured direct bridge after its source disappears', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const sharedSkill = await writeSkill(agentsSkills, 'removed-later');
    const bridgeConfigPath = await writeBridgeConfig(root, [
      { source: 'agents', skill: 'removed-later', targets: ['cindy'] },
    ]);

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    await prepareCodexGlobalSkillsLinks(codexHome, { homeDir, bridgeConfigPath });
    expect(await sameRealPath(path.join(paths.skillsDir, 'removed-later'), sharedSkill)).toBe(true);

    await fs.rm(sharedSkill, { recursive: true, force: true });
    const result = await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      bridgeConfigPath,
    });

    expect(
      result.sources.some((source) => source.name === 'removed-later' && source.status === 'missing'),
    ).toBe(true);
    await expect(fs.lstat(path.join(paths.skillsDir, 'removed-later'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not replace a real directory at a configured skill path', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    await writeSkill(agentsSkills, 'shared-skill');
    const bridgeConfigPath = await writeBridgeConfig(root, [
      { source: 'agents', skill: 'shared-skill', targets: ['cindy'] },
    ]);

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const conflictingDir = path.join(paths.skillsDir, 'shared-skill');
    await fs.mkdir(conflictingDir, { recursive: true });
    await fs.writeFile(path.join(conflictingDir, 'keep.txt'), 'do not remove', 'utf8');

    const result = await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      bridgeConfigPath,
    });

    expect(result.sources.find((source) => source.name === 'shared-skill')?.status).toBe('conflict');
    await expect(fs.readFile(path.join(conflictingDir, 'keep.txt'), 'utf8')).resolves.toBe('do not remove');
    expect(result.warnings.some((warning) => warning.includes('shared-skill'))).toBe(true);
  });

  it('does not replace an unrelated user-owned symlink', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    await writeSkill(agentsSkills, 'shared-skill');
    const externalSkill = await writeSkill(path.join(root, 'external-skills'), 'shared-skill');
    const bridgeConfigPath = await writeBridgeConfig(root, [
      { source: 'agents', skill: 'shared-skill', targets: ['cindy'] },
    ]);
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    await fs.mkdir(paths.skillsDir, { recursive: true });
    const userLink = path.join(paths.skillsDir, 'shared-skill');
    await fs.symlink(externalSkill, userLink, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      bridgeConfigPath,
    });

    expect(await sameRealPath(userLink, externalSkill)).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('unrelated'))).toBe(true);
  });

  it('preserves a reserved legacy link name when the user points it elsewhere', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const externalSkills = path.join(root, 'external-skills');
    await writeSkill(externalSkills, 'external-skill');
    await fs.mkdir(paths.skillsDir, { recursive: true });
    await fs.symlink(
      externalSkills,
      paths.legacyCodexSkillsLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });

    expect(await sameRealPath(paths.legacyCodexSkillsLink, externalSkills)).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('points elsewhere'))).toBe(true);
  });

  it('preserves an old aggregate when one of its reserved links points elsewhere', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const oldAggregateDir = path.join(codexHome, 'global_skills');
    const externalSkills = path.join(root, 'external-skills');
    await writeSkill(externalSkills, 'external-skill');
    await fs.mkdir(paths.sharedAgentsSkillsDir, { recursive: true });
    await fs.mkdir(oldAggregateDir, { recursive: true });
    await fs.symlink(
      externalSkills,
      path.join(oldAggregateDir, 'codex'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await fs.symlink(
      paths.sharedAgentsSkillsDir,
      path.join(oldAggregateDir, 'agents'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });

    expect(await sameRealPath(path.join(oldAggregateDir, 'codex'), externalSkills)).toBe(true);
    expect(
      await sameRealPath(path.join(oldAggregateDir, 'agents'), paths.sharedAgentsSkillsDir),
    ).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('aggregate link points elsewhere')))
      .toBe(true);
  });

  it('removes the old aggregate scan link without deleting non-managed files', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');

    const oldAggregateDir = path.join(codexHome, 'global_skills');
    const oldScanEntry = path.join(codexHome, 'skills', 'xdt-global');
    await fs.mkdir(path.join(codexHome, 'skills'), { recursive: true });
    await fs.mkdir(oldAggregateDir, { recursive: true });
    await fs.symlink(oldAggregateDir, oldScanEntry, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(path.join(oldAggregateDir, 'keep.txt'), 'do not remove', 'utf8');

    await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);

    await expect(fs.lstat(oldScanEntry)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(oldAggregateDir, 'keep.txt'), 'utf8')).resolves.toBe('do not remove');
    await expect(fs.lstat(paths.legacyCodexSkillsLink)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
