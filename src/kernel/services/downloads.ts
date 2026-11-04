/**
 * 内核代下载的第三方安装包（环境检查页那颗「下载」钮）。
 *
 * 两条铁律：
 * 1. **只下载，不代装**——安装包落在 `data/downloads/`，装不装由人双击决定。静默跑别人的安装程序
 *    （要管理员权限、会动 Hyper-V/WSL）不是这个内核该替用户做的事。
 * 2. **URL 只走这张白名单表**，绝不拿前端传来的地址去 fetch（那是 SSRF 与投毒的入口）。
 *
 * 唯一的例外是 ffmpeg：它就是一个静态 exe，解压出来放进 `data/bin/` 就能直接用，
 * 所以给它多做一步解包——这样"点一下就下载"对可选项来说等于"点一下就可用"。
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { setFfmpegCandidate } from './media.ts';

// =============== 直连 / 系统代理（2026-11-04，Docker 下载慢的完整真相） ===============
//
// 排查结论（本机实测）：desktop.docker.com 直连单流 1.5~2MB/s，curl 走系统代理 1.6MB/s，
// 而 undici 走同一个 Clash 只有 0.05~0.07MB/s/连接——「undici × 本机代理」这个组合天生慢。
// 所以这批 CDN 大文件**直连优先**（它们都有国内可达的 CDN 边缘），代理只是兜底：
// 环境变量（HTTP(S)_PROXY）与 WinINET 注册表（桌面快捷方式启动的内核没有 env）都会认，
// 直连探不通（被墙域名握手挂住）才换代理，代理拒绝/没开再回直连——哪条路都不能把下载整死。

let proxyCache: { at: number; url: string | null } | null = null;
let proxyAgent: { url: string; agent: ProxyAgent } | null = null;

/** 测试用：清掉代理缓存（env 是测试里现设的，不重置会读到上一条用例的值） */
export function resetProxyCache(): void {
  proxyCache = null;
  proxyAgent = null;
}

/** 路径偏好（测试注入点）：true = 直连优先；false = 代理优先（测代理转发时置 false） */
export const downloadPrefs = { directFirst: true };

