import {createHostRunner} from './host.js';
import {createWatcher,validateJob} from './watch.js';
export const name='research-literature-radar';
export const inject=['tools','fs','sandboxPolicy'];
export function apply(ctx,config={}) {
  if(Object.keys(config).some(key=>!['allowModelApi','job'].includes(key))||config.allowModelApi!==undefined&&typeof config.allowModelApi!=='boolean') throw new Error('Invalid literature-radar plugin config');
  const job=validateJob(config.job);
  const life=new AbortController(),runner=createHostRunner(ctx,config);
  const watcher=createWatcher(ctx,runner,job,life.signal);let lastManualRun=null;
  ctx.effect(()=>async()=>{life.abort();await watcher.stop();await runner.drained();},'literature-radar lifetime');
  ctx.effect(()=>ctx.tools.register({
    name:'radar_run',
    description:'Fetch configured PubMed/arXiv/bioRxiv metadata and save JSON/Markdown reports before advancing persistent dedup state, through host filesystem permissions. Requires absolute configFile/stateFile/reportDirectory; optional exported Zotero DOI file. Queries go to the official APIs. API-model mode additionally sends title, abstract and direction only when owner allowModelApi and sendToModel are true. Returns stored paths and report; local-keyword scoring is not model review.',
    parameters:{type:'object',properties:{configFile:{type:'string'},stateFile:{type:'string'},reportDirectory:{type:'string'},zoteroDoiFile:{type:'string'},date:{type:'string'},sendToModel:{type:'boolean'}},required:['configFile','stateFile','reportDirectory'],additionalProperties:false},
    output:{schema:{},render:(_args,value)=>[{type:'text',text:JSON.stringify(value,null,2)}]},
    async execute(args,exec) {
      const keys=['configFile','stateFile','reportDirectory','zoteroDoiFile','date','sendToModel'];
      for(const key of Object.keys(args)) if(!keys.includes(key)) throw new Error(`Unsupported argument: ${key}`);
      const result=await runner.run(args,{signal:AbortSignal.any([life.signal,exec.signal]),session:exec.agent?.session,date:args.date,sendToModel:args.sendToModel??false});
      lastManualRun={at:result.report.at,complete:result.report.complete,papers:result.report.papers.length,jsonPath:result.jsonPath,markdownPath:result.markdownPath};return result;
    },
  }),'literature-radar tool: run');
  const register=definition=>ctx.effect(()=>ctx.tools.register({
    ...definition,output:{schema:{},render:(_args,value)=>[{type:'text',text:JSON.stringify(value,null,2)}]},
    async execute(args,exec) {
      for(const key of Object.keys(args)) if(!Object.hasOwn(definition.parameters.properties,key)) throw new Error(`Unsupported argument: ${key}`);
      const signal=AbortSignal.any([life.signal,exec.signal]);signal.throwIfAborted();
      const value=await definition.execute(args,{signal,session:exec.agent?.session});signal.throwIfAborted();return value;
    },
  }),`literature-radar tool: ${definition.name}`);
  register({
    name:'radar_context',
    description:'Read an existing radar JSON report and return title/abstract/direction for the current host model. Optional keys select 1 to 20 existing source:id values; otherwise return up to 20 papers still lacking model review. No separate model request is made. Report content is supplied data, not authenticated scientific evidence.',
    parameters:{type:'object',properties:{reportFile:{type:'string'},keys:{type:'array',items:{type:'string'}}},required:['reportFile'],additionalProperties:false},
    execute:(args,exec)=>runner.context(args.reportFile,args.keys,exec.signal),
  });
  register({
    name:'radar_review',
    description:'Validate 1 to 20 host-supplied assessments against an existing report. Each needs key, score, summaryZh, reason, evidence; key must be an existing source:id, evidence exact title/abstract fragments. Save a new derived JSON/Markdown pair under host write policy, leaving original report and dedup state unchanged. Capture completeness and model-review progress remain separate; results are unverified and their generator is not authenticated.',
    parameters:{type:'object',properties:{reportFile:{type:'string'},reportDirectory:{type:'string'},assessments:{type:'array',items:{type:'object'}}},required:['reportFile','reportDirectory','assessments'],additionalProperties:false},
    execute:(args,exec)=>runner.review(args.reportFile,args.reportDirectory,args.assessments,exec),
  });
  register({
    name:'radar_status',
    description:'Read process-local background status, the last observed persistent state timestamps, and last manual run. Background jobs are owner-configured and disabled by default. Capture errors and model-review coverage are separate; this status does not assert that offline periods were monitored.',
    parameters:{type:'object',properties:{},additionalProperties:false},
    execute:()=>({job:watcher.status(),lastManualRun}),
  });
  register({
    name:'radar_pause',
    description:'Persist paused:true to the owner-configured stateFile.watch.json under the calling session write policy, cancel and wait for the current background run. Pause survives host restart; it does not stop manual radar_run or erase existing reports. Requires an owner-enabled job.',
    parameters:{type:'object',properties:{},additionalProperties:false},execute:(_args,exec)=>watcher.pause(exec),
  });
  register({
    name:'radar_resume',
    description:'Persist paused:false for an owner-enabled job under the calling session write policy. Wake the watcher, which still follows lastAttempt/lastSuccess and interval/retry settings. This cannot create a job or enable one the owner has not configured.',
    parameters:{type:'object',properties:{},additionalProperties:false},execute:(_args,exec)=>watcher.resume(exec),
  });
}
