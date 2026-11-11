const fs = require('fs');
const os = require('os');
const path = require('path');

function envValue(env, name) {
  const key = Object.keys(env || {}).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? String(env[key] || '').trim() : '';
}

function cleanPath(value) {
  let result = String(value || '').trim();
  if (result.startsWith('"') && result.endsWith('"')) result = result.slice(1, -1);
  if (result === '~') return os.homedir();
  if (result.startsWith(`~${path.sep}`) || result.startsWith('~/') || result.startsWith('~\\')) {
    result = path.join(os.homedir(), result.slice(2));
  }
  return result;
}

function existingFile(value, platform = process.platform) {
  const candidate = cleanPath(value);
  if (!candidate) return '';
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return '';
    if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
    return path.resolve(candidate);
  } catch {
    return '';
  }
}

function executableExtensions(env, platform) {
  if (platform !== 'win32') return [''];
  const configured = envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD';
  const values = configured.split(';').map((value) => value.trim().toLowerCase()).filter(Boolean);
  return [...new Set(['.exe', '.cmd', '.bat', '.com', ...values])];
}

function findExecutable(value, env, platform = process.platform) {
  const requested = cleanPath(value);
  if (!requested) return '';
  const hasDirectory = path.isAbsolute(requested) || requested.includes('/') || requested.includes('\\');
  const extensions = path.extname(requested) ? [''] : executableExtensions(env, platform);
  const names = extensions.map((extension) => `${requested}${extension}`);

  if (hasDirectory) {
    for (const name of names) {
      const found = existingFile(name, platform);
      if (found) return found;
    }
    return '';
  }

  const pathValue = envValue(env, 'PATH');
  const delimiter = platform === 'win32' ? ';' : ':';
  for (const directory of pathValue.split(delimiter).map(cleanPath).filter(Boolean)) {
    for (const name of names) {
      const found = existingFile(path.join(directory, name), platform);
      if (found) return found;
    }
  }
  return '';
}

function windowsDesktopCandidates(env) {
  const localAppData = envValue(env, 'LOCALAPPDATA') || path.join(os.homedir(), 'AppData', 'Local');
  const binRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  const candidates = [path.join(binRoot, 'codex.exe')];
  try {
    const directories = fs.readdirSync(binRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(binRoot, entry.name, 'codex.exe'))
      .filter((candidate) => existingFile(candidate, 'win32'));
    candidates.push(...directories);
  } catch {
    // Codex Desktop is optional.
  }
  // Desktop upgrades can leave an older root-level codex.exe next to the
  // current versioned runtime. Prefer whichever executable was updated most
  // recently instead of assuming that the root-level copy is authoritative.
  return candidates
    .filter((candidate) => existingFile(candidate, 'win32'))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
}

function npmCandidates(env, platform) {
  const home = os.homedir();
  const prefix = envValue(env, 'NPM_CONFIG_PREFIX');
  if (platform === 'win32') {
    const appData = envValue(env, 'APPDATA') || path.join(home, 'AppData', 'Roaming');
    const localAppData = envValue(env, 'LOCALAPPDATA') || path.join(home, 'AppData', 'Local');
    return [
      prefix && path.join(prefix, 'codex.cmd'),
      path.join(appData, 'npm', 'codex.cmd'),
      path.join(localAppData, 'npm', 'codex.cmd')
    ].filter(Boolean);
  }
  return [
    prefix && path.join(prefix, 'bin', 'codex'),
    path.join(home, '.npm-global', 'bin', 'codex'),
    path.join(home, '.local', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex'
  ].filter(Boolean);
}

function launchForExecutable(executable, env = process.env, platform = process.platform) {
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
    const command = envValue(env, 'COMSPEC') || path.join(envValue(env, 'SYSTEMROOT') || 'C:\\Windows', 'System32', 'cmd.exe');
    return {
      command,
      args: ['/d', '/s', '/c', `call "${executable.replace(/"/g, '""')}" app-server`],
      executable,
      sourceType: 'windows-command-shim'
    };
  }
  return {
    command: executable,
    // stdio is the app-server default. Omitting the newer --stdio alias keeps
    // compatibility with older bundled Codex CLIs that reject that flag.
    args: ['app-server'],
    executable,
    sourceType: 'native-executable'
  };
}

function resolveCodexLaunch(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const configured = envValue(env, 'CODEX_BIN');
  const checked = [];

  if (configured) {
    const found = findExecutable(configured, env, platform);
    checked.push(`CODEX_BIN=${configured}`);
    if (found) return { ...launchForExecutable(found, env, platform), source: 'CODEX_BIN', checked };
  }

  const onPath = findExecutable('codex', env, platform);
  checked.push('PATH');
  if (onPath) return { ...launchForExecutable(onPath, env, platform), source: 'PATH', checked };

  const automaticCandidates = platform === 'win32'
    ? [...windowsDesktopCandidates(env), ...npmCandidates(env, platform)]
    : npmCandidates(env, platform);
  for (const candidate of automaticCandidates) {
    checked.push(candidate);
    const found = existingFile(candidate, platform);
    if (found) return { ...launchForExecutable(found, env, platform), source: 'automatic', checked };
  }

  const configuredHint = configured ? `\nCODEX_BIN=${configured}, but that file does not exist or cannot be executed.` : '';
  throw new Error(
    `Codex CLI was not found. Install @openai/codex@0.167.0, then configure the model endpoint and key in .env. `
    + `Alternatively, set CODEX_BIN to the full path of codex.exe or codex.cmd.${configuredHint}`
  );
}

module.exports = { resolveCodexLaunch, launchForExecutable, findExecutable };
