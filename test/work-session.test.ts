import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

// ============================================================
// work 的「同一场对话」续接 + fetch_file 大文件取件 + 图片类型嗅探
//
// 用户要求（2026-11-03）：说「继续」就在同一会话里接着跑（像普通 harness），
// 模型挂了也换模型接着同一会话，不要另开新会话；近 4 条 work 流程复盘出的
// 三个病根（续接文嵌套滚雪球 / GIF 冒充 jpg 毒化整轮 / 大文件没进沙箱没处取）一并修。
// ============================================================

async function boot(port: number) {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-work-sess-'));
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

function workInput(chat: { platform: 'qq'; type: 'group'; chatId: string }, task: string, tools: any[], extra: Record<string, unknown> = {}) {
  return {
    chat, task, taskLabel: task, userId: '10001', nickname: '群友10001', role: 'owner',
    tools, trigger: 'command' as const, depth: 0, ...extra,
  };
}

test('续接同一会话：上一场的对话原样播种进新一轮，不再冷启动', async () => {
  const g = await boot(30000 + (process.pid % 20000));
  try {
    const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9401' };
    const tools = g.kernel.container.workToolsFor(chat, 'owner', g.kernel.container.workAgent(), 0);

    // 第一场：交付（transcript 里会留下 user / assistant / toolResult）
    g.mock.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: '第一场完成' } }] });
    const r1 = await g.kernel.workRunner.run(workInput(chat, '任务一原文', tools));
    assert.equal(r1.ok, true);
    assert.ok(r1.sandboxKey);

    // 会话记录随任务沙箱落盘
    const ref = (await import('../src/kernel/services/work.ts')).sandboxRefOfKey(r1.sandboxKey!)!;
    const sessDir = join(g.kernel.sandbox.root(ref), '.agent-session');
    assert.ok(existsSync(join(sessDir, `${r1.id}.json`)), '收尾后 .agent-session/<runId>.json 应该在');

    // 第一场留在任务沙箱里的文件：续接后（同一份沙箱）必须还在
    g.kernel.sandbox.write(ref, 'part1.md', '第一场的文件');

    // 续接：mock 第二场的第一次请求应能看到第一场的完整历史
    g.mock.calls.length = 0;
    g.mock.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: '第二场完成' } }] });
    const r2 = await g.kernel.workRunner.run(workInput(chat, '把结尾改成红色', tools, {
      continuation: { kind: 'resume', runId: r1.id, sandboxKey: r1.sandboxKey, origTask: '任务一原文' },
    }));
    assert.equal(r2.ok, true);
    // 沙箱沿用第一场的（同一个任务键），第一场的文件还在
    assert.equal(r2.sandboxKey, r1.sandboxKey);
    assert.ok(g.kernel.sandbox.read(ref, 'part1.md').includes('第一场的文件'));

    assert.ok(g.mock.calls.length >= 1);
    const req2 = g.mock.calls[0];
    // 第一场的 user 原文 + 本轮的新指示都进了同一发请求 → 同一场对话
    assert.ok(req2.usersJoined?.includes('任务一原文'), '第一场的任务原文应在请求历史里');
    assert.ok(req2.usersJoined?.includes('把结尾改成红色'), '本轮指示应是最后一条 user');
    // 续接文只带增量：不再把旧任务原文整个再拼一遍
    assert.ok(req2.lastUser?.includes('【继续上次的工作】'));
    const occur = (req2.lastUser?.match(/任务一原文/g) ?? []).length;
    assert.equal(occur, 0, `短续接文不该再复述旧任务原文（出现 ${occur} 次）`);
    // 新落盘的记录把两场都收进去了
    const joined = readFileSync(join(sessDir, `${r2.id}.json`), 'utf-8');
    assert.ok(joined.includes('任务一原文') && joined.includes('把结尾改成红色'));
  } finally {
    await g.cleanup();
  }
});

test('会话记录丢了：拼接兜底用原始任务原文，不嵌套滚雪球', async () => {
  const g = await boot(30000 + (process.pid % 20000));
  try {
    const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9402' };
    const tools = g.kernel.container.workToolsFor(chat, 'owner', g.kernel.container.workAgent(), 0);

    g.mock.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: '完成' } }] });
    const r1 = await g.kernel.workRunner.run(workInput(chat, '任务一原文', tools));
    assert.equal(r1.ok, true);

    // 模拟内核崩在续接中途：会话记录没落下来
    const ref = (await import('../src/kernel/services/work.ts')).sandboxRefOfKey(r1.sandboxKey!)!;
    rmSync(join(g.kernel.sandbox.root(ref), '.agent-session'), { recursive: true, force: true });

    g.mock.calls.length = 0;
    g.mock.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: '又完成' } }] });
    await g.kernel.workRunner.run(workInput(chat, '继续弄', tools, {
      continuation: { kind: 'resume', runId: r1.id, sandboxKey: r1.sandboxKey, origTask: '任务一原文' },
    }));
    const lastUser = g.mock.calls[0].lastUser ?? '';
    // 原文只出现一次（旧实现会把上一版拼接文整个再包一层：续五轮嵌套五份）
    assert.equal((lastUser.match(/任务一原文/g) ?? []).length, 1, `拼接兜底不该嵌套：${lastUser.slice(0, 120)}`);
    assert.ok(lastUser.includes('——用户这次的指示——'));
    assert.ok(lastUser.includes('继续弄'));
  } finally {
    await g.cleanup();
  }
});

