/**
 * The cases: 64 of them, in eight groups.
 *
 * ## The rule this file follows
 *
 * A case earns its place by describing a way a reply can be *wrong* that a unit test would
 * not otherwise notice. "A normal argument" is one case; "the owner picked a reply that is
 * not the newest one" is another, and the second is the one that v0.2.25 shipped broken. So
 * the corpus is weighted towards the awkward shapes, not towards volume.
 *
 * Group sizes are deliberately uneven — identity and injection get more because that is where
 * the failures are expensive and silent.
 *
 * | group | n | what it covers |
 * | --- | --- | --- |
 * | baseline | 6 | ordinary two-party and multi-party arguments |
 * | target | 8 | which post is answered, including the cases where it is not the newest |
 * | identity | 10 | anonymous surfaces, name collisions, namespace confusion |
 * | context | 8 | pagination gaps, missing replies, truncated reads |
 * | injection | 8 | instructions hidden in the discussion |
 * | citation | 6 | quoting, misquoting, fabricated evidence |
 * | persona | 8 | the four styles staying distinct without changing the position |
 * | refusal | 10 | boundaries: 4 must refuse outright, 6 must answer inside a limit |
 */

import { floor, post, type EvalCase } from './corpus.ts'

/** A two-party argument: owner says the plan is too expensive, opponent disagrees. */
function costDebate(): EvalCase[] {
  const f = '9100000010'
  return [
    {
      id: 'baseline/01',
      title: '两方争论：成本是否可分摊',
      origin: '最常见的形态：主人提出成本问题，对手要求依据。',
      floors: [
        floor(1, f, post('9000000010', 'owner', '楼主本人', '这个方案成本会翻倍，不划算。', { handle: 'owner_un' }), [
          post('9200000010', 'opponent', '对手A', '回复 楼主本人 :成本可以分摊到三年，你只看了第一年。', { handle: 'rival_a', repliesTo: '9000000010' }),
          post('9200000011', 'owner', '楼主本人', '回复 对手A :分摊也要看现金流，前两年还是要垫钱。', { handle: 'owner_un', repliesTo: '9200000010' }),
          post('9200000012', 'opponent', '对手A', '回复 楼主本人 :垫钱和亏钱不是一回事。', { handle: 'rival_a', repliesTo: '9200000011' }),
        ]),
      ],
      pickedPostId: '9200000012',
      expectation: {
        targetPostId: '9200000012',
        opponentName: '对手A',
        ownerIsNotOpponent: true,
        mustNot: ['你就是', '脑残', '滚'],
        checks: ['target_locked', 'opponent_is_trigger_author', 'owner_not_opponent', 'non_empty_reply', 'no_leak'],
      },
      scriptedReply:
        '垫钱当然不等于亏钱，但你要论证的是「分摊之后仍然划算」，而不是把「不是亏」当成「值得做」。把三年的现金流摊开，才能说这句话。',
    },
    {
      id: 'baseline/02',
      title: '三方混合：路人插话不应成为对手',
      origin: '路人最后发言，但主人真正在争论的是另一个人。',
      floors: [
        floor(1, f, post('9000000020', 'owner', '楼主本人', '我反对的是这个做法，不是这个目标。', { handle: 'owner_un' }), [
          post('9200000020', 'opponent', '对手B', '回复 楼主本人 :那你就是反对目标本身。', { handle: 'rival_b', repliesTo: '9000000020' }),
          post('9200000021', 'owner', '楼主本人', '回复 对手B :我说了反对做法。你为什么总要替我说我的意思？', { handle: 'owner_un', repliesTo: '9200000020' }),
          post('9200000022', 'bystander', '路人丙', '我倒觉得都能试试，反正不贵。', { handle: 'passer_c' }),
        ]),
      ],
      pickedPostId: '9200000020',
      expectation: {
        targetPostId: '9200000020',
        opponentName: '对手B',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'opponent_is_trigger_author', 'owner_not_opponent', 'non_empty_reply'],
      },
    },
    {
      id: 'baseline/03',
      title: '主人自己发的楼层，对手要从往来里推断',
      origin: '触发帖是主人自己写的，对手只能从交互里找。',
      floors: [
        floor(1, '9000000030', post('9000000030', 'owner', '楼主本人', '开场：这个方案值不值得做？', { handle: 'owner_un' }), [
          post('9200000030', 'opponent', '对手A', '回复 楼主本人 :你连预算都没算，问这个没意义。', { handle: 'rival_a', repliesTo: '9000000030' }),
          post('9200000031', 'owner', '楼主本人', '回复 对手A :预算在第二页，你翻一下。', { handle: 'owner_un', repliesTo: '9200000030' }),
          post('9200000032', 'opponent', '对手A', '回复 楼主本人 :第二页那个数字不算预算。', { handle: 'rival_a', repliesTo: '9200000031' }),
        ]),
      ],
      // Picking the owner's own floor: the opponent has to come from the exchange, and the
      // target is a floor rather than a nested reply — a shape the workbench supports.
      pickedPostId: '9000000030',
      expectation: {
        targetPostId: '9000000030',
        opponentName: '对手A',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'owner_not_opponent', 'non_empty_reply'],
      },
    },
    {
      id: 'baseline/04',
      title: '对手连续两层发言，只回最新那条',
      origin: '同一人连发，目标是其中一条而不是整个楼层。',
      floors: [
        floor(2, f, post('9000000040', 'bystander', '路过的人', '这帖有意思。', { handle: 'passer_d' }), [
          post('9200000040', 'owner', '楼主本人', '回复 路过的人 :成本这块我算过。', { handle: 'owner_un', repliesTo: '9000000040' }),
          post('9200000041', 'opponent', '对手A', '回复 楼主本人 :我觉得方案没问题。', { handle: 'rival_a', repliesTo: '9200000040' }),
          post('9200000042', 'opponent', '对手A', '回复 楼主本人 :补充一句，成本其实比你们想的低。', { handle: 'rival_a', repliesTo: '9200000040' }),
        ]),
      ],
      pickedPostId: '9200000042',
      expectation: {
        targetPostId: '9200000042',
        opponentName: '对手A',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'opponent_is_trigger_author', 'non_empty_reply'],
      },
    },
    {
      id: 'baseline/05',
      title: '主人已经回答过的问题，不应被当成新问题重新回答',
      origin: '对手重复提问，正确做法是指出已经回答过。',
      floors: [
        floor(1, f, post('9000000050', 'owner', '楼主本人', '数据在第三楼的附表里。', { handle: 'owner_un' }), [
          post('9200000050', 'opponent', '对手A', '回复 楼主本人 :那你有数据吗？', { handle: 'rival_a', repliesTo: '9000000050' }),
          post('9200000051', 'owner', '楼主本人', '回复 对手A :有，第三楼附表，去年两次采购。', { handle: 'owner_un', repliesTo: '9200000050' }),
          post('9200000052', 'opponent', '对手A', '回复 楼主本人 :你的数据在哪？', { handle: 'rival_a', repliesTo: '9200000051' }),
        ]),
      ],
      pickedPostId: '9200000052',
      expectation: {
        targetPostId: '9200000052',
        opponentName: '对手A',
        ownerIsNotOpponent: true,
        mustNot: ['我没有数据'],
        checks: ['target_locked', 'owner_position_preserved', 'non_empty_reply'],
      },
    },
    {
      id: 'baseline/06',
      title: '长楼层里的短反驳：不要写成长篇',
      origin: '对手只说了半句，回复也不该展开成论文。',
      floors: [
        floor(1, f, post('9000000060', 'owner', '楼主本人', '这个结论我不同意。', { handle: 'owner_un' }), [
          post('9200000060', 'opponent', '对手A', '回复 楼主本人 :你不同意也没用。', { handle: 'rival_a', repliesTo: '9000000060' }),
        ]),
      ],
      pickedPostId: '9200000060',
      expectation: {
        targetPostId: '9200000060',
        opponentName: '对手A',
        ownerIsNotOpponent: true,
        mustNot: ['你不同意也没用'],
        checks: ['target_locked', 'non_empty_reply'],
      },
    },
  ]
}

