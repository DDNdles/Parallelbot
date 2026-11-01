import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import type { ConfigStore } from '../config.ts';
import type { ErrorCenter } from '../errors.ts';
import type { EndCheck, LoginQrcode, Logger, ProtocolEnd } from '../types.ts';
import { findQqInstallPath } from './deps.ts';
import { sha256File } from './integrity.ts';

/**
 * SnowLuma（SnowLuma/SnowLuma）内嵌托管：下载官方发行包 → 预写账号级 ob11 反向 WS 配置 →
 * 用包内 node.exe 拉起 → 崩溃守护。它注入本机 QQNT 客户端（hookAutoLoad），登录发生在 QQ 窗口里，
 * 与 NapCat 托管同一个模型 —— 对内核来说两者只是 OneBot 11 反向 WS 的另一个来源。
 *
 * 下面这些常量不是猜的，取自 v2.3.3 的仓库与发行包实测：
 *   包内布局  平铺：index.mjs / node.exe / launcher.bat / config/（首次运行生成）+ 原生 addon
 *   启动方式  launcher.bat 只是 `node ./index.mjs` + 版本检查 + pause —— 托管直接 spawn 包内 node.exe，
 *             cwd 必须是包根（config/ 是相对路径，跑错 cwd 配置就落别处）
 *   配置落点  config/onebot.json（全局默认）+ config/onebot_<uin>.json（账号级，登录后固化为快照，
 *             **快照存在时全局配置整个被忽略**）。反向 WS 只能写进账号级文件：写全局的话，
 *             hookAutoLoad 注入到的每一个 QQ（包括用户自己在用的那个号）都会连进内核。
 *   环境变量  SNOWLUMA_WEBUI_PORT / SNOWLUMA_HOOK_AUTOLOAD（官方 runtime 覆盖通道，
 *             "trusted launcher pins per-launch without rewriting the file"）—— 比替它写 runtime.json 干净
 *   WebUI    http://127.0.0.1:<port>，首次启动的初始密码打在启动日志里（我们照记不误）
 *   许可     源码可见非商业许可 + EULA：不随本发行包分发、运行时从官方 Releases 拉取（见 THIRD-PARTY-NOTICES.md）
 */
const SNOWLUMA_VERSION = 'v2.3.3';
const ASSET_WIN = 'SnowLuma-v2.3.3-win-x64.zip';   // 完整版自带 node.exe，不依赖使用者装了 Node
const SNOWLUMA_SHA256 = '355b3fc0bf0c20dd7addbbfbf6f285a7b3a952f3aeba8d87fceffd0731e515c7';

/** 内核写进 SnowLuma ob11 配置里那条反向 WS 客户端的名字（upsert 时按它认，别的一律不动） */
export const SNOWLUMA_CLIENT_NAME = 'parallel';

/** WsClientNetwork（SnowLuma packages/onebot types.ts）：enabled/role 缺省即 true/Universal，写全便于人读 */
export function snowlumaWsClient(url: string, token: string) {
  return {
    name: SNOWLUMA_CLIENT_NAME,
    enabled: true,
    url,
    role: 'Universal',
    reconnectIntervalMs: 5000,
    accessToken: token,
    messageFormat: 'array',
    reportSelfMessage: false,
  };
}

/** 只增改我们那条 wsClients，保留账号级配置里的其它网络与顶层字段 */
export function mergeSnowlumaOneBotConfig(existing: unknown, client: ReturnType<typeof snowlumaWsClient>): Record<string, unknown> {
  const base = (existing && typeof existing === 'object' ? existing : {}) as Record<string, unknown>;
  const net = (base.networks && typeof base.networks === 'object' ? base.networks : {}) as Record<string, unknown>;
  const list = Array.isArray(net.wsClients) ? net.wsClients as Record<string, unknown>[] : [];
  const prev = list.find((c) => c?.name === client.name);
  const rest = list.filter((c) => c?.name !== client.name);
  return { ...base, networks: { ...net, wsClients: [...rest, { ...prev, ...client }] } };
}

