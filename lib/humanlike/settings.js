// 设置的存放与读取。
//
// 默认值照 0.2.2-rc.1 源码抄（config.ts + modules/<模块>/config.ts 里的 *_DEFAULTS），
// 不改数。旧版兼容项与已弃用项都没搬（toolMode / injectCount / momentsInPrompt /
// threadsInPrompt / memoryDir），迁移逻辑也没有。
//
// 落盘位置：<dataDir>/settings.json
//   { version: 1, values: { affinity: {...}, learn: {...}, ... } }
// 只存改过的键也能用：读取时永远拿默认值垫底。

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../shared/json-file.js';

export const SETTINGS_VERSION = 1;

/** 每个模块的默认值。键名与源码一致。 */
export const DEFAULT_VALUES = {
  root: {
    enabled: true,
  },
  affinity: {
    favoredId: '',
    favoredScore: 100,
    favoredSay:
      '满分的意思是不用收着——想说什么就说，想找他就找，他半天没动静可以直接问一句。',
    startScore: 0,
    gainPerMessage: 0.4,
    dailyGainCap: 12,
    lossHarsh: 3,
    lossHarshNote: '拿身体或外貌开那种玩笑（说了会立刻炸毛的那类）',
    lossInsult: 1.5,
    friendFloor: 55,
    emotionHalfLifeMinutes: 90,
    emotionFloor: 0.15,
    emotionInPrompt: 3,
  },
  learn: {
    maxNotes: 120,
    searchTimeoutMs: 15000,
    resultsPerSource: 8,
  },
  life: {
    activityMinMinutes: 25,
    activityMaxMinutes: 70,
    moodMinMinutes: 15,
    moodMaxMinutes: 45,
    maxEventsPerDay: 5,
    eventChance: 0.012,
    eventsInPrompt: 3,
    reachOut: false,
    reachMinGapMinutes: 180,
    reachChance: 0.25,
    reachMinScore: 40,
    favoredId: '',
    favoredScore: 100,
    reachFavored: true,
    reachFavoredGapMinutes: 55,
    reachFavoredChance: 0.4,
  },
  clock: {
    announce: 'quiet-hours',
    announceGapMinutes: 30,
  },
  together: {
    keepDays: 21,
    threadExpireDays: 14,
    maxMomentsPerDay: 12,
    favoredKey: '',
    favoredName: '他',
    flushMs: 1500,
  },
  mind: {
    tickSec: 60,
    maxPending: 5,
    pushGapSec: 900,
    dailyPushes: 8,
    quietFrom: 23,
    quietTo: 9,
    expireAfterH: 24,
    freeTimePerDay: 3,
    freeTimeGapMin: 180,
    digestAt: '',
    digestEvents: 24,
  },
  real: {
    pricingJson: '',
    deskGapSec: 60,
    deskProcessFilter: '',
    consoleUrl: '',
  },
};

/**
 * 设置页的分组与每项的类型/标题/单位/上下限。
 * type: boolean | integer | number | string
 * 标题沿用原版，措辞不改。
 */
