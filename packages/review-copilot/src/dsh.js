import { createProject, validateProject, getItem, addEvidence, updateItem, recordProposal, toMarkdown } from './review.js';
import { validateProposal } from './model.js';
import {buildReviewContext} from './prompts.js';

export const name = 'research-review-copilot';
export const inject = ['tools'];
const output = {
  schema: {},
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
};

export function apply(ctx) {
  const parameters = (properties,required) => ({type:'object',properties,required,additionalProperties:false});
  const register = (definition,mutation=false) => ctx.effect(() => ctx.tools.register({
    ...definition, output,
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      for (const key of Object.keys(args)) {
        if (!Object.hasOwn(definition.parameters.properties,key)) throw new Error(`Unsupported argument: ${key}`);
      }
      const value=definition.execute(args);
      if(mutation) {value.revision=args.project.revision+1;validateProject(value);}
      return value;
    },
  }), `review-copilot tool: ${definition.name}`);
  const project = { type:'object', additionalProperties:true, description: 'Complete project JSON returned by a review tool or read from the author workspace.' };
  const itemId = { type: 'string', description: 'Exact comment ID, such as R001.' };
  register({
    name:'review_context',
    description:'Read-only P1 basic workflow template with project revision, supplied review comments and evidence. Defaults to P1-29; P1-26 through P1-30 are included under MIT. Optional itemId selects one existing comment. Template variables remain unfilled and inputChecklist requires author checking, not automatic missing-data detection. No model request, file write, acceptance or revision increment.',
    parameters:parameters({project,itemId,promptId:{type:'string',enum:['P1-26','P1-27','P1-28','P1-29','P1-30']}},['project']),
    execute:args=>buildReviewContext(args.project,{itemId:args.itemId,promptId:args.promptId}),
  });
  register({
    name: 'review_create',
    description: 'Create a reviewer-response project from author-provided review text. Returns project JSON without writing files. Classifications and strategies are initial suggestions requiring author review. Save the returned project using the host file tools.',
    parameters: parameters({title:{type:'string'},comments:{type:'string'}},['title','comments']),
    execute: args => createProject(args.title, args.comments),
  });
  register({
    name: 'review_evidence',
    description: 'Attach an author-provided source and exact excerpt to one review comment. This records supplied text without verifying the source or experiment. Clears the item confirmation and returns a draft project; save it with host file tools.',
    parameters: parameters({project,itemId,source:{type:'string'},excerpt:{type:'string'}},['project','itemId','source','excerpt']),
    execute(args) {
      const next = addEvidence(args.project,args.itemId,args.source,args.excerpt);
      getItem(next,args.itemId).history.at(-1).actor = 'host-model';
      return next;
    },
  },true);
  register({
    name: 'review_propose',
    description: 'Store an unaccepted model proposal. Use only supplied evidence IDs; no invented experiments, numeric results, citations, page or line locations. Proposal fields: strategy, rationale, draft, evidenceIds, missing. With no evidence, draft must contain [待补：specific gap] and missing must list gaps. Does not accept the proposal as the response.',
    parameters: parameters({project,itemId,proposal:parameters({
      strategy:{type:'string',enum:['add-evidence','existing-evidence','acknowledge-revise']},
      rationale:{type:'string'},draft:{type:'string'},
      evidenceIds:{type:'array',items:{type:'string'}},missing:{type:'array',items:{type:'string'}},
    },['strategy','rationale','draft','evidenceIds','missing'])},['project','itemId','proposal']),
    execute(args) {
      const item = getItem(validateProject(args.project),args.itemId);
      return recordProposal(args.project,args.itemId,validateProposal(args.proposal,item));
    },
  },true);
  register({
    name: 'review_draft',
    description: 'Set a response draft and optional author-supplied location/strategy. Never claims author confirmation: always sets draft and clears verification. Missing work must remain explicitly marked. This tool cannot mark an item done; the author confirms completion through the CLI after checking actual changes and evidence.',
    parameters: parameters({
      project,itemId,response:{type:'string'},location:{type:'string'},
      strategy:{type:'string',enum:['add-evidence','existing-evidence','acknowledge-revise']},
    },['project','itemId','response']),
    execute(args) {
      const patch = {response:args.response,status:'draft',verification:''};
      if (args.location !== undefined) patch.location = args.location;
      if (args.strategy !== undefined) patch.strategy = args.strategy;
      return updateItem(args.project,args.itemId,patch,'host-model');
    },
  },true);
  register({
    name: 'review_render',
    description: 'Render the supplied project as a Markdown worksheet and return both project and text. Does not verify author claims or write files. The host file tools save the result under their normal permissions.',
    parameters:parameters({project},['project']),
    execute: args => ({project:validateProject(args.project),markdown:toMarkdown(args.project)}),
  });
}
