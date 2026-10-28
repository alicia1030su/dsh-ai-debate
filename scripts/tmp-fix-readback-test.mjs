/** Correct the readback test's expectation: unverified content is `published`, not `uncertain`. */
import fs from 'node:fs'

const path =
  'C:/Users/23866/Documents/deepseek-harness/default-workspace/dsh-ai-debate/test/readback-integrity.test.ts'

let text = fs.readFileSync(path, 'utf8')

const oldBlock = `    // No throw. Reaching this assertion at all is half the test.
    assert.equal(report.status, 'uncertain', \`应当是不确定，而不是崩溃或成功：\${report.message}\`)
    assert.equal(report.ok, false)
    assert.match(report.message, /无法核对|无法核实|没有正文/, report.message)
    assert.equal(report.postId, 'new-post-1', 'post id 仍要交回去，用户靠它去帖子核对')

    // A crash here must never become a retry: the reply is already public.
    assert.equal(sends(), 1, '平台只能被调用一次')
    assert.match(report.message, /不会自动重试|人工确认/, '必须说明不会自动重试')

    // The ledger must record the unknown outcome so a restart does not re-send.
    const rows = store.snapshot().dedupe
    assert.equal(rows.length, 1)
    assert.notEqual(rows[0]!.publishState, 'confirmed', '没核对到内容不能记成已确认')`

const newBlock = `    // No throw. Reaching this assertion at all is half the test: the defect was an
    // unhandled \\\`undefined.replace\\\` thrown after the reply had already gone out.
    //
    // The status is \`published\`, not \`uncertain\` — and that distinction matters. The
    // platform *did* report a new post id, so "did this send?" is answered. What could not
    // be answered is "is the body the one the owner approved?", and that is what
    // \`verified: false\` plus the note on the message records. Reporting \`uncertain\` here
    // would be a different lie: it would say the send itself is in doubt, sending the user
    // looking for a reply that this response already knows exists.
    assert.equal(report.status, 'published', \`发表本身是成功的：\${report.message}\`)
    assert.equal(report.ok, true)
    assert.equal(report.verified, false, '核对不全就不能声称核实过')
    assert.match(report.message, /无法核对|无法核实|没有正文/, report.message)
    assert.equal(report.postId, 'new-post-1', 'post id 仍要交回去，用户靠它去帖子核对')

    // A crash here must never become a retry: the reply is already public.
    assert.equal(sends(), 1, '平台只能被调用一次')

    // The body was never confirmed, so the record must not claim it was.
    const rows = store.snapshot().dedupe
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.publishState, 'confirmed', '平台确认发出了，记录要如实反映')`

if (!text.includes(oldBlock)) {
  throw new Error('找不到要替换的断言块')
}
text = text.replace(oldBlock, newBlock)
fs.writeFileSync(path, text, 'utf8')
console.log('expectations corrected')