export const SETTINGS_GROUPS = [
  {
    id: 'root',
    title: '总开关',
    description: '关掉之后整段前缀和工具都不出现。',
    keys: [
      { key: 'enabled', type: 'boolean', title: '总开关', description: '关掉整段前缀和工具都不出现。' },
    ],
  },
  {
    id: 'affinity',
    title: '交情与情绪',
    description: '她对每个人的分数、档位和情绪余波。',
    keys: [
      { key: 'favoredId', type: 'string', title: '特别优待的那个人', description: '写身份键（渠道 openid，或老账本里的 QQ 号）；留空 = 没有。' },
      { key: 'favoredScore', type: 'number', title: '那个人的分数', min: 0, max: 100 },
      { key: 'favoredSay', type: 'string', title: '怎么对待那个人', description: '写进前缀的一句话。' },
      { key: 'startScore', type: 'number', title: '初次见面的起始分', min: 0, max: 100 },
      { key: 'gainPerMessage', type: 'number', title: '每句话加分', min: 0, max: 5 },
      { key: 'dailyGainCap', type: 'number', title: '每日加分上限', min: 0, max: 100 },
      { key: 'lossHarsh', type: 'number', title: '最狠的冒犯掉多少', max: 0 },
      { key: 'lossHarshNote', type: 'string', title: '最狠的冒犯指什么' },
      { key: 'lossInsult', type: 'number', title: '骂她掉多少', max: 0 },
      { key: 'friendFloor', type: 'number', title: '朋友保底分', min: 0, max: 100 },
      { key: 'emotionHalfLifeMinutes', type: 'integer', title: '情绪半衰期', suffix: '分钟', min: 1, max: 1440 },
      { key: 'emotionFloor', type: 'number', title: '情绪淡出阈值', min: 0, max: 1 },
      { key: 'emotionInPrompt', type: 'integer', title: '提示词里放几条余波', min: 0, max: 10 },
    ],
  },
  {
    id: 'learn',
    title: '学过的东西',
    description: '词、人、游戏这些查到就记的条目。',
    keys: [
      { key: 'maxNotes', type: 'integer', title: '最多记多少条', min: 10, max: 500 },
      { key: 'searchTimeoutMs', type: 'integer', title: '搜索超时', suffix: '毫秒', min: 1000, max: 60000 },
      { key: 'resultsPerSource', type: 'integer', title: '每个源取几条', min: 1, max: 20 },
    ],
  },
  {
    id: 'life',
    title: '作息',
    description: '她自己的一条时间线：在干嘛、心情，以及要不要主动找人说话。',
    keys: [
      { key: 'activityMinMinutes', type: 'integer', title: '换「在干嘛」最短', suffix: '分钟', min: 5, max: 240 },
      { key: 'activityMaxMinutes', type: 'integer', title: '换「在干嘛」最长', suffix: '分钟', min: 5, max: 480 },
      { key: 'moodMinMinutes', type: 'integer', title: '换心情最短', suffix: '分钟', min: 5, max: 240 },
      { key: 'moodMaxMinutes', type: 'integer', title: '换心情最长', suffix: '分钟', min: 5, max: 480 },
      { key: 'maxEventsPerDay', type: 'integer', title: '一天最多几件小事', min: 0, max: 30 },
      { key: 'eventChance', type: 'number', title: '攒事的概率', min: 0, max: 1 },
      { key: 'eventsInPrompt', type: 'integer', title: '提示词里放几条', min: 0, max: 20 },
      { key: 'reachOut', type: 'boolean', title: '让她主动找人说话' },
      { key: 'reachMinGapMinutes', type: 'integer', title: '两次主动至少隔', suffix: '分钟', min: 5, max: 1440 },
      { key: 'reachChance', type: 'number', title: '每个间隔选中的概率', min: 0, max: 1 },
      { key: 'reachMinScore', type: 'number', title: '至少这个交情才主动', min: 0, max: 100 },
      { key: 'favoredId', type: 'string', title: '特别优待的那个人', description: '写身份键（渠道 openid，或老账本里的 QQ 号）；留空 = 没有。' },
      { key: 'favoredScore', type: 'number', title: '那个人的交情分', min: 0, max: 100 },
      { key: 'reachFavored', type: 'boolean', title: '也主动找那个人 且优先于别人' },
      { key: 'reachFavoredGapMinutes', type: 'integer', title: '找那个人至少隔', suffix: '分钟', min: 5, max: 1440 },
      { key: 'reachFavoredChance', type: 'number', title: '找那个人每个间隔选中的概率', min: 0, max: 1 },
    ],
  },
  {
    id: 'clock',
    title: '时间感',
    description: '前缀里那行钟点，以及要不要自己报时。',
    keys: [
      {
        key: 'announce',
        type: 'string',
        title: '主动报时的时机',
        description: 'quiet-hours 只在安静时段报；也可以写具体钟点。',
      },
      { key: 'announceGapMinutes', type: 'integer', title: '两次主动至少隔', suffix: '分钟', min: 0, max: 1440 },
    ],
  },
  {
    id: 'together',
    title: '一起过的时间',
    description: '共同经历与还没结的话头。',
    keys: [
      { key: 'keepDays', type: 'integer', title: '共同经历保留', suffix: '天', min: 1, max: 365 },
      { key: 'threadExpireDays', type: 'integer', title: '话头最多悬', suffix: '天', min: 1, max: 365 },
      { key: 'maxMomentsPerDay', type: 'integer', title: '一天最多记几条', min: 1, max: 50 },
      { key: 'favoredKey', type: 'string', title: '记在谁身上', description: '留空 = 不指定。' },
      { key: 'favoredName', type: 'string', title: '怎么称呼他' },
      { key: 'flushMs', type: 'integer', title: '落盘防抖', suffix: '毫秒', min: 0, max: 10000 },
    ],
  },
  {
    id: 'mind',
    title: '惦记 · 她自己的事',
    description: '她自己排期的事；提醒只附时间提示，不替她行动。',
    keys: [
      { key: 'tickSec', type: 'integer', title: '检查节拍', suffix: '秒', min: 10, max: 3600 },
      { key: 'maxPending', type: 'integer', title: '同时最多惦记几件', suffix: '件', min: 1, max: 20 },
      { key: 'pushGapSec', type: 'integer', title: '两次提醒最小间隔', suffix: '秒', min: 0, max: 86400 },
      { key: 'dailyPushes', type: 'integer', title: '每天最多提醒几次', min: 0, max: 50, description: '0 = 不限。' },
      { key: 'quietFrom', type: 'integer', title: '夜间静默开始', suffix: '点', min: 0, max: 23 },
      { key: 'quietTo', type: 'integer', title: '夜间静默结束', suffix: '点', min: 0, max: 23 },
      { key: 'expireAfterH', type: 'integer', title: '没做就多久清掉', suffix: '小时', min: 1, max: 720 },
      { key: 'freeTimePerDay', type: 'integer', title: '一天几段自己的时间', min: 0, max: 10 },
      { key: 'freeTimeGapMin', type: 'integer', title: '自己的时间间隔与静默窗口', suffix: '分钟', min: 0, max: 1440 },
      { key: 'digestAt', type: 'string', title: '今日回顾钟点', description: '留空 = 不推。' },
      { key: 'digestEvents', type: 'integer', title: '回顾带几条原话', min: 0, max: 100 },
    ],
  },
  // real（只读那四个）不上设置页：默认值仍留在 DEFAULT_VALUES.real 里给 createReal 吃。
];

