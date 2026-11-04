import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { connect as netConnect } from 'node:net';
import { startUrlFetch, fetchState, resetProxyCache, downloadPrefs } from '../src/kernel/services/downloads.ts';

// ============================================================
// 依赖代下载的多段 Range 并行（2026-11-04）：docker 安装器 600MB 没有国内镜像
// 可换（npmmirror/华为云/阿里云都实测没有），单连接又常被 CDN 限速——
// 正解是同一条 URL 多段并发。这里用本机假服务器钉住三件事：
//  支持 Range → 走分段；不支持 Range → 单流回退；说支持但段请求被拒 → 也回退。
// ============================================================

const TOTAL = 20 * 1024 * 1024;   // > SEG_MIN_BYTES(16MB)，触发分段
const BODY = Buffer.alloc(TOTAL);
for (let i = 0; i < TOTAL; i++) BODY[i] = i % 251;

function rangeServer() {
  let rangeHits = 0;
  let headHits = 0;
  const server = createServer((req, res) => {
    if (req.method === 'HEAD') {
      headHits++;
      res.writeHead(200, { 'content-length': String(TOTAL), 'accept-ranges': 'bytes' });
      return res.end();
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
    if (!m) {
      res.writeHead(200, { 'content-length': String(TOTAL) });
      return res.end(BODY);
    }
    rangeHits++;
    const lo = Number(m[1]);
    const hi = Math.min(Number(m[2]), TOTAL - 1);
    res.writeHead(206, { 'content-range': `bytes ${lo}-${hi}/${TOTAL}`, 'content-length': String(hi - lo + 1) });
    res.end(BODY.subarray(lo, hi + 1));
  });
  return { server, hits: () => ({ rangeHits, headHits }) };
}

/** 探测请求（bytes=0-0）给 206、真分段请求却回 200 的坏服务器（逼出"探测过后才失败→单流回退"那条路） */
function lyingServer() {
  const server = createServer((req, res) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
    if (m && m[1] === '0' && m[2] === '0') {
      res.writeHead(206, { 'content-range': `bytes 0-0/${TOTAL}`, 'content-length': '1' });
      return res.end(BODY.subarray(0, 1));
    }
    res.writeHead(200, { 'content-length': String(TOTAL) });
    res.end(BODY);
  });
  return server;
}

