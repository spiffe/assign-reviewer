const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const apply = require('../lib/apply.js');
const capture = require('../lib/capture.js');
const { fakeGithub, fakeCore, pullRequest, assigneesOf, repo } = require('./fake_github.js');

const pool = ['alice', 'bob', 'carol'];
const review = (login, state, id) => ({ id, user: { login }, state });
const context = { repo, payload: { workflow_run: { head_sha: 'head-sha' } } };

function writeArtifact(t, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assign-reviewer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'review.json');
  fs.writeFileSync(file, contents);
  return file;
}

test('apply', async (t) => {
  const artifact = (submitter, review_state, pr_number = 1, review_id = undefined) =>
    JSON.stringify({ pr_number, review_id, review_state, submitter });
  const tests = [
    {
      name: 'approval moves the ball to the reviewer',
      pr: { assignees: ['contributor'] }, reviews: [review('bob', 'APPROVED')],
      artifact: artifact('bob', 'approved'),
      want: ['bob'],
    },
    {
      name: 'changes requested moves the ball to the author',
      pr: { assignees: ['bob'] }, reviews: [review('bob', 'CHANGES_REQUESTED')],
      artifact: artifact('bob', 'changes_requested'),
      want: ['contributor'],
    },
    {
      name: 'a comment review moves the ball to the author',
      pr: { assignees: ['bob'] }, reviews: [review('bob', 'COMMENTED')],
      artifact: artifact('bob', 'commented'),
      want: ['contributor'],
    },
    {
      name: 'author replies return the ball to the last reviewer',
      pr: { assignees: ['contributor'] },
      reviews: [review('carol', 'COMMENTED'), review('contributor', 'COMMENTED')],
      artifact: artifact('contributor', 'commented'),
      want: ['carol'],
    },
    {
      name: 'author replies while a maintainer holds the ball change nothing',
      pr: { assignees: ['alice'] },
      reviews: [review('carol', 'COMMENTED'), review('contributor', 'COMMENTED')],
      artifact: artifact('contributor', 'commented'),
      want: ['alice'],
    },
    {
      name: 'a review that does not exist is ignored',
      pr: { assignees: ['contributor'] }, reviews: [review('bob', 'COMMENTED')],
      artifact: artifact('bob', 'approved'),
      want: ['contributor'],
    },
    {
      name: 'an older review does not undo a newer one by the same reviewer',
      pr: { assignees: ['bob'] },
      reviews: [review('bob', 'COMMENTED'), review('bob', 'APPROVED')],
      artifact: artifact('bob', 'commented'),
      want: ['bob'],
    },
    {
      name: 'an older review does not repeat its move after a newer one in the same state',
      pr: { assignees: ['bob'] },
      reviews: [review('bob', 'COMMENTED', 10), review('contributor', 'COMMENTED', 11), review('bob', 'COMMENTED', 12)],
      artifact: artifact('bob', 'commented', 1, 10),
      want: ['bob'],
    },
    {
      name: 'the latest of two reviews in the same state is applied',
      pr: { assignees: ['bob'] },
      reviews: [review('bob', 'COMMENTED', 10), review('bob', 'COMMENTED', 12)],
      artifact: artifact('bob', 'commented', 1, 12),
      want: ['contributor'],
    },
    {
      name: 'an artifact without a review id is matched by state alone',
      pr: { assignees: ['bob'] },
      reviews: [review('bob', 'COMMENTED', 10), review('bob', 'COMMENTED', 12)],
      artifact: artifact('bob', 'commented'),
      want: ['contributor'],
    },
    {
      name: 'a review id that is not an integer is ignored',
      pr: { assignees: ['bob'] }, reviews: [review('bob', 'COMMENTED', 10)],
      artifact: artifact('bob', 'commented', 1, '10'),
      want: ['bob'],
    },
    {
      name: 'a newer review by somebody else does not make a review stale',
      pr: { assignees: ['bob'] },
      reviews: [review('bob', 'CHANGES_REQUESTED'), review('carol', 'APPROVED')],
      artifact: artifact('bob', 'changes_requested'),
      want: ['contributor'],
    },
    {
      name: 'a dismissed review does not hide the one before it',
      pr: { assignees: ['bob'] },
      reviews: [review('bob', 'COMMENTED'), review('bob', 'DISMISSED')],
      artifact: artifact('bob', 'commented'),
      want: ['contributor'],
    },
    {
      name: 'a review by an outsider is ignored',
      pr: { assignees: ['bob'] }, reviews: [review('outsider', 'CHANGES_REQUESTED')],
      artifact: artifact('outsider', 'changes_requested'),
      want: ['bob'],
    },
    {
      name: 'an artifact for a pull request with another head is ignored',
      pr: { assignees: ['contributor'], head: { sha: 'other-sha' } },
      reviews: [review('bob', 'APPROVED')],
      artifact: artifact('bob', 'approved'),
      want: ['contributor'],
    },
    {
      name: 'a closed pull request is left alone',
      pr: { assignees: ['contributor'], state: 'closed' }, reviews: [review('bob', 'APPROVED')],
      artifact: artifact('bob', 'approved'),
      want: ['contributor'],
    },
    {
      name: 'a draft is left alone',
      pr: { assignees: ['contributor'], draft: true }, reviews: [review('bob', 'APPROVED')],
      artifact: artifact('bob', 'approved'),
      want: ['contributor'],
    },
    {
      name: 'a dismissed review state is ignored',
      pr: { assignees: ['bob'] }, reviews: [review('bob', 'DISMISSED')],
      artifact: artifact('bob', 'dismissed'),
      want: ['bob'],
    },
    {
      name: 'a pull request number that is not an integer is ignored',
      pr: { assignees: ['contributor'] }, reviews: [review('bob', 'APPROVED')],
      artifact: artifact('bob', 'approved', '1; rm -rf'),
      want: ['contributor'],
    },
    {
      name: 'the login is assigned as the API spells it',
      pr: { assignees: ['contributor'] }, reviews: [review('bob', 'APPROVED')],
      artifact: artifact('BOB', 'approved'),
      want: ['bob'],
    },
    {
      name: 'an artifact that is not an object is ignored',
      pr: { assignees: ['contributor'] }, reviews: [review('bob', 'APPROVED')],
      artifact: 'null',
      want: ['contributor'],
    },
    {
      name: 'malformed JSON is ignored',
      pr: { assignees: ['contributor'] }, reviews: [review('bob', 'APPROVED')],
      artifact: '{not json',
      want: ['contributor'],
    },
  ];
  for (const tt of tests) {
    await t.test(tt.name, async (t) => {
      const pr = pullRequest(tt.pr);
      const github = fakeGithub({ pool, prs: [pr], reviews: { 1: tt.reviews } });
      const reviewFile = writeArtifact(t, tt.artifact);
      await apply({ github, context, core: fakeCore(), reviewFile });
      assert.deepEqual(assigneesOf(pr), tt.want);
    });
  }
});

