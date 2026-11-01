# mftf-distros

Standalone builds of the [Magento Functional Testing Framework](https://github.com/magento/magento2-functional-testing-framework),
ready to unpack and run without Composer. MFTF Studio downloads them, and
they work the same outside it.

These builds are not made or endorsed by Adobe.

## What a build is

One release per build, tagged `mftf-<version>-<build>`, holding one archive,
`<version>.tgz`. It unpacks to a folder named after the version, with
`bin/mftf` inside, and `mftf-distro.json` naming the version and the build.

Each build starts from Adobe's own tag of that version, and then:

- Its dependencies are installed with Composer as if on the lowest PHP that
  version supports, so the build runs on that PHP and anything newer.
- [`rnscommerce/codeception-module-webdriver-bidi`](https://github.com/rnscommerce/codeception-module-webdriver-bidi)
  and the [PHP WebDriver BiDi client](https://github.com/rnscommerce/php-webdriver-bidi)
  it uses are added. A test run enables the module where it wants WebDriver
  BiDi, and does nothing different where it does not.
- `MagentoWebDriver.php` is changed so that MFTF's page waits, and the click
  `conditionalClick` makes, go through WebDriver BiDi where the module is
  enabled and the browser session has it. Where either is missing, MFTF's own
  code runs.
- `mergedActionGroupSchema.xsd` is changed so that libxml 2.12 and later accept
  it: the schema as Adobe ships it is rejected as non-deterministic.
- MFTF's own documentation and its own tests are left out.

Every changed file says so at its top, and when. A new build is published
whenever any of these steps changes.

## Licence

MFTF is licensed under AGPL-3.0 (see `COPYING.txt` and `LICENSE_AGPL3.txt` in
every build), and so is each build here, changes included. Every dependency
keeps its own licence file under `vendor/`. The builds are PHP throughout,
so each archive is its own complete source.
