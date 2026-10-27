/**
 * 独立回归测试：历史 confirmed 去重记录不可因会话 TTL 清理和重新分析而丢失。
 * 使用方式：复制本文件到 dsh-ai-debate 项目根目录，安装依赖并编译后执行：
 * node --experimental-transform-types --test v013_dedupe_expiry_regression.test.mjs
 * 不联网、不发贴吧。失败说明该问题仍存在。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DebateStore } from './lib/store.js';
import { runAnalysis } from './lib/runtime.js';
import { DEFAULT_CONFIG, resolveConfig } from './lib/config.js';
import { FakeAdapter, threePartyThread } from './test/helpers.ts';

test('同一召唤重新分析不得覆盖已经 confirmed 的永久防重记录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debate-audit-v013-'));
  try {
    const store = new DebateStore({ dir, sessionTtlMs: 60_000 });
    const data = threePartyThread();
    const runtime = {
      adapter: new FakeAdapter(data),
      store,
      policy: { mode: 'manual', maxAutoPublishesPerSession: 0, cooldownMs: 0, maxPublishesPerThread: 10, stopOnChallenge: true },
      config: () => resolveConfig({ ...DEFAULT_CONFIG, ownerUserId: 'owner-1', aiAccountUserId: '1001' }),
      llm: () => { throw new Error('本测试不调用模型'); },
      log: () => undefined,
    };
    const first = await runAnalysis(runtime, { url: data.thread.url, postId: 'n7' });
    const key = store.snapshot().dedupe[0].key;
    await store.mutate(d => ({
      ...d,
      sessions: d.sessions.map(s => ({ ...s, state: 'PUBLISHED', updatedAt: '2020-01-01T00:00:00Z', publishedPostIds: ['already-sent'] })),
      dedupe: d.dedupe.map(r => ({ ...r, publishState: 'confirmed', publishedPostId: 'already-sent', firstSeenAt: '2020-01-01T00:00:00Z' })),
    }));
    assert.equal(store.getSession(first.sessionId), undefined, '旧会话应该已经被 TTL 清理');
    assert.equal(store.findDedupe(key)?.publishState, 'confirmed', '清理会话不能删除已确认发表的防重记录');
    await runAnalysis(runtime, { url: data.thread.url, postId: 'n7' });
    const after = store.findDedupe(key);
    assert.equal(after?.publishState, 'confirmed', 'BUG: 重新分析将 confirmed 覆盖成 undefined');
    assert.equal(after?.publishedPostId, 'already-sent', 'BUG: 历史已发表的 postId 被丢弃');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