function readWinInetProxy(): Promise<string | null> {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  return new Promise((res) => {
    execFile('reg', ['query', key, '/v', 'ProxyEnable'], { timeout: 3000 }, (e, on) => {
      if (e || !/0x1/.test(String(on ?? ''))) return res(null);
      execFile('reg', ['query', key, '/v', 'ProxyServer'], { timeout: 3000 }, (e2, os) => {
        if (e2) return res(null);
        const raw = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(String(os ?? ''))?.[1] ?? '';
        // "host:port" 一刀切；"http=…;https=…" 分协议的取 https 档
        const pick = raw.includes('=') ? /(?:^|;)https=[^;]+/.exec(raw)?.[0].replace(/^;?https=/, '') ?? '' : raw;
        res(pick ? (/^[a-z]+:\/\//.test(pick) ? pick : `http://${pick}`) : null);
      });
    });
  });
}

/** 当前该用的代理地址（60s 缓存：Clash 开关切换要跟得上，又不能每条连接都查注册表/env） */
async function systemProxy(): Promise<string | null> {
  const now = Date.now();
  if (proxyCache && now - proxyCache.at < 60_000) return proxyCache.url;
  const url = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
    || (process.platform === 'win32' ? await readWinInetProxy() : null);
  proxyCache = { at: now, url: url || null };
  return proxyCache.url;
}

/** 指定路径取一次 fetch。代理在时必须用 undici 自己的 fetch——全局 fetch（内置另一份
 *  undici）不吃外部包的 dispatcher，两套 API 还对不上（「invalid onRequestStart method」实测）。
 *  connections=16：ProxyAgent 内部默认把请求排进单连接串行（实测 8 段并发变 1），分段要真
 *  并行就得把池子撑开。 */
async function fetchVia(url: string, opts: { signal?: AbortSignal; headers?: Record<string, string> }, via: 'direct' | 'proxy'): Promise<Response> {
  if (via === 'proxy') {
    const proxy = await systemProxy();
    if (!proxy) throw new Error('没有可用的系统代理');
    if (proxyAgent?.url !== proxy) proxyAgent = { url: proxy, agent: new ProxyAgent({ uri: proxy, connections: 16 }) };
    return undiciFetch(url, { ...opts, dispatcher: proxyAgent.agent } as never) as unknown as Response;
  }
  return fetch(url, opts as never);
}

/** 直连握手的耐心：被墙域名的典型表现不是拒绝而是挂住，2.5s 探不到响应头就换代理 */
const DIRECT_PROBE_MS = 2500;

/**
 * 探测 Range 能力与可用路径：bytes=0-0 微型请求，按偏好顺序试，先通先用。
 * 返回 206 的总大小与实际走通的那条路；两条都不通返回 null（调用方走单流再兜底）。
 */
async function probeRange(url: string, signal: AbortSignal): Promise<{ total: number; via: 'direct' | 'proxy' } | null> {
  const order: ('direct' | 'proxy')[] = downloadPrefs.directFirst ? ['direct', 'proxy'] : ['proxy', 'direct'];
  for (const via of order) {
    const c = new AbortController();
    const onOuter = () => c.abort();
    signal.addEventListener('abort', onOuter, { once: true });
    const t = setTimeout(() => c.abort(), via === 'direct' ? DIRECT_PROBE_MS : 4000);
    try {
      const r = await fetchVia(url, { signal: c.signal, headers: { range: 'bytes=0-0' } }, via);
      try { await r.body?.cancel(); } catch { /* 只探能力，不消费 body */ }
      const cr = /^bytes 0-0\/(\d+)$/.exec(String(r.headers.get('content-range') ?? ''));
      if (r.status === 206 && cr) return { total: Number(cr[1]) || 0, via };
    } catch (e) {
      if (signal.aborted) throw e;
      // 这条路不通（没代理/被墙/超时）：试下一条
    } finally {
      clearTimeout(t);
      signal.removeEventListener('abort', onOuter);
    }
  }
  return null;
}

export interface DepFetchSpec {
  /** 官方直链（实测可用；版本随官方走，不钉死） */
  url: string;
  /** 落在 data/downloads 下的文件名 */
  file: string;
  /** 原生可执行文件：下载完直接挪到 data/bin/<bin>（没有壳要解） */
  bin?: string;
  /** zip 里要提出来的可执行文件名（给了就多做一步解包到 data/bin） */
  unpackBin?: string;
}

/** 环境检查页「点击就下载」的全部货源。加新条目先确认直链真的能下（curl -I），别猜。 */
export const DEP_FETCHES: Record<string, DepFetchSpec> = {
  docker: {
    url: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
    file: 'DockerDesktopInstaller.exe',
  },
  ffmpeg: {
    // npmmirror 的阿里 CDN：本机实测 ~800KB/s；原先的 gyan.dev 只有 ~100KB/s，一键安装慢就慢在它。
    // b6.0 这份是 MZ 头的原生 exe（81MB，ffmpeg 6.0），落盘即用、无需解包。
    // 2026-11-04 验过：200 / 81,114,624 字节 / 4d5a 头 / 无 content-encoding。
    url: 'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.0/ffmpeg-win32-x64',
    file: 'ffmpeg.exe',
    bin: 'ffmpeg.exe',
  },
};

export interface FetchState {
  id: string;
  dest: string;
  bytes: number;
  /** 服务端报了 content-length 才有，慢网下用来显示进度 */
  total: number;
  done: boolean;
  error: string;
}

const jobs = new Map<string, FetchState>();
/** 635MB 的 Docker 安装器在慢网下要跑十几分钟，别用几分钟的闸把它掐了 */
const TIMEOUT_MS = 30 * 60_000;

export function fetchState(id: string): FetchState | null {
  const j = jobs.get(id);
  if (!j || j.done || !j.dest) return j ?? null;
  // 计数走的是响应流，落盘可能领先一点点；以磁盘上的 .part 为准更诚实
  try {
    const part = j.dest + '.part';
    const onDisk = existsSync(part) ? statSync(part).size : statSync(j.dest).size;
    if (onDisk > j.bytes) j.bytes = onDisk;
  } catch { /* 文件还没建出来，保持原值 */ }
  return j;
}

/** 内核自带的 ffmpeg 落点：media.ts 与依赖探测都从这里读，别各写一份路径 */
export function bundledFfmpeg(dataDir: string): string {
  return join(dataDir, 'bin', 'ffmpeg.exe');
}

/**
 * 起一个后台下载（同 id 正在跑就复用，不重复开流）。
 * 立即返回状态，前端靠 /api/setup/fetch 轮进度——下载几分钟，不能把 HTTP 请求挂在那儿。
 */
export function startDepFetch(id: string, dataDir: string): FetchState {
  const spec = DEP_FETCHES[id];
  if (!spec) throw new Error(`不在下载白名单里：${id}`);
  return startUrlFetch(id, spec.url, spec.file, dataDir);
}

/** 已知 URL 的后台下载（白名单校验归 startDepFetch；测试用它打本机假服务器验证分段/回退） */
export function startUrlFetch(id: string, url: string, file: string, dataDir: string): FetchState {
  const running = jobs.get(id);
  if (running && !running.done && !running.error) return running;

  const dir = join(dataDir, 'downloads');
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, file);
  const state: FetchState = { id, dest, bytes: 0, total: 0, done: false, error: '' };
  jobs.set(id, state);
  void finish(state, { url, file }, dataDir);
  return state;
}

async function finish(state: FetchState, spec: DepFetchSpec, dataDir: string): Promise<void> {
  const part = state.dest + '.part';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // 大文件先试多段并行（Docker 安装器 600MB，单流实测常被压到 1MB/s 上下，8 段能到 ~3MB/s+）；
    // 不支持 Range / 探测失败 / 个别段拉挂 → 退回单流再拉一次，行为与从前完全一致。
    let segmented = false;
    try {
      segmented = await trySegmented(state, spec.url, part, ctrl.signal);
    } catch (e) {
      if (ctrl.signal.aborted) throw e;   // 超时/外部中止不再重试，如实报错
      state.bytes = 0;                    // 分段已拉的字节清零重来
      rmSync(part, { force: true });
    }
    if (!segmented) await singleStream(state, spec.url, part, ctrl.signal);
    renameSync(part, state.dest);
    if (spec.bin) {
      // 原生 exe：进 data/bin（与 unpackBin 的产物同位置），落盘即用
      mkdirSync(join(dataDir, 'bin'), { recursive: true });
      renameSync(state.dest, join(dataDir, 'bin', spec.bin));
      // 转码那头缓存过"没有 ffmpeg"，不清掉要等重启才认新位置
      setFfmpegCandidate(bundledFfmpeg(dataDir));
    }
    if (spec.unpackBin) {
      await unpackBin(state.dest, spec.unpackBin, bundledFfmpeg(dataDir));
      // 转码那头缓存过"没有 ffmpeg"，不清掉要等重启才认新位置
      setFfmpegCandidate(bundledFfmpeg(dataDir));
    }
    state.done = true;
  } catch (e) {
    state.error = (e as Error).name === 'AbortError' ? '下载超时' : (e as Error).message;
    try { rmSync(part, { force: true }); } catch { /* 半成品留着也没用，删不掉就算了 */ }
  } finally {
    clearTimeout(timer);
  }
}

