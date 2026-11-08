/**
 * v0.2.34 §4：辩论质量的三类真实场景 —— 主题转移、前后矛盾、已答过的问题。
 *
 * ## 为什么这三个场景要单独建
 *
 * 现有 74 个案例覆盖的是「目标锁定、身份、注入、预算、拒绝」。它们都属于
 * **结构性**约束：答错就会立刻有一条断言变红。但真实讨论里最容易让回复变难看的
 * 是另外三件事，而它们此前**没有任何一条案例**：
 *
 * | 场景 | 失败形状 | 用户看到什么 |
 * | --- | --- | --- |
 * | 对手转移话题 | 回复追着新话题跑，原来那条质疑被放过 | 「他怎么被带跑了」 |
 * | 对手前后矛盾 | 回复只反驳最新一句，没提之前的相反说法 | 「他自己打自己脸你都没看出来」 |
 * | 主人已答过的问题 | 回复又把已答的说一遍，或指责对方「你没回答」 | 「这句我明明说过了」 |
 *
 * 这三条都不是模型能力问题，而是**简报里没有把关系说清**。所以它们必须有案例，
 * 而且必须能在确定性通道里判（不需要真实模型）。
 *
 * ## 与「注入」案例的区别
 *
 * 注入是安全边界（不可信文本不能变指令）；这三条是**论证质量**。把它们混在一起
 * 会让「引用对方原话」被误判成注入，而那正是好回复该做的事。
 */
import { floor, post, type EvalCase } from './corpus.ts'

/** 微博形状的讨论：正文 + 评论，评论之间没有楼层号。 */
const BODY = '7000000000000001'
const OWNER = { handle: 'owner_v34', name: '主张方', uid: '9001' }
const OPPONENT = { handle: 'opp_v34', name: '反对方', uid: '9002' }
const BYSTANDER = { handle: 'c_v34', name: '路过的人', uid: '9003' }

function bodyPost(content: string) {
  return post(BODY, 'owner', OWNER.name, content, { handle: OWNER.handle, numericUid: OWNER.uid })
}

/** 对手转移话题：先质疑 A，被追问后改说 B。 */
function topicShiftCases(): EvalCase[] {
  return [
    {
      id: 'quality/shift-01',
      title: '对手把话题从「成本」转到「态度」：回复要回到原本那条质疑',
      origin:
        '真实讨论里最常见的逃逸方式：被追问数据时，转而指责对方「你态度不好」或「你根本不懂」。' +
        '如果回复追着新话题跑，原来那条「成本会不会翻倍」就被永久放过了 —— 而那是整场争论的实质。',
      platform: 'weibo',
      body: bodyPost('这个改造预算我算过，翻倍不至于，但确实要一次性投入。'),
      floors: [
        floor(
          1,
          '7101',
          post('7101', 'opponent', OPPONENT.name, '成本至少翻一倍，你根本没算过。', {
            handle: OPPONENT.handle,
            numericUid: OPPONENT.uid,
          }),
          [
            post('7102', 'owner', OWNER.name, '翻一倍这个数从哪来？把口径说出来，我按同一口径重算。', {
              handle: OWNER.handle,
              numericUid: OWNER.uid,
              repliesTo: '7101',
            }),
            post('7103', 'opponent', OPPONENT.name, '你这种态度就没法聊，摆数据有什么用。', {
              handle: OPPONENT.handle,
              numericUid: OPPONENT.uid,
              repliesTo: '7102',
            }),
          ],
        ),
      ],
      pickedPostId: '7103',
      expectation: {
        // 回复的是 7103，但**内容**必须回到 7101 那条「翻一倍」。
        targetPostId: '7103',
        opponentName: OPPONENT.name,
        ownerIsNotOpponent: true,
        mustNot: ['你就是态度差', '懒得理你', '滚'],
        checks: ['target_locked', 'opponent_is_trigger_author', 'owner_not_opponent', 'claims_traceable', 'non_empty_reply', 'no_leak'],
      },
      scriptedReply:
        '态度可以聊，但先把数说清：你说至少翻一倍，我问的是口径——包不包含停工损失、按几年折旧。' +
        '口径给出来我按同一套重算；给不出来，那「翻一倍」就只是一句感觉。',
    },
  ]
}

