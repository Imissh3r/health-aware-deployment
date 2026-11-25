import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, unlinkSync, writeFileSync
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { runFormalHealthyRelease } from './run-formal-healthy-release.mjs';
import { runFormalFaultyCandidate } from './run-formal-faulty-candidate.mjs';
import { runFormalPostRolloutDegradation } from './run-formal-post-rollout-degradation.mjs';

const execute = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const runners = { S1: runFormalHealthyRelease, S2: runFormalFaultyCandidate, S3: runFormalPostRolloutDegradation };
const algorithm = 'sha256-fisher-yates-v1';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hexDigest = /^[a-f0-9]{64}$/;
const gitHash = /^[a-f0-9]{40}$/;
const present = value => typeof value === 'string' && value.trim().length > 0;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const json = value => JSON.stringify(value);
const copy = value => JSON.parse(json(value));
const read = path => {
  if (!lstatSync(path).isFile()) throw new Error('Expected a regular JSON file: ' + path);
  return JSON.parse(readFileSync(path, 'utf8'));
};
const exists = path => Boolean(lstatSync(path, { throwIfNoEntry: false }));
const active = new Set();

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function frozenMetadata(environment) {
  const url = typeof environment?.proxyUrl === 'string' ? URL.parse(environment.proxyUrl) : null;
  requireCondition(url?.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port &&
    url.pathname === '/api/work' && url.href === environment.proxyUrl &&
    !url.username && !url.password && !url.search && !url.hash &&
    matches(/^[a-z0-9][a-z0-9_-]*$/, environment.project) &&
    matches(hexDigest, environment.stableConfigSha256) &&
    matches(hexDigest, environment.environmentFingerprint) &&
    matches(hexDigest, environment.composeConfigSha256) && present(environment.host) &&
    present(environment.preflightRef) && present(environment.composeConfigRef) &&
    environment.imageDigests && Object.getPrototypeOf(environment.imageDigests) === Object.prototype &&
    Object.keys(environment.imageDigests).length > 0 &&
    Object.values(environment.imageDigests).every(value => matches(/^sha256:[a-f0-9]{64}$/, value)),
  'Missing or invalid frozen environment metadata');
  const { project, proxyUrl, stableConfigSha256, environmentFingerprint, composeConfigSha256,
    host, preflightRef, composeConfigRef, imageDigests } = environment;
  return { project, proxyUrl, stableConfigSha256, environmentFingerprint, composeConfigSha256,
    host, preflightRef, composeConfigRef, imageDigests: Object.fromEntries(Object.entries(imageDigests).sort()) };
}

function attempt(pair, round) {
  const attemptId = pair.pairId + '-r0' + round;
  return {
    attemptId, round,
    arms: [...pair.plannedOrder].map((arm, index) => {
      const trialId = attemptId + '-' + arm;
      return { scenario: pair.scenario, pairId: pair.pairId, attemptId, round, position: index + 1,
        arm, trialId, driverRunId: trialId + '-driver' };
    })
  };
}

