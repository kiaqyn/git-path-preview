import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from './preview.mjs';

test('counts destination and UTF-16 units; warns at threshold', () => {
  const result = inspect(['a/😀.txt'], 'C:\\target', 18);
  assert.equal(result.longest[0].fullLength, 18);
  assert.equal(result.warnings.length, 1);
});
test('rejects ambiguous destination and invalid threshold', () => {
  assert.throws(() => inspect([], 'C:relative'));
  assert.throws(() => inspect([], 'C:\\target', 0));
  assert.throws(() => inspect([], '\\\\?\\C:\\target'));
  assert.throws(() => inspect([], '\\\\.\\C:\\target'));
});
test('accepts forward slashes in absolute Windows drive and UNC destinations', () => {
  const drive = inspect(['src/file.txt'], 'C:/target');
  assert.equal(drive.destination, 'C:\\target');
  assert.equal(drive.longest[0].fullLength, 22);
  const network = inspect(['src/file.txt'], '//server/share/project');
  assert.equal(network.destination, '\\\\server\\share\\project');
  assert.equal(network.longest[0].fullLength, 35);
});
test('rejects invalid destination components while preserving valid drive and UNC paths', () => {
  for (const destination of ['C:\\parent\\bad|name', 'C:\\parent\\bad:name', '\\\\server\\share\\bad?name']) {
    assert.throws(() => inspect(['readme.txt'], destination), /Windows-invalid character/);
    const scan = spawnSync(process.execPath, [path.resolve('preview.mjs'), 'unused-repo', destination, '--json'], { encoding: 'utf8' });
    assert.equal(scan.status, 2, scan.stderr);
    assert.match(scan.stderr, /Windows-invalid character/);
    assert.equal(scan.stdout, '');
  }
  assert.equal(inspect(['readme.txt'], 'C:\\parent\\normal-name').findings.length, 0);
  assert.equal(inspect(['readme.txt'], '\\\\server\\share\\normal-name').findings.length, 0);
});
test('Windows cannot create a destination component containing a vertical bar', { skip: process.platform !== 'win32' }, () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'path-invalid-target-'));
  try {
    const valid = path.join(temporary, 'normal-name');
    const invalid = path.join(temporary, 'bad|name');
    mkdirSync(valid);
    assert.throws(() => mkdirSync(invalid), error => error.code === 'EINVAL');
    assert.throws(() => inspect(['readme.txt'], invalid), /Windows-invalid character/);
  } finally {
    const resolvedTemp = realpathSync(temporary);
    const relativeTemp = path.relative(realpathSync(os.tmpdir()), resolvedTemp);
    if (!relativeTemp || relativeTemp.startsWith('..') || path.isAbsolute(relativeTemp)) throw new Error('Temporary directory is outside the intended temp root');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
test('finds Windows-invalid names and collisions in directories and files', () => {
  const r = inspect(['A/one.txt', 'a/two.txt', 'README', 'readme', 'NUL.txt', 'CON .txt', 'bad:part/file', 'end./file', 'ok'], 'C:\\repo');
  assert.ok(r.findings.some(x => x.kind === 'case_collision' && x.paths.includes('A') && x.paths.includes('a')));
  assert.ok(r.findings.some(x => x.kind === 'case_collision' && x.paths.includes('README') && x.paths.includes('readme')));
  assert.ok(r.findings.some(x => x.kind === 'reserved_device_name' && x.path === 'NUL.txt'));
  assert.ok(r.findings.some(x => x.kind === 'reserved_device_name' && x.path === 'CON .txt'));
  assert.ok(r.findings.some(x => x.kind === 'invalid_character' && x.path === 'bad:part/file'));
  assert.ok(r.findings.some(x => x.kind === 'trailing_dot_or_space' && x.path === 'end./file'));
});
test('path-length estimation does not normalize illegal backslashes from Git paths', () => {
  const r = inspect(['x\\y'], 'C:\\repo');
  assert.equal(r.longest[0].fullLength, 11);
  assert.equal(r.findings[0].kind, 'invalid_character');
});
test('detects incompatible names in a bare Git tree without checking it out', () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'path-preview-tree-'));
  try {
    execFileSync('git', ['init', '--bare', repo], { stdio: 'pipe' });
    const git = (args, input) => execFileSync('git', ['-C', repo, ...args], { input, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
    const blob = git(['hash-object', '-w', '--stdin'], 'fixture');
    const tree = git(['mktree'], `100644 blob ${blob}\tA.txt\n100644 blob ${blob}\ta.txt\n100644 blob ${blob}\tNUL.txt\n`);
    const child = spawnSync(process.execPath, [path.resolve('preview.mjs'), repo, 'C:\\repo', '--ref', tree, '--json'], { encoding: 'utf8' });
    assert.equal(child.status, 1, child.stderr);
    const findings = JSON.parse(child.stdout).findings;
    assert.equal(JSON.parse(child.stdout).tree, tree);
    assert.ok(findings.some(x => x.kind === 'case_collision'));
    assert.ok(findings.some(x => x.kind === 'reserved_device_name'));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
test('preserves an initial UTF-8 BOM character when it belongs to a filename', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'path-bom-test-'));
  try {
    const repo = path.join(temporary, 'repo');
    execFileSync('git', ['init', repo], { stdio: 'pipe' });
    const git = (args, input) => execFileSync('git', ['-C', repo, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const blob = git(['hash-object', '-w', '--stdin'], 'fixture');
    const filename = '\uFEFFNUL.txt';
    const tree = git(['mktree', '-z'], `100644 blob ${blob}\t${filename}\0`);
    const raw = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '-z', '--name-only', tree]);
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const scan = spawnSync(process.execPath, [path.resolve('preview.mjs'), repo, 'C:\\repo', '--ref', tree, '--json'], { encoding: 'utf8' });
    assert.equal(scan.status, 0, scan.stderr);
    const report = JSON.parse(scan.stdout);
    assert.equal(report.longest[0].path, filename);
    assert.equal(report.findings.length, 0);
    if (process.platform === 'win32') {
      const checkout = spawnSync('git', ['-C', repo, 'read-tree', '--reset', '-u', tree], { encoding: 'utf8' });
      assert.equal(checkout.status, 0, checkout.stderr);
    }
  } finally {
    const resolvedTemp = realpathSync(temporary);
    const relativeTemp = path.relative(realpathSync(os.tmpdir()), resolvedTemp);
    if (!relativeTemp || relativeTemp.startsWith('..') || path.isAbsolute(relativeTemp)) throw new Error('Temporary directory is outside the intended temp root');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
test('rejects a tree with a filename containing invalid UTF-8 bytes', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'path-invalid-utf8-'));
  try {
    const repo = path.join(temporary, 'repo.git');
    execFileSync('git', ['init', '--bare', repo], { stdio: 'pipe' });
    const blob = execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], { input: 'fixture', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const entry = Buffer.concat([Buffer.from(`100644 blob ${blob}\t`, 'utf8'), Buffer.from([0xff]), Buffer.from('.txt\0', 'utf8')]);
    const tree = execFileSync('git', ['-C', repo, 'mktree', '-z'], { input: entry, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const scan = spawnSync(process.execPath, [path.resolve('preview.mjs'), repo, 'C:\\repo', '--ref', tree, '--json'], { encoding: 'utf8' });
    assert.equal(scan.status, 2, scan.stderr);
    assert.match(scan.stderr, /utf-8/i);
    assert.equal(scan.stdout, '');
  } finally {
    const resolvedTemp = realpathSync(temporary);
    const relativeTemp = path.relative(realpathSync(os.tmpdir()), resolvedTemp);
    if (!relativeTemp || relativeTemp.startsWith('..') || path.isAbsolute(relativeTemp)) throw new Error('Temporary directory is outside the intended temp root');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
test('reported tree ID matches audited content when Git replacement refs exist', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'path-replace-test-'));
  try {
    const repo = path.join(temporary, 'repo.git');
    execFileSync('git', ['init', '--bare', repo], { stdio: 'pipe' });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE'].includes(key.toUpperCase())));
    const git = (args, input) => execFileSync('git', ['-C', repo, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env }).trim();
    const blob = git(['hash-object', '-w', '--stdin'], 'fixture');
    const originalTree = git(['mktree'], `100644 blob ${blob}\treadme.txt\n`);
    const replacementTree = git(['mktree'], `100644 blob ${blob}\tNUL.txt\n`);
    git(['replace', originalTree, replacementTree]);
    assert.equal(git(['ls-tree', '--name-only', originalTree]), 'NUL.txt', 'Control: Git applies replacement refs by default');
    assert.equal(git(['--no-replace-objects', 'ls-tree', '--name-only', originalTree]), 'readme.txt');
    const scan = spawnSync(process.execPath, [path.resolve('preview.mjs'), repo, 'C:\\repo', '--ref', originalTree, '--json'], { env, encoding: 'utf8' });
    assert.equal(scan.status, 0, scan.stderr);
    const report = JSON.parse(scan.stdout);
    assert.equal(report.tree, originalTree);
    assert.equal(report.replacementRefsIgnored, true);
    assert.equal(report.longest[0].path, 'readme.txt');
    assert.equal(report.findings.length, 0);
    git(['replace', '-d', originalTree]);
    git(['replace', replacementTree, originalTree]);
    assert.equal(git(['ls-tree', '--name-only', replacementTree]), 'readme.txt', 'Control: replacement can hide an incompatible filename');
    const unsafeScan = spawnSync(process.execPath, [path.resolve('preview.mjs'), repo, 'C:\\repo', '--ref', replacementTree, '--json'], { env, encoding: 'utf8' });
    assert.equal(unsafeScan.status, 1, unsafeScan.stderr);
    const unsafeReport = JSON.parse(unsafeScan.stdout);
    assert.equal(unsafeReport.tree, replacementTree);
    assert.ok(unsafeReport.findings.some(f => f.kind === 'reserved_device_name' && f.path === 'NUL.txt'));
  } finally {
    const resolvedTemp = realpathSync(temporary);
    const relativeTemp = path.relative(realpathSync(os.tmpdir()), resolvedTemp);
    if (!relativeTemp || relativeTemp.startsWith('..') || path.isAbsolute(relativeTemp)) throw new Error('Temporary directory is outside the intended temp root');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
test('text output includes every long path, including those beyond the top ten', () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'path-preview-many-'));
  try {
    execFileSync('git', ['init', '--bare', repo], { stdio: 'pipe' });
    const git = (args, input) => execFileSync('git', ['-C', repo, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const blob = git(['hash-object', '-w', '--stdin'], 'fixture');
    const entries = Array.from({ length: 12 }, (_, i) => `100644 blob ${blob}\tpath-${String(i).padStart(2, '0')}.txt\n`).join('');
    const tree = git(['mktree'], entries);
    const child = spawnSync(process.execPath, [path.resolve('preview.mjs'), repo, 'C:\\repo', '--ref', tree, '--threshold', '5'], { encoding: 'utf8' });
    assert.equal(child.status, 1, child.stderr);
    assert.equal((child.stdout.match(/^WARN \d+ /gm) ?? []).length, 12);
    assert.match(child.stdout, /path-11\.txt/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
test('Windows Git rejects reserved names identified by the audit', { skip: process.platform !== 'win32' }, () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'path-preview-checkout-'));
  try {
    execFileSync('git', ['-C', repo, 'init'], { stdio: 'pipe' });
    const git = (args, input) => execFileSync('git', ['-C', repo, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const blob = git(['hash-object', '-w', '--stdin'], 'fixture');
    for (const name of ['NUL.txt', 'CON .txt']) {
      const tree = git(['mktree'], `100644 blob ${blob}\t${name}\n`);
      const checked = spawnSync('git', ['-C', repo, 'read-tree', '--reset', '-u', tree], { encoding: 'utf8' });
      assert.notEqual(checked.status, 0, `Git unexpectedly checked out ${name} on Windows`);
      const audit = spawnSync(process.execPath, [path.resolve('preview.mjs'), repo, 'C:\\repo', '--ref', tree, '--json'], { encoding: 'utf8' });
      assert.equal(audit.status, 1, audit.stderr);
      assert.ok(JSON.parse(audit.stdout).findings.some(x => x.kind === 'reserved_device_name' && x.path === name));
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
test('flags Git metadata names without flagging ordinary lookalikes', () => {
  const r = inspect(['.git', 'folder/GIT~1/file', 'git~2', '.gitmodules'], 'C:\\repo');
  assert.deepEqual(r.findings.filter(x => x.kind === 'git_metadata_name').map(x => x.path).sort(), ['.git', 'folder/GIT~1/file'].sort());
});
test('flags additional Git NTFS device aliases without matching ordinary names', () => {
  const r = inspect(['CONIN$', 'dir/conout$.txt', 'LPT0 .txt', 'COM0', 'LPT01', 'CONIN$more'], 'C:\\repo');
  assert.deepEqual(r.findings.filter(x => x.kind === 'git_ntfs_device_name').map(x => x.path).sort(), ['CONIN$', 'dir/conout$.txt', 'LPT0 .txt'].sort());
});
test('Windows Git NTFS protection rejects additional device aliases', { skip: process.platform !== 'win32' }, () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'path-preview-ntfs-'));
  try {
    execFileSync('git', ['-C', repo, 'init'], { stdio: 'pipe' });
    const git = (args, input) => execFileSync('git', ['-C', repo, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const blob = git(['hash-object', '-w', '--stdin'], 'fixture');
    for (const [name, rejected] of [['CONIN$', true], ['conout$.txt', true], ['LPT0', true], ['LPT0 .txt', true], ['COM0', false], ['LPT01', false]]) {
      const tree = git(['mktree'], `100644 blob ${blob}\t${name}\n`);
      const checked = spawnSync('git', ['-C', repo, '-c', 'core.protectNTFS=true', 'read-tree', '--reset', '-u', tree], { encoding: 'utf8' });
      assert.equal(checked.status === 0, !rejected, checked.stderr);
      const audit = spawnSync(process.execPath, [path.resolve('preview.mjs'), repo, 'C:\\repo', '--ref', tree, '--json'], { encoding: 'utf8' });
      assert.equal(audit.status, rejected ? 1 : 0, audit.stderr);
      assert.equal(JSON.parse(audit.stdout).findings.some(x => x.kind === 'git_ntfs_device_name'), rejected);
    }
  } finally {
    const resolvedTemp = realpathSync(repo);
    const relativeTemp = path.relative(realpathSync(os.tmpdir()), resolvedTemp);
    if (!relativeTemp || relativeTemp.startsWith('..') || path.isAbsolute(relativeTemp)) throw new Error('Temporary directory is outside the intended temp root');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
test('Windows Git protects metadata names from checkout', { skip: process.platform !== 'win32' }, () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'path-preview-protect-'));
  try {
    execFileSync('git', ['-C', repo, 'init'], { stdio: 'pipe' });
    const git = (args, input) => execFileSync('git', ['-C', repo, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const blob = git(['hash-object', '-w', '--stdin'], 'fixture');
    for (const [name, rejected] of [['.git', true], ['git~1', true], ['git~2', false]]) {
      const tree = git(['mktree'], `100644 blob ${blob}\t${name}\n`);
      const checked = spawnSync('git', ['-C', repo, '-c', 'core.protectNTFS=true', 'read-tree', '--reset', '-u', tree], { encoding: 'utf8' });
      assert.equal(checked.status === 0, !rejected, checked.stderr);
      const audit = spawnSync(process.execPath, [path.resolve('preview.mjs'), repo, 'C:\\repo', '--ref', tree, '--json'], { encoding: 'utf8' });
      assert.equal(audit.status, rejected ? 1 : 0, audit.stderr);
      assert.equal(JSON.parse(audit.stdout).findings.some(x => x.kind === 'git_metadata_name'), rejected);
    }
  } finally {
    const resolvedTemp = realpathSync(repo);
    const relativeTemp = path.relative(realpathSync(os.tmpdir()), resolvedTemp);
    if (!relativeTemp || relativeTemp.startsWith('..') || path.isAbsolute(relativeTemp)) throw new Error('Temporary directory is outside the intended temp root');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
test('Windows Git checkout succeeds in a short destination and fails in a deep destination', { skip: process.platform !== 'win32' }, () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'path-depth-test-'));
  try {
    const root = realpathSync(temporary);
    const source = path.join(root, 'source');
    mkdirSync(source);
    execFileSync('git', ['-C', source, 'init'], { stdio: 'pipe' });
    const git = (args, input) => execFileSync('git', ['-C', source, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    const blob = git(['hash-object', '-w', '--stdin'], 'fixture');
    const fileName = `${'f'.repeat(60)}.txt`;
    const directoryName = 'd'.repeat(60);
    const inner = git(['mktree'], `100644 blob ${blob}\t${fileName}\n`);
    const tree = git(['mktree'], `040000 tree ${inner}\t${directoryName}\n`);
    const commit = git(['commit-tree', tree], 'fixture');
    git(['update-ref', 'HEAD', commit]);
    const longParent = path.join(root, 'p'.repeat(100));
    mkdirSync(longParent);
    const shortDest = path.join(root, 'short');
    const longDest = path.join(longParent, 'deep');
    for (const dest of [shortDest, longDest]) execFileSync('git', ['clone', '--no-checkout', '--no-local', '--', source, dest], { stdio: 'pipe' });
    const cli = path.resolve('preview.mjs');
    const audit = dest => spawnSync(process.execPath, [cli, source, dest, '--json'], { encoding: 'utf8' });
    const shortAudit = audit(shortDest);
    const longAudit = audit(longDest);
    assert.equal(shortAudit.status, 0, shortAudit.stderr);
    assert.equal(longAudit.status, 1, longAudit.stderr);
    assert.ok(JSON.parse(longAudit.stdout).warnings.length > 0);
    const checkout = dest => spawnSync('git', ['-C', dest, '-c', 'core.longpaths=false', 'checkout', '--force', 'HEAD'], { encoding: 'utf8' });
    const shortCheckout = checkout(shortDest);
    const longCheckout = checkout(longDest);
    assert.equal(shortCheckout.status, 0, shortCheckout.stderr);
    assert.notEqual(longCheckout.status, 0, 'Long checkout unexpectedly succeeded');
    assert.match(longCheckout.stderr, /filename too long/i);
  } finally {
    const resolvedTemp = realpathSync(temporary);
    const relativeTemp = path.relative(realpathSync(os.tmpdir()), resolvedTemp);
    if (!relativeTemp || relativeTemp.startsWith('..') || path.isAbsolute(relativeTemp)) throw new Error('Temporary directory is outside the intended temp root');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
test('partial local repository does not silently fetch missing tree objects', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'path-no-fetch-'));
  try {
    const source = path.join(temporary, 'source');
    const partial = path.join(temporary, 'partial.git');
    mkdirSync(source);
    const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim();
    git(['init', source]);
    git(['-C', source, 'config', 'user.name', 'Test']);
    git(['-C', source, 'config', 'user.email', 'test@example.invalid']);
    git(['-C', source, 'config', 'uploadpack.allowFilter', 'true']);
    writeFileSync(path.join(source, 'tracked.txt'), 'fixture');
    git(['-C', source, 'add', 'tracked.txt']);
    git(['-C', source, 'commit', '-m', 'fixture']);
    git(['clone', '--bare', '--filter=tree:0', '--', pathToFileURL(source).href, partial]);
    const existsWithoutFetch = () => spawnSync('git', ['--no-lazy-fetch', '-C', partial, 'cat-file', '-e', 'HEAD^{tree}'], { stdio: 'ignore' }).status === 0;
    assert.equal(existsWithoutFetch(), false, 'Fixture should initially lack the tree object');
    const scan = spawnSync(process.execPath, [path.resolve('preview.mjs'), partial, 'C:\\repo', '--json'], { encoding: 'utf8', env: { ...process.env, GIT_NO_LAZY_FETCH: '0' } });
    assert.equal(scan.status, 2, scan.stderr);
    assert.match(scan.stderr, /ensure required tree objects are already available locally/);
    assert.equal(existsWithoutFetch(), false, 'Scan must not silently fetch missing objects');
    const control = spawnSync('git', ['-C', partial, 'cat-file', '-e', 'HEAD^{tree}'], { env: { ...process.env, GIT_NO_LAZY_FETCH: '0' }, stdio: 'pipe' });
    assert.equal(control.status, 0, 'Control fetch must work so the missing-object test is meaningful');
    assert.equal(existsWithoutFetch(), true);
  } finally {
    const resolvedTemp = realpathSync(temporary);
    const relativeTemp = path.relative(realpathSync(os.tmpdir()), resolvedTemp);
    if (!relativeTemp || relativeTemp.startsWith('..') || path.isAbsolute(relativeTemp)) throw new Error('Temporary directory is outside the intended temp root');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
test('failed remote scan removes its temporary bare repository', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'path-failed-clone-'));
  try {
    const emptyConfig = path.join(temporary, 'empty-gitconfig');
    writeFileSync(emptyConfig, '');
    const env = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, LANG: 'C', LC_ALL: 'C' };
    const scan = spawnSync(process.execPath, [path.resolve('preview.mjs'), 'https://127.0.0.1:1/nonexistent', 'C:\\repo', '--remote', '--json'], { encoding: 'utf8', env, timeout: 10000 });
    assert.equal(scan.error, undefined, scan.error?.message);
    assert.equal(scan.status, 2, scan.stderr);
    assert.match(scan.stderr, /failed to connect|could not connect|connection refused/i, 'Control: cloning reached the loopback connection attempt');
    assert.deepEqual(readdirSync(temporary), ['empty-gitconfig']);
  } finally {
    const resolvedTemp = realpathSync(temporary);
    const relativeTemp = path.relative(realpathSync(os.tmpdir()), resolvedTemp);
    if (!relativeTemp || relativeTemp.startsWith('..') || path.isAbsolute(relativeTemp)) throw new Error('Temporary directory is outside the intended temp root');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
test('remote mode refuses a configured URL rewrite before cloning', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'path-url-rewrite-'));
  try {
    const original = 'https://example.invalid/repo.git';
    const rewritten = pathToFileURL(path.join(temporary, 'local-fixture.git')).href;
    const emptyConfig = path.join(temporary, 'empty-gitconfig');
    writeFileSync(emptyConfig, '');
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${rewritten}.insteadOf`, GIT_CONFIG_VALUE_0: original,
      TMPDIR: temporary, TMP: temporary, TEMP: temporary };
    const control = execFileSync('git', ['ls-remote', '--get-url', '--', original], { env, encoding: 'utf8' }).trim();
    assert.equal(control, rewritten, 'Control: Git actually rewrites the supplied URL');
    const scan = spawnSync(process.execPath, [path.resolve('preview.mjs'), original, 'C:\\repo', '--remote', '--json'], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(scan.status, 2, scan.stderr);
    assert.match(scan.stderr, /Git rewrites this remote URL/);
    assert.equal(scan.stdout, '');
    assert.deepEqual(readdirSync(temporary), ['empty-gitconfig'], 'No temporary clone should be created');
  } finally {
    const resolvedTemp = realpathSync(temporary);
    const relativeTemp = path.relative(realpathSync(os.tmpdir()), resolvedTemp);
    if (!relativeTemp || relativeTemp.startsWith('..') || path.isAbsolute(relativeTemp)) throw new Error('Temporary directory is outside the intended temp root');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
test('missing Git produces an actionable error', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
  env.PATH = '';
  const scan = spawnSync(process.execPath, [path.resolve('preview.mjs'), '.', 'C:\\repo'], { env, encoding: 'utf8' });
  assert.equal(scan.status, 2, scan.stderr);
  assert.match(scan.stderr, /Git was not found on PATH/);
  const remoteScan = spawnSync(process.execPath, [path.resolve('preview.mjs'), 'https://example.org/repo.git', 'C:\\repo', '--remote'], { env, encoding: 'utf8' });
  assert.equal(remoteScan.status, 2, remoteScan.stderr);
  assert.match(remoteScan.stderr, /Git was not found on PATH/);
});
test('reads committed tree, not working files, and returns meaningful exit codes', () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'path-preview-test-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    writeFileSync(path.join(repo, 'tracked.txt'), 'a'); git('add', 'tracked.txt'); git('commit', '-m', 'fixture');
    writeFileSync(path.join(repo, 'untracked.txt'), 'b');
    const cli = path.resolve('preview.mjs');
    const ok = spawnSync(process.execPath, [cli, repo, 'C:\\repo', '--json'], { encoding: 'utf8' });
    assert.equal(ok.status, 0); assert.equal(JSON.parse(ok.stdout).count, 1);
    const warning = spawnSync(process.execPath, [cli, repo, 'C:\\repo', '--threshold', '5'], { encoding: 'utf8' });
    assert.equal(warning.status, 1);
    const bad = spawnSync(process.execPath, [cli, repo, 'relative'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('refuses repository-selection environment overrides instead of scanning the wrong repository', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'path-env-override-'));
  try {
    const intended = path.join(temporary, 'intended.git');
    const other = path.join(temporary, 'other.git');
    for (const repo of [intended, other]) execFileSync('git', ['init', '--bare', repo], { stdio: 'pipe' });
    const treeIn = (repo, name) => {
      const git = (args, input) => execFileSync('git', ['-C', repo, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      const blob = git(['hash-object', '-w', '--stdin'], 'fixture');
      const tree = git(['mktree'], `100644 blob ${blob}\t${name}\n`);
      git(['update-ref', 'refs/tags/fixture', tree]);
    };
    treeIn(intended, 'safe.txt');
    treeIn(other, 'NUL.txt');
    const env = { ...process.env, GIT_DIR: other };
    const control = execFileSync('git', ['-C', intended, 'ls-tree', '--name-only', 'refs/tags/fixture'], { env, encoding: 'utf8' }).trim();
    assert.equal(control, 'NUL.txt', 'Control: inherited GIT_DIR overrides the specified repository');
    const scan = spawnSync(process.execPath, [path.resolve('preview.mjs'), intended, 'C:\\repo', '--ref', 'refs/tags/fixture', '--json'], { env, encoding: 'utf8' });
    assert.equal(scan.status, 2, scan.stderr);
    assert.match(scan.stderr, /GIT_DIR/);
    assert.equal(scan.stdout, '');
    for (const name of ['GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) {
      const blocked = spawnSync(process.execPath, [path.resolve('preview.mjs'), intended, 'C:\\repo', '--ref', 'refs/tags/fixture', '--json'], { env: { ...process.env, [name]: other }, encoding: 'utf8' });
      assert.equal(blocked.status, 2, `${name}: ${blocked.stderr}`);
      assert.ok(blocked.stderr.includes(name));
      assert.equal(blocked.stdout, '');
    }
  } finally {
    const resolvedTemp = realpathSync(temporary);
    const relativeTemp = path.relative(realpathSync(os.tmpdir()), resolvedTemp);
    if (!relativeTemp || relativeTemp.startsWith('..') || path.isAbsolute(relativeTemp)) throw new Error('Temporary directory is outside the intended temp root');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