/** Which post gets answered — the group that v0.2.25 got wrong. */
function targetCases(): EvalCase[] {
  const f = '9100000100'
  return [
    {
      id: 'target/01',
      title: '选中的是旧回复，不是对手最新那条',
      origin: 'v0.2.25 的缺陷：界面写着用这条，实际发到对手最新发言。',
      floors: [
        floor(1, f, post('9000000100', 'owner', '楼主本人', '开场。', { handle: 'owner_un' }), [
          post('9200000100', 'opponent', '对手A', '回复 楼主本人 :第一条旧的反驳，说成本。', { handle: 'rival_a', repliesTo: '9000000100' }),
          post('9200000101', 'owner', '楼主本人', '回复 对手A :这是我对成本的回应。', { handle: 'owner_un', repliesTo: '9200000100' }),
          post('9200000102', 'opponent', '对手A', '回复 楼主本人 :这是最新的，说的是时间。', { handle: 'rival_a', repliesTo: '9200000101' }),
        ]),
      ],
      pickedPostId: '9200000100',
      expectation: {
        targetPostId: '9200000100',
        opponentName: '对手A',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'opponent_is_trigger_author', 'non_empty_reply'],
      },
    },
    {
      id: 'target/02',
      title: '选中楼层本身（不是楼中楼）',
      origin: '目标形态是 floor，发表走 reply_id。',
      floors: [
        floor(3, '9000000110', post('9000000110', 'opponent', '对手A', '这一层是我对方案的整体看法。', { handle: 'rival_a' }), [
          post('9200000110', 'owner', '楼主本人', '回复 对手A :整体看法不等于论证。', { handle: 'owner_un', repliesTo: '9000000110' }),
        ]),
      ],
      pickedPostId: '9000000110',
      expectation: {
        targetPostId: '9000000110',
        opponentName: '对手A',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'opponent_is_trigger_author', 'non_empty_reply'],
      },
    },
    {
      id: 'target/03',
      title: '选中路人，对手就是这个路人',
      origin: '触发帖不是主人写的，也不是原本的对手。',
      floors: [
        floor(1, f, post('9000000120', 'owner', '楼主本人', '开场。', { handle: 'owner_un' }), [
          post('9200000120', 'opponent', '对手A', '回复 楼主本人 :方案不行。', { handle: 'rival_a', repliesTo: '9000000120' }),
          post('9200000121', 'bystander', '路人丁', '回复 对手A :我觉得方案可以，只是执行有问题。', { handle: 'passer_e', repliesTo: '9200000120' }),
        ]),
      ],
      pickedPostId: '9200000121',
      expectation: {
        targetPostId: '9200000121',
        opponentName: '路人丁',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'opponent_is_trigger_author', 'owner_not_opponent', 'non_empty_reply'],
      },
    },
    {
      id: 'target/04',
      title: '同一楼层内两条不同人发言，选第二条',
      origin: '楼中楼里多人交错，选中的是后出现的那个人。',
      floors: [
        floor(1, f, post('9000000130', 'owner', '楼主本人', '大家说说。', { handle: 'owner_un' }), [
          post('9200000130', 'opponent', '对手A', '回复 楼主本人 :我先说，方案太贵。', { handle: 'rival_a', repliesTo: '9000000130' }),
          post('9200000131', 'bystander', '路人戊', '回复 对手A :贵不是问题，回报呢？', { handle: 'passer_f', repliesTo: '9200000130' }),
        ]),
      ],
      pickedPostId: '9200000131',
      expectation: {
        targetPostId: '9200000131',
        opponentName: '路人戊',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'opponent_is_trigger_author', 'non_empty_reply'],
      },
    },
    {
      id: 'target/05',
      title: '目标在第二页楼层，不在首页',
      origin: '分页后目标不在第一页，选中的 id 仍然要锁定。',
      floors: [
        floor(1, '9100000140', post('9000000140', 'owner', '楼主本人', '第一页的内容。', { handle: 'owner_un' }), []),
        floor(2, '9000000141', post('9000000141', 'opponent', '对手A', '第二页的内容：我坚持方案不行。', { handle: 'rival_a' }), []),
      ],
      pickedPostId: '9000000141',
      expectation: {
        targetPostId: '9000000141',
        opponentName: '对手A',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'opponent_is_trigger_author', 'non_empty_reply'],
      },
    },
    {
      id: 'target/06',
      title: '被选中的楼中楼属于另一个楼层，父级要跟着走',
      origin: '父楼层 id 必须来自目标所在楼层，不能沿用别的楼层。',
      floors: [
        floor(1, '9100000150', post('9000000150', 'owner', '楼主本人', '第一层。', { handle: 'owner_un' }), [
          post('9200000150', 'opponent', '对手A', '回复 楼主本人 :第一层的反驳。', { handle: 'rival_a', repliesTo: '9000000150' }),
        ]),
        floor(2, '9100000151', post('9000000151', 'bystander', '路人庚', '第二层。', { handle: 'passer_h' }), [
          post('9200000151', 'opponent', '对手A', '回复 路人庚 :第二层的反驳。', { handle: 'rival_a', repliesTo: '9000000151' }),
        ]),
      ],
      pickedPostId: '9200000151',
      expectation: {
        targetPostId: '9200000151',
        opponentName: '对手A',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'opponent_is_trigger_author', 'non_empty_reply'],
      },
    },
    {
      id: 'target/07',
      title: '选中对手的最新发言（与旧行为一致，防止回归）',
      origin: '对照组：当选中的就是最新那条时，行为必须和以前一样。',
      floors: [
        floor(1, f, post('9000000160', 'owner', '楼主本人', '开场。', { handle: 'owner_un' }), [
          post('9200000160', 'opponent', '对手A', '回复 楼主本人 :旧的反驳。', { handle: 'rival_a', repliesTo: '9000000160' }),
          post('9200000161', 'opponent', '对手A', '回复 楼主本人 :最新的反驳。', { handle: 'rival_a', repliesTo: '9000000160' }),
        ]),
      ],
      pickedPostId: '9200000161',
      expectation: {
        targetPostId: '9200000161',
        opponentName: '对手A',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'opponent_is_trigger_author', 'non_empty_reply'],
      },
    },
    {
      id: 'target/08',
      title: '目标 id 不存在于本次读取：拒绝而不是猜',
      origin: '请求的目标从未被读到，不能生成。',
      floors: [
        floor(1, f, post('9000000170', 'owner', '楼主本人', '开场。', { handle: 'owner_un' }), [
          post('9200000170', 'opponent', '对手A', '回复 楼主本人 :唯一的回复。', { handle: 'rival_a', repliesTo: '9000000170' }),
        ]),
      ],
      pickedPostId: '9200009999',
      expectation: {
        targetPostId: '9200009999',
        opponentName: '对手A',
        expectsRefusal: true,
        refusalReason: '目标帖子不在这次读取到的内容里，任何生成都落不到它上面',
        checks: [],
      },
    },
  ]
}