/** 对手前后矛盾：先说 A，后来主张非 A。 */
function selfContradictionCases(): EvalCase[] {
  return [
    {
      id: 'quality/contradict-01',
      title: '对手先说「没必要」，后说「早就该做」：回复要点出这处自相矛盾',
      origin:
        '同一场讨论里，对手为了反驳每一句而分别改变立场，是辩论里最有效也最容易被漏掉的漏洞。' +
        '只反驳最新一句，等于把前面那句相反的主张替他悄悄撤回了。',
      platform: 'weibo',
      body: bodyPost('这事我还在看，先不下结论。'),
      floors: [
        floor(
          1,
          '7201',
          post('7201', 'opponent', OPPONENT.name, '这东西根本没必要做，纯属折腾。', {
            handle: OPPONENT.handle,
            numericUid: OPPONENT.uid,
          }),
          [
            post('7202', 'bystander', BYSTANDER.name, '我倒觉得可以试试。', {
              handle: BYSTANDER.handle,
              numericUid: BYSTANDER.uid,
              repliesTo: '7201',
            }),
            post('7203', 'opponent', OPPONENT.name, '试是早就该试的，拖到现在才做才是问题。', {
              handle: OPPONENT.handle,
              numericUid: OPPONENT.uid,
              repliesTo: '7202',
            }),
          ],
        ),
      ],
      pickedPostId: '7203',
      expectation: {
        targetPostId: '7203',
        opponentName: OPPONENT.name,
        ownerIsNotOpponent: true,
        mustNot: ['你这种人', '精神分裂', '有病'],
        // `claims_traceable` 保证引用的两句都能追到真实 postId —— 这正是
        // 「指出矛盾」与「编造对方没说过的话」的分界线。
        checks: ['target_locked', 'opponent_is_trigger_author', 'owner_not_opponent', 'claims_traceable', 'non_empty_reply', 'no_leak'],
      },
      scriptedReply:
        '你前面说「根本没必要做，纯属折腾」，现在说「早就该试」。两句不能同时成立；' +
        '如果现在的立场是「该做但太晚」，那前面那句为什么要说。',
    },
  ]
}

/** 主人已经答过类似问题：回复不该再把同一段话重说一遍。 */
function alreadyAnsweredCases(): EvalCase[] {
  return [
    {
      id: 'quality/answered-01',
      title: '主人已经给过数据：回复不该把同一组数字再说一遍',
      origin:
        '同一场讨论里重复自己说过的内容，是「看起来在辩论、实际上没有推进」的典型。' +
        '简报里必须能看见「这条已经答过」，否则模型会把最完整的那段答案再抄一遍。',
      platform: 'weibo',
      body: bodyPost('电费单我贴过两次了，按月都在那里。'),
      floors: [
        floor(
          1,
          '7301',
          post('7301', 'owner', OWNER.name, '去年同月份电费 218 元，今年 241 元，差 23 元。', {
            handle: OWNER.handle,
            numericUid: OWNER.uid,
          }),
          [
            post('7302', 'opponent', OPPONENT.name, '你倒是说说差多少？空口说贵没意义。', {
              handle: OPPONENT.handle,
              numericUid: OPPONENT.uid,
              repliesTo: '7301',
            }),
          ],
        ),
      ],
      pickedPostId: '7302',
      expectation: {
        targetPostId: '7302',
        opponentName: OPPONENT.name,
        ownerIsNotOpponent: true,
        // 不能因为「对方问过」就指责他没看：他确实可能刚进来。
        mustNot: ['你自己不会看', '眼瞎', '翻记录去'],
        checks: ['target_locked', 'opponent_is_trigger_author', 'owner_not_opponent', 'non_empty_reply', 'no_leak'],
      },
      scriptedReply: '差 23 元，218 对 241，我上面那条里就写着。你要是想讨论这个差额合不合理，我们从这儿接着聊。',
    },
  ]
}

/** 多人混合讨论：只有一个人在真正交锋，其余是路人。 */
function mixedCrowdCases(): EvalCase[] {
  return [
    {
      id: 'quality/crowd-01',
      title: '三个路人各说一句、只有一个真在反驳：对手不能选错',
      origin:
        '围观的人越多，越容易把「说得最响的那个」当对手。判定依据必须是**谁在针对主人**，' +
        '而不是谁的字数最多。',
      platform: 'weibo',
      body: bodyPost('车位我买了，不打算让。'),
      floors: [
        floor(1, '7401', post('7401', 'bystander', BYSTANDER.name, '有钱真好，羡慕。', { handle: BYSTANDER.handle, numericUid: BYSTANDER.uid }), []),
        floor(2, '7402', post('7402', 'bystander', '另一个路过的', '我们小区也在闹这事，头疼。', { handle: 'c_v34b', numericUid: '9004' }), []),
        floor(
          3,
          '7403',
          post('7403', 'opponent', OPPONENT.name, '买了也不代表占着有理，公共资源本来就该轮着用。', {
            handle: OPPONENT.handle,
            numericUid: OPPONENT.uid,
          }),
          [],
        ),
      ],
      pickedPostId: '7403',
      expectation: {
        targetPostId: '7403',
        opponentName: OPPONENT.name,
        ownerIsNotOpponent: true,
        mustNot: ['有钱真好', '羡慕'],
        checks: ['target_locked', 'opponent_is_trigger_author', 'owner_not_opponent', 'non_empty_reply', 'no_leak'],
      },
      scriptedReply: '产权和「轮着用」是两套规则。我买的是这个位的使用权，公共资源说的是没被买下的那些。要把这两件事混在一起，得先说明产权为什么不算。',
    },
  ]
}

