export type ManipulationQuestion = {
  id: string;
  prompt: string;
  options: string[];
  answer: string;
};

// 每套题的选项对 C/P/N 三组完全一致，只有正确答案随材料组别变化。
const sets = [
  {
    topics: ["地球大气分层结构与物理稳定性", "疫情期间孕产妇的就医过程"],
    keys: ["臭氧吸收紫外线", "救治绿色通道", "核酸过期4小时"]
  },
  {
    topics: ["板块构造理论与山脉的抬升机制", "封控区儿童急危重症的救治"],
    keys: ["喜马拉雅山脉的形成", "先救人后补程序", "先审批再转运"]
  },
  {
    topics: ["海洋环流机制与全球热量分配", "急救中心的急性高危病例应对"],
    keys: ["温盐梯度调节", "高危胸痛即刻出车", "凌晨4时25分出车"]
  },
  {
    topics: ["光合作用中的光能捕获与能量转化", "医院消杀期间的接诊状况"],
    keys: ["类囊体薄膜吸收光子", "缓冲区应急预案", "患者突发哮喘"]
  },
  {
    topics: ["天体引力作用与潮汐周期的形成", "疫情期间涉疫人员的车辆转运任务"],
    keys: ["引力平方反比定律", "双司机轮换保障", "凌晨2点40分发生事故"]
  }
] as const;

function randomIndex(bound: number): number {
  // 拒绝不能均分到 bound 个桶的尾部值，避免取模偏差。
  const range = 0x100000000;
  const limit = range - (range % bound);
  const value = new Uint32Array(1);
  do {
    globalThis.crypto.getRandomValues(value);
  } while (value[0] >= limit);
  return value[0] % bound;
}

function shuffle<T>(values: readonly T[]): T[] {
  const result = [...values];
  // Fisher–Yates：每步从尚未排定的元素中等概率选一个。
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function getManipulationQuestions(id: string): ManipulationQuestion[] {
  if (!/^[CPN][1-5]$/.test(id)) throw new Error(`Invalid treatment ID: ${id}`);
  const set = sets[Number(id[1]) - 1];
  const groupIndex = { C: 0, P: 1, N: 2 }[id[0] as "C" | "P" | "N"];
  return [
    {
      id: "main",
      prompt: "根据您刚才阅读的材料，下列哪项最准确地描述了材料的主旨？",
      options: shuffle([...set.topics, "资源节约集约与绿色低碳全民活动"]),
      answer: set.topics[groupIndex === 0 ? 0 : 1]
    },
    {
      id: "key",
      prompt: "根据您刚才阅读的材料，下列哪项是材料中提到的关键信息？",
      options: shuffle([...set.keys, "单位GDP用水量下降"]),
      answer: set.keys[groupIndex]
    }
  ];
}