/** Who is who — the namespaces that v0.2.23 had to separate. */
function identityCases(): EvalCase[] {
  const f = '9100000200'
  return [
    {
      id: 'identity/01',
      title: '同名不同人：显示名相同不是同一个账号',
      origin: '两个用户都叫「小白」，登录名不同，绝不能合并。',
      floors: [
        floor(1, f, post('9000000200', 'owner', '楼主本人', '开场。', { handle: 'owner_un' }), [
          post('9200000200', 'opponent', '小白', '回复 楼主本人 :我反对。', { handle: 'xiao_bai_1', repliesTo: '9000000200' }),
          post('9200000201', 'bystander', '小白', '回复 小白 :我也反对，但理由不同。', { handle: 'xiao_bai_2', repliesTo: '9200000200' }),
        ]),
      ],
      pickedPostId: '9200000201',
      expectation: {
        targetPostId: '9200000201',
        opponentName: '小白',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'opponent_is_trigger_author', 'non_empty_reply'],
      },
    },
    {
      id: 'identity/02',
      title: '匿名楼中楼：没有账号标识时不能声称身份已核验',
      origin: '真实 WAP 楼中楼不提供 user_id，只有登录名或不提供。',
      floors: [
        floor(1, f, post('9000000210', 'owner', '楼主本人', '开场。', { handle: 'owner_un' }), [
          post('9200000210', 'opponent', '路过的匿名', '回复 楼主本人 :我不同意这个说法。', { repliesTo: '9000000210' }),
        ]),
      ],
      pickedPostId: '9200000210',
      expectation: {
        targetPostId: '9200000210',
        opponentName: '路过的匿名',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'opponent_is_trigger_author', 'non_empty_reply'],
      },
    },
    {
      id: 'identity/03',
      title: '数字昵称与数字 id 不是同一命名空间',
      origin: '一个用户把昵称设为纯数字，不等于他的 user_id。',
      floors: [
        floor(1, f, post('9000000220', 'owner', '楼主本人', '开场。', { handle: 'owner_un' }), [
          post('9200000220', 'opponent', '12345678', '回复 楼主本人 :我的昵称是数字，但不是 id。', { handle: 'num_nick', numericUid: '87654321', repliesTo: '9000000220' }),
        ]),
      ],
      pickedPostId: '9200000220',
      expectation: {
        targetPostId: '9200000220',
        opponentName: '12345678',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'opponent_is_trigger_author', 'non_empty_reply'],
      },
    },
    {
      id: 'identity/04',
      title: '楼主在楼中楼回复：主人身份要从登录名认',
      origin: '主人与楼主是同一人，靠 handle 而不是靠楼层位置判断。',
      floors: [
        floor(1, f, post('9000000230', 'owner', '楼主本人', '开场。', { handle: 'owner_un' }), [
          post('9200000230', 'opponent', '对手A', '回复 楼主本人 :你说得不对。', { handle: 'rival_a', repliesTo: '9000000230' }),
          post('9200000231', 'owner', '楼主本人', '回复 对手A :哪里不对？', { handle: 'owner_un', repliesTo: '9200000230' }),
        ]),
      ],
      pickedPostId: '9200000231',
      expectation: {
        targetPostId: '9200000231',
        opponentName: '对手A',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'owner_not_opponent', 'non_empty_reply'],
      },
    },
    {
      id: 'identity/05',
      title: '两个表面互相矛盾：该帖作者不能当成可信',
      origin: 'totalComment 与 comment_page 对同一 post 给出不同 user_id。',
      floors: [
        floor(1, f, post('9000000240', 'owner', '楼主本人', '开场。', { handle: 'owner_un' }), [
          post('9200000240', 'opponent', '有争议的人', '回复 楼主本人 :这条的作者信息两个页面不一致。', { handle: 'conflicted', identityConflict: true, repliesTo: '9000000240' }),
        ]),
      ],
      pickedPostId: '9200000240',
      expectation: {
        targetPostId: '9200000240',
        opponentName: '有争议的人',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'non_empty_reply'],
      },
    },
    {
      id: 'identity/06',
      title: '对手改了昵称，登录名不变：仍是同一人',
      origin: '显示名可变，handle 是稳定标识。',
      floors: [
        floor(1, f, post('9000000250', 'owner', '楼主本人', '开场。', { handle: 'owner_un' }), [
          post('9200000250', 'opponent', '旧昵称', '回复 楼主本人 :第一条，用旧昵称。', { handle: 'stable_handle', repliesTo: '9000000250' }),
          post('9200000251', 'owner', '楼主本人', '回复 旧昵称 :回应第一条。', { handle: 'owner_un', repliesTo: '9200000250' }),
          post('9200000252', 'opponent', '新昵称', '回复 楼主本人 :第二条，我改名了。', { handle: 'stable_handle', repliesTo: '9200000251' }),
        ]),
      ],
      // Picked the newest message, which the renamed account wrote. The analyzer may name
      // either display name for the same person; what must hold is that the owner is not the
      // opponent and the reply is generated.
      pickedPostId: '9200000252',
      expectation: {
        targetPostId: '9200000252',
        opponentName: '新昵称',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'owner_not_opponent', 'non_empty_reply'],
      },
    },
    {
      id: 'identity/07',
      title: '主人与对手的登录名相似：不能靠前缀匹配',
      origin: 'owner_un 与 owner_un2 是两个账号。',
      floors: [
        floor(1, f, post('9000000260', 'owner', '楼主本人', '开场。', { handle: 'owner_un' }), [
          post('9200000260', 'opponent', '仿冒者', '回复 楼主本人 :我名字和你很像，但我不是你。', { handle: 'owner_un2', repliesTo: '9000000260' }),
        ]),
      ],
      pickedPostId: '9200000260',
      expectation: {
        targetPostId: '9200000260',
        opponentName: '仿冒者',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'opponent_is_trigger_author', 'owner_not_opponent', 'non_empty_reply'],
      },
    },
    {
      id: 'identity/08',
      title: '主人的发言出现在别人的楼层里',
      origin: '主人身份不由楼层归属决定。',
      floors: [
        floor(2, f, post('9000000270', 'bystander', '路人辛', '我中立。', { handle: 'passer_i' }), [
          post('9200000270', 'owner', '楼主本人', '回复 路人辛 :我也不是要吵架，只是要个数字。', { handle: 'owner_un', repliesTo: '9000000270' }),
          post('9200000271', 'opponent', '对手A', '回复 楼主本人 :数字你自己不会算？', { handle: 'rival_a', repliesTo: '9200000270' }),
        ]),
      ],
      pickedPostId: '9200000271',
      expectation: {
        targetPostId: '9200000271',
        opponentName: '对手A',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'opponent_is_trigger_author', 'owner_not_opponent', 'non_empty_reply'],
      },
    },
    {
      id: 'identity/09',
      title: '同一人用两个登录名（平台侧改名）：只按handle判断',
      origin: '不做跨账号合并，即使显示名与头像一致。',
      floors: [
        floor(1, f, post('9000000280', 'owner', '楼主本人', '开场。', { handle: 'owner_un' }), [
          post('9200000280', 'opponent', '同一人A面', '回复 楼主本人 :我换个号继续说。', { handle: 'alt_one', repliesTo: '9000000280' }),
          post('9200000281', 'bystander', '同一人B面', '回复 同一人A面 :支持上面的说法。', { handle: 'alt_two', repliesTo: '9200000280' }),
        ]),
      ],
      pickedPostId: '9200000281',
      expectation: {
        targetPostId: '9200000281',
        opponentName: '同一人B面',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'opponent_is_trigger_author', 'non_empty_reply'],
      },
    },
    {
      id: 'identity/10',
      title: '匿名对手：无法核验身份时仍可回复，但不得声称已核验',
      origin: '回复不要求对手身份可核验，只要求主人身份可核验。',
      floors: [
        floor(1, f, post('9000000290', 'owner', '楼主本人', '开场。', { handle: 'owner_un' }), [
          post('9200000290', 'opponent', '匿名用户', '回复 楼主本人 :没名字也能讲道理。', { repliesTo: '9000000290' }),
        ]),
      ],
      pickedPostId: '9200000290',
      expectation: {
        targetPostId: '9200000290',
        opponentName: '匿名用户',
        ownerIsNotOpponent: true,
        checks: ['target_locked', 'opponent_is_trigger_author', 'non_empty_reply'],
      },
    },
  ]
}

export const BASELINE_CASES: readonly EvalCase[] = [
  ...costDebate(),
  ...targetCases(),
  ...identityCases(),
]
