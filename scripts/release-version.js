'use strict';

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BUMPS = new Set(['patch', 'minor', 'major']);
const BASELINE_TAG = 'v0.0.0';

function parseStableTag(tag) {
  const match = STABLE_TAG.exec(String(tag));
  if (!match) {
    throw new Error(`release tag must match vX.Y.Z, got "${tag}"`);
  }

  const version = match.slice(1).map(Number);
  if (!version.every(Number.isSafeInteger)) {
    throw new Error(`release tag exceeds JavaScript's safe integer range: "${tag}"`);
  }

  return { major: version[0], minor: version[1], patch: version[2] };
}

function nextVersionTag(currentTag, bump) {
  if (!BUMPS.has(bump)) {
    throw new Error(`bump must be patch, minor, or major, got "${bump}"`);
  }

  const current = parseStableTag(currentTag);
  const next = { ...current };

  if (bump === 'major') {
    next.major += 1;
    next.minor = 0;
    next.patch = 0;
  } else if (bump === 'minor') {
    next.minor += 1;
    next.patch = 0;
  } else {
    next.patch += 1;
  }

  if (![next.major, next.minor, next.patch].every(Number.isSafeInteger)) {
    throw new Error(`next ${bump} version exceeds JavaScript's safe integer range`);
  }

  return `v${next.major}.${next.minor}.${next.patch}`;
}

function majorTag(versionTag) {
  return `v${parseStableTag(versionTag).major}`;
}

function compareVersionTags(leftTag, rightTag) {
  const left = parseStableTag(leftTag);
  const right = parseStableTag(rightTag);

  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function latestVersionTag(tags) {
  const valid = tags.filter((tag) => STABLE_TAG.test(String(tag)));
  if (valid.length === 0) {
    return BASELINE_TAG;
  }

  return valid.sort(compareVersionTags).at(-1);
}

function runCli(argv, stdin = '') {
  const [command, first, second] = argv;

  if (command === 'validate' && first && second === undefined) {
    parseStableTag(first);
    return first;
  }

  if (command === 'next' && first && second) {
    return nextVersionTag(first, second);
  }

  if (command === 'major' && first && second === undefined) {
    return majorTag(first);
  }

  if (command === 'compare' && first && second) {
    return String(Math.sign(compareVersionTags(first, second)));
  }

  if (command === 'latest' && first === undefined) {
    return latestVersionTag(stdin.split(/\r?\n/).filter(Boolean));
  }

  throw new Error('usage: release-version.js validate <vX.Y.Z> | next <vX.Y.Z> <patch|minor|major> | major <vX.Y.Z> | compare <vX.Y.Z> <vX.Y.Z> | latest < tags.txt');
}

if (require.main === module) {
  try {
    const stdin = process.argv[2] === 'latest' ? require('node:fs').readFileSync(0, 'utf8') : '';
    process.stdout.write(`${runCli(process.argv.slice(2), stdin)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  compareVersionTags,
  latestVersionTag,
  majorTag,
  nextVersionTag,
  parseStableTag,
  runCli,
};
