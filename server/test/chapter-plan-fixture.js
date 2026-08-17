export function validChapterPlanFixture(overrides = {}) {
  return {
    qualityProtocolVersion: 3,
    designProtocolVersion: 1,
    rhythmIntentVersion: 1,
    rhythmIntent: {
      pressurePattern: 'false-relief', resolutionMethod: 'wit', payoffScale: 'chapter',
      hookMechanism: 'unfinished-action', costType: 'relationship',
    },
    goal: '主角取得本章目标', obstacle: '既有制度和对手共同阻拦',
    choice: '主角主动暴露一项资源换取通路', payoff: '目标取得但局势留下新代价',
    hook: '本章行动造成的未完后果逼近',
    tensionArc: '压力来源：期限与对手逼近；变化链：入口被封→旧办法暂时打开通路→行动暴露引来反制；选择高点：主角暴露资源换取机会；兑现与余波：取得目标但追踪范围扩大',
    foreshadowing: '无埋点理由：本章专注兑现上一场行动后果，不额外制造谜团；本章聚焦：主角主动跨过当前阻碍并承担代价；既有未知处理：原有幕后身份保持未知，不新增假证据也不提前揭示',
    worldExpansion: '展开前认知：主角与读者只知道本地规则会核验身份；既有依据：已经成立的身份制度；可验证证据：旧凭证触发跨区警报；边界增量/机制深化：确认本地核验与上级系统相连；选择与代价：主角仍使用凭证并暴露行踪；保留未知：不揭示上级系统的控制者',
    decisionChain: '当前误判/未决：主角以为旧凭证仍能安全通行；验证/争取行动：主角主动刷旧凭证换取入口；利益受损者：封锁系统负责人失去对入口的控制；针对性反制：负责人依据凭证签名启动跨区追踪；状态改写：主角持有隐蔽通路→主角打开通路但位置暴露；后续索债：主角必须在追踪合围前带证人离开',
    knowledgeDesign: '当前问题：旧凭证是否仍是安全资源；可见依据：闸机先放行后触发跨区警报；允许结论：凭证仍能开门但已被中央追踪；替代解释：凭证本身被标记｜闸机已更换统一审计规则；交叉验证：闸机日志＋巡逻终端的同一警报编号；保留未知：不确认是谁下令标记凭证',
    notes: '',
    scenes: [{
      title: '跨过门槛', trigger: '承接上一章未完行动或本章直接诱因',
      desire: '主角立即取得目标', obstacle: '现场规则与对手同时阻拦',
      action: '主角使用已有资源改变局面', turn: '通路打开但追踪被激活',
      cost: '主角的位置和资源暴露',
    }],
    ...overrides,
  };
}
