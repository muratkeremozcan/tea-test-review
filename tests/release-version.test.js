'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  compareVersionTags,
  latestVersionTag,
  majorTag,
  nextVersionTag,
  parseStableTag,
} = require('../scripts/release-version.js');

const CLI = path.join(__dirname, '..', 'scripts', 'release-version.js');
const RELEASE_WORKFLOW = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');

describe('release version tags', () => {
  test('parses a stable action release tag', () => {
    assert.deepStrictEqual(parseStableTag('v12.34.56'), { major: 12, minor: 34, patch: 56 });
  });

  for (const tag of ['1.2.3', 'v1', 'v1.2', 'v01.2.3', 'v1.02.3', 'v1.2.03', 'v1.2.3-beta.1', 'main', '']) {
    test(`rejects ${JSON.stringify(tag)}`, () => {
      assert.throws(() => parseStableTag(tag), /must match vX\.Y\.Z/);
    });
  }

  test('rejects unsafe numeric components', () => {
    assert.throws(() => parseStableTag('v9007199254740992.0.0'), /safe integer range/);
  });

  test('bumps patch without changing the compatibility line', () => {
    assert.strictEqual(nextVersionTag('v1.2.3', 'patch'), 'v1.2.4');
  });

  test('bumps minor and resets patch', () => {
    assert.strictEqual(nextVersionTag('v1.2.3', 'minor'), 'v1.3.0');
  });

  test('bumps major and resets minor and patch', () => {
    assert.strictEqual(nextVersionTag('v1.2.3', 'major'), 'v2.0.0');
  });

  test('rejects an unsupported bump', () => {
    assert.throws(() => nextVersionTag('v1.2.3', 'prerelease'), /bump must be/);
  });

  test('derives the floating major tag', () => {
    assert.strictEqual(majorTag('v12.34.56'), 'v12');
  });

  test('orders semantic versions numerically', () => {
    assert.ok(compareVersionTags('v2.0.0', 'v1.99.99') > 0);
    assert.ok(compareVersionTags('v1.10.0', 'v1.9.99') > 0);
    assert.strictEqual(compareVersionTags('v1.2.3', 'v1.2.3'), 0);
  });

  test('selects the highest stable version instead of the latest publication', () => {
    assert.strictEqual(latestVersionTag(['v2.0.0', 'v1.9.1', '1.0.0', 'v1']), 'v2.0.0');
  });

  test('uses v0.0.0 as the first-release baseline when no stable version exists', () => {
    assert.strictEqual(latestVersionTag(['1.0.0', 'v1', 'beta']), 'v0.0.0');
    assert.strictEqual(nextVersionTag(latestVersionTag([]), 'patch'), 'v0.0.1');
  });
});

describe('release version CLI', () => {
  test('prints a derived version', () => {
    const result = spawnSync(process.execPath, [CLI, 'next', 'v1.2.3', 'patch'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, 'v1.2.4\n');
    assert.strictEqual(result.stderr, '');
  });

  test('fails loudly for a malformed tag', () => {
    const result = spawnSync(process.execPath, [CLI, 'validate', '1.2.3'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /must match vX\.Y\.Z/);
  });

  test('fails loudly for an incomplete command', () => {
    const result = spawnSync(process.execPath, [CLI, 'next', 'v1.2.3'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /usage:/);
  });

  test('reads release tags from stdin and prints the highest stable version', () => {
    const result = spawnSync(process.execPath, [CLI, 'latest'], {
      encoding: 'utf8',
      input: 'v1.9.9\nv2.0.0\nv1.10.0\n1.0.0\n',
    });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, 'v2.0.0\n');
  });

  test('prints the first-release baseline for empty stdin', () => {
    const result = spawnSync(process.execPath, [CLI, 'latest'], { encoding: 'utf8', input: '' });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, 'v0.0.0\n');
  });

  test('compares stable versions for promotion ordering', () => {
    const older = spawnSync(process.execPath, [CLI, 'compare', 'v1.2.3', 'v1.10.0'], { encoding: 'utf8' });
    const equal = spawnSync(process.execPath, [CLI, 'compare', 'v1.2.3', 'v1.2.3'], { encoding: 'utf8' });
    const newer = spawnSync(process.execPath, [CLI, 'compare', 'v2.0.0', 'v1.99.99'], { encoding: 'utf8' });

    assert.strictEqual(older.stdout, '-1\n');
    assert.strictEqual(equal.stdout, '0\n');
    assert.strictEqual(newer.stdout, '1\n');
  });
});

describe('release workflow contract', () => {
  test('prepares from a bump choice and promotes only published releases', () => {
    assert.match(RELEASE_WORKFLOW, /workflow_dispatch:/);
    assert.match(RELEASE_WORKFLOW, /options:\n\s+- patch\n\s+- minor\n\s+- major/);
    assert.match(RELEASE_WORKFLOW, /release:\n\s+types: \[published\]/);
  });

  test('pins every write-capable workflow dependency to a full commit SHA', () => {
    const externalUses = [...RELEASE_WORKFLOW.matchAll(/^\s+uses: (?!\.\/)(\S+)/gm)].map((match) => match[1]);
    assert.ok(externalUses.length > 0);
    for (const use of externalUses) {
      assert.match(use, /@[0-9a-f]{40}$/);
    }
  });

  test('runs the unit and consumer smoke gates before preparation and promotion', () => {
    assert.strictEqual((RELEASE_WORKFLOW.match(/name: Run unit tests/g) || []).length, 2);
    assert.strictEqual((RELEASE_WORKFLOW.match(/name: Run deterministic consumer smoke/g) || []).length, 2);
  });

  test('checks Marketplace publication before moving the floating tag', () => {
    const marketplace = RELEASE_WORKFLOW.indexOf('name: Verify Marketplace publication');
    const move = RELEASE_WORKFLOW.indexOf('name: Move the floating major tag');
    assert.ok(marketplace > -1 && marketplace < move);
    assert.match(RELEASE_WORKFLOW, /grep --fixed-strings --word-regexp --quiet "\$TAG"/);
  });

  test('prevents major-tag rollback and peels annotated tags to commits', () => {
    const ordering = RELEASE_WORKFLOW.indexOf('release-version.js compare "$TAG" "$highest_tag"');
    const move = RELEASE_WORKFLOW.indexOf('name: Move the floating major tag');

    assert.ok(ordering > -1 && ordering < move);
    assert.match(RELEASE_WORKFLOW, /if \[ "\$RELEASE_ORDER" -lt 0 \]/);
    assert.match(RELEASE_WORKFLOW, /while \[ "\$object_type" = 'tag' \]/);
    assert.match(RELEASE_WORKFLOW, /exact_sha=\$\(resolve_tag_commit "\$TAG"\)/);
    assert.match(RELEASE_WORKFLOW, /major_sha=\$\(resolve_tag_commit "\$MAJOR"\)/);
  });

  test('creates releases from the exact tag and never the floating major', () => {
    assert.match(RELEASE_WORKFLOW, /gh release create "\$TAG"/);
    assert.doesNotMatch(RELEASE_WORKFLOW, /gh release create "\$MAJOR"/);
  });
});