test('apply never logs raw line breaks from the artifact', async (t) => {
  // An unescaped line starting with "::" in the job log is a workflow
  // command, so artifact text must not be able to start a log line.
  const injected = 'x\n::add-mask::secret\r\n::error::forged';
  const tests = [
    { name: 'in the review state', artifact: { pr_number: 1, review_state: injected, submitter: 'bob' } },
    { name: 'in the submitter', artifact: { pr_number: 1, review_state: 'approved', submitter: injected } },
  ];
  for (const tt of tests) {
    await t.test(tt.name, async (t) => {
      const pr = pullRequest({ assignees: ['contributor'] });
      const github = fakeGithub({ pool, prs: [pr], reviews: { 1: [review('bob', 'APPROVED')] } });
      const core = fakeCore();
      const reviewFile = writeArtifact(t, JSON.stringify(tt.artifact));
      await apply({ github, context, core, reviewFile });
      assert.deepEqual(assigneesOf(pr), ['contributor']);
      assert.equal(core.infos.length, 1);
      assert.doesNotMatch(core.infos[0], /[\r\n]/);
    });
  }
});

test('apply ignores a missing artifact', async () => {
  const pr = pullRequest({ assignees: ['contributor'] });
  const github = fakeGithub({ pool, prs: [pr] });
  await apply({ github, context, core: fakeCore(), reviewFile: '/nonexistent/review.json' });
  assert.deepEqual(assigneesOf(pr), ['contributor']);
});

test('capture output is what apply reads', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assign-reviewer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  capture({
    context: {
      payload: {
        pull_request: { number: 1 },
        review: { id: 7, state: 'APPROVED', user: { login: 'bob' } },
      },
    },
    core: fakeCore(),
    dir,
  });

  const pr = pullRequest({ assignees: ['contributor'] });
  const reviews = [review('bob', 'APPROVED', 7)];
  const github = fakeGithub({ pool, prs: [pr], reviews: { 1: reviews } });
  await apply({ github, context, core: fakeCore(), reviewFile: path.join(dir, 'review.json') });
  assert.deepEqual(assigneesOf(pr), ['bob']);

  // The id reaches apply, which is what tells this review from a later
  // approval by the same reviewer.
  const later = pullRequest({ assignees: ['contributor'] });
  const withLater = fakeGithub({ pool, prs: [later], reviews: { 1: [...reviews, review('bob', 'APPROVED', 8)] } });
  await apply({ github: withLater, context, core: fakeCore(), reviewFile: path.join(dir, 'review.json') });
  assert.deepEqual(assigneesOf(later), ['contributor']);
});
