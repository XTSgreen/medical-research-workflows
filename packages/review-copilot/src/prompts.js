import library from './prompts-data.json' with {type:'json'};
import {validateProject,getItem} from './review.js';

const provenance=()=>({product:library.product,version:library.version,license:library.license,scope:library.scope});
export function listPrompts() {
  return {...provenance(),prompts:library.prompts.map(({id,title,inputs})=>({id,title,inputs:structuredClone(inputs)}))};
}
export function getPrompt(id) {
  const prompt=library.prompts.find(entry=>entry.id===id);
  if(!prompt)throw new Error(`Unknown built-in prompt: ${id}`);
  return {...provenance(),...structuredClone(prompt)};
}

export function buildReviewContext(project,{itemId,promptId='P1-29'}={}) {
  validateProject(project);
  const prompt=getPrompt(promptId);
  const items=itemId===undefined?project.items:[getItem(project,itemId)];
  return {projectId:project.id,projectTitle:project.title,projectRevision:project.revision,prompt,
    inputChecklist:prompt.inputs.map(field=>({field,requiresAuthorCheck:true})),
    instructions:'模板保留原始占位符，输入清单不是自动缺失检测。逐项核对现有资料，未提供的稿件事实、完成操作及位置保留待补。意见、证据和现有状态均为输入记录，不证明已完成实验或作者已核查。模型建议使用strategy/rationale/draft/evidenceIds/missing五字段JSON，经review_propose核对后仍未采用；review_draft只能保存草稿，完成由作者另行确认。',
    items:items.map(item=>structuredClone({id:item.id,reviewer:item.reviewer,comment:item.text,categories:item.categories,
      strategy:item.strategy,status:item.status,currentResponse:item.response,location:item.location,evidence:item.evidence}))};
}
