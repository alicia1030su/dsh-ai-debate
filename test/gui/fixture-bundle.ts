/**
 * Emit the fixture bundle the preload reads.
 *
 * Kept separate from the browser script so the data can be regenerated without a
 * browser, and so the bundle is a plain JSON file a reader can inspect.
 */

import { writeFileSync } from 'node:fs'

import {
  commentPageJson,
  FLOORS,
  NESTED,
  PICKED_NESTED_POST_ID,
  totalCommentJson,
  wapPageHtml,
} from '../support/fixture-discussion.ts'

const out = process.argv[2]
if (out === undefined || out === '') {
  console.error('用法: fixture-bundle.ts <输出路径>')
  process.exit(1)
}

// One comment page per floor that has replies.
const commentPage: Record<string, string> = {}
for (const floor of FLOORS) {
  if ((floor.nestedCount ?? 0) === 0) continue
  commentPage[floor.postId] = commentPageJson(floor.postId)
}

// The picked reply's page is served twice, and the two reads disagree about its
// author — that is the comparable conflict the analysis must catch. Serving the
// conflicting variant here would make *every* read a conflict, so only the dedicated
// conflict scenario uses it; this bundle ships the agreeing variant.
void PICKED_NESTED_POST_ID
void NESTED

writeFileSync(
  out,
  JSON.stringify(
    {
      wapPage: wapPageHtml(1),
      totalComment: totalCommentJson(),
      commentPage,
    },
    null,
    2,
  ),
  'utf8',
)

console.log(`已写入 ${out}`)
