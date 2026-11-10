#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');

const workflow = fs.readFileSync('.github/workflows/rust-sccache.yml', 'utf8');
const setup = fs.readFileSync('.github/actions/setup-sccache/action.yml', 'utf8');
const finalize = fs.readFileSync('.github/actions/finalize-sccache/action.yml', 'utf8');

const selector = workflow.split('\n').find(line => line.trimStart().startsWith('runs-on:'));
assert.equal(
  selector.trim(),
  `runs-on: ${'\x24'}{{ github.event.repository.private && fromJSON('["self-hosted","Linux","X64"]') || inputs.runner }}`
);
assert.match(workflow, /default: "ubuntu-24\.04"/);
assert.match(setup, /if \[\[ "\$\{\{ github\.event\.repository\.private \}\}" == "true" \]\]/);
assert.match(setup, /mode=private-local-garage/);
assert.match(setup, /mode=public-actions/);
assert.match(setup, /\[\[ -x \/usr\/local\/libexec\/sccache-client \]\]/);
assert.match(setup, /\[\[ -S \/run\/host-sccache\/sccache\.sock && -x \/usr\/local\/bin\/sccache \]\]/);
assert.match(setup, /SCCACHE_START_SERVER=0 SCCACHE_NO_AUTO_START_SERVER=1/);
assert.doesNotMatch(setup, /RUNNER_NAME,,|SCCACHE_SERVER_PORT=4228|private-asus-garage/);
assert.match(finalize, /private-local-garage/);
assert.doesNotMatch(finalize, /private-asus-garage/);
console.log('Visibility policy: public -> hosted Ubuntu; private -> any registered Linux x64 self-hosted runner, managed Garage only');
