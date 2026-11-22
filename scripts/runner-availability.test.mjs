import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRunnerAvailability, pages, auditRepository } from './runner-availability.mjs';

const runner = (name, status, busy, labels) => ({
  name, status, busy, labels: labels.map(name => ({name})),
});
const local = ['self-hosted', 'Linux', 'X64', 'local-ci'];
test('admission distinguishes unregistered, offline, busy and available', () => {
  const acer = runner('acer', 'online', true, [...local, 'acer']);
  const asus = runner('asus', 'online', false, [...local, 'asus']);
  assert.equal(classifyRunnerAvailability(local, []).status, 'unregistered');
  assert.equal(classifyRunnerAvailability(local, [{...acer, status:'offline'}]).status, 'offline');
  assert.equal(classifyRunnerAvailability(local, [acer]).status, 'busy');
  assert.equal(classifyRunnerAvailability(local.map(x => x.toUpperCase()), [acer,asus]).status, 'available');
  assert.equal(classifyRunnerAvailability([...local, 'acer'], [asus]).status, 'unregistered');
  assert.throws(() => classifyRunnerAvailability([], [acer]));
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