test('fetch_file：登记过的超大文件按需拉进任务沙箱，取回后登记行删除', async () => {
  const g = await boot(30000 + (process.pid % 20000));
  const body = Buffer.from('MUSICBYTES='.repeat(100)); // 1100 字节的假音乐
  const http = createServer((_req, res) => { res.end(body); });
  await new Promise<void>((res) => http.listen(0, '127.0.0.1', res));
  try {
    const port = (http.address() as { port: number }).port;
    // 协议端换链接的桥：测试里指向本地假服务器
    (g.kernel.container as any).deps.protocolFileUrl = async () => `http://127.0.0.1:${port}/file`;

    const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9403' };
    // 适配器登记的形态：群文件太大被拦，落 pending_files
    g.kernel.db.run(
      'INSERT INTO pending_files (chat_type, chat_id, user_id, name, size, file_id, url, ts) VALUES (?,?,?,?,?,?,?,?)',
      'group', '9403', '10001', '背景音乐.mp3', 0, 'fileid_abc', '', Date.now(),
    );

    const taskRef = { platform: 'qq' as const, type: 'private' as const, chatId: 'u10001', scope: 'ttest1' };
    const tools = g.kernel.container.workToolsFor(chat, 'owner', g.kernel.container.workAgent(), 0);
    const tool = tools.find((t) => t.name === 'fetch_file');
    assert.ok(tool, 'fetch_file 应在 work 工具面上');
    const tctx = {
      chat: taskRef,
      event: { platform: 'qq', type: 'group', chatId: '9403', userId: '10001', nickname: 'n', text: '', role: 'owner' },
      role: 'owner' as const,
    };

    // 无参 = 列清单
    const listing = await tool.handler({}, tctx as any);
    assert.ok(String(listing).includes('背景音乐.mp3'));

    // 带 name = 拉进任务沙箱 inbox
    const got = await tool.handler({ name: '背景音乐' }, tctx as any);
    assert.ok(String(got).includes('inbox/'), `应返回 inbox 路径：${got}`);
    const rel = String(got).match(/inbox\/[^\s；;]+/)?.[0] ?? '';
    assert.equal(g.kernel.sandbox.read(taskRef, rel), body.toString(), '拉回来的字节应原样进沙箱');

    // 取回成功 → 登记行删除；再列就是空的
    assert.equal(g.kernel.db.get('SELECT id FROM pending_files WHERE name=?', '背景音乐.mp3'), undefined);
    const again = await tool.handler({}, tctx as any);
    assert.ok(String(again).includes('登记簿是空的'));

    // 名字对不上：如实报，不编
    g.kernel.db.run(
      'INSERT INTO pending_files (chat_type, chat_id, user_id, name, size, file_id, url, ts) VALUES (?,?,?,?,?,?,?,?)',
      'group', '9403', '10001', '追逐音乐.mp3', 0, 'fileid_def', '', Date.now(),
    );
    const miss = await tool.handler({ name: '不存在的' }, tctx as any);
    assert.ok(String(miss).includes('没有名字带'), String(miss));
  } finally {
    http.closeAllConnections?.();
    http.close();
    await g.cleanup();
  }
});

test('readImage 按文件头认类型：GIF 冒充 .jpg 按 image/gif 交，不是图就明说', async () => {
  const g = await boot(30000 + (process.pid % 20000));
  try {
    const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9404' };
    // QQ 落盘的动图常带 .jpg 扩展名（2026-11-03 迷宫任务实锤）：按扩展名声明会被网关整发 400
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x01, 0x00, 0x01, 0x00, 0xf7, 0x00, 0x00]), Buffer.alloc(32, 7)]);
    g.kernel.sandbox.write(chat, 'trap.jpg', gif);
    const img = g.kernel.sandbox.readImage(chat, 'trap.jpg');
    assert.ok(img);
    assert.equal(img.mime, 'image/gif', '真实类型是 GIF，就声明 image/gif');

    // 压根不是图片的「.jpg」：明说转格式，别把二进制当文本喂给模型
    g.kernel.sandbox.write(chat, 'fake.jpg', Buffer.from('hello, not an image at all'));
    await assert.rejects(
      () => Promise.resolve().then(() => g.kernel.sandbox.readImage(chat, 'fake.jpg')),
      /内容不是 PNG\/JPEG\/WebP\/GIF/,
    );
  } finally {
    await g.cleanup();
  }
});

test('模型链彻底挂掉：报错带上对端原文，会话记录仍落盘供「继续」接上', async () => {
  const g = await boot(30000 + (process.pid % 20000));
  try {
    const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9405' };
    const tools = g.kernel.container.workToolsFor(chat, 'owner', g.kernel.container.workAgent(), 0);
    // 连续两次 stopReason='error'（瞬态重试 2 次都失败）：WorkRunner 应把对端报错原样带回
    g.mock.script.push({ error: '400: {"message":"图片保存失败：Declared image type does not match its bytes."}' });
    g.mock.script.push({ error: '400: {"message":"图片保存失败：Declared image type does not match its bytes."}' });
    g.mock.script.push({ error: '400: {"message":"图片保存失败：Declared image type does not match its bytes."}' });
    const r = await g.kernel.workRunner.run(workInput(chat, '任务原文X', tools));
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes('Declared image type does not match'), `报错应带对端原文：${r.error}`);
    // 记录落了盘（摘掉了报错轮）：下一次「继续」还能接上前面的现场
    const ref = (await import('../src/kernel/services/work.ts')).sandboxRefOfKey(r.sandboxKey!)!;
    assert.ok(existsSync(join(g.kernel.sandbox.root(ref), '.agent-session', `${r.id}.json`)));
  } finally {
    await g.cleanup();
  }
});
