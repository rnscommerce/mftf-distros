# mftf-distros

Standalone builds of the [Magento Functional Testing Framework](https://github.com/magento/magento2-functional-testing-framework),
ready to unpack and run without Composer. MFTF Studio downloads them, and
they work the same outside it.

These builds are not made or endorsed by Adobe.

## What a build is

One release per build, tagged `mftf-<version>-<build>`, holding two archives:

- `<version>.tgz`, MFTF as Adobe ships it, with the changes below;
- `<version>-bidi.tgz`, the same with WebDriver BiDi added.

Each unpacks to a folder named after the archive, with `bin/mftf` inside, and
`mftf-distro.json` naming the version, the build and whether it has BiDi.

Each build starts from Adobe's own tag of that version, and then:

- Its dependencies are installed from Adobe's own `composer.lock`, checked as
  if on the lowest PHP that version supports.
- The patches in `patches/<version>/` are applied:
  - `action-group-schema.diff`: `mergedActionGroupSchema.xsd` is accepted by
    libxml 2.12 and later, which reject the schema as Adobe ships it as
    non-deterministic.
  - `console-lines.diff`: the console splits a generated test at every line
    break, so each step is named on Windows too.
  - `absent-project-autoloader.diff`: the standalone bootstrap loads a
    project's `vendor/autoload.php` only where there is one.
  - `module-vendor-name.diff`: a module outside `vendor`, `app/code` and
    `dev/tests` is named after the folder it sits in, as `Acme_Own` for
    `Acme/Own`, rather than `UnknownVendor_Own`.
- MFTF's own documentation and its own tests are left out, as are the AWS
  SDK's models for every service but Secrets Manager and STS.

The BiDi build then adds:

- [`rnscommerce/codeception-module-webdriver-bidi`](https://github.com/rnscommerce/codeception-module-webdriver-bidi)
  and the [PHP WebDriver BiDi client](https://github.com/rnscommerce/php-webdriver-bidi)
  it uses. Only what they need is added or updated; the rest stays on Adobe's lock.
- The patch in `patches/<version>/bidi/`, `magento-web-driver-bidi-waits.diff`:
  MFTF's page waits, and the click `conditionalClick` makes, go through
  WebDriver BiDi where the module is enabled and the browser session has it.
  Where either is missing, MFTF's own code runs.

Every changed file says so at its top, and when. The patches apply with
`git apply` or with `cweagans/composer-patches`.

## Publishing

`builds.json` names each version's build and the lowest PHP it supports.
A push to `main` that names a build with no release yet publishes it; one
already released is left alone. So a change to a patch or to `build.mjs` is
published by raising the build of each version it changes.

    node build.mjs [--only <version>] [--out <dir>] [--publish]

## Licence

MFTF is licensed under AGPL-3.0 (see `COPYING.txt` and `LICENSE_AGPL3.txt` in
every build), and so is each build here, changes included. Every dependency
keeps its own licence file under `vendor/`. The builds are PHP throughout,
so each archive is its own complete source.
