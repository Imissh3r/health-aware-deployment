import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { hostname, release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs, promisify } from 'node:util';
import { generateRehearsalManifest, initializeCollection, openCollection } from './formal-collection.mjs';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const project = 'health-aware-workflow-comparison';
const proxyUrl = 'http://127.0.0.1:18080/api/work';
const services = ['app', 'candidate', 'db', 'nginx'];
const composeFiles = ['compose.yaml', 'compose.comparison.yaml'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hex = /^[a-f0-9]{64}$/;
const dockerId = /^sha256:[a-f0-9]{64}$/;
const network = project + '_default';
const volume = project + '_db-data';
const composeConfigRef = 'comparison-compose.redacted.json';
const preflightRef = 'rehearsal-preflight.json';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  }
  return value;
}

const canonical = value => JSON.stringify(sorted(value)) + '\n';
const same = (actual, expected, message) => check(isDeepStrictEqual(actual, expected), message);

async function executeCommand(file, args, options) {
  return (await exec(file, args, { ...options, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
}

async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function composeSummary(model, root) {
  const bindings = { app: [{ host: '127.0.0.1', port: '13000', target: 3000, protocol: 'tcp' }],
    candidate: [], db: [], nginx: [{ host: '127.0.0.1', port: '18080', target: 80, protocol: 'tcp' }] };
  const mountPath = join(root, 'runtime/nginx/conf.d');
  check(model?.name === project && model.networks?.default?.name === network &&
    model.volumes?.['db-data']?.name === volume, 'Unexpected Compose project, network or volume');
  same(Object.keys(model.services ?? {}).sort(), services, 'Unexpected Compose services');
  same(Object.keys(model.networks).sort(), ['default'], 'Unexpected Compose networks');
  same(Object.keys(model.volumes).sort(), ['db-data'], 'Unexpected Compose volumes');
  check(!model.networks.default.external && !model.volumes['db-data'].external, 'Comparison resources must belong to the project');
  const entries = services.map(service => {
    const spec = model.services[service];
    const source = spec.build?.context;
    const image = { app: project + '-app', candidate: project + '-candidate', db: 'postgres:17', nginx: 'nginx:stable-alpine' }[service];
    const expectedBuild = ['app', 'candidate'].includes(service);
    check(expectedBuild ? source === join(root, 'apps/sample-app') && (!spec.image || spec.image === image)
      : !spec.build && spec.image === image, 'Unexpected image or build context for ' + service);
    const ports = (spec.ports ?? []).map(port =>
      ({ host: port.host_ip, port: port.published, target: port.target, protocol: port.protocol }));
    same(ports, bindings[service], 'Unexpected published ports for ' + service);
    same(Object.keys(spec.networks ?? {}).sort(), ['default'], 'Unexpected network for ' + service);
    const dep = { app: 'db', candidate: 'db', nginx: 'app' }[service];
    same(Object.keys(spec.depends_on ?? {}), dep ? [dep] : [], 'Unexpected dependencies for ' + service);
    if (dep) check(spec.depends_on[dep].condition === 'service_healthy' &&
      spec.depends_on[dep].required === true, 'Unexpected dependency conditions for ' + service);
    same(spec.profiles ?? [], ['candidate', 'nginx'].includes(service) ? ['routing'] : [], 'Unexpected profile for ' + service);
    const expectedMount = { nginx: { type: 'bind', source: mountPath, target: '/etc/nginx/conf.d', readOnly: true },
      db: { type: 'volume', source: 'db-data', target: '/var/lib/postgresql/data', readOnly: false } }[service];
    const mounts = (spec.volumes ?? []).map(mount =>
      ({ type: mount.type, source: mount.source, target: mount.target, readOnly: Boolean(mount.read_only) }));
    same(mounts, expectedMount ? [expectedMount] : [], 'Unexpected Compose mounts for ' + service);
    if (service === 'nginx') check(spec.volumes[0].bind?.create_host_path === false, 'Nginx mount must use the existing runtime directory');
    const environment = spec.environment ?? {};
    const dbKeys = service === 'db' ? ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB']
      : ['PGUSER', 'PGPASSWORD', 'PGDATABASE'];
    if (service !== 'nginx') check(dbKeys.every(key => typeof environment[key] === 'string' &&
      environment[key].length > 0), 'Missing database environment for ' + service);
    const app = expectedBuild ? {
      version: service === 'app' ? '1.0.0' : '2.0.0',
      ...(service === 'candidate' && { faultPath: '/tmp/health-aware-workload-fault' })
    } : null;
    if (app) check(environment.APP_VERSION === app.version && environment.PGHOST === 'db' &&
      environment.PGPORT === '5432' && environment.ERROR_EVERY_N_REQUESTS === '0' &&
      environment.RESPONSE_DELAY_MS === '0' && (app.faultPath ?? undefined) === environment.WORKLOAD_FAULT_FILE,
    'Unexpected application settings for ' + service);
    const healthcheck = service === 'db' ? { test: ['CMD-SHELL', 'pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}'],
      interval: '5s', timeout: '3s', retries: 5, start_period: '10s' } : null;
    same(spec.healthcheck ?? null, healthcheck, 'Unexpected Compose health check for ' + service);
    const envKeys = app ? [...dbKeys, 'APP_VERSION', 'PGHOST', 'PGPORT', 'ERROR_EVERY_N_REQUESTS',
      'RESPONSE_DELAY_MS', ...(app.faultPath ? ['WORKLOAD_FAULT_FILE'] : [])] : service === 'db' ? dbKeys : [];
    same(Object.keys(environment).sort(), envKeys.sort(), 'Unexpected Compose environment keys for ' + service);
    return [service, { image, buildContext: expectedBuild ? source : null, ports, mounts, dependency: dep ?? null,
      profiles: spec.profiles ?? [], app, healthcheck }];
  });
  return { schema: 's1-rehearsal-compose/v1', project, composeFiles, profile: 'routing', network, volume,
    services: Object.fromEntries(entries) };
}

export async function observeRehearsalEnvironment({
  root = repo, env = process.env, host = hostname(), kernel = release(), command = executeCommand
} = {}) {
  const call = async (file, args) => {
    try { return (await command(file, args, { cwd: root, env })).trim(); }
    catch { throw new Error('Read-only dependency or metadata command failed: ' + file + ' ' + args[0]); }
  };
  const json = async (file, args) => {
    try { return JSON.parse(await call(file, args)); }
    catch { throw new Error('Could not read valid metadata: ' + file + ' ' + args[0]); }
  };
  const gitRevision = await call('git', ['rev-parse', 'HEAD']);
  check(/^[a-f0-9]{40}$/.test(gitRevision) &&
    await call('git', ['branch', '--show-current']) === 'workflow-comparison' &&
    await call('git', ['status', '--porcelain', '--untracked-files=all']) === '', 'Expected a clean workflow-comparison checkout');
  check(/microsoft/i.test(kernel) && /^[a-zA-Z0-9._-]+$/.test(host), 'Expected an identified WSL host');
  check(env.COMPOSE_PROJECT_NAME === project && env.DEPLOYMENT_PROXY_URL === proxyUrl &&
    env.COMPOSE_FILE === composeFiles.map(file => resolve(root, file)).join(':') && !env.COMPOSE_PATH_SEPARATOR,
  'Select the documented comparison Compose environment');
  const compose = ['compose', '--profile', 'routing'];
  const toolVersion = async (file, args, pattern) => {
    const result = (await call(file, args)).match(pattern);
    check(result, 'Missing tool version: ' + file);
    return result[1];
  };
  const version = /^(v?\d+\.\d+(?:\.\d+)?(?:[-+][a-zA-Z0-9.+-]+)?)$/;
  const tools = { node: process.version,
    docker: await toolVersion('docker', ['version', '--format', '{{.Server.Version}}'], version),
    compose: await toolVersion('docker', ['compose', 'version', '--short'], version),
    flock: await toolVersion('flock', ['--version'], /^flock (?:from util-linux|\(util-linux\)) (\d+\.\d+(?:\.\d+)?)$/) };
  const model = await json('docker', [...compose, 'config', '--format', 'json']);
  const snapshot = composeSummary(model, root);
  const ids = (await call('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project])).split(/\s+/);
  check(ids.length === services.length && new Set(ids).size === ids.length &&
    ids.every(id => /^[a-f0-9]{12,64}$/.test(id)), 'Expected exactly four comparison containers');
  const containers = await json('docker', ['container', 'inspect', ...ids]);
  const [bridge] = await json('docker', ['network', 'inspect', network]);
  const [data] = await json('docker', ['volume', 'inspect', volume]);
  check(bridge?.Name === network && /^[a-f0-9]{64}$/.test(bridge.Id) &&
    bridge.Driver === 'bridge' && bridge.Labels?.['com.docker.compose.project'] === project &&
    data?.Name === volume && data.Driver === 'local' && data.Labels?.['com.docker.compose.project'] === project &&
    data.Labels?.['com.docker.compose.volume'] === 'db-data' && typeof data.Mountpoint === 'string' &&
    data.Mountpoint.endsWith('/' + volume + '/_data') && Number.isFinite(Date.parse(data.CreatedAt)), 'Comparison network or database volume is unverified');
  check(Array.isArray(containers) && containers.length === services.length, 'Incomplete comparison container metadata');
  const observed = {};
  for (const service of services) {
    const [container, ...duplicates] = containers.filter(item => item.Config?.Labels?.['com.docker.compose.service'] === service);
    const expected = snapshot.services[service];
    check(container && !duplicates.length && /^[a-f0-9]{64}$/.test(container.Id) &&
      dockerId.test(container.Image) && container.Config.Labels['com.docker.compose.project'] === project &&
      container.State?.Running === true && (service === 'nginx' || container.State.Health?.Status === 'healthy'),
    'Comparison container missing or unhealthy: ' + service);
    const [image] = await json('docker', ['image', 'inspect', expected.image]);
    check(image?.Id === container.Image, 'Running image differs from the local comparison reference: ' + service);
    const ports = Object.entries(container.NetworkSettings?.Ports ?? {}).flatMap(([target, list]) =>
      (list ?? []).map(binding => ({ host: binding.HostIp, port: binding.HostPort,
        target: Number(target.split('/')[0]), protocol: target.split('/')[1] })));
    same(ports, expected.ports, 'Running port binding differs: ' + service);
    const attached = container.NetworkSettings?.Networks ?? {};
    same(Object.keys(attached), [network], 'Unexpected container network: ' + service);
    check(attached[network].NetworkID === bridge.Id, 'Network identity differs: ' + service);
    const mounts = container.Mounts?.map(mount =>
      ({ type: mount.Type, source: mount.Type === 'volume' ? mount.Name : mount.Source, target: mount.Destination,
        readOnly: mount.RW === false }));
    same(mounts, expected.mounts.map(mount => ({ ...mount,
      source: mount.type === 'volume' ? volume : mount.source })), 'Running mounts differ: ' + service);
    if (service === 'db') check(container.Mounts[0].Source === data.Mountpoint, 'Database volume mount point differs');
    const actualEnv = Object.fromEntries((container.Config.Env ?? []).map(item => {
      const index = item.indexOf('=');
      return [item.slice(0, index), item.slice(index + 1)];
    }));
    check(Object.entries(model.services[service].environment ?? {}).every(([key, value]) =>
      typeof value === 'string' && actualEnv[key] === value), 'Effective environment differs: ' + service);
    observed[service] = { containerId: container.Id, imageId: container.Image };
  }
  check(await call('docker', [...compose, 'port', 'nginx', '80']) === '127.0.0.1:18080', 'Comparison proxy binding differs');
  const stablePath = join(root, 'runtime/nginx/conf.d/default.conf');
  const stable = await readFile(stablePath);
  check(stable.equals(await readFile(join(root, 'infra/nginx/conf.d/default.conf'))), 'Runtime config differs from the stable template');
  const route = JSON.parse(await readFile(join(root, 'deployments/active-deployment.json'), 'utf8'));
  check(route.deployment_id === null && route.pending_deployment_id === null, 'Routing ownership is not clear');
  const configBytes = canonical(snapshot);
  const facts = { schema: 's1-rehearsal-environment/v1', gitRevision, host, kernel, tools, project, proxyUrl, composeFiles,
    composeConfigSha256: sha256(configBytes), stableConfigSha256: sha256(stable),
    network: { name: network, id: bridge.Id, driver: bridge.Driver },
    volume: { name: volume, driver: data.Driver, mountpoint: data.Mountpoint,
      createdAt: new Date(data.CreatedAt).toISOString() }, services: observed };
  return { gitRevision, configBytes, facts, frozen: {
    project, proxyUrl, host, composeConfigSha256: facts.composeConfigSha256, stableConfigSha256: facts.stableConfigSha256,
    environmentFingerprint: sha256(canonical(facts)), composeConfigRef, preflightRef,
    // WP4's field name is historical. These are Docker Engine image IDs.
    imageDigests: Object.fromEntries(services.map(service => [service, observed[service].imageId]))
  } };
}

export async function launchS1Rehearsal({ action, sessionId, gitRevision, fingerprint, authorizeS1H }, {
  root = repo, observe = () => observeRehearsalEnvironment({ root }),
  initialize = initializeCollection, open = openCollection
} = {}) {
  check(['check', 'execute'].includes(action) && /^[a-z0-9][a-z0-9-]{0,63}$/.test(sessionId ?? '') &&
    /^[a-f0-9]{40}$/.test(gitRevision ?? ''), 'Require an action, session ID and full expected Git revision');
  check(action === 'execute' ? authorizeS1H === true && hex.test(fingerprint ?? '') : !authorizeS1H && !fingerprint,
    'Execution requires --authorize-s1-h and the reviewed --fingerprint');
  const results = join(root, 'experiments/results');
  check(await realpath(results) === resolve(results), 'Results parent must be the repository results directory');
  const directory = join(results, 'rehearsal-' + sessionId);
  check(!await exists(directory), 'Rehearsal session directory already exists');
  const observed = await observe();
  check(observed.gitRevision === gitRevision, 'Observed Git revision differs from the expected revision');
  const manifest = generateRehearsalManifest({ sessionId, gitRevision, frozen: observed.frozen,
    arms: [{ scenario: 'S1', arm: 'H' }] });
  if (action === 'check') return { action, directory, manifest, facts: observed.facts };
  check(observed.frozen.environmentFingerprint === fingerprint, 'Environment differs from the reviewed check fingerprint');
  const verifyEnvironment = async expected => {
    const fresh = await observe();
    check(fresh.gitRevision === expected.gitRevision && isDeepStrictEqual(fresh.frozen, expected.frozen),
      'Environment changed before trial admission');
    for (const [file, bytes] of [[composeConfigRef, fresh.configBytes], [preflightRef, canonical(observed.facts)]]) {
      check(await readFile(join(directory, file), 'utf8') === bytes, 'Rehearsal provenance reference differs: ' + file);
    }
    return { gitRevision: fresh.gitRevision, frozen: fresh.frozen };
  };
  await initialize(directory, manifest, { mode: 'rehearsal' });
  await writeFile(join(directory, composeConfigRef), observed.configBytes, { flag: 'wx', mode: 0o600, flush: true });
  await writeFile(join(directory, preflightRef), canonical(observed.facts), { flag: 'wx', mode: 0o600, flush: true });
  const collection = open(directory, { expectedMode: 'rehearsal', verifyEnvironment });
  const outcome = await collection.runNext();
  const { status } = collection.inspect();
  return { action, directory, trialId: manifest.arms[0].trialId, event: outcome.type, status };
}

if (import.meta.main) {
  try {
    const { positionals, values } = parseArgs({ allowPositionals: true, options: {
      session: { type: 'string' }, 'git-revision': { type: 'string' },
      fingerprint: { type: 'string' }, 'authorize-s1-h': { type: 'boolean' }
    } });
    check(positionals.length === 1, 'Usage: run-s1-rehearsal.mjs check|execute --session ID --git-revision SHA');
    const result = await launchS1Rehearsal({ action: positionals[0], sessionId: values.session,
      gitRevision: values['git-revision'], fingerprint: values.fingerprint, authorizeS1H: values['authorize-s1-h'] });
    console.log(JSON.stringify(result, null, 2));
    if (result.action === 'execute' && result.status !== 'collection_complete') process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