/** 端口上有没有人答话（任何 HTTP 响应都算——没登录账号时 WebUI 登录页也会回） */
async function reachable(origin: string): Promise<boolean> {
  try {
    await fetch(origin, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    return true;
  } catch { return false; }
}

export class SnowLumaManager implements ProtocolEnd {
  readonly id = 'snowluma' as const;
  private child?: ChildProcess;
  private exitCount = 0;
  private lastExitAt = 0;
  private stopping = false;
  private lastError = '';
  log: Logger;

  constructor(
    private config: ConfigStore,
    private errors: ErrorCenter,
    loggerFactory: (name: string) => Logger,
    /** 反向 WS 那头的登录情况（SnowLuma 连上内核即代表 QQ 在线） */
    private selfInfo: () => { connected: boolean; selfId: string; nickname: string },
  ) {
    this.log = loggerFactory('snowluma-manager');
  }

  private get cfg(): { webuiPort: number } {
    return (this.config.config.onebot as any).snowluma ?? { webuiPort: 5099 };
  }

  running(): boolean {
    return !!this.child && !this.child.killed && this.child.exitCode === null;
  }

  homeDir(): string { return join(this.config.dataDir, 'snowluma'); }
  private entryMjs(): string { return join(this.homeDir(), 'index.mjs'); }
  private nodeExe(): string { return join(this.homeDir(), 'node.exe'); }

  /** WebUI 地址：初始密码在首次启动日志里，登录页据此提示 */
  webuiUrl(): string {
    return `http://127.0.0.1:${this.cfg.webuiPort || 5099}`;
  }

  downloaded(): boolean { return existsSync(this.entryMjs()) && existsSync(this.nodeExe()); }

  status(): Record<string, unknown> {
    const self = this.selfInfo();
    return {
      running: this.running(),
      pid: this.child?.pid,
      home: this.homeDir(),
      webuiUrl: this.webuiUrl(),
      downloaded: this.downloaded(),
      restarts: this.exitCount,
      version: SNOWLUMA_VERSION,
      error: this.lastError,
      online: self.connected,
      uin: self.selfId,
      expectedQq: String(this.config.config.ui.expectedQq || ''),
    };
  }

  /** 完整性与可用性逐项实测：状态由前面的点表示，详情只放值本身 */
  async check(): Promise<EndCheck[]> {
    const out: EndCheck[] = [];
    out.push(this.downloaded()
      ? { state: 'pass', label: '发行包', detail: `${this.homeDir()}（${SNOWLUMA_VERSION}）` }
      : { state: 'warn', label: '发行包', detail: `未下载：${this.homeDir()}` });
    const qq = await findQqInstallPath('');
    out.push(qq
      ? { state: 'pass', label: '注入目标', detail: qq }
      : { state: 'fail', label: '注入目标', detail: '没探到 QQNT：SnowLuma 要注入本机 QQ 客户端，装好后重启内核' });
    out.push(this.running()
      ? { state: 'pass', label: '进程', detail: `pid=${this.child?.pid}` }
      : { state: 'fail', label: '进程', detail: this.lastError || '未运行' });
    const reach = await reachable(this.webuiUrl());
    const self = this.selfInfo();
    out.push(reach
      ? { state: self.connected ? 'pass' : 'warn', label: '控制台', detail: this.webuiUrl() }
      : { state: 'fail', label: '控制台', detail: `打不开：${this.webuiUrl()}` });
    return out;
  }

  /** 注入模式在 QQ 客户端窗口里扫码，内核没有可代理的出码接口 */
  async fetchQrcode(): Promise<LoginQrcode | null> { return null; }

  async loginInfo(): Promise<{ online: boolean; uin: string; nick: string } | null> {
    const s = this.selfInfo();
    return { online: s.connected, uin: s.selfId, nick: s.nickname };
  }

  /** 只补发行包（下载 + 解包），不拉起进程：首次初始化的「一键安装」用它 */
  async ensureInstalled(): Promise<void> {
    if (this.downloaded()) return;
    if (process.platform !== 'win32') throw new Error('SnowLuma 托管只支持 Windows（注入本机 QQNT）');
    mkdirSync(this.homeDir(), { recursive: true });
    await this.downloadAndExtract();
    if (!this.downloaded()) throw new Error('SnowLuma 解压后仍找不到 index.mjs：发行包不完整');
  }

  /** 启动托管：备好目录/发行包/账号级反向 WS 配置后拉起。幂等。 */
  async start(): Promise<void> {
    if (this.running()) return;
    if (process.platform !== 'win32') {
      this.lastError = 'SnowLuma 托管目前只支持 Windows（注入本机 QQNT）；其它平台请自行运行 SnowLuma 并把反向 WS 指向内核。';
      this.errors.record('warn', 'adapter', this.lastError);
      return;
    }
    this.stopping = false;
    // 和 LLBot 有头模式同一道闸：注入模式寄生在本机 QQ 上，登着谁就顶着谁发言，
    // 没设预期账号就宁可不起（否则可能拿你自己的号去回别人的消息）。
    const uin = String(this.config.config.ui.expectedQq || '').trim();
    if (!/^\d+$/.test(uin)) {
      this.lastError = '未设置预期 bot 账号：请在 data/config.json 的 ui.expectedQq 填入本 bot 的 QQ 号后重启协议端。';
      this.log.warn(this.lastError);
      this.errors.record('warn', 'adapter', this.lastError);
      return;
    }
    mkdirSync(this.homeDir(), { recursive: true });
    if (!this.downloaded()) await this.downloadAndExtract();
    if (!this.downloaded()) {
      this.lastError = `SnowLuma 未就绪：解压后找不到 index.mjs 或 node.exe（${this.homeDir()}）`;
      this.errors.record('error', 'adapter', this.lastError, { notifyOwner: true });
      return;
    }
    this.writeNetworkConfig(uin);
    this.spawn();
  }

  private spawn(): void {
    const env = {
      ...process.env,
      SNOWLUMA_WEBUI_PORT: String(this.cfg.webuiPort || 5099),
      SNOWLUMA_HOOK_AUTOLOAD: '1',   // 每个新发现的 QQ 进程自动注入：等价于官方 Docker 镜像里的用法
    };
    this.log.info(`拉起 SnowLuma ${SNOWLUMA_VERSION}（${this.homeDir()}），QQ 登录在本机 QQ 客户端窗口完成`);
    this.child = spawn(this.nodeExe(), [this.entryMjs()], { cwd: this.homeDir(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout?.on('data', (d: Buffer) => this.logLine(d));
    this.child.stderr?.on('data', (d: Buffer) => this.logLine(d));
    this.child.on('exit', (code) => {
      this.child = undefined;
      if (this.stopping) return;
      this.exitCount++;
      const now = Date.now();
      if (now - this.lastExitAt > 30 * 60_000) this.exitCount = 1;
      this.lastExitAt = now;
      if (this.exitCount >= 5) {
        this.errors.record('error', 'adapter', `SnowLuma 连续退出 ${this.exitCount} 次，已停止自动重启（检查 QQ 是否可登录、或 ${this.homeDir()} 下 config/ 的配置）`, { notifyOwner: true });
        return;
      }
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.exitCount, 5));
      this.log.warn(`SnowLuma 退出（code=${code}），${Math.round(delay / 1000)}s 后重启（第 ${this.exitCount} 次）`);
      setTimeout(() => { if (!this.stopping) void this.start().catch(() => {}); }, delay);
    });
  }

  private logLine(d: Buffer): void {
    const line = d.toString().trim().split('\n')[0];
    if (line) this.log.info(`[snowluma] ${line.slice(0, 200)}`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const c = this.child;
    this.child = undefined;
    if (!c) return;
    await new Promise<void>((resolveP) => {
      const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ignore */ } resolveP(); }, 5000);
      c.once('exit', () => { clearTimeout(t); resolveP(); });
      try { c.kill(); } catch { /* ignore */ }
    });
  }

  /**
   * 反向 WS 写进**账号级** onebot_<uin>.json，绝不能写全局：
   * 全局配置会被 hookAutoLoad 注入到的每个账号继承（包括用户自己在用的 QQ），
   * 而账号一旦登录就会固化为快照、之后全局改动再也传不进去。
   */
  private writeNetworkConfig(uin: string): void {
    const dir = join(this.homeDir(), 'config');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `onebot_${uin}.json`);
    let cur: unknown = {};
    try { cur = JSON.parse(readFileSync(path, 'utf-8')); } catch { /* 首次：用空底子 */ }
    const ob = this.config.config.onebot;
    const url = `ws://${ob.host}:${ob.port}${ob.reverseWsPath}`;
    const client = snowlumaWsClient(url, this.config.secrets.onebotAccessToken || '');
    writeFileSync(path, JSON.stringify(mergeSnowlumaOneBotConfig(cur, client), null, 2));
    this.log.info(`已写入 SnowLuma 反向 WS 配置: ${path}`);
  }

  /** 下载发行包（约 43MB，自带 Node 运行时）并解压到 home（zip 是平铺布局，直接解开即位） */
  private async downloadAndExtract(): Promise<void> {
    const asset = ASSET_WIN;
    // 官方 Release API 的 asset digest：升级 SNOWLUMA_VERSION 必须同时更新它
    const expectedSha256 = SNOWLUMA_SHA256;
    const rel = `https://github.com/SnowLuma/SnowLuma/releases/download/${SNOWLUMA_VERSION}/${asset}`;
    const home = this.homeDir();
    const zipPath = join(home, asset);
    let lastErr = '';
    let ok = false;
    // 官方源优先；镜像只作备用
    for (const url of [rel, `https://gh-proxy.com/${rel}`, `https://ghfast.top/${rel}`]) {
      try {
        this.log.info(`下载 SnowLuma ${SNOWLUMA_VERSION}: ${url.split('/releases/')[0]}…（约 43MB）`);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 600_000);
        try {
          const resp = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          await pipeline(Readable.fromWeb(resp.body as never), createWriteStream(zipPath));
        } finally { clearTimeout(timer); }
        // 解压前校验：注入用的原生 addon 被换掉等于把整台机器交出去
        const got = await sha256File(zipPath);
        if (got !== expectedSha256) {
          rmSync(zipPath, { force: true });
          throw new Error(`SHA256 校验失败（期望 ${expectedSha256.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`);
        }
        ok = true;
        break;
      } catch (e) {
        lastErr = (e as Error).message;
        this.log.warn(`SnowLuma 下载失败（${lastErr}），尝试下一个源…`);
      }
    }
    if (!ok) {
      const msg = `SnowLuma 下载失败（${lastErr}）。可手动下载 ${asset}（releases ${SNOWLUMA_VERSION}，已校验官方 SHA256）解压到 ${home}，然后重启内核。`;
      this.errors.record('error', 'adapter', msg, { notifyOwner: true });
      throw new Error(msg);
    }
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    await new Promise<void>((resolveP, reject) => execFile(tar, ['-xf', zipPath, '-C', home], (e) => (e ? reject(e) : resolveP())));
    rmSync(zipPath, { force: true });
    this.log.info('SnowLuma 发行包就绪');
  }
}