export function generateCollectionManifest({ seed, gitRevision = null, frozen = null }) {
  requireCondition(matches(/^(?:[a-f0-9]{2}){1,64}$/, seed), 'Provide an explicit lowercase hex seed (1–64 bytes)');
  requireCondition(gitRevision === null || matches(gitHash, gitRevision), 'Expected a full Git revision');
  const environment = frozen === null ? null : frozenMetadata(frozen);
  const provenance = { schemaVersion: 1, protocolRevision: 'Draft v1.2', algorithm, seed, gitRevision, frozen: environment };
  const scheduleId = 'wc-' + sha256(json(provenance));
  const pairs = Object.keys(runners).flatMap(scenario => {
    const order = ['HC', 'HC', 'HC', 'HC', 'CH', 'CH', 'CH', 'CH'];
    let counter = 0;
    for (let i = order.length - 1; i > 0; i--) {
      const bound = i + 1;
      const limit = 2 ** 32 - (2 ** 32 % bound);
      let word;
      do {
        word = Number.parseInt(sha256(`${algorithm}:${seed}:${scenario}:${counter++}`).slice(0, 8), 16);
      } while (word >= limit);
      const j = word % bound;
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order.map((plannedOrder, index) => {
      const pair = { scenario, pairId: scheduleId + '-' + scenario + '-p0' + (index + 1), plannedOrder };
      return { ...pair, original: attempt(pair, 1) };
    });
  });
  return { ...provenance, scheduleId, pairs };
}

export function validateCollectionManifest(manifest) {
  requireCondition(isDeepStrictEqual(manifest, generateCollectionManifest(manifest)),
    'Manifest conflicts with the deterministic schedule or contains invalid identifiers');
}

export function generateRehearsalManifest({ sessionId, gitRevision, frozen, arms }) {
  requireCondition(matches(/^[a-z0-9][a-z0-9-]{0,63}$/, sessionId), 'Provide a unique rehearsal session ID');
  requireCondition(matches(gitHash, gitRevision), 'Expected a full Git revision');
  const environment = frozenMetadata(frozen);
  requireCondition(environment.project === 'health-aware-workflow-comparison' &&
    environment.proxyUrl === 'http://127.0.0.1:18080/api/work', 'Rehearsal requires the comparison project and proxy');
  requireCondition(Array.isArray(arms) && arms.length > 0, 'Select at least one rehearsal arm');
  return { schemaVersion: 1, protocolRevision: 'Draft v1.2', purpose: 'rehearsal', sessionId, gitRevision,
    frozen: environment, arms: arms.map(({ scenario, arm }, index) => {
      requireCondition(Object.hasOwn(runners, scenario) && ['H', 'C'].includes(arm), 'Invalid rehearsal arm');
      const position = index + 1;
      const trialId = `rehearsal-${sessionId}-${position}-${scenario}-${arm}`;
      return { scenario, arm, position, trialId, driverRunId: trialId + '-driver' };
    }) };
}

export function validateCollectionPlan(mode, manifest) {
  if (mode === 'rehearsal') {
    requireCondition(isDeepStrictEqual(manifest, generateRehearsalManifest(manifest)), 'Invalid rehearsal manifest or trial IDs');
  } else {
    requireCondition(['formal', 'fixture'].includes(mode), 'Unknown collection mode');
    validateCollectionManifest(manifest);
  }
}

export function collectionEvidenceDirectory(mode) {
  return { formal: 'trial-evidence', fixture: 'fixture-evidence', rehearsal: 'rehearsal-evidence' }[mode];
}

function sync(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Publish only complete files. A competing writer cannot replace an existing event.
function publish(path, value) {
  const directory = dirname(path);
  const temporary = join(directory, '.pending-' + randomUUID());
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(temporary, path);
    sync(directory);
  } finally {
    unlinkSync(temporary);
  }
}

export function initializeCollection(directory, manifest, { mode = 'formal' } = {}) {
  validateCollectionPlan(mode, manifest);
  mkdirSync(directory, { mode: 0o700 });
  sync(dirname(resolve(directory)));
  mkdirSync(join(directory, 'ledger'), { mode: 0o700 });
  publish(join(directory, 'manifest.json'), { mode, manifest });
}

const eventFile = index => String(index).padStart(6, '0') + '.json';
const validityStatuses = ['valid', 'invalid', 'needs_review'];
const safeOutcome = outcome => outcome.nextArmAllowed === true &&
  (outcome.cleanup?.status === 'completed' ||
    (outcome.scenario === 'S1' && outcome.cleanup?.status === 'not_required')) &&
  outcome.reset?.status === 'verified' && outcome.reset.event?.event === 'reset_verified' &&
  Object.hasOwn(outcome.reset.event, 'evidence') && outcome.reset.event.evidence != null;

function checkOutcome(outcome, trial, path) {
  requireCondition(outcome?.trialId === trial.trialId && outcome.scenario === trial.scenario &&
    outcome.arm === trial.arm && outcome.runId === trial.driverRunId && outcome.directory === path &&
    validityStatuses.includes(outcome.validity?.status) && Array.isArray(outcome.validity.issues) &&
    typeof outcome.nextArmAllowed === 'boolean', 'Missing or conflicting runner evidence');
}

function review(details) {
  requireCondition(present(details?.authorizedBy) && present(details.reason) && present(details.evidenceRef),
    'An explicit authorizer, reason and evidence reference are required');
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function inspectState(state) {
  const trial = state.round?.arms[state.results.length] ?? null;
  if (state.block) return { status: state.block.status, trial: state.block.trial, reason: state.block.reason };
  if (!state.round) return { status: 'collection_complete' };
  if (trial) return { status: 'planned', trial };
  if (state.rehearsal) return { status: 'collection_complete' };
  if (state.results.every(result => result.outcome?.validity.status === 'valid')) return { status: 'pair_complete' };
  return { status: 'pair_review_required', attemptId: state.round.attemptId };
}

function advance(state, manifest) {
  state.round = manifest.pairs[++state.pairIndex]?.original ?? null;
  state.results = [];
}

function transition(state, event, manifest, evidenceRoot) {
  const current = inspectState(state);
  const trial = state.round?.arms[state.results.length];
  switch (event.type) {
    case 'start':
    case 'preflight_blocked':
      requireCondition(current.status === 'planned' && isDeepStrictEqual(event.trial, trial) &&
        event.evidencePath === join(evidenceRoot, trial.trialId), 'Conflicting arm start or preflight record');
      if (event.type === 'start') {
        requireCondition(Number.isSafeInteger(event.pid) && event.pid > 0 && present(event.host), 'Invalid start owner');
        state.block = { status: 'interrupted_or_unresolved', trial, start: event,
          reason: 'Durable start exists without a terminal outcome' };
      } else {
        requireCondition(present(event.reason), 'Missing preflight blocking reason');
        state.block = { status: 'preflight_blocked', trial, reason: event.reason };
      }
      break;
    case 'outcome':
      requireCondition(state.block?.start?.trial.trialId === event.trialId && trial &&
        state.block.start.sequence === event.startedAt && !state.block.error &&
        event.outcomeRef === join(state.block.start.evidencePath, 'summary.json'), 'Conflicting outcome record');
      checkOutcome(event.outcome, trial, state.block.start.evidencePath);
      state.results.push(event);
      state.block = safeOutcome(event.outcome) ? null : { status: 'reset_blocked', trial,
        reason: 'Runner did not establish safe cleanup and verified reset' };
      break;
    case 'interrupted':
      requireCondition(state.block?.start?.trial.trialId === event.trialId && !state.block.error &&
        present(event.reason), 'Conflicting interruption record');
      state.block.reason = event.reason;
      state.block.error = true;
      break;
    case 'reconcile':
      review(event);
      requireCondition(state.block?.trial.trialId === event.trialId && event.resetVerified === true &&
        event.operationsSettled === true, 'Reconciliation must attest settled operations and verified reset');
      if (state.block.start) {
        if (event.outcome) {
          requireCondition(event.outcomeRef === join(state.block.start.evidencePath, 'summary.json') &&
            event.aborted !== true, 'Conflicting recovered outcome reference');
          checkOutcome(event.outcome, state.block.trial, state.block.start.evidencePath);
        } else {
          requireCondition(event.aborted === true, 'Interrupted arm must be recovered or explicitly aborted');
          if (event.unusableSummaryRef !== undefined) {
            requireCondition(event.unusableSummaryRef === join(state.block.start.evidencePath, 'summary.json') &&
              present(event.summaryError), 'Conflicting incomplete summary reference');
          }
        }
        state.results.push(event);
      } else {
        requireCondition(!Object.hasOwn(event, 'outcome') && !Object.hasOwn(event, 'aborted'),
          'Reconciliation conflicts with the existing attempt');
      }
      state.block = null;
      break;
    case 'pair_decision': {
      requireCondition(current.status === 'pair_review_required' && event.attemptId === state.round.attemptId,
        'Pair is not eligible for adjudication');
      review(event);
      if (event.decision === 'replace') {
        const invalid = state.results.find(result => result.trialId === event.invalidTrialId);
        requireCondition(state.round.round < 3, 'Replacement limit reached');
        requireCondition(invalid?.outcome?.validity.status === 'invalid' ||
          ((invalid?.outcome?.validity.status === 'needs_review' || invalid?.aborted === true) &&
            event.adjudicatedValidity === 'invalid'),
        'Replacement requires technical invalidity, not an adverse workflow outcome');
        requireCondition(event.matchingInvalid === true && present(event.technicalReason),
          'Replacement requires a matching-relevant technical justification');
        requireCondition(isDeepStrictEqual(event.rerunOf, state.round.arms.map(arm => arm.trialId)),
          'Replacement must link both arms of the preceding round');
        state.round = attempt(manifest.pairs[state.pairIndex], state.round.round + 1);
        state.results = [];
      } else {
        requireCondition(event.decision === 'retain', 'Unknown pair decision');
        advance(state, manifest);
      }
      break;
    }
    default:
      throw new Error('Unknown collection ledger event: ' + event.type);
  }

  if (inspectState(state).status === 'pair_complete') advance(state, manifest);
}

export function openCollection(directory, { expectedMode, verifyEnvironment, fixtureRunners, now = () => new Date() } = {}) {
  const root = realpathSync(directory);
  const { mode, manifest } = read(join(root, 'manifest.json'));
  validateCollectionPlan(mode, manifest);
  requireCondition(expectedMode === undefined || expectedMode === mode, 'Collection mode differs from the expected mode');
  requireCondition(!fixtureRunners || mode === 'fixture', 'Invalid collection mode');
  const manifestHash = sha256(json({ mode, manifest }));
  const ledger = join(root, 'ledger');
  const rehearsal = mode === 'rehearsal';
  const evidenceRoot = join(root, collectionEvidenceDirectory(mode));
  const load = () => {
    const state = { pairIndex: 0, rehearsal, round: rehearsal ? { arms: manifest.arms } : manifest.pairs[0].original,
      results: [], block: null };
    const files = readdirSync(ledger).filter(file => !file.startsWith('.pending-')).sort();
    const events = files.map((file, index) => {
      requireCondition(file === eventFile(index + 1), 'Missing, duplicate or unexpected collection ledger record');
      const event = read(join(ledger, file));
      requireCondition(event.sequence === index + 1 && event.manifestHash === manifestHash &&
        event.mode === mode && present(event.recordedAt), 'Conflicting collection ledger metadata');
      transition(state, event, manifest, evidenceRoot);
      return event;
    });
    return { state, events };
  };
  const append = ({ state, events }, payload) => {
    const event = { ...payload, sequence: events.length + 1, manifestHash, mode, recordedAt: now().toISOString() };
    transition(state, event, manifest, evidenceRoot);
    publish(join(ledger, eventFile(event.sequence)), event);
    return event;
  };

  return {
    inspect() {
      const { state, events } = load();
      const status = inspectState(state);
      const start = state.block?.start;
      if (start && !state.block.error && start.host === hostname() &&
          (active.has(join(root, start.trial.trialId)) || (start.pid !== process.pid && processAlive(start.pid)))) {
        status.status = 'started';
        status.reason = 'Starting process may still be active';
      }
      return { mode, manifestHash, ...status, events };
    },

    async runNext() {
      requireCondition(!rehearsal || expectedMode === 'rehearsal', 'Explicit rehearsal execution mode is required');
      const snapshot = load();
      const next = inspectState(snapshot.state);
      requireCondition(next.status === 'planned', 'No eligible arm: ' + next.status);
      const { trial } = next;
      const evidencePath = join(evidenceRoot, trial.trialId);
      requireCondition(!exists(evidencePath), 'Trial evidence path already exists: ' + evidencePath);
      const run = (mode === 'fixture' ? fixtureRunners : runners)?.[trial.scenario];
      requireCondition(typeof run === 'function' && typeof verifyEnvironment === 'function',
        'Execution requires a scenario runner and an explicit environment verifier');
      try {
        requireCondition(manifest.gitRevision && manifest.frozen, 'Frozen Git and environment metadata are required');
        if (mode !== 'fixture') {
          const git = async (...args) => {
            const result = await execute('git', ['-C', repo, ...args], { encoding: 'utf8' });
            return result.stdout.trim();
          };
          requireCondition(await git('branch', '--show-current') === 'workflow-comparison' &&
            await git('rev-parse', 'HEAD') === manifest.gitRevision && (await git('status', '--porcelain')).length === 0,
          'Frozen Git checkpoint must match a clean workflow-comparison checkout');
          requireCondition(hostname() === manifest.frozen.host &&
            process.env.COMPOSE_PROJECT_NAME === manifest.frozen.project &&
            process.env.DEPLOYMENT_PROXY_URL === manifest.frozen.proxyUrl, 'Frozen process environment mismatch');
          if (rehearsal) {
            const expectedFiles = ['compose.yaml', 'compose.comparison.yaml'].map(file => resolve(repo, file)).join(':');
            requireCondition(process.env.COMPOSE_FILE === expectedFiles && !process.env.COMPOSE_PATH_SEPARATOR,
              'Rehearsal requires the explicit comparison Compose file list');
          }
        }
        const verified = await verifyEnvironment(copy({ gitRevision: manifest.gitRevision, frozen: manifest.frozen }));
        requireCondition(verified?.gitRevision === manifest.gitRevision &&
          isDeepStrictEqual(frozenMetadata(verified.frozen), manifest.frozen),
        'Verified environment differs from the manifest');
      } catch (error) {
        return append(snapshot, { type: 'preflight_blocked', trial, evidencePath, reason: String(error.message ?? error) });
      }
      if (!exists(evidenceRoot)) {
        mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
        sync(root);
      }
      requireCondition(realpathSync(evidenceRoot) === evidenceRoot && !exists(evidencePath),
        'Trial evidence directory conflicts with the planned path');
      const start = append(snapshot, { type: 'start', trial, evidencePath, pid: process.pid, host: hostname() });
      const key = join(root, trial.trialId);
      active.add(key);
      let outcome;
      try {
        const { project, proxyUrl, stableConfigSha256, environmentFingerprint } = manifest.frozen;
        const result = await run({ arm: trial.arm, trialId: trial.trialId, evidenceRoot,
          frozen: { project, proxyUrl, stableConfigSha256, environmentFingerprint } });
        const summaryPath = join(evidencePath, 'summary.json');
        outcome = read(summaryPath);
        checkOutcome(outcome, trial, evidencePath);
        requireCondition(isDeepStrictEqual(outcome, copy(result)), 'Runner return conflicts with summary.json');
        sync(summaryPath);
        sync(evidencePath);
        sync(evidenceRoot);
      } catch (error) {
        return append(load(), { type: 'interrupted', trialId: trial.trialId, reason: String(error.message ?? error) });
      } finally {
        active.delete(key);
      }
      return append(load(), { type: 'outcome', trialId: trial.trialId, startedAt: start.sequence,
        outcomeRef: join(evidencePath, 'summary.json'), outcome });
    },

    reconcile({ authorizedBy, reason, evidenceRef, resetVerified, operationsSettled, aborted }) {
      requireCondition(!rehearsal || expectedMode === 'rehearsal', 'Explicit rehearsal execution mode is required');
      const snapshot = load();
      const block = snapshot.state.block;
      requireCondition(block, 'No safety block to reconcile');
      const event = { type: 'reconcile', trialId: block.trial.trialId, authorizedBy, reason, evidenceRef,
        resetVerified, operationsSettled };
      if (block.start) {
        requireCondition(!active.has(join(root, block.trial.trialId)) &&
          block.start.host === hostname() &&
          (block.start.pid === process.pid || !processAlive(block.start.pid)),
        'Starting process may still own this arm');
        const path = join(block.start.evidencePath, 'summary.json');
        if (exists(path)) {
          let outcome;
          try {
            outcome = read(path);
            checkOutcome(outcome, block.trial, block.start.evidencePath);
          } catch (error) {
            requireCondition(aborted === true, 'Unusable summary requires explicit abort: ' + error.message);
            event.unusableSummaryRef = path;
            event.summaryError = error.message;
          }
          if (outcome && !event.summaryError) {
            requireCondition(aborted !== true, 'Existing outcome must be reconciled from its evidence');
            sync(path);
            sync(block.start.evidencePath);
            sync(evidenceRoot);
            event.outcome = outcome;
            event.outcomeRef = path;
          }
        }
        if (!event.outcome) event.aborted = aborted === true;
      }
      return append(snapshot, event);
    },

    decidePair({ decision, authorizedBy, reason, evidenceRef, invalidTrialId,
      technicalReason, matchingInvalid, adjudicatedValidity }) {
      const snapshot = load();
      const { round } = snapshot.state;
      const event = { type: 'pair_decision', decision, attemptId: round?.attemptId, authorizedBy, reason, evidenceRef };
      if (decision === 'replace') Object.assign(event, { invalidTrialId, technicalReason, matchingInvalid,
        ...(adjudicatedValidity !== undefined && { adjudicatedValidity }), rerunOf: round?.arms.map(arm => arm.trialId) });
      return append(snapshot, event);
    }
  };
}

export function inspectCollectionCommand(command, input) {
  if (command === 'plan') return generateCollectionManifest({ seed: input });
  if (command === 'inspect') return openCollection(input).inspect();
  throw new Error('Unknown offline command: ' + command);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, input, ...extra] = process.argv.slice(2);
    requireCondition(input && !extra.length, 'Usage: formal-collection.mjs plan <hex-seed> | inspect <collection-directory>');
    console.log(JSON.stringify(inspectCollectionCommand(command, input), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
