import {setTimeout as delay} from 'node:timers/promises';
import {nextRunDelay} from './radar.js';
import {validatePaths} from './host.js';

export function validateJob(input) {
  if(input===undefined) return null;
  if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.enabled!=='boolean') throw new Error('job requires an explicit boolean enabled');
  const allowed=['enabled','configFile','stateFile','reportDirectory','zoteroDoiFile','intervalSeconds','retrySeconds','sendToModel'];
  for(const key of Object.keys(input)) if(!allowed.includes(key)) throw new Error(`Unknown job field: ${key}`);
  const job={...input,intervalSeconds:input.intervalSeconds??86400,retrySeconds:input.retrySeconds??300,sendToModel:input.sendToModel??false};
  nextRunDelay({lastAttempt:null,lastSuccess:null},job.intervalSeconds,job.retrySeconds);
  if(typeof job.sendToModel!=='boolean') throw new Error('job.sendToModel must be boolean');
  if(job.enabled) validatePaths(job);
  return job;
}
export function createWatcher(ctx,runner,job,lifeSignal) {
  const controller=new AbortController(),signal=AbortSignal.any([lifeSignal,controller.signal]);
  const state={configured:!!job,enabledConfigured:!!job?.enabled,active:!!job?.enabled,paused:null,running:false,nextRunAt:null,lastAttemptAt:null,lastCompletedAt:null,lastOutcome:null,error:null,intervalSeconds:job?.intervalSeconds??null,retrySeconds:job?.retrySeconds??null,controlFile:job?.enabled?`${job.stateFile}.watch.json`:null,stateLastAttempt:null,stateLastSuccess:null};
  let wakeGeneration=0,waiter=null,currentRun=null,runAbort=null;
  const wake=()=>{wakeGeneration++;waiter?.abort();};
  async function wait(ms,generation) {
    if(generation!==wakeGeneration) return;
    const tick=new AbortController();waiter=tick;
    try {await delay(ms,undefined,{signal:AbortSignal.any([signal,tick.signal])});}
    catch(error) {if(signal.aborted) throw error;}
    finally {if(waiter===tick) waiter=null;}
  }
  function controlValue(file) {
    if(file.text===null) return {schemaVersion:1,paused:false};
    const data=runner.parse(file);
    if(data?.schemaVersion!==1||typeof data.paused!=='boolean') throw new Error('Invalid radar watch control file');
    return data;
  }
  async function loop() {
    try {
      while(!signal.aborted) {
        const generation=wakeGeneration;
        try {
          const control=controlValue(await runner.read(state.controlFile,signal,{optional:true,maxBytes:1_000_000}));
          if(generation!==wakeGeneration) continue;
          state.paused=control.paused;
          if(state.paused) {state.nextRunAt=null;await wait(60000,generation);continue;}
          const snapshot=await runner.snapshot(job,signal);
          if(generation!==wakeGeneration) continue;
          state.stateLastAttempt=snapshot.state.lastAttempt;state.stateLastSuccess=snapshot.state.lastSuccess;
          const remaining=nextRunDelay(snapshot.state,job.intervalSeconds,job.retrySeconds);
          state.nextRunAt=new Date(Date.now()+remaining).toISOString();
          if(remaining>0) {await wait(Math.min(remaining,60000),generation);continue;}
          state.running=true;state.lastAttemptAt=new Date().toISOString();runAbort=new AbortController();
          currentRun=runner.run(job,{signal:AbortSignal.any([signal,runAbort.signal]),sendToModel:job.sendToModel});
          const result=await currentRun;
          state.lastCompletedAt=new Date().toISOString();
          state.lastOutcome={complete:result.report.complete,captureComplete:result.report.captureComplete,modelReview:result.report.modelReview,papers:result.report.papers.length,errors:result.report.errors.length,excluded:result.report.excluded,jsonPath:result.jsonPath,markdownPath:result.markdownPath};
          state.stateLastAttempt=result.nextState.lastAttempt;state.stateLastSuccess=result.nextState.lastSuccess;state.error=null;
        } catch(error) {
          state.running=false;
          if(signal.aborted) break;
          if(!runAbort?.signal.aborted) {
            state.error=error.message;state.nextRunAt=new Date(Date.now()+job.retrySeconds*1000).toISOString();
            await wait(job.retrySeconds*1000,generation);
          }
        } finally {state.running=false;currentRun=null;runAbort=null;}
      }
    } finally {state.active=false;state.running=false;state.nextRunAt=null;}
  }
  const task=job?.enabled?loop().catch(error=>{if(!signal.aborted) state.error=error.message;state.active=false;}):Promise.resolve();
  async function setPaused(paused,{signal:callSignal,session}={}) {
    if(!job?.enabled) throw new Error('No owner-enabled background job is configured');
    const file=await runner.read(state.controlFile,callSignal,{optional:true,maxBytes:1_000_000});
    controlValue(file);
    const configTarget=await ctx.fs.resolve(job.configFile,{signal:callSignal}),stateTarget=await ctx.fs.resolve(job.stateFile,{signal:callSignal});
    if([configTarget.targetKey,stateTarget.targetKey].includes(file.target.targetKey)) throw new Error('Watch control must not overwrite config or dedup state');
    const policy=await runner.writable([file.target],session,callSignal);
    await ctx.fs.writeText(file.target,JSON.stringify({schemaVersion:1,paused,updatedAt:new Date().toISOString()},null,2)+'\n',file.expected,callSignal,policy);
    state.paused=paused;
    const pending=currentRun;
    if(paused) {runAbort?.abort();state.nextRunAt=null;}
    wake();
    if(paused&&pending) await pending.catch(()=>{});
    return {persisted:true,job:structuredClone(state)};
  }
  return {status:()=>structuredClone(state),pause:options=>setPaused(true,options),resume:options=>setPaused(false,options),stop:async()=>{controller.abort();wake();await task;}};
}
