/**
 * Which post the reply actually lands on.
 *
 * ## The bug v0.2.25 fixes
 *
 * v0.2.24 let the owner pick a comment. It used that pick to choose *whose argument*
 * to analyse, then published to `dispute.opponent.lastPostId` — that person's newest
 * post. So the page said "用这条" and the reply went somewhere else. Nothing failed;
 * the target just moved.
 *
 * This file pins the distinction the code must keep:
 *
 * - `selectedTargetPostId` — what the owner clicked.
 * - `publishTargetPostId` — where the reply is addressed.
 * - the author check — who is on the other end of *that* post.
 *
 * The platform can do it: `publishReply` sends `comment_id` for a nested reply and
 * `reply_id` for a floor. So a mismatch here is ours, not the platform's.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// `new URL(...).pathname` yields `/C:/...` on Windows, which `join` then turns into
// `C://C://...`. `fileURLToPath` is the only form that works on both platforms.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

function runtimeSource(): string {
  return readFileSync(join(SRC, 'runtime.ts'), 'utf8')
}

test('选中的评论就是发表目标，不再回退到作者最新发言', () => {
  const source = runtimeSource()
  // The one expression that decides where the reply lands.
  assert.match(
    source,
    /const publishTargetPostId = selected\?\.postId \?\? dispute\.opponent\?\.lastPostId/,
    '有选中时必须用选中那条；没有选中才回退到对手最新发言',
  )
  // And the target expectation must be built from it, not recomputed from the dispute.
  const expectationBlock = source.slice(
    source.indexOf('const targetExpectation: TargetExpectation'),
    source.indexOf('if (!targetExpectation.targetPostId)'),
  )
  assert.match(
    expectationBlock,
    /targetPostId: publishTargetPostId/,
    '目标期望必须引用同一个变量，否则两处会漂移',
  )
  assert.doesNotMatch(
    expectationBlock,
    /targetPostId: dispute\.opponent\?\.lastPostId/,
    '不得在期望里重新写回对手最新发言',
  )
})

test('父楼层跟着选中的评论走', () => {
  const source = runtimeSource()
  // A nested reply must attach under its own floor. Using the dispute's floor for a
  // pick from another floor would post the reply under the wrong floor.
  assert.match(
    source,
    /floorPostId: selected\?\.parentPostId \?\? dispute\.floorPostId/,
    '楼中楼必须挂在自己的父楼层下',
  )
})

test('目标作者取自被回复的那条评论，而不是同名的另一个人', () => {
  const source = runtimeSource()
  assert.match(
    source,
    /selected\?\.authorNumericUid !== undefined/,
    '选中的评论若带数字账号，必须用它做作者校验',
  )
})

test('安全校验与发表共用同一个目标 id', () => {
  const source = runtimeSource()
  // Two different ids here would mean "the gate checked A, we posted to B" — the
  // exact class of bug this version exists to remove.
  assert.match(source, /const verifiedTargetPostId = publishTargetPostId/, '必须是同一个值')
  assert.match(source, /targetPostId: verifiedTargetPostId/, '候选带上它')
  assert.match(source, /expectedTargetPostId: verifiedTargetPostId/, '安全闸门用它做期望')
})

test('平台确实支持精确回复：楼中楼用 comment_id，楼层用 reply_id', () => {
  const adapter = readFileSync(join(SRC, 'platforms/tieba/adapter.ts'), 'utf8')
  assert.match(adapter, /form\.comment_id = target\.nestedReplyId/, '楼中楼必须带 comment_id')
  assert.match(adapter, /form\.reply_id = target\.floorPostId/, '楼层/Schema 必须带 reply_id')
  // If this ever becomes false, "precise target" stops being possible and the UI must
  // say so instead of silently posting elsewhere.
})

test('选中了这次读取里不存在的评论时，不猜位置', () => {
  const source = runtimeSource()
  // `selectedComment` returns undefined for an unknown id, which falls back to the
  // opponent's latest — but `runGeneration` refuses an id outside the stored list
  // before that, so the fallback cannot be reached by a stale pick.
  assert.match(
    source,
    /目标评论 \$\{requestedTarget\} 不在这次读取到的评论里/,
    '未知目标必须报错，不能默默换一条',
  )
})
