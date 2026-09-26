import { getAllPresets, loadUserPresets, saveUserPresets, BUILTIN_PRESETS, type Preset } from './config.js';

export function listPresets(): Array<Preset & { isBuiltin: boolean }> {
  const all = getAllPresets();
  return Object.values(all).map(p => ({
    ...p,
    isBuiltin: Boolean(BUILTIN_PRESETS[p.name])
  }));
}

export function findPreset(inputName: string): Preset | null {
  const clean = inputName.startsWith('@') ? inputName.slice(1) : inputName;
  const all = getAllPresets();
  return all[clean] || null;
}

export function saveCustomPreset(
  name: string,
  dependencies: string[],
  devDependencies: string[],
  description?: string
): Preset {
  const clean = name.startsWith('@') ? name.slice(1) : name;
  const user = loadUserPresets();

  const newPreset: Preset = {
    name: clean,
    description: description || `Custom preset "${clean}"`,
    dependencies,
    devDependencies
  };

  user[clean] = newPreset;
  saveUserPresets(user);
  return newPreset;
}

export function removeCustomPreset(name: string): boolean {
  const clean = name.startsWith('@') ? name.slice(1) : name;
  const user = loadUserPresets();

  if (!user[clean]) {
    return false;
  }

  delete user[clean];
  saveUserPresets(user);
  return true;
}