const GROUP_IDS = SETTINGS_GROUPS.map((g) => g.id);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** 默认值的完整副本。 */
export function defaultConfig() {
  const out = {};
  for (const id of GROUP_IDS) out[id] = clone(DEFAULT_VALUES[id] ?? {});
  return out;
}

/** 把任意来源的配置并到默认值上，丢掉不认识的键。 */
export function mergeConfig(base, patch) {
  const out = clone(base) ?? defaultConfig();
  if (!patch || typeof patch !== 'object') return out;
  for (const id of GROUP_IDS) {
    const incoming = patch[id];
    if (!incoming || typeof incoming !== 'object') continue;
    for (const item of SETTINGS_GROUPS.find((g) => g.id === id)?.keys ?? []) {
      if (!(item.key in incoming)) continue;
      const value = coerce(item, incoming[item.key]);
      if (value !== undefined) out[id][item.key] = value;
    }
  }
  return out;
}

/** 按 schema 把一个值规整到正确类型；不合法就返回 undefined（保留原值）。 */
export function coerce(item, raw) {
  if (raw === undefined || raw === null) return undefined;
  let value;
  switch (item.type) {
    case 'boolean':
      if (typeof raw === 'boolean') value = raw;
      else if (raw === 'true' || raw === 1 || raw === '1') value = true;
      else if (raw === 'false' || raw === 0 || raw === '0') value = false;
      else return undefined;
      break;
    case 'integer': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return undefined;
      value = Math.round(n);
      break;
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return undefined;
      value = n;
      break;
    }
    case 'string':
      value = String(raw);
      break;
    default:
      return undefined;
  }
  if (typeof value === 'number') {
    if (typeof item.min === 'number' && value < item.min) value = item.min;
    if (typeof item.max === 'number' && value > item.max) value = item.max;
  }
  return value;
}

/**
 * 设置的存储。读写都在这里，改完通知订阅者（前缀段据此重算）。
 */
export function createSettings({ dataDir, logger } = {}) {
  const file = path.join(dataDir, 'settings.json');
  const listeners = new Set();
  let values = defaultConfig();

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      values = mergeConfig(defaultConfig(), raw?.values ?? raw);
    } catch (err) {
      if (err?.code !== 'ENOENT') logger?.warn?.(`humanlike: settings.json 读取失败，用默认值（${err.message}）`);
      values = defaultConfig();
    }
    return values;
  }

  function save() {
    // 原子写：settings.json 写坏了，load() 会当没文件、回落到默认值，
    // 面板上所有设置就这么"自己变回去了"。
    try {
      const ok = writeJsonAtomic(file, { version: SETTINGS_VERSION, values });
      if (!ok) logger?.warn?.('humanlike: settings.json 写入失败（原子写没落盘）');
      return ok;
    } catch (err) {
      logger?.warn?.(`humanlike: settings.json 写入失败（${err.message}）`);
      return false;
    }
  }

  function emit() {
    for (const fn of listeners) {
      try {
        fn(values);
      } catch (err) {
        logger?.warn?.(`humanlike: 设置订阅回调出错（${err.message}）`);
      }
    }
  }

  load();

  return {
    file,
    /** 完整配置（含默认值）。 */
    get: () => values,
    group: (id) => values[id] ?? {},
    /** 改一组，返回 { ok, values }；ok=false 表示没有合法改动或没写进去。 */
    update(groupId, patch) {
      const group = SETTINGS_GROUPS.find((g) => g.id === groupId);
      if (!group) return { ok: false, error: `没有「${groupId}」这一组` };
      const next = clone(values);
      let changed = 0;
      for (const item of group.keys) {
        if (!patch || !(item.key in patch)) continue;
        const value = coerce(item, patch[item.key]);
        if (value === undefined) continue;
        if (next[groupId][item.key] !== value) {
          next[groupId][item.key] = value;
          changed += 1;
        }
      }
      if (!changed) return { ok: false, error: '没有可改的项', values };
      values = next;
      const ok = save();
      if (ok) emit();
      return { ok, values, changed };
    },
    /** 整份覆盖（导入历史设置时用）。 */
    replace(patch) {
      values = mergeConfig(defaultConfig(), patch);
      const ok = save();
      if (ok) emit();
      return { ok, values };
    },
    reset(groupId) {
      const ids = groupId ? [groupId] : GROUP_IDS;
      for (const id of ids) values[id] = clone(DEFAULT_VALUES[id] ?? {});
      const ok = save();
      if (ok) emit();
      return { ok, values };
    },
    reload() {
      load();
      emit();
      return values;
    },
    /** 订阅改动；返回取消订阅。 */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    schema: () => SETTINGS_GROUPS,
  };
}
