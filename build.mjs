/**
 * Builds each MFTF version in builds.json as two archives, ready to unpack
 * and run: <version>.tgz, Adobe's tag on Adobe's own lock, and
 * <version>-bidi.tgz, the same with the WebDriver BiDi module added. With
 * --publish, each version whose build has no release yet becomes release
 * mftf-<version>-<build> holding both; one already released is left alone,
 * so publishing a version again is raising its build in builds.json.
 *
 * Needs php, composer and git on PATH, and for --publish gh signed in as
 * someone who can write releases here.
 *
 *   node build.mjs [--only <version>] [--out <dir>] [--publish]
 */
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const run = promisify(execFile);

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'rnscommerce/mftf-distros';
const MFTF_REPO = 'https://github.com/magento/magento2-functional-testing-framework';

/**
 * The Codeception module that puts WebDriver BiDi in a run's session, and the
 * PHP client it pulls in. Neither is on Packagist, so the BiDi build adds both
 * repositories to its own composer.json and requires the module by a tag.
 */
const BIDI_MODULE = 'rnscommerce/codeception-module-webdriver-bidi';
const BIDI_CONSTRAINT = '^0.6';
const BIDI_PACKAGES = [BIDI_MODULE, 'rnscommerce/php-webdriver-bidi'];
const BIDI_CLASS = 'Rnscommerce\\Codeception\\WebDriverBiDi\\WebDriverBiDi';

const { values } = parseArgs({
  options: {
    only: { type: 'string' },
    out: { type: 'string', default: path.join(ROOT, 'out') },
    publish: { type: 'boolean', default: false },
  },
});

async function main() {
  const builds = JSON.parse(await readFile(path.join(ROOT, 'builds.json'), 'utf8'));
  const versions = Object.keys(builds).filter((version) => !values.only || version === values.only);
  if (versions.length === 0) throw new Error(`no version ${values.only} in builds.json`);
  await mkdir(values.out, { recursive: true });
  const released = values.publish ? await releases() : [];

  for (const version of versions) {
    const { php, build } = builds[version];
    const name = `mftf-${version}-${build}`;
    if (values.publish && released.includes(name)) {
      console.log(`${version}  build ${build} is published`);
      continue;
    }
    const archives = await assemble(version, php, build);
    if (values.publish) await publish(version, php, build, archives);
  }
}

