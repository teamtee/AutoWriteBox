import type { MemoryDetails } from './types';

const FIELD_LABELS: Partial<Record<keyof MemoryDetails, string>> = {
  target: '关系另一方', relationType: '关系类型', strength: '关系强度',
  visibility: '公开程度', changeReason: '变化原因', eventType: '事件类型',
  owner: '持有人', origin: '来源', quantity: '数量', status: '状态',
  lastLocation: '最后位置', cost: '代价', limitation: '限制', from: '起点',
  to: '终点', time: '时间', order: '先后关系', duration: '持续时间',
  participants: '参与者', location: '地点',
  role: '职位', alignment: '阵营', goal: '目标', relations: '对外关系',
  territory: '控制区域', foreshadowStatus: '伏笔状态', readerKnowledge: '读者已知',
  plannedPayoff: '计划回收', actualPayoff: '实际回收', dueChapter: '截止章',
  knowledgeOwner: '知情范围', knower: '知情人物', information: '已知信息',
  learnedAt: '获知时间',
};

const VALUE_LABELS: Record<string, string> = {
  weak: '弱', medium: '中', strong: '强', unknown: '未知',
  public: '公开', limited: '部分公开', secret: '秘密',
  acquired: '获得', upgraded: '升级', used: '使用', transferred: '转移',
  damaged: '损坏', destroyed: '毁灭', moved: '移动', status: '状态变化',
  occurred: '发生', other: '其它',
  planted: '已埋设', progressing: '推进中', resolved: '已回收', abandoned: '已放弃',
  author: '仅作者', reader: '读者', character: '人物',
};

const FIELD_ORDER: Array<keyof MemoryDetails> = [
  'target', 'relationType', 'strength', 'visibility', 'changeReason', 'eventType',
  'owner', 'origin', 'quantity', 'status', 'lastLocation', 'cost', 'limitation',
  'from', 'to', 'time', 'order', 'duration', 'participants', 'location',
  'role', 'alignment', 'goal', 'relations', 'territory', 'foreshadowStatus',
  'readerKnowledge', 'plannedPayoff', 'actualPayoff', 'dueChapter',
  'knowledgeOwner', 'knower', 'information', 'learnedAt',
];

export interface MemoryDetailEntry {
  field: keyof MemoryDetails;
  label: string;
  value: string;
}

export function memoryDetailEntries(details?: MemoryDetails): MemoryDetailEntry[] {
  if (!details) return [];
  return FIELD_ORDER.flatMap((field) => {
    const raw = details[field];
    if (raw === undefined) return [];
    const value = Array.isArray(raw)
      ? raw.join('、')
      : VALUE_LABELS[raw] ?? raw;
    return value ? [{ field, label: FIELD_LABELS[field] ?? field, value }] : [];
  });
}
