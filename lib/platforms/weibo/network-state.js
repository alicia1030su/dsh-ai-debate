/**
 * 授权主机的可达性（v0.2.33 §六）。
 *
 * ## 它要回答的问题
 *
 * `doctor` 的 `× 注册或登录` 覆盖了两种完全不同的处境：
 *
 * 1. 这台机器连不上 `open.weibo.com` —— 网络问题，重新登录也会失败；
 * 2. 网络是通的，但平台拒绝了手上的令牌 —— 授权问题，必须重新登录。
 *
 * CLI 对这两种给出**同一句话**（`resolveToken()` 把所有异常都 `catch` 掉，然后返回
 * null）。而它们对应的动作完全不同，所以插件必须自己分一次。
 *
 * ## 为什么这个探测没有凭据
 *
 * 它只发一个**不带任何令牌、不带 Cookie** 的 HTTPS 请求，问的是「这个域名在这台
 * 机器上答不答话」。答 200 是答，答 404 也是答——只要拿到了 HTTP 状态码，
 * 就证明链路通。这既不读保管库，也不碰令牌，更不消耗接口额度。
 *
 * ## 为什么它必须有超时，且默认不跑
 *
 * 这是一次外部网络调用，不能出现在读取路径上：一条微博读不读得到，不该取决于
 * 一个额外的连通性探测。它只在诊断面板发现「有登录记录但 CLI 拿不到令牌」时
 * 才跑一次，且有硬上限（默认 2.5 秒）。超时就报 `unreachable`——在诊断语境里，
 * 「2.5 秒没答上来」和「连不上」对用户是同一件事。
 */
/** 默认探测的地址。与 CLI 自己的授权基址同源，不再引入第二个依赖。 */
const AUTH_HOST = 'https://open.weibo.com/cli/';
/** 默认超时。够一次国内 HTTPS 往返，又不至于让诊断面板卡住。 */
const DEFAULT_TIMEOUT_MS = 2_500;
/**
 * 探测授权主机是否可达。
 *
 * 永不抛错：诊断的价值在于「说清现在怎样」，抛错就变成了「什么都没说」。
 */
export async function probeAuthHostReachability(options = {}) {
    const impl = options.fetchImpl ?? globalThis.fetch;
    if (typeof impl !== 'function') {
        return { state: 'unknown', reason: '当前运行时没有 fetch，无法探测授权主机。' };
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        // `HEAD` 而不是 `GET`：只关心链路是否通，不需要任何响应正文。
        const response = await impl(AUTH_HOST, { method: 'HEAD', signal: controller.signal, redirect: 'manual' });
        return { state: 'reachable', status: response.status };
    }
    catch (error) {
        const name = error.name;
        if (name === 'AbortError') {
            return { state: 'unreachable', reason: `${timeoutMs} 毫秒内没有响应：网络可能不通，或代理把请求吞掉了。` };
        }
        const message = error.message.split('\n')[0] ?? '未知错误';
        return { state: 'unreachable', reason: `连不上 open.weibo.com：${message}` };
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=network-state.js.map