async function releases() {
  const { stdout } = await run(
    'gh',
    ['api', `repos/${REPO}/releases`, '--paginate', '--jq', '.[].tag_name'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout.split('\n').filter(Boolean);
}

async function assemble(version, php, build) {
  // Staged beside the archives so a version that fails leaves nothing behind.
  const work = await mkdtemp(path.join(values.out, `.${version}-`));
  try {
    console.log(`${version}  downloading`);
    const tarball = path.join(work, 'source.tar.gz');
    await download(`${MFTF_REPO}/archive/refs/tags/${version}.tar.gz`, tarball);
    const classic = path.join(work, version);
    await mkdir(classic);
    await run('tar', ['xzf', tarball, '--strip-components=1', '-C', classic]);

    console.log(`${version}  installing Adobe's lock for PHP ${php}`);
    await composer(classic, ['config', 'platform.php', php]);
    // The extensions checked are the runner's, which say nothing about the
    // user's machine; Studio checks those against the PHP it runs with.
    await composer(classic, [
      'install',
      '--no-dev',
      '--no-progress',
      '--prefer-dist',
      '--optimize-autoloader',
      '--ignore-platform-req=ext-*',
    ]);
    await trim(classic);

    const bidi = path.join(work, `${version}-bidi`);
    await cp(classic, bidi, { recursive: true, verbatimSymlinks: true });

    await applyPatches(classic, path.join(ROOT, 'patches', version));
    await verify(classic, version, false);

    console.log(`${version}  adding WebDriver BiDi`);
    for (const name of BIDI_PACKAGES) {
      await composer(bidi, ['config', `repositories.${name.split('/')[1]}`, 'vcs', `https://github.com/${name}`]);
    }
    await composer(bidi, [
      'require',
      `${BIDI_MODULE}:${BIDI_CONSTRAINT}`,
      '--with-dependencies',
      '--update-no-dev',
      '--no-progress',
      '--prefer-dist',
      '--optimize-autoloader',
      '--ignore-platform-req=ext-*',
    ]);
    await applyPatches(bidi, path.join(ROOT, 'patches', version));
    await applyPatches(bidi, path.join(ROOT, 'patches', version, 'bidi'));
    await verify(bidi, version, true);

    const archives = [];
    for (const [tree, isBidi] of [
      [classic, false],
      [bidi, true],
    ]) {
      const stem = path.basename(tree);
      await writeFile(
        path.join(tree, 'mftf-distro.json'),
        `${JSON.stringify({ version, bidi: isBidi, build }, null, 2)}\n`,
      );
      const staged = path.join(work, `${stem}.tgz`);
      await run('tar', ['czf', staged, '-C', work, stem]);
      const target = path.join(values.out, `${stem}.tgz`);
      await rename(staged, target);
      archives.push(target);
    }
    console.log(`${version}  build ${build} done`);
    return archives;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const composer = (cwd, args) =>
  run('composer', [...args, '--no-interaction'], {
    cwd,
    env: { ...process.env, COMPOSER_NO_INTERACTION: '1' },
    maxBuffer: 16 * 1024 * 1024,
  });

/**
 * What a version does not need at runtime: the framework's own test suites
 * and docs, and the AWS SDK's models for every service but the two MFTF
 * reaches for. It constructs one client, Secrets Manager, for its optional
 * vault credentials; STS stays because the SDK's credential providers reach
 * for it. The models alone are most of an untrimmed version's weight.
 */
const REMOVE = [
  'docs',
  '.github',
  'dev/tests/unit',
  'dev/tests/verification',
  'dev/tests/static',
  'dev/tests/util',
  'dev/tests/phpunit.xml',
];
const AWS_DATA = 'vendor/aws/aws-sdk-php/src/data';
const AWS_KEEP = new Set(['secretsmanager', 'sts']);

async function trim(source) {
  for (const rel of REMOVE) await rm(path.join(source, rel), { recursive: true, force: true });
  for (const entry of await readdir(path.join(source, AWS_DATA), { withFileTypes: true })) {
    if (entry.isDirectory() && !AWS_KEEP.has(entry.name)) {
      await rm(path.join(source, AWS_DATA, entry.name), { recursive: true });
    }
  }
}

/**
 * Every .diff directly in `dir`, in name order; one that does not apply whole
 * fails the build. Git is kept from finding a repository above the source, in
 * which it would apply paths relative to that repository and skip the rest.
 */
async function applyPatches(source, dir) {
  const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.diff')).sort();
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(source) };
  for (const name of names) {
    const patch = path.join(dir, name);
    await run('git', ['apply', '--check', patch], { cwd: source, env });
    await run('git', ['apply', patch], { cwd: source, env });
    console.log(`${path.basename(source)}  applied ${name}`);
  }
}

/**
 * What a build could have broken: the framework itself, the Action Group
 * schema libxml must accept, the one AWS client MFTF constructs, and in the
 * BiDi build the module. All are exercised here rather than surfacing on
 * someone's machine as a stack trace from inside the framework.
 */
async function verify(source, version, bidi) {
  const { stdout } = await run('php', [path.join(source, 'bin/mftf'), '--version'], { cwd: source });
  if (!stdout.includes(version)) throw new Error(`${version}: bin/mftf --version said "${stdout.trim()}"`);

  const schema = path.join(source, 'src/Magento/FunctionalTestingFramework/Test/etc/mergedActionGroupSchema.xsd');
  const checked = await run('php', [
    '-r',
    `$d = new DOMDocument(); $d->loadXML('<x/>'); libxml_use_internal_errors(true); $d->schemaValidate('${schema}');` +
      ` foreach (libxml_get_errors() as $e) { if (str_contains($e->message, 'not determinist')) { echo 'NOT DETERMINISTIC'; } }`,
  ]);
  if (checked.stdout.includes('NOT DETERMINISTIC')) {
    throw new Error(`${version}: the Action Group schema is still non-deterministic`);
  }

  await run('php', [
    '-r',
    `require '${source}/vendor/autoload.php'; new Aws\\SecretsManager\\SecretsManagerClient(['region' => 'us-east-1', 'version' => 'latest', 'credentials' => false]);`,
  ]);

  const module = await run('php', [
    '-r',
    `require '${source}/vendor/autoload.php'; echo class_exists('${BIDI_CLASS.replaceAll('\\', '\\\\')}') ? 'yes' : 'no';`,
  ]);
  if (module.stdout !== (bidi ? 'yes' : 'no')) {
    throw new Error(`${version}: the BiDi module is ${bidi ? 'missing from' : 'in'} the ${bidi ? 'BiDi' : 'classic'} build`);
  }
}

async function publish(version, php, build, archives) {
  const name = `mftf-${version}-${build}`;
  const notes = [
    `MFTF ${version} from Adobe's tag, with Adobe's own dependencies installed for PHP ${php} and later.`,
    `${version}.tgz is that build; ${version}-bidi.tgz adds WebDriver BiDi. The README says what is changed in each.`,
  ].join(' ');
  await run('gh', [
    'release',
    'create',
    name,
    ...archives,
    '--repo',
    REPO,
    '--title',
    `MFTF ${version}, build ${build}`,
    '--notes',
    notes,
  ]);
  console.log(`${version}  published ${name}`);
}

async function download(url, to) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(to));
}

main().catch((error) => {
  console.error(error.stderr ?? error.message ?? error);
  process.exit(1);
});
