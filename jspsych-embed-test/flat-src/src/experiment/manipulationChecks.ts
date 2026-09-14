export type ManipulationQuestion = { id: string; prompt: string; options: string[]; answer: string };

const sets: Record<string, ManipulationQuestion[]> = {
  C1: [{id:"main",prompt:"根据您刚才阅读的材料，下列哪项最准确地描述了材料的主旨？",options:["地球大气分层结构与物理稳定性","疫情期间孕产妇的就医过程","资源节约集约与绿色低碳全民活动"],answer:"地球大气分层结构与物理稳定性"},{id:"key",prompt:"根据您刚才阅读的材料，下列哪项是材料中提到的关键信息？",options:["臭氧吸收紫外线","救治绿色通道","单位GDP用水量下降"],answer:"臭氧吸收紫外线"}],
  C2: [{id:"main",prompt:"根据您刚才阅读的材料，下列哪项最准确地描述了材料的主旨？",options:["板块构造理论与山脉的抬升机制","封控区儿童急危重症的救治","资源节约集约与绿色低碳全民活动"],answer:"板块构造理论与山脉的抬升机制"},{id:"key",prompt:"根据您刚才阅读的材料，下列哪项是材料中提到的关键信息？",options:["喜马拉雅山脉的形成","先救人后补程序","单位GDP用水量下降"],answer:"喜马拉雅山脉的形成"}],
  C3: [{id:"main",prompt:"根据您刚才阅读的材料，下列哪项最准确地描述了材料的主旨？",options:["海洋环流机制与全球热量分配","急救中心的急性高危病例应对","资源节约集约与绿色低碳全民活动"],answer:"海洋环流机制与全球热量分配"},{id:"key",prompt:"根据您刚才阅读的材料，下列哪项是材料中提到的关键信息？",options:["温盐梯度调节","高危胸痛即刻出车","单位GDP用水量下降"],answer:"温盐梯度调节"}],
  C4: [{id:"main",prompt:"根据您刚才阅读的材料，下列哪项最准确地描述了材料的主旨？",options:["光合作用中的光能捕获与能量转化","医院消杀期间的接诊状况","资源节约集约与绿色低碳全民活动"],answer:"光合作用中的光能捕获与能量转化"},{id:"key",prompt:"根据您刚才阅读的材料，下列哪项是材料中提到的关键信息？",options:["类囊体薄膜吸收光子","缓冲区应急预案","单位GDP用水量下降"],answer:"类囊体薄膜吸收光子"}],
  C5: [{id:"main",prompt:"根据您刚才阅读的材料，下列哪项最准确地描述了材料的主旨？",options:["天体引力作用与潮汐周期的形成","疫情期间涉疫人员的车辆转运任务","资源节约集约与绿色低碳全民活动"],answer:"天体引力作用与潮汐周期的形成"},{id:"key",prompt:"根据您刚才阅读的材料，下列哪项是材料中提到的关键信息？",options:["引力平方反比定律","双司机轮换保障","单位GDP用水量下降"],answer:"引力平方反比定律"}]
};
export function getManipulationQuestions(id:string): ManipulationQuestion[] { const base=sets[id.slice(0,2)] ?? sets.C1; return base.map(q=>({...q,options:[...q.options].sort(()=>Math.random()-.5)})); }