/** 小于这个不值得分段（省一次 HEAD 与收尾拼接的 IO） */
const SEG_MIN_BYTES = 16 * 1024 * 1024;
/** 分段上限：桌面 CDN 实测 4 段就有 3 倍以上增益，8 段封顶防把对端打疼 */
const SEG_MAX = 8;

/**
 * 多段 Range 并行：路径与大小由 probeRange 定（直连优先），各段并发拉到自己的临时片，
 * 字节数逐一核对后按序拼回 .part。
 * 不该分段/没法分段返回 false（调用方走单流），拉挂了抛错（调用方决定退回单流还是报错）。
 */
async function trySegmented(state: FetchState, url: string, part: string, signal: AbortSignal): Promise<boolean> {
  const p = await probeRange(url, signal);
  if (!p || p.total < SEG_MIN_BYTES) return false;
  const { total, via } = p;
  state.total = total;
  const n = Math.min(SEG_MAX, Math.max(2, Math.floor(total / 16_000_000)));
  const segSize = Math.ceil(total / n);
  const segFiles: string[] = [];
  try {
    await Promise.all(Array.from({ length: n }, async (_, i) => {
      const lo = i * segSize;
      const hi = Math.min(total, lo + segSize) - 1;
      const segPart = `${part}.seg${i}`;
      segFiles.push(segPart);
      const res = await fetchVia(url, { signal, headers: { range: `bytes=${lo}-${hi}` } }, via);
      if (res.status !== 206 || !res.body) {
        try { await res.body?.cancel(); } catch { /* 释放没消费的连接 */ }
        throw new Error(`分片 ${i}: HTTP ${res.status}`);
      }
      const counter = new PassThrough();
      counter.on('data', (c: Buffer) => { state.bytes += c.length; });
      // 流式落盘：整体 arrayBuffer 会把 600MB 安装包一口吞进内存
      await pipeline(Readable.fromWeb(res.body as any), counter, createWriteStream(segPart));
      // 落盘字节数对不上就当失败：不核对就会把缺一截的文件当完整交付
      const got = statSync(segPart).size;
      if (got !== hi - lo + 1) throw new Error(`分片 ${i}: 字节数不符（${got} ≠ ${hi - lo + 1}）`);
    }));
    // 按序拼回 .part（流式追加，600MB 不进内存）
    const out = createWriteStream(part, { flags: 'w' });
    for (let i = 0; i < segFiles.length; i++) {
      await pipeline(createReadStream(segFiles[i]), out, { end: i === segFiles.length - 1 });
    }
    return true;
  } finally {
    for (const f of segFiles) { try { rmSync(f, { force: true }); } catch { /* 收尾清理尽力而为 */ } }
  }
}

