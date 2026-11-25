#!/usr/bin/env node
// Read-only admission and queue audit. GitHub resolves job selectors (including
// matrices and reusable workflows); do not attempt to interpret Actions YAML.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { isContributionOnly, isMaintainedRepo } from './fleet-scope.mjs';
import { decide } from '../policy-wasm/bridge.mjs';

const exec = promisify(execFile);
const active = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
// GitHub transport stays native. Policy runs once for the entire job batch,
// including hosted runner recognition and real registration/idle decisions.
export function classifyRunnerAvailability(requests, runners, mode = 'require', module) {
  const result = decide('runner-admission', {mode, requests, runners}, module);
  if (!Array.isArray(result) || result.length !== requests.length) {
    throw new Error('invalid shared WASM runner-admission response');
  }
  return result;
}

async function api(endpoint) {
  const { stdout } = await exec('gh', ['api', endpoint], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

export async function pages(endpoint, key, get = api) {
  const values = [];
  for (let page = 1; ; page++) {
    const payload = await get(endpoint + (endpoint.includes('?') ? '&' : '?') +
      'per_page=100&page=' + page);
    const batch = payload[key];
    if (!Array.isArray(batch)) throw new Error('Missing ' + key + ' in ' + endpoint);
    values.push(...batch);
    if (batch.length < 100) return values;
  }
}

async function concurrent(items, fn, limit = 6) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

export async function auditRepository(repo, get = api) {
  const endpoint = '/repos/' + repo + '/actions/';
  const runs = new Map();
  // Include in-progress workflows with queued jobs, and workflow states
  // that GitHub exposes separately from ordinary queued jobs.
  for (const state of active) {
    for (const run of await pages(endpoint + 'runs?status=' + state, 'workflow_runs', get))
      runs.set(run.id, run);
  }
  const expanded = await concurrent([...runs.values()], async run => ({
    run, jobs: await pages(endpoint + 'runs/' + run.id + '/jobs?filter=latest', 'jobs', get),
  }));
  const waiting = expanded.flatMap(({run, jobs}) => jobs
    .filter(job => ['queued', 'waiting', 'pending', 'requested'].includes(job.status))
    .map(job => ({ run: run.id, branch: run.head_branch, job: job.id, name: job.name,
      createdAt: job.created_at, labels: job.labels, status: job.status })));
  const requests = waiting.map(job => job.labels ?? []);
  // First classify against no private runner registrations. Only a custom
  // label needs an authenticated API request; hosted jobs use no runner API.
  const preliminary = classifyRunnerAvailability(requests, [], 'audit');
  const registrationsRequired = preliminary.some(result => result.status === 'unregistered');
  const decisions = registrationsRequired
    ? classifyRunnerAvailability(requests, await pages(endpoint + 'runners', 'runners', get), 'audit')
    : preliminary;
  return {
    repo, workflowRuns: runs.size,
    noJobs: expanded.filter(({jobs}) => !jobs.length).map(({run}) => run.id),
    waiting: waiting.map((job, index) => ({...job, availability: decisions[index]})),
  };
}

function repoName(value) {
  if (!/^codeandsolder\/[A-Za-z0-9_.-]+$/.test(value ?? ''))
    throw new Error('Expected codeandsolder/REPO');
  if (isContributionOnly(value)) throw new Error('Contribution-only fork: ' + value);
  return value;
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === 'require') {
    const [repo, ...labels] = rest;
    repoName(repo);
    const runners = await pages('/repos/' + repo + '/actions/runners', 'runners');
    const [result] = classifyRunnerAvailability([labels], runners);
    console.log(JSON.stringify({ repo, labels, ...result }));
    // Busy means eligible capacity exists; an offline-only pool does not.
    return ['available', 'busy'].includes(result.status) ? 0 : 1;
  }
  if (command === 'audit') {
    const repos = rest.length ? rest.map(repoName) :
      (await pages('/installation/repositories', 'repositories'))
        .filter(isMaintainedRepo)
        .map(repo => repo.full_name);
    const results = await concurrent(repos, async repo => {
      try { return await auditRepository(repo); }
      catch (error) { return { repo, error: error.message }; }
    });
    const outcomes = {};
    for (const entry of results) for (const job of entry.waiting ?? [])
      outcomes[job.availability.status] = (outcomes[job.availability.status] ?? 0) + 1;
    console.log(JSON.stringify({ at: new Date().toISOString(), outcomes, results }, null, 2));
    return results.some(entry => entry.error) || outcomes.unregistered || outcomes.offline ? 1 : 0;
  }
  console.error('Usage: runner-availability.mjs require codeandsolder/REPO LABEL...\n' +
    '       runner-availability.mjs audit [codeandsolder/REPO...]');
  return 64;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
