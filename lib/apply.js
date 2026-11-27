// Privileged half of the review update. Reads the artifact the capture
// action produced and moves the assignee. See the README for the rules
// and for why the artifact is not trusted.

const fs = require('fs');
const loadCourt = require('./court.js');

const courtMovingStates = ['approved', 'changes_requested', 'commented'];

const stateOf = (review) => (review.state || '').toLowerCase();

// The most recent court-moving review by `login`, or null when there is
// none. Reviews are listed oldest first.
function latestReview(reviews, login, eq) {
  return reviews.findLast(r =>
    r.user && eq(r.user.login, login) &&
    courtMovingStates.includes(stateOf(r))) ?? null;
}

module.exports = async function ({ github, context, core, reviewFile }) {
  const court = await loadCourt({ github, context, core });
  const { owner, repo } = context.repo;

  // The artifact comes from a fork-triggered run. Treat it as untrusted
  // and validate every field before use.
  let raw;
  try {
    if (!fs.lstatSync(reviewFile).isFile()) {
      throw new Error(`${reviewFile} is not a regular file`);
    }
    raw = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
    if (raw === null || typeof raw !== 'object') {
      throw new Error('it is not a JSON object');
    }
  } catch (e) {
    core.warning(`Could not read captured review data, ${e.message}`);
    return;
  }
  const prNumber = Number(raw.pr_number);
  const state = String(raw.review_state || '').toLowerCase();
  const claimedSubmitter = String(raw.submitter || '');
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    core.warning('Captured pr_number is not a positive integer, ignoring.');
    return;
  }
  // A capture pinned to an earlier commit of the action records no
  // review id. Its artifact is still applied, with the state check below
  // as the only test of which review it is for.
  const reviewId = raw.review_id ?? null;
  if (reviewId !== null && (!Number.isInteger(reviewId) || reviewId <= 0)) {
    core.warning('Captured review_id is not a positive integer, ignoring.');
    return;
  }
  // core.info writes to the job log unescaped, where a line starting with
  // "::" is a workflow command. Artifact values that have not yet been
  // matched against a trusted value are logged JSON-encoded, which keeps
  // them on one line and off the start of it.
  if (!courtMovingStates.includes(state)) {
    core.info(`Review state ${JSON.stringify(state)} does not change the court, nothing to do.`);
    return;
  }

  // Re-fetch the PR so we act on its current author and assignees.
  const { data: pr } = await github.rest.pulls.get({
    owner, repo, pull_number: prNumber,
  });
  const author = pr.user.login;

  // Bind the artifact to the PR that triggered the capture run.
  // pull_request_review runs the PR's own copy of the capture workflow,
  // so a fork can ship a modified capture that uploads an arbitrary
  // pr_number, and the field validation above only checks it is a
  // positive integer. Requiring the re-fetched PR's head to equal the
  // triggering run's head SHA limits any forged artifact to the
  // attacker's own PR (whose head is the only one that can match),
  // rather than letting it act on a victim PR. A legitimate apply that
  // races a fresh push is skipped and reconciles on the next event.
  if (pr.head.sha !== context.payload.workflow_run.head_sha) {
    core.info(`PR #${prNumber} head does not match the capture run head, ignoring (forged or stale artifact).`);
    return;
  }

  // Bot-authored PRs (for example Dependabot) do not take part in the
  // rotation.
  if (court.isBot(pr.user)) {
    core.info(`PR #${prNumber} authored by bot ${author}, skipping.`);
    return;
  }

  // The apply is asynchronous, so the PR may have closed in between.
  if (pr.state !== 'open') {
    core.info(`PR #${prNumber} is ${pr.state}, leaving court unchanged.`);
    return;
  }

  // Drafts take no part in the rotation. A review can land on a draft,
  // and the PR can go back to draft while the apply is queued.
  if (pr.draft) {
    core.info(`PR #${prNumber} is a draft, skipping.`);
    return;
  }

  // Reviews drive the court only when submitted by a pool member or by
  // the PR author (inline replies create an implicit "commented" review).
  if (!court.inPool(claimedSubmitter) && !court.eq(claimedSubmitter, author)) {
    core.info(`Review by ${JSON.stringify(claimedSubmitter)} is not from a flow participant, leaving court unchanged.`);
    return;
  }

  // Confirm the claimed review is the submitter's current one. The
  // capture is fork-modifiable, so without this a forged artifact could
  // fabricate a pool member's review on the attacker's own PR. Applies
  // can also finish out of order, and an older review by the same
  // submitter must not undo the newer one. Skipping it loses nothing,
  // since the newer review has its own apply. The state alone cannot
  // tell two reviews in the same state apart, hence the id.
  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    owner, repo, pull_number: prNumber, per_page: 100,
  });
  const review = latestReview(reviews, claimedSubmitter, court.eq);
  if (review === null || stateOf(review) !== state) {
    core.info(`The latest review by ${JSON.stringify(claimedSubmitter)} on PR #${prNumber} is not ${state}, ignoring (forged or stale artifact).`);
    return;
  }
  if (reviewId !== null && review.id !== reviewId) {
    core.info(`Review ${reviewId} is not the latest by ${review.user.login} on PR #${prNumber}, ignoring (forged or stale artifact).`);
    return;
  }
  // From here on the login is the one the API reports, so the artifact's
  // spelling of it is never assigned.
  const submitter = review.user.login;

  // The author reviewed their own PR. GitHub only allows "commented"
  // self-reviews, and they mostly carry inline replies to review
  // threads, so hand the ball back to the pool member who reviewed most
  // recently, mirroring the push and conversation-comment handlers in
  // assign.js. Like there, the flip only happens while the author holds
  // the ball, so manual assignee changes are never overridden.
  if (court.eq(submitter, author)) {
    if (state !== 'commented') {
      core.info(`Unexpected ${state} self-review on PR #${prNumber}, leaving court unchanged.`);
      return;
    }
    const holder = court.courtHolder(pr);
    if (holder === null || !court.eq(holder, author)) {
      core.info(`Author does not hold the ball on PR #${prNumber}, leaving court unchanged.`);
      return;
    }
    const reviewer = await court.lastPoolReviewer(pr, reviews);
    if (reviewer === null) {
      core.info(`No pool member has reviewed PR #${prNumber} yet, leaving court unchanged.`);
      return;
    }
    await court.setCourt(pr, reviewer);
    return;
  }

  // A pool member reviewed. Approve keeps the reviewer assigned (a
  // maintainer merges), otherwise the author owns it.
  const target = state === 'approved' ? submitter : author;
  await court.setCourt(pr, target);
};