/** 单流下载（老路径）：不支持 Range / 小文件 / 分段失败时走这里。按偏好试两条路，
 *  一条半路挂了（连不上/被掐）就换另一条重来——大文件不能因为单条路抽风就整个失败。 */
async function singleStream(state: FetchState, url: string, part: string, signal: AbortSignal): Promise<void> {
  const order: ('direct' | 'proxy')[] = downloadPrefs.directFirst ? ['direct', 'proxy'] : ['proxy', 'direct'];
  let lastErr: unknown = new Error('没有可用的下载路径');
  for (const via of order) {
    try {
      const resp = await fetchVia(url, { signal }, via);
      if (!resp.ok || !resp.body) {
        try { await resp.body?.cancel(); } catch { /* 释放连接 */ }
        throw new Error(`HTTP ${resp.status}`);
      }
      state.total = Number(resp.headers.get('content-length') ?? 0) || 0;
      const counter = new PassThrough();
      counter.on('data', (chunk: Buffer) => { state.bytes += chunk.length; });
      await pipeline(Readable.fromWeb(resp.body as any), counter, createWriteStream(part));
      return;
    } catch (e) {
      lastErr = e;
      if (signal.aborted) throw e;   // 超时/外部中止不再换路
      try { rmSync(part, { force: true }); } catch { /* 换路重来的半成品不要了 */ }
      state.bytes = 0;
    }
  }
  throw lastErr;
}

/** zip 里按名字找那个 exe（包内通常还套一层 ffmpeg-<版本>-essentials_build/bin） */
async function unpackBin(zip: string, want: string, target: string): Promise<void> {
  const dir = join(target, '..', '_unpack');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Windows 自带 bsdtar 解 zip（PATH 里的 GNU tar 不行，所以走绝对路径）；必须异步，别阻塞事件循环
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  await new Promise<void>((resolve, reject) => {
    execFile(tar, ['-xf', zip, '-C', dir], { timeout: 300_000 }, (e) => (e ? reject(e) : resolve()));
  });
  const found = findDeep(dir, want, 4);
  if (!found) throw new Error(`解压后没找到 ${want}`);
  mkdirSync(join(target, '..'), { recursive: true });
  renameSync(found, target);
  rmSync(dir, { recursive: true, force: true });
  rmSync(zip, { force: true });   // 已经解出可执行文件，114MB 的 zip 没必要占着盘
}

function findDeep(root: string, name: string, depth: number): string {
  if (depth < 0) return '';
  // readdirSync 默认 withFileTypes:false（这里要的就是 string[]）；显式传那个选项会命中
  // 返回 string[] | Buffer[] 的重载，把 entries 的类型搅宽
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return ''; }
  for (const n of entries) {
    const p = join(root, n);
    if (n === name) return p;
  }
  for (const n of entries) {
    const p = join(root, n);
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch { continue; }
    const hit = findDeep(p, name, depth - 1);
    if (hit) return hit;
  }
  return '';
}
