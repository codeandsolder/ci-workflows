import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRunnerAvailability, pages, auditRepository } from './runner-availability.mjs';

const runner = (name, status, busy, labels) => ({
  name, status, busy, labels: labels.map(name => ({name})),
});
const local = ['self-hosted', 'Linux', 'X64', 'local-ci'];
const modulePath = process.argv[2];
const admission = (requests, runners, mode = 'require') =>
  classifyRunnerAvailability(requests, runners, mode, modulePath);
test('admission distinguishes unregistered, offline, busy and available', () => {
  const acer = runner('acer', 'online', true, [...local, 'acer']);
  const asus = runner('asus', 'online', false, [...local, 'asus']);
  assert.equal(admission([local], [])[0].status, 'unregistered');
  assert.equal(admission([local], [{...acer, status:'offline'}])[0].status, 'offline');
  assert.equal(admission([local], [acer])[0].status, 'busy');
  assert.equal(admission([local.map(x => x.toUpperCase())], [acer,asus])[0].status, 'available');
  assert.equal(admission([[...local, 'acer']], [asus])[0].status, 'unregistered');
  assert.throws(() => admission([[]], [acer]));
});
test('pagination does not silently ignore a second page', async () => {
  const value = await pages('/fake', 'runners', async path => ({runners:
    path.endsWith('page=1') ? Array.from({length:100}, (_, i)=>i) : [100]}));
  assert.equal(value.length, 101);
  await assert.rejects(pages('/fake', 'runners', async () => ({})), /Missing runners/);
});
test('uses GitHub-resolved labels and inspects jobs in running workflow', async () => {
  const get = async path => {
    if (path.includes('runs?status=')) return {workflow_runs:
      /status=(queued|in_progress)&/.test(path) ? [{id:42, head_branch:'main'}] : []};
    if (path.includes('runs/42/jobs')) return {jobs:[
      {id:1, status:'queued', labels:[...local,'missing'],name:'matrix'},
      {id:2, status:'queued', labels:['ubuntu-26.04'],name:'public'},
      {id:3, status:'queued', labels:[],name:'not resolved'},
      {id:4, status:'in_progress', labels:local,name:'running'},
      {id:5, status:'queued', labels:['benchmark','X64'], name:'custom-only'},
    ]};
    if (path.includes('/runners?')) return {runners:[runner('acer','online',false,local)]};
    throw Error(path);
  };
  const result = await auditRepository('codeandsolder/example', get);
  assert.equal(result.workflowRuns, 1);
  assert.deepEqual(result.waiting.map(job => job.availability.status),
    ['unregistered','not-self-hosted','unresolved','unregistered']);
});

test('contribution-only forks are excluded from maintained fleet scope', async () => {
  const { isContributionOnly, isMaintainedRepo } = await import('./fleet-scope.mjs');
  for (const name of ['Anubis', 'hayro', 'oxc']) {
    assert.equal(isContributionOnly('codeandsolder/' + name), true);
    assert.equal(isMaintainedRepo({full_name:'codeandsolder/' + name}), false);
  }
  assert.equal(isMaintainedRepo({full_name:'codeandsolder/ngspice', fork:true}), true);
  assert.equal(isMaintainedRepo({full_name:'codeandsolder/archived', archived:true}), false);
  assert.equal(isMaintainedRepo({full_name:'elsewhere/example'}), false);
});

test('one WASM batch agrees with independent JavaScript admission oracle', () => {
  // Keep this oracle independent of the Rust implementation: it verifies the
  // original GitHub label and runner-state semantics across mixed selectors.
  const jsDecision = (labels, runners) => {
    const required = new Set(labels.map(label => label.toLowerCase()));
    const matches = runners.filter(runner => {
      const actual = new Set(runner.labels.map(label => label.name.toLowerCase()));
      return [...required].every(label => actual.has(label));
    });
    const online = matches.filter(runner => runner.status === 'online');
    const idle = online.filter(runner => runner.busy === false);
    return {
      status: !matches.length ? 'unregistered' : !online.length ? 'offline' :
        !idle.length ? 'busy' : 'available',
      matching: matches.map(runner => runner.name),
      online: online.map(runner => runner.name),
      idle: idle.map(runner => runner.name),
    };
  };
  const runners = [
    runner('acer', 'online', false, ['self-hosted','Linux','X64','local-ci','acer']),
    runner('asus', 'online', true, ['self-hosted','Linux','X64','local-ci','asus']),
    runner('wyse', 'offline', false, ['self-hosted','Linux','X64','local-ci','wyse']),
    runner('windows', 'online', true, ['self-hosted','Windows','X64','ci']),
    runner('bench', 'online', false, ['benchmark','X64']),
  ];
  const selectors = [
    ['self-hosted'], ['Linux'], ['X64'], ['local-ci'], ['self-hosted','Linux'],
    ['self-hosted','X64'], ['Linux','X64'], ['local-ci','X64'],
    ['benchmark'], ['Windows'], ['ci'], ['acer'], ['asus'], ['wyse'],
    ['unknown'], ['self-hosted','Linux','local-ci','asus'],
    ['local-CI','x64'], ['BENCHMARK','x64'], ['self-hosted','X64','wyse'],
  ];
  // Hundreds of cases are checked with a single WASM entry, not one spawn
  // and module compile per case.
  const requests = [...selectors];
  for (const first of selectors) {
    for (const second of selectors) {
      if (requests.length >= 300) break;
      requests.push([...new Set([...first,...second])]);
    }
    if (requests.length >= 300) break;
  }
  assert.deepEqual(admission(requests, runners), requests.map(labels => jsDecision(labels, runners)));
});

test('hosted jobs do not require private runner API access', async () => {
  let runnerLookups = 0;
  const get = async endpoint => {
    if (endpoint.includes('runs?status=')) {
      return {workflow_runs: endpoint.includes('status=queued') ?
        [{id:19,head_branch:'main'}] : []};
    }
    if (endpoint.includes('runs/19/jobs')) {
      return {jobs:[
        {id:1,name:'github linux',status:'queued',labels:['ubuntu-latest']},
        {id:2,name:'github macOS',status:'queued',labels:['macos-15']},
        {id:3,name:'unresolved',status:'queued',labels:[]},
        {id:4,name:'github win',status:'queued',labels:['windows-2025']},
      ]};
    }
    if (endpoint.includes('/runners?')) {
      runnerLookups++;
      throw new Error('private runner API must not be used for GitHub-hosted labels');
    }
    throw new Error('unexpected API endpoint: ' + endpoint);
  };
  const result = await auditRepository('codeandsolder/example', get);
  assert.equal(runnerLookups, 0);
  assert.deepEqual(result.waiting.map(job => job.availability.status),
    ['not-self-hosted','not-self-hosted','unresolved','not-self-hosted']);
});

test('WASI accepts only valid labels, modes and runner API structures', () => {
  assert.throws(() => admission([[null]], [], 'require'));
  assert.throws(() => admission([['  ']], [], 'require'));
  assert.throws(() => admission([local], [{name:'x',status:'online',busy:'false',labels:[]}]));
  assert.throws(() => admission([local], [], 'not-a-mode'));
  assert.equal(admission([[]], [], 'audit')[0].status, 'unresolved');
});
