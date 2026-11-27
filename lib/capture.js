// Unprivileged half of the review update. Writes the review event data
// the apply action needs into `dir`/review.json, for upload as an
// artifact. It never calls the API.

const fs = require('fs');
const path = require('path');

module.exports = function ({ context, core, dir }) {
  const review = context.payload.review;
  const data = {
    pr_number: context.payload.pull_request.number,
    review_id: review.id,
    review_state: (review.state || '').toLowerCase(),
    submitter: review.user.login,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify(data));
  core.info(`Captured ${data.review_state} review by ${data.submitter} on PR #${data.pr_number}.`);
};
