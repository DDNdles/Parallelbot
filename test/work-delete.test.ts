import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ============================================================
// 「工作」页历史分组的批量删除
//
// 用户要求：之前的工作记录要能勾选后一次删掉（2026-11-03）。
// 口径：只删记录（内存 + work_runs 表），沙箱里的文件与产物保留；
// 正在跑的任务不能从界面上删掉；不存在的 id 忽略。
// ============================================================

async function boot(port: number) {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-work-del-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as any;
  cfg.onebot.port = port;
  (cfg.providers as Record<string, unknown>).mock = {
    label: 'Mock', model: 'mock-1', enabled: true, baseUrl: '', protocol: 'mock',
    models: [{ id: 'mock-1', enabled: true }],
  };
  cfg.llm.activeProvider = 'mock';
  cfg.llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
  cfg.llm.workChain = [{ provider: 'mock', model: 'mock-1' }];
  cfg.masterIds = ['10001'];
  await kernel.boot();
  const mock = (kernel.llm as unknown as { providers: Map<string, any> }).providers.get('mock')!;
  return {
    kernel, mock,
    cleanup: async () => {
      await kernel.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function workInput(chat: { platform: 'qq'; type: 'group'; chatId: string }, task: string, tools: any[]) {
  return {
    chat, task, taskLabel: task, userId: '10001', nickname: '群友10001', role: 'owner',
    tools, trigger: 'command' as const, depth: 0,
  };
}

test('批量删除工作记录：只删选中的那几条，内存与 work_runs 表同时消失，沙箱文件保留', async () => {
  const g = await boot(30000 + (process.pid % 20000));
  try {
    const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9401' };
    const chatKey = 'group_9401';
    const tools = g.kernel.container.workToolsFor(chat, 'owner', g.kernel.container.workAgent(), 0);

    const ids: string[] = [];
    for (const n of [1, 2]) {
      g.kernel.sandbox.write({ ...chat, scope: 'u10001' }, `out${n}.md`, `第 ${n} 份产物`);
      g.mock.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: `完成 ${n}`, artifacts: [`out${n}.md`] } }] });
      const r = await g.kernel.workRunner.run(workInput(chat, `任务 ${n}`, tools));
      assert.equal(r.ok, true);
      ids.push(r.id);
    }
    assert.equal(g.kernel.workRunner.list(10, chatKey).length, 2);

    // 删掉第一条：列表只剩一条，库里那行也没了，另一条原样保留
    assert.equal(g.kernel.workRunner.deleteRuns([ids[0]]), 1);
    const left = g.kernel.workRunner.list(10, chatKey);
    assert.deepEqual(left.map((r: any) => r.id), [ids[1]]);
    assert.equal(g.kernel.db.get('SELECT id FROM work_runs WHERE id=?', ids[0]), undefined);
    assert.ok(g.kernel.db.get('SELECT id FROM work_runs WHERE id=?', ids[1]), '没选中的记录不能被连坐');

    // 沙箱文件与产物清单不动：删的只是记录
    assert.ok(g.kernel.sandbox.read({ ...chat, scope: 'u10001' }, 'out1.md').includes('第 1 份产物'));
    assert.deepEqual(g.kernel.workRunner.latestArtifacts('10001')?.artifacts, ['out2.md']);

    // 不存在的 id / 空数组：不报错、计数为 0
    assert.equal(g.kernel.workRunner.deleteRuns(['work_nope']), 0);
    assert.equal(g.kernel.workRunner.deleteRuns([]), 0);
    assert.equal(g.kernel.workRunner.deleteRuns('not-an-array'), 0);
  } finally {
    await g.cleanup();
  }
});

test('正在跑的任务不能被批量删除（内存 running 跳过，登记过的行也保留）', async () => {
  const g = await boot(30000 + (process.pid % 20000));
  try {
    const chatKey = 'group_9402';
    const fakeId = 'work_fake_running';
    // 模拟一件正在跑的活：内存里有 running 快照，库里也有 start 行（persist('start') 的形态）
    (g.kernel.workRunner as any).runs.set(fakeId, {
      id: fakeId, chatKey, task: '正在跑', startedAt: Date.now(), steps: [], events: [],
      depth: 0, agentName: 'work', userId: '10001', phase: 'running',
      ok: false, summary: '', rounds: 1, toolCalls: 2, durationMs: 0, artifacts: [],
    });
    g.kernel.db.run(
      'INSERT INTO work_runs (id, chat_key, task, phase, ok, ts, user_id) VALUES (?,?,?,?,?,?,?)',
      fakeId, chatKey, '正在跑', 'start', 0, Date.now(), '10001',
    );

    assert.equal(g.kernel.workRunner.deleteRuns([fakeId]), 0);
    assert.ok((g.kernel.workRunner as any).runs.has(fakeId), '内存里的运行中记录不能被删');
    assert.ok(g.kernel.db.get('SELECT id FROM work_runs WHERE id=?', fakeId), '库里的 start 行也不能删');
  } finally {
    await g.cleanup();
  }
});
