#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';

export function inspect(paths, destination, threshold = 260) {
  const target = typeof destination === 'string' ? destination.replaceAll('/', '\\') : '';
  if (!path.win32.isAbsolute(target) || /^(?:\\\\[?.]\\)/.test(target) || !/^(?:[a-zA-Z]:\\|\\\\[^\\]+\\[^\\]+)/.test(target)) throw new Error('Destination must be an absolute Windows drive or UNC path (device namespace paths are not supported).');
  if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error('Threshold must be a positive integer.');
  const root = path.win32.normalize(target);
  // Check directory components after the drive or UNC share. The server/share
  // root and filesystem-specific naming behavior are intentionally not inferred.
  const destinationParts = root.slice(path.win32.parse(root).root.length).split('\\');
  if (destinationParts.some(part => /[<>:"|?*\x00-\x1f]/u.test(part))) throw new Error('Destination contains a Windows-invalid character in a directory component.');
  const findings = [];
  const prefixes = new Map();
  const records = paths.filter(Boolean).map(name => {
    const parts = name.split('/');
    const length = root.length + (root.endsWith('\\') ? 0 : 1) + name.length;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i], prefix = parts.slice(0, i + 1).join('/');
      if (/[<>:"\\|?*\x00-\x1f]/u.test(part)) findings.push({ kind: 'invalid_character', path: name, component: part });
      if (/[ .]$/u.test(part)) findings.push({ kind: 'trailing_dot_or_space', path: name, component: part });
      // Git rejects these metadata-directory aliases during Windows checkout
      // when core.protectNTFS is enabled; they are not ordinary device names.
      if (/^(?:\.git|git~1)$/iu.test(part)) findings.push({ kind: 'git_metadata_name', path: name, component: part });
      const stem = part.split('.', 1)[0].replace(/ +$/u, '');
      if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu.test(stem)) findings.push({ kind: 'reserved_device_name', path: name, component: part });
      // Git for Windows protectNTFS additionally rejects these device aliases.
      if (/^(?:lpt0|conin\$|conout\$)$/iu.test(stem)) findings.push({ kind: 'git_ntfs_device_name', path: name, component: part });
      if (part.length > 255) findings.push({ kind: 'long_component', path: name, component: part });
      const folded = prefix.toLowerCase();
      if (!prefixes.has(folded)) prefixes.set(folded, new Set());
      prefixes.get(folded).add(prefix);
    }
    return { path: name, fullLength: length, warning: length >= threshold };
  }).sort((a, b) => b.fullLength - a.fullLength || a.path.localeCompare(b.path));
  for (const variants of prefixes.values()) if (variants.size > 1) findings.push({ kind: 'case_collision', paths: [...variants].sort() });
  return { destination: root, threshold, count: records.length, warnings: records.filter(x => x.warning), findings, longest: records.slice(0, 10) };
}

export function run(args) {
  if (args.includes('--help') || !args.length) {
    console.log('Usage: node preview.mjs <git-repo-or-https-url> <Windows-destination> [--remote] [--ref REF] [--threshold N] [--json]\n--remote makes a temporary shallow bare clone of the remote default branch.');
    return args.length ? 0 : 2;
  }
  let repo = args[0], destination = args[1], ref = 'HEAD', threshold = 260, json = false, remote = false;
  if (!destination || repo.startsWith('-') || destination.startsWith('-')) throw new Error('Repository and destination are required.');
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--remote') remote = true;
    else if (args[i] === '--ref' && args[i + 1] && !args[i + 1].startsWith('-')) ref = args[++i];
    else if (args[i] === '--threshold' && /^\d+$/.test(args[i + 1] ?? '')) threshold = Number(args[++i]);
    else throw new Error(`Invalid argument: ${args[i]}`);
  }
  inspect([], destination, threshold);
  // These Git environment variables can redirect repository, ref, or object
  // lookup away from the repository the user supplied, especially in hooks.
  const repoOverrides = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']);
  const inheritedOverrides = Object.keys(process.env).filter(key => repoOverrides.has(key.toUpperCase()));
  if (inheritedOverrides.length) throw new Error(`Git repository environment overrides are set (${inheritedOverrides.join(', ')}). Clear them for this command and retry; the selected repository or refs may otherwise differ.`);
  let temporary;
  let result;
  try {
    if (remote) {
      const url = new URL(repo);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Remote must be an HTTPS URL without credentials, query or fragment.');
      if (ref !== 'HEAD') throw new Error('Remote mode supports only the default branch; use a local repository to inspect other refs.');
      // Git can silently rewrite an HTTPS argument to another URL or protocol.
      // Resolve its configured rewrite without contacting the remote, before cloning.
      let effectiveUrl;
      try {
        effectiveUrl = execFileSync('git', ['ls-remote', '--get-url', '--', repo], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).trim();
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error('Git was not found on PATH. Install Git 2.45 or newer.');
        throw new Error('Unable to check Git URL rewrites before cloning.');
      }
      if (effectiveUrl !== repo) throw new Error('Git rewrites this remote URL. Review url.*.insteadOf configuration and run without the rewrite.');
      temporary = mkdtempSync(path.join(os.tmpdir(), 'git-path-preview-'));
      try {
        execFileSync('git', ['clone', '--bare', '--depth=1', '--filter=blob:none', '--', repo, temporary], { timeout: 120000, stdio: ['ignore','ignore','pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error('Git was not found on PATH. Install Git 2.45 or newer.');
        throw error;
      }
      repo = temporary;
    }
    // Resolve once: a branch can move while a scan is running. Listing the
    // immutable tree keeps the reported identifier tied to the actual paths.
    let tree, raw;
    try {
      tree = execFileSync('git', ['--no-lazy-fetch', '--no-replace-objects', '-C', repo, 'rev-parse', '--verify', '--end-of-options', `${ref}^{tree}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(tree)) throw new Error('Git returned an invalid tree identifier.');
      raw = execFileSync('git', ['--no-lazy-fetch', '--no-replace-objects', '-C', repo, 'ls-tree', '-r', '-z', '--name-only', '--full-tree', tree], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Git was not found on PATH. Install Git 2.45 or newer.');
      throw new Error(`${error.message.trim()}\nCheck the repository and ref, use Git 2.45+, and ensure required tree objects are already available locally; this scan disables automatic fetching.`);
    }
    // Git's NUL-delimited output is a sequence of paths, not a text document:
    // a leading UTF-8 BOM can be an actual character in the first filename.
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    result = inspect(decoded.split('\0'), destination, threshold);
    result.tree = tree;
    result.ref = ref;
    result.replacementRefsIgnored = true;
  } finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Destination: ${result.destination}\nRef: ${result.ref}\nTree: ${result.tree}\nReplacement refs: ignored\nTracked entries: ${result.count}\nWarning threshold: ${threshold} UTF-16 units\nLong paths: ${result.warnings.length}\nOther findings: ${result.findings.length}`);
    const entries = result.warnings.length ? result.warnings : result.longest;
    for (const entry of entries) console.log(`${entry.warning ? 'WARN ' : '     '}${entry.fullLength} ${JSON.stringify(entry.path)}`);
    for (const finding of result.findings) console.log(`WARN ${finding.kind} ${JSON.stringify(finding.paths ?? finding.path)}${finding.component ? ` component=${JSON.stringify(finding.component)}` : ''}`);
    if (result.warnings.length) console.log('Consider a shorter destination or review Git for Windows long-path configuration.');
    if (result.findings.length) console.log('Filename findings may require renaming paths in the source repository.');
    console.log('These checks are estimates; a clean report does not guarantee a successful checkout.');
  }
  return result.warnings.length || result.findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { console.error(`Error: ${error.message}`); process.exitCode = 2; }
}
