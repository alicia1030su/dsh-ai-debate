/**
 * v0.1.4 regression checks using compiled modules only.
 * Run from the repository root: node --test v014_independent_audit.test.mjs
 * No network, no real Tieba account, no posting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeDispute } from './lib/analyzer.js';
import { dedupeKey, DebateStore } from './lib/store.js';

const THREAD_ID = '900000000000';
const OWNER_ID = '111111';
const TRIGGER_ID = 'n3';

function fakeThread(ownerName) {
  const floor = {
    platform: 'tieba', floorNumber: 1, postId: 'floor',
    authorId: '333333', authorName: '楼主', content: '开始讨论', images: [],
  };
  const nested = [
    { platform: 'tieba', postId: 'n1', parentPostId: 'floor', authorId: OWNER_ID, authorName: ownerName, content: '方案不可行' },
    { platform: 'tieba', postId: 'n2', parentPostId: 'floor', authorId: '222222', authorName: '对手B', content: '回复 ' + ownerName + ' :有证据吗', replyToName: ownerName },
    { platform: 'tieba', postId: TRIGGER_ID, parentPostId: 'floor', authorId: OWNER_ID, authorName: ownerName, content: '@AI 来帮忙', replyToName: '对手B' },
  ];
  return {
    thread: { platform: 'tieba', id: THREAD_ID, url: 'https://tieba.baidu.com/p/' + THREAD_ID, title: '测试', content: '讨论', forum: { platform: 'tieba', id: '1', name: '测试吧' } },
    floors: [{ floor, nested, nestedComplete: true }],
    complete: true, issues: [],
  };
}

test('stable numeric owner ID must produce the same dedupe key after display-name change', () => {
  const keys = [];
  for (const ownerName of ['主人旧昵称', '主人新昵称']) {
    const dispute = analyzeDispute(fakeThread(ownerName), { userId: OWNER_ID }, { postId: TRIGGER_ID });
    assert.equal(dispute.owner.userId, OWNER_ID, 'Both analyses must identify the same stable user');
    assert.equal(dispute.needsConfirmation, false);
    keys.push(dedupeKey({ platform: 'tieba', threadId: THREAD_ID, ownerKey: dispute.owner.key, triggerPostId: TRIGGER_ID }));
  }
  assert.equal(keys[0], keys[1], 'Same user and trigger must retain one durable dedupe identity despite a nickname change');
});

test('maxSessions must not prune an active nonterminal session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v014-active-session-'));
  try {
    const store = new DebateStore({ dir, maxSessions: 1 });
    await store.ready();
    const stamp = new Date().toISOString();
    const session = id => ({ id, platform: 'tieba', threadId: THREAD_ID, triggerPostId: 't-' + id, state: 'READY', candidates: [], publishedPostIds: [], createdAt: stamp, updatedAt: stamp });
    await store.mutate(data => ({ ...data, sessions: [...data.sessions, session('active-A')] }));
    await store.mutate(data => ({ ...data, sessions: [...data.sessions, session('active-B')] }));
    assert.ok(store.getSession('active-A'), 'The oldest active session must not disappear due to the maxSessions cache cap');
    assert.ok(store.getSession('active-B'));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