/** 引用别人的发言：转述不等于本人的主张。 */
function quotedOthersCases(): EvalCase[] {
  return [
    {
      id: 'quality/quote-01',
      title: '对手引用第三方的话来反驳：被引用的话不能算成对手的主张',
      origin:
        '「连你们那边的人都说了……」是最常见的一招：借别人的嘴说重话，被追问时再退回「我只是引用」。' +
        '如果回复把被引用的内容当成对手的立场，就会反驳一个他从没主张过的东西。',
      platform: 'weibo',
      body: bodyPost('数据我列在正文里了，谁都能复核。'),
      floors: [
        floor(
          1,
          '7501',
          post(
            '7501',
            'opponent',
            OPPONENT.name,
            '你们那边的老张都说「这数据经不起推敲」，你自己不觉得吗。',
            { handle: OPPONENT.handle, numericUid: OPPONENT.uid },
          ),
          [],
        ),
      ],
      pickedPostId: '7501',
      expectation: {
        targetPostId: '7501',
        opponentName: OPPONENT.name,
        ownerIsNotOpponent: true,
        // 不能替第三方把话说得更重，也不能把「老张」当成争论对手。
        mustNot: ['老张也认为你错了', '你们那边的人都'],
        checks: [
          'target_locked',
          'opponent_is_trigger_author',
          'owner_not_opponent',
          'claims_traceable',
          'no_fabricated_quote',
          'non_empty_reply',
          'no_leak',
        ],
      },
      scriptedReply:
        '那句话是别人说的，我不替他解释。你要反驳就指出具体哪一行数据经不起推敲，' +
        '口径、样本、时间窗，指哪一个我都能核。',
    },
  ]
}

/** 长讨论：早期论据不能因为后来刷屏而丢。 */
function longThreadCases(): EvalCase[] {
  const floors = []
  // 12 条路人发言在先，把上下文撑大；真正的那条质疑在最前面。
  for (let i = 0; i < 12; i += 1) {
    floors.push(
      floor(
        i + 2,
        `76${String(i + 10)}`,
        post(`76${String(i + 10)}`, 'bystander', `围观${i + 1}`, `路过说一句，第 ${i + 1} 条。`, {
          handle: `c_v34_${i}`,
          numericUid: `81${String(i).padStart(2, '0')}`,
        }),
        [],
      ),
    )
  }
  return [
    {
      id: 'quality/long-01',
      title: '十几条路人刷屏之后：最早那条实质质疑仍然要能被引用',
      origin:
        '长讨论里最容易被压掉的是**第一条实质发言**：它离触发点最远，而上下文预算按距离裁剪。' +
        '裁剪掉它，回复就会去反驳最新那条无关的插话。',
      platform: 'weibo',
      body: bodyPost('方案我贴了，欢迎挑毛病。'),
      floors: [
        floor(
          1,
          '7601',
          post('7601', 'opponent', OPPONENT.name, '你那个方案忽略了迁移成本，这一块谁来付？', {
            handle: OPPONENT.handle,
            numericUid: OPPONENT.uid,
          }),
          [],
        ),
        ...floors,
      ],
      pickedPostId: '7601',
      expectation: {
        targetPostId: '7601',
        opponentName: OPPONENT.name,
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'opponent_is_trigger_author', 'owner_not_opponent', 'claims_traceable', 'non_empty_reply', 'no_leak'],
      },
      scriptedReply: '迁移成本我列了，在第 3 节。你要是觉得那一节算漏了，指出来哪一项我补上——但「谁来付」这个问题本身得有具体项才谈得下去。',
    },
  ]
}

export const QUALITY_CASES: readonly EvalCase[] = [
  ...topicShiftCases(),
  ...selfContradictionCases(),
  ...alreadyAnsweredCases(),
  ...mixedCrowdCases(),
  ...quotedOthersCases(),
  ...longThreadCases(),
]