async function until(stateId: string, timeoutMs = 30_000) {
  const start = Date.now();
  for (;;) {
    const st = fetchState(stateId);
    if (st?.done) return st;
    if (st?.error) throw new Error(`下载失败：${st.error}`);
    if (Date.now() - start > timeoutMs) throw new Error('下载超时未结束');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('支持 Range 的大文件走多段并行，拼接结果逐字节一致', async () => {
  const { server, hits } = rangeServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-dl-seg-'));
  try {
    const port = (server.address() as { port: number }).port;
    const st = startUrlFetch(`seg-${process.pid}`, `http://127.0.0.1:${port}/d`, 'big.bin', dataDir);
    await until(st.id);
    const got = readFileSync(join(dataDir, 'downloads', 'big.bin'));
    assert.equal(got.length, TOTAL);
    assert.ok(got.equals(BODY), '拼接结果要逐字节一致');
    // 1 次 0-0 探测 + 2 个分段（floor(20MB/16MB)=1 → max(2,1)=2 段）；探测已不再用 HEAD
    assert.ok(hits().rangeHits >= 3, `该走分段（实际 Range 请求 ${hits().rangeHits} 个）`);
    assert.equal(st.total, TOTAL);
  } finally {
    server.close();
    server.closeAllConnections?.();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('不支持 Range 的服务器直接单流，结果照常正确', async () => {
  const server = createServer((req, res) => {
    if (req.method === 'HEAD') { res.writeHead(200, { 'content-length': String(TOTAL) }); return res.end(); }
    res.writeHead(200, { 'content-length': String(TOTAL) });
    res.end(BODY);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-dl-plain-'));
  try {
    const port = (server.address() as { port: number }).port;
    const st = startUrlFetch(`plain-${process.pid}`, `http://127.0.0.1:${port}/d`, 'big.bin', dataDir);
    await until(st.id);
    assert.ok(readFileSync(join(dataDir, 'downloads', 'big.bin')).equals(BODY));
  } finally {
    server.close();
    server.closeAllConnections?.();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('段请求被拒（回 200）→ 退回单流，文件照常完整', async () => {
  const server = lyingServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-dl-fallback-'));
  try {
    const port = (server.address() as { port: number }).port;
    const st = startUrlFetch(`fallback-${process.pid}`, `http://127.0.0.1:${port}/d`, 'big.bin', dataDir);
    await until(st.id);
    assert.ok(readFileSync(join(dataDir, 'downloads', 'big.bin')).equals(BODY), '回退后仍要拿到完整文件');
  } finally {
    server.close();
    server.closeAllConnections?.();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// =============== 系统代理（2026-11-04） ===============
// Windows 用户挂着 Clash 系代理，Node fetch 两边都不认，内核下载一直在裸连国外 CDN。
// 钉住两条：env 代理生效（CONNECT 经假代理转发）；代理挂了自动回落直连。

/**
 * 假代理：http 目标经 HTTP 代理是「绝对地址 GET」形态（CONNECT 只用于 https 目标），
 * 代理自己按 Range 语义应答即可——断言目标服务器零命中才能真正证明流量走了代理。
 */
function fakeProxy(o: { dead?: boolean } = {}) {
  let forwards = 0;
  const server = createServer((req, res) => {
    forwards++;
    const m = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
    if (m) {
      const lo = Number(m[1]);
      const hi = Math.min(Number(m[2]), TOTAL - 1);
      res.writeHead(206, { 'content-range': `bytes ${lo}-${hi}/${TOTAL}`, 'content-length': String(hi - lo + 1) });
      return res.end(BODY.subarray(lo, hi + 1));
    }
    res.writeHead(200, { 'content-length': String(TOTAL) });
    res.end(BODY);
  });
  server.on('connect', (req, sock) => {
    if (o.dead) { sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
    sock.end('HTTP/1.1 200 Connection established\r\n\r\n');   // 测试不追 https 隧道，收到即断
  });
  return { server, forwards: () => forwards };
}

test('环境变量代理生效（代理优先档）：下载经代理转发，目标服务器零直接命中', async () => {
  const server = rangeServer();
  await new Promise<void>((r) => server.server.listen(0, '127.0.0.1', r));
  const targetPort = (server.server.address() as { port: number }).port;
  const px = fakeProxy();
  await new Promise<void>((r) => px.server.listen(0, '127.0.0.1', r));
  const proxyPort = (px.server.address() as { port: number }).port;
  const prev = { s: process.env.HTTPS_PROXY, h: process.env.HTTP_PROXY };
  const prevPref = downloadPrefs.directFirst;
  process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
  delete process.env.HTTP_PROXY;
  downloadPrefs.directFirst = false;   // 代理优先档：直连虽通也不走，专门验证代理路径
  resetProxyCache();
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-dl-proxy-'));
  try {
    const st = startUrlFetch(`proxy-${process.pid}`, `http://127.0.0.1:${targetPort}/d`, 'big.bin', dataDir);
    await until(st.id);
    assert.ok(readFileSync(join(dataDir, 'downloads', 'big.bin')).equals(BODY));
    assert.ok(px.forwards() >= 3, `请求应经代理转发（转发 ${px.forwards()} 次）`);
    assert.equal(server.hits().rangeHits, 0, '目标服务器不该收到任何直连请求');
  } finally {
    downloadPrefs.directFirst = prevPref;
    if (prev.s === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = prev.s;
    if (prev.h === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = prev.h;
    resetProxyCache();
    server.server.close();
    server.server.closeAllConnections?.();
    px.server.close();
    px.server.closeAllConnections?.();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('直连优先档：代理虽在，CDN 下载仍走直连（实测直连比 undici×Clash 快数倍）', async () => {
  const server = rangeServer();
  await new Promise<void>((r) => server.server.listen(0, '127.0.0.1', r));
  const targetPort = (server.server.address() as { port: number }).port;
  const px = fakeProxy();
  await new Promise<void>((r) => px.server.listen(0, '127.0.0.1', r));
  const proxyPort = (px.server.address() as { port: number }).port;
  const prev = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
  resetProxyCache();
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-dl-direct-'));
  try {
    assert.equal(downloadPrefs.directFirst, true);
    const st = startUrlFetch(`direct-${process.pid}`, `http://127.0.0.1:${targetPort}/d`, 'big.bin', dataDir);
    await until(st.id);
    assert.ok(readFileSync(join(dataDir, 'downloads', 'big.bin')).equals(BODY));
    assert.ok(server.hits().rangeHits >= 3, '流量应直连目标');
    assert.equal(px.forwards(), 0, '代理不该被碰');
  } finally {
    if (prev === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = prev;
    resetProxyCache();
    server.server.close();
    server.server.closeAllConnections?.();
    px.server.close();
    px.server.closeAllConnections?.();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('代理没开（拒绝连接）→ 自动回落直连，下载不中断', async () => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-length': String(TOTAL) }); res.end(BODY); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  // 占一个端口然后立刻关掉：保证"代理端口没人听"
  const dead = createServer();
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
  const deadPort = (dead.address() as { port: number }).port;
  await new Promise<void>((r) => dead.close(() => r()));
  const prev = process.env.HTTPS_PROXY;
  const prevPref = downloadPrefs.directFirst;
  process.env.HTTPS_PROXY = `http://127.0.0.1:${deadPort}`;
  downloadPrefs.directFirst = false;   // 代理优先档才真会去撞死端口，回退直连才是这条用例的意义
  resetProxyCache();
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-dl-deadpx-'));
  try {
    const port = (server.address() as { port: number }).port;
    const st = startUrlFetch(`deadpx-${process.pid}`, `http://127.0.0.1:${port}/d`, 'big.bin', dataDir);
    await until(st.id);
    assert.ok(readFileSync(join(dataDir, 'downloads', 'big.bin')).equals(BODY), '代理挂了也要拿到完整文件');
  } finally {
    downloadPrefs.directFirst = prevPref;
    if (prev === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = prev;
    resetProxyCache();
    server.close();
    server.closeAllConnections?.();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
